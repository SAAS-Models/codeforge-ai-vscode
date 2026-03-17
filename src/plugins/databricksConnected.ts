/**
 * plugins/databricksConnected.ts — Databricks Connected plugin for Evolve AI
 *
 * Activates alongside the base Databricks plugin when the workspace contains
 * Databricks markers AND API credentials are configured (.databrickscfg,
 * .databricks-connect, or DATABRICKS_HOST/DATABRICKS_TOKEN env vars).
 *
 * Contributes:
 *  - contextHooks      : live cluster status, recent failures, Unity Catalog schemas
 *  - systemPromptSection: connected-workspace knowledge + current workspace info
 *  - codeLensActions    : Explore in Unity Catalog, Run SQL
 *  - commands (15)      : connect, disconnect, status, clusters, jobs, notebooks,
 *                         Unity Catalog, SQL execution, DLT pipeline management
 *  - statusItem         : shows connection status + workspace host
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

// ── Detection markers (same as base Databricks plugin) ───────────────────────

const DATABRICKS_MARKERS = [
  '.databricks',
  'databricks.yml',
  'databricks.yaml',
  '.databrickscfg',
  'bundle.yml',
  'bundle.yaml',
];

const PYSPARK_IMPORT = /from pyspark|import pyspark|SparkSession|spark\s*=\s*SparkSession/;

function findMarker(wsPath: string): string | null {
  for (const marker of DATABRICKS_MARKERS) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

function hasCredentialMarkers(wsPath: string): boolean {
  // Check for local credential config files
  if (fs.existsSync(path.join(wsPath, '.databricks-connect'))) return true;
  if (fs.existsSync(path.join(wsPath, '.databrickscfg'))) return true;
  // Check home directory for global config
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && fs.existsSync(path.join(home, '.databrickscfg'))) return true;
  // Check environment variables
  if (process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN) return true;
  return false;
}

function hasPySparkInRequirements(wsPath: string): boolean {
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      const content = fs.readFileSync(f, 'utf8');
      if (/pyspark|databricks-connect|databricks-sdk/i.test(content)) return true;
    }
  }
  return false;
}

// ── Databricks REST API client ───────────────────────────────────────────────

interface DatabricksCluster {
  cluster_id: string;
  cluster_name: string;
  state: string;
  spark_version: string;
  num_workers?: number;
  autoscale?: { min_workers: number; max_workers: number };
  node_type_id?: string;
  driver_node_type_id?: string;
  creator_user_name?: string;
}

interface DatabricksJob {
  job_id: number;
  settings: {
    name: string;
    tasks?: Array<{ task_key: string; description?: string }>;
    schedule?: { quartz_cron_expression: string; timezone_id: string };
  };
  creator_user_name?: string;
}

interface DatabricksJobRun {
  run_id: number;
  run_name: string;
  state: {
    life_cycle_state: string;
    result_state?: string;
    state_message?: string;
  };
  start_time: number;
  end_time?: number;
  job_id: number;
  tasks?: Array<{
    task_key: string;
    state: { life_cycle_state: string; result_state?: string };
  }>;
}

interface DatabricksRunOutput {
  error?: string;
  error_trace?: string;
  metadata?: { run_id: number; job_id: number };
  notebook_output?: { result?: string; truncated?: boolean };
}

interface CatalogInfo {
  name: string;
  comment?: string;
  owner?: string;
}

interface SchemaInfo {
  name: string;
  catalog_name: string;
  comment?: string;
}

interface TableInfo {
  name: string;
  catalog_name: string;
  schema_name: string;
  table_type: string;
  columns?: Array<{ name: string; type_text: string; comment?: string; nullable?: boolean }>;
  comment?: string;
}

interface SQLStatement {
  statement_id: string;
  status: { state: string; error?: { message: string } };
  manifest?: { schema: { columns: Array<{ name: string; type_text: string }> } };
  result?: { data_array?: string[][] };
}

interface DLTPipeline {
  pipeline_id: string;
  name: string;
  state: string;
  creator_user_name?: string;
  catalog?: string;
  target?: string;
}

interface WorkspaceObject {
  path: string;
  object_type: string;
  object_id?: number;
  language?: string;
}

/** Lightweight Databricks REST client. All methods throw on HTTP errors. */
class DatabricksClient {
  constructor(
    private readonly host: string,
    private readonly token: string,
  ) {
    // Normalise host: ensure no trailing slash, ensure https://
    this.host = host.replace(/\/+$/, '');
    if (!this.host.startsWith('https://') && !this.host.startsWith('http://')) {
      this.host = `https://${this.host}`;
    }
  }

  get workspaceHost(): string { return this.host; }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = `${this.host}/api/2.1${apiPath}`;
    const https = await import('https');
    const http  = await import('http');
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    return new Promise<T>((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type':  'application/json',
          'User-Agent':    'AI-Forge-VSCode/1.0',
        },
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Databricks API ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : ({} as T));
          } catch {
            reject(new Error(`Invalid JSON from Databricks API: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Databricks API request timed out')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private get<T>(apiPath: string): Promise<T> { return this.request<T>('GET', apiPath); }
  private post<T>(apiPath: string, body: unknown): Promise<T> { return this.request<T>('POST', apiPath, body); }

  // ── Connection test ──────────────────────────────────────────────────────

  async testConnection(): Promise<{ host: string; user: string }> {
    const me = await this.get<{ user_name: string }>('/preview/scim/v2/Me');
    return { host: this.host, user: me.user_name ?? 'unknown' };
  }

  // ── Clusters ─────────────────────────────────────────────────────────────

  async listClusters(): Promise<DatabricksCluster[]> {
    const resp = await this.get<{ clusters?: DatabricksCluster[] }>('/clusters/list');
    return resp.clusters ?? [];
  }

  async getCluster(clusterId: string): Promise<DatabricksCluster> {
    return this.get<DatabricksCluster>(`/clusters/get?cluster_id=${encodeURIComponent(clusterId)}`);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  async listJobs(limit = 25): Promise<DatabricksJob[]> {
    const resp = await this.get<{ jobs?: DatabricksJob[] }>(`/jobs/list?limit=${limit}&expand_tasks=true`);
    return resp.jobs ?? [];
  }

  async runJob(jobId: number): Promise<{ run_id: number }> {
    return this.post<{ run_id: number }>('/jobs/run-now', { job_id: jobId });
  }

  async listJobRuns(jobId?: number, limit = 20): Promise<DatabricksJobRun[]> {
    let qs = `?limit=${limit}&expand_tasks=true`;
    if (jobId) qs += `&job_id=${jobId}`;
    const resp = await this.get<{ runs?: DatabricksJobRun[] }>(`/jobs/runs/list${qs}`);
    return resp.runs ?? [];
  }

  async getRunOutput(runId: number): Promise<DatabricksRunOutput> {
    return this.get<DatabricksRunOutput>(`/jobs/runs/get-output?run_id=${runId}`);
  }

  async getJob(jobId: number): Promise<DatabricksJob> {
    return this.get<DatabricksJob>(`/jobs/get?job_id=${jobId}`);
  }

  async createJob(settings: unknown): Promise<{ job_id: number }> {
    return this.post<{ job_id: number }>('/jobs/create', settings);
  }

  // ── Unity Catalog ────────────────────────────────────────────────────────

  async listCatalogs(): Promise<CatalogInfo[]> {
    const resp = await this.get<{ catalogs?: CatalogInfo[] }>('/unity-catalog/catalogs');
    return resp.catalogs ?? [];
  }

  async listSchemas(catalogName: string): Promise<SchemaInfo[]> {
    const resp = await this.get<{ schemas?: SchemaInfo[] }>(
      `/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalogName)}`
    );
    return resp.schemas ?? [];
  }

  async listTables(catalogName: string, schemaName: string): Promise<TableInfo[]> {
    const resp = await this.get<{ tables?: TableInfo[] }>(
      `/unity-catalog/tables?catalog_name=${encodeURIComponent(catalogName)}&schema_name=${encodeURIComponent(schemaName)}`
    );
    return resp.tables ?? [];
  }

  async getTable(fullName: string): Promise<TableInfo> {
    return this.get<TableInfo>(`/unity-catalog/tables/${encodeURIComponent(fullName)}`);
  }

  // ── SQL Execution ────────────────────────────────────────────────────────

  async listWarehouses(): Promise<Array<{ id: string; name: string; state: string }>> {
    const resp = await this.get<{ warehouses?: Array<{ id: string; name: string; state: string }> }>(
      '/sql/warehouses'
    );
    return resp.warehouses ?? [];
  }

  async executeSQL(warehouseId: string, sql: string): Promise<SQLStatement> {
    return this.post<SQLStatement>('/sql/statements', {
      warehouse_id: warehouseId,
      statement:    sql,
      wait_timeout: '30s',
    });
  }

  // ── Workspace / Notebooks ────────────────────────────────────────────────

  async listWorkspace(wsPath: string): Promise<WorkspaceObject[]> {
    const resp = await this.get<{ objects?: WorkspaceObject[] }>(
      `/workspace/list?path=${encodeURIComponent(wsPath)}`
    );
    return resp.objects ?? [];
  }

  async exportNotebook(wsPath: string): Promise<string> {
    const resp = await this.get<{ content: string }>(
      `/workspace/export?path=${encodeURIComponent(wsPath)}&format=SOURCE`
    );
    return Buffer.from(resp.content, 'base64').toString('utf8');
  }

  async importNotebook(wsPath: string, content: string, language: string, overwrite = false): Promise<void> {
    await this.post('/workspace/import', {
      path:      wsPath,
      content:   Buffer.from(content).toString('base64'),
      language:  language.toUpperCase(),
      format:    'SOURCE',
      overwrite,
    });
  }

  // ── DLT Pipelines ───────────────────────────────────────────────────────

  async listPipelines(): Promise<DLTPipeline[]> {
    const resp = await this.get<{ statuses?: DLTPipeline[] }>('/pipelines');
    return resp.statuses ?? [];
  }

  async getPipeline(pipelineId: string): Promise<DLTPipeline & { spec?: unknown }> {
    return this.get<DLTPipeline & { spec?: unknown }>(`/pipelines/${encodeURIComponent(pipelineId)}`);
  }

  async startPipeline(pipelineId: string): Promise<void> {
    await this.post(`/pipelines/${encodeURIComponent(pipelineId)}/updates`, { full_refresh: false });
  }

  async stopPipeline(pipelineId: string): Promise<void> {
    await this.post(`/pipelines/${encodeURIComponent(pipelineId)}/stop`, {});
  }
}

// ── Cached data shape ────────────────────────────────────────────────────────

interface ConnectedContextData {
  host: string;
  user: string;
  clusters: Array<{ name: string; state: string; sparkVersion: string }>;
  recentFailures: Array<{ jobName: string; runId: number; error: string; time: string }>;
  catalogs: string[];
  schemas: string[];
}

// ── The plugin ───────────────────────────────────────────────────────────────

const SECRET_HOST  = 'databricks-host';
const SECRET_TOKEN = 'databricks-token';
const CACHE_TTL_MS = 60_000; // 60 seconds

export class DatabricksConnectedPlugin implements IPlugin {
  readonly id          = 'databricks-connected';
  readonly displayName = 'Databricks Connected';
  readonly icon        = '$(cloud-upload)';

  private _client: DatabricksClient | null = null;
  private _connected = false;
  private _host      = '';
  private _user      = '';
  private _wsPath    = '';

  // Cache for context data
  private _cachedContext: ConnectedContextData | null = null;
  private _cacheTimestamp = 0;

  // ── detect ──────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Must be a Databricks workspace (same markers as base plugin)
    const hasMarker = !!findMarker(wsPath) || hasPySparkInRequirements(wsPath);
    if (!hasMarker) {
      // Quick scan for PySpark imports
      const pyFiles = this._scanPyFiles(wsPath, 30);
      let found = false;
      for (const f of pyFiles) {
        try {
          const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
          if (PYSPARK_IMPORT.test(sample)) { found = true; break; }
        } catch { /* skip */ }
      }
      if (!found) return false;
    }

    // Additionally check for credential markers (config files or env vars)
    return hasCredentialMarkers(wsPath);
  }

  private _scanPyFiles(dir: string, max: number): string[] {
    const results: string[] = [];
    const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv']);
    const walk = (d: string) => {
      if (results.length >= max) return;
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (SKIP.has(entry.name)) continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.py$/.test(entry.name)) results.push(full);
        }
      } catch { /* skip unreadable dirs */ }
    };
    walk(dir);
    return results;
  }

  // ── activate ────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Try to initialise client from stored secrets
    const host  = await services.ai.getSecret(SECRET_HOST);
    const token = await services.ai.getSecret(SECRET_TOKEN);

    if (host && token) {
      try {
        this._client = new DatabricksClient(host, token);
        const info = await this._client.testConnection();
        this._connected = true;
        this._host = info.host;
        this._user = info.user;
        console.log(`[Evolve AI] Databricks Connected: ${this._host} as ${this._user}`);
      } catch (e) {
        console.warn(`[Evolve AI] Databricks Connected: stored credentials invalid — ${e}`);
        this._client = null;
        this._connected = false;
        vscode.window.showWarningMessage(
          'Databricks Connected: stored credentials are invalid or expired. Use "Databricks: Connect" to reconfigure.',
          'Connect Now',
        ).then(choice => {
          if (choice === 'Connect Now') {
            vscode.commands.executeCommand('aiForge.databricks.connect');
          }
        });
      }
    } else {
      // Try environment variables
      const envHost  = process.env.DATABRICKS_HOST;
      const envToken = process.env.DATABRICKS_TOKEN;
      if (envHost && envToken) {
        try {
          this._client = new DatabricksClient(envHost, envToken);
          const info = await this._client.testConnection();
          this._connected = true;
          this._host = info.host;
          this._user = info.user;
          // Persist to SecretStorage for future sessions
          await services.ai.storeSecret(SECRET_HOST, envHost);
          await services.ai.storeSecret(SECRET_TOKEN, envToken);
          console.log(`[Evolve AI] Databricks Connected (env): ${this._host} as ${this._user}`);
        } catch (e) {
          console.warn(`[Evolve AI] Databricks Connected: env credentials invalid — ${e}`);
          this._client = null;
          this._connected = false;
        }
      }

      if (!this._connected) {
        vscode.window.showInformationMessage(
          'Databricks Connected plugin detected a Databricks workspace. Configure API credentials to enable live features.',
          'Connect Now',
        ).then(choice => {
          if (choice === 'Connect Now') {
            vscode.commands.executeCommand('aiForge.databricks.connect');
          }
        });
      }
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
      // Fetch cluster status
      const clusters = await this._client.listClusters();
      const clusterSummary = clusters.slice(0, 5).map(c => ({
        name:         c.cluster_name,
        state:        c.state,
        sparkVersion: c.spark_version,
      }));

      // Fetch recent failed runs
      const runs = await this._client.listJobRuns(undefined, 20);
      const failedRuns = runs
        .filter(r => r.state.result_state === 'FAILED')
        .slice(0, 3)
        .map(r => ({
          jobName: r.run_name || `Job ${r.job_id}`,
          runId:   r.run_id,
          error:   r.state.state_message ?? 'Unknown error',
          time:    new Date(r.start_time).toISOString(),
        }));

      // Fetch Unity Catalog catalogs
      let catalogs: string[] = [];
      let schemas: string[] = [];
      try {
        const catList = await this._client.listCatalogs();
        catalogs = catList.map(c => c.name);
        // Fetch schemas from the first catalog for context
        if (catalogs.length > 0) {
          const schList = await this._client.listSchemas(catalogs[0]);
          schemas = schList.map(s => `${s.catalog_name}.${s.name}`);
        }
      } catch {
        // Unity Catalog may not be available on all workspaces
      }

      this._cachedContext = {
        host:           this._host,
        user:           this._user,
        clusters:       clusterSummary,
        recentFailures: failedRuns,
        catalogs,
        schemas,
      };
      this._cacheTimestamp = now;
      return this._cachedContext;
    } catch (e) {
      console.warn(`[Evolve AI] Databricks Connected context fetch failed: ${e}`);
      return this._cachedContext; // return stale cache if available
    }
  }

  // ── contextHooks ────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'databricks-live',

      collect: async (_ws): Promise<ConnectedContextData | null> => {
        return this._fetchContextData();
      },

      format(data: unknown): string {
        const d = data as ConnectedContextData | null;
        if (!d) return '';

        const lines = [`## Databricks Live Workspace (${d.host})`];
        lines.push(`**User:** ${d.user}`);

        if (d.clusters.length > 0) {
          lines.push('\n### Active Clusters');
          for (const c of d.clusters) {
            lines.push(`- **${c.name}**: ${c.state} (Spark ${c.sparkVersion})`);
          }
        }

        if (d.recentFailures.length > 0) {
          lines.push('\n### Recent Job Failures');
          for (const f of d.recentFailures) {
            lines.push(`- **${f.jobName}** (run ${f.runId}, ${f.time}): ${f.error.slice(0, 200)}`);
          }
        }

        if (d.catalogs.length > 0) {
          lines.push(`\n### Unity Catalog: ${d.catalogs.join(', ')}`);
          if (d.schemas.length > 0) {
            lines.push(`**Schemas:** ${d.schemas.slice(0, 10).join(', ')}${d.schemas.length > 10 ? '...' : ''}`);
          }
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ─────────────────────────────────────────────────

  systemPromptSection(): string {
    const base = `
## Databricks Connected Workspace

You have access to a live Databricks workspace. The user can ask you to:
- Check cluster status, start/stop clusters
- List, run, and analyse jobs and their failures
- Browse Unity Catalog (catalogs, schemas, tables, columns)
- Execute SQL queries on SQL warehouses and analyse results
- Import/export notebooks between local editor and Databricks workspace
- Manage Delta Live Tables pipelines (list, start, stop, inspect)
- Design and create new workflow/job configurations via the API

When the user asks about their Databricks environment, use the live data available in context.
When suggesting fixes for failed jobs, be specific — reference the actual error message and job config.
When exploring data, suggest queries that leverage Unity Catalog 3-part names.
`.trim();

    if (this._connected) {
      return `${base}\n\n**Current workspace:** ${this._host}\n**Authenticated as:** ${this._user}`;
    }
    return `${base}\n\n_Credentials not yet configured. The user should run "Databricks: Connect" to enable live features._`;
  }

  // ── codeLensActions ─────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(search) Explore in Unity Catalog',
      command:     'aiForge.databricks.exploreCatalog',
      linePattern: /\b\w+\.\w+\.\w+\b/,  // matches catalog.schema.table references
      languages:   ['python', 'sql'],
      tooltip:     'Look up this table in Unity Catalog',
    },
    {
      title:       '$(play) Run SQL',
      command:     'aiForge.databricks.runSQL',
      linePattern: /spark\.sql\(|SELECT\s+|INSERT\s+|MERGE\s+|CREATE\s+|ALTER\s+/i,
      languages:   ['python', 'sql'],
      tooltip:     'Execute this SQL on a Databricks SQL warehouse',
    },
  ];

  // ── Helper: ensure connected ────────────────────────────────────────────

  private _requireClient(action: string): DatabricksClient {
    if (!this._client || !this._connected) {
      vscode.window.showWarningMessage(
        `Databricks: Not connected. Run "Databricks: Connect" first.`,
        'Connect Now',
      ).then(choice => {
        if (choice === 'Connect Now') {
          vscode.commands.executeCommand('aiForge.databricks.connect');
        }
      });
      throw new Error(`Databricks not connected — cannot ${action}`);
    }
    return this._client;
  }

  // ── commands (15) ───────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [

    // ───────────────────── 1. Connect ─────────────────────
    {
      id:    'aiForge.databricks.connect',
      title: 'Databricks: Connect to Workspace',
      handler: async (services): Promise<void> => {
        const host = await vscode.window.showInputBox({
          prompt:      'Databricks workspace URL (e.g. https://adb-1234567890.12.azuredatabricks.net)',
          placeHolder: 'https://your-workspace.cloud.databricks.com',
          ignoreFocusOut: true,
          validateInput: (v) => {
            if (!v.trim()) return 'Host is required';
            if (!/^https?:\/\//.test(v) && !v.includes('.')) return 'Enter a valid URL or hostname';
            return null;
          },
        });
        if (!host) return;

        const token = await vscode.window.showInputBox({
          prompt:      'Databricks personal access token',
          placeHolder: 'dapi...',
          password:    true,
          ignoreFocusOut: true,
          validateInput: (v) => v.trim() ? null : 'Token is required',
        });
        if (!token) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Databricks: Testing connection…' },
          async () => {
            try {
              const client = new DatabricksClient(host.trim(), token.trim());
              const info = await client.testConnection();

              await services.ai.storeSecret(SECRET_HOST, host.trim());
              await services.ai.storeSecret(SECRET_TOKEN, token.trim());

              this._client = client;
              this._connected = true;
              this._host = info.host;
              this._user = info.user;
              this._cachedContext = null;
              this._cacheTimestamp = 0;

              vscode.window.showInformationMessage(
                `Databricks: Connected to ${info.host} as ${info.user}`
              );
              services.events.emit('ui.status.update', {});
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Databricks: Connection failed — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 2. Disconnect ─────────────────────
    {
      id:    'aiForge.databricks.disconnect',
      title: 'Databricks: Disconnect',
      handler: async (services): Promise<void> => {
        await services.ai.storeSecret(SECRET_HOST, '');
        await services.ai.storeSecret(SECRET_TOKEN, '');
        this._client = null;
        this._connected = false;
        this._host = '';
        this._user = '';
        this._cachedContext = null;
        this._cacheTimestamp = 0;
        vscode.window.showInformationMessage('Databricks: Disconnected. Credentials cleared.');
        services.events.emit('ui.status.update', {});
      },
    },

    // ───────────────────── 3. Status ─────────────────────
    {
      id:    'aiForge.databricks.status',
      title: 'Databricks: Connection Status',
      handler: async (services): Promise<void> => {
        if (!this._connected || !this._client) {
          vscode.window.showInformationMessage(
            'Databricks: Not connected.',
            'Connect Now',
          ).then(choice => {
            if (choice === 'Connect Now') {
              vscode.commands.executeCommand('aiForge.databricks.connect');
            }
          });
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Databricks: Fetching workspace info…' },
          async () => {
            try {
              const client = this._requireClient('get status');
              const [clusters, jobs] = await Promise.all([
                client.listClusters(),
                client.listJobs(100),
              ]);

              const running  = clusters.filter(c => c.state === 'RUNNING').length;
              const total    = clusters.length;
              const jobCount = jobs.length;

              const msg = [
                `**Workspace:** ${this._host}`,
                `**User:** ${this._user}`,
                `**Clusters:** ${running} running / ${total} total`,
                `**Jobs:** ${jobCount}`,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Summarise this Databricks workspace status and highlight anything noteworthy:\n\n${msg}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Databricks status failed: ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 4. List Clusters ─────────────────────
    {
      id:    'aiForge.databricks.listClusters',
      title: 'Databricks: List Clusters',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Databricks: Fetching clusters…' },
          async () => {
            try {
              const client = this._requireClient('list clusters');
              const clusters = await client.listClusters();

              if (clusters.length === 0) {
                vscode.window.showInformationMessage('Databricks: No clusters found.');
                return;
              }

              const summary = clusters.map(c => {
                const workers = c.autoscale
                  ? `${c.autoscale.min_workers}-${c.autoscale.max_workers} workers (autoscale)`
                  : `${c.num_workers ?? 0} workers`;
                return `- **${c.cluster_name}** [${c.state}]: ${c.spark_version}, ${workers}, node: ${c.node_type_id ?? 'default'}`;
              }).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse these Databricks clusters. Highlight any that are idle but running (wasting cost), undersized, or using outdated Spark versions:\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Databricks: Failed to list clusters — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 5. Cluster Info ─────────────────────
    {
      id:    'aiForge.databricks.clusterInfo',
      title: 'Databricks: Cluster Details & Optimization',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get cluster info');
          const clusters = await client.listClusters();

          if (clusters.length === 0) {
            vscode.window.showInformationMessage('Databricks: No clusters found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            clusters.map(c => ({
              label:       c.cluster_name,
              description: `[${c.state}] ${c.spark_version}`,
              detail:      `ID: ${c.cluster_id} | Creator: ${c.creator_user_name ?? 'unknown'}`,
              clusterId:   c.cluster_id,
            })),
            { placeHolder: 'Select a cluster to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Databricks: Fetching ${pick.label}…` },
            async () => {
              const detail = await client.getCluster(pick.clusterId);
              const configJson = JSON.stringify(detail, null, 2);

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyse this Databricks cluster configuration. Suggest optimisations for cost and performance (instance types, autoscaling, Spark config, Photon, etc.):\n\n\`\`\`json\n${configJson}\n\`\`\``,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Cluster info failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 6. List Jobs ─────────────────────
    {
      id:    'aiForge.databricks.listJobs',
      title: 'Databricks: List Jobs',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Databricks: Fetching jobs…' },
          async () => {
            try {
              const client = this._requireClient('list jobs');
              const jobs = await client.listJobs(50);

              if (jobs.length === 0) {
                vscode.window.showInformationMessage('Databricks: No jobs found.');
                return;
              }

              const summary = jobs.map(j => {
                const tasks  = j.settings.tasks?.map(t => t.task_key).join(', ') ?? 'none';
                const sched  = j.settings.schedule
                  ? `Schedule: ${j.settings.schedule.quartz_cron_expression} (${j.settings.schedule.timezone_id})`
                  : 'No schedule';
                return `- **${j.settings.name}** (ID: ${j.job_id}): Tasks=[${tasks}] | ${sched}`;
              }).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Here are the Databricks jobs in the workspace. Summarise them and note any that might need attention (no schedule, too many tasks, etc.):\n\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`Databricks: Failed to list jobs — ${msg}`);
            }
          }
        );
      },
    },

    // ───────────────────── 7. Run Job ─────────────────────
    {
      id:    'aiForge.databricks.runJob',
      title: 'Databricks: Run Job',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('run job');
          const jobs = await client.listJobs(50);

          if (jobs.length === 0) {
            vscode.window.showInformationMessage('Databricks: No jobs found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            jobs.map(j => ({
              label:       j.settings.name,
              description: `ID: ${j.job_id}`,
              detail:      j.settings.tasks?.map(t => t.task_key).join(', ') ?? '',
              jobId:       j.job_id,
            })),
            { placeHolder: 'Select a job to run' },
          );
          if (!pick) return;

          const confirm = await vscode.window.showWarningMessage(
            `Run job "${pick.label}" (ID: ${pick.jobId})?`,
            { modal: true },
            'Run',
          );
          if (confirm !== 'Run') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Databricks: Starting ${pick.label}…` },
            async () => {
              const result = await client.runJob(pick.jobId);
              vscode.window.showInformationMessage(
                `Databricks: Job "${pick.label}" started. Run ID: ${result.run_id}`
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Run job failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 8. Analyze Failure (killer feature) ─────────────────────
    {
      id:    'aiForge.databricks.analyzeFailure',
      title: 'Databricks: Analyse Failed Job Run',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('analyse failure');

          // Fetch recent runs and filter to failed ones
          const allRuns = await client.listJobRuns(undefined, 50);
          const failedRuns = allRuns.filter(r => r.state.result_state === 'FAILED');

          if (failedRuns.length === 0) {
            vscode.window.showInformationMessage('Databricks: No recent failed job runs found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            failedRuns.map(r => ({
              label:       r.run_name || `Run ${r.run_id}`,
              description: `Job ${r.job_id} | ${new Date(r.start_time).toLocaleString()}`,
              detail:      r.state.state_message?.slice(0, 120) ?? 'No error message',
              runId:       r.run_id,
              jobId:       r.job_id,
            })),
            { placeHolder: 'Select a failed run to analyse' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Databricks: Fetching failure details…', cancellable: false },
            async () => {
              // Fetch run output (error + stack trace)
              const output = await client.getRunOutput(pick.runId);

              // Fetch the job config for context
              let jobConfig: DatabricksJob | null = null;
              try {
                jobConfig = await client.getJob(pick.jobId);
              } catch { /* job may have been deleted */ }

              const errorText   = output.error ?? 'No error captured';
              const stackTrace  = output.error_trace ?? '';
              const jobName     = jobConfig?.settings?.name ?? `Job ${pick.jobId}`;
              const tasksInfo   = jobConfig?.settings?.tasks
                ?.map(t => `  - ${t.task_key}${t.description ? `: ${t.description}` : ''}`)
                .join('\n') ?? '  (no task details)';

              const prompt = `This Databricks job failed. Analyse the error, explain the root cause, and suggest a specific fix.

**Job:** ${jobName} (ID: ${pick.jobId})
**Run ID:** ${pick.runId}
**Tasks:**
${tasksInfo}

**Error message:**
\`\`\`
${errorText}
\`\`\`

${stackTrace ? `**Stack trace:**\n\`\`\`\n${stackTrace.slice(0, 3000)}\n\`\`\`` : ''}

Provide:
1. Root cause analysis — what exactly went wrong
2. The most likely fix (with code if applicable)
3. How to prevent this failure in the future
4. Any related Databricks best practices that apply`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Failure analysis failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 9. Design Workflow ─────────────────────
    {
      id:    'aiForge.databricks.designWorkflow',
      title: 'Databricks: Design Workflow with AI',
      handler: async (services): Promise<void> => {
        const description = await vscode.window.showInputBox({
          prompt:      'Describe the workflow you want (e.g. "nightly ETL from S3, transform with Spark, load to Delta, run at 2am")',
          placeHolder: 'Describe your workflow…',
          ignoreFocusOut: true,
        });
        if (!description) return;

        // Gather workspace info for context
        let clusterInfo = '';
        if (this._client && this._connected) {
          try {
            const clusters = await this._client.listClusters();
            if (clusters.length > 0) {
              clusterInfo = `\n\nAvailable clusters: ${clusters.map(c => `${c.cluster_name} (${c.spark_version})`).join(', ')}`;
            }
          } catch { /* ignore */ }
        }

        const prompt = `Design a complete Databricks Job/Workflow configuration for this requirement:

"${description}"
${clusterInfo}

Generate a complete Databricks Asset Bundle job YAML (databricks.yml format) that includes:
- Job name and description
- All required tasks with proper dependencies (depends_on)
- Cluster configuration (use job clusters for cost efficiency)
- Task parameters
- Schedule (cron expression) if a schedule was mentioned
- Email notifications on failure
- Retry policy for flaky tasks
- Separate dev/prod targets

Also explain:
1. Why you structured the tasks this way
2. Any performance considerations
3. Cost optimisation tips

${this._connected ? 'The user has a live Databricks workspace — offer to create this job via the API after review.' : ''}`;

        await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
      },
    },

    // ───────────────────── 10. Browse Notebooks ─────────────────────
    {
      id:    'aiForge.databricks.browseNotebooks',
      title: 'Databricks: Browse & Import Notebook',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('browse notebooks');

          // Start at workspace root
          let currentPath = '/';
          let selectedNotebook: WorkspaceObject | null = null;

          // Drill-down navigation
          while (!selectedNotebook) {
            const objects = await client.listWorkspace(currentPath);

            if (objects.length === 0) {
              vscode.window.showInformationMessage(`Databricks: No objects in ${currentPath}`);
              return;
            }

            const items = objects
              .sort((a, b) => {
                // Directories first, then notebooks
                if (a.object_type === 'DIRECTORY' && b.object_type !== 'DIRECTORY') return -1;
                if (a.object_type !== 'DIRECTORY' && b.object_type === 'DIRECTORY') return 1;
                return a.path.localeCompare(b.path);
              })
              .map(o => ({
                label:       o.object_type === 'DIRECTORY' ? `$(folder) ${path.basename(o.path)}` : `$(notebook) ${path.basename(o.path)}`,
                description: o.object_type === 'DIRECTORY' ? 'Directory' : `${o.language ?? 'unknown'} notebook`,
                detail:      o.path,
                obj:         o,
              }));

            // Add "go up" option if not at root
            if (currentPath !== '/') {
              items.unshift({
                label:       '$(arrow-up) ..',
                description: 'Go up one level',
                detail:      path.dirname(currentPath),
                obj:         { path: path.dirname(currentPath), object_type: 'DIRECTORY' },
              });
            }

            const pick = await vscode.window.showQuickPick(items, {
              placeHolder: `Browsing: ${currentPath}`,
            });
            if (!pick) return;

            if (pick.obj.object_type === 'DIRECTORY') {
              currentPath = pick.obj.path;
            } else {
              selectedNotebook = pick.obj;
            }
          }

          // Import the selected notebook
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Databricks: Importing ${path.basename(selectedNotebook.path)}…` },
            async () => {
              const content = await client.exportNotebook(selectedNotebook!.path);
              const ext = selectedNotebook!.language === 'SQL' ? '.sql'
                        : selectedNotebook!.language === 'SCALA' ? '.scala'
                        : selectedNotebook!.language === 'R' ? '.r'
                        : '.py';
              const fileName = path.basename(selectedNotebook!.path) + ext;
              const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (!wsFolder) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
              }

              const filePath = path.join(wsFolder, fileName);
              await services.workspace.writeFile(filePath, content, true);
              vscode.window.showInformationMessage(`Databricks: Imported ${fileName}`);
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Browse notebooks failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 11. Deploy Notebook ─────────────────────
    {
      id:    'aiForge.databricks.deployNotebook',
      title: 'Databricks: Deploy Current File as Notebook',
      handler: async (services): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file to deploy as a notebook.');
          return;
        }

        try {
          const client = this._requireClient('deploy notebook');

          const remotePath = await vscode.window.showInputBox({
            prompt:      'Remote workspace path (e.g. /Users/you@company.com/my_notebook)',
            placeHolder: `/Users/${this._user}/${path.basename(editor.document.fileName, path.extname(editor.document.fileName))}`,
            ignoreFocusOut: true,
            validateInput: (v) => v.trim().startsWith('/') ? null : 'Path must start with /',
          });
          if (!remotePath) return;

          const lang = editor.document.languageId === 'sql' ? 'SQL'
                     : editor.document.languageId === 'scala' ? 'SCALA'
                     : editor.document.languageId === 'r' ? 'R'
                     : 'PYTHON';

          const overwrite = await vscode.window.showQuickPick(
            [{ label: 'No', value: false }, { label: 'Yes', value: true }],
            { placeHolder: 'Overwrite if notebook exists?' },
          );
          if (!overwrite) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Databricks: Deploying to ${remotePath}…` },
            async () => {
              await client.importNotebook(remotePath.trim(), editor.document.getText(), lang, overwrite.value);
              vscode.window.showInformationMessage(`Databricks: Deployed to ${remotePath}`);
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Deploy failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 12. Explore Catalog ─────────────────────
    {
      id:    'aiForge.databricks.exploreCatalog',
      title: 'Databricks: Explore Unity Catalog',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('explore catalog');

          // Step 1: Pick catalog
          const catalogs = await client.listCatalogs();
          if (catalogs.length === 0) {
            vscode.window.showInformationMessage('Databricks: No Unity Catalog catalogs found.');
            return;
          }

          const catPick = await vscode.window.showQuickPick(
            catalogs.map(c => ({
              label:       c.name,
              description: c.owner ? `Owner: ${c.owner}` : '',
              detail:      c.comment ?? '',
            })),
            { placeHolder: 'Select a catalog' },
          );
          if (!catPick) return;

          // Step 2: Pick schema
          const schemas = await client.listSchemas(catPick.label);
          if (schemas.length === 0) {
            vscode.window.showInformationMessage(`Databricks: No schemas in ${catPick.label}.`);
            return;
          }

          const schemaPick = await vscode.window.showQuickPick(
            schemas.map(s => ({
              label:       s.name,
              description: `${s.catalog_name}.${s.name}`,
              detail:      s.comment ?? '',
            })),
            { placeHolder: `Select a schema in ${catPick.label}` },
          );
          if (!schemaPick) return;

          // Step 3: Pick table
          const tables = await client.listTables(catPick.label, schemaPick.label);
          if (tables.length === 0) {
            vscode.window.showInformationMessage(`Databricks: No tables in ${catPick.label}.${schemaPick.label}.`);
            return;
          }

          const tablePick = await vscode.window.showQuickPick(
            tables.map(t => ({
              label:       t.name,
              description: t.table_type,
              detail:      t.comment ?? '',
              fullName:    `${t.catalog_name}.${t.schema_name}.${t.name}`,
            })),
            { placeHolder: `Select a table in ${catPick.label}.${schemaPick.label}` },
          );
          if (!tablePick) return;

          // Step 4: Fetch table detail and send to AI
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Databricks: Fetching ${tablePick.fullName}…` },
            async () => {
              const tableDetail = await client.getTable(tablePick.fullName);
              const columns = tableDetail.columns
                ?.map(c => `  - \`${c.name}\` ${c.type_text}${c.nullable === false ? ' NOT NULL' : ''}${c.comment ? ` — ${c.comment}` : ''}`)
                .join('\n') ?? '  (no column info)';

              const prompt = `Explain this Unity Catalog table and suggest useful queries:

**Table:** \`${tablePick.fullName}\`
**Type:** ${tableDetail.table_type}
${tableDetail.comment ? `**Description:** ${tableDetail.comment}` : ''}

**Columns:**
${columns}

Please:
1. Explain what this table likely represents based on column names and types
2. Suggest 3-5 useful queries (SELECT, aggregations, joins) using the full 3-part name
3. Identify any potential data quality concerns (nullable columns, missing constraints)
4. Suggest complementary tables that might join well with this one`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Explore catalog failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 13. Query Table ─────────────────────
    {
      id:    'aiForge.databricks.queryTable',
      title: 'Databricks: AI Query Suggestion for Table',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('query table');

          // Quick pick catalog > schema > table
          const catalogs = await client.listCatalogs();
          if (catalogs.length === 0) {
            vscode.window.showInformationMessage('No Unity Catalog catalogs found.');
            return;
          }

          const catPick = await vscode.window.showQuickPick(
            catalogs.map(c => ({ label: c.name, description: c.comment ?? '' })),
            { placeHolder: 'Select catalog' },
          );
          if (!catPick) return;

          const schemas = await client.listSchemas(catPick.label);
          const schemaPick = await vscode.window.showQuickPick(
            schemas.map(s => ({ label: s.name, description: s.comment ?? '' })),
            { placeHolder: 'Select schema' },
          );
          if (!schemaPick) return;

          const tables = await client.listTables(catPick.label, schemaPick.label);
          const tablePick = await vscode.window.showQuickPick(
            tables.map(t => ({
              label: t.name,
              description: t.table_type,
              fullName: `${t.catalog_name}.${t.schema_name}.${t.name}`,
            })),
            { placeHolder: 'Select table' },
          );
          if (!tablePick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Databricks: Generating query…' },
            async () => {
              const tableDetail = await client.getTable(tablePick.fullName);
              const columns = tableDetail.columns
                ?.map(c => `${c.name} (${c.type_text})`)
                .join(', ') ?? 'unknown columns';

              const prompt = `Generate and explain a sample SQL query for this table:

**Table:** \`${tablePick.fullName}\`
**Columns:** ${columns}

Generate:
1. A basic SELECT with interesting columns and a WHERE clause
2. An aggregation query (GROUP BY) that would show useful metrics
3. A window function query if applicable
4. Explain what each query does and when you'd use it

Use the full 3-part Unity Catalog name in all queries.`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Query table failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 14. Run SQL ─────────────────────
    {
      id:    'aiForge.databricks.runSQL',
      title: 'Databricks: Execute SQL on Warehouse',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('run SQL');

          // Get SQL — from selection or prompt
          const editor = vscode.window.activeTextEditor;
          let sql = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : '';

          if (!sql) {
            const input = await vscode.window.showInputBox({
              prompt:      'Enter SQL to execute',
              placeHolder: 'SELECT * FROM catalog.schema.table LIMIT 100',
              ignoreFocusOut: true,
            });
            if (!input) return;
            sql = input;
          }

          // Pick a warehouse
          const warehouses = await client.listWarehouses();
          if (warehouses.length === 0) {
            vscode.window.showErrorMessage('Databricks: No SQL warehouses found. Create one in the Databricks UI.');
            return;
          }

          const whPick = await vscode.window.showQuickPick(
            warehouses.map(w => ({
              label:       w.name,
              description: `[${w.state}] ID: ${w.id}`,
              whId:        w.id,
            })),
            { placeHolder: 'Select a SQL warehouse' },
          );
          if (!whPick) return;

          if (warehouses.find(w => w.id === whPick.whId)?.state !== 'RUNNING') {
            const proceed = await vscode.window.showWarningMessage(
              `Warehouse "${whPick.label}" is not running. The query will start it (may take a few minutes).`,
              'Proceed', 'Cancel',
            );
            if (proceed !== 'Proceed') return;
          }

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Databricks: Executing SQL…', cancellable: false },
            async () => {
              const result = await client.executeSQL(whPick.whId, sql);

              if (result.status.state === 'FAILED') {
                const errMsg = result.status.error?.message ?? 'Unknown SQL error';
                await vscode.commands.executeCommand(
                  'aiForge._sendToChat',
                  `This SQL query failed on Databricks. Explain the error and suggest a fix:\n\n**SQL:**\n\`\`\`sql\n${sql}\n\`\`\`\n\n**Error:** ${errMsg}`,
                  'chat',
                );
                return;
              }

              // Format results as a table
              const columns = result.manifest?.schema?.columns?.map(c => c.name) ?? [];
              const rows    = result.result?.data_array ?? [];

              let tableText = '';
              if (columns.length > 0) {
                const header    = '| ' + columns.join(' | ') + ' |';
                const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
                const dataRows  = rows.slice(0, 50).map(
                  row => '| ' + row.map(v => (v ?? 'NULL').toString().slice(0, 50)).join(' | ') + ' |'
                );
                tableText = [header, separator, ...dataRows].join('\n');
                if (rows.length > 50) {
                  tableText += `\n\n_(showing 50 of ${rows.length} rows)_`;
                }
              } else {
                tableText = 'Query executed successfully (no result set).';
              }

              const prompt = `Analyse these SQL query results from Databricks:

**SQL:**
\`\`\`sql
${sql}
\`\`\`

**Results (${rows.length} rows):**
${tableText}

Provide:
1. A brief summary of what the data shows
2. Any patterns, anomalies, or insights
3. Suggested follow-up queries for deeper analysis`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: SQL execution failed — ${msg}`);
        }
      },
    },

    // ───────────────────── 15. Manage DLT Pipeline ─────────────────────
    {
      id:    'aiForge.databricks.managePipeline',
      title: 'Databricks: Manage DLT Pipeline',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('manage pipeline');

          const pipelines = await client.listPipelines();
          if (pipelines.length === 0) {
            vscode.window.showInformationMessage('Databricks: No Delta Live Tables pipelines found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            pipelines.map(p => ({
              label:       p.name,
              description: `[${p.state}] ${p.catalog ?? ''}.${p.target ?? ''}`,
              detail:      `ID: ${p.pipeline_id} | Creator: ${p.creator_user_name ?? 'unknown'}`,
              pipelineId:  p.pipeline_id,
              state:       p.state,
            })),
            { placeHolder: 'Select a DLT pipeline' },
          );
          if (!pick) return;

          // Offer actions based on state
          const actions: Array<{ label: string; action: string }> = [
            { label: '$(info) View Details & AI Analysis', action: 'details' },
          ];

          if (pick.state === 'IDLE' || pick.state === 'FAILED') {
            actions.push({ label: '$(play) Start Pipeline', action: 'start' });
          }
          if (pick.state === 'RUNNING') {
            actions.push({ label: '$(debug-stop) Stop Pipeline', action: 'stop' });
          }

          const actionPick = await vscode.window.showQuickPick(actions, {
            placeHolder: `Action for "${pick.label}" [${pick.state}]`,
          });
          if (!actionPick) return;

          if (actionPick.action === 'start') {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Databricks: Starting ${pick.label}…` },
              async () => {
                await client.startPipeline(pick.pipelineId);
                vscode.window.showInformationMessage(`Databricks: Pipeline "${pick.label}" update started.`);
              }
            );
          } else if (actionPick.action === 'stop') {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Databricks: Stopping ${pick.label}…` },
              async () => {
                await client.stopPipeline(pick.pipelineId);
                vscode.window.showInformationMessage(`Databricks: Pipeline "${pick.label}" stop requested.`);
              }
            );
          } else {
            // Fetch full pipeline detail and send to AI
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Databricks: Fetching ${pick.label} details…` },
              async () => {
                const detail = await client.getPipeline(pick.pipelineId);
                const configJson = JSON.stringify(detail, null, 2);

                const prompt = `Analyse this Delta Live Tables pipeline configuration:

\`\`\`json
${configJson}
\`\`\`

Please explain:
1. What this pipeline does (data sources, transformations, targets)
2. The pipeline topology (which tables depend on which)
3. Whether the configuration follows best practices
4. Suggestions for improvement (performance, cost, reliability)
${pick.state === 'FAILED' ? '5. The pipeline is currently in FAILED state — what might have caused the failure?' : ''}`;

                await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
              }
            );
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Databricks: Pipeline management failed — ${msg}`);
        }
      },
    },
  ];

  // ── statusItem ──────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      if (this._connected) {
        const hostShort = this._host.replace(/^https?:\/\//, '').split('.')[0];
        return `$(cloud-upload) ${hostShort}`;
      }
      return '$(cloud) Databricks (disconnected)';
    },
  };
}
