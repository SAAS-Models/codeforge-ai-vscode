/**
 * plugins/docker.ts — Docker / Docker Compose plugin for Evolve AI
 *
 * Activates when the workspace contains a Dockerfile, docker-compose file,
 * or .dockerignore.
 * Contributes:
 *  - contextHooks       : Dockerfile stages, compose services, base images
 *  - systemPromptSection: full Docker domain knowledge (~3KB)
 *  - codeLensActions    : Explain Stage, Optimize Layers
 *  - codeActions        : Add HEALTHCHECK, non-root USER, merge RUN layers, add .dockerignore entry
 *  - transforms         : Optimize all Dockerfiles, add healthchecks to compose services
 *  - templates          : Multi-stage Dockerfile, docker-compose.yml, CI/CD Dockerfile
 *  - commands           : explainDockerfile, optimize, addHealthcheck, securityAudit, generateCompose, generateDockerfile
 *  - statusItem         : shows stage/service count
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

const DOCKER_COMPOSE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

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

function hasDockerfiles(wsPath: string): boolean {
  try {
    const entries = fs.readdirSync(wsPath);
    for (const entry of entries) {
      if (/^Dockerfile/.test(entry) || /\.dockerfile$/i.test(entry)) { return true; }
    }
  } catch { /* skip */ }
  // Also check sub-directories one level deep
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const subDir = path.join(wsPath, entry.name);
      try {
        const subEntries = fs.readdirSync(subDir);
        for (const sub of subEntries) {
          if (/^Dockerfile/.test(sub) || /\.dockerfile$/i.test(sub)) { return true; }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return false;
}

function hasComposeFile(wsPath: string): boolean {
  for (const name of DOCKER_COMPOSE_NAMES) {
    if (fs.existsSync(path.join(wsPath, name))) { return true; }
  }
  return false;
}

function hasDockerIgnore(wsPath: string): boolean {
  return fs.existsSync(path.join(wsPath, '.dockerignore'));
}

// ── Context data shape ────────────────────────────────────────────────────────

interface DockerfileInfo {
  file: string;
  stages: Array<{ name: string; base: string }>;
  stageCount: number;
}

interface ComposeService {
  name: string;
  image: string;
  ports: string[];
  hasHealthcheck: boolean;
}

interface DockerContext {
  dockerfiles: DockerfileInfo[];
  composeServices: ComposeService[];
  hasDockerIgnore: boolean;
  totalStages: number;
  serviceCount: number;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseDockerfileStages(content: string): Array<{ name: string; base: string }> {
  const stages: Array<{ name: string; base: string }> = [];
  const fromPattern = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(content)) !== null) {
    stages.push({
      base: match[1] ?? '',
      name: match[2] ?? `stage${stages.length}`,
    });
  }
  return stages;
}

function parseComposeServices(content: string): ComposeService[] {
  const services: ComposeService[] = [];
  // Simple regex-based extraction — not a full YAML parser
  const servicePattern = /^  (\w[\w-]*):\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = servicePattern.exec(content)) !== null) {
    const name = match[1] ?? '';
    if (name === 'networks' || name === 'volumes' || name === 'configs' || name === 'secrets') { continue; }
    // Extract image line near this service
    const snippet = content.slice(match.index, match.index + 600);
    const imageMatch = /image:\s*(\S+)/.exec(snippet);
    const image = imageMatch ? (imageMatch[1] ?? '') : '';
    // Extract ports
    const ports: string[] = [];
    const portPattern = /- ["']?(\d[\d.:/-]+)["']?/g;
    const portSection = /ports:([\s\S]*?)(?=\n  \w|\n\w|$)/m.exec(snippet);
    if (portSection) {
      let pm: RegExpExecArray | null;
      while ((pm = portPattern.exec(portSection[0])) !== null) {
        ports.push(pm[1] ?? '');
      }
    }
    const hasHealthcheck = /healthcheck:/i.test(snippet);
    services.push({ name, image, ports, hasHealthcheck });
  }
  return services;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class DockerPlugin implements IPlugin {
  readonly id          = 'docker';
  readonly displayName = 'Docker';
  readonly icon        = '$(package)';

  private _wsPath       = '';
  private _serviceCount = 0;
  private _stageCount   = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) { return false; }
    const wsPath = ws.uri.fsPath;
    if (hasDockerfiles(wsPath)) { return true; }
    if (hasComposeFile(wsPath)) { return true; }
    if (hasDockerIgnore(wsPath)) { return true; }
    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(_services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    if (this._wsPath) {
      // Count stages across Dockerfiles
      const dockerfiles = globFiles(this._wsPath, [/^Dockerfile/, /\.dockerfile$/i], 20);
      this._stageCount = dockerfiles.reduce((sum, f) => {
        try {
          const content = fs.readFileSync(f, 'utf8');
          return sum + parseDockerfileStages(content).length;
        } catch { return sum; }
      }, 0);

      // Count compose services
      for (const name of DOCKER_COMPOSE_NAMES) {
        const full = path.join(this._wsPath, name);
        if (fs.existsSync(full)) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            this._serviceCount = parseComposeServices(content).length;
          } catch { /* skip */ }
          break;
        }
      }
    }

    console.log(`[Evolve AI] Docker plugin activated: ${this._stageCount} stage(s), ${this._serviceCount} service(s)`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'docker.files',

      async collect(ws): Promise<DockerContext> {
        const wsPath = ws?.uri.fsPath ?? '';
        const dockerfileInfos: DockerfileInfo[] = [];

        const dockerfilePaths = globFiles(wsPath, [/^Dockerfile/, /\.dockerfile$/i], 20);
        for (const f of dockerfilePaths) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            const stages = parseDockerfileStages(content);
            dockerfileInfos.push({
              file: path.relative(wsPath, f),
              stages,
              stageCount: stages.length,
            });
          } catch { /* skip */ }
        }

        let composeServices: ComposeService[] = [];
        for (const name of DOCKER_COMPOSE_NAMES) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            try {
              const content = fs.readFileSync(full, 'utf8');
              composeServices = parseComposeServices(content);
            } catch { /* skip */ }
            break;
          }
        }

        const totalStages = dockerfileInfos.reduce((s, d) => s + d.stageCount, 0);

        return {
          dockerfiles:    dockerfileInfos,
          composeServices,
          hasDockerIgnore: hasDockerIgnore(wsPath),
          totalStages,
          serviceCount:   composeServices.length,
        };
      },

      format(data: unknown): string {
        const d = data as DockerContext;
        const lines: string[] = ['## Docker Context'];

        if (d.dockerfiles.length > 0) {
          lines.push('### Dockerfiles:');
          for (const df of d.dockerfiles.slice(0, 10)) {
            const stageList = df.stages.map(s => `${s.name} (FROM ${s.base})`).join(', ');
            lines.push(`- \`${df.file}\`: ${df.stageCount} stage(s) — ${stageList}`);
          }
        }

        if (d.composeServices.length > 0) {
          lines.push('### Compose Services:');
          for (const svc of d.composeServices.slice(0, 15)) {
            const portStr = svc.ports.length > 0 ? ` ports: ${svc.ports.join(', ')}` : '';
            const hcStr   = svc.hasHealthcheck ? ' [healthcheck]' : '';
            const imgStr  = svc.image ? ` image: ${svc.image}` : '';
            lines.push(`- \`${svc.name}\`${imgStr}${portStr}${hcStr}`);
          }
        }

        if (!d.hasDockerIgnore && d.dockerfiles.length > 0) {
          lines.push('### Note: No .dockerignore found — consider adding one to reduce build context size.');
        }

        return lines.join('\n');
      },
    },
    {
      key: 'docker.compose',

      async collect(ws): Promise<{ composeFile: string | null; serviceNames: string[] }> {
        const wsPath = ws?.uri.fsPath ?? '';
        for (const name of DOCKER_COMPOSE_NAMES) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            try {
              const content = fs.readFileSync(full, 'utf8').slice(0, 3000);
              const services = parseComposeServices(content);
              return {
                composeFile: name,
                serviceNames: services.map(s => s.name),
              };
            } catch { /* skip */ }
          }
        }
        return { composeFile: null, serviceNames: [] };
      },

      format(data: unknown): string {
        const d = data as { composeFile: string | null; serviceNames: string[] };
        if (!d.composeFile) { return ''; }
        return `## Docker Compose\nFile: \`${d.composeFile}\`\nServices: ${d.serviceNames.join(', ')}`;
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Docker Expert Knowledge

You are an expert in Docker, Docker Compose, and container best practices. Apply these rules in every response involving Dockerfiles, compose files, or containerisation:

### Dockerfile Instructions
- FROM: always pin to a specific version tag — never use \`latest\` in production
- RUN: combine related commands with \`&&\` and backslashes to minimise layer count; clean up caches in the same RUN step
- COPY vs ADD: prefer COPY; use ADD only when you need automatic tar extraction or remote URL support
- ENV / ARG: use ARG for build-time variables, ENV for runtime; never put secrets in ARG or ENV
- WORKDIR: always set explicitly; never rely on default working directory
- USER: always switch to a non-root USER before CMD/ENTRYPOINT — never run containers as root
- EXPOSE: documents intent only; does not publish ports
- CMD vs ENTRYPOINT: use ENTRYPOINT for the main process, CMD for default arguments; use exec form (\`["executable","arg"]\`) not shell form
- HEALTHCHECK: always add in production images — specify interval, timeout, retries, start-period

### Multi-Stage Builds
- Builder stage: install build tools and compile artefacts; never carry build tools into the final image
- Final stage: copy only the compiled output from the builder stage using \`COPY --from=builder\`
- Minimise final image: use alpine, distroless, or scratch as the base for the final stage when possible
- Label stages with meaningful names (\`AS builder\`, \`AS runner\`, \`AS test\`)
- Use a separate test stage to run unit tests during the build pipeline

### Layer Optimisation
- Order instructions from least-changing to most-changing: system packages → app dependencies → source code → config
- Copy dependency manifests (package.json, requirements.txt) before source code to maximise layer cache hits
- Use .dockerignore to exclude node_modules, .git, test files, and build artefacts from the build context
- Merge consecutive RUN commands; avoid creating and immediately deleting files in separate layers
- Pin apt/apk package versions for reproducibility; use \`--no-install-recommends\` with apt-get

### Security
- Use minimal base images (alpine, distroless, scratch) to reduce attack surface
- Never copy secrets, credentials, or .env files into an image — use Docker secrets or runtime environment injection
- Switch to a non-root user: \`RUN addgroup -S appgroup && adduser -S appuser -G appgroup\` then \`USER appuser\`
- Use read-only filesystems where possible: \`--read-only\` at runtime, or declare VOLUME for writable paths
- Regularly update base images and run vulnerability scans (Trivy, Snyk, Docker Scout)
- Avoid running processes as PID 1 without a proper init — use \`--init\` or tini

### HEALTHCHECK
- Always specify interval, timeout, retries, and start-period
- Example: \`HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s CMD curl -f http://localhost:8080/health || exit 1\`
- Use wget instead of curl in alpine images
- For non-HTTP services, use appropriate health check commands (pg_isready, redis-cli ping, etc.)

### Docker Compose v2
- Use \`services:\`, \`networks:\`, \`volumes:\` at the top level — Compose v2 syntax (no \`version:\` key required)
- \`depends_on:\` with \`condition: service_healthy\` ensures services wait for healthchecks
- Use named volumes for persistent data; use bind mounts only for development workflows
- Use \`env_file:\` to load environment variables from .env files; use \`environment:\` for overrides
- Network aliases enable service discovery by name within a custom bridge network
- Use \`profiles:\` to group optional services (e.g., debug, monitoring) that are not started by default
- Use \`extends:\` or multiple compose files for environment overrides (dev/staging/prod)

### Networking
- Default bridge network: containers communicate by IP; use custom bridge networks for DNS-based name resolution
- Custom bridge: \`docker network create --driver bridge mynet\` — enables container name DNS
- Host network mode (\`network_mode: host\`) bypasses isolation — avoid in production
- Expose ports explicitly; never expose more ports than needed
- Use overlay networks for multi-host Swarm/Compose deployments

### Volumes
- Named volumes are managed by Docker and portable across host restarts
- Bind mounts (\`./host/path:/container/path\`) are useful in development for live reload
- tmpfs mounts (\`tmpfs: /tmp\`) for ephemeral in-memory storage (sensitive temp files)
- Mount volumes as read-only where write access is not required: \`/data:ro\`

### BuildKit
- Enable BuildKit: \`DOCKER_BUILDKIT=1 docker build\` or set in daemon.json
- Use cache mounts: \`RUN --mount=type=cache,target=/root/.cache/pip pip install ...\` to cache package manager downloads
- Use secret mounts: \`RUN --mount=type=secret,id=npmrc cat /run/secrets/npmrc\` — secrets never appear in layers
- Multi-platform builds: \`docker buildx build --platform linux/amd64,linux/arm64\`

### Best Practices
- One concern per container — one process per container, log to stdout/stderr
- Use \`tini\` or \`--init\` to handle PID 1 signal forwarding and zombie process reaping
- Set PYTHONDONTWRITEBYTECODE=1 and PYTHONUNBUFFERED=1 for Python containers
- Set NODE_ENV=production to prune dev dependencies in Node.js images
- Pin image digests in production for true immutability: \`FROM node:20@sha256:...\`
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(package) Explain stage',
      command:     'aiForge.docker.explainDockerfile',
      linePattern: /^FROM\s+/i,
      languages:   ['dockerfile'],
      tooltip:     'Explain this Docker stage and its purpose',
    },
    {
      title:       '$(package) Optimize layers',
      command:     'aiForge.docker.optimize',
      linePattern: /^RUN\s+/i,
      languages:   ['dockerfile'],
      tooltip:     'Suggest layer optimizations for this RUN instruction',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(package) Docker: Add HEALTHCHECK instruction',
      command:   'aiForge.docker.addHealthcheck',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['dockerfile'],
    },
    {
      title:     '$(package) Docker: Switch to non-root USER',
      command:   'aiForge.docker.securityAudit',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['dockerfile'],
    },
    {
      title:     '$(package) Docker: Merge consecutive RUN layers',
      command:   'aiForge.docker.optimize',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['dockerfile'],
    },
    {
      title:     '$(package) Docker: Add .dockerignore entry',
      command:   'aiForge.docker.generateDockerfile',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['dockerfile'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Optimize all Dockerfiles for image size',
      description: 'Merge RUN layers, add multi-stage build, switch to minimal base image',
      extensions:  ['.dockerfile', ''],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Optimize this Dockerfile for minimal image size. Apply these improvements:
- Use multi-stage build: a builder stage for compilation and a minimal final stage (alpine/distroless)
- Merge consecutive RUN commands with && to reduce layers
- Add .dockerignore-aware COPY patterns (copy dep manifests before source)
- Switch to non-root USER
- Add HEALTHCHECK instruction
- Pin base image versions
- Clean package manager caches in the same RUN step
- Return ONLY the complete optimized Dockerfile, no explanation.

File: ${filePath}
\`\`\`dockerfile
${content}
\`\`\``,
          }],
          system: 'You are a Docker optimization expert. Return only the complete optimized Dockerfile.',
          instruction: 'Optimize Dockerfile for image size',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add healthchecks to all compose services',
      description: 'Add HEALTHCHECK to Dockerfiles and healthcheck: sections to compose services',
      extensions:  ['.yml', '.yaml'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add healthcheck configurations to all services in this Docker Compose file.
For each service:
- Add a healthcheck: section with appropriate test command (curl, wget, pg_isready, redis-cli, etc.)
- Set reasonable interval (30s), timeout (5s), retries (3), start_period (10s)
- Add depends_on with condition: service_healthy where services depend on others
- Return ONLY the complete updated compose file, no explanation.

File: ${filePath}
\`\`\`yaml
${content}
\`\`\``,
          }],
          system: 'You are a Docker Compose expert. Return only the complete updated YAML file.',
          instruction: 'Add healthchecks to compose services',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Multi-stage Dockerfile (Node/Python/Go)',
      description: 'Production-ready multi-stage Dockerfile with non-root user and healthcheck',
      prompt: (wsPath) =>
        `Create a production-quality multi-stage Dockerfile.
Include:
- A builder stage that installs dependencies and compiles the application
- A minimal final stage using alpine or distroless
- Non-root USER for the final stage
- HEALTHCHECK instruction with appropriate command
- .dockerignore-aware layer ordering (copy dependency files before source)
- Build arguments (ARG) for configurable values
- Environment variables (ENV) for runtime config
- EXPOSE for the service port
- exec-form CMD or ENTRYPOINT
- Comments explaining each section
Choose a realistic stack (Node.js, Python FastAPI, or Go) based on the workspace.
Generate as ## Dockerfile then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'docker-compose.yml with services',
      description: 'Docker Compose v2 file with app, database, cache, and healthchecks',
      prompt: (wsPath) =>
        `Create a complete docker-compose.yml (Compose v2 format) for a multi-service application.
Include:
- App service with build context, ports, environment, and healthcheck
- Database service (PostgreSQL or MySQL) with named volume and healthcheck using pg_isready/mysqladmin
- Cache service (Redis) with healthcheck using redis-cli ping
- Custom bridge network for inter-service communication
- Named volumes for persistent data
- depends_on with condition: service_healthy
- env_file: .env reference for sensitive values
- A separate override file comment or profiles: for dev extras (e.g., pgAdmin, Mailhog)
- Resource limits (mem_limit or deploy.resources)
Generate as ## docker-compose.yml then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'CI/CD Dockerfile',
      description: 'Dockerfile optimized for CI/CD pipelines with build args and test stage',
      prompt: (wsPath) =>
        `Create a CI/CD-optimized Dockerfile with multiple stages.
Include:
- A base stage with pinned OS and runtime dependencies
- A deps stage that caches dependency installation separately
- A test stage that runs unit tests (fails the build if tests fail)
- A builder stage that compiles/bundles the application
- A final production stage using a minimal base image
- BuildKit cache mount comments (\`# syntax=docker/dockerfile:1\`) at the top
- ARG for version/build metadata (VERSION, GIT_COMMIT, BUILD_DATE)
- LABEL for OCI image annotations
- Non-root USER in the final stage
- HEALTHCHECK in the final stage
Generate as ## Dockerfile then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.docker.explainDockerfile',
      title: 'Evolve AI: Explain Dockerfile',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Dockerfile first'); return; }
        const code = editor.document.getText(editor.selection.isEmpty
          ? undefined
          : editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Dockerfile in detail:
- What does each stage/instruction do?
- What is the final image, and what process does it run?
- Are there any multi-stage patterns — what does each stage produce?
- Identify any potential issues (root user, missing HEALTHCHECK, unpinned tags, large layers)
- Suggest improvements

\`\`\`dockerfile
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.docker.optimize',
      title: 'Evolve AI: Optimize Dockerfile',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Dockerfile first'); return; }
        const code = editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Docker: Optimizing…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimize this Dockerfile for minimal image size and faster builds:
- Merge consecutive RUN commands with &&
- Reorder instructions for better layer caching (deps before source)
- Use a multi-stage build if not already present
- Switch to a minimal base image (alpine/distroless) for the final stage
- Add non-root USER if missing
- Add HEALTHCHECK if missing
- Clean up package manager caches in the same RUN step

Return ONLY the optimized Dockerfile, no explanation.

\`\`\`dockerfile
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimize Dockerfile',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'Docker: Optimized Dockerfile ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimized Dockerfile:\n\`\`\`dockerfile\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.docker.addHealthcheck',
      title: 'Evolve AI: Add Healthcheck',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Dockerfile first'); return; }
        const code = editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add a HEALTHCHECK instruction to this Dockerfile.
- Choose the most appropriate health check command for the service (curl, wget, pg_isready, redis-cli, etc.)
- Set interval=30s, timeout=5s, retries=3, start-period=10s (adjust if the app has a slow startup)
- Place it near the end of the file, before CMD/ENTRYPOINT
- Explain the choice of health check command

\`\`\`dockerfile
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.docker.securityAudit',
      title: 'Evolve AI: Docker Security Audit',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Dockerfile or compose file first'); return; }
        const code = editor.document.getText();
        const lang = editor.document.fileName.toLowerCase().includes('compose') ? 'yaml' : 'dockerfile';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Perform a security audit of this ${lang === 'yaml' ? 'Docker Compose' : 'Dockerfile'}.
Check for:
- Root user (containers running as root)
- Unpinned base image tags (:latest or no tag)
- Secrets or credentials baked into the image (ENV, ARG, COPY)
- Exposed unnecessary ports
- Missing HEALTHCHECK (Dockerfile only)
- Use of ADD instead of COPY
- Shell form CMD/ENTRYPOINT (prefer exec form)
- Missing USER instruction
- Overly broad COPY commands (COPY . .) without .dockerignore
- Privileged mode or dangerous capabilities in Compose
For each issue: explain the risk and provide the fix.

\`\`\`${lang}
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.docker.generateCompose',
      title: 'Evolve AI: Generate Docker Compose',
      async handler(_services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete docker-compose.yml for this application.
Include:
- App service built from the Dockerfile with port mappings
- Backing services (database, cache) appropriate to the stack
- Named volumes for persistent data
- Custom bridge network
- Healthchecks for all services
- depends_on with condition: service_healthy
- Environment variable references (use env_file: .env)
- Resource limits

${code ? `\`\`\`dockerfile\n${code}\n\`\`\`` : '(No Dockerfile open — generate a generic template)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.docker.generateDockerfile',
      title: 'Evolve AI: Generate Dockerfile',
      async handler(_services): Promise<void> {
        const lang = await vscode.window.showQuickPick(
          ['Node.js', 'Python', 'Go', 'Java (Maven)', 'Ruby on Rails', 'Rust', 'PHP'],
          { placeHolder: 'Select the application stack' }
        );
        if (!lang) { return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a production-quality multi-stage Dockerfile for a ${lang} application.
Requirements:
- Multi-stage build: deps/builder stage + minimal final stage (alpine or distroless)
- Non-root USER in the final stage
- HEALTHCHECK instruction
- Layer cache optimization (copy dependency files before source)
- BuildKit cache mount if beneficial (\`# syntax=docker/dockerfile:1\`)
- Build ARGs for version/environment
- .dockerignore instructions as comments
- Exec-form CMD or ENTRYPOINT
- Inline comments explaining each section
Generate as ## Dockerfile then the complete content.`,
          'new'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      if (this._serviceCount > 0) {
        return `$(package) Docker (${this._serviceCount} service${this._serviceCount !== 1 ? 's' : ''})`;
      }
      if (this._stageCount > 0) {
        return `$(package) Docker (${this._stageCount} stage${this._stageCount !== 1 ? 's' : ''})`;
      }
      return '$(package) Docker';
    },
  };
}
