/**
 * ui/chatPanel.ts — Plugin-aware sidebar chat
 *
 * Fixes applied vs v2:
 *  FIX 5  — Active AI stream can be cancelled. A "Stop" button appears
 *            during streaming. Clicking it calls abort.abort().
 *  FIX 12 — Chat history is persisted to workspaceState. Survives panel
 *            reload, window reload, and VS Code restarts.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import type { IServices } from '../core/services';
import type { AIRequest, Message } from '../core/aiService';

const HISTORY_KEY     = 'aiForge.chatHistory';
const MAX_HISTORY     = 40; // messages to keep in state
const HISTORY_UI_SHOW = 20; // messages shown in panel on load
const MSG_WINDOW_BUDGET = 48_000; // [FIX-10] Max chars for conversation history sent to AI

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'aiForge.chatPanel';
  private _view?: vscode.WebviewView;
  private _history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private _activeAbort: AbortController | null = null;   // FIX 5
  private _lastActiveFileUri: string | undefined;        // [FIX-5] Track file for apply safety

  // [FIX-18] Status debouncing and caching
  private _statusTimer: ReturnType<typeof setTimeout> | null = null;
  private _statusCache: { data: Record<string, unknown>; ts: number } | null = null;
  private static readonly STATUS_CACHE_TTL = 5_000;

  constructor(private readonly _svc: IServices) {
    // Restore persisted history (FIX 12)
    const saved = _svc.vsCtx.workspaceState.get<typeof this._history>(HISTORY_KEY, []);
    this._history = saved.slice(-MAX_HISTORY);

    // Allow CoreCommands to push messages into the panel
    _svc.vsCtx.subscriptions.push(
      vscode.commands.registerCommand('aiForge._sendToChat',
        (instruction: string, mode: string) => this.send(instruction, mode as 'chat' | 'edit' | 'new')
      )
    );

    // Refresh header when plugins / provider change
    // [FIX-18] Invalidate cache on provider change, debounce all status updates
    // [FIX-19] Store disposables to prevent listener accumulation on panel re-creation
    _svc.vsCtx.subscriptions.push(
      _svc.events.on('plugin.activated',   () => this._scheduleStatus()),
      _svc.events.on('plugin.deactivated', () => this._scheduleStatus()),
      _svc.events.on('provider.changed',   () => { this._statusCache = null; this._scheduleStatus(); }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html    = this._html();

    view.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'send':           await this.send(msg.text, msg.mode);    break;
          case 'cancel':         this._activeAbort?.abort();             break;  // FIX 5
          case 'apply':          await this._apply(msg.content, msg.expectedUri); break;
          case 'applyNew':       await this._applyNew(msg.content);      break;
          case 'clear':          await this._clearHistory();             break;
          case 'getStatus':      await this._postStatus();               break;
          case 'getHistory':     this._sendHistory();                    break;
          case 'switchProvider': await vscode.commands.executeCommand('aiForge.switchProvider'); break;
          default: console.warn('[Evolve AI] Unknown webview message type:', msg.type); break;
        }
      } catch (e) {
        console.error('[Evolve AI] Webview message handler error:', e);
        this._post({ type: 'notice', text: `Error: ${String(e)}. Try reloading the window (Ctrl+Shift+P > "Developer: Reload Window").` });
      }
    }, undefined, this._svc.vsCtx.subscriptions);

    this._postStatus();
    this._sendHistory();
  }

  show(): void { this._view?.show(true); }

  // ── Send ──────────────────────────────────────────────────────────────────────

  async send(instruction: string, mode: 'chat' | 'edit' | 'new' = 'chat'): Promise<void> {
    this.show();

    // [FIX-5] Track the active file at request time for safe apply
    this._lastActiveFileUri = vscode.window.activeTextEditor?.document.uri.toString();

    // [FIX-20] Wrap entire send flow in try/catch so context.build() failures
    // don't leave the panel in a broken state
    let ctx, system, user;
    try {
      ctx    = await this._svc.context.build();
      system = this._svc.context.buildSystemPrompt(ctx);
      user   = this._svc.context.buildUserPrompt(ctx, instruction);
    } catch (e) {
      this._post({ type: 'aiChunk', text: `\n\n⚠ Context build failed: ${String(e)}` });
      this._post({ type: 'aiDone', content: '', mode, expectedUri: undefined });
      return;
    }

    const ctxTag = [
      ctx.activeFile?.relPath,
      ctx.selection        ? 'selection'            : null,
      ctx.errors.length    ? `${ctx.errors.length} error(s)` : null,
      ctx.gitDiff          ? 'git diff'             : null,
      ...[...ctx.pluginData.keys()],
    ].filter(Boolean).join(' · ');

    this._post({ type: 'userMsg', text: instruction, context: ctxTag });
    this._history.push({ role: 'user', content: user });
    this._post({ type: 'aiStart' });

    // FIX 5 — create abort controller, send stop signal to panel
    const abort = new AbortController();
    this._activeAbort = abort;
    this._post({ type: 'streamStart' });

    let full = '';
    try {
      const req: AIRequest = {
        // [FIX-10] Token-aware message windowing instead of blind slice(-10)
        messages:    this._windowMessages(MSG_WINDOW_BUDGET),
        system,
        instruction,
        mode,
        signal:      abort.signal,     // FIX 5
      };
      for await (const chunk of this._svc.ai.stream(req)) {
        full += chunk;
        this._post({ type: 'aiChunk', text: chunk });
      }
    } catch (e) {
      this._post({ type: 'aiChunk', text: `\n\n⚠ ${String(e)}` });
    }

    this._activeAbort = null;
    this._history.push({ role: 'assistant', content: full });

    // FIX 12 — persist history after every exchange
    await this._saveHistory();

    // [FIX-5] Include the expected file URI so the webview can pass it back on apply
    this._post({ type: 'aiDone', content: full, mode, expectedUri: this._lastActiveFileUri });
  }

  // [FIX-10] Walk history backwards, accumulating messages until budget is exceeded
  private _windowMessages(budget: number): Message[] {
    const msgs = [...this._history];
    let total = 0;
    const result: Message[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const len = msgs[i].content.length;
      if (total + len > budget && result.length > 0) break;
      result.unshift(msgs[i]);
      total += len;
    }
    return result;
  }

  // ── History ───────────────────────────────────────────────────────────────────

  private async _saveHistory(): Promise<void> {
    const trimmed = this._history.slice(-MAX_HISTORY);
    this._history = trimmed;
    await this._svc.vsCtx.workspaceState.update(HISTORY_KEY, trimmed);
  }

  private async _clearHistory(): Promise<void> {
    this._history = [];
    await this._svc.vsCtx.workspaceState.update(HISTORY_KEY, []);
    this._post({ type: 'historyClear' });
  }

  private _sendHistory(): void {
    // Send last N messages to populate the panel on load
    const recent = this._history.slice(-HISTORY_UI_SHOW);
    this._post({ type: 'historyLoad', messages: recent });
  }

  // ── Apply ─────────────────────────────────────────────────────────────────────

  // [FIX-5] Verify the active file matches what was in context before applying
  private async _apply(content: string, expectedUri?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { this._post({ type: 'notice', text: '✗ No active editor' }); return; }

    if (expectedUri && editor.document.uri.toString() !== expectedUri) {
      const basename = path.basename(editor.document.uri.fsPath);
      const ans = await vscode.window.showWarningMessage(
        `Active file changed since AI response. Apply to "${basename}" anyway?`,
        'Apply', 'Cancel'
      );
      if (ans !== 'Apply') return;
    }

    try {
      await this._svc.workspace.applyToActiveFile(content.replace(/^```[\w]*\n?|```\s*$/gm, '').trim());
      this._post({ type: 'notice', text: '✓ Applied to current file' });
    } catch (e) {
      this._post({ type: 'notice', text: `✗ ${String(e)}` });
    }
  }

  private async _applyNew(content: string): Promise<void> {
    const ws    = vscode.workspace.getWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file('.')
    )?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
    const files = this._svc.workspace.parseMultiFileOutput(content, ws);
    if (files.length === 0) { this._post({ type: 'notice', text: '⚠ Could not parse files from response' }); return; }
    await this._svc.workspace.applyGeneratedFiles(files);
    this._post({ type: 'notice', text: `✓ Created/updated ${files.length} file(s)` });
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  // [FIX-18] Debounced status update — avoids redundant network calls
  private _scheduleStatus(): void {
    if (this._statusTimer) clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this._postStatus();
    }, 300);
  }

  private async _postStatus(): Promise<void> {
    // [FIX-18] Return cached status if recent
    const now = Date.now();
    if (this._statusCache && (now - this._statusCache.ts) < ChatPanelProvider.STATUS_CACHE_TTL) {
      this._post(this._statusCache.data);
      return;
    }

    const cfg      = vscode.workspace.getConfiguration('aiForge');
    const host     = cfg.get<string>('ollamaHost', 'http://localhost:11434');
    const running  = await this._svc.ai.isOllamaRunning(host);
    const models   = running ? await this._svc.ai.getOllamaModels(host) : [];
    const provider = await this._svc.ai.detectProvider();
    const active   = this._svc.plugins.active;
    const statusMsg: Record<string, unknown> = {
      type: 'status',
      provider,
      ollamaRunning: running,
      ollamaModels:  models,
      currentModel:  cfg.get<string>('ollamaModel', ''),
      activePlugins: active.map(p => ({ id: p.id, name: p.displayName, icon: p.icon })),
    };
    this._statusCache = { data: statusMsg, ts: now };
    this._post(statusMsg);
  }

  private _post(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────
  // [FIX-9] Extracted into a readable, maintainable template
  // [FIX-16] Streaming render batched via requestAnimationFrame

  private _html(): string {
    // [SEC-3] Generate a nonce for CSP — prevents inline script injection
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
  --bg: var(--vscode-sideBar-background);
  --bg2: var(--vscode-editor-background);
  --border: var(--vscode-panel-border);
  --text: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --accent: var(--vscode-button-background);
  --green: var(--vscode-testing-iconPassed);
  --yellow: var(--vscode-editorWarning-foreground);
  --mono: var(--vscode-editor-font-family);
  --font: var(--vscode-font-family);
  --fsz: var(--vscode-font-size);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: var(--fsz); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* Header */
#header { padding: 6px 10px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex-shrink: 0; transition: background 0.3s; }
.dot.green { background: var(--green); }
.dot.yellow { background: var(--yellow); }
#providerLabel { font-weight: 600; }
#modelLabel { color: var(--muted); }
#pluginBadges { display: flex; gap: 4px; margin-left: 4px; }
.badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; padding: 1px 5px; font-size: 10px; }
.hbtn { background: none; border: 1px solid var(--border); color: var(--muted); padding: 2px 7px; border-radius: 3px; cursor: pointer; font-size: 10px; transition: color 0.15s; }
.hbtn:hover { color: var(--text); }
#rightBtns { margin-left: auto; display: flex; gap: 4px; }

/* Tabs */
#tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.tab { flex: 1; padding: 7px 4px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }

/* Messages */
#msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.msg { border-radius: 6px; padding: 10px 12px; line-height: 1.55; word-break: break-word; animation: fadeIn 0.15s ease-out; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.msg.user { background: var(--vscode-inputOption-activeBackground); align-self: flex-end; max-width: 92%; }
.msg.ai { background: var(--bg2); border: 1px solid var(--border); }
.msg.notice { background: none; border: 1px dashed var(--border); color: var(--muted); font-size: 11px; text-align: center; }
.ctx { font-size: 10px; color: var(--muted); margin-top: 4px; }

/* Welcome state */
.welcome { text-align: center; padding: 20px 16px; color: var(--muted); }
.welcome h3 { color: var(--text); margin-bottom: 8px; font-size: 13px; }
.welcome p { font-size: 11px; line-height: 1.6; margin: 3px 0; }
.welcome kbd { background: var(--bg2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; font-size: 10px; font-family: var(--mono); }

/* Thinking indicator */
.thinking { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; padding: 8px 12px; }
.thinking-dots span { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: var(--muted); animation: dotPulse 1.2s infinite ease-in-out; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotPulse { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }

/* Toast */
.toast { position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 5px 14px; border-radius: 4px; font-size: 11px; z-index: 100; animation: toastIn 0.2s ease-out, toastOut 0.3s 1.5s ease-in forwards; pointer-events: none; }
@keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(8px); } }
@keyframes toastOut { to { opacity: 0; } }

/* Code */
pre { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow-x: auto; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; margin: 6px 0; }
code { font-family: var(--mono); font-size: 12px; background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 2px; }

/* Actions */
.actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.15s, transform 0.1s; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn:active { transform: scale(0.97); }
.btn.primary { background: var(--accent); color: var(--vscode-button-foreground); }
.btn.primary:hover { filter: brightness(1.1); }

/* Streaming cursor */
.streaming::after { content: '\\25CB'; animation: blink .7s infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* Input */
#inputArea { border-top: 1px solid var(--border); padding: 8px; flex-shrink: 0; }
#row { display: flex; gap: 6px; align-items: flex-end; }
#input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 7px 10px; font-family: var(--font); font-size: var(--fsz); resize: none; min-height: 36px; max-height: 140px; overflow-y: auto; transition: border-color 0.15s; }
#input:focus { outline: none; border-color: var(--accent); }
#sendBtn { background: var(--accent); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 7px 14px; cursor: pointer; font-size: 13px; flex-shrink: 0; transition: opacity 0.15s; }
#sendBtn:hover { filter: brightness(1.1); }
#sendBtn:disabled { opacity: .4; cursor: not-allowed; }
#stopBtn { display: none; background: var(--vscode-errorForeground); color: #fff; border: none; border-radius: 4px; padding: 7px 12px; cursor: pointer; font-size: 12px; flex-shrink: 0; }
.hint { font-size: 10px; color: var(--muted); margin-top: 4px; }
</style>
</head>
<body>

<div id="header">
  <div class="dot" id="dot"></div>
  <span id="providerLabel">...</span>
  <span id="modelLabel"></span>
  <div id="pluginBadges"></div>
  <div id="rightBtns">
    <button class="hbtn" id="switchBtn" title="Switch AI provider">Switch</button>
    <button class="hbtn" id="clearBtn" title="Clear conversation history">Clear</button>
  </div>
</div>

<div id="tabs">
  <button class="tab active" id="tabChat" title="Ask questions about your code">Chat</button>
  <button class="tab"        id="tabEdit" title="Describe changes to apply to the active file">Edit</button>
  <button class="tab"        id="tabNew"  title="Generate new files from a description">Create</button>
</div>

<div id="msgs">
  <div class="welcome">
    <h3>Evolve AI</h3>
    <p><strong>Chat</strong> &mdash; ask questions about your code</p>
    <p><strong>Edit</strong> &mdash; describe changes to the active file</p>
    <p><strong>Create</strong> &mdash; generate new files from scratch</p>
    <p style="margin-top:8px">Right-click code for inline actions</p>
    <p><kbd>Ctrl+Shift+A</kbd> to open &middot; <kbd>Ctrl+Alt+E</kbd> to explain selection</p>
  </div>
</div>

<div id="inputArea">
  <div id="row">
    <textarea id="input" rows="1" placeholder="Ask Evolve AI..."></textarea>
    <button id="stopBtn">Stop</button>
    <button id="sendBtn">&#9654;</button>
  </div>
  <div class="hint" id="hint">Chat: ask anything &middot; Shift+Enter for newline</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let mode = 'chat', streaming = false, lastContent = '', lastExpectedUri = null, aiEl = null;
let renderPending = false;
let currentProvider = 'offline';

function setMode(m) {
  mode = m;
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', ['chat', 'edit', 'new'][i] === m)
  );
  const hints = {
    chat: 'Chat: ask anything \\u00B7 Shift+Enter for newline',
    edit: 'Edit: describe the change to apply \\u00B7 Shift+Enter for newline',
    new:  'Create: describe what to generate \\u00B7 Shift+Enter for newline'
  };
  const placeholders = {
    chat: 'Ask about your code...',
    edit: 'Describe the change to make...',
    new:  'Describe what to create...'
  };
  document.getElementById('hint').textContent = hints[m];
  document.getElementById('input').placeholder = placeholders[m];
}

function resize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }
function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function md(s) {
  const blocks = [];
  s = s.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    blocks.push('<pre>' + code + '</pre>');
    return '%%BLK' + (blocks.length - 1) + '%%';
  });
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/^[-*] (.+)$/gm, '\\u2022 $1');
  s = s.replace(/\\n/g, '<br>');
  blocks.forEach((b, i) => { s = s.replace('%%BLK' + i + '%%', b); });
  return s;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function clearWelcome() {
  const w = document.querySelector('.welcome');
  if (w) w.remove();
}

function addMsg(cls, html, id) {
  clearWelcome();
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = html;
  if (id) el.id = id;
  document.getElementById('msgs').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
  return el;
}

function send() {
  if (streaming) return;
  const inp = document.getElementById('input');
  const t = inp.value.trim();
  if (!t) return;
  inp.value = ''; inp.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  vscode.postMessage({ type: 'send', text: t, mode });
}

function cancel() { vscode.postMessage({ type: 'cancel' }); }

function clearHistory() {
  if (!confirm('Clear all chat history?')) return;
  vscode.postMessage({ type: 'clear' });
}

window.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'status': {
      currentProvider = data.provider;
      const d = document.getElementById('dot');
      // Green when any provider is configured and working
      const isReady = data.provider === 'ollama' ? data.ollamaRunning
        : (data.provider !== 'offline' && data.provider !== 'auto');
      d.className = 'dot ' + (isReady ? 'green' : 'yellow');
      d.title = isReady ? 'Provider connected' : 'No AI provider active';
      document.getElementById('providerLabel').textContent = data.provider.toUpperCase();
      document.getElementById('modelLabel').textContent = data.currentModel ? ' \\u00B7 ' + data.currentModel : '';
      const pb = document.getElementById('pluginBadges');
      pb.innerHTML = (data.activePlugins || []).map(p =>
        '<span class="badge" title="' + esc(p.name) + '">' + esc(p.icon) + '</span>'
      ).join('');
      break;
    }
    case 'historyLoad': {
      const msgs = document.getElementById('msgs');
      if (data.messages && data.messages.length > 0) {
        msgs.innerHTML = '';
        data.messages.forEach(m => {
          if (m.role === 'user') {
            // Show only the instruction line, not the full context-enriched prompt
            const lines = m.content.split('\\n');
            const short = lines[lines.length - 1] || lines[0] || m.content;
            addMsg('user', esc(short));
          } else {
            addMsg('ai', md(esc(m.content)));
          }
        });
        addMsg('notice', 'Previous conversation restored');
      }
      break;
    }
    case 'historyClear':
      document.getElementById('msgs').innerHTML = '<div class="msg notice">History cleared.</div>';
      break;
    case 'userMsg':
      addMsg('user', esc(data.text) + (data.context ? '<div class="ctx">' + esc(data.context) + '</div>' : ''));
      break;
    case 'streamStart': {
      streaming = true;
      document.getElementById('stopBtn').style.display = 'block';
      document.getElementById('sendBtn').style.display = 'none';
      // Show thinking indicator before first chunk arrives
      const thinking = document.createElement('div');
      thinking.className = 'thinking';
      thinking.id = 'thinkingIndicator';
      thinking.innerHTML = 'Thinking <div class="thinking-dots"><span></span><span></span><span></span></div>';
      document.getElementById('msgs').appendChild(thinking);
      thinking.scrollIntoView({ behavior: 'smooth' });
      lastContent = '';
      aiEl = null;
      break;
    }
    case 'aiChunk':
      // Remove thinking indicator on first chunk
      if (!aiEl) {
        const ti = document.getElementById('thinkingIndicator');
        if (ti) ti.remove();
        aiEl = addMsg('ai streaming', '');
      }
      if (aiEl) {
        lastContent += data.text;
        if (!renderPending) {
          renderPending = true;
          requestAnimationFrame(() => {
            if (aiEl) {
              aiEl.innerHTML = md(esc(lastContent));
              aiEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
            renderPending = false;
          });
        }
      }
      break;
    case 'aiDone': {
      streaming = false;
      lastExpectedUri = data.expectedUri || null;
      // Clean up thinking indicator if no chunks arrived
      const ti2 = document.getElementById('thinkingIndicator');
      if (ti2) ti2.remove();
      document.getElementById('stopBtn').style.display = 'none';
      document.getElementById('sendBtn').style.display = 'block';
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('input').focus();
      if (aiEl) {
        aiEl.classList.remove('streaming');
        aiEl.innerHTML = md(esc(lastContent));
        const acts = document.createElement('div');
        acts.className = 'actions';
        if (data.mode === 'edit') {
          const applyBtn = document.createElement('button');
          applyBtn.className = 'btn primary'; applyBtn.textContent = 'Apply to file';
          applyBtn.addEventListener('click', apply);
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn'; copyBtn.textContent = 'Copy';
          copyBtn.addEventListener('click', copy);
          acts.appendChild(applyBtn); acts.appendChild(copyBtn);
        } else if (data.mode === 'new') {
          const createBtn = document.createElement('button');
          createBtn.className = 'btn primary'; createBtn.textContent = 'Create files';
          createBtn.addEventListener('click', applyNew);
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn'; copyBtn.textContent = 'Copy';
          copyBtn.addEventListener('click', copy);
          acts.appendChild(createBtn); acts.appendChild(copyBtn);
        } else {
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn'; copyBtn.textContent = 'Copy';
          copyBtn.addEventListener('click', copy);
          acts.appendChild(copyBtn);
        }
        aiEl.appendChild(acts);
        aiEl = null;
      }
      break;
    }
    case 'notice':
      addMsg('notice', esc(data.text));
      break;
  }
});

function apply() { vscode.postMessage({ type: 'apply', content: lastContent, expectedUri: lastExpectedUri }); }
function applyNew() { vscode.postMessage({ type: 'applyNew', content: lastContent }); }
function copy() {
  navigator.clipboard.writeText(lastContent).then(() => toast('Copied to clipboard'));
}

// Wire up all event listeners (CSP blocks inline onclick handlers)
// [FIX-26] Null-safe event binding to prevent silent webview crashes
function on(id, evt, fn) { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); else console.warn('[Evolve AI] Missing element:', id); }
on('switchBtn', 'click', () => vscode.postMessage({type:'switchProvider'}));
on('clearBtn',  'click', () => clearHistory());
on('tabChat',   'click', () => setMode('chat'));
on('tabEdit',   'click', () => setMode('edit'));
on('tabNew',    'click', () => setMode('new'));
on('sendBtn',   'click', () => send());
on('stopBtn',   'click', () => cancel());
on('input',     'keydown', (e) => onKey(e));
on('input',     'input', function() { resize(this); });

// Auto-focus input and request initial state
const inputEl = document.getElementById('input');
if (inputEl) inputEl.focus();
vscode.postMessage({ type: 'getStatus' });
vscode.postMessage({ type: 'getHistory' });
</script>
</body></html>`;
  }
}

// [SEC-3] Cryptographically random nonce for webview CSP
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const bytes = require('crypto').randomBytes(32);
  for (let i = 0; i < 32; i++) nonce += chars[bytes[i] % chars.length];
  return nonce;
}
