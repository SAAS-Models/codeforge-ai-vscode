/**
 * plugins/gcp.ts — Google Cloud Platform plugin for Evolve AI
 *
 * Activates when the workspace contains any GCP project marker.
 * Contributes:
 *  - contextHooks      : App Engine config, Cloud Build steps, Firebase config, Cloud Functions, GCP imports
 *  - systemPromptSection: full GCP domain knowledge (Cloud Functions, Cloud Run, Firestore, BigQuery, Pub/Sub, IAM)
 *  - codeLensActions   : Cloud Function entry points, Firestore operations, BigQuery queries
 *  - codeActions       : Optimize Cloud Function, Add GCP error handling, Add Firestore rules, Optimize BigQuery
 *  - transforms        : Add GCP SDK error handling, Add Cloud Logging
 *  - templates         : Cloud Function, Cloud Run service, Firebase app, Pub/Sub architecture
 *  - commands          : explainService, optimizeFunction, generateCloudBuild, addErrorHandling,
 *                        optimizeBigQuery, generateFirestoreRules, explainCost, addLogging
 *  - statusItem        : shows detected GCP services count
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

// -- Detection markers --------------------------------------------------------

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

const GCP_TERRAFORM_PROVIDER = /provider\s+["']google["']/;

function findMarker(wsPath: string): string | null {
  for (const marker of GCP_MARKER_FILES) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

function hasCloudFunctionsDir(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'cloud-functions'));
}

function hasGcpInDependencies(wsPath: string): boolean {
  // Check Python requirements
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (/google-cloud|functions-framework|firebase-admin/i.test(content)) return true;
      } catch { /* skip */ }
    }
  }
  // Check Node.js package.json
  const pkgPath = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, 'utf8');
      if (/@google-cloud\/|firebase-admin|firebase-functions/i.test(content)) return true;
    } catch { /* skip */ }
  }
  return false;
}

function hasTerraformGcpProvider(wsPath: string): boolean {
  const tfDir = path.join(wsPath, 'terraform');
  if (!fs.existsSync(tfDir)) return false;
  try {
    for (const entry of fs.readdirSync(tfDir)) {
      if (entry.endsWith('.tf')) {
        const content = fs.readFileSync(path.join(tfDir, entry), 'utf8').slice(0, 3000);
        if (GCP_TERRAFORM_PROVIDER.test(content)) return true;
      }
    }
  } catch { /* skip */ }
  return false;
}

// -- Helper: walk for specific file patterns ----------------------------------

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.next']);
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

// -- Detect GCP services from workspace ---------------------------------------

interface DetectedServices {
  appEngine:      boolean;
  cloudBuild:     boolean;
  firebase:       boolean;
  firestore:      boolean;
  cloudFunctions: boolean;
  cloudRun:       boolean;
  bigQuery:       boolean;
  pubSub:         boolean;
  cloudStorage:   boolean;
  cloudLogging:   boolean;
  terraform:      boolean;
}

function detectServices(wsPath: string, allContent: string): DetectedServices {
  return {
    appEngine:      fs.existsSync(path.join(wsPath, 'app.yaml')) || fs.existsSync(path.join(wsPath, 'app.yml')),
    cloudBuild:     fs.existsSync(path.join(wsPath, 'cloudbuild.yaml')) || fs.existsSync(path.join(wsPath, 'cloudbuild.yml')),
    firebase:       fs.existsSync(path.join(wsPath, 'firebase.json')) || fs.existsSync(path.join(wsPath, '.firebaserc')),
    firestore:      fs.existsSync(path.join(wsPath, 'firestore.rules')) || /firestore|Firestore/i.test(allContent),
    cloudFunctions: hasCloudFunctionsDir(wsPath) || /functions_framework|firebase-functions|@google-cloud\/functions/i.test(allContent),
    cloudRun:       /cloud.run|cloud_run|CloudRun|gcr\.io|run\.googleapis/i.test(allContent),
    bigQuery:       /bigquery|BigQuery|google\.cloud\.bigquery|@google-cloud\/bigquery/i.test(allContent),
    pubSub:         /pubsub|PubSub|google\.cloud\.pubsub|@google-cloud\/pubsub/i.test(allContent),
    cloudStorage:   /google\.cloud\.storage|@google-cloud\/storage|storage\.googleapis/i.test(allContent),
    cloudLogging:   /google\.cloud\.logging|@google-cloud\/logging|cloud-logging/i.test(allContent),
    terraform:      hasTerraformGcpProvider(wsPath),
  };
}

function countServices(svc: DetectedServices): number {
  return Object.values(svc).filter(Boolean).length;
}

function serviceNames(svc: DetectedServices): string[] {
  const names: string[] = [];
  if (svc.appEngine)      names.push('App Engine');
  if (svc.cloudBuild)     names.push('Cloud Build');
  if (svc.firebase)       names.push('Firebase');
  if (svc.firestore)      names.push('Firestore');
  if (svc.cloudFunctions) names.push('Cloud Functions');
  if (svc.cloudRun)       names.push('Cloud Run');
  if (svc.bigQuery)       names.push('BigQuery');
  if (svc.pubSub)         names.push('Pub/Sub');
  if (svc.cloudStorage)   names.push('Cloud Storage');
  if (svc.cloudLogging)   names.push('Cloud Logging');
  if (svc.terraform)      names.push('Terraform (GCP)');
  return names;
}

// -- Context data shape -------------------------------------------------------

interface GCPContext {
  services:           DetectedServices;
  appEngineConfig:    string | null;
  cloudBuildConfig:   string | null;
  firebaseConfig:     string | null;
  firestoreRules:     string | null;
  cloudFunctionFiles: string[];
  gcpImports:         string[];
}

// -- The plugin ---------------------------------------------------------------

export class GCPPlugin implements IPlugin {
  readonly id          = 'gcp';
  readonly displayName = 'Google Cloud';
  readonly icon        = '$(cloud)';

  private _wsPath   = '';
  private _services: DetectedServices = {
    appEngine: false, cloudBuild: false, firebase: false, firestore: false,
    cloudFunctions: false, cloudRun: false, bigQuery: false, pubSub: false,
    cloudStorage: false, cloudLogging: false, terraform: false,
  };

  // -- detect -----------------------------------------------------------------

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Fast: check marker files first
    if (findMarker(wsPath)) return true;
    if (hasCloudFunctionsDir(wsPath)) return true;
    if (hasGcpInDependencies(wsPath)) return true;
    if (hasTerraformGcpProvider(wsPath)) return true;

    // Slower: scan source files for GCP imports (limit scan)
    const sourceFiles = globFiles(wsPath, [/\.py$/, /\.js$/, /\.ts$/], 50);
    for (const f of sourceFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (GCP_IMPORT_PATTERN.test(sample)) return true;
      } catch { /* skip */ }
    }

    return false;
  }

  // -- activate ---------------------------------------------------------------

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Pre-scan for services to populate status item
    if (this._wsPath) {
      const allSource = globFiles(this._wsPath, [/\.py$/, /\.js$/, /\.ts$/, /\.yaml$/, /\.yml$/], 60)
        .map(f => { try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; } })
        .join('\n');
      this._services = detectServices(this._wsPath, allSource);
    }

    console.log(`[Evolve AI] GCP plugin activated: ${serviceNames(this._services).join(', ') || 'GCP project'}`);
    return [];
  }

  // -- contextHooks -----------------------------------------------------------

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'gcp',

      async collect(ws): Promise<GCPContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        // Read App Engine config
        let appEngineConfig: string | null = null;
        for (const name of ['app.yaml', 'app.yml']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            appEngineConfig = fs.readFileSync(full, 'utf8').slice(0, 2000);
            break;
          }
        }

        // Read Cloud Build config
        let cloudBuildConfig: string | null = null;
        for (const name of ['cloudbuild.yaml', 'cloudbuild.yml']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            cloudBuildConfig = fs.readFileSync(full, 'utf8').slice(0, 2000);
            break;
          }
        }

        // Read Firebase config
        let firebaseConfig: string | null = null;
        const fbPath = path.join(wsPath, 'firebase.json');
        if (fs.existsSync(fbPath)) {
          firebaseConfig = fs.readFileSync(fbPath, 'utf8').slice(0, 2000);
        }

        // Read Firestore rules
        let firestoreRules: string | null = null;
        const rulesPath = path.join(wsPath, 'firestore.rules');
        if (fs.existsSync(rulesPath)) {
          firestoreRules = fs.readFileSync(rulesPath, 'utf8').slice(0, 2000);
        }

        // Find Cloud Function files
        const cloudFunctionFiles: string[] = [];
        const sourceFiles = globFiles(wsPath, [/\.py$/, /\.js$/, /\.ts$/], 40);
        for (const f of sourceFiles) {
          try {
            const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
            if (/functions_framework|exports\.\w+\s*=|firebase-functions|onRequest|onCall/i.test(sample)) {
              cloudFunctionFiles.push(path.relative(wsPath, f));
            }
          } catch { /* skip */ }
        }

        // Collect unique GCP imports
        const gcpImports = new Set<string>();
        const allContent = sourceFiles.map(f => {
          try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; }
        }).join('\n');

        const pyImports = allContent.match(/from google\.cloud(?:\.\w+)*/g);
        if (pyImports) pyImports.forEach(m => gcpImports.add(m.replace('from ', '')));

        const jsImports = allContent.match(/@google-cloud\/[\w-]+/g);
        if (jsImports) jsImports.forEach(m => gcpImports.add(m));

        const services = detectServices(wsPath, allContent);

        return {
          services,
          appEngineConfig,
          cloudBuildConfig,
          firebaseConfig,
          firestoreRules,
          cloudFunctionFiles,
          gcpImports: Array.from(gcpImports).slice(0, 20),
        };
      },

      format(data: unknown): string {
        const d = data as GCPContext;
        const svcList = serviceNames(d.services);
        const lines = [
          `## Google Cloud Context (${svcList.length} service${svcList.length !== 1 ? 's' : ''} detected)`,
          `### Services: ${svcList.join(', ') || 'none detected'}`,
        ];

        if (d.appEngineConfig) {
          lines.push(`### App Engine config:\n\`\`\`yaml\n${d.appEngineConfig.slice(0, 800)}\n\`\`\``);
        }

        if (d.cloudBuildConfig) {
          lines.push(`### Cloud Build pipeline:\n\`\`\`yaml\n${d.cloudBuildConfig.slice(0, 800)}\n\`\`\``);
        }

        if (d.firebaseConfig) {
          lines.push(`### Firebase config:\n\`\`\`json\n${d.firebaseConfig.slice(0, 600)}\n\`\`\``);
        }

        if (d.firestoreRules) {
          lines.push(`### Firestore rules:\n\`\`\`\n${d.firestoreRules.slice(0, 600)}\n\`\`\``);
        }

        if (d.cloudFunctionFiles.length > 0) {
          lines.push(`### Cloud Functions: ${d.cloudFunctionFiles.slice(0, 8).join(', ')}`);
        }

        if (d.gcpImports.length > 0) {
          lines.push(`### GCP dependencies: ${d.gcpImports.join(', ')}`);
        }

        return lines.join('\n');
      },
    },
  ];

  // -- systemPromptSection ----------------------------------------------------

  systemPromptSection(): string {
    return `
## Google Cloud Platform Expert Knowledge

You are an expert in Google Cloud Platform (GCP). Apply these rules in every response involving GCP services, Firebase, or Google Cloud SDK code:

### Cloud Functions Best Practices
- Minimise cold starts: keep dependencies lightweight, use lazy initialisation for clients
- Initialise GCP clients (Firestore, Storage, BigQuery) OUTSIDE the function handler — reuse across invocations
- Set appropriate memory (128MB-8GB) and timeout (max 540s for HTTP, 600s for events) based on workload
- Use structured logging with severity levels — Cloud Logging parses JSON stdout automatically
- Always set --max-instances to prevent runaway scaling and unexpected costs
- Use functions_framework for local testing; deploy with gcloud functions deploy or Cloud Build
- For Python: use functions-framework package; for Node.js: use @google-cloud/functions-framework
- Prefer 2nd gen (Cloud Run-based) functions for concurrency, longer timeouts, and traffic splitting
- Handle retries idempotently for event-driven functions — use event IDs for deduplication
- Environment variables for config; Secret Manager for credentials — NEVER hardcode secrets

### Cloud Run Optimization
- Use multi-stage Docker builds to minimise image size — smaller images = faster cold starts
- Set concurrency appropriately (default 80) — CPU-bound workloads may need lower values
- Use startup probes and minimum instances (--min-instances=1) for latency-sensitive services
- Prefer Cloud Run jobs for batch workloads; Cloud Run services for HTTP
- Use Cloud Run service-to-service auth with IAM — no API keys between internal services
- Configure CPU allocation: CPU always-on for consistent performance, CPU-on-demand for cost savings

### Firestore Data Modeling
- Denormalise data — Firestore charges per document read, not per field
- Use subcollections for 1:N relationships; root collections for independent entities
- Composite indexes are required for multi-field queries — define in firestore.indexes.json
- Security rules: ALWAYS validate auth (request.auth != null) and data types (request.resource.data)
- Use batch writes (max 500 ops) for atomic multi-document updates
- Avoid deeply nested subcollections (>3 levels) — queries cannot span subcollections
- Use collection group queries for querying across subcollections with the same name
- Prefer server timestamps (serverTimestamp()) over client-generated dates

### BigQuery Best Practices
- ALWAYS use parameterised queries to prevent SQL injection and improve cache hit rates
- Prefer partitioned tables (time-unit or integer-range) — queries scan only relevant partitions
- Use clustered tables on frequently filtered columns — reduces bytes scanned
- SELECT only needed columns — BigQuery charges by bytes scanned, not rows
- Use approximate functions (APPROX_COUNT_DISTINCT, HLL_COUNT) for large-scale analytics
- Avoid SELECT * in production queries — it scans every column and costs more
- Use materialised views for repeated expensive aggregations
- Set query cost limits with maximum_bytes_billed to prevent accidental full-table scans
- Use MERGE for upserts; avoid DELETE+INSERT patterns

### Pub/Sub Messaging Patterns
- Use dead-letter topics for messages that fail processing after max retries
- Set appropriate ack deadlines (default 10s; extend for long processing)
- Use ordering keys when message order matters — but this limits throughput
- Prefer push subscriptions for Cloud Run/Functions; pull for long-running workers
- Enable exactly-once delivery for critical pipelines (higher latency trade-off)
- Use message attributes for routing/filtering — avoid parsing message body for routing decisions

### IAM and Security
- Follow least privilege: grant roles at the most specific resource level
- Use service accounts for service-to-service auth — never user credentials in production
- Prefer predefined roles over primitive roles (roles/viewer, roles/editor are too broad)
- Use Workload Identity Federation for external services — avoid service account keys
- Enable VPC Service Controls for sensitive data perimeters
- Audit with Cloud Audit Logs; monitor with Cloud Monitoring alerts

### Cloud Build CI/CD
- Use kaniko for building Docker images without Docker-in-Docker privileges
- Cache dependencies between builds: --cache-from for Docker, /workspace for build artifacts
- Use substitutions for environment-specific values (_PROJECT_ID, _REGION, _ENV)
- Trigger builds on push/PR with Cloud Build triggers connected to GitHub/GitLab
- Use approval gates for production deployments
- Store build artifacts in Artifact Registry (not Container Registry — it is deprecated)

### Common Anti-Patterns to Avoid
- Do NOT initialise SDK clients inside request handlers — causes repeated auth overhead
- Do NOT use service account key files in production — use attached service accounts or Workload Identity
- Do NOT store secrets in environment variables or source code — use Secret Manager
- Do NOT use synchronous file I/O in Cloud Functions — use async/await patterns
- Do NOT ignore error handling for GCP API calls — always handle quota, permission, and network errors
- Do NOT use Firestore transactions for read-only operations — they are more expensive
`.trim();
  }

  // -- codeLensActions --------------------------------------------------------

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud) Explain Cloud Function',
      command:     'aiForge.gcp.explainService',
      linePattern: /@functions_framework\.\w+|@app\.route|exports\.\w+\s*=\s*(?:async\s+)?(?:function|\()|onRequest|onCall|onDocumentCreated|onObjectFinalized/,
      languages:   ['python', 'javascript', 'typescript'],
      tooltip:     'Explain what this Cloud Function does and its cost/performance implications',
    },
    {
      title:       '$(cloud) Optimize Function',
      command:     'aiForge.gcp.optimizeFunction',
      linePattern: /def\s+\w+\(.*(?:request|event|cloud_event)|exports\.\w+\s*=|module\.exports/,
      languages:   ['python', 'javascript', 'typescript'],
      tooltip:     'Optimize this Cloud Function for cold starts, memory, and concurrency',
    },
    {
      title:       '$(cloud) Optimize BigQuery',
      command:     'aiForge.gcp.optimizeBigQuery',
      linePattern: /\.query\(|bigquery\.Client|SELECT\s+.+\s+FROM|CREATE\s+TABLE|MERGE\s+INTO/i,
      languages:   ['python', 'javascript', 'typescript', 'sql'],
      tooltip:     'Optimize this BigQuery query for cost and performance',
    },
    {
      title:       '$(cloud) Firestore operation',
      command:     'aiForge.gcp.explainService',
      linePattern: /\.collection\(|\.document\(|\.doc\(|firestore\.client|db\.collection|\.set\(|\.update\(|\.where\(/,
      languages:   ['python', 'javascript', 'typescript'],
      tooltip:     'Explain this Firestore operation and its cost implications',
    },
  ];

  // -- codeActions (lightbulb) ------------------------------------------------

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(cloud) GCP: Optimize Cloud Function',
      command:   'aiForge.gcp.optimizeFunction',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python', 'javascript', 'typescript'],
    },
    {
      title:     '$(cloud) GCP: Add error handling for GCP SDK calls',
      command:   'aiForge.gcp.addErrorHandling',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python', 'javascript', 'typescript'],
    },
    {
      title:     '$(cloud) GCP: Add Firestore security rules',
      command:   'aiForge.gcp.generateFirestoreRules',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python', 'javascript', 'typescript'],
    },
    {
      title:     '$(cloud) GCP: Optimize BigQuery query',
      command:   'aiForge.gcp.optimizeBigQuery',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python', 'javascript', 'typescript', 'sql'],
    },
  ];

  // -- transforms -------------------------------------------------------------

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add GCP SDK error handling',
      description: 'Wrap GCP SDK calls with proper error handling, retries, and logging',
      extensions:  ['.py', '.js', '.ts'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add comprehensive error handling to all GCP SDK calls in this ${lang} file. Apply:
- Wrap each GCP API call (Firestore, BigQuery, Storage, Pub/Sub) in try/catch or try/except
- Add specific error handling for common GCP errors (NotFound, PermissionDenied, ResourceExhausted, DeadlineExceeded)
- Add structured logging with appropriate severity levels (INFO, WARNING, ERROR)
- Add retry logic with exponential backoff for transient errors (503, 429)
- Ensure resources are properly cleaned up in finally blocks
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are a GCP SDK expert. Return only the complete updated file.',
          instruction: 'Add GCP SDK error handling',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add Cloud Logging to Cloud Functions',
      description: 'Replace print/console.log with structured Cloud Logging',
      extensions:  ['.py', '.js', '.ts'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add Google Cloud Logging best practices to this ${lang} file. Apply:
- Replace print() / console.log() with structured logging using Cloud Logging client
- For Python: use google.cloud.logging or JSON-formatted stdout (Cloud Functions auto-parses JSON)
- For Node.js: use @google-cloud/logging or structured JSON to stdout
- Add appropriate severity levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Include request context (trace ID, function name) in log entries
- Add log correlation for distributed tracing
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are a Cloud Logging expert. Return only the complete updated file.',
          instruction: 'Add Cloud Logging',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // -- templates --------------------------------------------------------------

  readonly templates: PluginTemplate[] = [
    {
      label:       'New Cloud Function (Python)',
      description: 'HTTP Cloud Function with error handling, logging, and local testing support',
      prompt: (wsPath) =>
        `Create a production-quality Google Cloud Function in Python.
Include:
- functions_framework import and @functions_framework.http decorator
- Proper request parsing (JSON body, query params)
- GCP client initialization OUTSIDE the handler (for connection reuse)
- Structured logging with Cloud Logging (JSON to stdout)
- Comprehensive error handling with appropriate HTTP status codes
- CORS headers for browser clients
- Input validation
- Type hints throughout
- A requirements.txt with pinned versions
- A .gcloudignore file
Generate as ## cloud_function/main.py and ## cloud_function/requirements.txt then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'New Cloud Function (Node.js)',
      description: 'HTTP Cloud Function with TypeScript, error handling, and structured logging',
      prompt: (wsPath) =>
        `Create a production-quality Google Cloud Function in Node.js with TypeScript.
Include:
- @google-cloud/functions-framework import
- Proper request/response typing (Request, Response from express)
- GCP client initialization outside the handler for connection reuse
- Structured JSON logging (Cloud Functions auto-parses JSON stdout)
- Comprehensive error handling with try/catch and appropriate HTTP status codes
- CORS middleware
- Input validation with descriptive error messages
- A package.json with @google-cloud/functions-framework and typescript
- A tsconfig.json configured for Cloud Functions
Generate as ## cloud_function/src/index.ts, ## cloud_function/package.json, ## cloud_function/tsconfig.json then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'New Cloud Run service',
      description: 'Containerized service with health checks, graceful shutdown, and Dockerfile',
      prompt: (wsPath) =>
        `Create a production-quality Cloud Run service.
Include:
- Python (FastAPI or Flask) or Node.js (Express) — choose based on workspace context
- Multi-stage Dockerfile optimized for small image size and fast cold starts
- Health check endpoint (GET /health)
- Graceful shutdown handler (SIGTERM)
- GCP client initialization with connection pooling
- Structured logging compatible with Cloud Logging
- Environment variable configuration (PORT, PROJECT_ID, etc.)
- Secret Manager integration for sensitive config
- A .dockerignore file
- A cloudbuild.yaml for CI/CD deployment to Cloud Run
Generate as separate files with ## filename headers then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Firebase app with Firestore',
      description: 'Firebase project with Firestore rules, indexes, and Cloud Functions triggers',
      prompt: (wsPath) =>
        `Create a Firebase project setup with Firestore.
Include:
- firebase.json with hosting, firestore, and functions configuration
- firestore.rules with production-quality security rules:
  - Authentication required for all writes
  - Data validation (type checking, required fields, field length limits)
  - Role-based access control pattern
  - Rate limiting pattern using security rules
- firestore.indexes.json with sample composite indexes
- A Cloud Functions trigger (onDocumentCreated) that processes new documents
- Client-side Firestore helper module with CRUD operations and error handling
- .firebaserc with project alias configuration
Generate as separate files with ## filename headers then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Pub/Sub event-driven architecture',
      description: 'Publisher + subscriber with dead-letter topic, retry, and monitoring',
      prompt: (wsPath) =>
        `Create a Pub/Sub event-driven architecture in Python.
Include:
- Publisher module: publish messages with attributes, ordering keys, and error handling
- Subscriber module (Cloud Function): process messages with idempotent handling
- Dead-letter topic configuration
- Message schema definition (Avro or Protocol Buffers)
- Retry logic with exponential backoff
- Cloud Monitoring alerting policy (as Terraform or gcloud commands)
- Integration test using Pub/Sub emulator
- A cloudbuild.yaml that deploys both publisher and subscriber
Generate as separate files with ## filename headers then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // -- commands ---------------------------------------------------------------

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.gcp.explainService',
      title: 'GCP: Explain Service Configuration',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain what this Google Cloud code/configuration does, including:
- Which GCP services are being used and how they interact
- Cost implications (pricing model, estimated costs for typical usage)
- Performance characteristics (cold starts, latency, throughput)
- Security considerations (IAM, authentication, data protection)
- Potential improvements and best practices

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.gcp.optimizeFunction',
      title: 'GCP: Optimize Cloud Function',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Optimizing Cloud Function...', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimize this Cloud Function for performance and cost. Apply:
- Move GCP client initialization outside the handler (global scope) for connection reuse
- Minimize cold start time: lazy imports, lightweight dependencies
- Add proper concurrency handling (2nd gen functions support concurrent requests)
- Optimize memory allocation based on workload
- Add structured logging instead of print/console.log
- Add proper error handling with appropriate HTTP status codes
- Ensure idempotency for event-driven functions

Return ONLY the optimized code block, no explanation.

\`\`\`
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimize Cloud Function',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'GCP: Optimized function ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimized Cloud Function:\n\`\`\`\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.gcp.generateCloudBuild',
      title: 'GCP: Generate cloudbuild.yaml',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete cloudbuild.yaml CI/CD pipeline for this project. Include:
- Build step: install dependencies and run tests
- Docker build step using kaniko (for security — no Docker-in-Docker)
- Push to Artifact Registry (not deprecated Container Registry)
- Deploy to Cloud Run (or Cloud Functions, based on the code)
- Use substitutions for _PROJECT_ID, _REGION, _SERVICE_NAME
- Add approval gate for production deploys
- Cache dependencies between builds
- Add timeout and machineType configuration

${code ? `Based on this code:\n\`\`\`\n${code}\n\`\`\`` : '(No file open — generate a general-purpose template)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.gcp.addErrorHandling',
      title: 'GCP: Add GCP SDK Error Handling',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add comprehensive error handling to all GCP SDK calls in this file.
For each GCP API call:
- Add specific exception handling (NotFound, PermissionDenied, ResourceExhausted, DeadlineExceeded)
- Add retry logic with exponential backoff for transient errors
- Add structured logging for each error case
- Clean up resources in finally blocks
- Return appropriate error responses (for HTTP functions)

\`\`\`
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.gcp.optimizeBigQuery',
      title: 'GCP: Optimize BigQuery SQL',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GCP: Optimizing BigQuery query...', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimize this BigQuery SQL/code for cost and performance. Apply:
- Replace SELECT * with specific column selections
- Add partitioning filters (WHERE _PARTITIONTIME or partition column)
- Use APPROX_COUNT_DISTINCT instead of COUNT(DISTINCT) for large datasets
- Add clustering recommendations for frequently filtered columns
- Replace correlated subqueries with JOINs or window functions
- Add maximum_bytes_billed as a safety guard
- Use parameterized queries instead of string interpolation
- Suggest materialized views for repeated expensive aggregations

Return ONLY the optimized code, no explanation.

\`\`\`
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimize BigQuery query',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'GCP: Optimized BigQuery query ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimized BigQuery query:\n\`\`\`sql\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.gcp.generateFirestoreRules',
      title: 'GCP: Generate Firestore Security Rules',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate production-quality Firestore security rules based on the data model in this code.
Include:
- Authentication requirement (request.auth != null) for all write operations
- Data type validation for every field (request.resource.data)
- Field-level access control (e.g., only admins can update certain fields)
- Document size limits
- Rate limiting patterns (using timestamp-based rules)
- Role-based access (admin, editor, viewer) using custom claims
- Collection-level rules for each collection found in the code
- Subcollection access rules

${code ? `Based on this code:\n\`\`\`\n${code}\n\`\`\`` : '(No file open — generate a template with common patterns)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.gcp.explainCost',
      title: 'GCP: Explain Cost Implications',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Analyze the cost implications of this Google Cloud code. For each GCP service used, explain:
- Pricing model (per-invocation, per-GB, per-second, etc.)
- Estimated cost at different traffic levels (100/day, 10K/day, 1M/day)
- Cost optimization opportunities (e.g., committed use discounts, caching, batching)
- Hidden costs (egress, cross-region, minimum billing increments)
- Specific anti-patterns that increase costs unnecessarily
- Recommended billing alerts and budgets

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.gcp.addLogging',
      title: 'GCP: Add Cloud Logging Best Practices',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add Cloud Logging best practices to this file:
- Replace print()/console.log() with structured JSON logging
- Add appropriate severity levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Include request trace IDs for distributed tracing correlation
- Add execution context (function name, project ID, region)
- Log latency metrics for GCP API calls
- Add error stack traces in structured format
- Ensure logs are parseable by Cloud Logging (JSON format with severity field)

\`\`\`
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
  ];

  // -- statusItem -------------------------------------------------------------

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      const count = countServices(this._services);
      return `$(cloud) GCP (${count} svc${count !== 1 ? 's' : ''})`;
    },
  };
}
