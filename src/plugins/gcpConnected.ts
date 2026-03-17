/**
 * plugins/gcpConnected.ts — Google Cloud Platform Connected plugin for Evolve AI
 *
 * Activates alongside the base GCP plugin when the workspace contains GCP
 * project markers AND API credentials are configured (service account JSON
 * stored in SecretStorage).
 *
 * Contributes:
 *  - contextHooks      : live Cloud Functions status, Cloud Run services, BigQuery job failures
 *  - systemPromptSection: connected-workspace knowledge + current project info
 *  - commands (18)     : connect, disconnect, projectStatus, Cloud Functions (5),
 *                         Cloud Run (2), BigQuery (3), GCS (2), Pub/Sub (2),
 *                         Firestore (1)
 *  - statusItem        : shows connection status + project ID
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
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
import {
  GcpClient,
  GcpApiError,
  type GCPFunction,
  type GCPFunctionDetail,
  type CloudRunService,
  type CloudRunServiceDetail,
  type BQDataset,
  type BQTable,
  type BQTableDetail,
  type BQQueryResult,
  type BQJob,
  type GCSBucket,
  type GCSObject,
  type PubSubTopic,
  type PubSubSubscription,
  type FirestoreDoc,
  type LogEntry,
} from '../core/gcpClient';

// ── Detection markers (same as base GCP plugin) ─────────────────────────────

const GCP_MARKER_FILES = [
  'app.yaml',
  'app.yml',
  '.gcloudignore',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  'firebase.json',
  'firestore.rules',
  'firestore.indexes.json',
  '.firebaserc',
];

const GCP_IMPORT_PATTERN = /from google\.cloud|require\(['"]@google-cloud\/|google-cloud-|functions_framework/;

function findMarker(wsPath: string): string | null {
  for (const marker of GCP_MARKER_FILES) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

function hasGcpInDependencies(wsPath: string): boolean {
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (/google-cloud|functions-framework|firebase-admin/i.test(content)) return true;
      } catch { /* skip */ }
    }
  }
  const pkgPath = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, 'utf8');
      if (/@google-cloud\/|firebase-admin|firebase-functions/i.test(content)) return true;
    } catch { /* skip */ }
  }
  return false;
}

function scanForGcpImports(wsPath: string, max: number): boolean {
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.next']);
  let count = 0;
  const walk = (d: string): boolean => {
    if (count >= max) return false;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (walk(full)) return true;
        } else if (/\.(py|ts|js)$/.test(entry.name)) {
          count++;
          const sample = fs.readFileSync(full, 'utf8').slice(0, 2000);
          if (GCP_IMPORT_PATTERN.test(sample)) return true;
        }
        if (count >= max) return false;
      }
    } catch { /* skip unreadable dirs */ }
    return false;
  };
  return walk(wsPath);
}

// ── Cached context data shape ────────────────────────────────────────────────

interface ConnectedContextData {
  projectId: string;
  projectName: string;
  functionsCount: number;
  functionErrors: Array<{ name: string; error: string; timestamp: string }>;
  cloudRunServices: Array<{ name: string; status: string; url: string }>;
  bqFailedJobs: Array<{ jobId: string; error: string; query: string }>;
}

// ── The plugin ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds

export class GCPConnectedPlugin implements IPlugin {
  readonly id          = 'gcp-connected';
  readonly displayName = 'Google Cloud Connected';
  readonly icon        = '$(cloud-upload)';

  private _client: GcpClient | null = null;
  private _connected = false;
  private _projectId   = '';
  private _projectName = '';
  private _wsPath      = '';

  // Cache for context data
  private _cachedContext: ConnectedContextData | null = null;
  private _cacheTimestamp = 0;

  // ── detect ──────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Must be a GCP workspace (same markers as base plugin)
    const hasMarker = !!findMarker(wsPath) || hasGcpInDependencies(wsPath);
    if (!hasMarker) {
      // Quick scan for GCP imports in source files
      if (!scanForGcpImports(wsPath, 30)) return false;
    }

    return true;
  }

  // ── activate ────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Try to initialise client from stored secrets
    try {
      this._client = await GcpClient.fromSecrets(services.ai);
      if (this._client) {
        const result = await this._client.testConnection();
        if (result.ok) {
          this._connected = true;
          // Extract project info from the test connection message
          const proj = await this._client.getProject();
          this._projectId = proj.projectId;
          this._projectName = proj.name;
          console.log(`[Evolve AI] GCP Connected: project ${this._projectId} (${this._projectName})`);
        } else {
          console.warn(`[Evolve AI] GCP Connected: stored credentials invalid — ${result.message}`);
          this._client = null;
          this._connected = false;
          vscode.window.showWarningMessage(
            'GCP Connected: stored credentials are invalid or expired. Use "GCP: Connect" to reconfigure.',
            'Connect Now',
          ).then(choice => {
            if (choice === 'Connect Now') {
              vscode.commands.executeCommand('aiForge.gcp.connect');
            }
          });
        }
      }
    } catch (e) {
      console.warn(`[Evolve AI] GCP Connected: credential init failed — ${e}`);
      this._client = null;
      this._connected = false;
    }

    if (!this._connected) {
      vscode.window.showInformationMessage(
        'GCP Connected plugin detected a Google Cloud project. Configure service account credentials to enable live features.',
        'Connect Now',
      ).then(choice => {
        if (choice === 'Connect Now') {
          vscode.commands.executeCommand('aiForge.gcp.connect');
        }
      });
    }

    return [];
  }

  // ── deactivate ──────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._client = null;
    this._connected = false;
    this._cachedContext = null;
    this._cacheTimestamp = 0;
  }

  // ── Context cache helper ────────────────────────────────────────────────

  private async _fetchContextData(): Promise<ConnectedContextData | null> {
    if (!this._client || !this._connected) return null;

    const now = Date.now();
    if (this._cachedContext && (now - this._cacheTimestamp) < CACHE_TTL_MS) {
      return this._cachedContext;
    }

    try {
      // Fetch Cloud Functions status
      let functionsCount = 0;
      const functionErrors: ConnectedContextData['functionErrors'] = [];
      try {
        const functions = await this._client.listFunctions();
        functionsCount = functions.length;

        // Check for recent errors in first few functions
        for (const fn of functions.slice(0, 5)) {
          if (fn.state !== 'ACTIVE') {
            functionErrors.push({
              name: fn.name.split('/').pop() ?? fn.name,
              error: `Function state: ${fn.state}`,
              timestamp: fn.updateTime,
            });
          }
        }

        // Fetch logs for error entries
        try {
          const errorLogs = await this._client.listLogEntries(
            'resource.type="cloud_function" AND severity>=ERROR',
            10,
          );
          for (const log of errorLogs.slice(0, 3)) {
            const fnName = log.resource?.labels?.['function_name'] ?? 'unknown';
            functionErrors.push({
              name: fnName,
              error: log.textPayload ?? JSON.stringify(log.jsonPayload ?? {}).slice(0, 200),
              timestamp: log.timestamp,
            });
          }
        } catch { /* logging may not be available */ }
      } catch { /* Cloud Functions API may not be enabled */ }

      // Fetch Cloud Run services
      const cloudRunServices: ConnectedContextData['cloudRunServices'] = [];
      try {
        const services = await this._client.listServices();
        for (const svc of services.slice(0, 10)) {
          const shortName = svc.name.split('/').pop() ?? svc.name;
          const readyCondition = svc.conditions?.find(c => c.type === 'Ready');
          const status = readyCondition?.state === 'CONDITION_SUCCEEDED' ? 'Ready' : (readyCondition?.state ?? 'Unknown');
          cloudRunServices.push({
            name: shortName,
            status,
            url: svc.uri ?? '',
          });
        }
      } catch { /* Cloud Run API may not be enabled */ }

      // Fetch recent BigQuery job failures
      const bqFailedJobs: ConnectedContextData['bqFailedJobs'] = [];
      try {
        const jobs = await this._client.listJobs(20);
        const failed = jobs.filter(j => j.status.errorResult);
        for (const job of failed.slice(0, 3)) {
          bqFailedJobs.push({
            jobId: job.jobReference.jobId,
            error: job.status.errorResult?.message ?? 'Unknown error',
            query: job.configuration.query?.query?.slice(0, 200) ?? '',
          });
        }
      } catch { /* BigQuery API may not be enabled */ }

      this._cachedContext = {
        projectId: this._projectId,
        projectName: this._projectName,
        functionsCount,
        functionErrors,
        cloudRunServices,
        bqFailedJobs,
      };
      this._cacheTimestamp = now;
      return this._cachedContext;
    } catch (e) {
      console.warn(`[Evolve AI] GCP Connected context fetch failed: ${e}`);
      return this._cachedContext; // return stale cache if available
    }
  }

  // ── contextHooks ────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'gcp-live',

      collect: async (_ws): Promise<ConnectedContextData | null> => {
        return this._fetchContextData();
      },

      format(data: unknown): string {
        const d = data as ConnectedContextData | null;
        if (!d) return '';

        const lines = [`## GCP Live Project: ${d.projectName} (${d.projectId})`];

        if (d.functionsCount > 0) {
          lines.push(`\n### Cloud Functions: ${d.functionsCount} deployed`);
          if (d.functionErrors.length > 0) {
            lines.push('**Recent errors:**');
            for (const e of d.functionErrors) {
              lines.push(`- **${e.name}** (${e.timestamp}): ${e.error.slice(0, 150)}`);
            }
          }
        }

        if (d.cloudRunServices.length > 0) {
          lines.push('\n### Cloud Run Services');
          for (const svc of d.cloudRunServices) {
            lines.push(`- **${svc.name}**: ${svc.status}${svc.url ? ` — ${svc.url}` : ''}`);
          }
        }

        if (d.bqFailedJobs.length > 0) {
          lines.push('\n### BigQuery Recent Failures');
          for (const j of d.bqFailedJobs) {
            lines.push(`- **${j.jobId}**: ${j.error.slice(0, 150)}${j.query ? `\n  Query: \`${j.query.slice(0, 100)}…\`` : ''}`);
          }
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ─────────────────────────────────────────────────

  systemPromptSection(): string {
    const base = `
## Google Cloud Connected Project

You have access to a live Google Cloud Platform project. The user can ask you to:
- List and inspect Cloud Functions, view logs, invoke HTTP functions
- Browse Cloud Run services, check revision status and scaling config
- Explore BigQuery datasets and tables, run SQL queries, analyse failed jobs
- Browse Cloud Storage buckets, download objects, upload files
- List Pub/Sub topics and subscriptions, publish messages
- Browse Firestore collections and documents
- Diagnose errors using Cloud Logging data

When the user asks about their GCP environment, use the live data available in context.
When suggesting fixes for errors, be specific — reference the actual error message and configuration.
When exploring BigQuery data, write efficient queries and suggest cost optimisations.
`.trim();

    if (this._connected) {
      return `${base}\n\n**Current project:** ${this._projectName} (${this._projectId})\n**Status:** Connected`;
    }
    return `${base}\n\n_Credentials not yet configured. The user should run "GCP: Connect" to enable live features._`;
  }

  // ── statusItem ─────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      if (this._connected) {
        return `$(cloud-upload) GCP: ${this._projectId}`;
      }
      return '$(cloud) GCP: not connected';
    },
  };

  // ── Helper: ensure connected ────────────────────────────────────────────

  private _requireClient(action: string): GcpClient {
    if (!this._client || !this._connected) {
      vscode.window.showWarningMessage(
        'GCP: Not connected. Run "GCP: Connect" first.',
        'Connect Now',
      ).then(choice => {
        if (choice === 'Connect Now') {
          vscode.commands.executeCommand('aiForge.gcp.connect');
        }
      });
      throw new Error(`GCP not connected — cannot ${action}`);
    }
    return this._client;
  }

  // ── Helper: short name from full GCP resource name ──────────────────────

  private _shortName(fullName: string): string {
    return fullName.split('/').pop() ?? fullName;
  }

  // ── commands (18) ───────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [

    // ───────────────────── 1. Connect ─────────────────────
    {
      id:    'aiForge.gcp.connect',
      title: 'GCP: Connect to Project',
      handler: async (services): Promise<void> => {
        // Pick the service account JSON file
        const fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSON files': ['json'] },
          title: 'Select GCP Service Account Key JSON file',
          openLabel: 'Select Service Account',
        });
        if (!fileUris || fileUris.length === 0) return;

        let serviceAccountJson: string;
        try {
          const raw = await vscode.workspace.fs.readFile(fileUris[0]);
          serviceAccountJson = Buffer.from(raw).toString('utf8');
          // Validate JSON structure
          const parsed = JSON.parse(serviceAccountJson);
          if (!parsed.private_key || !parsed.client_email || !parsed.token_uri) {
            vscode.window.showErrorMessage('GCP: Invalid service account file. Must contain private_key, client_email, and token_uri.');
            return;
          }
        } catch (e) {
          vscode.window.showErrorMessage(`GCP: Failed to read service account file — ${e instanceof Error ? e.message : String(e)}`);
          return;
        }

        const projectId = await vscode.window.showInputBox({
          prompt:      'GCP Project ID',
          placeHolder: 'my-project-123',
          ignoreFocusOut: true,
          validateInput: (v) => {
            if (!v.trim()) return 'Project ID is required';
            if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v.trim())) {
              return 'Project ID must be 6-30 lowercase letters, digits, or hyphens';
            }
            return null;
          },
        });
        if (!projectId) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Testing connection...' },
          async () => {
            try {
              await GcpClient.configureCredentials(services.ai, serviceAccountJson, projectId.trim());

              const client = await GcpClient.fromSecrets(services.ai);
              if (!client) {
                vscode.window.showErrorMessage('GCP: Failed to create client from stored credentials.');
                return;
              }

              const result = await client.testConnection();
              if (!result.ok) {
                vscode.window.showErrorMessage(`GCP: Connection failed — ${result.message}`);
                return;
              }

              const proj = await client.getProject();
              this._client = client;
              this._connected = true;
              this._projectId = proj.projectId;
              this._projectName = proj.name;
              this._cachedContext = null;
              this._cacheTimestamp = 0;

              vscode.window.showInformationMessage(
                `GCP: Connected to project "${proj.name}" (${proj.projectId})`
              );
              services.events.emit('ui.status.update', {});
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`GCP: Connection failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 2. Disconnect ─────────────────────
    {
      id:    'aiForge.gcp.disconnect',
      title: 'GCP: Disconnect',
      handler: async (services): Promise<void> => {
        await GcpClient.configureCredentials(services.ai, '', '');
        this._client = null;
        this._connected = false;
        this._projectId = '';
        this._projectName = '';
        this._cachedContext = null;
        this._cacheTimestamp = 0;
        vscode.window.showInformationMessage('GCP: Disconnected. Credentials cleared.');
        services.events.emit('ui.status.update', {});
      },
    },

    // ───────────────────── 3. Project Status ─────────────────────
    {
      id:    'aiForge.gcp.projectStatus',
      title: 'GCP: Project Status',
      handler: async (services): Promise<void> => {
        if (!this._connected || !this._client) {
          vscode.window.showInformationMessage(
            'GCP: Not connected.',
            'Connect Now',
          ).then(choice => {
            if (choice === 'Connect Now') {
              vscode.commands.executeCommand('aiForge.gcp.connect');
            }
          });
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Fetching project info...' },
          async () => {
            try {
              const client = this._requireClient('get project status');

              // Gather service summaries in parallel
              const [functions, runServices, datasets, buckets, topics] = await Promise.allSettled([
                client.listFunctions(),
                client.listServices(),
                client.listDatasets(),
                client.listBuckets(),
                client.listTopics(),
              ]);

              const fnCount   = functions.status === 'fulfilled' ? functions.value.length : 0;
              const runCount  = runServices.status === 'fulfilled' ? runServices.value.length : 0;
              const dsCount   = datasets.status === 'fulfilled' ? datasets.value.length : 0;
              const bktCount  = buckets.status === 'fulfilled' ? buckets.value.length : 0;
              const topicCount = topics.status === 'fulfilled' ? topics.value.length : 0;

              const msg = [
                `**Project:** ${this._projectName} (\`${this._projectId}\`)`,
                '',
                '### Service Summary',
                `- **Cloud Functions:** ${fnCount} deployed`,
                `- **Cloud Run:** ${runCount} services`,
                `- **BigQuery:** ${dsCount} datasets`,
                `- **Cloud Storage:** ${bktCount} buckets`,
                `- **Pub/Sub:** ${topicCount} topics`,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Summarise this Google Cloud project status and highlight anything noteworthy:\n\n${msg}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`GCP: Project status failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 4. List Functions ─────────────────────
    {
      id:    'aiForge.gcp.listFunctions',
      title: 'GCP: List Cloud Functions',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Fetching Cloud Functions...' },
          async () => {
            try {
              const client = this._requireClient('list functions');
              const functions = await client.listFunctions();

              if (functions.length === 0) {
                vscode.window.showInformationMessage('GCP: No Cloud Functions found in this project.');
                return;
              }

              const summary = functions.map(fn => {
                const name = this._shortName(fn.name);
                const runtime = fn.buildConfig?.runtime ?? 'unknown';
                const trigger = fn.serviceConfig?.uri ? 'HTTP' : 'Event';
                return `- **${name}** [${fn.state}]: runtime=${runtime}, trigger=${trigger}, updated=${fn.updateTime}`;
              }).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Google Cloud Functions. Highlight any that are not ACTIVE, using outdated runtimes, or that might need attention:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`GCP: Failed to list functions — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 5. Function Details ─────────────────────
    {
      id:    'aiForge.gcp.functionDetails',
      title: 'GCP: Cloud Function Details & Optimization',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get function details');
          const functions = await client.listFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('GCP: No Cloud Functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            functions.map(fn => ({
              label:       this._shortName(fn.name),
              description: `[${fn.state}] ${fn.buildConfig?.runtime ?? 'unknown'}`,
              detail:      fn.serviceConfig?.uri ?? 'No HTTP trigger',
              fullName:    fn.name,
            })),
            { placeHolder: 'Select a function to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Fetching ${pick.label}...` },
            async () => {
              const detail = await client.getFunction(pick.fullName);
              const configJson = JSON.stringify(detail, null, 2);

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse this Google Cloud Function configuration. Suggest optimisations for performance, cost, and security (memory, timeout, concurrency, runtime version, IAM, etc.):\n\n\`\`\`json\n${configJson}\n\`\`\``,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Function details failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 6. Invoke Function ─────────────────────
    {
      id:    'aiForge.gcp.invokeFunction',
      title: 'GCP: Invoke Cloud Function',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('invoke function');
          const functions = await client.listFunctions();

          // Filter to HTTP-triggered functions
          const httpFunctions = functions.filter(fn => fn.serviceConfig?.uri);
          if (httpFunctions.length === 0) {
            vscode.window.showInformationMessage('GCP: No HTTP-triggered Cloud Functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            httpFunctions.map(fn => ({
              label:       this._shortName(fn.name),
              description: fn.serviceConfig?.uri ?? '',
              detail:      `[${fn.state}] ${fn.buildConfig?.runtime ?? 'unknown'}`,
              fullName:    fn.name,
            })),
            { placeHolder: 'Select a function to invoke' },
          );
          if (!pick) return;

          const payloadInput = await vscode.window.showInputBox({
            prompt:      'Request payload (JSON). Leave empty for no payload.',
            placeHolder: '{"key": "value"}',
            ignoreFocusOut: true,
            validateInput: (v) => {
              if (!v.trim()) return null;
              try { JSON.parse(v); return null; } catch { return 'Invalid JSON'; }
            },
          });
          if (payloadInput === undefined) return; // cancelled

          const payload = payloadInput.trim() ? JSON.parse(payloadInput) : undefined;

          const confirm = await vscode.window.showWarningMessage(
            `Invoke function "${pick.label}"?`,
            { modal: true },
            'Invoke',
          );
          if (confirm !== 'Invoke') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Invoking ${pick.label}...` },
            async () => {
              const result = await client.callFunction(pick.fullName, payload);

              const prompt = `Analyse this Cloud Function invocation result:

**Function:** ${pick.label}
**Payload:** \`${payloadInput || '{}'}\`

**Response:**
\`\`\`
${result.result.slice(0, 5000)}
\`\`\`

Explain the response, check for errors, and suggest improvements if applicable.`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Invoke function failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 7. Function Logs ─────────────────────
    {
      id:    'aiForge.gcp.functionLogs',
      title: 'GCP: Cloud Function Logs',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get function logs');
          const functions = await client.listFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('GCP: No Cloud Functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            functions.map(fn => ({
              label:       this._shortName(fn.name),
              description: `[${fn.state}] ${fn.buildConfig?.runtime ?? 'unknown'}`,
              fullName:    fn.name,
            })),
            { placeHolder: 'Select a function to view logs' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Fetching logs for ${pick.label}...` },
            async () => {
              const logs = await client.getFunctionLogs(pick.fullName, 50);

              if (logs.length === 0) {
                vscode.window.showInformationMessage(`GCP: No recent log entries for ${pick.label}.`);
                return;
              }

              const logLines = logs.map(log => {
                const text = log.textPayload ?? JSON.stringify(log.jsonPayload ?? {}).slice(0, 300);
                return `[${log.severity}] ${log.timestamp}: ${text}`;
              }).join('\n');

              const prompt = `Analyse these Cloud Function logs for "${pick.label}". Identify any errors, warnings, performance issues, or patterns:

\`\`\`
${logLines.slice(0, 8000)}
\`\`\`

Please:
1. Summarise the log activity
2. Highlight any errors or warnings with root cause analysis
3. Identify performance concerns (cold starts, timeouts, etc.)
4. Suggest improvements`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Function logs failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 8. Debug Function ─────────────────────
    {
      id:    'aiForge.gcp.debugFunction',
      title: 'GCP: Debug Cloud Function Errors',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('debug function');

          // Fetch functions and find ones with errors in logs
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GCP: Scanning for function errors...' },
            async () => {
              const functions = await client.listFunctions();
              if (functions.length === 0) {
                vscode.window.showInformationMessage('GCP: No Cloud Functions found.');
                return;
              }

              // Find functions with error logs
              const errorLogs = await client.listLogEntries(
                'resource.type="cloud_function" AND severity>=ERROR',
                30,
              );

              // Group errors by function name
              const errorsByFunction = new Map<string, LogEntry[]>();
              for (const log of errorLogs) {
                const fnName = log.resource?.labels?.['function_name'] ?? 'unknown';
                const existing = errorsByFunction.get(fnName) ?? [];
                existing.push(log);
                errorsByFunction.set(fnName, existing);
              }

              if (errorsByFunction.size === 0) {
                vscode.window.showInformationMessage('GCP: No recent Cloud Function errors found.');
                return;
              }

              const pick = await vscode.window.showQuickPick(
                Array.from(errorsByFunction.entries()).map(([name, logs]) => ({
                  label:       name,
                  description: `${logs.length} recent errors`,
                  detail:      logs[0].textPayload?.slice(0, 100) ?? 'Error details in logs',
                  fnName:      name,
                  logs,
                })),
                { placeHolder: 'Select a function with errors to debug' },
              );
              if (!pick) return;

              // Get function configuration for context
              const matchingFn = functions.find(fn => this._shortName(fn.name) === pick.fnName);
              let configSection = '';
              if (matchingFn) {
                try {
                  const detail = await client.getFunction(matchingFn.name);
                  configSection = `\n**Function Configuration:**\n\`\`\`json\n${JSON.stringify(detail, null, 2).slice(0, 3000)}\n\`\`\``;
                } catch { /* skip config fetch */ }
              }

              const errorLines = pick.logs.map(log => {
                const text = log.textPayload ?? JSON.stringify(log.jsonPayload ?? {}).slice(0, 500);
                return `[${log.severity}] ${log.timestamp}: ${text}`;
              }).join('\n');

              const prompt = `This Cloud Function "${pick.fnName}" has errors. Diagnose the issue and suggest a fix.
${configSection}

**Error Logs:**
\`\`\`
${errorLines.slice(0, 6000)}
\`\`\`

Provide:
1. Root cause analysis — what exactly is failing
2. The most likely fix (with code if applicable)
3. How to prevent this error in the future
4. Relevant GCP best practices`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Debug function failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 9. List Cloud Run ─────────────────────
    {
      id:    'aiForge.gcp.listCloudRun',
      title: 'GCP: List Cloud Run Services',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Fetching Cloud Run services...' },
          async () => {
            try {
              const client = this._requireClient('list Cloud Run services');
              const runServices = await client.listServices();

              if (runServices.length === 0) {
                vscode.window.showInformationMessage('GCP: No Cloud Run services found.');
                return;
              }

              const summary = runServices.map(svc => {
                const name = this._shortName(svc.name);
                const readyCondition = svc.conditions?.find(c => c.type === 'Ready');
                const status = readyCondition?.state === 'CONDITION_SUCCEEDED' ? 'Ready' : (readyCondition?.state ?? 'Unknown');
                return `- **${name}** [${status}]: URL=${svc.uri ?? 'none'}, revision=${svc.latestReadyRevision ? this._shortName(svc.latestReadyRevision) : 'none'}, updated=${svc.updateTime}`;
              }).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Cloud Run services. Highlight any that are not ready, recently updated, or that might need scaling adjustments:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`GCP: Failed to list Cloud Run services — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 10. Cloud Run Details ─────────────────────
    {
      id:    'aiForge.gcp.cloudRunDetails',
      title: 'GCP: Cloud Run Service Details & Optimization',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get Cloud Run service details');
          const runServices = await client.listServices();

          if (runServices.length === 0) {
            vscode.window.showInformationMessage('GCP: No Cloud Run services found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            runServices.map(svc => ({
              label:       this._shortName(svc.name),
              description: svc.uri ?? 'No URL',
              detail:      `Revision: ${svc.latestReadyRevision ? this._shortName(svc.latestReadyRevision) : 'none'}`,
              fullName:    svc.name,
            })),
            { placeHolder: 'Select a Cloud Run service to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Fetching ${pick.label}...` },
            async () => {
              const detail = await client.getService(pick.fullName);
              const configJson = JSON.stringify(detail, null, 2);

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse this Cloud Run service configuration. Suggest optimisations for scaling, cost, performance, and security:\n\n\`\`\`json\n${configJson.slice(0, 8000)}\n\`\`\`

Please review:
1. Container image and ports configuration
2. Scaling settings (min/max instances) — are they appropriate?
3. Traffic splitting between revisions
4. Memory and CPU allocation
5. Service account and IAM considerations
6. Cold start mitigation strategies`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Cloud Run details failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 11. Explore BigQuery ─────────────────────
    {
      id:    'aiForge.gcp.exploreBigQuery',
      title: 'GCP: Explore BigQuery Datasets & Tables',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('explore BigQuery');

          // Step 1: Pick dataset
          const datasets = await client.listDatasets();
          if (datasets.length === 0) {
            vscode.window.showInformationMessage('GCP: No BigQuery datasets found in this project.');
            return;
          }

          const dsPick = await vscode.window.showQuickPick(
            datasets.map(ds => ({
              label:       ds.datasetReference.datasetId,
              description: `Location: ${ds.location}`,
              detail:      ds.friendlyName ?? '',
              datasetId:   ds.datasetReference.datasetId,
            })),
            { placeHolder: 'Select a BigQuery dataset' },
          );
          if (!dsPick) return;

          // Step 2: Pick table
          const tables = await client.listTables(dsPick.datasetId);
          if (tables.length === 0) {
            vscode.window.showInformationMessage(`GCP: No tables found in ${dsPick.datasetId}.`);
            return;
          }

          const tablePick = await vscode.window.showQuickPick(
            tables.map(t => ({
              label:       t.tableReference.tableId,
              description: `Type: ${t.type}`,
              detail:      `Created: ${new Date(Number(t.creationTime)).toLocaleDateString()}`,
              datasetId:   t.tableReference.datasetId,
              tableId:     t.tableReference.tableId,
            })),
            { placeHolder: `Select a table in ${dsPick.datasetId}` },
          );
          if (!tablePick) return;

          // Step 3: Fetch schema and send to AI
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Fetching ${tablePick.label} schema...` },
            async () => {
              const tableDetail = await client.getTable(tablePick.datasetId, tablePick.tableId);
              const columns = tableDetail.schema?.fields
                ?.map(f => `  - \`${f.name}\` ${f.type}${f.mode === 'REQUIRED' ? ' NOT NULL' : ''}${f.description ? ` — ${f.description}` : ''}`)
                .join('\n') ?? '  (no schema info)';

              const prompt = `Explain this BigQuery table and suggest useful queries:

**Table:** \`${this._projectId}.${tablePick.datasetId}.${tablePick.tableId}\`
**Type:** ${tableDetail.type}
**Rows:** ${tableDetail.numRows ?? 'unknown'}
**Size:** ${tableDetail.numBytes ? `${(Number(tableDetail.numBytes) / (1024 * 1024)).toFixed(2)} MB` : 'unknown'}
${tableDetail.description ? `**Description:** ${tableDetail.description}` : ''}

**Schema:**
${columns}

Please:
1. Explain what this table likely represents based on column names and types
2. Suggest 3-5 useful queries (using fully-qualified table name)
3. Identify data quality concerns (nullable columns, missing descriptions)
4. Estimate query costs based on table size
5. Suggest partitioning/clustering if applicable`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Explore BigQuery failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 12. Run BigQuery ─────────────────────
    {
      id:    'aiForge.gcp.runBigQuery',
      title: 'GCP: Run BigQuery SQL',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('run BigQuery query');

          // Get SQL — from selection or prompt
          const editor = vscode.window.activeTextEditor;
          let sql = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : '';

          if (!sql) {
            const input = await vscode.window.showInputBox({
              prompt:      'Enter BigQuery SQL to execute',
              placeHolder: 'SELECT * FROM `project.dataset.table` LIMIT 100',
              ignoreFocusOut: true,
            });
            if (!input) return;
            sql = input;
          }

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GCP: Running BigQuery query...' },
            async () => {
              const result = await client.runQuery(sql);

              if (result.errors && result.errors.length > 0) {
                const errorMsg = result.errors.map(e => `${e.reason}: ${e.message}`).join('\n');
                const prompt = `This BigQuery query failed. Diagnose the error and suggest a fix:

**Query:**
\`\`\`sql
${sql}
\`\`\`

**Errors:**
\`\`\`
${errorMsg}
\`\`\`

Explain the error and provide a corrected query.`;

                await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
                return;
              }

              // Format results as a table
              const columns = result.schema?.fields.map(f => f.name) ?? [];
              const rows = result.rows?.slice(0, 50).map(r => r.f.map(f => f.v ?? 'NULL')) ?? [];

              let resultTable = '';
              if (columns.length > 0 && rows.length > 0) {
                const header = `| ${columns.join(' | ')} |`;
                const separator = `| ${columns.map(() => '---').join(' | ')} |`;
                const dataRows = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
                resultTable = `${header}\n${separator}\n${dataRows}`;
              }

              const prompt = `Analyse these BigQuery query results:

**Query:**
\`\`\`sql
${sql}
\`\`\`

**Results** (${result.totalRows ?? '?'} total rows, showing first ${rows.length}):
${resultTable || 'No rows returned.'}

Please:
1. Summarise what the results show
2. Highlight any interesting patterns or anomalies
3. Suggest follow-up queries for deeper analysis
4. Note any query optimisation opportunities`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: BigQuery query failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 13. Analyse BQ Job Failures ─────────────────────
    {
      id:    'aiForge.gcp.analyzeBQJob',
      title: 'GCP: Analyse Failed BigQuery Jobs',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('analyse BigQuery jobs');

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GCP: Fetching BigQuery jobs...' },
            async () => {
              const jobs = await client.listJobs(50);
              const failedJobs = jobs.filter(j => j.status.errorResult);

              if (failedJobs.length === 0) {
                vscode.window.showInformationMessage('GCP: No recent failed BigQuery jobs found.');
                return;
              }

              const pick = await vscode.window.showQuickPick(
                failedJobs.map(j => ({
                  label:       j.jobReference.jobId.slice(0, 40),
                  description: `${j.configuration.jobType} | ${j.status.errorResult?.reason ?? 'error'}`,
                  detail:      j.status.errorResult?.message?.slice(0, 120) ?? 'No error details',
                  job:         j,
                })),
                { placeHolder: 'Select a failed job to analyse' },
              );
              if (!pick) return;

              const job = pick.job;
              const prompt = `This BigQuery job failed. Diagnose the issue and suggest a fix.

**Job ID:** ${job.jobReference.jobId}
**Job Type:** ${job.configuration.jobType}
**Error:** ${job.status.errorResult?.reason ?? 'unknown'}: ${job.status.errorResult?.message ?? 'No message'}
${job.configuration.query?.query ? `\n**Query:**\n\`\`\`sql\n${job.configuration.query.query.slice(0, 3000)}\n\`\`\`` : ''}
${job.statistics?.creationTime ? `\n**Created:** ${new Date(Number(job.statistics.creationTime)).toISOString()}` : ''}

Provide:
1. Root cause analysis
2. A corrected query or configuration fix
3. Tips to prevent this error in the future
4. Cost implications of the failed job`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: BigQuery job analysis failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 14. Browse GCS ─────────────────────
    {
      id:    'aiForge.gcp.browseGCS',
      title: 'GCP: Browse Cloud Storage',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('browse Cloud Storage');

          // Step 1: Pick bucket
          const buckets = await client.listBuckets();
          if (buckets.length === 0) {
            vscode.window.showInformationMessage('GCP: No Cloud Storage buckets found.');
            return;
          }

          const bucketPick = await vscode.window.showQuickPick(
            buckets.map(b => ({
              label:       b.name,
              description: `${b.location} | ${b.storageClass}`,
              detail:      `Created: ${new Date(b.timeCreated).toLocaleDateString()}`,
            })),
            { placeHolder: 'Select a bucket' },
          );
          if (!bucketPick) return;

          // Step 2: Browse objects (with prefix navigation)
          let prefix = '';
          let selectedObject: GCSObject | null = null;

          while (!selectedObject) {
            const objects = await client.listObjects(bucketPick.label, prefix || undefined, 100);

            // Group by "directory" prefixes
            const dirs = new Set<string>();
            const files: GCSObject[] = [];
            for (const obj of objects) {
              const relative = prefix ? obj.name.slice(prefix.length) : obj.name;
              const slashIdx = relative.indexOf('/');
              if (slashIdx >= 0) {
                dirs.add((prefix || '') + relative.slice(0, slashIdx + 1));
              } else {
                files.push(obj);
              }
            }

            const items: Array<{ label: string; description: string; detail: string; isDir: boolean; dirPrefix?: string; obj?: GCSObject }> = [];

            // Go up option
            if (prefix) {
              const parentPrefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
              items.push({
                label:       '$(arrow-up) ..',
                description: 'Go up one level',
                detail:      parentPrefix || '(root)',
                isDir:       true,
                dirPrefix:   parentPrefix,
              });
            }

            // Directories
            for (const dir of Array.from(dirs).sort()) {
              items.push({
                label:       `$(folder) ${dir.slice(prefix.length).replace(/\/$/, '')}`,
                description: 'Directory',
                detail:      dir,
                isDir:       true,
                dirPrefix:   dir,
              });
            }

            // Files
            for (const obj of files.sort((a, b) => a.name.localeCompare(b.name))) {
              const sizeMB = (Number(obj.size) / (1024 * 1024)).toFixed(2);
              items.push({
                label:       `$(file) ${obj.name.split('/').pop() ?? obj.name}`,
                description: `${sizeMB} MB | ${obj.contentType}`,
                detail:      obj.name,
                isDir:       false,
                obj,
              });
            }

            if (items.length === 0) {
              vscode.window.showInformationMessage(`GCP: No objects found in gs://${bucketPick.label}/${prefix}`);
              return;
            }

            const pick = await vscode.window.showQuickPick(items, {
              placeHolder: `Browsing: gs://${bucketPick.label}/${prefix}`,
            });
            if (!pick) return;

            if (pick.isDir) {
              prefix = pick.dirPrefix ?? '';
            } else if (pick.obj) {
              selectedObject = pick.obj;
            }
          }

          // Download and open the selected object
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Downloading ${selectedObject.name}...` },
            async () => {
              try {
                const content = await client.getObject(bucketPick.label, selectedObject!.name);
                const fileName = selectedObject!.name.split('/').pop() ?? 'downloaded-file';
                const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsFolder) {
                  // Open as untitled document
                  const doc = await vscode.workspace.openTextDocument({ content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) });
                  await vscode.window.showTextDocument(doc);
                  return;
                }

                const filePath = path.join(wsFolder, '.gcs-downloads', fileName);
                const dirPath = path.dirname(filePath);
                if (!fs.existsSync(dirPath)) {
                  fs.mkdirSync(dirPath, { recursive: true });
                }
                fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(`GCP: Downloaded to ${filePath}`);
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`GCP: Download failed — ${msg}`);
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Browse GCS failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 15. Deploy to GCS ─────────────────────
    {
      id:    'aiForge.gcp.deployToGCS',
      title: 'GCP: Upload Current File to Cloud Storage',
      handler: async (services): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file to upload to Cloud Storage.');
          return;
        }

        try {
          const client = this._requireClient('upload to GCS');

          // Pick bucket
          const buckets = await client.listBuckets();
          if (buckets.length === 0) {
            vscode.window.showInformationMessage('GCP: No Cloud Storage buckets found.');
            return;
          }

          const bucketPick = await vscode.window.showQuickPick(
            buckets.map(b => ({
              label:       b.name,
              description: `${b.location} | ${b.storageClass}`,
            })),
            { placeHolder: 'Select a destination bucket' },
          );
          if (!bucketPick) return;

          const fileName = path.basename(editor.document.fileName);
          const objectName = await vscode.window.showInputBox({
            prompt:      'Object path in bucket',
            value:       fileName,
            placeHolder: 'path/to/file.ext',
            ignoreFocusOut: true,
            validateInput: (v) => v.trim() ? null : 'Object path is required',
          });
          if (!objectName) return;

          const confirm = await vscode.window.showWarningMessage(
            `Upload to gs://${bucketPick.label}/${objectName}?`,
            { modal: true },
            'Upload',
          );
          if (confirm !== 'Upload') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Uploading to gs://${bucketPick.label}/${objectName}...` },
            async () => {
              const content = editor.document.getText();
              const contentType = editor.document.languageId === 'json' ? 'application/json'
                : editor.document.languageId === 'html' ? 'text/html'
                : editor.document.languageId === 'css' ? 'text/css'
                : editor.document.languageId === 'javascript' ? 'application/javascript'
                : 'text/plain';

              await client.uploadObject(bucketPick.label, objectName.trim(), content, contentType);
              vscode.window.showInformationMessage(`GCP: Uploaded to gs://${bucketPick.label}/${objectName}`);
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Upload failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 16. List Pub/Sub ─────────────────────
    {
      id:    'aiForge.gcp.listPubSub',
      title: 'GCP: List Pub/Sub Topics & Subscriptions',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Fetching Pub/Sub resources...' },
          async () => {
            try {
              const client = this._requireClient('list Pub/Sub');

              const [topics, subscriptions] = await Promise.all([
                client.listTopics(),
                client.listSubscriptions(),
              ]);

              if (topics.length === 0 && subscriptions.length === 0) {
                vscode.window.showInformationMessage('GCP: No Pub/Sub topics or subscriptions found.');
                return;
              }

              const topicLines = topics.map(t => {
                const name = this._shortName(t.name);
                const labels = t.labels ? ` | Labels: ${Object.entries(t.labels).map(([k, v]) => `${k}=${v}`).join(', ')}` : '';
                return `- **${name}**${labels}`;
              }).join('\n');

              const subLines = subscriptions.map(s => {
                const name = this._shortName(s.name);
                const topicName = this._shortName(s.topic);
                const pushEndpoint = s.pushConfig?.pushEndpoint ? ` | Push: ${s.pushConfig.pushEndpoint}` : ' | Pull';
                return `- **${name}** → topic: ${topicName} | ack: ${s.ackDeadlineSeconds}s${pushEndpoint}`;
              }).join('\n');

              const prompt = `Analyse this Pub/Sub messaging architecture:

### Topics (${topics.length})
${topicLines || 'None found.'}

### Subscriptions (${subscriptions.length})
${subLines || 'None found.'}

Please:
1. Explain the messaging architecture and data flow
2. Identify any orphaned subscriptions or topics without subscribers
3. Suggest improvements (dead-letter topics, retry policies, push vs pull)
4. Highlight potential reliability or ordering concerns`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`GCP: Pub/Sub listing failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 17. Publish Message ─────────────────────
    {
      id:    'aiForge.gcp.publishMessage',
      title: 'GCP: Publish Pub/Sub Message',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('publish Pub/Sub message');

          const topics = await client.listTopics();
          if (topics.length === 0) {
            vscode.window.showInformationMessage('GCP: No Pub/Sub topics found.');
            return;
          }

          const topicPick = await vscode.window.showQuickPick(
            topics.map(t => ({
              label:    this._shortName(t.name),
              detail:   t.name,
              fullName: t.name,
            })),
            { placeHolder: 'Select a topic to publish to' },
          );
          if (!topicPick) return;

          // Get message — from selection or input
          const editor = vscode.window.activeTextEditor;
          let messageData = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : '';

          if (!messageData) {
            const input = await vscode.window.showInputBox({
              prompt:      'Message data (text or JSON)',
              placeHolder: '{"event": "test", "data": "hello"}',
              ignoreFocusOut: true,
              validateInput: (v) => v.trim() ? null : 'Message data is required',
            });
            if (!input) return;
            messageData = input;
          }

          const confirm = await vscode.window.showWarningMessage(
            `Publish message to "${topicPick.label}"?`,
            { modal: true },
            'Publish',
          );
          if (confirm !== 'Publish') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Publishing to ${topicPick.label}...` },
            async () => {
              const result = await client.publishMessage(topicPick.fullName, messageData);
              vscode.window.showInformationMessage(
                `GCP: Message published to ${topicPick.label}. Message ID: ${result.messageId}`
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Publish message failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 18. Explore Firestore ─────────────────────
    {
      id:    'aiForge.gcp.exploreFirestore',
      title: 'GCP: Explore Firestore Collections',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('explore Firestore');

          // Step 1: List collections
          const collections = await client.listCollections();
          if (collections.length === 0) {
            vscode.window.showInformationMessage('GCP: No Firestore collections found.');
            return;
          }

          const collPick = await vscode.window.showQuickPick(
            collections.map(c => ({
              label:       c,
              description: 'Collection',
            })),
            { placeHolder: 'Select a Firestore collection' },
          );
          if (!collPick) return;

          // Step 2: List documents in collection
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GCP: Fetching ${collPick.label} documents...` },
            async () => {
              const docs = await client.listDocuments(collPick.label, 20);

              if (docs.length === 0) {
                vscode.window.showInformationMessage(`GCP: No documents found in ${collPick.label}.`);
                return;
              }

              // Format documents for AI analysis
              const docSummaries = docs.map(doc => {
                const docName = this._shortName(doc.name);
                const fieldNames = Object.keys(doc.fields);
                const fieldSummary = fieldNames.slice(0, 10).map(f => {
                  const val = doc.fields[f];
                  const type = val.stringValue !== undefined ? 'string'
                    : val.integerValue !== undefined ? 'integer'
                    : val.booleanValue !== undefined ? 'boolean'
                    : val.mapValue !== undefined ? 'map'
                    : val.arrayValue !== undefined ? 'array'
                    : 'unknown';
                  return `\`${f}\` (${type})`;
                }).join(', ');
                return `- **${docName}**: ${fieldSummary}${fieldNames.length > 10 ? ` (+${fieldNames.length - 10} more fields)` : ''}`;
              }).join('\n');

              const prompt = `Analyse this Firestore collection and its data model:

**Collection:** \`${collPick.label}\`
**Documents found:** ${docs.length}

### Sample Documents:
${docSummaries}

### First Document (full):
\`\`\`json
${JSON.stringify(docs[0], null, 2).slice(0, 3000)}
\`\`\`

Please:
1. Explain the data model and what this collection represents
2. Identify the field types and their purposes
3. Suggest Firestore security rules for this collection
4. Recommend indexes for common query patterns
5. Highlight any data modelling improvements (subcollections, denormalisation, etc.)`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`GCP: Explore Firestore failed — ${msg}`);
        }
      },
    },
  ];
}
