/**
 * plugins/azureConnected.ts — Azure Connected plugin for Evolve AI
 *
 * Activates alongside the base Azure plugin when the workspace contains
 * Azure markers AND API credentials are configured in SecretStorage.
 *
 * Contributes:
 *  - contextHooks      : live Function Apps status, resource group summary,
 *                         recent pipeline failures (60-second cache)
 *  - systemPromptSection: connected-workspace knowledge + subscription info
 *  - codeLensActions    : Invoke Function, View Logs
 *  - commands (20)      : connect, disconnect, subscription status, Function Apps,
 *                         Logic Apps, Cosmos DB, Storage, Pipelines, App Service,
 *                         Log Analytics, Alerts
 *  - statusItem         : shows connection status + subscription
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
import { AzureClient } from '../core/azureClient';
import type {
  AzureFunctionApp,
  AzureLogicApp,
  CosmosAccount,
  AzureStorageAccount,
  AzureWebApp,
} from '../core/azureClient';

// ── Detection markers (same as base Azure plugin) ────────────────────────────

const AZURE_MARKERS = [
  'host.json',
  'local.settings.json',
  'function.json',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.azure',
  'azuredeploy.json',
  'main.bicep',
];

const AZURE_IMPORT_PATTERN = /from azure\.|require\s*\(\s*['"]@azure\//;
const AZURE_NAMESPACE_PATTERN = /using\s+Azure\.|Microsoft\.Azure\.|Azure\.\w+/;

function findMarker(wsPath: string): string | null {
  for (const marker of AZURE_MARKERS) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

function hasBicepFiles(wsPath: string): boolean {
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv']);
  let found = false;
  function walk(dir: string, depth = 0): void {
    if (found || depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (found) return;
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); }
        else if (/\.bicep$/.test(entry.name)) { found = true; return; }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(wsPath);
  return found;
}

function hasAzureDependency(wsPath: string): boolean {
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8').slice(0, 5000);
        if (/azure-functions|azure-storage|azure-cosmos|azure-identity|azure-mgmt/i.test(content)) return true;
      } catch { /* ignore */ }
    }
  }
  const pkg = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const allDeps = { ...p.dependencies, ...p.devDependencies };
      if (Object.keys(allDeps).some(d => d.startsWith('@azure/'))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', 'bin', 'obj']);
  function walk(d: string) {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) results.push(full);
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

// ── Cached context data ──────────────────────────────────────────────────────

interface ConnectedContextData {
  subscriptionName: string;
  resourceGroupCount: number;
  functionApps: Array<{ name: string; state: string; runtime: string; region: string }>;
  recentErrors: Array<{ app: string; message: string; time: string }>;
  failedPipelines: Array<{ name: string; result: string; date: string }>;
  webApps: Array<{ name: string; state: string; region: string }>;
}

// ── Secret keys ──────────────────────────────────────────────────────────────

const SECRET_TENANT_ID       = 'azure-tenant-id';
const SECRET_CLIENT_ID       = 'azure-client-id';
const SECRET_CLIENT_SECRET   = 'azure-client-secret';
const SECRET_SUBSCRIPTION_ID = 'azure-subscription-id';

const CACHE_TTL_MS = 60_000; // 60 seconds

// ── The plugin ───────────────────────────────────────────────────────────────

export class AzureConnectedPlugin implements IPlugin {
  readonly id          = 'azure-connected';
  readonly displayName = 'Azure Connected';
  readonly icon        = '$(cloud-upload)';

  private _client: AzureClient | null = null;
  private _connected = false;
  private _subscriptionName = '';
  private _subscriptionId   = '';
  private _wsPath = '';

  // Cache for context data
  private _cachedContext: ConnectedContextData | null = null;
  private _cacheTimestamp = 0;

  // ── detect ──────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Must be an Azure workspace (same markers as base plugin)
    if (findMarker(wsPath)) return true;
    if (hasBicepFiles(wsPath)) return true;
    if (hasAzureDependency(wsPath)) return true;

    // Quick scan for Azure imports
    const sourceFiles = globFiles(wsPath, [/\.py$/, /\.cs$/, /\.ts$/, /\.js$/], 30);
    for (const f of sourceFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (AZURE_IMPORT_PATTERN.test(sample)) return true;
        if (AZURE_NAMESPACE_PATTERN.test(sample)) return true;
      } catch { /* skip */ }
    }

    return false;
  }

  // ── activate ────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Try to initialise client from stored secrets
    const client = await AzureClient.fromSecrets(services.ai);
    if (client) {
      try {
        const test = await client.testConnection();
        if (test.ok) {
          this._client = client;
          this._connected = true;
          const sub = await client.getSubscription();
          this._subscriptionName = sub.displayName;
          this._subscriptionId = sub.subscriptionId;
          console.log(`[Evolve AI] Azure Connected: ${this._subscriptionName}`);
        } else {
          console.warn(`[Evolve AI] Azure Connected: stored credentials invalid — ${test.message}`);
          this._showSetupPrompt();
        }
      } catch (e) {
        console.warn(`[Evolve AI] Azure Connected: credential check failed — ${e}`);
        this._showSetupPrompt();
      }
    } else {
      this._showSetupPrompt();
    }

    return [];
  }

  private _showSetupPrompt(): void {
    vscode.window.showInformationMessage(
      'Azure Connected plugin detected an Azure workspace. Configure service principal credentials to enable live features.',
      'Connect Now',
    ).then(choice => {
      if (choice === 'Connect Now') {
        vscode.commands.executeCommand('aiForge.azure.connect');
      }
    });
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
      const client = this._client;

      // Fetch resource groups count
      const rgs = await client.listResourceGroups();
      const rgCount = rgs.length;

      // Fetch function apps with status
      let functionApps: ConnectedContextData['functionApps'] = [];
      try {
        const apps = await client.listFunctionApps();
        functionApps = apps.slice(0, 10).map(a => ({
          name:    a.name,
          state:   a.state,
          runtime: a.kind,
          region:  a.location,
        }));
      } catch { /* Functions may not be deployed */ }

      // Fetch function app errors from logs (best-effort)
      const recentErrors: ConnectedContextData['recentErrors'] = [];
      try {
        for (const app of functionApps.slice(0, 3)) {
          const detail = await client.getFunctionApp(
            this._extractResourceGroup(app.name, functionApps as unknown as AzureFunctionApp[]),
            app.name,
          );
          if (detail && detail.appSettings) {
            // We note apps that might have issues (stopped state etc.)
            if (app.state !== 'Running') {
              recentErrors.push({
                app:     app.name,
                message: `Function App is in ${app.state} state`,
                time:    new Date().toISOString(),
              });
            }
          }
        }
      } catch { /* best-effort */ }

      // Fetch web apps
      let webApps: ConnectedContextData['webApps'] = [];
      try {
        const apps = await client.listWebApps();
        webApps = apps.slice(0, 10).map(a => ({
          name:   a.name,
          state:  a.state,
          region: a.location,
        }));
      } catch { /* App Service may not be used */ }

      // Pipeline failures (best-effort — requires DevOps org/project)
      const failedPipelines: ConnectedContextData['failedPipelines'] = [];

      this._cachedContext = {
        subscriptionName: this._subscriptionName,
        resourceGroupCount: rgCount,
        functionApps,
        recentErrors,
        failedPipelines,
        webApps,
      };
      this._cacheTimestamp = now;
      return this._cachedContext;
    } catch (e) {
      console.warn(`[Evolve AI] Azure Connected context fetch failed: ${e}`);
      return this._cachedContext; // return stale cache if available
    }
  }

  private _extractResourceGroup(appName: string, apps: AzureFunctionApp[]): string {
    const match = apps.find(a => a.name === appName);
    return match?.resourceGroup ?? '';
  }

  // ── Helper: ensure connected ────────────────────────────────────────────

  private _requireClient(action: string): AzureClient {
    if (!this._client || !this._connected) {
      vscode.window.showWarningMessage(
        'Azure: Not connected. Run "Azure: Connect" first.',
        'Connect Now',
      ).then(choice => {
        if (choice === 'Connect Now') {
          vscode.commands.executeCommand('aiForge.azure.connect');
        }
      });
      throw new Error(`Azure not connected — cannot ${action}`);
    }
    return this._client;
  }

  // ── contextHooks ────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'azure-live',

      collect: async (_ws): Promise<ConnectedContextData | null> => {
        return this._fetchContextData();
      },

      format(data: unknown): string {
        const d = data as ConnectedContextData | null;
        if (!d) return '';

        const lines = [`## Azure Live Environment (${d.subscriptionName})`];
        lines.push(`**Resource Groups:** ${d.resourceGroupCount}`);

        if (d.functionApps.length > 0) {
          lines.push('\n### Function Apps');
          for (const app of d.functionApps) {
            lines.push(`- **${app.name}**: ${app.state} (${app.runtime}, ${app.region})`);
          }
        }

        if (d.webApps.length > 0) {
          lines.push('\n### Web Apps');
          for (const app of d.webApps) {
            lines.push(`- **${app.name}**: ${app.state} (${app.region})`);
          }
        }

        if (d.recentErrors.length > 0) {
          lines.push('\n### Recent Issues');
          for (const err of d.recentErrors) {
            lines.push(`- **${err.app}**: ${err.message.slice(0, 200)}`);
          }
        }

        if (d.failedPipelines.length > 0) {
          lines.push('\n### Failed Pipelines');
          for (const p of d.failedPipelines) {
            lines.push(`- **${p.name}**: ${p.result} (${p.date})`);
          }
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ─────────────────────────────────────────────────

  systemPromptSection(): string {
    const base = `
## Azure Connected Environment

You have access to a live Azure subscription. The user can ask you to:
- Check Function App status, logs, invoke functions, diagnose errors
- Browse Logic Apps and analyse workflow failures
- Explore Cosmos DB accounts, databases, containers, and run queries
- Browse Storage accounts, containers, blobs — upload and download files
- List and analyse Azure DevOps pipeline runs and failures
- Manage App Service web apps (list, inspect, restart)
- Query Log Analytics with KQL and analyse results
- List active alerts and suggest remediation

When the user asks about their Azure environment, use the live data available in context.
When diagnosing failures, be specific — reference actual error messages and resource configurations.
Suggest Azure best practices for cost, security, and reliability.
`.trim();

    if (this._connected) {
      return `${base}\n\n**Subscription:** ${this._subscriptionName} (${this._subscriptionId})`;
    }
    return `${base}\n\n_Credentials not yet configured. The user should run "Azure: Connect" to enable live features._`;
  }

  // ── codeLensActions ─────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud-upload) Invoke Azure Function',
      command:     'aiForge.azure.invokeFunction',
      linePattern: /\[FunctionName\s*\(|@app\.(route|function_name|timer_trigger|queue_trigger)|def\s+main\s*\(.*func\.HttpRequest/,
      languages:   ['python', 'csharp'],
      tooltip:     'Invoke this function on the live Azure environment',
    },
    {
      title:       '$(output) View Function Logs',
      command:     'aiForge.azure.functionLogs',
      linePattern: /\[FunctionName\s*\(|@app\.(route|function_name)|azure-functions/,
      languages:   ['python', 'csharp', 'typescript', 'javascript'],
      tooltip:     'Fetch recent logs for this Function App',
    },
  ];

  // ── commands (20) ───────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [

    // ───────────────────── 1. Connect ─────────────────────
    {
      id:    'aiForge.azure.connect',
      title: 'Azure: Connect to Subscription',
      handler: async (services): Promise<void> => {
        const tenantId = await vscode.window.showInputBox({
          prompt:         'Azure Tenant ID (Directory ID)',
          placeHolder:    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput:  (v) => v.trim() ? null : 'Tenant ID is required',
        });
        if (!tenantId) return;

        const clientId = await vscode.window.showInputBox({
          prompt:         'Azure Client ID (Application ID)',
          placeHolder:    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput:  (v) => v.trim() ? null : 'Client ID is required',
        });
        if (!clientId) return;

        const clientSecret = await vscode.window.showInputBox({
          prompt:         'Azure Client Secret',
          placeHolder:    'Enter client secret value',
          password:       true,
          ignoreFocusOut: true,
          validateInput:  (v) => v.trim() ? null : 'Client Secret is required',
        });
        if (!clientSecret) return;

        const subscriptionId = await vscode.window.showInputBox({
          prompt:         'Azure Subscription ID',
          placeHolder:    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput:  (v) => v.trim() ? null : 'Subscription ID is required',
        });
        if (!subscriptionId) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Testing connection...' },
          async () => {
            try {
              // Store credentials first so AzureClient can read them
              await AzureClient.configureCredentials(
                services.ai,
                tenantId.trim(),
                clientId.trim(),
                clientSecret.trim(),
                subscriptionId.trim(),
              );

              const client = await AzureClient.fromSecrets(services.ai);
              if (!client) {
                vscode.window.showErrorMessage('Azure: Failed to create client from credentials.');
                return;
              }

              const test = await client.testConnection();
              if (!test.ok) {
                vscode.window.showErrorMessage(`Azure: Connection failed — ${test.message}`);
                return;
              }

              const sub = await client.getSubscription();

              this._client = client;
              this._connected = true;
              this._subscriptionName = sub.displayName;
              this._subscriptionId = sub.subscriptionId;
              this._cachedContext = null;
              this._cacheTimestamp = 0;

              vscode.window.showInformationMessage(
                `Azure: Connected to subscription "${sub.displayName}"`
              );
              services.events.emit('ui.status.update', {});
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Connection failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 2. Disconnect ─────────────────────
    {
      id:    'aiForge.azure.disconnect',
      title: 'Azure: Disconnect',
      handler: async (services): Promise<void> => {
        await services.ai.storeSecret(SECRET_TENANT_ID, '');
        await services.ai.storeSecret(SECRET_CLIENT_ID, '');
        await services.ai.storeSecret(SECRET_CLIENT_SECRET, '');
        await services.ai.storeSecret(SECRET_SUBSCRIPTION_ID, '');
        this._client = null;
        this._connected = false;
        this._subscriptionName = '';
        this._subscriptionId = '';
        this._cachedContext = null;
        this._cacheTimestamp = 0;
        vscode.window.showInformationMessage('Azure: Disconnected. Credentials cleared.');
        services.events.emit('ui.status.update', {});
      },
    },

    // ───────────────────── 3. Subscription Status ─────────────────────
    {
      id:    'aiForge.azure.subscriptionStatus',
      title: 'Azure: Subscription Status',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching subscription info...' },
          async () => {
            try {
              const client = this._requireClient('get subscription status');
              const [sub, rgs, functionApps, webApps] = await Promise.all([
                client.getSubscription(),
                client.listResourceGroups(),
                client.listFunctionApps().catch(() => [] as AzureFunctionApp[]),
                client.listWebApps().catch(() => [] as AzureWebApp[]),
              ]);

              const summary = [
                `**Subscription:** ${sub.displayName} (${sub.subscriptionId})`,
                `**State:** ${sub.state}`,
                `**Resource Groups:** ${rgs.length}`,
                `**Function Apps:** ${functionApps.length}`,
                `**Web Apps:** ${webApps.length}`,
                '',
                '### Resource Groups',
                ...rgs.slice(0, 20).map(rg => `- **${rg.name}** (${rg.location})`),
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Summarise this Azure subscription and highlight anything noteworthy (resource distribution, naming patterns, etc.):\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Subscription status failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 4. List Function Apps ─────────────────────
    {
      id:    'aiForge.azure.listFunctionApps',
      title: 'Azure: List Function Apps',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching Function Apps...' },
          async () => {
            try {
              const client = this._requireClient('list function apps');
              const apps = await client.listFunctionApps();

              if (apps.length === 0) {
                vscode.window.showInformationMessage('Azure: No Function Apps found in this subscription.');
                return;
              }

              const summary = apps.map(a =>
                `- **${a.name}** [${a.state}]: ${a.kind}, ${a.location}, host: ${a.defaultHostName}`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Azure Function Apps. Highlight any that are stopped, using outdated runtimes, or might benefit from scaling adjustments:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Failed to list Function Apps — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 5. Function App Details ─────────────────────
    {
      id:    'aiForge.azure.functionAppDetails',
      title: 'Azure: Function App Details & Optimization',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get function app details');
          const apps = await client.listFunctionApps();

          if (apps.length === 0) {
            vscode.window.showInformationMessage('Azure: No Function Apps found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            apps.map(a => ({
              label:       a.name,
              description: `[${a.state}] ${a.location}`,
              detail:      `Resource Group: ${a.resourceGroup} | Host: ${a.defaultHostName}`,
              app:         a,
            })),
            { placeHolder: 'Select a Function App to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Fetching ${pick.label} details...` },
            async () => {
              const [detail, functions] = await Promise.all([
                client.getFunctionApp(pick.app.resourceGroup, pick.app.name),
                client.listFunctions(pick.app.resourceGroup, pick.app.name).catch(() => []),
              ]);

              const configJson = JSON.stringify({
                name:          detail.name,
                state:         detail.state,
                location:      detail.location,
                kind:          detail.kind,
                runtimeStack:  detail.runtimeStack,
                appSettings:   detail.appSettings,
                functions:     functions.map(f => ({ name: f.name, language: f.language, disabled: f.isDisabled })),
              }, null, 2);

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse this Azure Function App configuration. Suggest optimisations for performance, cost, and security (runtime version, plan sizing, app settings, managed identity, etc.):\n\n\`\`\`json\n${configJson}\n\`\`\``,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Function App details failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 6. Invoke Function ─────────────────────
    {
      id:    'aiForge.azure.invokeFunction',
      title: 'Azure: Invoke Function',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('invoke function');
          const apps = await client.listFunctionApps();
          const runningApps = apps.filter(a => a.state === 'Running');

          if (runningApps.length === 0) {
            vscode.window.showInformationMessage('Azure: No running Function Apps found.');
            return;
          }

          const appPick = await vscode.window.showQuickPick(
            runningApps.map(a => ({
              label:       a.name,
              description: a.defaultHostName,
              detail:      `${a.location} | ${a.kind}`,
              app:         a,
            })),
            { placeHolder: 'Select a Function App' },
          );
          if (!appPick) return;

          const url = await vscode.window.showInputBox({
            prompt:         'Function URL (e.g. https://myapp.azurewebsites.net/api/MyFunction)',
            placeHolder:    `https://${appPick.app.defaultHostName}/api/`,
            value:          `https://${appPick.app.defaultHostName}/api/`,
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'URL is required',
          });
          if (!url) return;

          const payloadStr = await vscode.window.showInputBox({
            prompt:         'Request payload (JSON, leave empty for GET)',
            placeHolder:    '{"name": "test"}',
            ignoreFocusOut: true,
          });

          const payload = payloadStr?.trim() ? JSON.parse(payloadStr) : undefined;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Invoking function...' },
            async () => {
              try {
                const result = await client.invokeFunctionApp(url.trim(), payload);
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `Analyse this Azure Function response. Explain the output and suggest any improvements to the function:\n\n**URL:** ${url}\n**Payload:** ${payloadStr || '(none — GET request)'}\n\n**Response:**\n\`\`\`json\n${resultStr.slice(0, 5000)}\n\`\`\``,
                  'chat',
                );
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `Azure Function invocation failed. Diagnose the error and suggest fixes:\n\n**URL:** ${url}\n**Error:** ${msg}`,
                  'chat',
                );
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Invoke function failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 7. Function Logs ─────────────────────
    {
      id:    'aiForge.azure.functionLogs',
      title: 'Azure: Function App Logs',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('fetch function logs');
          const apps = await client.listFunctionApps();

          if (apps.length === 0) {
            vscode.window.showInformationMessage('Azure: No Function Apps found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            apps.map(a => ({
              label:       a.name,
              description: `[${a.state}] ${a.location}`,
              detail:      `Resource Group: ${a.resourceGroup}`,
              app:         a,
            })),
            { placeHolder: 'Select a Function App to view logs' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Fetching logs for ${pick.label}...` },
            async () => {
              try {
                const logs = await client.getFunctionLogs(pick.app.resourceGroup, pick.app.name, 'host');

                if (!logs || logs.length === 0) {
                  vscode.window.showInformationMessage(`Azure: No recent logs found for ${pick.label}.`);
                  return;
                }

                const logText = logs;

                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `Analyse these Azure Function App logs for "${pick.label}". Identify errors, warnings, slow invocations, and suggest improvements:\n\n\`\`\`\n${logText.slice(0, 8000)}\n\`\`\``,
                  'chat',
                );
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Azure: Failed to fetch logs — ${msg}`);
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Function logs failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 8. Debug Function ─────────────────────
    {
      id:    'aiForge.azure.debugFunction',
      title: 'Azure: Debug Function App Errors',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('debug function');
          const apps = await client.listFunctionApps();
          const problematic = apps.filter(a => a.state !== 'Running');
          const targetApps = problematic.length > 0 ? problematic : apps;

          if (targetApps.length === 0) {
            vscode.window.showInformationMessage('Azure: No Function Apps found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            targetApps.map(a => ({
              label:       a.name,
              description: `[${a.state}] ${a.location}`,
              detail:      problematic.length > 0 ? 'This app has issues' : `Resource Group: ${a.resourceGroup}`,
              app:         a,
            })),
            { placeHolder: problematic.length > 0 ? 'Select a problematic Function App to debug' : 'Select a Function App to debug' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Diagnosing ${pick.label}...` },
            async () => {
              const [detail, logs, functions] = await Promise.all([
                client.getFunctionApp(pick.app.resourceGroup, pick.app.name),
                client.getFunctionLogs(pick.app.resourceGroup, pick.app.name, 'host').catch(() => ''),
                client.listFunctions(pick.app.resourceGroup, pick.app.name).catch(() => []),
              ]);

              const diagnosticData = [
                `## Function App Diagnostic: ${pick.label}`,
                '',
                `**State:** ${detail.state}`,
                `**Runtime:** ${detail.runtimeStack}`,
                `**Location:** ${detail.location}`,
                `**Functions:** ${functions.map(f => `${f.name} (${f.language}, disabled=${f.isDisabled})`).join(', ') || 'none found'}`,
                '',
                '### App Settings',
                '```json',
                JSON.stringify(detail.appSettings, null, 2).slice(0, 2000),
                '```',
                '',
                '### Recent Logs',
                '```',
                logs.slice(0, 4000),
                '```',
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Diagnose this Azure Function App. It ${pick.app.state !== 'Running' ? 'is NOT running' : 'may have errors'}. Analyse the configuration, logs, and function list. Provide specific diagnosis and actionable fix steps:\n\n${diagnosticData}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Debug function failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 9. List Logic Apps ─────────────────────
    {
      id:    'aiForge.azure.listLogicApps',
      title: 'Azure: List Logic Apps',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching Logic Apps...' },
          async () => {
            try {
              const client = this._requireClient('list logic apps');
              const apps = await client.listLogicApps();

              if (apps.length === 0) {
                vscode.window.showInformationMessage('Azure: No Logic Apps found in this subscription.');
                return;
              }

              const summary = apps.map(a =>
                `- **${a.name}** [${a.state}]: ${a.location}, RG: ${a.resourceGroup}, changed: ${a.changedTime}`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Azure Logic Apps. Summarise the workflows and highlight any that are disabled or might need attention:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Failed to list Logic Apps — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 10. Analyze Logic App Failure ─────────────────────
    {
      id:    'aiForge.azure.analyzeLogicAppFailure',
      title: 'Azure: Analyse Logic App Failure',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('analyse logic app failure');
          const apps = await client.listLogicApps();

          if (apps.length === 0) {
            vscode.window.showInformationMessage('Azure: No Logic Apps found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            apps.map(a => ({
              label:       a.name,
              description: `[${a.state}] ${a.location}`,
              detail:      `Resource Group: ${a.resourceGroup}`,
              app:         a,
            })),
            { placeHolder: 'Select a Logic App to analyse failures' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Fetching failed runs for ${pick.label}...` },
            async () => {
              const [detail, runs] = await Promise.all([
                client.getLogicApp(pick.app.resourceGroup, pick.app.name),
                client.listLogicAppRuns(pick.app.resourceGroup, pick.app.name, 10),
              ]);

              if (runs.length === 0) {
                vscode.window.showInformationMessage(`Azure: No failed runs found for ${pick.label}.`);
                return;
              }

              const runsSummary = runs.map(r =>
                `- **${r.name}** [${r.status}]: started ${r.startTime}${r.endTime ? `, ended ${r.endTime}` : ''}${r.correlation?.clientTrackingId ? ` (tracking: ${r.correlation.clientTrackingId})` : ''}`
              ).join('\n');

              const diagnosticData = [
                `## Logic App Failure Analysis: ${pick.label}`,
                '',
                `**State:** ${pick.app.state}`,
                `**Location:** ${pick.app.location}`,
                '',
                '### Workflow Definition (summary)',
                '```json',
                JSON.stringify(detail.definition, null, 2).slice(0, 3000),
                '```',
                '',
                '### Failed Runs',
                runsSummary,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Diagnose the failures in this Azure Logic App. Analyse the workflow definition and failed runs. Provide specific diagnosis and actionable fix steps:\n\n${diagnosticData}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Logic App failure analysis failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 11. Explore Cosmos DB ─────────────────────
    {
      id:    'aiForge.azure.exploreCosmosDB',
      title: 'Azure: Explore Cosmos DB',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('explore Cosmos DB');

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching Cosmos DB accounts...' },
            async () => {
              const accounts = await client.listCosmosAccounts();

              if (accounts.length === 0) {
                vscode.window.showInformationMessage('Azure: No Cosmos DB accounts found.');
                return;
              }

              const accountPick = await vscode.window.showQuickPick(
                accounts.map(a => ({
                  label:       a.name,
                  description: `${a.kind} | ${a.location}`,
                  detail:      `Endpoint: ${a.documentEndpoint}`,
                  account:     a,
                })),
                { placeHolder: 'Select a Cosmos DB account' },
              );
              if (!accountPick) return;

              const databases = await client.listCosmosDatabases(
                accountPick.account.resourceGroup,
                accountPick.account.name,
              );

              if (databases.length === 0) {
                vscode.window.showInformationMessage(`Azure: No databases found in ${accountPick.label}.`);
                return;
              }

              const dbPick = await vscode.window.showQuickPick(
                databases.map(d => ({
                  label:  d.id,
                  detail: `RID: ${d._rid}`,
                  db:     d,
                })),
                { placeHolder: 'Select a database' },
              );
              if (!dbPick) return;

              const containers = await client.listCosmosContainers(
                accountPick.account.resourceGroup,
                accountPick.account.name,
                dbPick.db.id,
              );

              const dataModel = [
                `## Cosmos DB Data Model: ${accountPick.label}`,
                '',
                `**Account:** ${accountPick.account.name} (${accountPick.account.kind})`,
                `**Database:** ${dbPick.db.id}`,
                `**Endpoint:** ${accountPick.account.documentEndpoint}`,
                '',
                '### Containers',
                ...containers.map(c =>
                  `- **${c.id}**: Partition Key = ${c.partitionKey.paths.join(', ')} (${c.partitionKey.kind})`
                ),
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Explain this Cosmos DB data model. Analyse the partition key design, suggest query patterns, and identify potential performance issues:\n\n${dataModel}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Cosmos DB exploration failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 12. Query Cosmos DB ─────────────────────
    {
      id:    'aiForge.azure.queryCosmos',
      title: 'Azure: Query Cosmos DB',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('query Cosmos DB');
          const accounts = await client.listCosmosAccounts();

          if (accounts.length === 0) {
            vscode.window.showInformationMessage('Azure: No Cosmos DB accounts found.');
            return;
          }

          const accountPick = await vscode.window.showQuickPick(
            accounts.map(a => ({
              label:       a.name,
              description: `${a.kind} | ${a.location}`,
              account:     a,
            })),
            { placeHolder: 'Select a Cosmos DB account' },
          );
          if (!accountPick) return;

          const databases = await client.listCosmosDatabases(
            accountPick.account.resourceGroup,
            accountPick.account.name,
          );

          const dbPick = await vscode.window.showQuickPick(
            databases.map(d => ({ label: d.id, db: d })),
            { placeHolder: 'Select a database' },
          );
          if (!dbPick) return;

          const containers = await client.listCosmosContainers(
            accountPick.account.resourceGroup,
            accountPick.account.name,
            dbPick.db.id,
          );

          const containerPick = await vscode.window.showQuickPick(
            containers.map(c => ({
              label:       c.id,
              description: `Partition: ${c.partitionKey.paths.join(', ')}`,
              container:   c,
            })),
            { placeHolder: 'Select a container' },
          );
          if (!containerPick) return;

          const query = await vscode.window.showInputBox({
            prompt:         'SQL query',
            placeHolder:    'SELECT TOP 10 * FROM c',
            value:          'SELECT TOP 10 * FROM c',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Query is required',
          });
          if (!query) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Executing Cosmos DB query...' },
            async () => {
              try {
                const result = await client.queryCosmosDocuments(
                  accountPick.account.resourceGroup,
                  accountPick.account.name,
                  dbPick.db.id,
                  containerPick.container.id,
                  query.trim(),
                );

                const resultStr = JSON.stringify(result.Documents.slice(0, 20), null, 2);

                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `Analyse these Cosmos DB query results. Explain the data structure and suggest query optimisations:\n\n**Query:** \`${query}\`\n**Container:** ${containerPick.label}\n**Results (${result._count} documents):**\n\`\`\`json\n${resultStr.slice(0, 8000)}\n\`\`\``,
                  'chat',
                );
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Azure: Cosmos DB query failed — ${msg}`);
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Cosmos DB query failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 13. Browse Storage ─────────────────────
    {
      id:    'aiForge.azure.browseStorage',
      title: 'Azure: Browse Storage',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('browse storage');
          const accounts = await client.listStorageAccounts();

          if (accounts.length === 0) {
            vscode.window.showInformationMessage('Azure: No Storage accounts found.');
            return;
          }

          const accountPick = await vscode.window.showQuickPick(
            accounts.map(a => ({
              label:       a.name,
              description: `${a.kind} | ${a.sku.name} | ${a.location}`,
              account:     a,
            })),
            { placeHolder: 'Select a Storage account' },
          );
          if (!accountPick) return;

          const containers = await client.listContainers(
            accountPick.account.resourceGroup,
            accountPick.account.name,
          );

          if (containers.length === 0) {
            vscode.window.showInformationMessage(`Azure: No containers found in ${accountPick.label}.`);
            return;
          }

          const containerPick = await vscode.window.showQuickPick(
            containers.map(c => ({
              label:       c.name,
              description: `Access: ${c.properties.publicAccess} | Modified: ${c.properties.lastModified}`,
              container:   c,
            })),
            { placeHolder: 'Select a container' },
          );
          if (!containerPick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Listing blobs in ${containerPick.label}...` },
            async () => {
              const blobs = await client.listBlobs(
                accountPick.account.name,
                containerPick.container.name,
              );

              if (blobs.length === 0) {
                vscode.window.showInformationMessage(`Azure: No blobs found in ${containerPick.label}.`);
                return;
              }

              const blobPick = await vscode.window.showQuickPick(
                blobs.slice(0, 50).map(b => ({
                  label:       b.name,
                  description: `${b.properties.contentType} | ${(b.properties.contentLength / 1024).toFixed(1)} KB`,
                  detail:      `Modified: ${b.properties.lastModified} | Type: ${b.properties.blobType}`,
                  blob:        b,
                })),
                { placeHolder: 'Select a blob to download to editor' },
              );
              if (!blobPick) return;

              try {
                const content = await client.downloadBlob(
                  accountPick.account.name,
                  containerPick.container.name,
                  blobPick.blob.name,
                );

                const doc = await vscode.workspace.openTextDocument({
                  content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
                  language: this._guessLanguage(blobPick.blob.name),
                });
                await vscode.window.showTextDocument(doc);
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Azure: Failed to download blob — ${msg}`);
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Browse storage failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 14. Deploy to Storage ─────────────────────
    {
      id:    'aiForge.azure.deployToStorage',
      title: 'Azure: Upload to Blob Storage',
      handler: async (services): Promise<void> => {
        try {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showWarningMessage('Azure: Open a file first.');
            return;
          }

          const client = this._requireClient('upload to storage');
          const accounts = await client.listStorageAccounts();

          if (accounts.length === 0) {
            vscode.window.showInformationMessage('Azure: No Storage accounts found.');
            return;
          }

          const accountPick = await vscode.window.showQuickPick(
            accounts.map(a => ({
              label:       a.name,
              description: `${a.kind} | ${a.location}`,
              account:     a,
            })),
            { placeHolder: 'Select a Storage account' },
          );
          if (!accountPick) return;

          const containers = await client.listContainers(
            accountPick.account.resourceGroup,
            accountPick.account.name,
          );

          if (containers.length === 0) {
            vscode.window.showInformationMessage(`Azure: No containers found in ${accountPick.label}.`);
            return;
          }

          const containerPick = await vscode.window.showQuickPick(
            containers.map(c => ({
              label:     c.name,
              container: c,
            })),
            { placeHolder: 'Select a container' },
          );
          if (!containerPick) return;

          const fileName = path.basename(editor.document.fileName);
          const blobName = await vscode.window.showInputBox({
            prompt:         'Blob name (path within container)',
            value:          fileName,
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Blob name is required',
          });
          if (!blobName) return;

          const confirm = await vscode.window.showWarningMessage(
            `Upload "${fileName}" to ${accountPick.label}/${containerPick.label}/${blobName}?`,
            { modal: true },
            'Upload',
          );
          if (confirm !== 'Upload') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Uploading...' },
            async () => {
              await client.uploadBlob(
                accountPick.account.name,
                containerPick.container.name,
                blobName.trim(),
                editor.document.getText(),
              );
              vscode.window.showInformationMessage(
                `Azure: Uploaded to ${accountPick.label}/${containerPick.label}/${blobName}`
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Upload failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 15. List Pipelines ─────────────────────
    {
      id:    'aiForge.azure.listPipelines',
      title: 'Azure: List DevOps Pipelines',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('list pipelines');

          const organization = await vscode.window.showInputBox({
            prompt:         'Azure DevOps organization name',
            placeHolder:    'my-org',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Organization is required',
          });
          if (!organization) return;

          const project = await vscode.window.showInputBox({
            prompt:         'Azure DevOps project name',
            placeHolder:    'my-project',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Project is required',
          });
          if (!project) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching pipelines...' },
            async () => {
              const pipelines = await client.listPipelines(organization.trim(), project.trim());

              if (pipelines.length === 0) {
                vscode.window.showInformationMessage('Azure: No pipelines found.');
                return;
              }

              // Fetch recent runs for each pipeline (first 5)
              const summaryParts: string[] = [];
              for (const p of pipelines.slice(0, 15)) {
                try {
                  const runs = await client.listPipelineRuns(organization.trim(), project.trim(), p.id);
                  const recentRun = runs[0];
                  const status = recentRun ? `Last: ${recentRun.result} (${recentRun.createdDate})` : 'No runs';
                  summaryParts.push(`- **${p.name}** (ID: ${p.id}): ${status}`);
                } catch {
                  summaryParts.push(`- **${p.name}** (ID: ${p.id}): Unable to fetch runs`);
                }
              }

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Azure DevOps pipelines. Highlight any with failures or that haven't run recently:\n\n${summaryParts.join('\n')}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: List pipelines failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 16. Analyze Pipeline Failure ─────────────────────
    {
      id:    'aiForge.azure.analyzePipelineFailure',
      title: 'Azure: Analyse Pipeline Failure',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('analyse pipeline failure');

          const organization = await vscode.window.showInputBox({
            prompt:         'Azure DevOps organization name',
            placeHolder:    'my-org',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Organization is required',
          });
          if (!organization) return;

          const project = await vscode.window.showInputBox({
            prompt:         'Azure DevOps project name',
            placeHolder:    'my-project',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Project is required',
          });
          if (!project) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching pipelines...' },
            async () => {
              const pipelines = await client.listPipelines(organization.trim(), project.trim());

              if (pipelines.length === 0) {
                vscode.window.showInformationMessage('Azure: No pipelines found.');
                return;
              }

              const pipelinePick = await vscode.window.showQuickPick(
                pipelines.map(p => ({
                  label:    p.name,
                  detail:   `ID: ${p.id} | Folder: ${p.folder}`,
                  pipeline: p,
                })),
                { placeHolder: 'Select a pipeline to analyse' },
              );
              if (!pipelinePick) return;

              const runs = await client.listPipelineRuns(
                organization.trim(), project.trim(), pipelinePick.pipeline.id,
              );
              const failedRuns = runs.filter(r => r.result === 'failed');

              if (failedRuns.length === 0) {
                vscode.window.showInformationMessage(`Azure: No failed runs found for "${pipelinePick.label}".`);
                return;
              }

              const runPick = await vscode.window.showQuickPick(
                failedRuns.map(r => ({
                  label:       `Run #${r.id}`,
                  description: `${r.result} — ${r.createdDate}`,
                  detail:      r.finishedDate ? `Finished: ${r.finishedDate}` : 'Still running',
                  run:         r,
                })),
                { placeHolder: 'Select a failed run to analyse' },
              );
              if (!runPick) return;

              const diagnosticData = [
                `## Pipeline Failure Analysis`,
                '',
                `**Pipeline:** ${pipelinePick.label} (ID: ${pipelinePick.pipeline.id})`,
                `**Run:** #${runPick.run.id}`,
                `**State:** ${runPick.run.state}`,
                `**Result:** ${runPick.run.result}`,
                `**Started:** ${runPick.run.createdDate}`,
                runPick.run.finishedDate ? `**Finished:** ${runPick.run.finishedDate}` : '',
                `**URL:** ${runPick.run.url}`,
              ].filter(Boolean).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Diagnose this Azure DevOps pipeline failure. Suggest common causes and fixes based on the pipeline configuration:\n\n${diagnosticData}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Pipeline failure analysis failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 17. List Web Apps ─────────────────────
    {
      id:    'aiForge.azure.listWebApps',
      title: 'Azure: List Web Apps',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching Web Apps...' },
          async () => {
            try {
              const client = this._requireClient('list web apps');
              const apps = await client.listWebApps();

              if (apps.length === 0) {
                vscode.window.showInformationMessage('Azure: No Web Apps found in this subscription.');
                return;
              }

              const summary = apps.map(a =>
                `- **${a.name}** [${a.state}]: ${a.kind}, ${a.location}, host: ${a.defaultHostName}`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Azure App Service Web Apps. Highlight any that are stopped, may need scaling, or have configuration concerns:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Failed to list Web Apps — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 18. Restart Web App ─────────────────────
    {
      id:    'aiForge.azure.restartWebApp',
      title: 'Azure: Restart Web App',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('restart web app');
          const apps = await client.listWebApps();

          if (apps.length === 0) {
            vscode.window.showInformationMessage('Azure: No Web Apps found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            apps.map(a => ({
              label:       a.name,
              description: `[${a.state}] ${a.location}`,
              detail:      `Resource Group: ${a.resourceGroup} | Host: ${a.defaultHostName}`,
              app:         a,
            })),
            { placeHolder: 'Select a Web App to restart' },
          );
          if (!pick) return;

          const confirm = await vscode.window.showWarningMessage(
            `Restart Web App "${pick.label}"?`,
            { modal: true },
            'Restart',
          );
          if (confirm !== 'Restart') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Azure: Restarting ${pick.label}...` },
            async () => {
              await client.restartWebApp(pick.app.resourceGroup, pick.app.name);
              vscode.window.showInformationMessage(
                `Azure: Web App "${pick.label}" restarted successfully.`
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Restart failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 19. Query Logs (KQL) ─────────────────────
    {
      id:    'aiForge.azure.queryLogs',
      title: 'Azure: Query Log Analytics (KQL)',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('query logs');

          const workspaceId = await vscode.window.showInputBox({
            prompt:         'Log Analytics Workspace ID',
            placeHolder:    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Workspace ID is required',
          });
          if (!workspaceId) return;

          const query = await vscode.window.showInputBox({
            prompt:         'KQL query',
            placeHolder:    'AppExceptions | take 50',
            value:          'AppExceptions | take 50',
            ignoreFocusOut: true,
            validateInput:  (v) => v.trim() ? null : 'Query is required',
          });
          if (!query) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Azure: Executing KQL query...' },
            async () => {
              try {
                const result = await client.queryLogs(workspaceId.trim(), query.trim());

                if (!result.tables || result.tables.length === 0) {
                  vscode.window.showInformationMessage('Azure: Query returned no results.');
                  return;
                }

                const table = result.tables[0];
                const columns = table.columns.map(c => c.name).join(' | ');
                const rows = table.rows.slice(0, 30).map(r =>
                  (r as unknown[]).map(v => String(v).slice(0, 100)).join(' | ')
                ).join('\n');

                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `Analyse these Log Analytics query results. Identify patterns, anomalies, and suggest follow-up queries:\n\n**Query:** \`${query}\`\n\n**Columns:** ${columns}\n\n**Results (${table.rows.length} rows):**\n\`\`\`\n${rows.slice(0, 8000)}\n\`\`\``,
                  'chat',
                );
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Azure: KQL query failed — ${msg}`);
              }
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Azure: Query logs failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 20. List Alerts ─────────────────────
    {
      id:    'aiForge.azure.listAlerts',
      title: 'Azure: List Active Alerts',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Fetching alerts...' },
          async () => {
            try {
              const client = this._requireClient('list alerts');
              const alerts = await client.listAlerts();

              if (alerts.length === 0) {
                vscode.window.showInformationMessage('Azure: No active alerts found.');
                return;
              }

              const summary = alerts.map(a =>
                `- **${a.name}** [Severity: ${a.properties.severity}]: ${a.properties.alertState} — ${a.properties.description ?? 'No description'} (since ${a.properties.startDateTime})`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these active Azure alerts. Explain each alert, its impact, and suggest remediation steps:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Azure: Failed to list alerts — ${msg}`);
            }
          }
        );
      },
    },
  ];

  // ── Helper: guess language for blob content ─────────────────────────────

  private _guessLanguage(blobName: string): string {
    const ext = path.extname(blobName).toLowerCase();
    const map: Record<string, string> = {
      '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
      '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
      '.cs': 'csharp', '.html': 'html', '.css': 'css', '.sql': 'sql',
      '.md': 'markdown', '.txt': 'plaintext', '.csv': 'plaintext',
      '.bicep': 'bicep', '.tf': 'terraform', '.sh': 'shellscript',
    };
    return map[ext] ?? 'plaintext';
  }

  // ── statusItem ──────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      if (this._connected) {
        return `$(cloud-upload) Azure: ${this._subscriptionName}`;
      }
      return '$(cloud) Azure: Disconnected';
    },
  };
}
