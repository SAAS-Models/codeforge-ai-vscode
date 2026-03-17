/**
 * plugins/pytest.ts — pytest stack plugin for Evolve AI
 *
 * Activates when the workspace contains any pytest project marker.
 * Contributes:
 *  - contextHooks      : pytest config, fixture inventory, test structure
 *  - systemPromptSection: full pytest / testing domain knowledge
 *  - codeLensActions   : Generate Tests, Add Parametrize, Add Fixture
 *  - codeActions       : Add parametrize, convert unittest, add fixture, add pytest.raises
 *  - transforms        : Generate tests for all modules, Convert unittest to pytest
 *  - templates         : conftest.py, test module with fixtures, integration test with DB
 *  - commands          : generateTest, addFixture, addParametrize, convertUnittest,
 *                        addCoverage, explainTest
 *  - statusItem        : shows count of test files found
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

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.tox']);

function hasPytestIni(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'pytest.ini'));
}

function hasConftestPy(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'conftest.py'));
}

function hasPyprojectTomlWithPytest(wsPath: string): boolean {
  const f = path.join(wsPath, 'pyproject.toml');
  if (!fs.existsSync(f)) return false;
  try {
    return /\[tool\.pytest/i.test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}

function hasSetupCfgWithPytest(wsPath: string): boolean {
  const f = path.join(wsPath, 'setup.cfg');
  if (!fs.existsSync(f)) return false;
  try {
    return /\[tool:pytest\]/i.test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}

function hasToxIniWithPytest(wsPath: string): boolean {
  const f = path.join(wsPath, 'tox.ini');
  if (!fs.existsSync(f)) return false;
  try {
    return /\[pytest\]/i.test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}

// ── File walker ───────────────────────────────────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 30): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) { results.push(full); }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

// ── Context data shapes ───────────────────────────────────────────────────────

interface PytestConfigContext {
  configFile:    string | null;
  configContent: string | null;
  markers:       string[];
  plugins:       string[];
  testPaths:     string[];
}

interface PytestFixtureContext {
  conftestFiles:  string[];
  fixtureNames:   string[];
  fixtureScopes:  Record<string, string>;
}

interface PytestStructureContext {
  testFileCount: number;
  testDirs:      string[];
  totalTests:    number;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class PytestPlugin implements IPlugin {
  readonly id          = 'pytest';
  readonly displayName = 'pytest';
  readonly icon        = '$(beaker)';

  private _wsPath     = '';
  private _testFiles: string[] = [];

  // ── detect ──────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    if (hasPytestIni(wsPath))                        return true;
    if (hasConftestPy(wsPath))                       return true;
    if (hasPyprojectTomlWithPytest(wsPath))          return true;
    if (hasSetupCfgWithPytest(wsPath))               return true;
    if (hasToxIniWithPytest(wsPath))                 return true;

    return false;
  }

  // ── activate ─────────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    if (this._wsPath) {
      this._testFiles = globFiles(this._wsPath, [/^test_.+\.py$/, /^.+_test\.py$/], 200);
    }

    console.log(`[Evolve AI] pytest plugin activated — ${this._testFiles.length} test files found`);
    return [];
  }

  // ── deactivate ───────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._wsPath   = '';
    this._testFiles = [];
  }

  // ── contextHooks ─────────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [

    // Hook 1: pytest configuration
    {
      key: 'pytest.config',

      async collect(ws): Promise<PytestConfigContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        let configFile: string | null   = null;
        let configContent: string | null = null;

        for (const name of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            configFile = name;
            try {
              configContent = fs.readFileSync(full, 'utf8').slice(0, 1500);
            } catch { configContent = null; }
            break;
          }
        }

        // Extract markers
        const markers: string[] = [];
        if (configContent) {
          const markerMatches = configContent.match(/markers\s*=\s*([^\[]*?)(?=\n\[|\n\w|\s*$)/s);
          if (markerMatches) {
            const markerLines = markerMatches[1].split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of markerLines) {
              const name = line.split(':')[0].trim().split(' ')[0];
              if (name && /^\w+$/.test(name)) markers.push(name);
            }
          }
        }

        // Extract plugins from addopts or requirements
        const plugins: string[] = [];
        const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml'];
        for (const req of reqFiles) {
          const reqPath = path.join(wsPath, req);
          if (fs.existsSync(reqPath)) {
            try {
              const content = fs.readFileSync(reqPath, 'utf8');
              const pluginMatches = content.match(/pytest-[\w-]+/g);
              if (pluginMatches) {
                for (const p of pluginMatches) {
                  if (!plugins.includes(p)) plugins.push(p);
                }
              }
            } catch { /* skip */ }
          }
        }

        // Extract testpaths
        const testPaths: string[] = [];
        if (configContent) {
          const pathMatch = configContent.match(/testpaths\s*=\s*(.+)/);
          if (pathMatch) {
            testPaths.push(...pathMatch[1].split(/[\s,]+/).filter(Boolean));
          }
        }

        return { configFile, configContent, markers, plugins, testPaths };
      },

      format(data: unknown): string {
        const d = data as PytestConfigContext;
        const lines = ['## pytest Configuration'];

        if (d.configFile) {
          lines.push(`Config: ${d.configFile}`);
        }
        if (d.testPaths.length > 0) {
          lines.push(`Test paths: ${d.testPaths.join(', ')}`);
        }
        if (d.markers.length > 0) {
          lines.push(`Custom markers: ${d.markers.slice(0, 10).join(', ')}`);
        }
        if (d.plugins.length > 0) {
          lines.push(`Plugins detected: ${d.plugins.slice(0, 8).join(', ')}`);
        }

        return lines.join('\n');
      },
    },

    // Hook 2: fixture inventory
    {
      key: 'pytest.fixtures',

      async collect(ws): Promise<PytestFixtureContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        // Find all conftest.py files
        const conftestFiles = globFiles(wsPath, [/^conftest\.py$/], 20)
          .map(f => path.relative(wsPath, f));

        const fixtureNames: string[] = [];
        const fixtureScopes: Record<string, string> = {};

        // Parse each conftest.py for fixture definitions
        for (const rel of conftestFiles) {
          const full = path.join(wsPath, rel);
          try {
            const content = fs.readFileSync(full, 'utf8');
            // Match @pytest.fixture(...) followed by def name(
            const regex = /@pytest\.fixture(?:\(([^)]*)\))?\s*\ndef\s+(\w+)\s*\(/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(content)) !== null) {
              const decoratorArgs = match[1] ?? '';
              const name = match[2];
              if (!fixtureNames.includes(name)) {
                fixtureNames.push(name);
              }
              // Extract scope
              const scopeMatch = decoratorArgs.match(/scope\s*=\s*['"](\w+)['"]/);
              if (scopeMatch) {
                fixtureScopes[name] = scopeMatch[1];
              } else {
                fixtureScopes[name] = 'function'; // default scope
              }
            }
          } catch { /* skip */ }
        }

        return { conftestFiles, fixtureNames, fixtureScopes };
      },

      format(data: unknown): string {
        const d = data as PytestFixtureContext;
        const lines = ['## pytest Fixtures'];

        if (d.conftestFiles.length > 0) {
          lines.push(`conftest.py files: ${d.conftestFiles.slice(0, 5).join(', ')}`);
        }

        if (d.fixtureNames.length > 0) {
          const byScope: Record<string, string[]> = {};
          for (const name of d.fixtureNames) {
            const scope = d.fixtureScopes[name] ?? 'function';
            if (!byScope[scope]) byScope[scope] = [];
            byScope[scope].push(name);
          }
          for (const [scope, names] of Object.entries(byScope)) {
            lines.push(`${scope} scope: ${names.slice(0, 8).join(', ')}`);
          }
        } else {
          lines.push('No fixtures detected in conftest.py files');
        }

        return lines.join('\n');
      },
    },

    // Hook 3: test structure
    {
      key: 'pytest.structure',

      async collect(ws): Promise<PytestStructureContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        const testFiles = globFiles(wsPath, [/^test_.+\.py$/, /^.+_test\.py$/], 100);

        // Count tests per directory
        const dirCounts: Record<string, number> = {};
        let totalTests = 0;

        for (const f of testFiles) {
          const dir = path.relative(wsPath, path.dirname(f));
          if (!dirCounts[dir]) dirCounts[dir] = 0;

          try {
            const content = fs.readFileSync(f, 'utf8');
            const testCount = (content.match(/^def test_/gm) ?? []).length;
            dirCounts[dir] += testCount;
            totalTests += testCount;
          } catch { /* skip */ }
        }

        const testDirs = Object.keys(dirCounts).sort((a, b) => dirCounts[b] - dirCounts[a]);

        return {
          testFileCount: testFiles.length,
          testDirs:      testDirs.slice(0, 10),
          totalTests,
        };
      },

      format(data: unknown): string {
        const d = data as PytestStructureContext;
        const lines = ['## pytest Test Structure'];

        lines.push(`Test files: ${d.testFileCount}`);
        lines.push(`Total test functions: ${d.totalTests}`);

        if (d.testDirs.length > 0) {
          lines.push(`Test directories: ${d.testDirs.slice(0, 5).join(', ')}`);
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## pytest Expert Knowledge

You are an expert in pytest, Python testing best practices, and the broader testing ecosystem. Apply these rules in every response involving Python tests:

### Fixtures — scope and lifecycle
- Use function scope (default) for stateless or cheap fixtures; class/module/session for expensive setup (e.g. DB connections)
- yield fixtures — code before yield is setup, code after is teardown; always prefer over setup/teardown methods
- Use autouse=True sparingly — only for truly universal fixtures (e.g. resetting global state); explicit injection is clearer
- Factory fixtures return a function to create multiple instances with different parameters in one test
- Fixture factories pattern: return a callable instead of an object when tests need N independent instances

### Parametrize
- @pytest.mark.parametrize('arg', [val1, val2]) on test functions; @pytest.mark.parametrize('a,b', [(1,2),(3,4)]) for multiple args
- Use indirect=True to pass parameters through fixtures rather than directly — useful for DB fixtures with different states
- Use ids=['name1', 'name2'] for readable test IDs in the output; or a callable ids=str for auto-generation
- Stack multiple @pytest.mark.parametrize decorators to get a Cartesian product of test cases
- Avoid too many parametrize cases (>20) in a single decorator — split into logical groups instead

### Marks
- @pytest.mark.skip(reason='...') — unconditional skip
- @pytest.mark.skipif(condition, reason='...') — conditional skip (e.g. platform checks)
- @pytest.mark.xfail(reason='...', strict=False) — expected failures; strict=True fails if it passes
- Register custom marks in pytest.ini [markers] section to avoid PytestUnknownMarkWarning
- Filter by marks: pytest -m "slow" or pytest -m "not slow"; combine with "and", "or", "not"

### conftest.py patterns
- Place conftest.py at the right level: root for session-wide fixtures, subdirectory for scope-limited ones
- Session-scoped DB fixture: spin up once per test session, use transactions with rollback per test
- Use tmp_path (built-in function-scope) for temporary files; tmp_path_factory for module/session scope
- monkeypatch: use for environment variables, os.path, module attributes, dictionary keys
- caplog: assert on log messages emitted during tests — set caplog.set_level(logging.DEBUG)
- capsys: capture stdout/stderr from non-logger output

### Mocking
- monkeypatch.setattr(module, 'attr', mock_obj) — prefer for patching module-level attributes
- unittest.mock.patch / pytest-mock's mocker.patch — prefer for class methods and complex mock behaviour
- mocker.patch.object(instance, 'method') replaces a method on an existing instance
- Always assert that mocks were called: mock.assert_called_once_with(expected_args)
- Avoid mocking what you don't own — mock at the boundary of your system, not deep inside dependencies

### Assertions
- pytest rewrites assert statements — use plain assert, not self.assertEqual
- pytest.approx() for floating-point comparisons: assert result == pytest.approx(1.0, rel=1e-3)
- pytest.raises(ExceptionType) as a context manager: check exc_info.value for message matching
- pytest.warns(UserWarning) to assert on warnings emitted; use match= for message patterns
- Rich introspection: pytest shows local variable values on failure — keep tests short for clarity

### Test structure — AAA pattern
- Arrange / Act / Assert — one logical concept per test, one assert per test where possible
- Name tests: test_<function>_<scenario>_<expected_outcome> (e.g. test_divide_by_zero_raises_value_error)
- Keep tests independent: no shared mutable state, no test-ordering dependencies
- Use factories (factory_boy, model_bakery) or fixture factories for complex object creation

### Plugins ecosystem
- pytest-cov: coverage reporting — pytest --cov=src --cov-report=term-missing --cov-fail-under=80
- pytest-xdist: parallel execution — pytest -n auto; use tmp_path not shared temp dirs
- pytest-asyncio: async tests — @pytest.mark.asyncio or asyncio_mode = "auto" in config
- pytest-mock: mocker fixture wraps unittest.mock cleanly — auto-reset after each test
- pytest-benchmark: performance regression tests — pytest-benchmark fixture, compare across runs
- pytest-httpx / responses: mock HTTP calls; never make real HTTP calls in unit tests

### Coverage
- .coveragerc or [tool.coverage] in pyproject.toml for configuration
- Branch coverage: coverage run --branch; shows uncovered branches, not just lines
- --cov-fail-under=N fails CI if coverage drops below N — set to 80 as a minimum floor
- Exclude test files and __init__.py from coverage reports with omit = in .coveragerc
- Use # pragma: no cover for genuinely untestable lines (e.g. if __name__ == '__main__')

### Common mistakes to avoid
- Using unittest.TestCase with pytest — loses parametrize, fixture injection; convert to plain functions
- Hardcoding file paths in tests — use tmp_path or monkeypatch.chdir() instead
- Sharing mutable state via module-level variables — leads to ordering-dependent failures
- assert in setup/teardown — use pytest.raises or regular asserts in the test body instead
- Catching all exceptions in tests — let pytest catch and display them for better diagnostics
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(beaker) Generate pytest Tests',
      command:     'aiForge.pytest.generateTest',
      linePattern: /^def (?!test_)\w+\s*\(/,
      languages:   ['python'],
      tooltip:     'Generate pytest tests for this function',
    },
    {
      title:       '$(beaker) Add Parametrize',
      command:     'aiForge.pytest.addParametrize',
      linePattern: /^def test_\w+\s*\(/,
      languages:   ['python'],
      tooltip:     'Add @pytest.mark.parametrize decorator to this test function',
    },
    {
      title:       '$(beaker) Add Fixture',
      command:     'aiForge.pytest.addFixture',
      linePattern: /^def test_\w+\s*\(/,
      languages:   ['python'],
      tooltip:     'Extract setup code into a pytest fixture',
    },
  ];

  // ── codeActions ───────────────────────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:             '$(beaker) pytest: Add @pytest.mark.parametrize',
      command:           'aiForge.pytest.addParametrize',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(beaker) pytest: Convert unittest.TestCase to pytest style',
      command:           'aiForge.pytest.convertUnittest',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(beaker) pytest: Add fixture for repeated setup code',
      command:           'aiForge.pytest.addFixture',
      kind:              'refactor',
      requiresSelection: true,
      languages:         ['python'],
    },
    {
      title:             '$(beaker) pytest: Add pytest.raises context manager',
      command:           'aiForge.pytest.generateTest',
      kind:              'quickfix',
      diagnosticPattern: /Exception|Error|raises/,
      requiresSelection: false,
      languages:         ['python'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Generate pytest Tests',
      description: 'Generate comprehensive pytest tests for all public functions in a module',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Generate a comprehensive pytest test module for the following Python file.
Requirements:
- Use pytest fixtures for setup and teardown — not unittest setUp/tearDown
- Add @pytest.mark.parametrize for functions with multiple input cases
- Test happy path, edge cases, and error conditions for each public function
- Use pytest.raises() context manager for exception assertions
- Include at least one conftest.py fixture suggestion in a comment if shared setup is needed
- Use plain assert statements (not self.assert*)
- Follow the AAA (Arrange / Act / Assert) pattern in each test
- Return ONLY the complete test file with no explanation.

Source file: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a pytest expert. Return only the complete Python test file.',
          instruction: 'Generate pytest tests',
          mode: 'new',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Convert unittest to pytest',
      description: 'Convert unittest.TestCase classes to plain pytest functions with fixtures',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Convert this unittest.TestCase test file to modern pytest style.
Rules:
- Replace unittest.TestCase classes with plain test functions
- Replace self.setUp / self.tearDown with pytest fixtures using yield
- Replace self.assert* methods with plain assert statements
- Replace self.assertRaises with pytest.raises() context manager
- Replace self.assertAlmostEqual with pytest.approx()
- Move shared fixtures to conftest.py (include as a comment at the top of the file)
- Preserve all existing test logic and coverage exactly
- Add @pytest.mark.parametrize where repeated tests differ only by input data
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a pytest expert. Return only the complete updated Python test file.',
          instruction: 'Convert unittest to pytest',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'conftest.py with common fixtures',
      description: 'Session-scoped fixtures, DB setup, tmp_path helpers',
      prompt: (wsPath) =>
        `Create a production-quality conftest.py file for a Python project.
Include:
- A session-scoped database fixture that creates and tears down a test database
- A function-scoped fixture that wraps each test in a transaction with rollback
- A tmp_path_factory-based fixture for shared temporary directories
- A monkeypatch-based fixture for resetting environment variables after each test
- A caplog fixture helper with pre-configured log level
- A factory fixture pattern example (returns a callable to create instances)
- Proper type annotations on all fixtures
- Docstrings explaining each fixture's purpose and scope
Generate as ## conftest.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Test module with fixtures and parametrize',
      description: 'Demonstrates fixture injection, parametrize, marks',
      prompt: (wsPath) =>
        `Create a comprehensive example pytest test module demonstrating best practices.
Include:
- Import and use of fixtures from conftest.py (inject by name)
- @pytest.mark.parametrize with multiple arguments and custom ids
- @pytest.mark.parametrize stacked for a Cartesian product of cases
- @pytest.mark.skip and @pytest.mark.skipif examples with reasons
- @pytest.mark.xfail with strict=False and a comment explaining when it applies
- pytest.raises() context manager testing exception type and message
- pytest.approx() for floating-point assertions
- capsys usage to assert on printed output
- caplog usage to assert on log messages
- A factory fixture that creates multiple independent objects in one test
- AAA (Arrange / Act / Assert) structure with inline comments labelling each section
Generate as ## test_example.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Integration test with database fixture',
      description: 'DB fixture, transactions, rollback pattern',
      prompt: (wsPath) =>
        `Create a pytest integration test module with a database fixture pattern.
Include:
- A session-scoped fixture that creates the DB schema (SQLite or SQLAlchemy in-memory)
- A function-scoped fixture that starts a transaction before each test and rolls back after
- At least 5 integration tests covering: create, read, update, delete, and a constraint violation
- Use of pytest.raises to test constraint violations
- @pytest.mark.parametrize for testing multiple record types
- Fixture dependency injection (function fixture depends on session fixture)
- A conftest.py section comment showing where these fixtures should live
- Proper type annotations and docstrings
Generate as ## test_integration.py then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.pytest.generateTest',
      title: 'pytest: Generate Tests',
      async handler(services, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Python file first'); return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'pytest: Generating tests…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate a comprehensive pytest test file for this module.
- Use pytest fixtures for setup (not unittest setUp)
- Add @pytest.mark.parametrize for functions with multiple input cases
- Test happy path, edge cases, and error conditions
- Use pytest.raises() for exception assertions
- Follow the AAA pattern and plain assert statements
Return the test file as ## test_<module_name>.py then the complete content.

\`\`\`python
${editor.document.getText()}
\`\`\``,
              }],
              system: sys,
              instruction: 'Generate pytest tests',
              mode: 'new',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
            const files  = services.workspace.parseMultiFileOutput(output, wsPath);
            await services.workspace.applyGeneratedFiles(files);
          }
        );
      },
    },
    {
      id:    'aiForge.pytest.addFixture',
      title: 'pytest: Extract pytest Fixture',
      async handler(services, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Extract the setup/teardown code in this test into a pytest fixture.
Determine the appropriate scope (function/class/module/session) based on what is being set up.
Use a yield fixture for teardown. Show where to place the fixture (inline or conftest.py).

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.pytest.addParametrize',
      title: 'pytest: Add Parametrize',
      async handler(services, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add @pytest.mark.parametrize to this test function.
Identify the input values and expected outputs, then generate a parametrized version with:
- Multiple representative test cases (happy path + edge cases)
- Custom ids for readable test output
- Preserve all existing logic exactly

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.pytest.convertUnittest',
      title: 'pytest: Convert unittest to pytest',
      async handler(services, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this unittest.TestCase test file to modern pytest style:
- Replace TestCase classes with plain test functions
- Replace setUp/tearDown with yield fixtures
- Replace self.assert* with plain assert statements and pytest.raises()
- Replace assertAlmostEqual with pytest.approx()
- Add @pytest.mark.parametrize where tests repeat with different inputs
- Preserve all existing test coverage exactly

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.pytest.addCoverage',
      title: 'pytest: Add Coverage Config',
      async handler(services, ...args: unknown[]): Promise<void> {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'pytest: Generating coverage config…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate pytest-cov coverage configuration for this project.
Include:
- A [tool.coverage.run] section in pyproject.toml (or .coveragerc if pyproject.toml is not used)
- branch = true for branch coverage
- source = [src_directory] pointing to the main package
- omit = ["*/tests/*", "*/conftest.py", "*/__init__.py"]
- A [tool.coverage.report] section with fail_under = 80 and show_missing = true
- A pytest.ini or [tool.pytest.ini_options] section with --cov flags in addopts
- A GitHub Actions CI snippet showing how to run tests with coverage in CI
Generate each as ## filename then the complete content.
Workspace: ${wsPath}`,
              }],
              system: sys,
              instruction: 'Add pytest coverage config',
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
      id:    'aiForge.pytest.explainTest',
      title: 'pytest: Explain Test',
      async handler(services, ...args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a test file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this pytest test code in detail:
- What is being tested (the system under test)
- What each fixture provides and at what scope
- What the parametrize cases cover and which edge cases are missing
- Whether the assertions are sufficient or could be improved
- Any anti-patterns or improvements to suggest

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => `$(beaker) ${this._testFiles.length} tests`,
  };
}
