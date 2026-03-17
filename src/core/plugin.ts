/**
 * core/plugin.ts — Plugin system contract + registry
 *
 * FIXES APPLIED:
 *  [FIX-1]  PluginRegistry now holds EventBus and emits plugin.activated /
 *           plugin.deactivated — status bar and chat panel update correctly
 *  [FIX-2]  detect() wrapped in Promise.race with 3-second timeout — one slow
 *           or hanging detect() can no longer block all other plugins
 *  [FIX-3]  PluginTransform.apply() receives IServices typed properly — no more
 *           "as never" cast anywhere
 *  [FIX-8]  PluginCodeAction contribution point added — plugins can now add
 *           lightbulb QuickFix / Refactor items, not only CodeLens
 *  [FIX-13] PluginRegistry.refresh() checks aiForge.disabledPlugins before
 *           activating — users can disable individual plugins from settings
 */

import * as vscode from 'vscode';
import type { IServices }       from './services';
import type { EventBus }        from './eventBus';

// ── Plugin contribution interfaces ────────────────────────────────────────────

export interface PluginContextHook {
  key: string;
  collect(ws: vscode.WorkspaceFolder | undefined): Promise<unknown>;
  format(data: unknown): string;
}

export interface PluginCodeLensAction {
  title:       string;
  command:     string;
  linePattern: RegExp;
  languages:   string[];   // empty = all languages
  tooltip?:    string;
}

/** [FIX-8] New: plugins can add lightbulb QuickFix / Refactor code actions */
export interface PluginCodeAction {
  title:    string;
  command:  string;
  kind:     'quickfix' | 'refactor';
  /** Appear only when a diagnostic matching this pattern is present */
  diagnosticPattern?: RegExp;
  /** Appear only when code is selected */
  requiresSelection?: boolean;
  /** Language IDs this applies to. Empty = all. */
  languages: string[];
}

export interface PluginTransform {
  label:       string;
  description: string;
  extensions:  string[];
  /** [FIX-3] Properly typed IServices — no "as never" cast anywhere */
  apply(
    content:  string,
    filePath: string,
    language: string,
    services: IServices
  ): Promise<string>;
}

export interface PluginTemplate {
  label:       string;
  description: string;
  prompt(workspacePath: string): string;
}

export interface PluginStatusItem {
  text(): Promise<string>;
}

export interface PluginCommand {
  id:      string;
  title:   string;
  handler(services: IServices, ...args: unknown[]): Promise<void>;
}

// ── IPlugin interface ─────────────────────────────────────────────────────────

export interface IPlugin {
  readonly id:          string;
  readonly displayName: string;
  readonly icon:        string;

  detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean>;
  activate(services: IServices, context: vscode.ExtensionContext): Promise<vscode.Disposable[]>;
  deactivate?(): Promise<void>;

  // Optional contributions
  contextHooks?:       PluginContextHook[];
  systemPromptSection?(): string;
  codeLensActions?:    PluginCodeLensAction[];
  codeActions?:        PluginCodeAction[];   // [FIX-8]
  transforms?:         PluginTransform[];
  templates?:          PluginTemplate[];
  statusItem?:         PluginStatusItem;
  commands?:           PluginCommand[];
}

// ── Plugin Registry ───────────────────────────────────────────────────────────

const DETECT_TIMEOUT_MS = 3000; // [FIX-2]

export class PluginRegistry {
  private _registered  = new Map<string, IPlugin>();
  private _active      = new Map<string, IPlugin>();
  private _disposables = new Map<string, vscode.Disposable[]>();
  // [FIX-25] Eager command stubs so palette entries don't error when plugin inactive
  private _eagerCmds   = new Map<string, vscode.Disposable>();
  private _vsCtx?: vscode.ExtensionContext;

  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;

  /** [FIX-1] Receives EventBus so it can emit lifecycle events */
  constructor(private readonly _bus: EventBus) {}

  register(plugin: IPlugin): void {
    // [FIX-24] Prevent silent overwrites from duplicate plugin IDs
    if (this._registered.has(plugin.id)) {
      console.warn(`[Evolve AI] Duplicate plugin ID "${plugin.id}" — skipping registration`);
      return;
    }
    this._registered.set(plugin.id, plugin);

    // [FIX-25] Register stub commands eagerly so they never throw "command not found".
    // Real handlers replace these stubs when the plugin activates.
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        if (this._eagerCmds.has(cmd.id)) continue;
        const d = vscode.commands.registerCommand(cmd.id, async () => {
          const action = await vscode.window.showInformationMessage(
            `The ${plugin.displayName} plugin is not active. It activates automatically when it detects matching project files in your workspace.`,
            'Reload Window', 'Open Folder'
          );
          if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          } else if (action === 'Open Folder') {
            vscode.commands.executeCommand('workbench.action.openFolder');
          }
        });
        this._eagerCmds.set(cmd.id, d);
      }
    }
  }

  async refresh(
    ws: vscode.WorkspaceFolder | undefined,
    services: IServices,
    vsCtx: vscode.ExtensionContext
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('aiForge');
    const disabled: string[] = cfg.get('disabledPlugins', []); // [FIX-13]

    for (const [id, plugin] of this._registered) {
      const isActive = this._active.has(id);

      // [FIX-13] User-disabled plugins never activate
      if (disabled.includes(id)) {
        if (isActive) await this._deactivate(id);
        continue;
      }

      // [FIX-2] Timeout: a slow detect() cannot stall everything else
      let shouldBeActive: boolean;
      try {
        shouldBeActive = await Promise.race([
          plugin.detect(ws),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('detect() timeout')), DETECT_TIMEOUT_MS)
          ),
        ]);
      } catch (e) {
        console.warn(`[Evolve AI] Plugin ${id} detect() failed/timed out:`, e);
        shouldBeActive = false;
      }

      if (shouldBeActive && !isActive) {
        await this._activate(plugin, services, vsCtx);
      } else if (!shouldBeActive && isActive) {
        await this._deactivate(id);
      }
    }
    this._onChange.fire();
  }

  private async _activate(
    plugin: IPlugin,
    services: IServices,
    vsCtx: vscode.ExtensionContext
  ): Promise<void> {
    try {
      const disposables = await plugin.activate(services, vsCtx);
      this._active.set(plugin.id, plugin);
      this._disposables.set(plugin.id, disposables);

      if (plugin.commands) {
        for (const cmd of plugin.commands) {
          // [FIX-25] Dispose the eager stub before registering the real handler
          this._eagerCmds.get(cmd.id)?.dispose();
          this._eagerCmds.delete(cmd.id);
          const d = vscode.commands.registerCommand(cmd.id, async (...args) => {
            try {
              await cmd.handler(services, ...args);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[Evolve AI] Command ${cmd.id} failed:`, e);
              vscode.window.showErrorMessage(`Evolve AI: ${msg}`);
            }
          });
          disposables.push(d);
          vsCtx.subscriptions.push(d);
        }
      }

      // [FIX-1] Actually emit the event — status bar and chat panel listen here
      this._bus.emit('plugin.activated', {
        pluginId:    plugin.id,
        displayName: plugin.displayName,
      });
      console.log(`[Evolve AI] Plugin activated: ${plugin.displayName}`);
    } catch (e) {
      console.error(`[Evolve AI] Plugin activation failed: ${plugin.id}`, e);
    }
  }

  private async _deactivate(id: string): Promise<void> {
    const plugin = this._active.get(id);
    if (!plugin) return;
    try {
      await plugin.deactivate?.();
      for (const d of this._disposables.get(id) ?? []) d.dispose();
    } catch (e) {
      console.error(`[Evolve AI] Plugin deactivation error: ${id}`, e);
    }
    this._active.delete(id);
    this._disposables.delete(id);

    // [FIX-25] Re-register stubs so commands show friendly message instead of error
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        if (this._eagerCmds.has(cmd.id)) continue;
        const d = vscode.commands.registerCommand(cmd.id, async () => {
          const action = await vscode.window.showInformationMessage(
            `The ${plugin.displayName} plugin is not active. It activates automatically when it detects matching project files in your workspace.`,
            'Reload Window', 'Open Folder'
          );
          if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          } else if (action === 'Open Folder') {
            vscode.commands.executeCommand('workbench.action.openFolder');
          }
        });
        this._eagerCmds.set(cmd.id, d);
      }
    }

    // [FIX-1] Emit deactivation event
    this._bus.emit('plugin.deactivated', { pluginId: id });
    console.log(`[Evolve AI] Plugin deactivated: ${id}`);
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  get active(): IPlugin[] { return [...this._active.values()]; }

  getActive(id: string): IPlugin | undefined { return this._active.get(id); }

  get contextHooks(): PluginContextHook[] {
    return this.active.flatMap(p => p.contextHooks ?? []);
  }

  get systemPromptSections(): string[] {
    return this.active.map(p => p.systemPromptSection?.()).filter((s): s is string => !!s);
  }

  get codeLensActions(): PluginCodeLensAction[] {
    return this.active.flatMap(p => p.codeLensActions ?? []);
  }

  /** [FIX-8] Expose plugin code actions */
  get codeActions(): PluginCodeAction[] {
    return this.active.flatMap(p => p.codeActions ?? []);
  }

  get transforms(): PluginTransform[] {
    return this.active.flatMap(p => p.transforms ?? []);
  }

  get templates(): PluginTemplate[] {
    return this.active.flatMap(p => p.templates ?? []);
  }

  async getStatusText(): Promise<string> {
    const parts: string[] = [];
    for (const plugin of this.active) {
      if (plugin.statusItem) {
        try { parts.push(await plugin.statusItem.text()); } catch { /* ignore */ }
      }
    }
    return parts.join(' · ');
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this._active.keys()]) await this._deactivate(id);
  }
}
