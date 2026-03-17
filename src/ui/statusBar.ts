/**
 * ui/statusBar.ts — Status bar service
 *
 * Shows: AI provider + model + active plugins
 * Updates on: provider change, plugin activation/deactivation, timer
 */

import * as vscode from 'vscode';
import type { IServices } from '../core/services';

export class StatusBarService {
  private readonly _item: vscode.StatusBarItem;
  private _timer: NodeJS.Timeout;

  constructor(private readonly _svc: IServices) {
    this._item         = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._item.command = 'aiForge.switchProvider';
    _svc.vsCtx.subscriptions.push(this._item);

    // Refresh on events
    _svc.events.on('provider.changed',   () => this.refresh());
    _svc.events.on('plugin.activated',   () => this.refresh());
    _svc.events.on('plugin.deactivated', () => this.refresh());
    _svc.events.on('ui.status.update',   () => this.refresh());

    // Periodic refresh (Ollama may start/stop)
    this._timer = setInterval(() => this.refresh(), 30_000);
    _svc.vsCtx.subscriptions.push({ dispose: () => clearInterval(this._timer) });

    this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const cfg      = vscode.workspace.getConfiguration('aiForge');
      const provider = await this._svc.ai.detectProvider();
      // [FIX-21] Pass configured host so non-default Ollama servers are detected
      const host     = cfg.get<string>('ollamaHost', 'http://localhost:11434');
      const running  = provider === 'ollama' ? await this._svc.ai.isOllamaRunning(host) : false;
      const model    = cfg.get<string>('ollamaModel', '');
      const active   = this._svc.plugins.active;

      const icon = {
        ollama:       '$(server)',
        anthropic:    '$(cloud)',
        openai:       '$(globe)',
        huggingface:  '$(hubot)',
        offline:      '$(circuit-board)',
        auto:         '$(circuit-board)',
      }[provider] ?? '$(circuit-board)';

      const modelShort = model ? model.split(':')[0] : '';
      const pluginTag  = active.length > 0
        ? ` · ${active.map(p => p.icon).join(' ')}`
        : '';

      this._item.text    = `${icon} Evolve AI${modelShort ? ': ' + modelShort : ''}${pluginTag}`;
      this._item.tooltip = this._buildTooltip(provider, model, running, active);
      this._item.show();
    } catch (e) {
      // [FIX-22] Log errors instead of silently swallowing them
      console.error('[Evolve AI] Status bar refresh failed:', e);
    }
  }

  private _buildTooltip(
    provider: string,
    model: string,
    ollamaRunning: boolean,
    active: { displayName: string; id: string }[]
  ): string {
    const lines = [
      `Evolve AI`,
      `Provider: ${provider}${ollamaRunning ? ' ✓' : ''}`,
      model ? `Model: ${model}` : '',
      active.length > 0 ? `Active plugins: ${active.map(p => p.displayName).join(', ')}` : 'No plugins active',
      '',
      'Click to switch provider',
    ];
    return lines.filter(Boolean).join('\n');
  }
}
