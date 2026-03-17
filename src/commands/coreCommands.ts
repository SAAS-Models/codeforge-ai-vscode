/**
 * commands/coreCommands.ts — All core commands
 *
 * FIXES APPLIED:
 *  [FIX-4]  switchProvider stores keys in SecretStorage via svc.ai.storeSecret()
 *  [FIX-5]  _editCommand creates an AbortController and links it to the
 *           Progress cancellation token — user can cancel mid-stream
 *  [FIX-6]  After AI edit, user sees "Apply / Show Diff / Cancel"
 *           showDiff() shows side-by-side before overwriting
 *  [FIX-14] Uses getActiveWorkspaceFolder() for multi-root support
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import type { IServices }                       from '../core/services';
import type { AIRequest }                       from '../core/aiService';
import { SECRET_ANTHROPIC, SECRET_OPENAI, SECRET_HUGGINGFACE } from '../core/aiService';
import { getActiveWorkspaceFolder }             from '../core/contextService';

export class CoreCommands {
  constructor(private readonly _svc: IServices) {}

  register(): void {
    // [FIX-27] Wrap all command handlers with try/catch to prevent unhandled errors
    const r = (id: string, fn: (...a: unknown[]) => unknown) =>
      this._svc.vsCtx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[Evolve AI] Command ${id} failed:`, e);
          vscode.window.showErrorMessage(`Evolve AI: ${msg}`);
        }
      }));

    r('aiForge.openChat',          ()          => this.openChat());
    r('aiForge.explainSelection',  ()          => this.explainSelection());
    r('aiForge.refactorSelection', ()          => this.refactorSelection());
    r('aiForge.fixErrors',         ()          => this.fixErrors());
    r('aiForge.addDocstrings',     ()          => this.addDocstrings());
    r('aiForge.addTests',          ()          => this.addTests());
    r('aiForge.generateFromDesc',  ()          => this.generateFromDesc());
    r('aiForge.buildFramework',    ()          => this.buildFramework());
    r('aiForge.applyToFolder',     (u: unknown)=> this.applyToFolder(u as vscode.Uri | undefined));
    r('aiForge.gitCommitMessage',  ()          => this.gitCommitMessage());
    r('aiForge.gitExplainDiff',    ()          => this.gitExplainDiff());
    r('aiForge.gitPRDescription',  ()          => this.gitPRDescription());
    r('aiForge.runAndFix',         ()          => this.runAndFix());
    r('aiForge.switchProvider',    ()          => this.switchProvider());
    r('aiForge.setupOllama',       ()          => this.setupOllama());

    // CodeLens handlers
    r('aiForge.codelens.explain',  (u: unknown, rng: unknown) =>
      this.codelensExplain(u as vscode.Uri, rng as vscode.Range));
    r('aiForge.codelens.tests',    (u: unknown, rng: unknown) =>
      this.codelensTests(u as vscode.Uri, rng as vscode.Range));
    r('aiForge.codelens.refactor', (u: unknown, rng: unknown) =>
      this.codelensRefactor(u as vscode.Uri, rng as vscode.Range));
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────

  openChat(): void {
    vscode.commands.executeCommand('aiForge.chatPanel.focus');
  }

  // ── Edit commands ─────────────────────────────────────────────────────────────

  async explainSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const code = editor.document.getText(editor.selection) || editor.document.getText();
    await vscode.commands.executeCommand('aiForge._sendToChat', `Explain this code:\n\n${code}`, 'chat');
  }

  async refactorSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
    const sel = editor.document.getText(editor.selection);
    if (!sel) { vscode.window.showWarningMessage('Select code to refactor'); return; }
    await this._editCommand(`Refactor this code for clarity, best practices, and performance:\n\n${sel}`, 'edit');
  }

  async fixErrors(): Promise<void> {
    const ctx = await this._svc.context.build({ includeErrors: true });
    if (!ctx.errors.length) { vscode.window.showInformationMessage('Evolve AI: No errors found ✓'); return; }
    const list = ctx.errors.map(e => `- ${e.file}:${e.line} — ${e.message}`).join('\n');
    await this._editCommand(`Fix all these errors:\n${list}`, 'edit');
  }

  async addDocstrings(): Promise<void> {
    await this._editCommand(
      'Add comprehensive documentation comments to all functions, classes, and public methods.', 'edit'
    );
  }

  async addTests(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
    const lang = editor.document.languageId;
    const name = path.basename(editor.document.fileName, path.extname(editor.document.fileName));
    const ext  = ({ python:'py', javascript:'js', typescript:'ts', go:'go', rust:'rs', java:'java' } as Record<string,string>)[lang] ?? 'ts';
    await this._editCommand(`Generate comprehensive unit tests. Name the test file ${name}.test.${ext}`, 'new');
  }

  // ── Generate / Build ──────────────────────────────────────────────────────────

  async generateFromDesc(): Promise<void> {
    const pluginTemplates = this._svc.plugins.templates;
    let instruction: string | undefined;

    if (pluginTemplates.length) {
      type Item = vscode.QuickPickItem & { template?: typeof pluginTemplates[number] };
      const items: Item[] = [
        { label: '$(edit) Describe what to build…', description: 'Free-form description' },
        ...pluginTemplates.map(t => ({ label: `$(extensions) ${t.label}`, description: t.description, template: t })),
      ];
      const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Generate or choose a template' });
      if (!choice) return;
      if (choice.template) {
        const ws    = getActiveWorkspaceFolder(); // [FIX-14]
        instruction = choice.template.prompt(ws?.uri.fsPath ?? '.');
      }
    }

    if (!instruction) {
      instruction = await vscode.window.showInputBox({
        prompt:      'Describe what to build',
        placeHolder: '"FastAPI app with JWT auth" or "React dashboard with recharts"',
        ignoreFocusOut: true,
      });
    }
    if (!instruction) return;
    await this._editCommand(instruction, 'new');
  }

  async buildFramework(): Promise<void> {
    const ws = getActiveWorkspaceFolder(); // [FIX-14]
    if (!ws) { vscode.window.showErrorMessage('Open a folder first'); return; }
    const input = await vscode.window.showInputBox({
      prompt:      'Describe the framework to build',
      placeHolder: '"FastAPI with auth, DB models, migrations, tests"',
      ignoreFocusOut: true,
    });
    if (!input) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Evolve AI: Building framework…', cancellable: false },
      async progress => {
        const ctx = await this._svc.context.build({ includeRelated: false });
        const req: AIRequest = {
          messages: [{ role: 'user', content:
            `Build this project structure with complete working code.\nFor each file use ## relative/path/file.ext\n\n${input}`
          }],
          system:      this._svc.context.buildSystemPrompt(ctx),
          instruction: input,
          mode:        'new',
        };
        progress.report({ message: 'Generating…' });
        const output = await this._svc.ai.send(req);
        progress.report({ message: 'Creating files…' });
        const files  = this._svc.workspace.parseMultiFileOutput(output, ws.uri.fsPath);
        await this._svc.workspace.applyGeneratedFiles(files);
      }
    );
  }

  async applyToFolder(uri?: vscode.Uri): Promise<void> {
    const folderPath = uri?.fsPath ?? getActiveWorkspaceFolder()?.uri.fsPath; // [FIX-14]
    if (!folderPath) { vscode.window.showWarningMessage('Open a folder first'); return; }
    await this._svc.workspace.applyToFolder(folderPath);
  }

  // ── Git ───────────────────────────────────────────────────────────────────────

  async gitCommitMessage(): Promise<void> {
    const ctx = await this._svc.context.build({ includeGitDiff: true, includeErrors: false, includeRelated: false });
    if (!ctx.gitDiff) {
      vscode.window.showInformationMessage('Evolve AI: No staged changes — stage files first.'); return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Evolve AI: Generating commit message…' },
      async () => {
        const req: AIRequest = {
          messages: [{ role: 'user', content:
            `Write a Git commit message (Conventional Commits format) for:\n\n${ctx.gitDiff}\n\nMax 72 chars first line. Bullet points for details if needed.`
          }],
          system: 'You write concise, accurate Git commit messages. Follow Conventional Commits.',
          instruction: 'commit message', mode: 'chat',
        };
        const msg = (await this._svc.ai.send(req)).trim().replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
        await vscode.env.clipboard.writeText(msg);
        const ans = await vscode.window.showInformationMessage(
          `Copied: "${msg.split('\n')[0]}"`, 'Apply to SCM', 'Dismiss'
        );
        if (ans === 'Apply to SCM') {
          const gitExt = vscode.extensions.getExtension('vscode.git');
          if (gitExt) {
            const git  = gitExt.isActive ? gitExt.exports : await gitExt.activate();
            const repo = git.getAPI(1).repositories[0];
            if (repo) repo.inputBox.value = msg;
          }
        }
      }
    );
  }

  async gitExplainDiff(): Promise<void> {
    const ctx = await this._svc.context.build({ includeGitDiff: true, includeErrors: false, includeRelated: false });
    if (!ctx.gitDiff) { vscode.window.showInformationMessage('Evolve AI: No changes to explain.'); return; }
    await vscode.commands.executeCommand('aiForge._sendToChat',
      `Explain what these code changes do and why they matter:\n\n${ctx.gitDiff}`, 'chat'
    );
  }

  async gitPRDescription(): Promise<void> {
    const ctx = await this._svc.context.build({ includeGitDiff: true, includeErrors: false });
    await vscode.commands.executeCommand('aiForge._sendToChat',
      `Write a professional PR description. Include: what changed, why, how to test.\n\n${ctx.gitDiff ?? 'No diff available'}`,
      'chat'
    );
  }

  // ── Run & Fix ─────────────────────────────────────────────────────────────────

  async runAndFix(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const cmd = this._svc.workspace.getRuntimeCommand(editor.document.uri.fsPath, editor.document.languageId);
    if (!cmd) { vscode.window.showWarningMessage('Evolve AI: No runner for this file type'); return; }
    const term = vscode.window.createTerminal('Evolve AI: Run');
    term.show();
    term.sendText(cmd);
    const ans = await vscode.window.showInformationMessage(`Running: ${cmd}`, 'Fix Errors Now', 'Dismiss');
    if (ans === 'Fix Errors Now') await this.fixErrors();
  }

  // ── Provider / Setup ─────────────────────────────────────────────────────────

  async switchProvider(): Promise<void> {
    const cfg     = vscode.workspace.getConfiguration('aiForge');
    const running = await this._svc.ai.isOllamaRunning();
    const models  = running ? await this._svc.ai.getOllamaModels() : [];

    type ProviderItem = vscode.QuickPickItem & { detail: string };
    const items: ProviderItem[] = [
      // ── Local / offline options (no data leaves your machine)
      { label: `$(server) Ollama${running ? ' ✓' : ' (not running)'}`,
        description: running ? `${models.length} model(s) installed — fully local, free` : 'Local LLM — install from ollama.com',
        detail: 'ollama' },
      { label: '$(circuit-board) Offline AI',  description: 'Built-in — instant, no setup, no LLM needed', detail: 'offline' },
      // ── separator
      { label: '── Cloud providers ──', description: '', detail: '', kind: vscode.QuickPickItemKind.Separator } as ProviderItem,
      // ── Cloud options
      { label: '$(cloud) Anthropic Claude',    description: 'Requires API key — claude-sonnet-4-6, opus, haiku',  detail: 'anthropic' },
      { label: '$(globe) OpenAI / Compatible', description: 'Also works with Groq, Mistral, Together AI, LiteLLM',  detail: 'openai' },
      { label: '$(hubot) Hugging Face',        description: 'Access thousands of open models — Qwen, Llama, Mistral, etc.',  detail: 'huggingface' },
    ];

    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Select AI provider' });
    if (!choice) return;
    const provider = choice.detail!;
    await cfg.update('provider', provider, vscode.ConfigurationTarget.Global);

    if (provider === 'ollama' && running && models.length) {
      const model = await vscode.window.showQuickPick(models, { placeHolder: 'Choose Ollama model' });
      if (model) await cfg.update('ollamaModel', model, vscode.ConfigurationTarget.Global);
    } else if (provider === 'ollama' && running) {
      const model = await vscode.window.showInputBox({ prompt: 'Model name', value: 'qwen2.5-coder:7b' });
      if (model) await cfg.update('ollamaModel', model, vscode.ConfigurationTarget.Global);
    } else if (provider === 'ollama' && !running) {
      // Offer local alternatives
      const action = await vscode.window.showWarningMessage(
        'Ollama not detected. You can install Ollama, or use LM Studio / llama.cpp which are also compatible.',
        'Install Ollama', 'Use Custom URL', 'Cancel'
      );
      if (action === 'Install Ollama') {
        vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      } else if (action === 'Use Custom URL') {
        const url = await vscode.window.showInputBox({
          prompt: 'Local server URL (Ollama, LM Studio, llama.cpp, Jan)',
          value: cfg.get<string>('ollamaHost', 'http://localhost:11434'),
          placeHolder: 'http://localhost:11434',
        });
        if (url) {
          await cfg.update('ollamaHost', url, vscode.ConfigurationTarget.Global);
          const model = await vscode.window.showInputBox({ prompt: 'Model name', value: 'qwen2.5-coder:7b' });
          if (model) await cfg.update('ollamaModel', model, vscode.ConfigurationTarget.Global);
        }
      }
    } else if (provider === 'anthropic') {
      // [SEC-6] Inform user that code will be sent to cloud API
      const consent = await vscode.window.showWarningMessage(
        'Evolve AI will send your code and workspace context to the Anthropic API over HTTPS for processing. Continue?',
        { modal: true }, 'I Understand', 'Cancel'
      );
      if (consent !== 'I Understand') return;
      // [FIX-4] Store in SecretStorage, not settings
      const key = await vscode.window.showInputBox({ prompt: 'Anthropic API key', password: true });
      if (key) await this._svc.ai.storeSecret(SECRET_ANTHROPIC, key);
    } else if (provider === 'openai') {
      // [SEC-6] Inform user that code will be sent to cloud API
      const consent = await vscode.window.showWarningMessage(
        'Evolve AI will send your code and workspace context to the OpenAI API over HTTPS for processing. Continue?',
        { modal: true }, 'I Understand', 'Cancel'
      );
      if (consent !== 'I Understand') return;
      // [FIX-4] Store in SecretStorage
      const key = await vscode.window.showInputBox({ prompt: 'OpenAI API key', password: true });
      if (key) await this._svc.ai.storeSecret(SECRET_OPENAI, key);
      // Ask for custom base URL (for non-OpenAI providers like Groq, Together AI)
      const customUrl = await vscode.window.showInputBox({
        prompt: 'Base URL (leave default for OpenAI, or enter Groq/Mistral/Together AI endpoint)',
        value: cfg.get<string>('openaiBaseUrl', 'https://api.openai.com/v1'),
      });
      if (customUrl) await cfg.update('openaiBaseUrl', customUrl, vscode.ConfigurationTarget.Global);
      const model = await vscode.window.showInputBox({
        prompt: 'Model name',
        value: cfg.get<string>('openaiModel', 'gpt-4o'),
      });
      if (model) await cfg.update('openaiModel', model, vscode.ConfigurationTarget.Global);
    } else if (provider === 'huggingface') {
      // [SEC-6] Inform user that code will be sent to cloud API
      const consent = await vscode.window.showWarningMessage(
        'Evolve AI will send your code and workspace context to the Hugging Face Inference API over HTTPS for processing. Continue?',
        { modal: true }, 'I Understand', 'Cancel'
      );
      if (consent !== 'I Understand') return;
      const key = await vscode.window.showInputBox({ prompt: 'Hugging Face API token (from hf.co/settings/tokens)', password: true });
      if (key) await this._svc.ai.storeSecret(SECRET_HUGGINGFACE, key);
      // Let user pick a model
      const hfModels = [
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Llama-3.3-70B-Instruct',
        'mistralai/Mistral-Small-24B-Instruct-2501',
        'bigcode/starcoder2-15b',
        'deepseek-ai/DeepSeek-Coder-V2-Instruct',
      ];
      const modelChoice = await vscode.window.showQuickPick(
        [...hfModels, '$(edit) Enter custom model ID…'],
        { placeHolder: 'Choose a Hugging Face model' }
      );
      if (modelChoice?.includes('custom')) {
        const custom = await vscode.window.showInputBox({ prompt: 'Hugging Face model ID (e.g., org/model-name)' });
        if (custom) await cfg.update('huggingfaceModel', custom, vscode.ConfigurationTarget.Global);
      } else if (modelChoice) {
        await cfg.update('huggingfaceModel', modelChoice, vscode.ConfigurationTarget.Global);
      }
    }

    this._svc.events.emit('provider.changed', {
      provider,
      model: cfg.get('ollamaModel', ''),
    });
  }

  setupOllama(): void {
    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
  }

  // ── CodeLens handlers ─────────────────────────────────────────────────────────

  async codelensExplain(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const doc  = await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand(
      'aiForge._sendToChat', `Explain this function:\n\n${extractBlock(doc, range.start.line)}`, 'chat'
    );
  }

  async codelensTests(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await this._editCommand(`Generate comprehensive unit tests:\n\n${extractBlock(doc, range.start.line)}`, 'new');
  }

  async codelensRefactor(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await this._editCommand(`Refactor for clarity and performance:\n\n${extractBlock(doc, range.start.line)}`, 'edit');
  }

  // ── Shared edit helper ────────────────────────────────────────────────────────

  private async _editCommand(instruction: string, mode: 'edit' | 'new'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor && mode === 'edit') { vscode.window.showWarningMessage('Open a file first'); return; }

    // [FIX-5] Create AbortController to cancel mid-stream
    const abortController = new AbortController();

    await vscode.window.withProgress(
      {
        location:    vscode.ProgressLocation.Notification,
        title:       `Evolve AI: ${mode === 'edit' ? 'Editing' : 'Generating'}…`,
        cancellable: true,  // [FIX-5] Enable cancel button
      },
      async (progress, token) => {
        // [FIX-5] Wire VS Code cancel token → AbortController
        token.onCancellationRequested(() => abortController.abort());

        const ctx    = await this._svc.context.build();
        const system = this._svc.context.buildSystemPrompt(ctx);
        const user   = this._svc.context.buildUserPrompt(ctx, instruction);
        const req: AIRequest = {
          messages:    [{ role: 'user', content: user }],
          system,
          instruction,
          mode,
          signal:      abortController.signal,  // [FIX-5]
        };

        let output = '';
        progress.report({ message: 'Streaming…' });
        for await (const chunk of this._svc.ai.stream(req)) {
          if (token.isCancellationRequested) break;
          output += chunk;
        }

        if (token.isCancellationRequested) {
          vscode.window.showInformationMessage('Evolve AI: Request cancelled.');
          return;
        }

        const cleaned = output.replace(/^```[\w]*\n?|```\s*$/gm, '').trim();

        if (mode === 'edit' && editor) {
          // [FIX-6] Three options: Apply, Show Diff, Cancel
          const ans = await vscode.window.showInformationMessage(
            'Evolve AI: Edit ready.',
            'Apply', 'Show Diff', 'Cancel'
          );
          if (ans === 'Apply') {
            await this._svc.workspace.applyToActiveFile(cleaned);
          } else if (ans === 'Show Diff') {
            // [FIX-6] Show side-by-side diff, then let user decide
            const decision = await this._svc.workspace.showDiff(
              editor.document.getText(), cleaned, instruction.slice(0, 50)
            );
            if (decision === 'apply') await this._svc.workspace.applyToActiveFile(cleaned);
          }
        } else if (mode === 'new') {
          const ws    = getActiveWorkspaceFolder(); // [FIX-14]
          const files = this._svc.workspace.parseMultiFileOutput(cleaned, ws?.uri.fsPath ?? '.');
          await this._svc.workspace.applyGeneratedFiles(files);
        }
      }
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// [FIX-2] Indentation-based block extraction — handles blank lines inside functions
function extractBlock(doc: vscode.TextDocument, startLine: number): string {
  const lines: string[] = [];
  const firstLine = doc.lineAt(startLine).text;
  const baseIndent = firstLine.search(/\S/);

  for (let i = startLine; i < Math.min(startLine + 100, doc.lineCount); i++) {
    const line = doc.lineAt(i).text;
    lines.push(line);

    if (i > startLine) {
      // Blank lines are allowed inside a block
      if (line.trim() === '') continue;
      // A non-blank line at base indent or less ends the block (next function/class)
      const indent = line.search(/\S/);
      if (indent >= 0 && indent <= baseIndent && lines.length > 2) break;
    }
  }
  // Trim trailing blank lines
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}
