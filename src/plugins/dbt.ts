/**
 * plugins/dbt.ts — dbt (data build tool) stack plugin for Evolve AI
 *
 * Activates when the workspace contains dbt_project.yml, profiles.yml, or
 * a models/ directory with .sql files.
 * Contributes:
 *  - contextHooks      : dbt project config, model list, source definitions
 *  - systemPromptSection: deep dbt/Jinja SQL/materialization domain knowledge
 *  - codeLensActions   : Explain Model, Add Test, Generate Docs
 *  - codeActions       : Convert to incremental, add schema test, add docs, replace hardcoded ref
 *  - transforms        : Add schema tests, Convert to incremental, Generate documentation
 *  - templates         : Staging model, Source YAML, Custom test macro
 *  - commands          : explainModel, addTest, convertIncremental, generateDocs, optimiseModel, addSourceYaml
 *  - statusItem        : shows dbt project name
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

function hasDbtProjectYml(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'dbt_project.yml'));
}

function hasProfilesYml(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'profiles.yml'));
}

function hasModelsDir(wsPath: string): boolean {
  const modelsDir = path.join(wsPath, 'models');
  if (!fs.existsSync(modelsDir)) return false;
  try {
    const files = fs.readdirSync(modelsDir, { withFileTypes: true });
    return files.some(f => f.isFile() && f.name.endsWith('.sql'));
  } catch {
    return false;
  }
}

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', 'target', 'dbt_packages']);

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

// ── dbt_project.yml parser ────────────────────────────────────────────────────

interface DbtProjectConfig {
  name:           string;
  version:        string;
  profile:        string;
  modelPaths:     string[];
  testPaths:      string[];
  macroPaths:     string[];
  seedPaths:      string[];
  materializations: string[];
  rawContent:     string;
}

function parseDbtProjectYml(wsPath: string): DbtProjectConfig {
  const defaults: DbtProjectConfig = {
    name: 'unknown',
    version: '1.0.0',
    profile: 'default',
    modelPaths: ['models'],
    testPaths: ['tests'],
    macroPaths: ['macros'],
    seedPaths: ['seeds'],
    materializations: [],
    rawContent: '',
  };

  const filePath = path.join(wsPath, 'dbt_project.yml');
  if (!fs.existsSync(filePath)) return defaults;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    defaults.rawContent = content.slice(0, 3000);

    // Simple YAML key extraction (no full YAML parser needed)
    const nameMatch    = content.match(/^name:\s*['"]?([^'"\n\r]+)['"]?/m);
    const versionMatch = content.match(/^version:\s*['"]?([^'"\n\r]+)['"]?/m);
    const profileMatch = content.match(/^profile:\s*['"]?([^'"\n\r]+)['"]?/m);

    if (nameMatch)    defaults.name    = nameMatch[1].trim();
    if (versionMatch) defaults.version = versionMatch[1].trim();
    if (profileMatch) defaults.profile = profileMatch[1].trim();

    // Extract model-paths, test-paths, macro-paths, seed-paths
    const modelPathsMatch = content.match(/model-paths:\s*\[([^\]]+)\]/);
    const testPathsMatch  = content.match(/test-paths:\s*\[([^\]]+)\]/);
    const macroPathsMatch = content.match(/macro-paths:\s*\[([^\]]+)\]/);
    const seedPathsMatch  = content.match(/seed-paths:\s*\[([^\]]+)\]/);

    if (modelPathsMatch) {
      defaults.modelPaths = modelPathsMatch[1].split(',').map(s => s.replace(/['"]/g, '').trim());
    }
    if (testPathsMatch) {
      defaults.testPaths = testPathsMatch[1].split(',').map(s => s.replace(/['"]/g, '').trim());
    }
    if (macroPathsMatch) {
      defaults.macroPaths = macroPathsMatch[1].split(',').map(s => s.replace(/['"]/g, '').trim());
    }
    if (seedPathsMatch) {
      defaults.seedPaths = seedPathsMatch[1].split(',').map(s => s.replace(/['"]/g, '').trim());
    }

    // Extract materializations from +materialized config blocks
    const materializationMatches = content.matchAll(/\+materialized:\s*['"]?(\w+)['"]?/g);
    const mats = new Set<string>();
    for (const m of materializationMatches) {
      mats.add(m[1]);
    }
    defaults.materializations = [...mats];

    return defaults;
  } catch {
    return defaults;
  }
}

// ── Materialization detector for SQL model files ──────────────────────────────

function detectMaterialization(content: string): string {
  const m = content.match(/\{\{\s*config\s*\(([^)]+)\)\s*\}\}/);
  if (!m) return 'view'; // dbt default
  const inner = m[1];
  const mat = inner.match(/materialized\s*=\s*['"](\w+)['"]/);
  return mat ? mat[1] : 'view';
}

// ── Source schema.yml parser ──────────────────────────────────────────────────

interface DbtSource {
  name:   string;
  schema: string;
  tables: string[];
}

function parseSourceYamls(wsPath: string): DbtSource[] {
  const sources: DbtSource[] = [];
  const yamlFiles = globFiles(wsPath, [/schema\.ya?ml$/, /sources\.ya?ml$/], 20);

  for (const f of yamlFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      if (!content.includes('sources:')) continue;

      // Simple pattern matching for source definitions
      const sourceBlocks = content.matchAll(/- name:\s*['"]?([^'"\n\r]+)['"]?\s*\n(?:\s+schema:\s*['"]?([^'"\n\r]+)['"]?)?/g);
      for (const block of sourceBlocks) {
        const sourceName  = block[1].trim();
        const sourceSchema = block[2]?.trim() ?? sourceName;

        // Find tables under this source (simplified)
        const tableMatches = content.matchAll(/- name:\s*['"]?([^'"\n\r]+)['"]?\s*\n/g);
        const tables: string[] = [];
        for (const t of tableMatches) {
          tables.push(t[1].trim());
        }

        sources.push({ name: sourceName, schema: sourceSchema, tables: tables.slice(0, 10) });
        if (sources.length >= 10) break;
      }
    } catch { /* skip */ }
    if (sources.length >= 10) break;
  }

  return sources;
}

// ── Context data shapes ───────────────────────────────────────────────────────

interface DbtProjectContextData {
  projectName:     string;
  version:         string;
  profile:         string;
  modelPaths:      string[];
  materializations:string[];
  rawProjectYml:   string;
}

interface DbtModelsContextData {
  models: Array<{ path: string; materialization: string }>;
}

interface DbtSourcesContextData {
  sources: DbtSource[];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class DbtPlugin implements IPlugin {
  readonly id          = 'dbt';
  readonly displayName = 'dbt';
  readonly icon        = '$(database)';

  private _projectName = 'dbt';
  private _wsPath      = '';

  // ── detect ──────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    try {
      if (hasDbtProjectYml(wsPath)) return true;
      if (hasProfilesYml(wsPath))   return true;
      if (hasModelsDir(wsPath))      return true;
    } catch {
      // fs errors — treat as not detected
    }

    return false;
  }

  // ── activate ────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';
    if (this._wsPath) {
      const config = parseDbtProjectYml(this._wsPath);
      this._projectName = config.name;
    }
    console.log(`[Evolve AI] dbt plugin activated: project=${this._projectName}`);
    return [];
  }

  // ── contextHooks ────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'dbt.project',

      async collect(ws): Promise<DbtProjectContextData> {
        const wsPath = ws?.uri.fsPath ?? '';
        const config = parseDbtProjectYml(wsPath);
        return {
          projectName:      config.name,
          version:          config.version,
          profile:          config.profile,
          modelPaths:       config.modelPaths,
          materializations: config.materializations,
          rawProjectYml:    config.rawContent,
        };
      },

      format(data: unknown): string {
        const d = data as DbtProjectContextData;
        const lines = [
          `## dbt Project Context`,
          `- Project: ${d.projectName} (v${d.version})`,
          `- Profile: ${d.profile}`,
          `- Model paths: ${d.modelPaths.join(', ')}`,
        ];
        if (d.materializations.length > 0) {
          lines.push(`- Configured materializations: ${d.materializations.join(', ')}`);
        }
        if (d.rawProjectYml) {
          lines.push(`### dbt_project.yml (excerpt):\n\`\`\`yaml\n${d.rawProjectYml.slice(0, 600)}\n\`\`\``);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'dbt.models',

      async collect(ws): Promise<DbtModelsContextData> {
        const wsPath = ws?.uri.fsPath ?? '';
        const sqlFiles = globFiles(wsPath, [/\.sql$/], 40);
        const models: Array<{ path: string; materialization: string }> = [];

        for (const f of sqlFiles) {
          // Only include files under models/ directories
          const rel = path.relative(wsPath, f).replace(/\\/g, '/');
          if (!rel.startsWith('models/')) continue;
          try {
            const content = fs.readFileSync(f, 'utf8').slice(0, 2000);
            models.push({ path: rel, materialization: detectMaterialization(content) });
          } catch {
            models.push({ path: rel, materialization: 'view' });
          }
        }

        return { models };
      },

      format(data: unknown): string {
        const d = data as DbtModelsContextData;
        if (d.models.length === 0) return '';
        const lines = [`## dbt Models (${d.models.length} total)`];
        for (const m of d.models.slice(0, 20)) {
          lines.push(`- ${m.path} [${m.materialization}]`);
        }
        if (d.models.length > 20) {
          lines.push(`... and ${d.models.length - 20} more`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'dbt.sources',

      async collect(ws): Promise<DbtSourcesContextData> {
        const wsPath = ws?.uri.fsPath ?? '';
        const sources = parseSourceYamls(wsPath);
        return { sources };
      },

      format(data: unknown): string {
        const d = data as DbtSourcesContextData;
        if (d.sources.length === 0) return '';
        const lines = [`## dbt Sources`];
        for (const src of d.sources) {
          lines.push(`- source('${src.name}', ...) — schema: ${src.schema}, tables: ${src.tables.slice(0, 5).join(', ')}`);
        }
        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ─────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## dbt (data build tool) Expert Knowledge

You are an expert in dbt Core and dbt Cloud. Apply this domain knowledge in every response involving SQL models, YAML configurations, Jinja templating, and data transformation best practices.

### Jinja Templating in dbt SQL
- \`{{ ref('model_name') }}\` — reference another model (builds the DAG dependency)
- \`{{ source('source_name', 'table_name') }}\` — reference a raw source table
- \`{{ config(materialized='table', unique_key='id') }}\` — set model configuration inline
- \`{{ doc('description_name') }}\` — reference documentation blocks from .md files
- \`{{ this }}\` — reference the current model (useful in incremental models)
- \`{{ is_incremental() }}\` — conditional block for incremental logic
- \`{{ var('variable_name', 'default') }}\` — reference project variables
- \`{{ env_var('ENV_NAME') }}\` — reference environment variables (use sparingly)
- Jinja2 control flow: \`{% if %}\`, \`{% for %}\`, \`{% set %}\`, \`{% macro %}\` ... \`{% endmacro %}\`

### Materializations — When to Use Each
- **view** (default): No data stored; re-runs query on each use. Best for lightweight transformations and intermediate logic.
- **table**: Materializes as a physical table on every dbt run. Best for final reporting tables or when views are too slow.
- **incremental**: Inserts/updates only new rows since last run. Best for large tables where full refresh is expensive. Requires \`unique_key\` and \`is_incremental()\` filter.
- **ephemeral**: Not materialized; injected as a CTE into dependent models. Best for small reusable logic not worth persisting.

### Incremental Models — Best Practices
\`\`\`sql
{{ config(materialized='incremental', unique_key='id', on_schema_change='sync_all_columns') }}

SELECT id, name, created_at
FROM {{ source('raw', 'events') }}
{% if is_incremental() %}
  WHERE created_at > (SELECT MAX(created_at) FROM {{ this }})
{% endif %}
\`\`\`
- Always specify \`unique_key\` for merge strategies
- Use \`on_schema_change='sync_all_columns'\` to handle schema drift
- Incremental strategies: \`append\`, \`merge\` (default), \`insert_overwrite\`, \`delete+insert\`
- Use \`full_refresh\` flag when schema changes require rebuilding the table

### Tests
- **Schema tests** (in schema.yml): \`unique\`, \`not_null\`, \`relationships\`, \`accepted_values\`
- **Custom generic tests**: defined as Jinja macros in macros/ directory
- **Singular tests**: standalone SQL files in tests/ that return failing rows
- Run all tests: \`dbt test\`; run for one model: \`dbt test --select model_name\`
- Test YAML syntax:
\`\`\`yaml
models:
  - name: orders
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: status
        tests:
          - accepted_values:
              values: ['placed', 'shipped', 'completed']
\`\`\`

### Project Structure — Staging/Intermediate/Marts Pattern
- **staging/** (stg_): One-to-one with source tables. Light transforms: rename, cast, clean. Always use \`source()\`.
- **intermediate/** (int_): Join and aggregate staging models. Use \`ref()\`. Ephemeral or view materialization.
- **marts/** (fct_, dim_): Final business-facing tables. Table or incremental materialization. Named for business domain.

### Documentation
- Define descriptions in schema.yml using \`description:\` field on models and columns
- Use \`{{ doc('block_name') }}\` to reference documentation from .md files
- Generate and serve docs: \`dbt docs generate && dbt docs serve\`
- Exposures in schema.yml describe downstream uses (dashboards, ML models)

### Seeds
- CSV files in seeds/ directory, loaded with \`dbt seed\`
- Use for static reference data: country codes, mapping tables, lookup values
- Control column types in seed config block in dbt_project.yml

### Snapshots
- Capture slowly changing dimension (SCD Type 2) history
- Strategy: \`timestamp\` (uses updated_at column) or \`check\` (checks all columns)
- Stored in snapshots/ directory, run with \`dbt snapshot\`

### Macros and Packages
- Reusable Jinja SQL in macros/ directory
- \`dbt_utils\` package: \`dbt_utils.generate_surrogate_key()\`, \`dbt_utils.pivot()\`, date spine, etc.
- \`dbt_expectations\`: Great Expectations-style test macros
- Install packages via packages.yml and \`dbt deps\`

### Hooks and Operations
- \`on-run-start\` / \`on-run-end\`: SQL to run before/after all models
- \`pre-hook\` / \`post-hook\`: Model-level hooks for grants, clustering, etc.
- Use hooks for GRANT statements to maintain permissions after table creation

### Commands Reference
- \`dbt run\` — materialize all models
- \`dbt run --select staging+\` — run staging and all downstream models
- \`dbt test\` — run all tests
- \`dbt build\` — run + test + seed + snapshot in DAG order
- \`dbt compile\` — compile Jinja without running
- \`dbt docs generate && dbt docs serve\` — build and serve documentation
- \`dbt debug\` — check connection and configuration
`.trim();
  }

  // ── codeLensActions ──────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(database) Explain dbt Model',
      command:     'aiForge.dbt.explainModel',
      linePattern: /^\s*SELECT\s/i,
      languages:   ['sql', 'jinja-sql'],
      tooltip:     'Explain what this dbt model does, its dependencies, and materialization strategy',
    },
    {
      title:       '$(database) Add dbt Test',
      command:     'aiForge.dbt.addTest',
      linePattern: /\{\{\s*config\s*\(|^\s*SELECT\s/i,
      languages:   ['sql', 'jinja-sql'],
      tooltip:     'Generate schema tests (unique, not_null, relationships) for this model',
    },
    {
      title:       '$(database) Generate Docs',
      command:     'aiForge.dbt.generateDocs',
      linePattern: /\{\{\s*config\s*\(|^\s*SELECT\s/i,
      languages:   ['sql', 'jinja-sql'],
      tooltip:     'Generate YAML documentation for this dbt model',
    },
  ];

  // ── codeActions (lightbulb) ──────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:             '$(database) dbt: Convert to incremental materialization',
      command:           'aiForge.dbt.convertIncremental',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['sql', 'jinja-sql'],
    },
    {
      title:             '$(database) dbt: Add schema tests (unique/not_null)',
      command:           'aiForge.dbt.addTest',
      kind:              'quickfix',
      requiresSelection: false,
      languages:         ['sql', 'jinja-sql'],
    },
    {
      title:             '$(database) dbt: Add documentation block',
      command:           'aiForge.dbt.generateDocs',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['sql', 'jinja-sql', 'yaml'],
    },
    {
      title:             '$(database) dbt: Replace hardcoded table with {{ ref() }}',
      command:           'aiForge.dbt.optimiseModel',
      kind:              'refactor',
      requiresSelection: true,
      languages:         ['sql', 'jinja-sql'],
    },
  ];

  // ── transforms ───────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add schema tests for all models',
      description: 'Generate YAML test definitions (unique, not_null, relationships) for models',
      extensions:  ['.sql'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const modelName = path.basename(filePath, '.sql');
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Analyse this dbt SQL model and generate a schema.yml YAML block with tests.
Include:
- unique and not_null tests for the primary key column
- not_null tests for any clearly non-nullable columns
- relationships tests where foreign key patterns are visible
- accepted_values tests for status/type/category columns
- A description for the model and each column

Model name: ${modelName}
File: ${filePath}
\`\`\`sql
${content}
\`\`\`

Return ONLY the complete YAML block (models: - name: ...) with no explanation.`,
          }],
          system: 'You are a dbt expert. Return only the complete schema.yml YAML block.',
          instruction: 'Generate schema tests',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },

    {
      label:       'Convert models to incremental',
      description: 'Add incremental config, unique_key, and is_incremental() filter to the model',
      extensions:  ['.sql'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Convert this dbt SQL model to use incremental materialization.
- Add or update {{ config(materialized='incremental', unique_key='<primary_key_column>') }}
- Identify the most likely timestamp column for incremental filtering
- Add a {% if is_incremental() %} ... {% endif %} block filtering to new rows only
- Use {{ this }} to reference the current table in the filter
- Preserve all existing logic and column definitions
- Return ONLY the complete updated SQL file.

File: ${filePath}
\`\`\`sql
${content}
\`\`\``,
          }],
          system: 'You are a dbt expert. Return only the complete updated SQL model file.',
          instruction: 'Convert to incremental',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },

    {
      label:       'Generate documentation for all models',
      description: 'Add descriptions to models and columns in schema.yml format',
      extensions:  ['.sql'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const modelName = path.basename(filePath, '.sql');
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Generate comprehensive dbt documentation for this SQL model.
- Write a clear business-facing description for the model
- Write descriptions for each SELECT column
- Note any important business logic in the descriptions
- Format as a complete schema.yml models entry

Model name: ${modelName}
File: ${filePath}
\`\`\`sql
${content}
\`\`\`

Return ONLY the complete YAML schema entry.`,
          }],
          system: 'You are a dbt documentation expert. Return only the complete YAML schema entry.',
          instruction: 'Generate documentation',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'dbt staging model',
      description: 'Staging model with source() ref, config block, column renames, and type casts',
      prompt: (wsPath) =>
        `Create a production-quality dbt staging model SQL file.
Include:
- A {{ config(materialized='view') }} block at the top
- Source reference using {{ source('source_name', 'table_name') }}
- Systematic column renaming (snake_case), type casting, and light cleaning
- A surrogate key using dbt_utils.generate_surrogate_key() if appropriate
- Comments explaining the source and any non-obvious transformations
- Follow the stg_<source>__<table>.sql naming convention
- Include a with source as (...), renamed as (...) CTE pattern
Generate as ## stg_example__table.sql then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'dbt source YAML',
      description: 'schema.yml with source definitions, freshness checks, and column tests',
      prompt: (wsPath) =>
        `Create a complete dbt sources YAML file (schema.yml).
Include:
- sources: block with a database and schema
- At least 2 source tables with:
  - table-level descriptions
  - freshness check (loaded_at_field, warn_after, error_after)
  - column definitions with not_null and unique tests where appropriate
  - description for each column
- Follow dbt schema.yml conventions exactly
Generate as ## _sources.yml then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'dbt custom test macro',
      description: 'Custom generic test macro template for reusable data quality checks',
      prompt: (wsPath) =>
        `Create a dbt custom generic test macro.
Include:
- The macro in macros/tests/ directory
- Proper macro signature: {% macro test_<name>(model, column_name, ...) %}
- The test body as a SELECT that returns failing rows
- Configurable threshold or comparison value parameter
- A usage example in a comment block showing how to use it in schema.yml
- A corresponding schema.yml snippet showing the test applied to a model
Generate as ## macros/tests/test_example.sql then the complete content, then ## usage_example.yml with the schema snippet.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ─────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.dbt.explainModel',
      title: 'dbt: Explain Model',
      async handler(_services, _uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a dbt model file first'); return; }
        const code = (range instanceof vscode.Range)
          ? editor.document.getText(range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        const modelName = path.basename(editor.document.fileName, '.sql');
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this dbt model named "${modelName}":
- What data does it transform and from which sources?
- What is the materialization strategy and why is it appropriate?
- What are the key transformations and business logic?
- What downstream models likely depend on this?
- Are there any potential performance or data quality issues?

\`\`\`sql
${code}
\`\`\``,
          'chat'
        );
      },
    },

    {
      id:    'aiForge.dbt.addTest',
      title: 'dbt: Add Test',
      async handler(_services, _uri, _range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a dbt model file first'); return; }
        const code = editor.document.getText();
        const modelName = path.basename(editor.document.fileName, '.sql');
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate dbt schema tests for the model "${modelName}".
Analyse the SQL and produce a schema.yml YAML block with:
- unique and not_null tests for the primary key
- not_null tests for clearly required columns
- accepted_values tests for status/type/category columns
- relationships tests for foreign key columns (if patterns are visible)
- Descriptions for the model and all columns

\`\`\`sql
${code}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.dbt.convertIncremental',
      title: 'dbt: Convert to Incremental',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a dbt model file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this dbt model to use incremental materialization:
- Add {{ config(materialized='incremental', unique_key='<id_column>') }}
- Identify the best timestamp/date column for incremental filtering
- Add {% if is_incremental() %} WHERE <timestamp> > (SELECT MAX(<timestamp>) FROM {{ this }}) {% endif %}
- Explain the unique_key choice and incremental strategy selected

\`\`\`sql
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.dbt.generateDocs',
      title: 'dbt: Generate Documentation',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a dbt model file first'); return; }
        const modelName = path.basename(editor.document.fileName, '.sql');
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate complete dbt documentation for the model "${modelName}".
Produce a schema.yml YAML entry with:
- A clear business-facing model description
- Column descriptions for every column in the SELECT
- Test definitions (unique, not_null, accepted_values as appropriate)
- Note any important business logic or transformations in descriptions

\`\`\`sql
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },

    {
      id:    'aiForge.dbt.optimiseModel',
      title: 'dbt: Optimise Model',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a dbt model file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'dbt: Optimising model…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimise this dbt SQL model for correctness and performance:
- Replace any hardcoded table references with {{ ref('model_name') }} or {{ source('src', 'tbl') }}
- Ensure the config block uses an appropriate materialization for the model's size and usage
- Improve SQL readability: use CTEs instead of nested subqueries
- Add missing type casts and null handling
- Remove redundant joins or columns
- Ensure incremental models have a proper is_incremental() filter
- Return ONLY the complete updated SQL file, no explanation.

\`\`\`sql
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimise dbt model',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'dbt: Optimised model ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimised dbt model:\n\`\`\`sql\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },

    {
      id:    'aiForge.dbt.addSourceYaml',
      title: 'dbt: Generate Source YAML',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete dbt sources YAML (_sources.yml) for this SQL.
${code
  ? `Identify the raw source tables referenced and produce a sources: block with:
- source name, database, and schema
- table-level descriptions
- freshness checks (loaded_at_field, warn_after, error_after)
- Column definitions with not_null and unique tests

\`\`\`sql\n${code}\n\`\`\``
  : `Create a template _sources.yml with:
- sources: block with database and schema placeholders
- At least 2 example source tables with descriptions
- Freshness checks and column tests`}`,
          'new'
        );
      },
    },
  ];

  // ── statusItem ───────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => `$(database) dbt:${this._projectName}`,
  };
}
