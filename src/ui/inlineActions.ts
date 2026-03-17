/**
 * ui/inlineActions.ts — Plugin-aware CodeLens + CodeActions
 *
 * FIXES APPLIED:
 *  [FIX-8] AIForgeCodeActionProvider now receives PluginRegistry and merges
 *          plugin-contributed codeActions (lightbulb QuickFix + Refactor items)
 *          alongside the built-in ones
 */

import * as vscode from 'vscode';
import type { PluginRegistry, PluginCodeLensAction, PluginCodeAction } from '../core/plugin';

// ── CodeLens provider ─────────────────────────────────────────────────────────

export class AIForgeCodeLensProvider implements vscode.CodeLensProvider {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onChange.event;

  constructor(private readonly _plugins: PluginRegistry) {
    _plugins.onDidChange(() => this._onChange.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const cfg = vscode.workspace.getConfiguration('aiForge');
    if (!cfg.get<boolean>('codeLensEnabled', true)) return [];

    const lenses: vscode.CodeLens[] = [];

    // Core: Explain / Tests / Refactor above every function
    const fnPattern = FUNCTION_PATTERNS[doc.languageId];
    if (fnPattern) {
      for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        fnPattern.lastIndex = 0; // [FIX-3] Reset in case of 'g' flag
        if (!fnPattern.test(line)) continue;
        const range = new vscode.Range(i, 0, i, line.length);
        lenses.push(
          lens(range, '$(sparkle) Explain',  'aiForge.codelens.explain',  [doc.uri, range]),
          lens(range, '$(beaker) Tests',      'aiForge.codelens.tests',    [doc.uri, range]),
          lens(range, '$(wand) Refactor',     'aiForge.codelens.refactor', [doc.uri, range]),
        );
      }
    }

    // Plugin-contributed CodeLens actions
    const pluginLens = this._plugins.codeLensActions.filter((a: PluginCodeLensAction) =>
      !a.languages.length || a.languages.includes(doc.languageId)
    );
    if (pluginLens.length) {
      for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        for (const a of pluginLens) {
          a.linePattern.lastIndex = 0; // [FIX-3] Reset in case of 'g' flag
          if (!a.linePattern.test(line)) continue;
          const range = new vscode.Range(i, 0, i, line.length);
          lenses.push(lens(range, a.title, a.command, [doc.uri, range], a.tooltip));
        }
      }
    }

    return lenses;
  }

  refresh(): void { this._onChange.fire(); }
}

// ── CodeActions (lightbulb) provider ─────────────────────────────────────────

export class AIForgeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor];

  /** [FIX-8] Now receives PluginRegistry to merge plugin code actions */
  constructor(private readonly _plugins: PluginRegistry) {}

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range,
    ctx: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Core: QuickFix per diagnostic
    for (const d of ctx.diagnostics) {
      const fix = new vscode.CodeAction(
        `$(wand) Evolve AI: Fix — ${d.message.slice(0, 60)}`,
        vscode.CodeActionKind.QuickFix
      );
      fix.diagnostics = [d];
      fix.command     = { command: 'aiForge.fixErrors', title: 'Fix with Evolve AI', arguments: [doc.uri, d] };
      fix.isPreferred = true;
      actions.push(fix);
    }

    // Core: selection actions
    if (!range.isEmpty) {
      actions.push(action('$(sparkle) Evolve AI: Explain',  'aiForge.explainSelection',  vscode.CodeActionKind.Refactor));
      actions.push(action('$(wand) Evolve AI: Refactor',    'aiForge.refactorSelection', vscode.CodeActionKind.Refactor));
      actions.push(action('$(beaker) Evolve AI: Tests',     'aiForge.addTests',          vscode.CodeActionKind.Refactor));
    }

    // [FIX-8] Plugin-contributed code actions
    for (const pa of this._plugins.codeActions as PluginCodeAction[]) {
      if (pa.languages.length && !pa.languages.includes(doc.languageId)) continue;
      if (pa.requiresSelection && range.isEmpty) continue;
      if (pa.diagnosticPattern) {
        const match = ctx.diagnostics.some(d => pa.diagnosticPattern!.test(d.message));
        if (!match) continue;
      }
      const kind = pa.kind === 'quickfix'
        ? vscode.CodeActionKind.QuickFix
        : vscode.CodeActionKind.Refactor;
      actions.push(action(pa.title, pa.command, kind));
    }

    return actions;
  }
}

// ── Register ─────────────────────────────────────────────────────────────────

export function registerInlineProviders(
  ctx: vscode.ExtensionContext,
  plugins: PluginRegistry
): AIForgeCodeLensProvider {
  const lensProvider = new AIForgeCodeLensProvider(plugins);
  const ALL_LANGS    = Object.keys(FUNCTION_PATTERNS);
  const selector     = ALL_LANGS.map(l => ({ language: l }));

  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, lensProvider),
    // [FIX-8] Pass plugins to CodeActionProvider
    vscode.languages.registerCodeActionsProvider(selector,
      new AIForgeCodeActionProvider(plugins),
      { providedCodeActionKinds: AIForgeCodeActionProvider.kinds }
    )
  );

  return lensProvider;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lens(
  range:   vscode.Range,
  title:   string,
  command: string,
  args:    unknown[],
  tooltip?: string
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: args, tooltip });
}

function action(
  title:   string,
  command: string,
  kind:    vscode.CodeActionKind
): vscode.CodeAction {
  const a   = new vscode.CodeAction(title, kind);
  a.command = { command, title };
  return a;
}

const FUNCTION_PATTERNS: Record<string, RegExp> = {
  python:          /^\s*(async\s+)?def\s+\w+\s*\(/,
  javascript:      /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let)\s+\w+\s*=\s*(async\s*)?\(/,
  typescript:      /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let)\s+\w+\s*=\s*(async\s*)?\(/,
  javascriptreact: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let)\s+\w+\s*=\s*(async\s*)?\(/,
  typescriptreact: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let)\s+\w+\s*=\s*(async\s*)?\(/,
  java:            /^\s*(public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\(/,
  go:              /^\s*func\s+/,
  rust:            /^\s*(pub\s+)?(async\s+)?fn\s+/,
  cpp:             /^\s*[\w:*&<>]+\s+\w+\s*\([^;]*\)\s*\{/,
  c:               /^\s*[\w*]+\s+\w+\s*\([^;]*\)\s*\{/,
  csharp:          /^\s*(public|private|protected|static|\s)+(async\s+)?[\w<>\[\]]+\s+\w+\s*\(/,
  ruby:            /^\s*def\s+\w+/,
  php:             /^\s*(public|private|protected|static|\s)*function\s+\w+/,
  shellscript:     /^\s*(function\s+\w+|\w+\s*\(\s*\))/,
  sql:             /^\s*(CREATE|ALTER)\s+(PROCEDURE|FUNCTION|VIEW)\s+/i,
};
