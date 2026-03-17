/**
 * plugins/security.ts — Security Scanner plugin for Evolve AI
 *
 * Always-on plugin (detect() always returns true).
 * Contributes:
 *  - contextHooks      : lightweight regex scan reporting finding count and types
 *  - systemPromptSection: OWASP Top 10, secure coding, secret management, input validation
 *  - codeActions       : 6 security issue categories (secrets, SQL injection, XSS, etc.)
 *  - transforms        : Scan workspace for secrets, Add input validation
 *  - commands          : scanFile, scanWorkspace, fixFinding
 *  - statusItem        : finding count or "Clean"
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type {
  IPlugin,
  PluginContextHook,
  PluginCodeAction,
  PluginTransform,
  PluginStatusItem,
  PluginCommand,
} from '../core/plugin';
import type { IServices } from '../core/services';
import type { AIRequest } from '../core/aiService';

// ── Security finding interface ────────────────────────────────────────────────

export interface SecurityFinding {
  line:      number;
  column:    number;
  endColumn: number;
  severity:  'high' | 'medium' | 'low';
  category:  string;  // 'secret' | 'sql-injection' | 'xss' | 'deserialization' | 'insecure-url' | 'weak-crypto'
  message:   string;
  pattern:   string;
}

// ── Security pattern definitions ──────────────────────────────────────────────

interface SecurityPattern {
  pattern:  RegExp;
  category: SecurityFinding['category'];
  severity: SecurityFinding['severity'];
  message:  string;
  exclude?: RegExp;  // If the line also matches this, skip it (negative filter)
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  // ── Hardcoded secrets ──────────────────────────────────────────────────────
  {
    pattern:  /\b(?:password|passwd|pwd)\s*=\s*["'][^"']{3,}["']/i,
    category: 'secret',
    severity: 'high',
    message:  'Hardcoded password detected. Use environment variables or a secrets manager.',
    exclude:  /(?:os\.environ|os\.getenv|getenv|environ\[|secrets\.|vault|bcrypt|hash|_hash|hash_)/i,
  },
  {
    pattern:  /\b(?:api_key|apikey|api_secret|secret_key|auth_token|access_token)\s*=\s*["'][^"']{6,}["']/i,
    category: 'secret',
    severity: 'high',
    message:  'Hardcoded API key or secret detected. Use environment variables or a secrets manager.',
    exclude:  /(?:os\.environ|os\.getenv|getenv|environ\[|secrets\.|vault)/i,
  },
  {
    pattern:  /\bAWS_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID|SESSION_TOKEN)\s*=\s*["'][^"']{8,}["']/,
    category: 'secret',
    severity: 'high',
    message:  'Hardcoded AWS credential detected. Use IAM roles or environment variables.',
    exclude:  /(?:os\.environ|os\.getenv|getenv|environ\[)/i,
  },
  {
    pattern:  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
    category: 'secret',
    severity: 'high',
    message:  'Private key material found in source code. Store keys in a secrets manager.',
  },

  // ── SQL injection ──────────────────────────────────────────────────────────
  {
    pattern:  /(?:execute|query|cursor\.execute)\s*\(\s*["'][^"']*["']\s*\+/i,
    category: 'sql-injection',
    severity: 'high',
    message:  'Potential SQL injection: string concatenation in SQL query. Use parameterized queries.',
    exclude:  /(?:%s|%d|\?|\$\d|:param)/,
  },
  {
    pattern:  /f["']SELECT\s+.*\{/i,
    category: 'sql-injection',
    severity: 'high',
    message:  'Potential SQL injection: f-string used in SQL query. Use parameterized queries.',
  },
  {
    pattern:  /f["'](?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\{/i,
    category: 'sql-injection',
    severity: 'high',
    message:  'Potential SQL injection: f-string used in SQL mutation. Use parameterized queries.',
  },
  {
    pattern:  /["']\s*\+\s*(?:req(?:uest)?\.(?:body|params|query|param)|user(?:Input|_input|name)|userId|user_id)/,
    category: 'sql-injection',
    severity: 'high',
    message:  'Potential SQL injection: user input concatenated into query string. Use parameterized queries.',
  },

  // ── XSS ───────────────────────────────────────────────────────────────────
  {
    pattern:  /\.innerHTML\s*=/,
    category: 'xss',
    severity: 'high',
    message:  'XSS risk: innerHTML assignment. Use textContent or sanitize input with DOMPurify.',
    exclude:  /(?:\/\/|\/\*|\*|#)\s*.*innerHTML/,
  },
  {
    pattern:  /document\.write\s*\(/,
    category: 'xss',
    severity: 'high',
    message:  'XSS risk: document.write() injects raw HTML. Use safe DOM APIs instead.',
  },
  {
    pattern:  /dangerouslySetInnerHTML\s*=/,
    category: 'xss',
    severity: 'medium',
    message:  'XSS risk: dangerouslySetInnerHTML. Ensure value is sanitized before use.',
  },

  // ── Insecure deserialization ───────────────────────────────────────────────
  {
    pattern:  /pickle\.loads?\s*\(/,
    category: 'deserialization',
    severity: 'high',
    message:  'Insecure deserialization: pickle.load() can execute arbitrary code. Use JSON or a safe format.',
  },
  {
    pattern:  /yaml\.load\s*\(/,
    category: 'deserialization',
    severity: 'high',
    message:  'Insecure deserialization: yaml.load() without SafeLoader. Use yaml.safe_load() instead.',
    exclude:  /yaml\.safe_load|Loader\s*=\s*yaml\.SafeLoader/,
  },
  {
    pattern:  /\beval\s*\(/,
    category: 'deserialization',
    severity: 'high',
    message:  'Dangerous eval() call. Avoid executing dynamic code from untrusted input.',
    exclude:  /(?:\/\/|#|\/\*|\*)\s*.*\beval\b/,
  },
  {
    pattern:  /\bexec\s*\(\s*(?!["'](?:git|ls|dir|cd|make|npm|pip|python|bash|sh)\b)/,
    category: 'deserialization',
    severity: 'medium',
    message:  'Potentially unsafe exec() call. Validate input before executing dynamic code.',
    exclude:  /(?:\/\/|#|\/\*|\*)\s*.*\bexec\b/,
  },

  // ── Insecure URLs / IPs ────────────────────────────────────────────────────
  {
    pattern:  /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/,
    category: 'insecure-url',
    severity: 'medium',
    message:  'Insecure HTTP URL detected. Use HTTPS to encrypt data in transit.',
    exclude:  /(?:example\.com|test|localhost|placeholder|todo|fixme|schema|namespace|xmlns|dtd|w3\.org|ietf\.org)/i,
  },
  {
    pattern:  /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    category: 'insecure-url',
    severity: 'low',
    message:  'Hardcoded private IP address detected. Use configuration or service discovery instead.',
    exclude:  /(?:\/\/|#|\*|example|test|sample|placeholder)/i,
  },

  // ── Weak cryptography ──────────────────────────────────────────────────────
  {
    pattern:  /hashlib\.md5\s*\(/,
    category: 'weak-crypto',
    severity: 'high',
    message:  'MD5 is cryptographically broken. Use SHA-256 or SHA-3 for security-sensitive hashing.',
  },
  {
    pattern:  /hashlib\.sha1\s*\(/,
    category: 'weak-crypto',
    severity: 'medium',
    message:  'SHA-1 is deprecated for security use. Use SHA-256 or SHA-3 instead.',
    exclude:  /(?:git|content.address|deduplicate|checksum(?!.*password))/i,
  },
  {
    pattern:  /Math\.random\s*\(\s*\)/,
    category: 'weak-crypto',
    severity: 'medium',
    message:  'Math.random() is not cryptographically secure. Use crypto.getRandomValues() or crypto.randomBytes().',
    exclude:  /(?:\/\/|#|test|mock|sample|color|position|index|offset)/i,
  },
  {
    pattern:  /\b(?:DES|RC4|Blowfish)\b/,
    category: 'weak-crypto',
    severity: 'high',
    message:  'Weak or deprecated cipher detected. Use AES-256-GCM or ChaCha20-Poly1305.',
    exclude:  /(?:\/\/|#|\*|comment|doc|test)/i,
  },
];

// ── Core scan function (exported for tests) ───────────────────────────────────

export function scanContent(content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Skip full-line comments
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      continue;
    }

    for (const sp of SECURITY_PATTERNS) {
      sp.pattern.lastIndex = 0;
      const match = sp.pattern.exec(line);
      if (!match) { continue; }

      // Apply exclusion filter
      if (sp.exclude) {
        sp.exclude.lastIndex = 0;
        if (sp.exclude.test(line)) { continue; }
      }

      findings.push({
        line:      lineIdx,
        column:    match.index,
        endColumn: match.index + match[0].length,
        severity:  sp.severity,
        category:  sp.category,
        message:   sp.message,
        pattern:   match[0].slice(0, 80),
      });
    }
  }

  return findings;
}

// ── Severity → diagnostic severity mapping ────────────────────────────────────

function toDiagnosticSeverity(s: SecurityFinding['severity']): vscode.DiagnosticSeverity {
  switch (s) {
    case 'high':   return vscode.DiagnosticSeverity.Error;
    case 'medium': return vscode.DiagnosticSeverity.Warning;
    case 'low':    return vscode.DiagnosticSeverity.Information;
  }
}

// ── Helper: format findings list for AI prompt ────────────────────────────────

function formatFindingsForPrompt(findings: SecurityFinding[]): string {
  return findings
    .map(f => `  Line ${f.line + 1} [${f.severity.toUpperCase()}] ${f.category}: ${f.message}`)
    .join('\n');
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class SecurityPlugin implements IPlugin {
  readonly id          = 'security';
  readonly displayName = 'Security Scanner';
  readonly icon        = '$(shield)';

  private _diagnostics: vscode.DiagnosticCollection | null = null;
  private _findingCount = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(_ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    return true;  // Always-on
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(_services: IServices, vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const disposables: vscode.Disposable[] = [];

    // Create diagnostic collection
    this._diagnostics = vscode.languages.createDiagnosticCollection('aiForge.security');
    disposables.push(this._diagnostics);
    vsCtx.subscriptions.push(this._diagnostics);

    // Scan on open
    const onOpen = vscode.workspace.onDidOpenTextDocument(doc => {
      this._scanDocument(doc);
    });
    disposables.push(onOpen);
    vsCtx.subscriptions.push(onOpen);

    // Scan on save
    const onSave = vscode.workspace.onDidSaveTextDocument(doc => {
      this._scanDocument(doc);
    });
    disposables.push(onSave);
    vsCtx.subscriptions.push(onSave);

    // Scan currently open documents
    for (const doc of vscode.workspace.textDocuments) {
      this._scanDocument(doc);
    }

    console.log('[Evolve AI] Security plugin activated — always-on');
    return disposables;
  }

  // ── deactivate ────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._diagnostics?.clear();
    this._diagnostics?.dispose();
    this._diagnostics = null;
  }

  // ── Internal scan ─────────────────────────────────────────────────────────

  private _scanDocument(doc: vscode.TextDocument): void {
    if (!this._diagnostics) { return; }

    const findings = scanContent(doc.getText());
    const diagnostics = findings.map(f => {
      const range = new vscode.Range(
        new vscode.Position(f.line, f.column),
        new vscode.Position(f.line, f.endColumn)
      );
      const diag = new vscode.Diagnostic(range, f.message, toDiagnosticSeverity(f.severity));
      diag.source = 'Evolve AI Security';
      diag.code   = f.category;
      return diag;
    });

    this._diagnostics.set(doc.uri, diagnostics);
    this._findingCount = diagnostics.length;
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'security.findings',

      async collect(_ws): Promise<unknown> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return { findingCount: 0, categories: [] }; }

        const findings = scanContent(editor.document.getText());
        const categoryCounts: Record<string, number> = {};
        for (const f of findings) {
          categoryCounts[f.category] = (categoryCounts[f.category] ?? 0) + 1;
        }

        return {
          findingCount: findings.length,
          categories:   Object.entries(categoryCounts).map(([cat, count]) => ({ cat, count })),
          highCount:    findings.filter(f => f.severity === 'high').length,
          mediumCount:  findings.filter(f => f.severity === 'medium').length,
          lowCount:     findings.filter(f => f.severity === 'low').length,
        };
      },

      format(data: unknown): string {
        const d = data as {
          findingCount: number;
          categories:   Array<{ cat: string; count: number }>;
          highCount:    number;
          mediumCount:  number;
          lowCount:     number;
        };

        if (d.findingCount === 0) {
          return '## Security Scan\nNo security issues found in the active file.';
        }

        const lines = [
          `## Security Scan`,
          `Found ${d.findingCount} potential issue(s): ${d.highCount} high, ${d.mediumCount} medium, ${d.lowCount} low.`,
          `Categories: ${d.categories.map(c => `${c.cat} (${c.count})`).join(', ')}.`,
          `Address high-severity issues before committing. Use environment variables for secrets, parameterized queries for SQL, and textContent instead of innerHTML.`,
        ];
        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Security-Aware Coding (Always-On)

You are security-aware. Apply the following principles in every code suggestion:

### OWASP Top 10 Awareness
- **Injection (A03)**: Always use parameterized queries or prepared statements. Never concatenate user input into SQL, LDAP, XPath, or shell commands.
- **Broken Auth (A07)**: Use bcrypt/argon2/scrypt for password hashing. Never use MD5 or SHA-1 for passwords. Use secure session tokens (crypto.randomBytes / secrets.token_urlsafe).
- **Sensitive Data (A02)**: Never hardcode secrets, API keys, passwords, or certificates in source code. Always use environment variables or a secrets manager (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault).
- **XSS (A03)**: Use textContent instead of innerHTML. Sanitize HTML with DOMPurify if innerHTML is unavoidable. Never use document.write().
- **Insecure Deserialization (A08)**: Avoid pickle.loads() on untrusted data. Use yaml.safe_load() not yaml.load(). Avoid eval() and exec() on user input.
- **Vulnerable Components (A06)**: Flag use of deprecated ciphers: DES, RC4, MD5, SHA-1. Recommend AES-256-GCM or ChaCha20-Poly1305.

### Secure Coding Patterns
- **Secrets**: Read credentials from environment variables: \`os.environ["DB_PASSWORD"]\`, \`process.env.API_KEY\`. Never hardcode literals.
- **SQL**: Use \`cursor.execute("SELECT ... WHERE id = %s", (user_id,))\` or ORM parameterization. Never f-strings in SQL.
- **Crypto**: For passwords use bcrypt/argon2/scrypt. For random tokens use \`secrets.token_urlsafe()\` (Python) or \`crypto.randomBytes()\` (Node). For data integrity use SHA-256+.
- **HTTP**: Always use HTTPS in production. Flag plain HTTP URLs (except localhost).
- **Input Validation**: Validate and sanitize all user input at the boundary. Use allow-lists not deny-lists. Apply schema validation (Pydantic, Joi, Zod).

### Secret Management Best Practices
1. Use a secrets manager, never config files checked into git.
2. Rotate secrets regularly; avoid long-lived credentials.
3. Apply least-privilege: each service gets only the permissions it needs.
4. Use short-lived tokens (OIDC, STS AssumeRole) where possible.
5. Audit secret access with CloudTrail / Vault audit logs.

### Input Validation Principles
- Validate at the entry point; assume everything from outside is hostile.
- Use strong typing and schema validation.
- Reject early, fail closed: return 400 on invalid input, not 500.
- Sanitize for output context (HTML, SQL, shell, JSON) separately.
- Log validation failures for anomaly detection, but never log raw user input.
`.trim();
  }

  // ── codeActions ───────────────────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:    'Fix: Use environment variable instead of hardcoded secret',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /secret|password|api.key/i,
      languages: [],
    },
    {
      title:    'Fix: Use parameterized query (SQL injection risk)',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /sql.injection/i,
      languages: [],
    },
    {
      title:    'Fix: Use textContent instead of innerHTML (XSS risk)',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /xss/i,
      languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    },
    {
      title:    'Fix: Replace unsafe deserialization',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /deserialization/i,
      languages: [],
    },
    {
      title:    'Fix: Replace insecure HTTP URL',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /insecure.url/i,
      languages: [],
    },
    {
      title:    'Fix: Replace weak cryptography',
      command:  'aiForge.security.fixFinding',
      kind:     'quickfix',
      diagnosticPattern: /weak.crypto/i,
      languages: [],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Scan workspace for hardcoded secrets',
      description: 'Analyse every source file and report potential hardcoded credentials',
      extensions:  ['.py', '.js', '.ts', '.go', '.java', '.rb', '.php', '.cs', '.env', '.yaml', '.yml', '.json'],
      async apply(content: string, filePath: string, _language: string, services: IServices): Promise<string> {
        const findings = scanContent(content);
        const secretFindings = findings.filter(f => f.category === 'secret');
        if (secretFindings.length === 0) { return content; }

        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `The following file has ${secretFindings.length} potential hardcoded secret(s):
${formatFindingsForPrompt(secretFindings)}

Replace each hardcoded secret with an environment variable read using os.environ or process.env.
Return ONLY the corrected file content with no explanation.

File: ${filePath}
\`\`\`
${content}
\`\`\``,
          }],
          system:      'You are a security expert. Return only the complete corrected file content.',
          instruction: 'Replace hardcoded secrets with environment variables',
          mode:        'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add input validation to all request handlers',
      description: 'Inject schema-based input validation at every route / handler entry point',
      extensions:  ['.py', '.js', '.ts'],
      async apply(content: string, filePath: string, _language: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add robust input validation to every request handler / route function in the following file.
Rules:
- Use Pydantic (Python), Zod (TypeScript), or Joi (JavaScript) as appropriate for the language
- Validate all user-supplied fields at the entry point
- Return HTTP 400 on invalid input with a descriptive error message
- Preserve all existing logic
- Return ONLY the updated file content with no explanation.

File: ${filePath}
\`\`\`
${content}
\`\`\``,
          }],
          system:      'You are a security expert. Return only the complete updated file content.',
          instruction: 'Add input validation to request handlers',
          mode:        'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.security.scanFile',
      title: 'Evolve AI: Security Scan Current File',
      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active file to scan.');
          return;
        }

        const content  = editor.document.getText();
        const findings = scanContent(content);

        if (findings.length === 0) {
          vscode.window.showInformationMessage('$(shield) Security Scan: No issues found — file is clean!');
          return;
        }

        const high   = findings.filter(f => f.severity === 'high').length;
        const medium = findings.filter(f => f.severity === 'medium').length;
        const low    = findings.filter(f => f.severity === 'low').length;

        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Security scan found ${findings.length} issue(s) in \`${editor.document.fileName}\`: ${high} high, ${medium} medium, ${low} low.

Issues:
${formatFindingsForPrompt(findings)}

For each issue, explain the risk and show a secure alternative. Be concise.`,
          'explain'
        );
      },
    },
    {
      id:    'aiForge.security.scanWorkspace',
      title: 'Evolve AI: Security Scan Workspace',
      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showWarningMessage('No workspace folder open.');
          return;
        }

        const wsPath = ws.uri.fsPath;
        const allFindings: Array<{ file: string; findings: SecurityFinding[] }> = [];

        const sourceExts = /\.(py|js|ts|jsx|tsx|go|java|rb|php|cs|env|ya?ml|json)$/i;
        const skip = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv']);

        function walk(dir: string): void {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (skip.has(entry.name)) { continue; }
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(full);
              } else if (sourceExts.test(entry.name)) {
                try {
                  const fileContent = fs.readFileSync(full, 'utf8');
                  const fileFindings = scanContent(fileContent);
                  if (fileFindings.length > 0) {
                    allFindings.push({ file: path.relative(wsPath, full), findings: fileFindings });
                  }
                } catch { /* skip unreadable files */ }
              }
            }
          } catch { /* skip unreadable dirs */ }
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Security Scan', cancellable: false },
          async progress => {
            progress.report({ message: 'Scanning workspace…' });
            walk(wsPath);
            progress.report({ message: 'Done.' });
          }
        );

        const totalFindings = allFindings.reduce((n, f) => n + f.findings.length, 0);
        if (totalFindings === 0) {
          vscode.window.showInformationMessage('$(shield) Workspace Security Scan: No issues found!');
          return;
        }

        const summary = [
          `Workspace security scan found ${totalFindings} issue(s) across ${allFindings.length} file(s):`,
          '',
          ...allFindings.map(({ file, findings }) =>
            `${file}: ${findings.length} issue(s) — ${[...new Set(findings.map(f => f.category))].join(', ')}`
          ),
        ].join('\n');

        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `${summary}

Provide a prioritised remediation plan. Focus on high-severity issues first. One line per file.`,
          'explain'
        );
      },
    },
    {
      id:    'aiForge.security.fixFinding',
      title: 'Evolve AI: Fix Security Issue',
      async handler(services: IServices, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active file to fix.');
          return;
        }

        const content  = editor.document.getText();
        const findings = scanContent(content);
        const highFindings = findings.filter(f => f.severity === 'high');

        if (findings.length === 0) {
          vscode.window.showInformationMessage('No security issues to fix in the current file.');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Security: Fixing issues…', cancellable: false },
          async () => {
            const targetFindings = highFindings.length > 0 ? highFindings : findings;
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Fix the following security issues in the file:
${formatFindingsForPrompt(targetFindings)}

Apply secure alternatives:
- Replace hardcoded secrets with os.environ / process.env reads
- Replace string-concatenated SQL with parameterized queries
- Replace innerHTML with textContent
- Replace yaml.load() with yaml.safe_load()
- Replace pickle.loads() with JSON parsing
Return ONLY the corrected file content with no explanation.

\`\`\`
${content}
\`\`\``,
              }],
              system:      'You are a security expert. Return only the complete corrected file content.',
              instruction: 'Fix security issues',
              mode:        'edit',
            };
            const fixed = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            await services.workspace.applyToActiveFile(fixed);
          }
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return '$(shield) Clean'; }

      const findings = scanContent(editor.document.getText());
      if (findings.length === 0) { return '$(shield) Clean'; }

      const high = findings.filter(f => f.severity === 'high').length;
      if (high > 0) {
        return `$(shield) ${findings.length} security issue(s) (${high} HIGH)`;
      }
      return `$(shield) ${findings.length} security issue(s)`;
    },
  };
}
