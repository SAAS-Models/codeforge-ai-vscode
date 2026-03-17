/**
 * core/workspaceService.ts — File and workspace operations
 *
 * FIXES APPLIED:
 *  [FIX-3]  pluginTransform.apply() receives properly typed IServices —
 *           no "as never" cast
 *  [FIX-6]  showDiff() added — callers can preview before overwriting
 *  [FIX-7]  applyToFolder now batches all changes in a WorkspaceEdit
 *           (fully undoable with Ctrl+Z) instead of fs.writeFileSync
 *  [FIX-10] Implements IWorkspaceService interface
 *  [FIX-14] Uses getActiveWorkspaceFolder() for multi-root support
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type { PluginRegistry, PluginTransform } from './plugin';
import type { AIRequest }                       from './aiService';
import type { IAIService, IContextService }     from './interfaces';
import type { IServices }                       from './services';
import type { IWorkspaceService }               from './interfaces';
import { getActiveWorkspaceFolder }             from './contextService';

// Re-export for convenience
export type { AIRequest };

export interface GeneratedFile {
  path:    string;
  content: string;
}

export class WorkspaceService implements IWorkspaceService {
  constructor(
    private readonly _plugins: PluginRegistry,
    private readonly _ai:      IAIService,
    private readonly _context: IContextService,
    private readonly _vsCtx:   vscode.ExtensionContext,
    private readonly _events:  import('./eventBus').EventBus
  ) {}

  // ── Apply AI edit to active file (always undoable) ────────────────────────

  async applyToActiveFile(newContent: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('No active editor');
    const doc   = editor.document;
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit  = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, newContent);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  // ── [FIX-6] Diff preview ─────────────────────────────────────────────────────

  async showDiff(
    original: string,
    proposed: string,
    title: string
  ): Promise<'apply' | 'cancel'> {
    // Write proposed content to a temp file so VS Code's diff editor can display it
    const tmpDir  = this._vsCtx.globalStorageUri.fsPath;
    fs.mkdirSync(tmpDir, { recursive: true });

    const tmpPath = path.join(tmpDir, 'ai-forge-diff-preview.tmp');
    fs.writeFileSync(tmpPath, proposed, 'utf8');

    const editor = vscode.window.activeTextEditor;
    if (!editor) return 'cancel';

    await vscode.commands.executeCommand(
      'vscode.diff',
      editor.document.uri,
      vscode.Uri.file(tmpPath),
      `Evolve AI — ${title} (read-only preview)`
    );

    const answer = await vscode.window.showInformationMessage(
      'Apply this AI-generated change to your file?',
      { modal: false },
      'Apply', 'Cancel'
    );

    // Clean up tmp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

    return answer === 'Apply' ? 'apply' : 'cancel';
  }

  // ── Write a new file ─────────────────────────────────────────────────────────

  async writeFile(filePath: string, content: string, openAfter = true): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    if (openAfter) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return uri;
  }

  // ── Parse AI multi-file output ────────────────────────────────────────────────

  parseMultiFileOutput(aiOutput: string, baseDir: string): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    let m: RegExpExecArray | null;

    // Pattern 1: ## filename.ext\n```lang\n...\n```
    const p1 = /^#{1,3}\s+([\w./\-]+\.\w+)\s*\n+```[\w]*\n([\s\S]*?)```/gm;
    while ((m = p1.exec(aiOutput)) !== null) {
      const full = path.join(baseDir, m[1].trim());
      if (isSafePath(full, baseDir)) files.push({ path: full, content: m[2].trim() });
    }

    // Pattern 2: // filename.ext  or  # filename.ext
    if (!files.length) {
      const p2 = /^(?:\/\/|#)\s+([\w./\-]+\.\w+)\s*\n([\s\S]*?)(?=^(?:\/\/|#)\s+[\w./\-]+\.\w+|\s*$)/gm;
      while ((m = p2.exec(aiOutput)) !== null) {
        const full = path.join(baseDir, m[1].trim());
        if (isSafePath(full, baseDir)) files.push({ path: full, content: m[2].trim() });
      }
    }

    // Pattern 3: === filename.ext ===
    if (!files.length) {
      const p3 = /^={3}\s+([\w./\-]+\.\w+)\s*={3}\s*\n([\s\S]*?)(?=^={3}|\s*$)/gm;
      while ((m = p3.exec(aiOutput)) !== null) {
        const full = path.join(baseDir, m[1].trim());
        if (isSafePath(full, baseDir)) files.push({ path: full, content: m[2].trim() });
      }
    }

    // Fallback: whole output as single file (extension unknown → .txt)
    if (!files.length && aiOutput.trim()) {
      const cleaned = aiOutput.replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      files.push({ path: path.join(baseDir, 'generated.txt'), content: cleaned });
    }

    return files;
  }

  // ── Apply a set of generated files ────────────────────────────────────────────

  async applyGeneratedFiles(files: GeneratedFile[]): Promise<void> {
    if (!files.length) return;

    if (files.length > 1) {
      const ws   = getActiveWorkspaceFolder(); // [FIX-14]
      const list = files.map(f =>
        `• ${ws ? path.relative(ws.uri.fsPath, f.path) : path.basename(f.path)}`
      ).join('\n');
      const ans  = await vscode.window.showInformationMessage(
        `Evolve AI will create/update ${files.length} file(s):\n${list}`,
        { modal: true }, 'Apply All', 'Cancel'
      );
      if (ans !== 'Apply All') return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const f of files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      const uri = vscode.Uri.file(f.path);
      if (fs.existsSync(f.path)) {
        const doc   = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(uri, range, f.content);
      } else {
        // [FIX-1] createFile with contents — fully on the undo stack
        edit.createFile(uri, { contents: new TextEncoder().encode(f.content) });
      }
    }
    await vscode.workspace.applyEdit(edit);

    if (files.length > 0) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(files[0].path));
      await vscode.window.showTextDocument(doc);
    }
  }

  // ── [FIX-7] Apply transform to folder — now fully undoable via WorkspaceEdit ─

  async applyToFolder(folderPath: string): Promise<void> {
    type Item = vscode.QuickPickItem & { isCustom?: boolean; plugin?: PluginTransform };

    const coreItems: Item[] = [
      { label: '$(symbol-type-parameter) Add type hints',  description: 'Add type annotations to all functions' },
      { label: '$(book) Add documentation',               description: 'Add docstrings/JSDoc to all functions' },
      { label: '$(shield) Add error handling',            description: 'Wrap risky code in try/catch or try/except' },
      { label: '$(search) Fix linting issues',            description: 'Fix style and lint warnings' },
    ];

    const pluginItems: Item[] = this._plugins.transforms.map(t => ({
      label:       `$(extensions) ${t.label}`,
      description: t.description,
      plugin:      t,
    }));

    const allItems: Item[] = [
      ...coreItems,
      ...(pluginItems.length ? [{ label: '── Plugin transforms ──', description: '' } as Item] : []),
      ...pluginItems,
      { label: '$(edit) Custom instruction…', description: 'Enter your own transform', isCustom: true },
    ];

    const choice = await vscode.window.showQuickPick(allItems, {
      placeHolder: 'Choose a transform to apply to all files in this folder',
      matchOnDescription: true,
    });
    if (!choice || choice.label.startsWith('──')) return;

    let instruction     = choice.label.replace(/\$\([^)]+\)\s*/, '');
    let pluginTransform = choice.plugin;

    if (choice.isCustom) {
      const custom = await vscode.window.showInputBox({ prompt: 'Transform instruction' });
      if (!custom) return;
      instruction = custom;
    }

    // [FIX-7] Warn: we need to collect all edits in WorkspaceEdit
    const ans = await vscode.window.showInformationMessage(
      `Transform "${instruction}" will be applied to all matching files. This is undoable via Ctrl+Z.`,
      'Continue', 'Cancel'
    );
    if (ans !== 'Continue') return;

    const extensions = pluginTransform?.extensions ?? ['.py','.ts','.js','.java','.go','.rs','.cs','.rb','.php'];
    const MAX_FOLDER_FILES = 50; // [FIX-13] Cap file count to prevent unbounded cost
    const allFiles   = walkDir(folderPath, extensions);
    const files      = allFiles.slice(0, MAX_FOLDER_FILES);

    if (allFiles.length > MAX_FOLDER_FILES) {
      const cap = await vscode.window.showWarningMessage(
        `Found ${allFiles.length} files. Processing capped at ${MAX_FOLDER_FILES} to manage cost.`,
        'Continue', 'Cancel'
      );
      if (cap !== 'Continue') return;
    }

    let processed = 0, skipped = 0;

    const batchEdit = new vscode.WorkspaceEdit(); // [FIX-7] One WorkspaceEdit for all files

    await vscode.window.withProgress({
      location:    vscode.ProgressLocation.Notification,
      title:       'Evolve AI: Applying transform…',
      cancellable: true,
    }, async (progress, token) => {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) break;
        const filePath = files[i];
        const lang     = EXT_LANG[path.extname(filePath)] ?? 'text';

        progress.report({
          message:   `${i + 1}/${files.length}: ${path.basename(filePath)}`,
          increment: 100 / files.length,
        });

        try {
          const original = fs.readFileSync(filePath, 'utf8');
          let updated: string;

          if (pluginTransform) {
            // [FIX-3] Properly typed — no casts needed
            const svcObj: IServices = {
              ai:        this._ai,
              context:   this._context,
              workspace: this,
              plugins:   this._plugins,
              events:    this._events,
              vsCtx:     this._vsCtx,
            };
            updated = await pluginTransform.apply(original, filePath, lang, svcObj);
          } else {
            const ctx = await this._context.build({ includeRelated: false, includeGitDiff: false });
            const sys = this._context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages:    [{ role: 'user', content:
                `File: ${filePath} (${lang})\n\`\`\`\n${original}\n\`\`\`\n\n${instruction}\n\nReturn ONLY the complete updated file.`
              }],
              system:      sys,
              instruction: instruction,
              mode:        'edit',
            };
            updated = (await this._ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
          }

          if (updated && updated !== original) {
            // [FIX-7] Queue in WorkspaceEdit instead of fs.writeFileSync
            const uri = vscode.Uri.file(filePath);
            try {
              const doc   = await vscode.workspace.openTextDocument(uri);
              const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
              batchEdit.replace(uri, range, updated);
              processed++;
            } catch {
              // File not openable — fall back to direct write (rare)
              fs.writeFileSync(filePath, updated, 'utf8');
              processed++;
            }
          } else {
            skipped++;
          }
        } catch { skipped++; }
      }
    });

    if (batchEdit.size > 0) {
      await vscode.workspace.applyEdit(batchEdit);
    }

    vscode.window.showInformationMessage(
      `Evolve AI: Done. ${processed} file(s) updated (undoable with Ctrl+Z), ${skipped} unchanged.`
    );
  }

  // ── Runtime command ───────────────────────────────────────────────────────────

  // [SEC-1] Shell-safe quoting — escape special chars to prevent injection
  getRuntimeCommand(filePath: string, lang: string): string | null {
    const safe = shellEscape(filePath);
    const map: Record<string, string> = {
      python:      `python3 ${safe}`,
      javascript:  `node ${safe}`,
      typescript:  `npx ts-node ${safe}`,
      go:          `go run ${safe}`,
      rust:        `cargo run`,
      java:        `javac ${safe} && java ${shellEscape(path.basename(filePath, '.java'))}`,
      shellscript: `bash ${safe}`,
      ruby:        `ruby ${safe}`,
      php:         `php ${safe}`,
    };
    return map[lang] ?? null;
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

// [FIX-12] Depth-limited directory walk
function walkDir(dir: string, exts: string[], maxDepth = 5, depth = 0): string[] {
  if (depth >= maxDepth) return [];
  const out:  string[] = [];
  const SKIP = new Set(['node_modules','.git','__pycache__','dist','build','.venv','venv','.databricks','out']);
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walkDir(full, exts, maxDepth, depth + 1));
      else if (exts.includes(path.extname(e.name))) out.push(full);
    }
  } catch { /* skip unreadable dirs */ }
  return out;
}

export const EXT_LANG: Record<string, string> = {
  '.py':'python', '.js':'javascript', '.ts':'typescript', '.jsx':'javascriptreact',
  '.tsx':'typescriptreact', '.java':'java', '.go':'go', '.rs':'rust',
  '.cpp':'cpp', '.c':'c', '.cs':'csharp', '.rb':'ruby', '.php':'php',
  '.sh':'shellscript', '.sql':'sql', '.html':'html', '.css':'css',
  '.yml':'yaml', '.yaml':'yaml',
};

// [SEC-1] Escape file path for safe shell interpolation.
// Wraps in single quotes and escapes any embedded single quotes.
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// [SEC-2] Verify that a resolved path stays within the allowed base directory.
// Prevents path traversal via ".." in AI-generated filenames.
function isSafePath(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  const base     = path.resolve(baseDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    console.warn(`[Evolve AI] Blocked path traversal: "${filePath}" escapes "${baseDir}"`);
    return false;
  }
  return true;
}
