/**
 * plugins/jupyter.ts — Jupyter Notebook plugin for Evolve AI
 *
 * Activates when the workspace contains .ipynb files, jupyter_notebook_config.py,
 * or a .jupyter/ directory.
 * Contributes:
 *  - contextHooks       : notebook file list with cell counts, kernel specs
 *  - systemPromptSection: full Jupyter domain knowledge (~2.5KB)
 *  - codeLensActions    : Explain Notebook, Add Documentation (above # %% markers)
 *  - codeActions        : Add markdown cell, convert to notebook format, add cell metadata
 *  - transforms         : Add documentation cells, clean notebook outputs
 *  - templates          : Data analysis, ML training, visualization notebooks
 *  - commands           : explainNotebook, addDocumentation, cleanOutputs, convertToNotebook, generateNotebook
 *  - statusItem         : shows notebook count
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

function globFiles(dir: string, patterns: RegExp[], maxFiles = 30): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.terraform', 'vendor']);
  function walk(d: string) {
    if (results.length >= maxFiles) { return; }
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) { continue; }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) { results.push(full); }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

function hasNotebooks(wsPath: string): boolean {
  try {
    const files = globFiles(wsPath, [/\.ipynb$/i], 5);
    return files.length > 0;
  } catch { return false; }
}

function hasJupyterConfig(wsPath: string): boolean {
  if (fs.existsSync(path.join(wsPath, 'jupyter_notebook_config.py'))) { return true; }
  if (fs.existsSync(path.join(wsPath, '.jupyter'))) { return true; }
  return false;
}

// ── Context data shapes ───────────────────────────────────────────────────────

interface NotebookInfo {
  file: string;
  cellCount: number;
  codeCells: number;
  markdownCells: number;
  kernelName: string;
  language: string;
}

interface NotebookContext {
  notebooks: NotebookInfo[];
  totalNotebooks: number;
  percentFormatFiles: number;
}

interface KernelContext {
  kernels: string[];
  hasKernelSpecs: boolean;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseNotebook(content: string): Omit<NotebookInfo, 'file'> {
  try {
    const nb = JSON.parse(content);
    const cells: unknown[] = Array.isArray(nb.cells) ? nb.cells : [];
    const codeCells     = cells.filter((c: unknown) => (c as { cell_type?: string }).cell_type === 'code').length;
    const markdownCells = cells.filter((c: unknown) => (c as { cell_type?: string }).cell_type === 'markdown').length;
    const kernelSpec    = (nb.metadata?.kernelspec ?? {}) as { name?: string; language?: string };
    return {
      cellCount:     cells.length,
      codeCells,
      markdownCells,
      kernelName:    kernelSpec.name ?? 'unknown',
      language:      kernelSpec.language ?? nb.metadata?.language_info?.name ?? 'python',
    };
  } catch {
    return { cellCount: 0, codeCells: 0, markdownCells: 0, kernelName: 'unknown', language: 'python' };
  }
}

function countPercentFormatFiles(wsPath: string): number {
  try {
    const pyFiles = globFiles(wsPath, [/\.py$/i], 50);
    let count = 0;
    for (const f of pyFiles) {
      try {
        const content = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (/^# %%/m.test(content)) { count++; }
      } catch { /* skip */ }
    }
    return count;
  } catch { return 0; }
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class JupyterPlugin implements IPlugin {
  readonly id          = 'jupyter';
  readonly displayName = 'Jupyter';
  readonly icon        = '$(notebook)';

  private _wsPath        = '';
  private _notebookCount = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) { return false; }
    const wsPath = ws.uri.fsPath;
    if (hasNotebooks(wsPath)) { return true; }
    if (hasJupyterConfig(wsPath)) { return true; }
    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    if (this._wsPath) {
      const notebooks = globFiles(this._wsPath, [/\.ipynb$/i], 50);
      this._notebookCount = notebooks.length;
    }

    console.log(`[Evolve AI] Jupyter plugin activated: ${this._notebookCount} notebook(s)`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'jupyter.notebooks',

      async collect(ws): Promise<NotebookContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const notebookPaths = globFiles(wsPath, [/\.ipynb$/i], 20);
        const notebooks: NotebookInfo[] = [];

        for (const f of notebookPaths) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            const info = parseNotebook(content);
            notebooks.push({ file: path.relative(wsPath, f), ...info });
          } catch { /* skip */ }
        }

        const percentFormatFiles = countPercentFormatFiles(wsPath);

        return {
          notebooks,
          totalNotebooks: notebooks.length,
          percentFormatFiles,
        };
      },

      format(data: unknown): string {
        const d = data as NotebookContext;
        if (d.totalNotebooks === 0 && d.percentFormatFiles === 0) { return ''; }
        const lines: string[] = ['## Jupyter Context'];

        if (d.notebooks.length > 0) {
          lines.push('### Notebooks:');
          for (const nb of d.notebooks.slice(0, 10)) {
            lines.push(
              `- \`${nb.file}\`: ${nb.cellCount} cells (${nb.codeCells} code, ${nb.markdownCells} markdown) — kernel: ${nb.kernelName} (${nb.language})`
            );
          }
        }

        if (d.percentFormatFiles > 0) {
          lines.push(`### Percent-format scripts: ${d.percentFormatFiles} file(s) with # %% cell markers`);
        }

        return lines.join('\n');
      },
    },
    {
      key: 'jupyter.kernels',

      async collect(ws): Promise<KernelContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const kernels = new Set<string>();

        // Parse kernel specs from all notebooks
        const notebookPaths = globFiles(wsPath, [/\.ipynb$/i], 20);
        for (const f of notebookPaths) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            const nb = JSON.parse(content) as { metadata?: { kernelspec?: { name?: string } } };
            const kName = nb.metadata?.kernelspec?.name;
            if (kName) { kernels.add(kName); }
          } catch { /* skip */ }
        }

        return {
          kernels: Array.from(kernels),
          hasKernelSpecs: kernels.size > 0,
        };
      },

      format(data: unknown): string {
        const d = data as KernelContext;
        if (!d.hasKernelSpecs) { return ''; }
        return `## Jupyter Kernels\nDetected kernels: ${d.kernels.join(', ')}`;
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Jupyter Notebook Expert Knowledge

You are an expert in Jupyter notebooks, IPython, and scientific computing workflows. Apply these guidelines in every response involving notebooks, .ipynb files, and percent-format scripts:

### Cell Types (nbformat)
- **code**: executable code cells — have source, outputs, and execution_count
- **markdown**: documentation cells — render as HTML, support LaTeX math (\`$...$\`, \`$$...$$\`)
- **raw**: unrendered cells used for nbconvert directives
- Cell metadata: \`tags\`, \`slideshow\`, \`collapsed\`, \`scrolled\`, \`jupyter\` namespace
- Output types: \`stream\` (stdout/stderr), \`display_data\` (rich output), \`execute_result\` (cell output), \`error\`

### Kernel Management
- Kernel specs live in \`~/.local/share/jupyter/kernels/\` or \`/usr/share/jupyter/kernels/\`
- Virtual envs: install with \`python -m ipykernel install --user --name myenv\`
- Conda envs: \`conda install ipykernel\` then register with ipykernel install
- Select kernel: Kernel menu → Change Kernel, or \`jupyter kernelspec list\`
- Restart kernel to clear all variables: always required after changing imports or redefining classes

### Magic Commands
- **Line magics** (\`%\`): \`%timeit\`, \`%run\`, \`%load\`, \`%who\`, \`%whos\`, \`%reset\`, \`%matplotlib inline\`, \`%load_ext\`, \`%autoreload\`
- **Cell magics** (\`%%\`): \`%%time\`, \`%%timeit\`, \`%%bash\`, \`%%sql\`, \`%%html\`, \`%%latex\`, \`%%writefile\`, \`%%capture\`
- \`%matplotlib inline\` — embed Matplotlib plots in the notebook output
- \`%matplotlib widget\` — interactive plots with ipympl
- \`%load_ext sql\` + \`%%sql\` — run SQL queries directly (requires ipython-sql)
- \`%autoreload 2\` — automatically reload changed modules without kernel restart

### IPython Features
- \`display(obj)\` — render any rich object (DataFrame, image, HTML, plot)
- \`HTML('...')\`, \`Image(url=...)\`, \`Audio(...)\`, \`Video(...)\` — rich media display
- \`clear_output(wait=True)\` — clear cell output for progress bars and animations
- \`interact(func, param=value)\` — instantly create interactive widgets
- \`IPython.display.FileLink(path)\` — downloadable file link
- \`?obj\` / \`??obj\` — inline docstrings and source inspection

### ipywidgets
- \`interact()\`, \`interactive()\` — auto-generate widgets from function signatures
- Widgets: \`IntSlider\`, \`FloatSlider\`, \`Dropdown\`, \`Select\`, \`Checkbox\`, \`Text\`, \`Textarea\`, \`Button\`
- Layout: \`VBox\`, \`HBox\`, \`Tab\`, \`Accordion\`, \`GridBox\`
- \`Output\` widget — capture and display output from callbacks
- \`observe()\` method — react to widget value changes
- Always call \`display(widget)\` to render widgets outside \`interact\`

### Percent Format Scripts (VS Code native)
- \`# %%\` — marks a code cell boundary
- \`# %% [markdown]\` — marks a markdown cell (content in multi-line comment or string)
- \`# %%\` with a label: \`# %% Data Loading\` — cell title visible in VS Code
- Run individual cells with Shift+Enter in VS Code's native notebook experience
- Convert to .ipynb: \`jupytext --to notebook script.py\` or use Jupytext extension

### nbformat Structure
- \`nbformat\`: 4, \`nbformat_minor\`: typically 4 or 5
- \`metadata.kernelspec\`: \`name\`, \`display_name\`, \`language\`
- \`metadata.language_info\`: \`name\`, \`version\`, \`codemirror_mode\`
- Cell \`id\` field (nbformat 4.5+): unique identifier per cell

### Best Practices
- **Restart and Run All** before sharing — ensures reproducibility with no hidden state
- Keep cells focused on one logical step; avoid very long cells
- Document assumptions and findings in markdown cells between code cells
- Use meaningful variable names that persist across cells — avoid single-letter names except loop variables
- Avoid side effects in cells that are frequently re-run (e.g., appending to lists)
- Use \`assert\` statements to validate intermediate results
- Clear outputs before committing to git (nbstripout or \`jupyter nbconvert --clear-output\`)
- Pin library versions in requirements.txt for reproducibility

### Papermill — Parameterized Execution
- Tag a cell with \`parameters\` tag to define default parameters
- Execute: \`papermill input.ipynb output.ipynb -p param_name value\`
- Use for batch runs, scheduled jobs, and CI/CD notebook pipelines
- Combine with scrapbook to store and retrieve notebook output values

### Common Notebook Patterns
- **EDA flow**: import → load data → inspect (shape, dtypes, describe) → visualize distributions → check missing values → correlation analysis
- **ML flow**: load → preprocess → train/test split → train model → evaluate metrics → confusion matrix / feature importance → save model
- **Visualization**: load data → aggregate → choose chart type → style → add labels/title → \`plt.tight_layout()\` → \`plt.savefig()\`
- **Reporting**: mix code outputs with markdown narrative → convert with nbconvert → \`jupyter nbconvert --to html notebook.ipynb\`
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(notebook) Explain notebook',
      command:     'aiForge.jupyter.explainNotebook',
      linePattern: /^# %%/,
      languages:   ['python'],
      tooltip:     'Explain this notebook cell and its purpose',
    },
    {
      title:       '$(notebook) Add documentation',
      command:     'aiForge.jupyter.addDocumentation',
      linePattern: /^# %%/,
      languages:   ['python'],
      tooltip:     'Add a markdown documentation cell above this code cell',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(notebook) Jupyter: Add markdown documentation cell',
      command:   'aiForge.jupyter.addDocumentation',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(notebook) Jupyter: Convert to notebook cell format',
      command:   'aiForge.jupyter.convertToNotebook',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(notebook) Jupyter: Add cell metadata (tags, slide type)',
      command:   'aiForge.jupyter.addDocumentation',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add documentation cells to notebook',
      description: 'Insert markdown cells with explanations above each code cell',
      extensions:  ['.ipynb'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add markdown documentation cells to this Jupyter notebook.
For each code cell that lacks a preceding markdown cell, insert a new markdown cell above it that:
- Summarizes what the code cell does in 1-2 sentences
- Explains any important parameters or variables
- Notes any side effects or dependencies on previous cells
Return ONLY the complete updated .ipynb JSON, no explanation.

File: ${filePath}
\`\`\`json
${content.slice(0, 8000)}
\`\`\``,
          }],
          system: 'You are a Jupyter notebook expert. Return only the complete updated .ipynb JSON.',
          instruction: 'Add documentation cells to notebook',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Clean notebook outputs',
      description: 'Remove all cell outputs and execution counts from the notebook',
      extensions:  ['.ipynb'],
      async apply(content, _filePath, _lang, _services): Promise<string> {
        try {
          const nb = JSON.parse(content) as {
            cells: Array<{
              cell_type: string;
              outputs?: unknown[];
              execution_count?: number | null;
            }>;
          };
          for (const cell of nb.cells) {
            if (cell.cell_type === 'code') {
              cell.outputs = [];
              cell.execution_count = null;
            }
          }
          return JSON.stringify(nb, null, 1);
        } catch {
          return content;
        }
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Data analysis notebook',
      description: 'EDA notebook: load, explore, visualize, and summarize a dataset',
      prompt: (wsPath) =>
        `Generate a complete Jupyter notebook for exploratory data analysis (EDA).
Include cells for:
- Imports (pandas, numpy, matplotlib, seaborn, plotly express)
- Load dataset (CSV or parquet) with configurable path
- Initial inspection: shape, dtypes, describe(), head()
- Missing value analysis: heatmap and percentage per column
- Distribution plots for numeric columns (histograms, box plots)
- Correlation matrix heatmap
- Categorical column value counts (bar charts)
- Key findings summary in a markdown cell
Format as a .ipynb JSON with code and markdown cells.
Use % format script style with # %% cell markers.
Workspace: ${wsPath}`,
    },
    {
      label:       'ML training notebook',
      description: 'End-to-end ML training notebook with preprocessing, training, and evaluation',
      prompt: (wsPath) =>
        `Generate a complete Jupyter notebook for machine learning model training.
Include cells for:
- Imports (sklearn, pandas, numpy, matplotlib)
- Data loading and initial inspection
- Preprocessing pipeline (imputation, scaling, encoding) using sklearn Pipeline
- Train/test split with stratification
- Model training (try at least 2 models: e.g., RandomForest and XGBoost/LogisticRegression)
- Cross-validation with CV score reporting
- Evaluation metrics (accuracy/F1/RMSE depending on task type)
- Confusion matrix or residual plot
- Feature importance visualization
- Model persistence with joblib
- Summary markdown cell with results
Format with # %% cell markers and include markdown cells explaining each section.
Workspace: ${wsPath}`,
    },
    {
      label:       'Visualization notebook',
      description: 'Notebook focused on creating publication-quality charts with matplotlib/plotly',
      prompt: (wsPath) =>
        `Generate a complete Jupyter notebook for data visualization.
Include cells for:
- Imports (matplotlib, seaborn, plotly, pandas)
- Sample or loaded dataset
- Matplotlib: line chart, scatter plot, bar chart, histogram — each with title/labels/style
- Seaborn: pairplot, heatmap, violinplot
- Plotly Express: interactive scatter, bar, line, and box plots
- Custom matplotlib theme setup (figure size, DPI, font settings)
- Saving figures to files (plt.savefig with tight_layout)
- ipywidgets interact() example for an interactive parameter exploration
Format with # %% cell markers and explanatory markdown cells.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.jupyter.explainNotebook',
      title: 'Evolve AI: Explain Notebook',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a notebook or percent-format script first'); return; }
        const code = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection)
          || editor.document.getText();
        const lang = editor.document.fileName.endsWith('.ipynb') ? 'json' : 'python';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Jupyter notebook in detail:
- What is the overall purpose and workflow?
- What does each section (group of cells) accomplish?
- What datasets, models, or APIs does it use?
- What are the key outputs or findings?
- Are there any potential issues (hidden state, missing restarts, hardcoded paths, missing error handling)?
- Suggest improvements for reproducibility and documentation

\`\`\`${lang}
${code.slice(0, 6000)}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.jupyter.addDocumentation',
      title: 'Evolve AI: Add Notebook Documentation',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a notebook or percent-format script first'); return; }
        const code = editor.document.getText();
        const isPy = editor.document.fileName.endsWith('.py');
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          isPy
            ? `Add markdown documentation cells to this percent-format notebook script.
For each # %% code cell, add a # %% [markdown] cell above it with:
- A brief title for the cell
- 1-2 sentences explaining what the code does
- Any important notes about parameters or dependencies
Return the complete updated script.

\`\`\`python
${code.slice(0, 6000)}
\`\`\``
            : `Add documentation to this Jupyter notebook.
For each code cell that lacks a preceding markdown cell, write a markdown cell explaining:
- What the cell does
- Key variables and their meaning
- Dependencies on previous cells
Return the complete updated .ipynb JSON.

\`\`\`json
${code.slice(0, 6000)}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.jupyter.cleanOutputs',
      title: 'Evolve AI: Clean Notebook Outputs',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a .ipynb file first'); return; }
        if (!editor.document.fileName.endsWith('.ipynb')) {
          vscode.window.showWarningMessage('This command only works on .ipynb files'); return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Jupyter: Cleaning outputs…', cancellable: false },
          async () => {
            try {
              const content = editor.document.getText();
              const nb = JSON.parse(content) as {
                cells: Array<{
                  cell_type: string;
                  outputs?: unknown[];
                  execution_count?: number | null;
                }>;
              };
              for (const cell of nb.cells) {
                if (cell.cell_type === 'code') {
                  cell.outputs = [];
                  cell.execution_count = null;
                }
              }
              const cleaned = JSON.stringify(nb, null, 1);
              await services.workspace.applyToActiveFile(cleaned);
              vscode.window.showInformationMessage('Jupyter: Notebook outputs cleared.');
            } catch {
              vscode.window.showErrorMessage('Jupyter: Failed to parse notebook JSON.');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.jupyter.convertToNotebook',
      title: 'Evolve AI: Convert Script to Notebook',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Python file first'); return; }
        if (!editor.document.fileName.endsWith('.py')) {
          vscode.window.showWarningMessage('This command converts .py files to notebook format'); return;
        }
        const code = editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this Python script to Jupyter percent-format notebook style.
- Add # %% cell markers to separate logical sections
- Add # %% [markdown] cells with descriptions before each code section
- Group imports together in the first # %% cell
- Add a # %% [markdown] title cell at the very top with the script's purpose
- Keep all existing code unchanged — only add cell markers and markdown cells
- Return the complete converted script

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.jupyter.generateNotebook',
      title: 'Evolve AI: Generate Notebook',
      async handler(_services): Promise<void> {
        const nbType = await vscode.window.showQuickPick(
          ['Data Analysis (EDA)', 'ML Training', 'Visualization', 'API Data Fetch', 'Text Processing (NLP)', 'Custom…'],
          { placeHolder: 'Select notebook type to generate' }
        );
        if (!nbType) { return; }

        let prompt = nbType;
        if (nbType === 'Custom…') {
          const custom = await vscode.window.showInputBox({ prompt: 'Describe the notebook to generate' });
          if (!custom) { return; }
          prompt = custom;
        }

        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete Jupyter notebook for: ${prompt}

Requirements:
- Use percent-format script style with # %% cell markers
- Alternate between # %% [markdown] documentation cells and # %% code cells
- Include all necessary imports in the first code cell
- Add a markdown title cell at the top explaining the notebook's purpose
- Cover the full workflow from data loading to final output/visualization
- Use realistic sample data or explain where to load data from
- Add markdown cells explaining each major step
- Follow best practices: meaningful variable names, clear outputs, no hidden state`,
          'new'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      if (this._notebookCount > 0) {
        return `$(notebook) Jupyter (${this._notebookCount} notebook${this._notebookCount !== 1 ? 's' : ''})`;
      }
      return '$(notebook) Jupyter';
    },
  };
}
