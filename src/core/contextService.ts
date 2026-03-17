/**
 * core/contextService.ts — Project context assembly with plugin hooks
 *
 * FIXES APPLIED:
 *  [FIX-9]  Total context budget cap (default 24 000 chars).
 *           Budget allocated proportionally: active file is priority-1,
 *           related files share remaining space, plugin data gets fixed slice.
 *  [FIX-10] Implements IContextService interface
 *  [FIX-14] getActiveWorkspaceFolder() uses active editor path to pick the
 *           correct folder in multi-root workspaces
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type { PluginRegistry, PluginContextHook } from './plugin';
import type { IContextService }                    from './interfaces';
import { EXT_LANG }                                from './workspaceService';

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface FileContext {
  path:     string;
  relPath:  string;
  content:  string;
  language: string;
}

export interface ErrorContext {
  file:     string;
  line:     number;
  col:      number;
  message:  string;
  severity: 'error' | 'warning';
  source:   string;
}

export interface ProjectContext {
  activeFile:    FileContext | null;
  selection:     string | null;
  errors:        ErrorContext[];
  gitDiff:       string | null;
  gitBranch:     string | null;
  relatedFiles:  FileContext[];
  workspaceName: string;
  language:      string;
  pluginData:    Map<string, unknown>;
  /** [FIX-9] How many chars were budgeted vs actually used */
  contextBudget: { total: number; used: number };
}

export interface BuildContextOptions {
  includeErrors?:   boolean;
  includeGitDiff?:  boolean;
  includeRelated?:  boolean;
  maxRelatedFiles?: number;
  /** Override the global budget (chars). Default: aiForge.contextBudget or 24000 */
  budgetChars?:     number;
}

// ── [FIX-9] Budget constants ──────────────────────────────────────────────────

const DEFAULT_BUDGET     = 24_000;  // chars — ~6 000 tokens at 4 chars/token
const ACTIVE_FILE_SHARE  = 0.50;    // 50% for active file
const RELATED_FILE_SHARE = 0.25;    // 25% for related files (shared)
const PLUGIN_DATA_SHARE  = 0.10;    // 10% for plugin-contributed context
const GIT_DIFF_SHARE     = 0.10;    // 10% for git diff
const ERRORS_SHARE       = 0.05;    // 5% for errors list

// ── [FIX-14] Active workspace folder helper ───────────────────────────────────

export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

// ── ContextService ────────────────────────────────────────────────────────────

export class ContextService implements IContextService {
  // [FIX-11] Cache plugin hook results to avoid repeated file I/O
  private _hookCache = new Map<string, { data: unknown; ts: number }>();
  private static readonly HOOK_CACHE_TTL = 10_000; // 10 seconds

  constructor(private readonly _plugins: PluginRegistry) {}

  /** Invalidate hook cache (call on file changes) */
  invalidateHookCache(): void {
    this._hookCache.clear();
  }

  async build(options: BuildContextOptions = {}): Promise<ProjectContext> {
    const cfg = vscode.workspace.getConfiguration('aiForge');
    const {
      includeErrors   = cfg.get<boolean>('includeErrorsInContext', true),
      includeGitDiff  = cfg.get<boolean>('includeGitDiffInContext', false), // [FIX-7] Default false
      includeRelated  = true,
      maxRelatedFiles = cfg.get<number>('maxContextFiles', 5),
      budgetChars     = cfg.get<number>('contextBudgetChars', DEFAULT_BUDGET),
    } = options;

    const editor   = vscode.window.activeTextEditor;
    const wsFolder = getActiveWorkspaceFolder(); // [FIX-14]

    // ── Gather raw data (full, un-truncated) ──────────────────────────────────

    const rawActive     = editor ? await this._fileCtx(editor.document, wsFolder) : null;
    const selection     = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection) : null;
    const errors        = includeErrors ? this._errors(wsFolder) : [];
    const git           = includeGitDiff ? await this._git(wsFolder) : { diff: null, branch: null };
    const rawRelated    = includeRelated && rawActive
      ? this._related(rawActive, wsFolder, maxRelatedFiles) : [];

    // [FIX-11] Plugin data with TTL cache — avoids repeated file I/O on every AI call
    // [FIX-23] Individual hook timeout prevents a slow plugin from blocking all AI calls
    const HOOK_TIMEOUT = 5_000;
    const pluginData = new Map<string, unknown>();
    const now = Date.now();
    await Promise.all(
      this._plugins.contextHooks.map(async (hook: PluginContextHook) => {
        const cached = this._hookCache.get(hook.key);
        if (cached && (now - cached.ts) < ContextService.HOOK_CACHE_TTL) {
          pluginData.set(hook.key, cached.data);
          return;
        }
        try {
          const data = await Promise.race([
            hook.collect(wsFolder),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Hook "${hook.key}" timed out`)), HOOK_TIMEOUT)
            ),
          ]);
          this._hookCache.set(hook.key, { data, ts: now });
          pluginData.set(hook.key, data);
        } catch (e) {
          console.warn(`[Evolve AI] Context hook "${hook.key}" failed:`, e);
        }
      })
    );

    // ── [FIX-9] Apply budget: truncate each section proportionally ───────────

    const activeFile  = rawActive  ? truncateFile(rawActive,  Math.floor(budgetChars * ACTIVE_FILE_SHARE))  : null;
    const perRelated  = rawRelated.length > 0
      ? Math.floor((budgetChars * RELATED_FILE_SHARE) / rawRelated.length)
      : 0;
    const relatedFiles = rawRelated.map(f => truncateFile(f, perRelated));

    // [FIX-25] Truncate diff at a line boundary to avoid breaking unified diff format
    const gitDiffBudget  = Math.floor(budgetChars * GIT_DIFF_SHARE);
    const gitDiff        = git.diff
      ? (git.diff.length > gitDiffBudget
          ? git.diff.slice(0, git.diff.lastIndexOf('\n', gitDiffBudget)) + '\n... (diff truncated)'
          : git.diff)
      : null;

    const errBudget = Math.floor(budgetChars * ERRORS_SHARE / 80); // ~80 chars per error
    const cappedErrors = errors.slice(0, Math.max(3, errBudget));

    // Track how much we actually used
    const used = (activeFile?.content.length ?? 0)
      + relatedFiles.reduce((a, f) => a + f.content.length, 0)
      + (gitDiff?.length ?? 0)
      + cappedErrors.reduce((a, e) => a + e.message.length, 0);

    return {
      activeFile,
      selection,
      errors:       cappedErrors,
      gitDiff,
      gitBranch:    git.branch,
      relatedFiles,
      workspaceName: wsFolder?.name ?? 'workspace',
      language:      rawActive?.language ?? 'unknown',
      pluginData,
      contextBudget: { total: budgetChars, used },
    };
  }

  // ── Prompt builders ──────────────────────────────────────────────────────────

  buildSystemPrompt(ctx: ProjectContext): string {
    const lines = [
      'You are Evolve AI, an expert coding assistant embedded in VS Code.',
      `Project: ${ctx.workspaceName}`,
      ctx.gitBranch ? `Git branch: ${ctx.gitBranch}` : '',
      '',
      'RULES:',
      '- When editing code, return ONLY the complete updated file. No markdown fences unless asked.',
      '- When generating new files, use ## filename.ext before each file\'s content.',
      '- Be surgical. Do not rewrite working code unnecessarily.',
      '- Reference files by their relative path.',
    ].filter(Boolean).join('\n');

    const pluginSections = this._plugins.systemPromptSections;
    if (pluginSections.length === 0) return lines;
    return [lines, '', '--- DOMAIN CONTEXT ---', ...pluginSections].join('\n');
  }

  buildUserPrompt(ctx: ProjectContext, instruction: string): string {
    const parts: string[] = [];

    if (ctx.activeFile) {
      parts.push(`## Active file: ${ctx.activeFile.relPath} (${ctx.activeFile.language})`);
      parts.push(ctx.selection
        ? `### Selected:\n\`\`\`\n${ctx.selection}\n\`\`\``
        : `\`\`\`${ctx.activeFile.language}\n${ctx.activeFile.content}\n\`\`\``
      );
    }

    if (ctx.errors.length > 0) {
      parts.push(`## Errors (${ctx.errors.length}):`);
      ctx.errors.forEach(e => parts.push(`- [${e.severity}] ${e.file}:${e.line} — ${e.message}`));
    }

    if (ctx.gitDiff) parts.push(`## Git changes:\n${ctx.gitDiff}`);

    // Plugin context data
    for (const hook of this._plugins.contextHooks) {
      const data = ctx.pluginData.get(hook.key);
      if (data !== undefined) {
        try {
          const fmt = hook.format(data);
          if (fmt) parts.push(fmt);
        } catch { /* skip broken hook */ }
      }
    }

    ctx.relatedFiles.forEach(rf =>
      parts.push(`## Related: ${rf.relPath}\n\`\`\`${rf.language}\n${rf.content}\n\`\`\``)
    );

    parts.push(`## Instruction:\n${instruction}`);
    return parts.join('\n\n');
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _fileCtx(
    doc: vscode.TextDocument,
    ws?: vscode.WorkspaceFolder
  ): Promise<FileContext> {
    return {
      path:     doc.uri.fsPath,
      relPath:  ws ? path.relative(ws.uri.fsPath, doc.uri.fsPath) : path.basename(doc.uri.fsPath),
      content:  doc.getText(),      // raw — budget applied in build()
      language: doc.languageId,
    };
  }

  private _errors(ws?: vscode.WorkspaceFolder): ErrorContext[] {
    const out: ErrorContext[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (ws && !uri.fsPath.startsWith(ws.uri.fsPath)) continue;
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        out.push({
          file:     path.relative(ws?.uri.fsPath ?? '', uri.fsPath),
          line:     d.range.start.line + 1,
          col:      d.range.start.character + 1,
          message:  d.message,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
          source:   d.source ?? 'unknown',
        });
      }
    }
    return out;
  }

  private async _git(ws?: vscode.WorkspaceFolder): Promise<{ diff: string | null; branch: string | null }> {
    if (!ws) return { diff: null, branch: null };
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) return { diff: null, branch: null };
      const git  = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      const api  = git.getAPI(1);
      const repo = api.repositories.find(
        (r: { rootUri: vscode.Uri }) => r.rootUri.fsPath === ws.uri.fsPath
      ) ?? api.repositories[0];
      if (!repo) return { diff: null, branch: null };

      const branch  = repo.state.HEAD?.name ?? null;
      const staged  = repo.state.indexChanges ?? [];
      const working = repo.state.workingTreeChanges ?? [];
      const all     = [...staged, ...working].slice(0, 10);
      if (!all.length) return { diff: null, branch };

      const lines = [`Branch: ${branch}`, `Changed (${all.length}):`];
      all.forEach(c =>
        lines.push(`  [${staged.includes(c) ? 'staged' : 'unstaged'}] ${path.basename(c.uri.fsPath)}`)
      );
      try {
        const d = await repo.diff(true);
        lines.push('\n--- Staged diff ---');
        lines.push(d);    // budget cap applied in build()
      } catch { /* diff unavailable */ }

      return { diff: lines.join('\n'), branch };
    } catch { return { diff: null, branch: null }; }
  }

  // [FIX-4] Uses fs.readFileSync instead of openTextDocument to avoid polluting
  // the VS Code working set (open editors) on every AI call
  private _related(
    active: FileContext,
    ws?: vscode.WorkspaceFolder,
    max = 5
  ): FileContext[] {
    if (!ws) return [];
    const out:      FileContext[] = [];
    const baseName = path.basename(active.path, path.extname(active.path));
    const dir      = path.dirname(active.path);

    try {
      for (const f of fs.readdirSync(dir)) {
        if (out.length >= max) break;
        const full = path.join(dir, f);
        if (full !== active.path && f.includes(baseName)) {
          try {
            const content  = fs.readFileSync(full, 'utf8');
            const ext      = path.extname(full);
            out.push({
              path:     full,
              relPath:  path.relative(ws.uri.fsPath, full),
              content,
              language: EXT_LANG[ext] ?? 'text',
            });
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip */ }

    if (out.length < max) {
      const re = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(active.content)) !== null && out.length < max) {
        if (!m[1].startsWith('.')) continue;
        for (const suf of ['', '.ts', '.js', '/index.ts', '/index.js']) {
          const full = path.resolve(dir, m[1] + suf);
          if (fs.existsSync(full) && !out.find(r => r.path === full)) {
            try {
              const content = fs.readFileSync(full, 'utf8');
              const ext     = path.extname(full);
              out.push({
                path:     full,
                relPath:  path.relative(ws.uri.fsPath, full),
                content,
                language: EXT_LANG[ext] ?? 'text',
              });
              break;
            } catch { /* skip */ }
          }
        }
      }
    }

    return out.slice(0, max);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateFile(f: FileContext, maxChars: number): FileContext {
  if (f.content.length <= maxChars) return f;
  return { ...f, content: f.content.slice(0, maxChars) + '\n... (truncated to fit context budget)' };
}
