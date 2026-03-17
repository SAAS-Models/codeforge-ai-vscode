/**
 * plugins/git.ts — Git plugin for Evolve AI
 *
 * Always-on plugin that detects .git/ in the workspace root.
 * Contributes:
 *  - contextHooks      : git status (branch, modified/staged/untracked counts) + recent commits
 *  - systemPromptSection: conventional commits, branch naming, PR best practices, git workflow
 *  - codeLensActions   : git blame above function definitions
 *  - codeActions       : generate commit message, generate PR description
 *  - transforms        : generate changelog from recent commits
 *  - templates         : PR description, conventional commit message, .gitignore for [language]
 *  - commands          : blame, changelog, commitMessage, prTemplate
 *  - statusItem        : branch name with dirty indicator
 */

import * as vscode        from 'vscode';
import * as path          from 'path';
import * as fs            from 'fs';
import { execSync }       from 'child_process';
import type {
  IPlugin,
  PluginContextHook,
  PluginCodeLensAction,
  PluginCodeAction,
  PluginTransform,
  PluginTemplate,
  PluginStatusItem,
  PluginCommand,
} from '../core/plugin';
import type { IServices } from '../core/services';
import type { AIRequest } from '../core/aiService';

// ── Helpers ──────────────────────────────────────────────────────────────────

function gitExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 3000, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getBranch(wsPath: string): string {
  return gitExec('git rev-parse --abbrev-ref HEAD', wsPath) || 'unknown';
}

function isDirty(wsPath: string): boolean {
  const status = gitExec('git status --porcelain', wsPath);
  return status.length > 0;
}

function getRemoteUrl(wsPath: string): string {
  return gitExec('git remote get-url origin', wsPath);
}

// ── Status data interface ─────────────────────────────────────────────────────

interface GitStatusData {
  branch:      string;
  modified:    number;
  staged:      number;
  untracked:   number;
  remoteUrl:   string;
}

interface GitCommitsData {
  commits: string[];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class GitPlugin implements IPlugin {
  readonly id          = 'git';
  readonly displayName = 'Git';
  readonly icon        = '$(git-branch)';

  private _wsPath  = '';
  private _branch  = 'unknown';
  private _dirty   = false;
  private _remote  = '';

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) { return false; }
    try {
      return fs.existsSync(path.join(ws.uri.fsPath, '.git'));
    } catch {
      return false;
    }
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(
    _services: IServices,
    _vsCtx: vscode.ExtensionContext
  ): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      this._wsPath = ws.uri.fsPath;
      this._branch = getBranch(this._wsPath);
      this._dirty  = isDirty(this._wsPath);
      this._remote = getRemoteUrl(this._wsPath);
    }

    console.log(`[Evolve AI] Git plugin activated — branch: ${this._branch}, dirty: ${this._dirty}`);
    return [];
  }

  // ── deactivate ────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._wsPath = '';
    this._branch = 'unknown';
    this._dirty  = false;
    this._remote = '';
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'git.status',

      async collect(ws: vscode.WorkspaceFolder | undefined): Promise<unknown> {
        if (!ws) {
          return { branch: 'unknown', modified: 0, staged: 0, untracked: 0, remoteUrl: '' };
        }
        const wsPath = ws.uri.fsPath;

        const branch    = gitExec('git rev-parse --abbrev-ref HEAD', wsPath) || 'unknown';
        const remoteUrl = gitExec('git remote get-url origin', wsPath);

        let modified  = 0;
        let staged    = 0;
        let untracked = 0;

        try {
          const statusOutput = execSync('git status --porcelain', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          });
          for (const line of statusOutput.split('\n')) {
            if (line.length < 2) { continue; }
            const xy = line.slice(0, 2);
            const x  = xy[0];
            const y  = xy[1];
            if (x === '?' && y === '?') {
              untracked++;
            } else {
              if (x !== ' ' && x !== '?') { staged++; }
              if (y !== ' ' && y !== '?') { modified++; }
            }
          }
        } catch { /* ignore */ }

        const data: GitStatusData = { branch, modified, staged, untracked, remoteUrl };
        return data;
      },

      format(data: unknown): string {
        const d = data as GitStatusData;
        const lines: string[] = [
          '## Git Status',
          `Branch: ${d.branch}`,
        ];
        if (d.staged > 0)    { lines.push(`Staged changes: ${d.staged} file(s)`); }
        if (d.modified > 0)  { lines.push(`Unstaged modifications: ${d.modified} file(s)`); }
        if (d.untracked > 0) { lines.push(`Untracked files: ${d.untracked} file(s)`); }
        if (d.staged === 0 && d.modified === 0 && d.untracked === 0) {
          lines.push('Working tree clean.');
        }
        if (d.remoteUrl) { lines.push(`Remote: ${d.remoteUrl}`); }
        return lines.join('\n');
      },
    },

    {
      key: 'git.recentCommits',

      async collect(ws: vscode.WorkspaceFolder | undefined): Promise<unknown> {
        if (!ws) { return { commits: [] }; }
        const wsPath = ws.uri.fsPath;

        let commits: string[] = [];
        try {
          const log = execSync('git log --oneline -5', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          });
          commits = log.split('\n').filter(l => l.trim().length > 0);
        } catch { /* ignore */ }

        const data: GitCommitsData = { commits };
        return data;
      },

      format(data: unknown): string {
        const d = data as GitCommitsData;
        if (d.commits.length === 0) {
          return '## Recent Commits\nNo commits found.';
        }
        return `## Recent Commits\n${d.commits.map(c => `- ${c}`).join('\n')}`;
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Git Best Practices

### Conventional Commits Format
Use the Conventional Commits specification for all commit messages:
\`<type>[optional scope]: <description>\`

Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
- **feat**: A new feature (correlates with MINOR in SemVer)
- **fix**: A bug fix (correlates with PATCH in SemVer)
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code (formatting, semicolons)
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding or correcting tests
- **build**: Changes to the build system or external dependencies
- **ci**: Changes to CI/CD configuration files
- **chore**: Other changes that don't modify src or test files
- **revert**: Reverts a previous commit

Breaking changes: append \`!\` after type/scope or add \`BREAKING CHANGE:\` footer.

Examples:
\`\`\`
feat(auth): add OAuth2 login with Google
fix(api): handle null pointer in user endpoint
docs: update README with new setup instructions
refactor!: drop support for Python 3.8
\`\`\`

### Branch Naming Conventions
- \`main\` or \`master\`: Production-ready code
- \`develop\` or \`dev\`: Integration branch for features
- Feature branches: \`feature/<short-description>\` or \`feat/<ticket-id>-description\`
- Bug fix branches: \`fix/<short-description>\` or \`bugfix/<ticket-id>-description\`
- Hotfix branches: \`hotfix/<short-description>\`
- Release branches: \`release/<version>\`
- Chore branches: \`chore/<short-description>\`

### Git Workflow Patterns

**Trunk-Based Development** (recommended for CI/CD):
- Commit directly to \`main\` or via short-lived feature branches (< 2 days)
- Use feature flags for incomplete features
- Integrate frequently to avoid merge conflicts

**GitHub Flow** (simple, web-centric):
1. Branch from \`main\`
2. Add commits
3. Open Pull Request
4. Review and discuss
5. Merge and deploy

**Gitflow** (release-driven):
- \`main\`: production releases only (tagged)
- \`develop\`: integration branch
- \`feature/*\`: new features, branch from develop
- \`release/*\`: release preparation, branch from develop
- \`hotfix/*\`: urgent production fixes, branch from main

### Pull Request Best Practices
1. **Small PRs**: Keep PRs under 400 lines changed — easier to review
2. **Single responsibility**: One logical change per PR
3. **Self-review**: Review your own diff before requesting review
4. **Descriptive title**: Use conventional commit format in title
5. **PR description**: Include context, motivation, test plan, screenshots if relevant
6. **Link issues**: Reference related issues with \`Closes #123\` or \`Fixes #456\`
7. **No force-push to shared branches**: Rebase locally before pushing
8. **Clean history**: Squash fixup commits before merge

### PR Description Template
\`\`\`markdown
## Summary
Brief description of what this PR does and why.

## Changes
- Change 1
- Change 2

## Test Plan
- [ ] Unit tests pass
- [ ] Manual testing steps

## Related Issues
Closes #<issue-number>
\`\`\`

### Common Git Commands Context
- \`git log --oneline --graph --decorate\`: Visual branch history
- \`git stash push -m "description"\`: Save work in progress
- \`git rebase -i HEAD~N\`: Interactive rebase to clean up commits
- \`git bisect start\`: Binary search for the commit that introduced a bug
- \`git reflog\`: Recover lost commits

### .gitignore Patterns by Language
**Python**: \`__pycache__/\`, \`*.pyc\`, \`.venv/\`, \`venv/\`, \`*.egg-info/\`, \`.pytest_cache/\`, \`.mypy_cache/\`
**JavaScript/Node**: \`node_modules/\`, \`dist/\`, \`.env\`, \`coverage/\`, \`.next/\`, \`*.tsbuildinfo\`
**Java**: \`target/\`, \`*.class\`, \`*.jar\`, \`.gradle/\`, \`build/\`
**Go**: \`vendor/\`, \`*.exe\`, \`*.test\`, \`*.out\`
**Terraform**: \`.terraform/\`, \`*.tfstate\`, \`*.tfstate.backup\`, \`*.tfvars\`
**General**: \`.DS_Store\`, \`Thumbs.db\`, \`.env\`, \`.env.local\`, \`*.log\`
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(git-commit) Git Blame',
      command:     'aiForge.git.blame',
      linePattern: /^\s*(?:def |async def |function |const |class |public |private |protected |export |static )/,
      languages:   [],
      tooltip:     'Show git blame for this function',
    },
  ];

  // ── codeActions ───────────────────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:    'Generate commit message for staged changes',
      command:  'aiForge.git.commitMessage',
      kind:     'refactor',
      languages: [],
    },
    {
      title:    'Generate PR description',
      command:  'aiForge.git.prTemplate',
      kind:     'refactor',
      languages: [],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Generate changelog from recent commits',
      description: 'Reads the git log and generates a CHANGELOG section for recent commits',
      extensions:  ['.md', '.txt', '.rst'],

      async apply(
        content:  string,
        filePath: string,
        _language: string,
        services:  IServices
      ): Promise<string> {
        const ws      = vscode.workspace.workspaceFolders?.[0];
        const wsPath  = ws?.uri.fsPath ?? path.dirname(filePath);

        let gitLog = '';
        try {
          gitLog = execSync('git log --oneline -20', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        if (!gitLog) {
          return content;
        }

        const req: AIRequest = {
          messages: [{
            role:    'user',
            content: `Generate a CHANGELOG section from the following recent git commits.
Format as Markdown with a date header and grouped by type (Features, Bug Fixes, Chores).
Include only meaningful commits (exclude merge commits and trivial chores).

Git log:
${gitLog}

Return ONLY the CHANGELOG section Markdown, no explanation.`,
          }],
          system:      'You are a developer writing a CHANGELOG. Return only the Markdown section.',
          instruction: 'Generate changelog from recent commits',
          mode:        'edit',
        };

        const changelogSection = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
        return `${changelogSection}\n\n${content}`.trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'PR description template',
      description: 'Generate a pull request description based on recent commits and changed files',
      prompt(workspacePath: string): string {
        let log = '';
        let diff = '';
        try {
          log  = execSync('git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline -10', {
            cwd: workspacePath, timeout: 3000, encoding: 'utf8',
          }).trim();
          diff = execSync('git diff --stat HEAD~5..HEAD', {
            cwd: workspacePath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        return `Generate a detailed PR description for a pull request with the following context.

Recent commits:
${log || '(no commits found)'}

Files changed:
${diff || '(no diff available)'}

Format the PR description as Markdown with these sections:
## Summary
## Changes
## Test Plan
## Related Issues

Be concise but informative.`;
      },
    },

    {
      label:       'Conventional commit message',
      description: 'Generate a conventional commit message for staged changes',
      prompt(workspacePath: string): string {
        let diff = '';
        try {
          diff = execSync('git diff --cached', {
            cwd: workspacePath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        return `Generate a conventional commit message for the following staged git diff.

Rules:
- Use format: \`<type>(<optional scope>): <description>\`
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Keep the subject line under 72 characters
- Use imperative mood: "add feature" not "added feature"
- If breaking change, append "!" after type/scope
- Optionally add a body explaining WHY (not WHAT)

Staged diff:
${diff || '(no staged changes)'}

Return ONLY the commit message, no explanation.`;
      },
    },

    {
      label:       '.gitignore for [language]',
      description: 'Generate a .gitignore file tailored to a specific language or framework',
      prompt(_workspacePath: string): string {
        return `Generate a comprehensive .gitignore file.

Please ask me which language or framework this .gitignore should target, or if you know from context, generate it now.

Include:
- Build artifacts and compiled output
- Dependency directories (node_modules, vendor, venv, etc.)
- IDE and editor files (.vscode/settings.json, .idea/, etc.)
- OS-generated files (.DS_Store, Thumbs.db)
- Environment and secrets files (.env, *.pem, *.key)
- Log and cache files
- Test coverage output

Return ONLY the .gitignore content, no explanation.`;
      },
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.git.blame',
      title: 'Evolve AI: Git Blame Function',

      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active file for git blame.');
          return;
        }

        const filePath  = editor.document.uri.fsPath;
        const wsPath    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(filePath);
        const line      = editor.selection.active.line + 1;  // git blame is 1-indexed

        let blameOutput = '';
        try {
          blameOutput = execSync(
            `git blame -L ${line},${line} --porcelain "${filePath}"`,
            { cwd: wsPath, timeout: 3000, encoding: 'utf8' }
          ).trim();
        } catch { /* ignore */ }

        if (!blameOutput) {
          vscode.window.showInformationMessage('Unable to get git blame for this line.');
          return;
        }

        // Parse commit hash, author and summary from --porcelain output
        const commitHash = blameOutput.slice(0, 40);
        const authorLine = blameOutput.split('\n').find(l => l.startsWith('author '));
        const summaryLine = blameOutput.split('\n').find(l => l.startsWith('summary '));
        const author  = authorLine  ? authorLine.slice(7).trim()  : 'unknown';
        const summary = summaryLine ? summaryLine.slice(8).trim() : 'unknown';

        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain the following git blame information for line ${line} of \`${path.basename(filePath)}\`:

Commit: ${commitHash.slice(0, 8)}
Author: ${author}
Message: ${summary}

What does this commit do, and why might this line have been changed? Be concise.`,
          'explain'
        );
      },
    },

    {
      id:    'aiForge.git.changelog',
      title: 'Evolve AI: Generate Changelog',

      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showWarningMessage('No workspace folder open.');
          return;
        }

        const wsPath = ws.uri.fsPath;
        let gitLog   = '';

        try {
          gitLog = execSync('git log --oneline -20', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        if (!gitLog) {
          vscode.window.showWarningMessage('No git log found. Make sure this is a git repository with commits.');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Git: Generating changelog…', cancellable: false },
          async () => {
            const req: AIRequest = {
              messages: [{
                role:    'user',
                content: `Generate a CHANGELOG section from the following recent git commits.
Format as Markdown with a date header for today and grouped by type (Features, Bug Fixes, Chores, Other).
Use emojis if appropriate (✨ for features, 🐛 for fixes, 🔧 for chores).
Include only meaningful commits; exclude merge commits.

Git log:
${gitLog}

Return ONLY the CHANGELOG Markdown, no explanation.`,
              }],
              system:      'You are a developer writing a CHANGELOG. Return only the Markdown content.',
              instruction: 'Generate changelog from git log',
              mode:        'generate',
            };

            const changelog = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            await services.workspace.applyToActiveFile(changelog);
            vscode.window.showInformationMessage('Changelog generated and applied to active file.');
          }
        );
      },
    },

    {
      id:    'aiForge.git.commitMessage',
      title: 'Evolve AI: Smart Commit Message',

      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showWarningMessage('No workspace folder open.');
          return;
        }

        const wsPath = ws.uri.fsPath;
        let stagedDiff = '';

        try {
          stagedDiff = execSync('git diff --cached', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        if (!stagedDiff) {
          vscode.window.showWarningMessage(
            'No staged changes found. Stage your changes with `git add` first.'
          );
          return;
        }

        // Truncate diff to avoid exceeding context budget
        const maxDiffChars = 8000;
        const truncated    = stagedDiff.length > maxDiffChars
          ? stagedDiff.slice(0, maxDiffChars) + '\n... (truncated)'
          : stagedDiff;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Git: Generating commit message…', cancellable: false },
          async () => {
            const req: AIRequest = {
              messages: [{
                role:    'user',
                content: `Generate a conventional commit message for the following staged diff.

Rules:
- Format: \`<type>(<optional scope>): <description>\`
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject line max 72 characters
- Imperative mood: "add feature" not "added feature"
- Append "!" for breaking changes
- Add optional body paragraph explaining WHY if the change is complex

Staged diff:
${truncated}

Return ONLY the commit message text, no explanation, no code fences.`,
              }],
              system:      'You are an expert developer writing git commit messages. Return only the commit message.',
              instruction: 'Generate conventional commit message from staged diff',
              mode:        'generate',
            };

            const message = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            await vscode.env.clipboard.writeText(message);
            vscode.window.showInformationMessage(
              `Commit message copied to clipboard: "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}"`
            );
          }
        );
      },
    },

    {
      id:    'aiForge.git.prTemplate',
      title: 'Evolve AI: Generate PR Template',

      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showWarningMessage('No workspace folder open.');
          return;
        }

        const wsPath = ws.uri.fsPath;
        let log  = '';
        let diff = '';

        try {
          log = execSync(
            'git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline -10',
            { cwd: wsPath, timeout: 3000, encoding: 'utf8' }
          ).trim();
        } catch { /* ignore */ }

        try {
          diff = execSync('git diff --stat HEAD~5..HEAD', {
            cwd: wsPath, timeout: 3000, encoding: 'utf8',
          }).trim();
        } catch { /* ignore */ }

        if (!log && !diff) {
          vscode.window.showWarningMessage('No git history found to generate a PR description from.');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Git: Generating PR description…', cancellable: false },
          async () => {
            const req: AIRequest = {
              messages: [{
                role:    'user',
                content: `Generate a detailed GitHub Pull Request description based on the following context.

Commits:
${log || '(no commits)'}

Files changed:
${diff || '(no diff)'}

Format as Markdown with these sections:
## Summary
## Changes Made
## Test Plan
## Screenshots (if applicable)
## Related Issues

Be concise but informative. Write in the present tense.
Return ONLY the Markdown PR description, no explanation, no code fences.`,
              }],
              system:      'You are a developer writing a GitHub pull request description. Return only the Markdown.',
              instruction: 'Generate PR description from git log',
              mode:        'generate',
            };

            const prDescription = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            await services.workspace.applyToActiveFile(prDescription);
            vscode.window.showInformationMessage('PR description generated and applied to active file.');
          }
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { return '$(git-branch) unknown'; }

      const wsPath = ws.uri.fsPath;
      const branch = getBranch(wsPath) || 'unknown';
      const dirty  = isDirty(wsPath);

      return `$(git-branch) ${branch}${dirty ? '*' : ''}`;
    },
  };
}
