/**
 * plugins/azure.ts — Microsoft Azure stack plugin for Evolve AI
 *
 * Activates when the workspace contains Azure project markers: host.json,
 * local.settings.json, function.json, azure-pipelines.yml, .azure/, ARM/Bicep
 * templates, or Azure SDK imports.
 *
 * Contributes:
 *  - contextHooks       : Functions config, ARM/Bicep resources, pipelines, triggers
 *  - systemPromptSection: Azure Functions, App Service, Cosmos DB, Storage, DevOps,
 *                         ARM/Bicep, Managed Identity, anti-patterns
 *  - codeLensActions    : Function triggers, ARM/Bicep resources, SDK clients
 *  - codeActions        : Optimize Function, Add retry, Managed Identity, ARM→Bicep
 *  - transforms         : Add retry policies, Add structured logging
 *  - templates          : Function, Bicep, Durable Functions, APIM+Functions+Cosmos
 *  - commands           : explainResource, optimizeFunction, generatePipeline,
 *                         addRetryPolicy, convertToBicep, generateFunction,
 *                         explainCost, addManagedIdentity
 *  - statusItem         : detected Azure services count
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

// ── Detection markers ─────────────────────────────────────────────────────────

/** Files/dirs whose presence signals an Azure workspace */
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
const AZURE_ENV_PATTERN = /^AZURE_/m;

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

function hasAzureConnectionStrings(wsPath: string): boolean {
  const appSettings = path.join(wsPath, 'appsettings.json');
  if (fs.existsSync(appSettings)) {
    try {
      const content = fs.readFileSync(appSettings, 'utf8').slice(0, 5000);
      if (/AccountEndpoint=|DefaultEndpointsProtocol=|\.azure\.com|\.windows\.net/i.test(content)) {
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

function hasAzureEnvVars(wsPath: string): boolean {
  const envFile = path.join(wsPath, '.env');
  if (fs.existsSync(envFile)) {
    try {
      const content = fs.readFileSync(envFile, 'utf8').slice(0, 3000);
      if (AZURE_ENV_PATTERN.test(content)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function hasAzureDependency(wsPath: string): boolean {
  // Python
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8').slice(0, 5000);
        if (/azure-functions|azure-storage|azure-cosmos|azure-identity|azure-mgmt/i.test(content)) return true;
      } catch { /* ignore */ }
    }
  }
  // Node
  const pkg = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const allDeps = { ...p.dependencies, ...p.devDependencies };
      if (Object.keys(allDeps).some(d => d.startsWith('@azure/'))) return true;
    } catch { /* ignore */ }
  }
  // .NET
  const csproj = globFiles(wsPath, [/\.csproj$/], 3);
  for (const f of csproj) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 5000);
      if (/Microsoft\.Azure\.|Azure\.Functions|Azure\.Storage|Azure\.Cosmos/i.test(content)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ── Helper: walk for specific file patterns ───────────────────────────────────

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

// ── Detect Azure environment type ─────────────────────────────────────────────

function detectEnvironmentType(wsPath: string): string {
  if (fs.existsSync(path.join(wsPath, 'host.json'))) return 'Azure Functions';
  if (fs.existsSync(path.join(wsPath, 'azure-pipelines.yml')) || fs.existsSync(path.join(wsPath, 'azure-pipelines.yaml'))) return 'Azure DevOps';
  if (fs.existsSync(path.join(wsPath, 'azuredeploy.json'))) return 'ARM Template';
  if (fs.existsSync(path.join(wsPath, 'main.bicep')) || hasBicepFiles(wsPath)) return 'Bicep';
  if (fs.existsSync(path.join(wsPath, '.azure'))) return 'Azure CLI';
  return 'Azure';
}

// ── Detect Azure services from code ───────────────────────────────────────────

function detectAzureServices(wsPath: string): string[] {
  const services: Set<string> = new Set();
  const allFiles = [
    ...globFiles(wsPath, [/\.py$/, /\.cs$/, /\.ts$/, /\.js$/], 40),
  ];
  const combined = allFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; }
  }).join('\n');

  if (/azure[._-]functions|host\.json|FunctionName|@app\.(route|function_name)/i.test(combined)) services.add('Functions');
  if (/azure[._-]storage|BlobServiceClient|BlobClient|CloudBlobContainer/i.test(combined)) services.add('Blob Storage');
  if (/QueueServiceClient|QueueClient|CloudQueueMessage/i.test(combined)) services.add('Queue Storage');
  if (/TableServiceClient|TableClient|CloudTable/i.test(combined)) services.add('Table Storage');
  if (/azure[._-]cosmos|CosmosClient|DocumentClient|cosmos_client/i.test(combined)) services.add('Cosmos DB');
  if (/azure[._-]identity|DefaultAzureCredential|ManagedIdentityCredential/i.test(combined)) services.add('Identity');
  if (/azure[._-]keyvault|SecretClient|KeyClient|CertificateClient/i.test(combined)) services.add('Key Vault');
  if (/azure[._-]servicebus|ServiceBusClient|ServiceBusSender/i.test(combined)) services.add('Service Bus');
  if (/azure[._-]eventhub|EventHubProducerClient|EventHubConsumerClient/i.test(combined)) services.add('Event Hubs');
  if (/azure[._-]monitor|MonitorClient|LogsQueryClient|MetricsQueryClient/i.test(combined)) services.add('Monitor');
  if (/azure[._-]mgmt|ResourceManagementClient|SubscriptionClient/i.test(combined)) services.add('Management SDK');
  if (/SignalR|azure[._-]signalr/i.test(combined)) services.add('SignalR');
  if (/azure[._-]search|SearchClient|SearchIndexClient/i.test(combined)) services.add('Cognitive Search');
  if (/azure[._-]ai|OpenAIClient|azure\.ai/i.test(combined)) services.add('AI Services');

  return [...services];
}

// ── Detect function triggers ──────────────────────────────────────────────────

function detectFunctionTriggers(wsPath: string): string[] {
  const triggers: Set<string> = new Set();

  // Check function.json files
  const functionJsons = globFiles(wsPath, [/function\.json$/], 20);
  for (const f of functionJsons) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 3000);
      if (/httpTrigger/i.test(content)) triggers.add('HTTP');
      if (/timerTrigger/i.test(content)) triggers.add('Timer');
      if (/queueTrigger/i.test(content)) triggers.add('Queue');
      if (/blobTrigger/i.test(content)) triggers.add('Blob');
      if (/cosmosDBTrigger/i.test(content)) triggers.add('Cosmos DB');
      if (/serviceBusTrigger/i.test(content)) triggers.add('Service Bus');
      if (/eventHubTrigger/i.test(content)) triggers.add('Event Hub');
      if (/eventGridTrigger/i.test(content)) triggers.add('Event Grid');
      if (/orchestrationTrigger|activityTrigger|entityTrigger/i.test(content)) triggers.add('Durable');
    } catch { /* skip */ }
  }

  // Check Python/C# source for trigger decorators/attributes
  const sources = globFiles(wsPath, [/\.py$/, /\.cs$/], 30);
  const combined = sources.map(f => {
    try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; }
  }).join('\n');

  if (/HttpTrigger|@app\.route|@app\.function_name.*http/i.test(combined)) triggers.add('HTTP');
  if (/TimerTrigger|@app\.timer_trigger|@app\.schedule/i.test(combined)) triggers.add('Timer');
  if (/QueueTrigger|@app\.queue_trigger/i.test(combined)) triggers.add('Queue');
  if (/BlobTrigger|@app\.blob_trigger/i.test(combined)) triggers.add('Blob');
  if (/CosmosDBTrigger|@app\.cosmos_db_trigger/i.test(combined)) triggers.add('Cosmos DB');
  if (/ServiceBusTrigger|@app\.service_bus_queue_trigger/i.test(combined)) triggers.add('Service Bus');
  if (/EventHubTrigger|@app\.event_hub_message_trigger/i.test(combined)) triggers.add('Event Hub');
  if (/OrchestrationTrigger|ActivityTrigger|@app\.orchestration_trigger|@app\.activity_trigger/i.test(combined)) triggers.add('Durable');

  return [...triggers];
}

// ── Context data shape ────────────────────────────────────────────────────────

interface AzureContext {
  envType:         string;
  marker:          string | null;
  azureServices:   string[];
  triggers:        string[];
  hostConfig:      string | null;
  pipelineConfig:  string | null;
  armTemplates:    string[];
  bicepFiles:      string[];
  hasManagedId:    boolean;
  hasDurable:      boolean;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class AzurePlugin implements IPlugin {
  readonly id          = 'azure';
  readonly displayName = 'Azure';
  readonly icon        = '$(cloud)';

  private _envType       = 'Azure';
  private _wsPath        = '';
  private _serviceCount  = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Check 1: marker files (fastest)
    if (findMarker(wsPath)) return true;

    // Check 2: Bicep files
    if (hasBicepFiles(wsPath)) return true;

    // Check 3: Azure connection strings in appsettings.json
    if (hasAzureConnectionStrings(wsPath)) return true;

    // Check 4: AZURE_ env vars in .env
    if (hasAzureEnvVars(wsPath)) return true;

    // Check 5: Azure SDK dependencies
    if (hasAzureDependency(wsPath)) return true;

    // Check 6: Scan source files for Azure imports (slower, last resort)
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

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath  = ws?.uri.fsPath ?? '';
    this._envType = this._wsPath ? detectEnvironmentType(this._wsPath) : 'Azure';
    this._serviceCount = this._wsPath ? detectAzureServices(this._wsPath).length : 0;
    console.log(`[Evolve AI] Azure plugin activated: ${this._envType}`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'azure',

      async collect(ws): Promise<AzureContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        const azureServices = detectAzureServices(wsPath);
        const triggers = detectFunctionTriggers(wsPath);

        // Read host.json if present
        let hostConfig: string | null = null;
        const hostPath = path.join(wsPath, 'host.json');
        if (fs.existsSync(hostPath)) {
          try { hostConfig = fs.readFileSync(hostPath, 'utf8').slice(0, 2000); } catch { /* ignore */ }
        }

        // Read pipeline config if present
        let pipelineConfig: string | null = null;
        for (const name of ['azure-pipelines.yml', 'azure-pipelines.yaml']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            try { pipelineConfig = fs.readFileSync(full, 'utf8').slice(0, 2000); } catch { /* ignore */ }
            break;
          }
        }

        // Find ARM templates
        const armTemplates = globFiles(wsPath, [/azuredeploy.*\.json$/, /arm.*\.json$/], 10)
          .map(f => path.relative(wsPath, f));

        // Find Bicep files
        const bicepFiles = globFiles(wsPath, [/\.bicep$/], 10)
          .map(f => path.relative(wsPath, f));

        // Scan for feature usage
        const allSources = globFiles(wsPath, [/\.py$/, /\.cs$/, /\.ts$/, /\.js$/], 40)
          .map(f => { try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; } })
          .join('\n');

        return {
          envType:       detectEnvironmentType(wsPath),
          marker:        findMarker(wsPath),
          azureServices,
          triggers,
          hostConfig,
          pipelineConfig,
          armTemplates,
          bicepFiles,
          hasManagedId:  /DefaultAzureCredential|ManagedIdentityCredential|azure[._-]identity/i.test(allSources),
          hasDurable:    /DurableClient|OrchestrationTrigger|orchestration_trigger|DurableOrchestrationClient/i.test(allSources),
        };
      },

      format(data: unknown): string {
        const d = data as AzureContext;
        const lines = [
          `## Azure Context (${d.envType})`,
        ];

        if (d.hostConfig) {
          lines.push(`### host.json:\n\`\`\`json\n${d.hostConfig.slice(0, 600)}\n\`\`\``);
        }

        if (d.pipelineConfig) {
          lines.push(`### Azure Pipeline:\n\`\`\`yaml\n${d.pipelineConfig.slice(0, 600)}\n\`\`\``);
        }

        if (d.armTemplates.length > 0) {
          lines.push(`### ARM templates: ${d.armTemplates.slice(0, 5).join(', ')}`);
        }

        if (d.bicepFiles.length > 0) {
          lines.push(`### Bicep files: ${d.bicepFiles.slice(0, 5).join(', ')}`);
        }

        if (d.triggers.length > 0) {
          lines.push(`### Function triggers: ${d.triggers.join(', ')}`);
        }

        if (d.azureServices.length > 0) {
          lines.push(`### Azure services: ${d.azureServices.join(', ')}`);
        }

        const features: string[] = [];
        if (d.hasManagedId) features.push('Managed Identity');
        if (d.hasDurable)   features.push('Durable Functions');
        if (features.length > 0) {
          lines.push(`### Detected features: ${features.join(', ')}`);
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Azure Expert Knowledge

You are an expert in Microsoft Azure cloud services, Azure Functions, ARM/Bicep infrastructure-as-code, and Azure DevOps. Apply these rules in every response involving Azure:

### Azure Functions Best Practices
- Keep functions small and stateless — one function, one responsibility
- Use Durable Functions for orchestration, fan-out/fan-in, and long-running workflows
- Cold start mitigation: use Premium plan or pre-warmed instances for latency-sensitive HTTP triggers
- Use bindings (input/output) instead of manual SDK calls — they handle connection management
- Never store state in static variables — functions can run on different instances
- Use IAsyncCollector for batch output bindings — avoids holding large payloads in memory
- Set host.json functionTimeout appropriately (Consumption plan max: 10 min, Premium: 30 min default)
- Use Application Insights for monitoring — structured logging with ILogger / logging module

### Azure App Service & Configuration
- Use deployment slots for zero-downtime deployments with auto-swap
- Store secrets in Key Vault with Key Vault References in App Settings, not in appsettings.json
- Enable Managed Identity for all service-to-service auth — never use connection strings with keys in code
- Use WEBSITE_RUN_FROM_PACKAGE=1 for immutable, faster deployments

### Cosmos DB Data Modeling
- Choose partition key carefully — it determines scalability, cost, and query performance
- Avoid hot partitions: distribute writes evenly across partition key values
- Prefer point reads (id + partition key) over cross-partition queries — 1 RU vs many
- Use Change Feed for event-driven architectures and materialised views
- Set RU/s at container level for predictable workloads; use autoscale for variable traffic
- Embed related data in the same document when read together — denormalise for read performance
- Use TTL for automatic data expiration instead of manual cleanup jobs

### Azure Storage Patterns
- Blob: use access tiers (Hot/Cool/Archive) based on access frequency to optimise cost
- Queue: use poison message handling (maxDequeueCount) — messages that fail 5+ times go to poison queue
- Table: partition key + row key design is critical — avoid full table scans
- Use SAS tokens with minimal scope and short expiry — never share account keys

### Azure DevOps Pipelines
- Use YAML pipelines (not classic) — they are versioned, reviewable, and portable
- Use templates for reusable pipeline logic — avoid duplicating stages across repos
- Use variable groups linked to Key Vault for secrets — never hardcode in pipeline YAML
- Use environments with approval gates for production deployments
- Cache dependencies (pip, npm, NuGet) between builds for faster CI

### ARM Templates vs Bicep
- Prefer Bicep over ARM JSON — it is more readable, has modules, and compiles to ARM
- Use modules to encapsulate reusable resource groups (e.g., networking, app service + db)
- Always parameterise resource names, SKUs, and locations — never hardcode
- Use dependsOn only when implicit dependency (via resource references) is not enough
- Use existing keyword in Bicep to reference pre-existing resources without redeploying them

### Managed Identity & RBAC
- Always use DefaultAzureCredential — it works in local dev (Azure CLI) and deployed (MI)
- Assign least-privilege RBAC roles — use built-in roles before creating custom ones
- Use user-assigned managed identity when multiple resources share the same identity

### Common Anti-Patterns
- Hardcoding connection strings or keys in code — use Key Vault + Managed Identity
- Missing retry policies on SDK calls — Azure SDKs have built-in retry; configure ExponentialRetry
- Over-provisioned resources — use autoscale, consumption plans, and reserved capacity
- Synchronous calls in Functions — use async/await consistently for I/O-bound operations
- Not setting CORS properly on Functions/App Service — leads to broken frontends
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud) Explain Azure Function',
      command:     'aiForge.azure.optimizeFunction',
      linePattern: /\[FunctionName\s*\(|@app\.(route|function_name|timer_trigger|queue_trigger|blob_trigger|cosmos_db_trigger)|def\s+main\s*\(.*func\.HttpRequest/,
      languages:   ['python', 'csharp'],
      tooltip:     'Explain and optimise this Azure Function',
    },
    {
      title:       '$(cloud) Explain resource',
      command:     'aiForge.azure.explainResource',
      linePattern: /^resource\s+\w+|"type"\s*:\s*"Microsoft\.\w+|module\s+\w+/,
      languages:   ['bicep', 'json'],
      tooltip:     'Explain this ARM/Bicep resource and its cost implications',
    },
    {
      title:       '$(cloud) Add retry policy',
      command:     'aiForge.azure.addRetryPolicy',
      linePattern: /BlobServiceClient|CosmosClient|ServiceBusClient|EventHubProducerClient|SecretClient|SearchClient|QueueClient|TableClient|DefaultAzureCredential/,
      languages:   ['python', 'csharp', 'typescript', 'javascript'],
      tooltip:     'Add retry and error handling for this Azure SDK client',
    },
    {
      title:       '$(cloud) Convert to Bicep',
      command:     'aiForge.azure.convertToBicep',
      linePattern: /"\$schema"\s*:\s*"https:\/\/schema\.management\.azure\.com/,
      languages:   ['json'],
      tooltip:     'Convert this ARM template to Bicep',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(cloud) Azure: Optimize Function',
      command:   'aiForge.azure.optimizeFunction',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python', 'csharp', 'typescript', 'javascript'],
    },
    {
      title:     '$(cloud) Azure: Add Retry Policy',
      command:   'aiForge.azure.addRetryPolicy',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python', 'csharp', 'typescript', 'javascript'],
    },
    {
      title:     '$(cloud) Azure: Add Managed Identity',
      command:   'aiForge.azure.addManagedIdentity',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python', 'csharp', 'typescript', 'javascript'],
    },
    {
      title:     '$(cloud) Azure: Convert ARM to Bicep',
      command:   'aiForge.azure.convertToBicep',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['json'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add Azure SDK retry policies',
      description: 'Add exponential retry and error handling to all Azure SDK client calls',
      extensions:  ['.py', '.cs', '.ts', '.js'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add retry policies and proper error handling to all Azure SDK calls in this file.
- Add exponential backoff retry configuration to SDK client instantiation
- Wrap SDK operations in try/catch with specific Azure exception handling
- Add logging for retries and failures using structured logging
- For Python: use azure.core.pipeline.policies.RetryPolicy or configure retry on client
- For C#: configure RetryOptions on client options
- For TypeScript/JavaScript: configure retryOptions on client pipeline
- Preserve all existing logic, variable names, and comments
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are an Azure SDK expert. Return only the complete updated file.',
          instruction: 'Add Azure SDK retry policies',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add structured logging to Azure Functions',
      description: 'Replace print/console.log with structured logging via ILogger or logging module',
      extensions:  ['.py', '.cs', '.ts', '.js'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add structured logging to this Azure Functions file.
- Replace print() / console.log() with proper structured logging
- For Python: use logging module with appropriate levels (info, warning, error)
- For C#: use ILogger with LogInformation, LogWarning, LogError
- For TypeScript/JavaScript: use context.log with appropriate levels
- Add correlation ID tracking where applicable
- Add metric logging for function execution time and throughput
- Preserve all existing logic and business rules
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are an Azure Functions observability expert. Return only the complete updated file.',
          instruction: 'Add structured logging to Azure Functions',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'New Azure Function (C#/Python/Node.js)',
      description: 'HTTP-triggered Azure Function with best practices and Managed Identity',
      prompt: (wsPath) =>
        `Create a production-quality Azure Function with HTTP trigger.
Include:
- HTTP trigger with route parameter, both GET and POST methods
- Input validation and proper error responses (400, 404, 500)
- Managed Identity authentication using DefaultAzureCredential
- Structured logging with correlation IDs
- Application Insights integration
- Proper async/await pattern
- Configuration from environment variables (not hardcoded)
- OpenAPI documentation decorators/attributes where applicable
- Health check endpoint pattern

Create versions for Python (v2 programming model with @app decorators) and C# (.NET 8 isolated worker).
Generate as ## function_app.py then the complete Python content, then ## Function.cs then the complete C# content.
Workspace: ${wsPath}`,
    },
    {
      label:       'New Bicep template',
      description: 'Bicep infrastructure template with modules, parameters, and outputs',
      prompt: (wsPath) =>
        `Create a production-quality Bicep template for a typical Azure web application.
Include:
- Parameters for environment (dev/staging/prod), location, naming prefix
- App Service Plan (Linux, P1v3 for prod, B1 for dev based on parameter)
- App Service with deployment slots (staging slot for prod)
- Application Insights linked to the App Service
- Key Vault for secrets with access policy for App Service Managed Identity
- User-assigned Managed Identity for the App Service
- Storage Account (for app data) with private endpoint
- Cosmos DB account with serverless capacity mode
- RBAC role assignments for Managed Identity (Key Vault Secrets User, Storage Blob Data Contributor, Cosmos DB Account Reader)
- Outputs: app service URL, Key Vault URI, storage account name
- Use descriptive resource names with environment prefix
- Add comments explaining non-obvious configuration choices
Generate as ## main.bicep then the complete content, then ## parameters.bicepparam then the parameter file.
Workspace: ${wsPath}`,
    },
    {
      label:       'Durable Functions orchestration',
      description: 'Durable Functions with orchestrator, activity functions, and error handling',
      prompt: (wsPath) =>
        `Create a production-quality Durable Functions orchestration.
Include:
- HTTP-triggered starter function that kicks off the orchestration
- Orchestrator function with:
  - Fan-out/fan-in pattern (parallel activity calls)
  - Retry policies on activity calls (maxRetries=3, backoff)
  - Sub-orchestration call example
  - Timer-based delay example (for approval workflows)
  - External event wait example (human-in-the-loop)
- Multiple activity functions:
  - Data validation activity
  - Processing activity (calls external API)
  - Notification activity (sends result)
- Entity function for managing workflow state
- Proper error handling with compensation (saga pattern)
- Structured logging throughout
- Status query endpoint for checking orchestration progress

Create for Python v2 programming model.
Generate as ## function_app.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Azure API Management + Functions + Cosmos DB',
      description: 'Full-stack Bicep template with APIM, Functions backend, and Cosmos DB',
      prompt: (wsPath) =>
        `Create a complete infrastructure-as-code template for an API-first Azure architecture.
Include Bicep files for:
1. API Management (Consumption tier for dev, Standard for prod)
   - Named values from Key Vault
   - API definition importing from Functions
   - Rate limiting and JWT validation policies
   - CORS policy for frontend
2. Azure Functions (Premium plan for APIM integration)
   - System-assigned Managed Identity
   - App Settings referencing Key Vault
   - Virtual Network integration
3. Cosmos DB (serverless for dev, provisioned autoscale for prod)
   - Database and container with well-designed partition key
   - Diagnostic settings to Log Analytics
4. Key Vault for all secrets
5. Log Analytics workspace
6. Application Insights
7. Virtual Network with subnets (Functions integration, private endpoints)

Use Bicep modules for each component.
Generate as ## main.bicep, ## modules/apim.bicep, ## modules/functions.bicep, ## modules/cosmosdb.bicep, ## modules/networking.bicep, ## modules/monitoring.bicep, then each module's complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.azure.explainResource',
      title: 'Azure: Explain Resource',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Azure ARM/Bicep resource definition, including:
- What the resource does and its purpose in the architecture
- Key configuration properties and their implications
- Cost implications (pricing tier, consumption model, reserved capacity)
- Security considerations (network access, identity, encryption)
- Dependencies on other resources
- Common misconfigurations to watch out for

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.azure.optimizeFunction',
      title: 'Azure: Optimize Function',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure: Optimizing Function...', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimize this Azure Function for performance and best practices. Apply:
- Reduce cold start impact (lazy initialization, connection reuse)
- Use async/await consistently for all I/O operations
- Use input/output bindings instead of manual SDK calls where possible
- Add proper error handling and structured logging
- Optimize memory usage (streaming for large payloads)
- Add timeout handling for external calls
- Ensure idempotency for queue/event triggers

Return ONLY the optimized code block, no explanation.

\`\`\`
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimize Azure Function',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'Azure: Optimized function ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimized version:\n\`\`\`\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.azure.generatePipeline',
      title: 'Azure: Generate Pipeline',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete azure-pipelines.yml for this project. Include:
- Trigger on main branch with PR validation
- Variable groups for secrets (linked to Key Vault)
- Stages: Build, Test, Deploy (dev), Deploy (prod with approval gate)
- Caching for package dependencies (pip/npm/NuGet)
- Code quality checks (linting, security scanning)
- Infrastructure deployment (Bicep/ARM) before application deployment
- Deployment slots with swap for zero-downtime
- Integration tests after deployment
- Rollback strategy on failure

${code ? `Project context:\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\`` : '(No file open — generate a template)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.azure.addRetryPolicy',
      title: 'Azure: Add Retry Policy',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add proper retry policies and error handling to the Azure SDK calls in this code.
- Configure exponential backoff retry on client creation
- Add try/catch blocks with specific Azure exception handling
  - HttpResponseError / ResourceNotFoundError for Python
  - RequestFailedException for C#
  - RestError for JavaScript/TypeScript
- Add circuit breaker pattern for external service calls
- Log retry attempts with structured logging
- Handle transient vs permanent failures differently

\`\`\`
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.azure.convertToBicep',
      title: 'Azure: Convert ARM to Bicep',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this ARM template JSON to Bicep format:
- Convert all resources to Bicep resource declarations
- Convert parameters and variables to Bicep param and var
- Replace concat() and other ARM functions with Bicep string interpolation
- Use existing keyword for pre-existing resource references
- Extract reusable components as modules where appropriate
- Preserve all comments and add new ones explaining complex configurations
- Output should be valid, deployable Bicep

\`\`\`json
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.azure.generateFunction',
      title: 'Azure: Generate Function',
      async handler(services): Promise<void> {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'HTTP Trigger',       description: 'REST API endpoint' },
            { label: 'Timer Trigger',       description: 'Scheduled/cron function' },
            { label: 'Queue Trigger',       description: 'Process queue messages' },
            { label: 'Blob Trigger',        description: 'React to blob storage changes' },
            { label: 'Cosmos DB Trigger',   description: 'React to Cosmos DB changes' },
            { label: 'Service Bus Trigger', description: 'Process Service Bus messages' },
            { label: 'Durable Orchestrator', description: 'Durable Functions workflow' },
          ],
          { placeHolder: 'Select trigger type' }
        );
        if (!pick) return;

        const langPick = await vscode.window.showQuickPick(
          ['Python', 'C#', 'TypeScript'],
          { placeHolder: 'Select language' }
        );
        if (!langPick) return;

        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a production-quality Azure Function with ${pick.label} in ${langPick}.
Include:
- Proper input validation and error handling
- Managed Identity authentication (DefaultAzureCredential)
- Structured logging with Application Insights
- Async/await patterns for all I/O
- Input/output bindings where applicable
- Unit test file for the function
- local.settings.json with required app settings

Generate as ## function_app.py (or appropriate filename) then the complete content, then ## test_function.py then the test file.
Workspace: ${ws}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.azure.explainCost',
      title: 'Azure: Explain Cost Implications',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Analyse the cost implications of this Azure configuration/code:
- Identify all billable resources and their pricing model (consumption, reserved, pay-as-you-go)
- Estimate relative cost for dev vs production workloads
- Identify cost optimisation opportunities:
  - Right-sizing (SKU, tier, capacity)
  - Reserved instances vs pay-as-you-go
  - Autoscale configuration
  - Storage tiering (Hot/Cool/Archive)
  - Serverless vs dedicated pricing
- Flag any "cost bombs" (unbounded scaling, missing caps, expensive defaults)
- Suggest Azure Cost Management alerts and budgets

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.azure.addManagedIdentity',
      title: 'Azure: Add Managed Identity',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Refactor this code to use Azure Managed Identity instead of connection strings or API keys.
- Replace any hardcoded connection strings, account keys, or API keys
- Use DefaultAzureCredential from azure-identity (Python) or Azure.Identity (C#/.NET) or @azure/identity (Node.js)
- Add fallback for local development (Azure CLI credential)
- Update Cosmos DB, Storage, Key Vault, Service Bus, Event Hub clients to use token-based auth
- Add the required RBAC role assignments as comments
- Explain what RBAC roles need to be assigned to the Managed Identity

\`\`\`
${code}
\`\`\``,
          'edit'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      const count = this._serviceCount;
      return `$(cloud) ${this._envType}${count > 0 ? ` (${count} services)` : ''}`;
    },
  };
}
