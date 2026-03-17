/**
 * plugins/databricks.ts — Databricks stack plugin for Evolve AI
 *
 * Activates when the workspace contains any Databricks project marker.
 * Contributes:
 *  - contextHooks      : cluster info, job configs, notebook names, DLT pipelines
 *  - systemPromptSection: full Databricks/Spark/Delta/Unity Catalog domain knowledge
 *  - codeLensActions   : Explain Job, Optimise, Convert to DataFrame, Add DLT decorator
 *  - codeActions       : QuickFix .collect() OOM risk, QuickFix UDF → built-in
 *  - transforms        : Optimise Spark, Add Delta patterns, Unity Catalog refs, Add MLflow
 *  - templates         : Notebook, DLT pipeline, Job YAML, Unity Catalog table DDL, Autoloader job
 *  - commands          : explainJob, optimiseQuery, convertToDelta, generateJobYaml, addMlflowTracking
 *  - statusItem        : shows detected Databricks environment type
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

/** Files/dirs whose presence signals a Databricks workspace */
const DATABRICKS_MARKERS = [
  '.databricks',
  'databricks.yml',
  'databricks.yaml',
  '.databrickscfg',
  'bundle.yml',        // Databricks Asset Bundles
  'bundle.yaml',
];

const PYSPARK_IMPORT = /from pyspark|import pyspark|SparkSession|spark\s*=\s*SparkSession/;

function findMarker(wsPath: string): string | null {
  for (const marker of DATABRICKS_MARKERS) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
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

function detectEnvironmentType(wsPath: string): string {
  if (fs.existsSync(path.join(wsPath, 'bundle.yml')) || fs.existsSync(path.join(wsPath, 'bundle.yaml'))) {
    return 'Databricks Asset Bundle';
  }
  if (fs.existsSync(path.join(wsPath, 'databricks.yml')) || fs.existsSync(path.join(wsPath, 'databricks.yaml'))) {
    return 'Databricks Workflow';
  }
  if (fs.existsSync(path.join(wsPath, '.databricks'))) {
    return 'Databricks Connect';
  }
  if (fs.existsSync(path.join(wsPath, '.databrickscfg'))) {
    return 'Databricks CLI';
  }
  return 'PySpark';
}

// ── Context data shape ────────────────────────────────────────────────────────

interface DatabricksContext {
  envType:       string;
  marker:        string | null;
  notebookFiles: string[];
  jobConfigs:    string[];
  dltPipelines:  string[];
  bundleConfig:  string | null;
  hasMLflow:     boolean;
  hasUnity:      boolean;
  hasDelta:      boolean;
  hasDLT:        boolean;
  hasAutoloader: boolean;
}

// ── Helper: walk for specific file patterns ───────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv']);
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

// ── The plugin ────────────────────────────────────────────────────────────────

export class DatabricksPlugin implements IPlugin {
  readonly id          = 'databricks';
  readonly displayName = 'Databricks';
  readonly icon        = '⚡';

  private _envType = 'Databricks';
  private _wsPath  = '';

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    if (findMarker(wsPath)) return true;
    if (hasPySparkInRequirements(wsPath)) return true;

    // Scan up to 50 Python files for PySpark imports (fast string check, no AST)
    const pyFiles = globFiles(wsPath, [/\.py$/], 50);
    for (const f of pyFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (PYSPARK_IMPORT.test(sample)) return true;
      } catch { /* skip */ }
    }

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath  = ws?.uri.fsPath ?? '';
    this._envType = this._wsPath ? detectEnvironmentType(this._wsPath) : 'Databricks';
    console.log(`[Evolve AI] Databricks plugin activated: ${this._envType}`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'databricks',

      async collect(ws): Promise<DatabricksContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        const notebookFiles = globFiles(wsPath, [/\.py$/, /\.ipynb$/], 30)
          .map(f => path.relative(wsPath, f));

        const jobConfigs = globFiles(wsPath, [/job.*\.ya?ml$/, /workflow.*\.ya?ml$/], 10)
          .map(f => path.relative(wsPath, f));

        const dltPipelines = globFiles(wsPath, [/pipeline.*\.ya?ml$/, /dlt.*\.py$/, /delta_live.*\.py$/], 10)
          .map(f => path.relative(wsPath, f));

        let bundleConfig: string | null = null;
        for (const name of ['bundle.yml', 'bundle.yaml', 'databricks.yml', 'databricks.yaml']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            bundleConfig = fs.readFileSync(full, 'utf8').slice(0, 2000);
            break;
          }
        }

        // Scan for feature usage across Python files
        const allPy = globFiles(wsPath, [/\.py$/], 60).map(f => {
          try { return fs.readFileSync(f, 'utf8').slice(0, 3000); } catch { return ''; }
        }).join('\n');

        return {
          envType:      detectEnvironmentType(wsPath),
          marker:       findMarker(wsPath),
          notebookFiles,
          jobConfigs,
          dltPipelines,
          bundleConfig,
          hasMLflow:    /mlflow/i.test(allPy),
          hasUnity:     /unity.catalog|three.part.name|catalog\.\w+\.\w+/i.test(allPy),
          hasDelta:     /delta|DeltaTable|MERGE INTO/i.test(allPy),
          hasDLT:       /@dlt\.|dlt\.table|dlt\.view|DeltaLiveTable/i.test(allPy),
          hasAutoloader:/cloudFiles|readStream/i.test(allPy),
        };
      },

      format(data: unknown): string {
        const d = data as DatabricksContext;
        const lines = [
          `## Databricks Context (${d.envType})`,
        ];

        if (d.bundleConfig) {
          lines.push(`### Bundle / Workflow config:\n\`\`\`yaml\n${d.bundleConfig.slice(0, 800)}\n\`\`\``);
        }

        if (d.jobConfigs.length > 0) {
          lines.push(`### Job configs: ${d.jobConfigs.slice(0, 5).join(', ')}`);
        }

        if (d.dltPipelines.length > 0) {
          lines.push(`### DLT pipelines: ${d.dltPipelines.slice(0, 5).join(', ')}`);
        }

        const features: string[] = [];
        if (d.hasDelta)      features.push('Delta Lake');
        if (d.hasDLT)        features.push('Delta Live Tables');
        if (d.hasMLflow)     features.push('MLflow');
        if (d.hasUnity)      features.push('Unity Catalog');
        if (d.hasAutoloader) features.push('Auto Loader');
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
## Databricks / Spark Expert Knowledge

You are an expert in Databricks, Apache Spark, Delta Lake, and the broader Databricks Lakehouse platform. Apply these rules in every response involving PySpark, SQL, or Databricks config:

### PySpark Best Practices
- Prefer DataFrame API over RDD API — RDDs bypass Catalyst optimizer
- NEVER use .collect() on large datasets — it pulls all data to the driver, causing OOM
- Use .limit(n).collect() or .show(n) for sampling; use aggregations for metrics
- Prefer spark.sql() for complex multi-table joins; DataFrame API for programmatic transforms
- Avoid Python UDFs — they serialize row-by-row through the Python interpreter; prefer built-in pyspark.sql.functions or Pandas UDFs (vectorized)
- Cache (df.cache() / df.persist()) only when a DataFrame is reused 2+ times; always unpersist after
- Use .repartition(n) before heavy shuffles; .coalesce(n) when reducing partitions without shuffle
- Broadcast small tables in joins: spark.sql("SELECT /*+ BROADCAST(small) */ ...") or broadcast(small_df)
- Avoid df.count() in loops — it triggers a full Spark job each call; batch metrics with aggregations

### Delta Lake
- Always use Delta format for new tables: .format("delta")
- Use MERGE INTO for CDC/upserts — never overwrite the whole table for incremental loads
- Enable change data feed for downstream consumers: TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true')
- Use OPTIMIZE with ZORDER for frequently filtered columns
- VACUUM regularly; default retention is 7 days
- Prefer schema evolution (mergeSchema=True) over recreating tables
- Use Delta time travel for auditing: df.read.format("delta").option("versionAsOf", n)

### Unity Catalog
- Always use 3-part names: catalog.schema.table — never 2-part in Unity Catalog workspaces
- Grant privileges at the most specific level (table > schema > catalog)
- Use VOLUME for unstructured file I/O instead of dbfs:/ paths in UC workspaces
- Column-level masking and row-level security are native UC features — use them over application-layer filtering
- Use information_schema views for lineage and discovery

### Delta Live Tables (DLT)
- Use @dlt.table for materialized Delta tables, @dlt.view for ephemeral views
- Declare expectations with @dlt.expect, @dlt.expect_or_drop, @dlt.expect_or_fail
- Use dlt.read() and dlt.read_stream() for intra-pipeline dependencies — not spark.read
- Enhanced autoscaling is the default for streaming pipelines
- Parameterize with pipeline parameters, not hardcoded values

### Auto Loader (Structured Streaming)
- Use spark.readStream.format("cloudFiles") for incremental file ingestion
- Set cloudFiles.format and cloudFiles.schemaLocation always
- Use .option("cloudFiles.inferColumnTypes", "true") for schema inference
- Trigger.AvailableNow for batch-like incremental loads; Trigger.ProcessingTime for near-real-time
- Checkpointing is mandatory: .option("checkpointLocation", ...)

### MLflow
- Always call mlflow.set_experiment() before logging runs
- Use mlflow.autolog() for automatic parameter/metric logging with sklearn, XGBoost, PyTorch
- Log models with mlflow.pyfunc.log_model() for custom flavors; use registered model names
- Use mlflow.MlflowClient() for programmatic model registry operations
- Unity Catalog model registry: set MLFLOW_TRACKING_URI to databricks-uc

### Databricks-Specific Patterns
- Use dbutils.secrets.get(scope, key) for credentials — NEVER hardcode or use env vars in notebooks
- Use dbutils.widgets for notebook parameters — not sys.argv or hardcoded values  
- Use dbutils.fs.ls() / dbutils.fs.cp() for file operations (or UC Volumes in Unity Catalog)
- Databricks Connect v2 (SDK-based) replaces legacy Remote Spark connections
- Job clusters are ephemeral; interactive clusters are persistent — cost implications differ
- Use task_values (dbutils.jobs.taskValues) to pass data between tasks in a Workflow

### Code Quality
- Type-annotate PySpark UDFs: @udf(returnType=StringType())
- Structure notebooks as importable modules when possible (avoid top-level side effects)
- Use structured logging, not print() — Databricks captures stdout but structured logs integrate with observability tools
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '⚡ Explain Spark job',
      command:     'aiForge.databricks.explainJob',
      linePattern: /def\s+\w+|spark\s*=\s*SparkSession|\.read\.|\.write\.|\.transform\(/,
      languages:   ['python'],
      tooltip:     'Explain what this Spark operation does and its performance implications',
    },
    {
      title:       '⚡ Optimise query',
      command:     'aiForge.databricks.optimiseQuery',
      linePattern: /\.select\(|\.filter\(|\.join\(|\.groupBy\(|spark\.sql\(/,
      languages:   ['python', 'sql'],
      tooltip:     'Suggest Spark/SQL optimisations for this operation',
    },
    {
      title:       '⚡ Convert to DataFrame API',
      command:     'aiForge.databricks.convertToDataFrame',
      linePattern: /spark\.sql\(/,
      languages:   ['python'],
      tooltip:     'Convert this SQL string to the equivalent DataFrame API',
    },
    {
      title:       '⚡ Add DLT decorator',
      command:     'aiForge.databricks.addDltDecorator',
      linePattern: /^def\s+\w+/,
      languages:   ['python'],
      tooltip:     'Wrap this function as a Delta Live Tables table or view',
    },
    {
      title:       '⚡ Add MLflow tracking',
      command:     'aiForge.databricks.addMlflowTracking',
      linePattern: /def\s+(train|fit|run|evaluate|model)\w*/i,
      languages:   ['python'],
      tooltip:     'Add MLflow experiment tracking to this training function',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '⚡ Databricks: Fix .collect() OOM risk',
      command:   'aiForge.databricks.fixCollect',
      kind:      'quickfix',
      diagnosticPattern: undefined,
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '⚡ Databricks: Replace Python UDF with built-in',
      command:   'aiForge.databricks.replaceUdf',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python'],
    },
    {
      title:     '⚡ Databricks: Add Unity Catalog 3-part name',
      command:   'aiForge.databricks.addUnityRef',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python', 'sql'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Optimise Spark performance',
      description: 'Add broadcast hints, remove unnecessary .collect(), fix UDFs',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Optimise this PySpark file for performance. Apply these rules:
- Replace .collect() on large DataFrames with aggregations or .limit().collect()
- Add broadcast() hints for small tables in joins
- Replace Python UDFs with equivalent pyspark.sql.functions
- Add .cache() where a DataFrame is reused 2+ times, with .unpersist() after use
- Use repartition/coalesce appropriately
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a PySpark performance expert. Return only the complete updated Python file.',
          instruction: 'Optimise Spark performance',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add Delta Lake patterns',
      description: 'Convert writes to Delta, add MERGE INTO for upserts, enable CDC',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Modernise this PySpark file to use Delta Lake best practices:
- Convert .format("parquet") or .format("csv") writes to .format("delta")
- Replace overwrite writes of incremental data with MERGE INTO patterns
- Add delta.enableChangeDataFeed where appropriate
- Add schema evolution (mergeSchema=True) to Delta writes
- Return ONLY the complete updated file.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a Delta Lake expert. Return only the complete updated Python file.',
          instruction: 'Add Delta Lake patterns',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add Unity Catalog references',
      description: 'Convert 2-part table names to 3-part catalog.schema.table format',
      extensions:  ['.py', '.sql'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Convert this ${lang} file to use Unity Catalog 3-part naming (catalog.schema.table).
- Replace any 2-part names (schema.table) with 3-part equivalents
- Replace dbfs:/ paths with /Volumes/catalog/schema/volume/ paths where appropriate
- Replace hive_metastore.schema.table with the Unity Catalog equivalent pattern
- If catalog name is unknown, use <catalog> as a placeholder
- Return ONLY the complete updated file.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are a Unity Catalog expert. Return only the complete updated file.',
          instruction: 'Add Unity Catalog references',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add MLflow experiment tracking',
      description: 'Wrap model training code with MLflow logging',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add MLflow experiment tracking to this Python file:
- Add mlflow.set_experiment() at the start
- Wrap training/fitting code in mlflow.start_run() context
- Add mlflow.log_param() for hyperparameters
- Add mlflow.log_metric() for evaluation metrics (loss, accuracy, F1, etc.)
- Log the trained model with the appropriate mlflow.<framework>.log_model()
- Add mlflow.autolog() if using sklearn, XGBoost, or PyTorch Lightning
- Return ONLY the complete updated file.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are an MLflow expert. Return only the complete updated Python file.',
          instruction: 'Add MLflow tracking',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Convert to Delta Live Tables',
      description: 'Wrap DataFrame functions as @dlt.table / @dlt.view with expectations',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Convert this PySpark file to a Delta Live Tables (DLT) pipeline:
- Add import dlt at the top
- Wrap each DataFrame-returning function with @dlt.table or @dlt.view decorator
- Replace spark.read with dlt.read() or dlt.read_stream() for intra-pipeline deps
- Add @dlt.expect() data quality expectations where values are filtered or validated
- Remove SparkSession initialization (DLT provides spark automatically)
- Return ONLY the complete updated file.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a Delta Live Tables expert. Return only the complete updated Python file.',
          instruction: 'Convert to DLT',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Databricks Notebook (PySpark)',
      description: 'PySpark notebook with SparkSession, Delta write, and best-practice structure',
      prompt: (wsPath) =>
        `Create a production-quality Databricks notebook as a Python file.
Include:
- Proper Databricks notebook header comments (# Databricks notebook source)
- SparkSession initialisation (spark already available in Databricks, but include the check)
- dbutils.widgets for parameterization (table_name, environment)
- A sample Bronze → Silver → Gold medallion architecture with Delta writes
- Delta MERGE INTO for the Silver layer (upsert pattern)
- OPTIMIZE and ZORDER calls at the end
- MLflow tracking for any model operations
- dbutils.secrets.get() for any credentials (never hardcoded)
- Proper error handling and structured logging
Generate as ## notebook_name.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Delta Live Tables pipeline',
      description: 'DLT pipeline with Bronze/Silver/Gold layers and data quality expectations',
      prompt: (wsPath) =>
        `Create a Delta Live Tables (DLT) pipeline Python file.
Include:
- import dlt at the top
- Bronze layer: @dlt.table reading from a source (Auto Loader cloudFiles or raw path)
- Silver layer: @dlt.table with transformations and @dlt.expect expectations for data quality
- Gold layer: @dlt.table with business-level aggregations
- At least one @dlt.view for an intermediate transformation
- Data quality expectations using @dlt.expect_or_drop and @dlt.expect_or_fail
- Use Unity Catalog 3-part table names (catalog.schema.table)
- Parameterize with pipeline parameters (not hardcoded values)
Generate as ## pipeline_name.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Databricks Asset Bundle (databricks.yml)',
      description: 'databricks.yml job definition with cluster config, tasks, and environments',
      prompt: (wsPath) =>
        `Create a complete Databricks Asset Bundle configuration (databricks.yml).
Include:
- bundle name and workspace host placeholder
- targets block for dev, staging, and prod environments with separate cluster policies
- A job with at least 3 tasks (Python wheel task, notebook task, DLT pipeline task)
- Job cluster definition with appropriate Spark version, autoscaling, and Photon enabled
- Task dependencies (depends_on)
- Job parameters with default values
- Email notifications on failure
- Permissions block with run_as service principal
Generate as ## databricks.yml then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Unity Catalog table DDL',
      description: 'CREATE TABLE DDL with UC 3-part name, column tags, and row-level security',
      prompt: (wsPath) =>
        `Create a complete Unity Catalog table DDL SQL file.
Include:
- CREATE TABLE with 3-part name (catalog.schema.table)
- Column definitions with appropriate Delta data types
- Column-level comments and tags (TAG key = 'value')
- Table-level properties (delta.enableChangeDataFeed, delta.autoOptimize)
- Row-level security policy using a row filter function
- Column masking policy for PII columns
- GRANT statements for appropriate roles (analyst, engineer, admin)
- OPTIMIZE ZORDER BY for common filter columns
Generate as ## create_table.sql then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Auto Loader ingestion job',
      description: 'Structured Streaming Auto Loader job from cloud storage to Delta',
      prompt: (wsPath) =>
        `Create a production Auto Loader (cloudFiles) ingestion job in Python.
Include:
- SparkSession configuration optimised for streaming
- spark.readStream.format("cloudFiles") with:
  - cloudFiles.format (json/csv/parquet — make it configurable via widget)
  - cloudFiles.schemaLocation for schema inference persistence
  - cloudFiles.inferColumnTypes = true
  - Appropriate path (use dbutils.widgets for source_path)
- Schema enforcement with rescued_data column
- Silver layer transformation with data quality checks
- writeStream with:
  - .format("delta") to Unity Catalog target table (3-part name)
  - checkpointLocation (use dbutils.widgets for checkpoint_path)
  - Trigger.AvailableNow for batch-incremental mode
  - outputMode("append")
- MLflow logging of ingestion metrics (records loaded, schema changes)
- Error handling with dead-letter table for malformed records
Generate as ## autoloader_job.py then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.databricks.explainJob',
      title: 'Databricks: Explain Spark Job',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain what this Databricks/Spark code does, including:
- What each transformation step accomplishes
- Any performance implications (shuffles, wide vs narrow transformations)
- Potential issues (e.g. .collect() on large data, Python UDFs, missing cache)
- Suggestions for improvement

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.databricks.optimiseQuery',
      title: 'Databricks: Optimise Query',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Databricks: Optimising…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimise this Spark/SQL code for performance and correctness. Apply:
- Broadcast hints for small tables
- Replace .collect() with aggregations
- Replace Python UDFs with built-in functions
- Add appropriate partitioning/bucketing hints
- Fix any anti-patterns

Return ONLY the optimised code block, no explanation.

\`\`\`
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimise Spark query',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'Databricks: Optimised code ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimised version:\n\`\`\`python\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.databricks.convertToDataFrame',
      title: 'Databricks: Convert SQL → DataFrame API',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this spark.sql() query to the equivalent DataFrame API, or vice versa.
Preserve all logic, column names, and filters exactly.

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.convertToDelta',
      title: 'Databricks: Convert to Delta Lake',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert the data writes in this file to Delta Lake format:
- Change .format("parquet")/.format("csv") to .format("delta")
- Replace overwrite patterns with MERGE INTO where appropriate
- Add schema evolution options

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.addDltDecorator',
      title: 'Databricks: Wrap as Delta Live Tables',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Wrap this function as a Delta Live Tables table or view.
Add appropriate @dlt.table or @dlt.view decorator, replace spark.read with dlt.read(),
and add @dlt.expect data quality expectations based on the logic.

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.addMlflowTracking',
      title: 'Databricks: Add MLflow Tracking',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add MLflow experiment tracking to this training/modelling code.
Wrap training in mlflow.start_run(), log hyperparameters with mlflow.log_param(),
log metrics with mlflow.log_metric(), and log the model with the appropriate log_model().

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.fixCollect',
      title: 'Databricks: Fix .collect() OOM Risk',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Find all .collect() calls in this file and refactor them to avoid OOM risk.
Replace large .collect() with aggregations, streaming writes, or .limit(n).collect() where only samples are needed.
Explain why each change was made.

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.replaceUdf',
      title: 'Databricks: Replace Python UDF with Built-in',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Replace Python UDFs in this code with equivalent pyspark.sql.functions or Pandas UDFs.
Python UDFs are slow (row-by-row Python serialisation). Prefer:
- Built-in pyspark.sql.functions (F.regexp_replace, F.when, F.date_format, etc.)
- Pandas UDFs (@pandas_udf) when a custom function is truly necessary

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.addUnityRef',
      title: 'Databricks: Add Unity Catalog 3-Part Names',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert all table references in this file to Unity Catalog 3-part names (catalog.schema.table).
Replace any 2-part names and dbfs:/ paths with UC equivalents.
If catalog name is unknown, use <catalog> as a placeholder and explain.

\`\`\`
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.databricks.generateJobYaml',
      title: 'Databricks: Generate Job YAML',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete Databricks Job YAML (databricks.yml / Databricks Asset Bundle format)
for the following Python code. Include:
- Appropriate cluster config with Photon enabled
- Task definition pointing to this file
- Widget parameters mapped to job parameters
- Email notification on failure
- Separate dev and prod targets

${code ? `\`\`\`python\n${code}\n\`\`\`` : '(No file open — generate a template)'}`,
          'new'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => `⚡ ${this._envType}`,
  };
}
