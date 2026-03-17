/**
 * core/aiService.ts — AI provider abstraction
 *
 * FIXES APPLIED:
 *  [FIX-4]  API keys stored in vscode.SecretStorage — never in settings.json
 *  [FIX-5]  AI requests are cancellable via AbortSignal in AIRequest
 *           Users can cancel mid-stream; withProgress cancel button works
 *  [FIX-10] Implements IAIService interface — concrete class hidden behind contract
 */

import * as vscode from 'vscode';
import * as http   from 'http';
import * as https  from 'https';
import type { EventBus }   from './eventBus';
import type { IAIService } from './interfaces';

export type ProviderName = 'auto' | 'ollama' | 'anthropic' | 'openai' | 'huggingface' | 'offline';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIRequest {
  messages:     Message[];
  system:       string;
  instruction:  string;
  mode:         string;
  /** [FIX-5] Optional: caller provides signal to cancel mid-stream */
  signal?:      AbortSignal;
}

export interface RequestInterceptor {
  intercept(req: AIRequest): AIRequest;
}

// Secret storage keys
const SECRET_ANTHROPIC    = 'aiForge.anthropicKey';
const SECRET_OPENAI       = 'aiForge.openaiKey';
const SECRET_HUGGINGFACE  = 'aiForge.huggingfaceKey';

// ── AIService ─────────────────────────────────────────────────────────────────

export class AIService implements IAIService {
  private _interceptors: RequestInterceptor[] = [];
  // [SEC-5] Concurrent request guard — prevents accidental cost spikes
  private _activeStreams = 0;
  private static readonly MAX_CONCURRENT_STREAMS = 3;

  constructor(
    private readonly _bus:     EventBus,
    private readonly _secrets: vscode.SecretStorage   // [FIX-4]
  ) {}

  // ── [FIX-4] Secret storage ───────────────────────────────────────────────────

  async storeSecret(key: string, value: string): Promise<void> {
    await this._secrets.store(key, value);
  }

  async getSecret(key: string): Promise<string | undefined> {
    return this._secrets.get(key);
  }

  // ── Interceptors ────────────────────────────────────────────────────────────

  addInterceptor(interceptor: RequestInterceptor): vscode.Disposable {
    this._interceptors.push(interceptor);
    return { dispose: () => {
      this._interceptors = this._interceptors.filter(i => i !== interceptor);
    }};
  }

  // ── Provider detection ───────────────────────────────────────────────────────

  async detectProvider(): Promise<ProviderName> {
    const cfg  = this._cfg();
    const pref = cfg.get<ProviderName>('provider', 'auto');
    if (pref !== 'auto') return pref;
    return (await this.isOllamaRunning()) ? 'ollama' : 'offline';
  }

  // [FIX-23] On Windows, 'localhost' may resolve to IPv6 ::1 while Ollama listens on IPv4.
  // This helper resolves the working host URL once, caching the result.
  private _resolvedOllamaHost: string | null = null;

  private async _resolveOllamaHost(host: string): Promise<string> {
    const url = new URL(host);
    if (url.hostname !== 'localhost') return host;
    if (this._resolvedOllamaHost) return this._resolvedOllamaHost;

    // Try localhost first, then 127.0.0.1
    for (const candidate of [host, host.replace('localhost', '127.0.0.1')]) {
      if (await this._pingUrl(candidate)) {
        this._resolvedOllamaHost = candidate;
        return candidate;
      }
    }
    this._resolvedOllamaHost = null;
    return host;
  }

  private _pingUrl(baseUrl: string): Promise<boolean> {
    const url = new URL(baseUrl);
    // [SEC-4] Only allow http/https schemes
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve(false);
    return new Promise(resolve => {
      // Use an explicit connection timeout via setTimeout
      let settled = false;
      const done = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };
      const timer = setTimeout(() => { req.destroy(); done(false); }, 4000);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(url.href, (res) => {
        clearTimeout(timer);
        res.resume(); // drain the response
        done(true);
      });
      req.on('error', () => { clearTimeout(timer); done(false); });
    });
  }

  async isOllamaRunning(host?: string): Promise<boolean> {
    const h = host ?? this._cfg().get<string>('ollamaHost', 'http://localhost:11434');
    const resolved = await this._resolveOllamaHost(h);
    const result = await this._pingUrl(resolved);
    console.log(`[Evolve AI] isOllamaRunning: host=${h}, resolved=${resolved}, result=${result}`);
    return result;
  }

  async getOllamaModels(host?: string): Promise<string[]> {
    const h   = host ?? this._cfg().get<string>('ollamaHost', 'http://localhost:11434');
    const resolved = await this._resolveOllamaHost(h);
    return new Promise(resolve => {
      const req = http.request(
        resolved + '/api/tags',
        { method: 'GET', timeout: 3000 },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try { resolve((JSON.parse(data).models || []).map((m: { name: string }) => m.name)); }
            catch { resolve([]); }
          });
        }
      );
      req.on('error', () => resolve([]));
      req.end();
    });
  }

  // ── Core streaming ───────────────────────────────────────────────────────────

  async* stream(request: AIRequest): AsyncGenerator<string> {
    // [SEC-5] Reject if too many concurrent streams
    if (this._activeStreams >= AIService.MAX_CONCURRENT_STREAMS) {
      yield '⚠ Evolve AI: Too many concurrent requests. Please wait for the current request to finish.';
      return;
    }
    this._activeStreams++;

    let req = request;
    for (const i of this._interceptors) req = i.intercept(req);

    this._bus.emit('ai.request.start', { instruction: req.instruction, mode: req.mode });

    try {
      const provider = await this.detectProvider();
      const cfg      = this._cfg();

      if (provider === 'ollama')         { yield* this._streamOllama(req, cfg);       }
      else if (provider === 'anthropic')  { yield* this._streamAnthropic(req, cfg);  }
      else if (provider === 'openai')     { yield* this._streamOpenAI(req, cfg);     }
      else if (provider === 'huggingface'){ yield* this._streamHuggingFace(req, cfg);}
      else                                { yield* this._offline(req);                }

      this._bus.emit('ai.request.done', { instruction: req.instruction });
    } catch (e) {
      const msg = String(e);
      this._bus.emit('ai.request.error', { instruction: req.instruction, error: msg });
      yield `\n\n⚠ Evolve AI error: ${msg}`;
    } finally {
      this._activeStreams--;
    }
  }

  async send(request: AIRequest): Promise<string> {
    let result = '';
    for await (const chunk of this.stream(request)) result += chunk;
    return result;
  }

  // ── Providers ────────────────────────────────────────────────────────────────

  private async* _streamOllama(req: AIRequest, cfg: vscode.WorkspaceConfiguration): AsyncGenerator<string> {
    const host  = cfg.get<string>('ollamaHost', 'http://localhost:11434');
    const resolved = await this._resolveOllamaHost(host);
    const model = cfg.get<string>('ollamaModel', 'qwen2.5-coder:7b');

    // Pre-check: verify the model exists before streaming
    const available = await this._getOllamaModels(resolved);
    if (available !== null && !available.some(m => m === model || m.startsWith(model + ':'))) {
      // Show one-click install notification
      const useExisting = available.length > 0 ? 'Use Installed Model' : undefined;
      const choices = ['Install Model Now', ...(useExisting ? [useExisting] : []), 'Open Settings'];
      const pick = await vscode.window.showWarningMessage(
        `Ollama model "${model}" is not installed.`,
        ...choices
      );

      if (pick === 'Install Model Now') {
        const term = vscode.window.createTerminal('Evolve AI: Ollama Pull');
        term.show();
        term.sendText(`ollama pull ${model}`);
        yield `⏳ Installing model **${model}**...\n\n`;
        yield `A terminal has been opened to download the model. Once it finishes, try your request again.\n`;
        return;
      } else if (pick === 'Use Installed Model' && available.length > 0) {
        // Let user pick from installed models
        const selected = await vscode.window.showQuickPick(available, {
          placeHolder: 'Select an installed Ollama model to use',
          title: 'Evolve AI: Choose Model',
        });
        if (selected) {
          await vscode.workspace.getConfiguration('aiForge').update('ollamaModel', selected, vscode.ConfigurationTarget.Global);
          yield `✓ Switched to model **${selected}**. Retrying...\n\n`;
          // Retry with the new model
          yield* this._streamOllamaWithModel(req, resolved, selected);
          return;
        }
        yield `⚠ No model selected. Please try again.\n`;
        return;
      } else if (pick === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiForge.ollamaModel');
        yield `⚠ Update the **aiForge.ollamaModel** setting to a model you have installed, then try again.\n`;
        return;
      }

      // User dismissed the dialog
      const list = available.length > 0 ? available.slice(0, 10).join(', ') : 'none';
      yield `⚠ Model **${model}** not found. Installed models: ${list}\n`;
      return;
    }

    yield* this._streamOllamaWithModel(req, resolved, model);
  }

  private async* _streamOllamaWithModel(req: AIRequest, resolvedHost: string, model: string): AsyncGenerator<string> {
    const url   = new URL(resolvedHost + '/api/chat');
    const body  = JSON.stringify({
      model, stream: true,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      options: { temperature: 0.2, num_predict: 4096 },
    });
    yield* this._httpStream(url, body,
      c => { try { return JSON.parse(c).message?.content || ''; } catch { return ''; } },
      {}, req.signal
    );
  }

  /** Fetch list of installed Ollama model names, or null on failure */
  private async _getOllamaModels(resolvedHost: string): Promise<string[] | null> {
    try {
      const url = new URL(resolvedHost + '/api/tags');
      const lib = url.protocol === 'https:' ? https : http;
      return await new Promise<string[] | null>((resolve) => {
        const req = lib.get(url, res => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const models = (parsed.models || []).map((m: { name: string }) => m.name);
              resolve(models);
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      });
    } catch { return null; }
  }

  private async* _streamAnthropic(req: AIRequest, cfg: vscode.WorkspaceConfiguration): AsyncGenerator<string> {
    // [FIX-4] Read from SecretStorage only — never fall back to settings.json
    const key = await this._secrets.get(SECRET_ANTHROPIC) ?? '';
    if (!key) { yield '⚠ No Anthropic API key — run: Evolve AI: Switch AI Provider'; return; }
    const url  = new URL('https://api.anthropic.com/v1/messages');
    const body = JSON.stringify({
      model: cfg.get<string>('anthropicModel', 'claude-sonnet-4-6'), max_tokens: 4096, stream: true,
      system:   req.system,
      messages: req.messages.filter(m => m.role !== 'system'),
    });
    yield* this._httpStream(url, body,
      c => {
        if (!c.startsWith('data:')) return '';
        try { return JSON.parse(c.slice(5).trim()).delta?.text || ''; } catch { return ''; }
      },
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      req.signal
    );
  }

  private async* _streamOpenAI(req: AIRequest, cfg: vscode.WorkspaceConfiguration): AsyncGenerator<string> {
    // [FIX-4] Read from SecretStorage only — never fall back to settings.json
    const key     = await this._secrets.get(SECRET_OPENAI) ?? '';
    const baseUrl = cfg.get<string>('openaiBaseUrl', 'https://api.openai.com/v1');
    const model   = cfg.get<string>('openaiModel', 'gpt-4o');
    if (!key) { yield '⚠ No OpenAI API key — run: Evolve AI: Switch AI Provider'; return; }
    const url  = new URL(baseUrl + '/chat/completions');
    const body = JSON.stringify({
      model, stream: true, temperature: 0.2, max_tokens: 4096,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    });
    yield* this._httpStream(url, body,
      c => {
        if (!c.startsWith('data:') || c.includes('[DONE]')) return '';
        try { return JSON.parse(c.slice(5).trim()).choices?.[0]?.delta?.content || ''; } catch { return ''; }
      },
      { Authorization: `Bearer ${key}` },
      req.signal
    );
  }

  private async* _streamHuggingFace(req: AIRequest, cfg: vscode.WorkspaceConfiguration): AsyncGenerator<string> {
    const key   = await this._secrets.get(SECRET_HUGGINGFACE) ?? '';
    const model = cfg.get<string>('huggingfaceModel', 'Qwen/Qwen2.5-Coder-32B-Instruct');
    const base  = cfg.get<string>('huggingfaceBaseUrl', 'https://api-inference.huggingface.co');
    if (!key) { yield '⚠ No Hugging Face API key — run: Evolve AI: Switch AI Provider'; return; }
    const url  = new URL(`${base}/models/${model}/v1/chat/completions`);
    const body = JSON.stringify({
      model, stream: true, temperature: 0.2, max_tokens: 4096,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    });
    yield* this._httpStream(url, body,
      c => {
        if (!c.startsWith('data:') || c.includes('[DONE]')) return '';
        try { return JSON.parse(c.slice(5).trim()).choices?.[0]?.delta?.content || ''; } catch { return ''; }
      },
      { Authorization: `Bearer ${key}` },
      req.signal
    );
  }

  private async* _offline(req: AIRequest): AsyncGenerator<string> {
    const low = req.instruction.toLowerCase();
    if (low.includes('explain') || low.includes('what')) {
      yield '📖 **Offline mode** — install Ollama for explanations:\n```\nollama pull qwen2.5-coder:7b\n```'; return;
    }
    if (low.includes('test'))  { yield '🧪 Offline mode: install Ollama for test generation.'; return; }
    if (low.includes('fix'))   { yield '🔧 Offline mode: install Ollama for error fixing.';    return; }
    yield '💡 **Offline mode** — no AI model configured.\n\n' +
          'Free local option: `ollama pull qwen2.5-coder:7b`\n' +
          'Or press **Switch** to configure an API key.';
  }

  // ── HTTP streaming engine ────────────────────────────────────────────────────

  private async* _httpStream(
    url: URL,
    body: string,
    parseChunk: (raw: string) => string,
    extraHeaders: Record<string, string | number> = {},
    signal?: AbortSignal   // [FIX-5]
  ): AsyncGenerator<string> {
    // [FIX-5] Check for pre-cancelled request
    if (signal?.aborted) { yield '⚠ Request cancelled'; return; }

    const lib     = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
    };

    let done = false;
    const pending: string[]               = [];
    let   waiter:  ((v: void) => void) | null = null;
    const wake = () => { waiter?.(); };

    const req = lib.request(options, res => {
      if ((res.statusCode ?? 0) >= 400) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end',  () => { pending.push(`⚠ API ${res.statusCode}: ${err.slice(0, 200)}`); done = true; wake(); });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d: string) => {
        // [FIX-5] Stop processing if cancelled
        if (signal?.aborted) { res.destroy(); done = true; wake(); return; }
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const t = parseChunk(line);
          if (t) { pending.push(t); wake(); }
        }
      });
      res.on('end',   () => { if (buf.trim()) { const t = parseChunk(buf); if (t) pending.push(t); } done = true; wake(); });
      res.on('error', (e: Error) => { pending.push(`⚠ Stream error: ${e.message}`); done = true; wake(); });
    });

    req.on('error',   (e: Error) => { pending.push(`⚠ Connection error: ${e.message}`); done = true; wake(); });
    req.setTimeout(60000, () => { req.destroy(); pending.push('⚠ Request timeout (60s)'); done = true; wake(); });

    // [FIX-5] Abort handler
    signal?.addEventListener('abort', () => { req.destroy(); pending.push(''); done = true; wake(); });

    req.write(body);
    req.end();

    while (!done || pending.length > 0) {
      if (pending.length === 0) await new Promise<void>(r => { waiter = r; });
      waiter = null;
      while (pending.length > 0) {
        const chunk = pending.shift()!;
        if (chunk) yield chunk;
      }
    }
  }

  private _cfg() { return vscode.workspace.getConfiguration('aiForge'); }
}

// Export constant keys so switchProvider command can use them
export { SECRET_ANTHROPIC, SECRET_OPENAI, SECRET_HUGGINGFACE };
