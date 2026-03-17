/**
 * plugins/django.ts — Django stack plugin for Evolve AI
 *
 * Activates when the workspace contains any Django project marker.
 * Contributes:
 *  - contextHooks       : Django apps, models, key settings
 *  - systemPromptSection: full Django/DRF/ORM domain knowledge
 *  - codeLensActions    : Explain Model, Add Serializer, Add View
 *  - codeActions        : Add serializer, admin, URL pattern, migration
 *  - transforms         : Generate serializers, admin registrations, URL patterns
 *  - templates          : Model, DRF ViewSet+Serializer, URL config, management command
 *  - commands           : explainModel, addSerializer, addAdmin, addView, addUrls, addTest
 *  - statusItem         : shows count of detected Django apps
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

// ── Detection helpers ──────────────────────────────────────────────────────────

function hasDjangoInRequirements(wsPath: string): boolean {
  for (const req of ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile']) {
    const f = path.join(wsPath, req);
    if (fs.existsSync(f)) {
      const content = fs.readFileSync(f, 'utf8');
      if (/\bdjango\b/i.test(content)) return true;
    }
  }
  return false;
}

function hasManagePy(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, 'manage.py'));
}

function hasSettingsPyWithInstalledApps(wsPath: string): boolean {
  // Check common settings locations
  const candidates = [
    path.join(wsPath, 'settings.py'),
    ...findFilesNamed(wsPath, 'settings.py', 5),
  ];
  for (const f of candidates) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 4000);
      if (/INSTALLED_APPS/i.test(content)) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ── File system helpers ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', 'env', '.env', 'migrations']);

function findFilesNamed(dir: string, name: string, maxResults = 20): string[] {
  const results: string[] = [];
  function walk(d: string, depth: number) {
    if (depth > 5 || results.length >= maxResults) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); }
        else if (entry.name === name) { results.push(full); }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir, 0);
  return results;
}

function globFiles(dir: string, patterns: RegExp[], maxFiles = 30): string[] {
  const results: string[] = [];
  function walk(d: string) {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) results.push(full);
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

// ── Django app detection ───────────────────────────────────────────────────────

interface DjangoApp {
  name: string;
  path: string;
  hasModels: boolean;
  hasViews: boolean;
  hasUrls: boolean;
  hasAdmin: boolean;
  hasForms: boolean;
  hasSerializers: boolean;
}

function detectDjangoApps(wsPath: string): DjangoApp[] {
  const apps: DjangoApp[] = [];
  try {
    for (const entry of fs.readdirSync(wsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const appPath = path.join(wsPath, entry.name);
      const hasModels = fs.existsSync(path.join(appPath, 'models.py'));
      const hasViews  = fs.existsSync(path.join(appPath, 'views.py'));
      if (hasModels || hasViews) {
        apps.push({
          name:           entry.name,
          path:           appPath,
          hasModels,
          hasViews,
          hasUrls:        fs.existsSync(path.join(appPath, 'urls.py')),
          hasAdmin:       fs.existsSync(path.join(appPath, 'admin.py')),
          hasForms:       fs.existsSync(path.join(appPath, 'forms.py')),
          hasSerializers: fs.existsSync(path.join(appPath, 'serializers.py')),
        });
      }
    }
  } catch { /* skip */ }
  return apps;
}

// ── Model extraction ──────────────────────────────────────────────────────────

interface ModelInfo {
  app:    string;
  models: string[];
}

function extractModelNames(wsPath: string, apps: DjangoApp[]): ModelInfo[] {
  const result: ModelInfo[] = [];
  const MODEL_CLASS = /^class\s+(\w+)\s*\(\s*(?:models\.Model|[\w.]*Model[\w.]*)\s*\)/gm;
  for (const app of apps) {
    if (!app.hasModels) continue;
    const modelsFile = path.join(app.path, 'models.py');
    try {
      const content = fs.readFileSync(modelsFile, 'utf8');
      const names: string[] = [];
      let m: RegExpExecArray | null;
      MODEL_CLASS.lastIndex = 0;
      while ((m = MODEL_CLASS.exec(content)) !== null) {
        names.push(m[1]);
      }
      if (names.length > 0) {
        result.push({ app: app.name, models: names });
      }
    } catch { /* skip */ }
  }
  return result;
}

// ── Settings extraction (sanitized) ──────────────────────────────────────────

interface DjangoSettings {
  installedApps:  string[];
  databases:      string[];
  middleware:     string[];
  hasDrf:         boolean;
  hasCelery:      boolean;
  hasCors:        boolean;
  hasChannels:    boolean;
  settingsPath:   string | null;
}

const SECRET_PATTERN = /SECRET_KEY\s*=.*$/gm;
const DB_PATTERN     = /DATABASES\s*=\s*\{[\s\S]*?\n\}/;
const APP_LIST_PATTERN = /INSTALLED_APPS\s*=\s*\[[\s\S]*?\]/;
const MIDDLEWARE_PATTERN = /MIDDLEWARE\s*=\s*\[[\s\S]*?\]/;

function extractSettings(wsPath: string): DjangoSettings {
  const settingsFiles = findFilesNamed(wsPath, 'settings.py', 5);
  const settingsPath  = settingsFiles[0] ?? null;

  const result: DjangoSettings = {
    installedApps: [],
    databases:     [],
    middleware:    [],
    hasDrf:        false,
    hasCelery:     false,
    hasCors:       false,
    hasChannels:   false,
    settingsPath,
  };

  if (!settingsPath) return result;

  try {
    // Remove SECRET_KEY values before processing
    const raw     = fs.readFileSync(settingsPath, 'utf8').replace(SECRET_PATTERN, 'SECRET_KEY = <redacted>');
    const content = raw.slice(0, 6000);

    // Extract INSTALLED_APPS entries
    const appMatch = APP_LIST_PATTERN.exec(content);
    if (appMatch) {
      const apps = appMatch[0].match(/'[\w.]+'/g) ?? [];
      result.installedApps = apps.map(a => a.replace(/'/g, '')).slice(0, 20);
    }

    // Extract DB engines (no passwords)
    const dbMatch = DB_PATTERN.exec(content);
    if (dbMatch) {
      const engines = dbMatch[0].match(/'ENGINE':\s*'[\w.]+'/g) ?? [];
      result.databases = engines.map(e => e.replace(/'ENGINE':\s*'/, '').replace(/'/, ''));
    }

    // Extract middleware names
    const mwMatch = MIDDLEWARE_PATTERN.exec(content);
    if (mwMatch) {
      const mws = mwMatch[0].match(/'[\w.]+'/g) ?? [];
      result.middleware = mws.map(m => m.replace(/'/g, '')).slice(0, 10);
    }

    result.hasDrf      = /rest_framework/i.test(content);
    result.hasCelery   = /celery/i.test(content);
    result.hasCors     = /corsheaders/i.test(content);
    result.hasChannels = /channels/i.test(content);
  } catch { /* skip */ }

  return result;
}

// ── Context data shape ────────────────────────────────────────────────────────

interface DjangoContext {
  apps:      DjangoApp[];
  models:    ModelInfo[];
  settings:  DjangoSettings;
  urlFiles:  string[];
  appCount:  number;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class DjangoPlugin implements IPlugin {
  readonly id          = 'django';
  readonly displayName = 'Django';
  readonly icon        = '$(globe)';

  private _wsPath   = '';
  private _appCount = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;
    if (hasManagePy(wsPath)) return true;
    if (hasDjangoInRequirements(wsPath)) return true;
    if (hasSettingsPyWithInstalledApps(wsPath)) return true;
    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath   = ws?.uri.fsPath ?? '';
    if (this._wsPath) {
      const apps = detectDjangoApps(this._wsPath);
      this._appCount = apps.length;
    }
    console.log(`[Evolve AI] Django plugin activated — ${this._appCount} app(s) detected`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'django.apps',

      async collect(ws): Promise<DjangoApp[]> {
        const wsPath = ws?.uri.fsPath ?? '';
        return detectDjangoApps(wsPath);
      },

      format(data: unknown): string {
        const apps = data as DjangoApp[];
        if (apps.length === 0) return '## Django Apps\nNo Django apps detected.';
        const lines = ['## Django Apps'];
        for (const app of apps) {
          const files = [
            app.hasModels     && 'models',
            app.hasViews      && 'views',
            app.hasUrls       && 'urls',
            app.hasAdmin      && 'admin',
            app.hasForms      && 'forms',
            app.hasSerializers && 'serializers',
          ].filter(Boolean).join(', ');
          lines.push(`- **${app.name}**: ${files || 'empty'}`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'django.models',

      async collect(ws): Promise<ModelInfo[]> {
        const wsPath = ws?.uri.fsPath ?? '';
        const apps   = detectDjangoApps(wsPath);
        return extractModelNames(wsPath, apps);
      },

      format(data: unknown): string {
        const models = data as ModelInfo[];
        if (models.length === 0) return '## Django Models\nNo models detected.';
        const lines = ['## Django Models'];
        for (const info of models) {
          lines.push(`- **${info.app}**: ${info.models.join(', ')}`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'django.settings',

      async collect(ws): Promise<DjangoSettings> {
        const wsPath = ws?.uri.fsPath ?? '';
        return extractSettings(wsPath);
      },

      format(data: unknown): string {
        const s = data as DjangoSettings;
        const lines = ['## Django Settings (sanitized)'];
        if (s.installedApps.length > 0) {
          lines.push(`### INSTALLED_APPS\n${s.installedApps.join(', ')}`);
        }
        if (s.databases.length > 0) {
          lines.push(`### Database engines: ${s.databases.join(', ')}`);
        }
        if (s.middleware.length > 0) {
          lines.push(`### Middleware (${s.middleware.length} entries)`);
        }
        const features: string[] = [];
        if (s.hasDrf)      features.push('Django REST Framework');
        if (s.hasCelery)   features.push('Celery');
        if (s.hasCors)     features.push('django-cors-headers');
        if (s.hasChannels) features.push('Django Channels');
        if (features.length > 0) {
          lines.push(`### Detected packages: ${features.join(', ')}`);
        }
        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Django Expert Knowledge

You are an expert in Django, Django REST Framework (DRF), and the wider Django ecosystem. Apply these rules in every response involving Django code:

### ORM — QuerySets & Database Access
- Always use QuerySets lazily — chain filters before evaluation; avoid evaluating mid-chain
- Use select_related() for ForeignKey/OneToOne to avoid N+1 queries (JOIN-based)
- Use prefetch_related() for ManyToMany and reverse FK relations (separate query + Python join)
- Use F() objects for database-side field references: F('price') * 2, avoid pulling to Python
- Use Q() objects for complex OR/AND queries: Q(status='active') | Q(is_staff=True)
- Use annotate() and aggregate() (Sum, Count, Avg, Max, Min) for server-side calculations
- Use values() / values_list() when you need only specific fields, not full model instances
- Use bulk_create(), bulk_update() for batch operations — never loop with .save()
- Use .only() and .defer() to limit column fetches for wide tables
- Use exists() instead of count() > 0 for boolean checks — exists() is faster
- Use iterator() for large QuerySets to avoid loading all into memory

### Models
- Define __str__ for every model — it's used in admin, shell, and error messages
- Use verbose_name and verbose_name_plural in Meta for readable admin display
- Define ordering in Meta for consistent default QuerySet ordering
- Use db_index=True on frequently filtered/ordered fields
- Use unique_together (or UniqueConstraint in constraints=[]) for composite uniqueness
- Use ForeignKey with on_delete explicitly: CASCADE, PROTECT, SET_NULL, SET_DEFAULT
- Use ManyToManyField through= for extra data on the join table
- Use OneToOneField for model extension (profile pattern)
- Custom managers: subclass models.Manager, add query logic, assign as objects = MyManager()
- Use signals (post_save, pre_delete) sparingly — prefer overriding save() or service functions
- Abstract base models for shared fields: class TimeStampedModel(models.Model): class Meta: abstract = True

### Views — FBVs vs CBVs
- Prefer class-based views (CBVs) for CRUD; FBVs for one-off or complex logic
- Generic CBVs: ListView, DetailView, CreateView, UpdateView, DeleteView, TemplateView
- Use mixins for reuse: LoginRequiredMixin, PermissionRequiredMixin, UserPassesTestMixin
- Override get_queryset() to filter by request.user or dynamic conditions
- Override get_context_data() to add extra context to templates
- Use @login_required, @permission_required decorators for FBVs
- Use dispatch() override for CBV-level access control

### Django REST Framework (DRF)
- ModelSerializer auto-generates fields from the model — always set fields explicitly or use '__all__'
- Use HyperlinkedModelSerializer for resource URLs in the response
- Nested serializers: read-only by default; override create()/update() for writable nested
- Use SerializerMethodField for computed read-only fields
- ViewSets + Routers: ModelViewSet for full CRUD, ReadOnlyModelViewSet for read-only
- Use action decorator for custom endpoints on ViewSets: @action(detail=True, methods=['post'])
- Permissions: IsAuthenticated, IsAdminUser, IsAuthenticatedOrReadOnly — combine with list()
- Custom permissions: subclass BasePermission, implement has_permission() and has_object_permission()
- Pagination: PageNumberPagination, LimitOffsetPagination, CursorPagination — set in DEFAULT_PAGINATION_CLASS
- Filtering: use django-filter with DjangoFilterBackend; SearchFilter for q= search; OrderingFilter
- Throttling: AnonRateThrottle, UserRateThrottle — configure in DEFAULT_THROTTLE_RATES
- Use get_serializer_class() to return different serializers per action
- Always version your API: namespace with api/v1/ paths or DRF versioning classes

### Forms
- ModelForm: set model and fields (or exclude) in Meta; never use fields = '__all__' in production forms
- Override clean_<fieldname>() for field-level validation; clean() for cross-field validation
- Use formsets / modelformset_factory for inline multi-form UIs
- Pass request.user to form __init__ for user-scoped validation
- Always call form.is_valid() before accessing form.cleaned_data

### Admin
- Register with @admin.register(MyModel) decorator — cleaner than admin.site.register()
- list_display: tuple of field names or callables for the changelist table
- list_filter, search_fields, date_hierarchy for filtering and search
- Use inlines (TabularInline, StackedInline) for related objects on the same page
- Define save_model() or response_change() for custom admin actions
- readonly_fields for computed or sensitive fields

### Migrations
- Run makemigrations after every model change; never edit migration files unless necessary
- Use RunPython for data migrations with a forward and reverse function
- Use SeparateDatabaseAndState for complex rename/split operations
- Use squashmigrations to condense migration history for large apps
- Always test migrations with --check in CI: manage.py migrate --check

### Middleware
- MIDDLEWARE is processed top-to-bottom on request, bottom-to-top on response
- Custom middleware: class-based with __init__(get_response) and __call__(request)
- Use MiddlewareMixin for compatibility with old-style process_request/process_response
- Place security middleware (CORS, auth) early in the stack

### URLs
- Use path() for simple routes; re_path() only when regex is truly needed
- Use include() with app_name for namespace: include('app.urls', namespace='app')
- Use reverse() and reverse_lazy() for URL generation — never hardcode paths
- Use {% url 'namespace:name' %} in templates

### Templates
- Use template inheritance: {% extends %}, {% block %}, {% include %}
- Use {% load %} for custom tag libraries; prefer built-in filters first
- Never put business logic in templates — compute in view, pass as context

### Testing
- Use TestCase for database tests (wraps each test in a transaction, rolls back)
- Use SimpleTestCase for no-database tests; TransactionTestCase for transaction behaviour
- Use Client for view testing: self.client.get('/path/'), self.client.post(...)
- Use RequestFactory for unit-testing views without middleware
- Use fixtures (JSON/YAML) or factory libraries (factory_boy) for test data
- Use setUpTestData() (classmethod) for expensive shared fixtures

### Security
- CSRF: always use {% csrf_token %} in forms; @csrf_exempt only for API views with DRF auth
- ALLOWED_HOSTS must be set in production — never '*' in production
- Rotate SECRET_KEY if compromised; use environment variables, never commit to source
- Use Django's built-in password validators in AUTH_PASSWORD_VALIDATORS
- Use HTTPS: SECURE_SSL_REDIRECT, HSTS headers, SECURE_BROWSER_XSS_FILTER
- Use django-cors-headers for CORS; restrict CORS_ALLOWED_ORIGINS in production

### Best Practices
- Fat models / thin views: business logic belongs on the model or in a service module, not views
- Service layer: create services.py per app for complex business operations
- Custom managers and QuerySets: encapsulate reusable query logic in the data layer
- Use Django signals sparingly — they create hidden coupling; prefer explicit service calls
- Always set AUTH_USER_MODEL if customizing the user model — do this before the first migration
- Use environment variables for all secrets (SECRET_KEY, DB credentials) via django-environ or python-decouple
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(globe) Explain Django model',
      command:     'aiForge.django.explainModel',
      linePattern: /^class\s+\w+\s*\(\s*(?:models\.Model|[\w.]*Model[\w.]*)\s*\)/,
      languages:   ['python'],
      tooltip:     'Explain this Django model, its fields, and relationships',
    },
    {
      title:       '$(globe) Add DRF serializer',
      command:     'aiForge.django.addSerializer',
      linePattern: /^class\s+\w+\s*\(\s*(?:models\.Model|[\w.]*Model[\w.]*)\s*\)/,
      languages:   ['python'],
      tooltip:     'Generate a Django REST Framework serializer for this model',
    },
    {
      title:       '$(globe) Add view for model',
      command:     'aiForge.django.addView',
      linePattern: /^class\s+\w+\s*\(\s*(?:models\.Model|[\w.]*Model[\w.]*)\s*\)/,
      languages:   ['python'],
      tooltip:     'Generate a view (CBV or DRF ViewSet) for this model',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(globe) Django: Add DRF serializer for model',
      command:   'aiForge.django.addSerializer',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(globe) Django: Add admin registration',
      command:   'aiForge.django.addAdmin',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(globe) Django: Add URL pattern for view',
      command:   'aiForge.django.addUrls',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(globe) Django: Generate migration for model change',
      command:   'aiForge.django.addView',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Generate serializers for all models',
      description: 'Create DRF ModelSerializer classes for every model in the file',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Generate Django REST Framework ModelSerializer classes for every model defined in this file.
Rules:
- Use class Meta with model = <ModelName> and fields = '__all__' or an explicit fields list
- Add validators and custom field overrides where appropriate
- Add docstrings explaining each serializer's purpose
- Append the serializers at the end of the file (do not remove existing code)
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a Django REST Framework expert. Return only the complete updated Python file.',
          instruction: 'Generate DRF serializers',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add admin registrations for all models',
      description: 'Register all models with ModelAdmin classes including list_display and search_fields',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Generate Django admin registrations for every model in this file.
Rules:
- Use @admin.register(ModelName) decorator pattern
- Add list_display with key fields
- Add search_fields for string-based fields
- Add list_filter for status/type/FK fields
- Add readonly_fields for auto-generated fields
- Import ModelAdmin at the top if not present
- Append the admin classes at the end of the file (do not remove existing code)
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a Django admin expert. Return only the complete updated Python file.',
          instruction: 'Add admin registrations',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Generate URL patterns for all views',
      description: 'Create path() entries for every view or ViewSet class found in the file',
      extensions:  ['.py'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Generate Django URL patterns for every view or ViewSet defined in this file.
Rules:
- Use path() for simple routes; include a urls.py block at the bottom
- For ViewSets, use DefaultRouter and register() each one
- Add url names (name=) for all path() entries
- Use app_name namespace where appropriate
- Return ONLY the complete updated file with a urlpatterns section appended.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a Django URL routing expert. Return only the complete updated Python file.',
          instruction: 'Generate URL patterns',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Django model with common fields',
      description: 'Model with timestamps, soft-delete, custom manager, and __str__',
      prompt: (wsPath) =>
        `Create a production-quality Django model file.
Include:
- An abstract TimeStampedModel base class with created_at and updated_at fields
- An abstract SoftDeleteModel with is_deleted, deleted_at, and a custom SoftDeleteManager
- A concrete domain model (e.g. Product or Article) extending both base classes
- Appropriate field types (CharField, TextField, DecimalField, ForeignKey, ManyToManyField)
- Meta class with ordering, verbose_name, indexes using models.Index
- __str__ method returning a human-readable identifier
- A custom QuerySet and Manager with at least 2 domain-specific filter methods
- A clean() method with cross-field validation
- Docstring for the class and each non-obvious field
Generate as ## models.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'DRF ViewSet + Serializer',
      description: 'Full ModelViewSet with nested serializer, permissions, and filtering',
      prompt: (wsPath) =>
        `Create a complete Django REST Framework ViewSet + Serializer pair.
Include:
- A ModelSerializer with explicit fields, a nested read-only related serializer, and a SerializerMethodField
- A second write serializer (CreateUpdateSerializer) with different field rules
- A ModelViewSet with:
  - get_serializer_class() returning read vs write serializer based on action
  - get_queryset() with select_related/prefetch_related and user-scoped filtering
  - A custom @action (detail=True, methods=['post']) for a domain operation
  - Permission classes: [IsAuthenticated, IsOwnerOrReadOnly]
  - Pagination: PageNumberPagination with 20 items per page
  - DjangoFilterBackend, SearchFilter, and OrderingFilter
- A DefaultRouter registration block at the bottom
Generate as ## views.py then the complete content, then ## serializers.py then its content.
Workspace: ${wsPath}`,
    },
    {
      label:       'URL configuration',
      description: 'urls.py with namespaced routes, API router, and include patterns',
      prompt: (wsPath) =>
        `Create a complete Django URL configuration file (urls.py).
Include:
- app_name for namespace
- path() entries for at least 3 class-based views with proper names
- A DefaultRouter for DRF ViewSets with router.urls included
- An include() to a sub-app's urls.py with namespace
- A health-check endpoint at /health/
- Proper imports (path, include, DefaultRouter)
- Comments explaining each URL group
Generate as ## urls.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Management command',
      description: 'Custom manage.py command with argument parsing and progress reporting',
      prompt: (wsPath) =>
        `Create a Django management command in the correct directory structure.
Include:
- management/commands/<command_name>.py
- A class Command(BaseCommand) with help string
- add_arguments() with at least 2 arguments (one positional, one optional flag)
- handle() method with:
  - Transaction wrapping with transaction.atomic()
  - Progress reporting via self.stdout.write()
  - Error handling with self.stderr.write() and CommandError
  - Dry-run mode support (--dry-run flag)
  - Verbosity checking with self.verbosity
- A docstring explaining the command's purpose
Generate as ## management/__init__.py then empty, then ## management/commands/__init__.py then empty, then ## management/commands/<name>.py then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.django.explainModel',
      title: 'Evolve AI: Explain Django Model',
      async handler(_services, _uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Django model in detail:
- What each field represents and its constraints
- The relationships (FK, M2M, O2O) and their implications
- The Meta options and their effect
- Any custom manager or QuerySet methods
- Performance considerations (indexes, select_related, prefetch_related)
- Suggestions for improvement

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.django.addSerializer',
      title: 'Evolve AI: Generate DRF Serializer',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Django models file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Django: Generating serializer…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Generate a complete Django REST Framework ModelSerializer for each model in this code.
Include:
- ModelSerializer with explicit fields list
- Nested read-only serializers for FK relations
- write_only fields for passwords/secrets
- validate_<field>() methods for custom validation
- create() and update() overrides if ManyToMany relations present

\`\`\`python
${code}
\`\`\`

Return ONLY the serializer code (no explanation).`,
              }],
              system: sys,
              instruction: 'Generate DRF serializer',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'Django: Serializer generated.', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the generated DRF serializer:\n\`\`\`python\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.django.addAdmin',
      title: 'Evolve AI: Generate Admin Registration',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Django models file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate Django admin registrations for all models in this file.
Use @admin.register() decorators, add list_display, search_fields, list_filter, and
readonly_fields. Add TabularInline for related objects where appropriate.

\`\`\`python
${code}
\`\`\``,
          'new'
        );
      },
    },
    {
      id:    'aiForge.django.addView',
      title: 'Evolve AI: Generate View for Model',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Django models file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate Django views for the models in this file.
Include both:
1. Class-based views (ListView, DetailView, CreateView, UpdateView, DeleteView) with LoginRequiredMixin
2. A DRF ModelViewSet with proper permissions and filtering if DRF is in the project

\`\`\`python
${code}
\`\`\``,
          'new'
        );
      },
    },
    {
      id:    'aiForge.django.addUrls',
      title: 'Evolve AI: Generate URL Patterns',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Django views file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate Django URL patterns for all views and ViewSets in this file.
Include:
- path() entries with descriptive URL names for all CBVs
- DefaultRouter registration for all ViewSets
- Correct imports (path, include, DefaultRouter)
- app_name for namespace

\`\`\`python
${code}
\`\`\``,
          'new'
        );
      },
    },
    {
      id:    'aiForge.django.addTest',
      title: 'Evolve AI: Generate Django Tests',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Django file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate comprehensive Django tests for this code.
Include:
- TestCase class with setUpTestData() for shared fixtures
- Model tests: field constraints, __str__, custom manager methods, signals
- View tests: using self.client for GET/POST, authentication, permissions
- Serializer tests: valid/invalid data, nested serializer behaviour
- URL tests: reverse() resolution
- Use factory_boy or simple model creation helpers for test data

\`\`\`python
${code}
\`\`\``,
          'new'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      const count = this._appCount;
      return `$(globe) Django (${count} app${count !== 1 ? 's' : ''})`;
    },
  };
}
