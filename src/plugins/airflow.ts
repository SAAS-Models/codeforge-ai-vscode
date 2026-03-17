/**
 * plugins/airflow.ts — Apache Airflow stack plugin for Evolve AI
 *
 * Activates when the workspace contains airflow.cfg, a dags/ directory with
 * Python files, or Python files containing `from airflow` imports.
 * Contributes:
 *  - contextHooks      : DAG list, airflow.cfg settings, custom operators
 *  - systemPromptSection: TaskFlow API, operators, sensors, scheduling, XCom knowledge
 *  - codeLensActions   : Explain DAG, Add Sensor, Convert to TaskFlow
 *  - codeActions       : Convert operator, add retry policy, add SLA, add task docs
 *  - transforms        : Convert all DAGs to TaskFlow API, Add monitoring/alerting
 *  - templates         : TaskFlow DAG, Custom Operator, Branching + sensors DAG
 *  - commands          : explainDag, convertToTaskflow, addSensor, addRetryPolicy, generateDag, addMonitoring
 *  - statusItem        : shows DAG count
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

// ── Detection helpers ─────────────────────────────────────────────────────────

const AIRFLOW_IMPORT = /from airflow|import airflow/;

function hasAirflowCfg(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'airflow.cfg'));
}

function hasDagsDirectory(wsPath: string): boolean {
  const dagsDir = path.join(wsPath, 'dags');
  if (!fs.existsSync(dagsDir)) return false;
  try {
    const files = fs.readdirSync(dagsDir, { withFileTypes: true });
    return files.some(f => f.isFile() && f.name.endsWith('.py'));
  } catch {
    return false;
  }
}

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', 'logs', '.airflow']);

function globFiles(dir: string, patterns: RegExp[], maxFiles = 30): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (patterns.some(p => p.test(entry.name))) {
          results.push(full);
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

// ── DAG parser helpers ────────────────────────────────────────────────────────

interface DagInfo {
  file:     string;
  dagId:    string | null;
  schedule: string | null;
}

function parseDagFile(filePath: string, wsPath: string): DagInfo {
  const rel = path.relative(wsPath, filePath).replace(/\\/g, '/');
  let dagId:    string | null = null;
  let schedule: string | null = null;

  try {
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 4000);

    // Match dag_id in DAG() constructor or @dag decorator
    const dagIdMatch = content.match(/dag_id\s*=\s*['"]([^'"]+)['"]/);
    if (dagIdMatch) {
      dagId = dagIdMatch[1];
    } else {
      // Fallback: filename without extension
      dagId = path.basename(filePath, '.py');
    }

    // Match schedule / schedule_interval
    const schedMatch = content.match(/schedule(?:_interval)?\s*=\s*['"]([^'"]+)['"]/);
    if (schedMatch) {
      schedule = schedMatch[1];
    } else {
      const schedNone = content.match(/schedule(?:_interval)?\s*=\s*(None|timedelta\([^)]+\))/);
      if (schedNone) {
        schedule = schedNone[1];
      }
    }
  } catch { /* skip */ }

  return { file: rel, dagId, schedule };
}

// ── airflow.cfg parser ────────────────────────────────────────────────────────

interface AirflowConfigData {
  hasConfig:    boolean;
  executor:     string | null;
  databaseConn: string | null;
  dagFolder:    string | null;
  maxActiveRuns:string | null;
  rawExcerpt:   string;
}

function parseAirflowCfg(wsPath: string): AirflowConfigData {
  const defaults: AirflowConfigData = {
    hasConfig:    false,
    executor:     null,
    databaseConn: null,
    dagFolder:    null,
    maxActiveRuns:null,
    rawExcerpt:   '',
  };

  const cfgPath = path.join(wsPath, 'airflow.cfg');
  if (!fs.existsSync(cfgPath)) return defaults;

  try {
    const content = fs.readFileSync(cfgPath, 'utf8');
    defaults.hasConfig  = true;
    defaults.rawExcerpt = content.slice(0, 1500);

    const executorMatch       = content.match(/^executor\s*=\s*(.+)$/m);
    const dbConnMatch         = content.match(/^sql_alchemy_conn\s*=\s*(.+)$/m);
    const dagFolderMatch      = content.match(/^dags_folder\s*=\s*(.+)$/m);
    const maxActiveRunsMatch  = content.match(/^max_active_runs_per_dag\s*=\s*(.+)$/m);

    if (executorMatch)      defaults.executor      = executorMatch[1].trim();
    if (dbConnMatch)        defaults.databaseConn  = dbConnMatch[1].trim().replace(/:[^:@]+@/, ':***@');
    if (dagFolderMatch)     defaults.dagFolder     = dagFolderMatch[1].trim();
    if (maxActiveRunsMatch) defaults.maxActiveRuns = maxActiveRunsMatch[1].trim();

    return defaults;
  } catch {
    return defaults;
  }
}

// ── Context data shapes ───────────────────────────────────────────────────────

interface AirflowDagsContextData {
  dagCount: number;
  dags:     DagInfo[];
}

interface AirflowConfigContextData extends AirflowConfigData {}

interface AirflowOperatorsContextData {
  customOperators: string[];
  customSensors:   string[];
  customHooks:     string[];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class AirflowPlugin implements IPlugin {
  readonly id          = 'airflow';
  readonly displayName = 'Apache Airflow';
  readonly icon        = '$(play-circle)';

  private _wsPath   = '';
  private _dagCount = 0;

  // ── detect ──────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    try {
      if (hasAirflowCfg(wsPath))    return true;
      if (hasDagsDirectory(wsPath)) return true;

      // Scan up to 40 Python files for airflow imports
      const pyFiles = globFiles(wsPath, [/\.py$/], 40);
      for (const f of pyFiles) {
        try {
          const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
          if (AIRFLOW_IMPORT.test(sample)) return true;
        } catch { /* skip */ }
      }
    } catch { /* fs errors — treat as not detected */ }

    return false;
  }

  // ── activate ────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws      = vscode.workspace.workspaceFolders?.[0];
    this._wsPath  = ws?.uri.fsPath ?? '';

    if (this._wsPath) {
      const dagFiles = globFiles(path.join(this._wsPath, 'dags'), [/\.py$/], 50);
      const fallback = globFiles(this._wsPath, [/\.py$/], 50)
        .filter(f => {
          try {
            return AIRFLOW_IMPORT.test(fs.readFileSync(f, 'utf8').slice(0, 1000));
          } catch { return false; }
        });
      this._dagCount = dagFiles.length || fallback.length;
    }

    console.log(`[Evolve AI] Airflow plugin activated: ${this._dagCount} DAG file(s)`);
    return [];
  }

  // ── contextHooks ────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'airflow.dags',

      async collect(ws): Promise<AirflowDagsContextData> {
        const wsPath = ws?.uri.fsPath ?? '';

        // Look for DAGs in dags/ subdir first, then anywhere in project
        const dagsDir = path.join(wsPath, 'dags');
        let dagFiles: string[];

        if (fs.existsSync(dagsDir)) {
          dagFiles = globFiles(dagsDir, [/\.py$/], 30);
        } else {
          dagFiles = globFiles(wsPath, [/\.py$/], 50).filter(f => {
            try {
              return AIRFLOW_IMPORT.test(fs.readFileSync(f, 'utf8').slice(0, 1000));
            } catch { return false; }
          }).slice(0, 30);
        }

        const dags = dagFiles.map(f => parseDagFile(f, wsPath));
        return { dagCount: dags.length, dags };
      },

      format(data: unknown): string {
        const d = data as AirflowDagsContextData;
        if (d.dags.length === 0) return '';
        const lines = [`## Airflow DAGs (${d.dagCount} total)`];
        for (const dag of d.dags.slice(0, 15)) {
          const sched = dag.schedule ? ` [schedule: ${dag.schedule}]` : '';
          lines.push(`- ${dag.file} — dag_id: ${dag.dagId ?? '(unknown)'}${sched}`);
        }
        if (d.dags.length > 15) {
          lines.push(`... and ${d.dags.length - 15} more`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'airflow.config',

      async collect(ws): Promise<AirflowConfigContextData> {
        const wsPath = ws?.uri.fsPath ?? '';
        return parseAirflowCfg(wsPath);
      },

      format(data: unknown): string {
        const d = data as AirflowConfigContextData;
        if (!d.hasConfig) return '';
        const lines = ['## Airflow Config (airflow.cfg)'];
        if (d.executor)      lines.push(`- Executor: ${d.executor}`);
        if (d.dagFolder)     lines.push(`- DAGs folder: ${d.dagFolder}`);
        if (d.maxActiveRuns) lines.push(`- Max active runs per DAG: ${d.maxActiveRuns}`);
        return lines.join('\n');
      },
    },

    {
      key: 'airflow.operators',

      async collect(ws): Promise<AirflowOperatorsContextData> {
        const wsPath = ws?.uri.fsPath ?? '';
        const customOperators: string[] = [];
        const customSensors:   string[] = [];
        const customHooks:     string[] = [];

        // Look for custom operators in plugins/ directory
        const pluginsDir = path.join(wsPath, 'plugins');
        if (fs.existsSync(pluginsDir)) {
          const pyFiles = globFiles(pluginsDir, [/\.py$/], 20);
          for (const f of pyFiles) {
            try {
              const content = fs.readFileSync(f, 'utf8').slice(0, 3000);
              const filename = path.basename(f, '.py');

              if (/class\s+\w+Operator\s*\(/.test(content)) {
                customOperators.push(filename);
              }
              if (/class\s+\w+Sensor\s*\(/.test(content)) {
                customSensors.push(filename);
              }
              if (/class\s+\w+Hook\s*\(/.test(content)) {
                customHooks.push(filename);
              }
            } catch { /* skip */ }
          }
        }

        return { customOperators, customSensors, customHooks };
      },

      format(data: unknown): string {
        const d = data as AirflowOperatorsContextData;
        const all = [...d.customOperators, ...d.customSensors, ...d.customHooks];
        if (all.length === 0) return '';
        const lines = ['## Custom Airflow Components (plugins/)'];
        if (d.customOperators.length > 0) lines.push(`- Custom operators: ${d.customOperators.join(', ')}`);
        if (d.customSensors.length > 0)   lines.push(`- Custom sensors: ${d.customSensors.join(', ')}`);
        if (d.customHooks.length > 0)     lines.push(`- Custom hooks: ${d.customHooks.join(', ')}`);
        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ─────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Apache Airflow Expert Knowledge

You are an expert in Apache Airflow 2.x. Apply this domain knowledge in every response involving DAGs, operators, sensors, hooks, scheduling, and pipeline orchestration.

### TaskFlow API (Airflow 2.0+) — Preferred Approach
- Use the \`@task\` decorator to define Python tasks — XCom push/pull is automatic and type-checked
- Use \`@dag\` decorator to define DAGs instead of the \`DAG()\` context manager
- TaskFlow functions pass return values directly as arguments to downstream tasks (no manual XCom)
- Supported: \`@task.python\`, \`@task.bash\`, \`@task.branch\`, \`@task.short_circuit\`
- Example:
  \`\`\`python
  from airflow.decorators import dag, task
  from datetime import datetime

  @dag(schedule='@daily', start_date=datetime(2024, 1, 1), catchup=False)
  def my_dag():
      @task
      def extract() -> dict:
          return {'key': 'value'}

      @task
      def transform(data: dict) -> str:
          return data['key'].upper()

      transform(extract())

  my_dag()
  \`\`\`

### Classic Operators — Key Patterns
- **BashOperator**: \`bash_command='...'\ — avoid shell=True security issues, use absolute paths
- **PythonOperator**: use \`python_callable\` — avoid heavy imports at DAG-file level
- **EmailOperator**: configure SMTP in airflow.cfg; use \`{{ ds }}\` for template dates
- **BranchPythonOperator**: return task_id string(s) to follow; use \`trigger_rule='none_failed_min_one_success'\` on join tasks
- **ShortCircuitOperator**: return False to skip downstream tasks entirely

### Sensors
- **FileSensor**: polls for file existence — set \`poke_interval\` and \`timeout\` always
- **ExternalTaskSensor**: waits for another DAG/task; set \`allowed_states\` and \`failed_states\`
- **HttpSensor**: polls an HTTP endpoint; use \`response_check\` callable for custom success logic
- **SmartSensor (deprecated)**: prefer deferrable operators in Airflow 2.2+ for async waiting
- Deferrable operators use \`asyncio\` and free up worker slots — prefer over blocking sensors

### Hooks and Connections
- Inherit from \`BaseHook\` for custom hooks; use \`get_connection(conn_id)\` to retrieve credentials
- Connection types: \`postgres\`, \`mysql\`, \`http\`, \`s3\`, \`google_cloud_platform\`, \`slack\`, \`ssh\`
- Store extra config as JSON in the connection's \`extra\` field
- NEVER hardcode credentials — always use connection IDs or Airflow Variables (\`Variable.get()\`)
- Use \`@provide_session\` or the ORM for direct metadata DB access (advanced; usually not needed)

### XCom
- XCom is stored in the Airflow metadata database — keep values small (< 48 KB recommended)
- TaskFlow API handles XCom automatically via return values and function arguments
- Manual XCom: \`context['ti'].xcom_push(key='k', value=v)\` and \`xcom_pull(task_ids='t', key='k')\`
- For large data, write to external storage (S3, GCS, DB) and XCom the path/reference only
- Custom XCom backends (Airflow 2.1+): store XComs in S3/GCS by configuring \`[core] xcom_backend\`

### Scheduling and Data-Aware Scheduling
- Cron presets: \`@once\`, \`@hourly\`, \`@daily\`, \`@weekly\`, \`@monthly\`, \`@yearly\`
- Always set \`catchup=False\` unless you explicitly need historical backfills
- Use \`start_date\` as a static date (never \`datetime.now()\` — it changes every import)
- Data-aware scheduling (Datasets, Airflow 2.4+): \`schedule=[Dataset('s3://my-bucket/data')]\`
- Custom timetables: subclass \`Timetable\` for non-standard schedules (e.g. business-day-only)

### Best Practices
- **Idempotency**: tasks must produce the same result when re-run; use upserts not appends
- **Task atomicity**: one logical unit per task — avoid tasks that do too many things
- **No top-level DB calls**: database connections at DAG-file level cause excessive DAG bag parse load
- **Dynamic DAGs**: use \`globals()[dag_id] = dag\` pattern or factory functions; avoid importing heavy libs at top level
- **Default args**: define \`default_args\` dict with \`owner\`, \`retries\`, \`retry_delay\`, \`email_on_failure\`
- **SLA misses**: configure \`sla\` on tasks and \`sla_miss_callback\` on the DAG for alerting
- **Task documentation**: set \`doc_md\` on tasks and the DAG for self-documenting pipelines

### Testing
- \`dag.test()\` runs a DAG locally without a running Airflow instance (Airflow 2.5+)
- Test fixtures: use \`pytest\` with \`DagBag\` to validate DAG loading: \`assert len(dag_bag.import_errors) == 0\`
- CI pattern: load all DAGs in \`DagBag\`, assert no import errors, assert expected task count
- Unit-test operators by calling \`execute(context={})\` directly on the operator instance

### Common Pitfalls
- **DAG bag parsing time**: keep DAG file imports minimal — heavy imports slow the scheduler
- **Import errors**: always test \`DagBag\` in CI to catch import errors before deployment
- **Zombie tasks**: caused by worker crashes — configure \`[scheduler] zombie_task_threshold\`
- **catchup=True by default**: always explicitly set \`catchup=False\` for new DAGs unless you need it
- **datetime.now() in start_date**: produces a different value every import — always use a static date
- **Mutable default_args**: define \`default_args\` as a fresh dict each DAG, not a module-level singleton
`.trim();
  }

  // ── codeLensActions ──────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(play-circle) Explain DAG',
      command:     'aiForge.airflow.explainDag',
      linePattern: /DAG\(|@dag/,
      languages:   ['python'],
      tooltip:     'Explain what this Airflow DAG does, its schedule, and dependencies',
    },
    {
      title:       '$(play-circle) Add Sensor',
      command:     'aiForge.airflow.addSensor',
      linePattern: /@task|def \w+_task|Operator\(/,
      languages:   ['python'],
      tooltip:     'Add an Airflow sensor before this task to wait for a condition',
    },
    {
      title:       '$(play-circle) Convert to TaskFlow',
      command:     'aiForge.airflow.convertToTaskflow',
      linePattern: /Operator\(/,
      languages:   ['python'],
      tooltip:     'Convert this classic operator to the TaskFlow @task decorator API',
    },
  ];

  // ── codeActions (lightbulb) ──────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:             '$(play-circle) Airflow: Convert classic operator to TaskFlow @task',
      command:           'aiForge.airflow.convertToTaskflow',
      kind:              'refactor',
      requiresSelection: true,
      languages:         ['python'],
    },
    {
      title:             '$(play-circle) Airflow: Add retry policy (retries + retry_delay)',
      command:           'aiForge.airflow.addRetryPolicy',
      kind:              'quickfix',
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(play-circle) Airflow: Add SLA miss callback',
      command:           'aiForge.airflow.addMonitoring',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(play-circle) Airflow: Add task documentation (doc_md)',
      command:           'aiForge.airflow.addSensor',
      kind:              'refactor',
      requiresSelection: true,
      languages:         ['python'],
    },
  ];

  // ── transforms ───────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Convert all DAGs to TaskFlow API',
      description: 'Rewrite classic DAG definitions to use @dag and @task decorators',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Convert this Apache Airflow DAG file to use the TaskFlow API (Airflow 2.0+):
- Replace the DAG() context manager with the @dag decorator
- Replace PythonOperator tasks with @task decorated functions
- Remove explicit xcom_push/xcom_pull — use return values and function arguments instead
- Keep BashOperator, sensors, and non-Python operators as-is (wrap in @task.python that calls them, or leave classic style)
- Preserve all DAG parameters: schedule, start_date, catchup, default_args, tags
- Preserve all task dependencies and business logic exactly
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are an Apache Airflow expert. Return only the complete updated Python file.',
          instruction: 'Convert to TaskFlow API',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },

    {
      label:       'Add monitoring/alerting to all DAGs',
      description: 'Add on_failure_callback, SLA miss handling, and task-level retry policies',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add production-grade monitoring and alerting to this Airflow DAG file:
- Add an \`on_failure_callback\` function to the DAG that logs the failure context
- Add \`sla_miss_callback\` to the DAG definition
- Add \`sla=timedelta(hours=2)\` to critical tasks (tasks likely to be the longest-running)
- Ensure \`default_args\` includes: retries=2, retry_delay=timedelta(minutes=5), email_on_failure=True
- Add \`doc_md\` to the DAG with a brief description of purpose and schedule
- Preserve all existing task logic and dependencies exactly
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are an Apache Airflow expert. Return only the complete updated Python file.',
          instruction: 'Add monitoring/alerting',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Airflow DAG with TaskFlow API',
      description: 'Production DAG using @dag and @task decorators with XCom, retries, and docs',
      prompt: (wsPath) =>
        `Create a production-quality Apache Airflow DAG using the TaskFlow API (Airflow 2.0+).
Include:
- @dag decorator with schedule, start_date (static date), catchup=False, tags, and doc_md
- At least 4 @task decorated functions representing an ETL pipeline (extract, validate, transform, load)
- Type-annotated task functions with proper return types
- Automatic XCom via return values passed as arguments between tasks
- A @task.branch for conditional logic (e.g., data quality check)
- default_args with retries=2, retry_delay=timedelta(minutes=5), email_on_failure=True
- on_failure_callback that logs the failure
- sla_miss_callback on the DAG
- sla=timedelta(hours=1) on the most critical task
- Task documentation (doc_md) on each task
- Airflow Variables for any configuration values (never hardcode)
- Connections used by ID (never hardcode credentials)
Generate as ## dags/example_taskflow_dag.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Custom Operator',
      description: 'Custom Airflow operator inheriting from BaseOperator with full hook support',
      prompt: (wsPath) =>
        `Create a production-quality custom Apache Airflow operator.
Include:
- A class inheriting from BaseOperator in plugins/ directory
- Proper __init__ with all configurable parameters and type annotations
- ui_color class attribute for visual distinction in the Airflow UI
- template_fields tuple for Jinja-templatable parameters
- execute(self, context) method with full implementation
- A companion custom Hook class inheriting from BaseHook
- get_connection(conn_id) usage — never hardcode credentials
- Proper error handling and logging using self.log
- A usage example in comments showing how to use the operator in a DAG
Generate as ## plugins/operators/example_operator.py then the complete content, then ## plugins/hooks/example_hook.py with the hook.
Workspace: ${wsPath}`,
    },
    {
      label:       'DAG with branching and sensors',
      description: 'DAG demonstrating BranchPythonOperator, ExternalTaskSensor, and conditional flows',
      prompt: (wsPath) =>
        `Create an Apache Airflow DAG that demonstrates branching logic and sensor usage.
Include:
- DAG() context manager (classic style) or @dag decorator — your choice
- An ExternalTaskSensor waiting for a dependency DAG to complete (with timeout and allowed_states)
- A FileSensor checking for an input file (with poke_interval and timeout)
- A BranchPythonOperator that routes to different tasks based on a condition
- At least two conditional branches with different downstream tasks
- A join task using trigger_rule='none_failed_min_one_success'
- Proper task dependencies using >> operators
- default_args with retries, retry_delay, and email_on_failure
- A ShortCircuitOperator example for skipping downstream tasks
- Task groups (TaskGroup) to organise related tasks visually
Generate as ## dags/branching_sensor_dag.py then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ─────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.airflow.explainDag',
      title: 'Evolve AI: Explain Airflow DAG',
      async handler(_services, _uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = (range instanceof vscode.Range)
          ? editor.document.getText(range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        const filename = path.basename(editor.document.fileName);
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Apache Airflow DAG from "${filename}":
- What does this pipeline do and what is its business purpose?
- What is the schedule and what does catchup=False/True mean for it?
- What are the tasks and their dependencies?
- What data sources and destinations are involved?
- Are there any performance, reliability, or best-practice issues to address?

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },

    {
      id:    'aiForge.airflow.convertToTaskflow',
      title: 'Evolve AI: Convert to TaskFlow API',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open an Airflow DAG file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this Airflow code to the TaskFlow API (Airflow 2.0+):
- Replace PythonOperator with @task decorated functions
- Replace the DAG() context manager with the @dag decorator
- Remove explicit xcom_push/xcom_pull — use return values instead
- Preserve all business logic, task dependencies, and DAG parameters

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.airflow.addSensor',
      title: 'Evolve AI: Add Airflow Sensor',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open an Airflow DAG file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add an appropriate Airflow sensor to this DAG code.
Based on the pipeline's inputs and dependencies, recommend and add:
- The right sensor type (FileSensor, ExternalTaskSensor, HttpSensor, S3KeySensor, etc.)
- Proper poke_interval and timeout settings
- mode='reschedule' for sensors that wait a long time (to free worker slots)
- Connection ID reference (never hardcoded credentials)

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.airflow.addRetryPolicy',
      title: 'Evolve AI: Add Retry Policy',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open an Airflow DAG file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add a robust retry policy to this Airflow DAG:
- Add to default_args: retries=2, retry_delay=timedelta(minutes=5)
- Add retry_exponential_backoff=True for tasks that call external APIs
- Add max_retry_delay=timedelta(hours=1) where exponential backoff is enabled
- Identify tasks that should NOT retry (e.g. non-idempotent inserts) and set retries=0
- Add on_retry_callback logging where helpful
- Return the complete updated file.

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.airflow.generateDag',
      title: 'Evolve AI: Generate Airflow DAG',
      async handler(services): Promise<void> {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
        const description = await vscode.window.showInputBox({
          prompt:      'Describe the Airflow DAG to generate',
          placeHolder: 'e.g. Daily ETL from PostgreSQL to S3, transform with pandas, alert on failure',
        });
        if (!description) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Airflow: Generating DAG…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate a production-quality Apache Airflow DAG for the following use case:
${description}

Requirements:
- Use TaskFlow API (@dag, @task) where appropriate
- Include proper scheduling, catchup=False, start_date as static date
- Add default_args with retries=2, retry_delay, email_on_failure=True
- Add on_failure_callback for alerting
- Use Airflow Variables and Connections — never hardcode credentials
- Add doc_md to the DAG and key tasks
- Follow Airflow best practices (idempotent tasks, no top-level DB calls)
- Generate as ## dags/<descriptive_name>.py then the complete content.

Workspace: ${wsPath}`,
              }],
              system: sys,
              instruction: 'Generate Airflow DAG',
              mode: 'new',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const files  = services.workspace.parseMultiFileOutput(output, wsPath);
            await services.workspace.applyGeneratedFiles(files);
          }
        );
      },
    },

    {
      id:    'aiForge.airflow.addMonitoring',
      title: 'Evolve AI: Add DAG Monitoring',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open an Airflow DAG file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add production monitoring and alerting to this Airflow DAG:
- Add an on_failure_callback function that logs task context and sends an alert
- Add sla_miss_callback to the DAG that notifies on SLA violations
- Add sla=timedelta(hours=2) to the most critical/longest-running tasks
- Add doc_md to the DAG with purpose, schedule, and contact information
- Ensure email_on_failure=True and email_on_retry=False in default_args
- Add tags to the DAG for environment and team identification
- Return the complete updated file.

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
  ];

  // ── statusItem ───────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      const label = this._dagCount > 0 ? `${this._dagCount} DAG${this._dagCount !== 1 ? 's' : ''}` : 'Airflow';
      return `$(play-circle) ${label}`;
    },
  };
}
