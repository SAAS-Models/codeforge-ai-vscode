/**
 * plugins/fastapi.ts — FastAPI web framework plugin for Evolve AI
 *
 * Activates when the workspace contains a FastAPI project marker.
 * Contributes:
 *  - contextHooks      : route summary, Pydantic model inventory, dependency patterns
 *  - systemPromptSection: full FastAPI / Pydantic / async domain knowledge
 *  - codeLensActions   : Explain Endpoint, Add Validation, Add Test
 *  - codeActions       : Add response_model, Add HTTPException, Extract Depends, Add OpenAPI docs
 *  - transforms        : Add input validation, Add OpenAPI descriptions
 *  - templates         : CRUD router, Pydantic model, app with middleware, Auth dependency
 *  - commands          : explainEndpoint, addValidation, addResponseModel, generateCrud,
 *                        addAuth, addTest
 *  - statusItem        : shows endpoint count
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

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
]);

function hasFastapiInRequirements(wsPath: string): boolean {
  for (const name of ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt']) {
    const f = path.join(wsPath, name);
    if (!fs.existsSync(f)) continue;
    try {
      if (/\bfastapi\b/i.test(fs.readFileSync(f, 'utf8'))) return true;
    } catch { /* skip */ }
  }
  return false;
}

function hasFastapiInPyproject(wsPath: string): boolean {
  const f = path.join(wsPath, 'pyproject.toml');
  if (!fs.existsSync(f)) return false;
  try {
    return /\bfastapi\b/i.test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}

function hasFastapiInPipfile(wsPath: string): boolean {
  const f = path.join(wsPath, 'Pipfile');
  if (!fs.existsSync(f)) return false;
  try {
    return /\bfastapi\b/i.test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}

function hasFastapiImportInFile(wsPath: string): boolean {
  for (const name of ['main.py', 'app.py', 'application.py']) {
    const f = path.join(wsPath, name);
    if (!fs.existsSync(f)) continue;
    try {
      const content = fs.readFileSync(f, 'utf8');
      if (/from\s+fastapi\s+import|import\s+fastapi/.test(content)) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ── File walker ───────────────────────────────────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 40): string[] {
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

// ── Endpoint counting helper ───────────────────────────────────────────────────

function countEndpoints(wsPath: string): number {
  if (!wsPath) return 0;
  const pyFiles = globFiles(wsPath, [/\.py$/], 60);
  const routePattern = /@(?:app|router)\.(get|post|put|delete|patch|head|options)\s*\(/g;
  let count = 0;
  for (const f of pyFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const matches = content.match(routePattern);
      if (matches) count += matches.length;
    } catch { /* skip */ }
  }
  return count;
}

// ── Context data shapes ───────────────────────────────────────────────────────

interface FastAPIRoutesContext {
  routeFiles: string[];
  endpoints:  Array<{ method: string; path: string; fn: string; file: string }>;
}

interface FastAPIModelsContext {
  modelFiles:  string[];
  modelNames:  string[];
  fieldCounts: Record<string, number>;
}

interface FastAPIDepsContext {
  dependsUsages: string[];
  yieldDeps:     number;
  depFiles:      string[];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class FastAPIPlugin implements IPlugin {
  readonly id          = 'fastapi';
  readonly displayName = 'FastAPI';
  readonly icon        = '$(zap)';

  private _wsPath       = '';
  private _endpointCount = 0;

  // ── detect ───────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    if (hasFastapiInRequirements(wsPath))  return true;
    if (hasFastapiInPyproject(wsPath))     return true;
    if (hasFastapiInPipfile(wsPath))       return true;
    if (hasFastapiImportInFile(wsPath))    return true;

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    if (this._wsPath) {
      this._endpointCount = countEndpoints(this._wsPath);
    }

    console.log(`[Evolve AI] FastAPI plugin activated — ${this._endpointCount} endpoints found`);
    return [];
  }

  // ── deactivate ────────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._wsPath       = '';
    this._endpointCount = 0;
  }

  // ── contextHooks ──────────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [

    // Hook 1: route summary
    {
      key: 'fastapi.routes',

      async collect(ws): Promise<FastAPIRoutesContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const pyFiles = globFiles(wsPath, [/\.py$/], 60);

        const routePattern = /@(?:app|router)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
        const fnPattern    = /(?:async\s+)?def\s+(\w+)\s*\(/;

        const endpoints: FastAPIRoutesContext['endpoints'] = [];
        const routeFiles: string[] = [];

        for (const f of pyFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            if (!/@(?:app|router)\.(?:get|post|put|delete|patch)/.test(content)) continue;

            const relFile = path.relative(wsPath, f);
            routeFiles.push(relFile);

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              routePattern.lastIndex = 0;
              const m = routePattern.exec(line);
              if (m) {
                const method = m[1].toUpperCase();
                const routePath = m[2];
                // Look ahead for the def
                let fn = '(unknown)';
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                  const fnMatch = fnPattern.exec(lines[j]);
                  if (fnMatch) { fn = fnMatch[1]; break; }
                }
                if (endpoints.length < 30) {
                  endpoints.push({ method, path: routePath, fn, file: relFile });
                }
              }
            }
          } catch { /* skip */ }
        }

        return { routeFiles, endpoints };
      },

      format(data: unknown): string {
        const d = data as FastAPIRoutesContext;
        const lines = ['## FastAPI Routes'];

        if (d.routeFiles.length > 0) {
          lines.push(`Route files: ${d.routeFiles.slice(0, 6).join(', ')}`);
        }
        if (d.endpoints.length > 0) {
          lines.push(`Endpoints (${d.endpoints.length}):`);
          for (const ep of d.endpoints.slice(0, 15)) {
            lines.push(`  ${ep.method} ${ep.path} → ${ep.fn}() [${ep.file}]`);
          }
          if (d.endpoints.length > 15) {
            lines.push(`  … and ${d.endpoints.length - 15} more`);
          }
        } else {
          lines.push('No endpoints detected');
        }

        return lines.join('\n');
      },
    },

    // Hook 2: Pydantic model inventory
    {
      key: 'fastapi.models',

      async collect(ws): Promise<FastAPIModelsContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const pyFiles = globFiles(wsPath, [/\.py$/], 60);

        const modelNames: string[] = [];
        const fieldCounts: Record<string, number> = {};
        const modelFiles: string[] = [];

        const classPattern = /^class\s+(\w+)\s*\(\s*(?:Base)?Model\s*\)/gm;
        const fieldPattern = /^\s{4}(\w+)\s*:/gm;

        for (const f of pyFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            if (!/BaseModel|pydantic/.test(content)) continue;

            const relFile = path.relative(wsPath, f);

            let classMatch: RegExpExecArray | null;
            classPattern.lastIndex = 0;
            while ((classMatch = classPattern.exec(content)) !== null) {
              const name = classMatch[1];
              if (!modelNames.includes(name)) {
                modelNames.push(name);
                if (!modelFiles.includes(relFile)) {
                  modelFiles.push(relFile);
                }

                // Count fields in this class (rough heuristic)
                const classStart = classMatch.index;
                const nextClass  = content.indexOf('\nclass ', classStart + 1);
                const classBody  = content.slice(classStart, nextClass === -1 ? undefined : nextClass);
                const fieldMatches = classBody.match(fieldPattern) ?? [];
                fieldCounts[name] = fieldMatches.length;
              }
            }
          } catch { /* skip */ }
        }

        return { modelFiles, modelNames, fieldCounts };
      },

      format(data: unknown): string {
        const d = data as FastAPIModelsContext;
        const lines = ['## FastAPI Pydantic Models'];

        if (d.modelFiles.length > 0) {
          lines.push(`Model files: ${d.modelFiles.slice(0, 5).join(', ')}`);
        }
        if (d.modelNames.length > 0) {
          lines.push(`Models (${d.modelNames.length}):`);
          for (const name of d.modelNames.slice(0, 12)) {
            const fields = d.fieldCounts[name] ?? 0;
            lines.push(`  ${name} (${fields} field${fields !== 1 ? 's' : ''})`);
          }
          if (d.modelNames.length > 12) {
            lines.push(`  … and ${d.modelNames.length - 12} more`);
          }
        } else {
          lines.push('No Pydantic models detected');
        }

        return lines.join('\n');
      },
    },

    // Hook 3: dependency injection patterns
    {
      key: 'fastapi.dependencies',

      async collect(ws): Promise<FastAPIDepsContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const pyFiles = globFiles(wsPath, [/\.py$/], 60);

        const dependsUsages: string[] = [];
        let yieldDeps = 0;
        const depFiles: string[] = [];

        for (const f of pyFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            if (!content.includes('Depends')) continue;

            const relFile = path.relative(wsPath, f);

            // Find Depends() usage patterns
            const dependsPattern = /Depends\s*\(\s*(\w+)\s*\)/g;
            let m: RegExpExecArray | null;
            while ((m = dependsPattern.exec(content)) !== null) {
              const depName = m[1];
              if (!dependsUsages.includes(depName)) {
                dependsUsages.push(depName);
              }
              if (!depFiles.includes(relFile)) {
                depFiles.push(relFile);
              }
            }

            // Count yield-based deps
            const yieldPattern = /def\s+\w+\s*\([^)]*\)\s*(?:->\s*\w+\s*)?:[\s\S]*?yield/g;
            const yieldMatches = content.match(yieldPattern) ?? [];
            yieldDeps += yieldMatches.length;
          } catch { /* skip */ }
        }

        return { dependsUsages: dependsUsages.slice(0, 20), yieldDeps, depFiles };
      },

      format(data: unknown): string {
        const d = data as FastAPIDepsContext;
        const lines = ['## FastAPI Dependencies'];

        if (d.depFiles.length > 0) {
          lines.push(`Dependency files: ${d.depFiles.slice(0, 5).join(', ')}`);
        }
        if (d.dependsUsages.length > 0) {
          lines.push(`Depends() usages: ${d.dependsUsages.join(', ')}`);
        }
        if (d.yieldDeps > 0) {
          lines.push(`Yield dependencies: ${d.yieldDeps}`);
        }
        if (d.dependsUsages.length === 0 && d.yieldDeps === 0) {
          lines.push('No dependency injection patterns detected');
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## FastAPI Expert Knowledge

You are an expert in FastAPI, Pydantic v2, async Python, and REST API design best practices. Apply these rules in every response involving FastAPI:

### Route Decorators and Path Operations
- Use @app.get/post/put/delete/patch/head/options for path operations; prefer router objects for modular organisation
- Path parameters: @app.get('/items/{item_id}') with type-annotated fn param def get_item(item_id: int)
- Query parameters: declare as function params not in path — def list_items(skip: int = 0, limit: int = 100)
- Optional query params: use Optional[str] = None or str | None = None (Python 3.10+)
- Use APIRouter with prefix='/prefix' and tags=['tag'] to group related routes; include with app.include_router()
- Status codes: status_code=201 for creation, 204 for no-content delete; use status.HTTP_* constants
- response_model= filters response fields and drives OpenAPI schema — always set it for production routes

### Pydantic v2 Models
- BaseModel for request/response schemas; use model_validator and field_validator (v2 API, not @validator)
- Field(): Field(default=..., description='...', ge=0, le=100, min_length=1, max_length=255)
- ConfigDict: model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)
- Use model_config = ConfigDict(from_attributes=True) for ORM integration (replaces orm_mode)
- Annotated types: Annotated[str, Field(min_length=1)] for reusable field constraints
- model_dump(exclude_unset=True) when patching — avoids overwriting fields not provided
- Separate Input/Output/DB schemas: UserCreate (in), UserOut (response), UserInDB (with hashed_password)
- Never expose sensitive fields (password, tokens) in response models — use separate Out schemas

### Dependency Injection with Depends()
- Depends() creates a dependency graph; FastAPI resolves and caches within a request
- yield dependencies: code before yield is setup, code after is teardown (runs after response)
- Sub-dependencies: def dep_b(dep_a: str = Depends(get_dep_a)) — FastAPI resolves tree
- Class-based dependencies: class CommonQueryParams: def __init__(self, skip: int = 0, limit: int = 100)
- Use Annotated: def get_items(commons: Annotated[CommonQueryParams, Depends()])
- dependency_overrides in testing: app.dependency_overrides[get_db] = get_test_db
- Security dependencies: oauth2_scheme = OAuth2PasswordBearer(tokenUrl='/auth/token')

### Request Body and Parameters
- Body(): Body(embed=True) wraps single body param in a key — useful for single-model payloads
- Query(): Query(gt=0, le=1000) with validation constraints
- Path(): Path(..., title='Item ID', ge=1)
- Header(): Header() with automatic underscore-to-hyphen conversion
- File() + UploadFile: async file reading with await file.read(); always close with finally
- Form(): for form-encoded data (not JSON); cannot combine with JSON body in same endpoint
- Multiple body params: FastAPI creates a combined JSON object with each param as a key

### Middleware
- CORS: app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])
- GZip: app.add_middleware(GZipMiddleware, minimum_size=1000)
- Custom middleware: @app.middleware('http') async def my_middleware(request, call_next)
- Middleware order matters — outermost middleware runs first on request, last on response
- TrustedHostMiddleware for production to reject Host header spoofing

### Security
- OAuth2PasswordBearer + JWT: decode with python-jose or PyJWT; raise 401 on invalid token
- API key via Header or Query: use Security(get_api_key) for OpenAPI integration
- HTTPBearer: extracts Bearer token, returns HTTPAuthorizationCredentials
- Security scopes: SecurityScopes allows fine-grained permission checking per endpoint
- Never store plain passwords — hash with bcrypt (passlib) before storing
- HTTPException(status_code=401, detail='...', headers={'WWW-Authenticate': 'Bearer'})

### Background Tasks
- BackgroundTasks: inject BackgroundTasks in route, call background_tasks.add_task(fn, arg1, arg2)
- Background tasks run after response is sent — suitable for email, logging, notifications
- For long-running work use Celery, ARQ, or similar task queues — not BackgroundTasks
- Pass dependencies explicitly to background tasks — they cannot use Depends()

### OpenAPI / Documentation
- tags= on routes and routers organises the Swagger UI
- summary= for short description, description= for markdown-formatted longer description
- response_description= on decorator for 200 response description
- responses={404: {'description': 'Not found'}} for documenting non-default status codes
- Include examples in Field(examples=[...]) or using openapi_extra parameter
- deprecated=True marks endpoint as deprecated in docs without removing it

### Testing with TestClient
- from fastapi.testclient import TestClient; client = TestClient(app)
- Override dependencies: app.dependency_overrides[dep] = mock_dep; clean up after test
- Use pytest fixtures for client; session-scoped client for read-only tests
- Async testing with httpx.AsyncClient and anyio: pytest.mark.anyio or asyncio_mode='auto'
- Always test validation errors (422 Unprocessable Entity) alongside happy path

### WebSockets
- @app.websocket('/ws') async def ws_endpoint(websocket: WebSocket): await websocket.accept()
- Use try/finally to ensure websocket.close() on disconnect
- WebSocketDisconnect exception for clean client disconnection handling

### Lifespan Events (FastAPI 0.93+)
- from contextlib import asynccontextmanager; @asynccontextmanager async def lifespan(app): ...
- FastAPI(lifespan=lifespan) — replaces @app.on_event('startup'/'shutdown') (deprecated)
- Use for DB connection pools, ML model loading, cache warming

### pydantic-settings
- BaseSettings reads from environment variables and .env files automatically
- Settings(env_file='.env', case_sensitive=False) pattern; use lru_cache for singleton
- Nested settings: model_config = SettingsConfigDict(env_nested_delimiter='__')

### Best Practices
- Always set response_model to prevent accidental data leakage
- Use async def for I/O-bound routes; def for CPU-bound (runs in threadpool)
- Return typed dicts or Pydantic models — not raw dicts — for full validation
- Pagination: use cursor-based over offset for large datasets
- Version APIs with prefix /v1, /v2 via include_router
- Health check: GET /health returning {status: 'ok'} with no auth required
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(zap) Explain Endpoint',
      command:     'aiForge.fastapi.explainEndpoint',
      linePattern: /@(?:app|router)\.(get|post|put|delete|patch)/,
      languages:   ['python'],
      tooltip:     'Explain this FastAPI endpoint — parameters, response model, dependencies',
    },
    {
      title:       '$(zap) Add Validation',
      command:     'aiForge.fastapi.addValidation',
      linePattern: /^(?:async\s+)?def\s+\w+\s*\(/,
      languages:   ['python'],
      tooltip:     'Add Pydantic request validation to this route handler',
    },
    {
      title:       '$(zap) Add Endpoint Test',
      command:     'aiForge.fastapi.addTest',
      linePattern: /@(?:app|router)\.(get|post|put|delete|patch)/,
      languages:   ['python'],
      tooltip:     'Generate a pytest test for this endpoint using TestClient',
    },
  ];

  // ── codeActions ───────────────────────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:             '$(zap) FastAPI: Add response_model to endpoint',
      command:           'aiForge.fastapi.addResponseModel',
      kind:              'quickfix',
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(zap) FastAPI: Add HTTPException error handler',
      command:           'aiForge.fastapi.addValidation',
      kind:              'quickfix',
      diagnosticPattern: /HTTPException|status_code|raise/,
      requiresSelection: false,
      languages:         ['python'],
    },
    {
      title:             '$(zap) FastAPI: Extract dependency with Depends()',
      command:           'aiForge.fastapi.addValidation',
      kind:              'refactor',
      requiresSelection: true,
      languages:         ['python'],
    },
    {
      title:             '$(zap) FastAPI: Add OpenAPI documentation',
      command:           'aiForge.fastapi.explainEndpoint',
      kind:              'refactor',
      requiresSelection: false,
      languages:         ['python'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add input validation to all endpoints',
      description: 'Add Pydantic request body models and Field constraints to every route',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add comprehensive Pydantic v2 input validation to all FastAPI endpoints in this file.
Requirements:
- Create request body Pydantic models (BaseModel) for POST/PUT/PATCH routes that accept raw data
- Add Field() constraints (ge, le, min_length, max_length, pattern) to all model fields
- Add query parameter validation using Query() with appropriate constraints
- Add path parameter validation using Path() with appropriate constraints
- Use annotated types where beneficial for reusability
- Preserve all existing logic exactly — only add validation
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a FastAPI and Pydantic v2 expert. Return only the complete updated Python file.',
          instruction: 'Add FastAPI input validation',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add OpenAPI descriptions to all routes',
      description: 'Add summary, description, tags, and response documentation to every endpoint',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add comprehensive OpenAPI documentation to all FastAPI route decorators in this file.
Requirements:
- Add summary= (one-line description) to every route decorator
- Add description= (markdown multi-line) to routes that need explanation
- Add tags= lists to group related routes
- Add response_description= for the 200 OK response
- Add responses= dict documenting 404, 422, and any other relevant status codes
- Add deprecated=True only to routes that are marked as deprecated in comments
- Preserve all existing code exactly — only modify/add decorator arguments
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a FastAPI OpenAPI documentation expert. Return only the complete updated Python file.',
          instruction: 'Add OpenAPI documentation',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'FastAPI CRUD router',
      description: 'Full CRUD router with Pydantic models, DB dependency, and error handling',
      prompt: (wsPath) =>
        `Create a production-quality FastAPI CRUD router module.
Include:
- An APIRouter with prefix and tags
- Three Pydantic v2 models: ItemCreate (input), ItemUpdate (partial update), ItemOut (response)
  - Use Field() with description, ge/le/min_length constraints
  - ItemUpdate fields all Optional for partial updates
  - ItemOut includes id and timestamps
- GET /items with pagination (skip, limit with Query validation)
- GET /items/{item_id} with 404 HTTPException if not found
- POST /items returning 201 with ItemOut response_model
- PUT /items/{item_id} with full replacement
- PATCH /items/{item_id} using model_dump(exclude_unset=True) for partial update
- DELETE /items/{item_id} returning 204 with no body
- A get_db dependency stub using yield (async generator pattern)
- Proper async/await throughout
- Type annotations on everything
- Docstrings on the router and each endpoint
Generate as ## routers/items.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Pydantic model with validation',
      description: 'Pydantic v2 model with field validators, model validators, ConfigDict',
      prompt: (wsPath) =>
        `Create a comprehensive Pydantic v2 model example demonstrating best practices.
Include:
- A BaseModel with 8+ fields covering: str, int, float, bool, datetime, Optional, list, nested model
- Field() with: description, default, ge/le, min_length/max_length, pattern (regex)
- @field_validator for cross-field validation and normalisation (e.g. strip whitespace, normalise email)
- @model_validator(mode='after') for multi-field business rules
- ConfigDict with: str_strip_whitespace=True, validate_assignment=True, from_attributes=True
- An Annotated type alias for a reusable constrained string
- A nested model demonstrating composition
- A separate Out model that excludes sensitive fields (e.g. hashed_password)
- model_dump(exclude_unset=True) usage example in a comment
- Complete type annotations
Generate as ## models/item.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'FastAPI app with middleware',
      description: 'Full app setup with CORS, GZip, custom middleware, lifespan events',
      prompt: (wsPath) =>
        `Create a production-quality FastAPI application entrypoint.
Include:
- asynccontextmanager lifespan function with DB pool init/teardown
- FastAPI(lifespan=lifespan, title='...', version='0.1.0', description='...')
- CORS middleware with configurable origins from settings
- GZip middleware with minimum_size=1000
- TrustedHostMiddleware for production
- A custom request logging middleware using @app.middleware('http')
  that logs method, path, status code, and duration
- pydantic-settings BaseSettings class reading from environment/'.env'
  with lru_cache singleton pattern
- app.include_router() calls for at least 2 routers (items, users)
- /health endpoint returning {status: 'ok', version: '...'}
- Global exception handler for unhandled exceptions returning 500 JSON
- Proper async/await, type annotations, and docstrings
Generate as ## main.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Auth dependency (JWT)',
      description: 'JWT authentication dependency with OAuth2, token creation, and user extraction',
      prompt: (wsPath) =>
        `Create a production-quality JWT authentication module for FastAPI.
Include:
- OAuth2PasswordBearer scheme pointing at /auth/token
- Settings with SECRET_KEY, ALGORITHM (HS256), ACCESS_TOKEN_EXPIRE_MINUTES
- TokenData Pydantic model (sub: str, scopes: list[str])
- create_access_token(data, expires_delta) using python-jose or PyJWT
- get_current_user dependency: decode JWT, raise 401 on invalid/expired token
- get_current_active_user dependency: checks user.disabled flag
- verify_password and get_password_hash using passlib (bcrypt)
- POST /auth/token endpoint: OAuth2PasswordRequestForm, returns access_token + token_type
- Security scopes: SecurityScopes + security_scopes.scopes check in get_current_user
- HTTPException(401, headers={'WWW-Authenticate': 'Bearer ...'}) on auth failures
- A protected example endpoint using Annotated[User, Depends(get_current_active_user)]
- Complete type annotations and docstrings
Generate as ## auth/dependencies.py then ## auth/router.py with complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.fastapi.explainEndpoint',
      title: 'FastAPI: Explain Endpoint',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a FastAPI file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this FastAPI endpoint in detail:
- What HTTP method and path it handles
- All path, query, header, and body parameters and their types/constraints
- The response model — what fields are returned and excluded
- What dependencies (Depends) it uses and what they provide
- Any authentication/authorisation requirements
- What HTTP status codes it can return and when
- Potential improvements (missing response_model, missing validation, etc.)

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.fastapi.addValidation',
      title: 'FastAPI: Add Request Validation',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a FastAPI file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add comprehensive Pydantic v2 input validation to this FastAPI code.
- Create request body models with Field() constraints for POST/PUT/PATCH routes
- Add Query(), Path() constraints to query and path parameters
- Raise appropriate HTTPException (400/422) for business validation failures
- Extract reusable dependency for shared validation logic
- Return the updated code only, no explanation.

\`\`\`python
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.fastapi.addResponseModel',
      title: 'FastAPI: Add Response Model',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a FastAPI file first'); return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'FastAPI: Adding response models…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Add response_model= and appropriate Pydantic Out models to all FastAPI routes that are missing them.
Requirements:
- Create a separate *Out model for each entity that excludes sensitive fields
- Add response_model= to every route decorator
- Add status_code= with correct HTTP status codes (201 for POST, 204 for DELETE)
- Preserve all existing logic exactly
- Return ONLY the complete updated file.

\`\`\`python
${editor.document.getText()}
\`\`\``,
              }],
              system: sys,
              instruction: 'Add FastAPI response models',
              mode: 'edit',
            };
            const result = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            await services.workspace.applyToActiveFile(result);
          }
        );
      },
    },
    {
      id:    'aiForge.fastapi.generateCrud',
      title: 'FastAPI: Generate CRUD Router',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'FastAPI: Generating CRUD router…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate a production-quality FastAPI CRUD router for this workspace.
Include:
- APIRouter with prefix and tags
- Pydantic v2 models: Create, Update (all Optional), Out
- GET list with pagination, GET by id, POST (201), PUT, PATCH (partial), DELETE (204)
- get_db yield dependency stub
- HTTPException 404 for not found resources
- Complete type annotations and docstrings
Generate as ## routers/<resource>.py then the complete content.
Workspace: ${wsPath}`,
              }],
              system: sys,
              instruction: 'Generate CRUD router',
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
      id:    'aiForge.fastapi.addAuth',
      title: 'FastAPI: Add Authentication',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'FastAPI: Generating auth module…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate a JWT authentication module for this FastAPI project.
Include:
- OAuth2PasswordBearer + JWT token creation with python-jose
- get_current_user dependency decoding JWT, raising 401 on failure
- Password hashing with passlib bcrypt
- POST /auth/token endpoint
- Protected route example using Depends(get_current_user)
- Settings for SECRET_KEY and ALGORITHM
Generate as ## auth/dependencies.py then ## auth/router.py with complete content.
Workspace: ${wsPath}`,
              }],
              system: sys,
              instruction: 'Add FastAPI authentication',
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
      id:    'aiForge.fastapi.addTest',
      title: 'FastAPI: Generate Endpoint Test',
      async handler(services, ..._args: unknown[]): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a FastAPI file first'); return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'FastAPI: Generating endpoint tests…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate pytest tests for all FastAPI endpoints in this file using TestClient.
Requirements:
- from fastapi.testclient import TestClient
- Override any Depends() using app.dependency_overrides
- Test happy path (2xx), validation errors (422), not-found (404), and auth failures (401)
- Use pytest fixtures for the client and any test data setup
- Use @pytest.mark.parametrize for routes with multiple input scenarios
- Assert on status codes, response JSON structure, and headers
- Return the test file as ## test_<filename>.py then the complete content.

\`\`\`python
${editor.document.getText()}
\`\`\``,
              }],
              system: sys,
              instruction: 'Generate FastAPI endpoint tests',
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
  ];

  // ── statusItem ────────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => `$(zap) ${this._endpointCount} endpoints`,
  };
}
