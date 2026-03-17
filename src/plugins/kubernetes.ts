/**
 * plugins/kubernetes.ts — Kubernetes / Helm / Kustomize plugin for Evolve AI
 *
 * Activates when the workspace contains Kubernetes manifests, Helm charts,
 * Kustomize overlays, or Skaffold config.
 * Contributes:
 *  - contextHooks       : manifest inventory, Helm chart info, namespaces
 *  - systemPromptSection: full Kubernetes domain knowledge (~4KB)
 *  - codeLensActions    : Explain Resource, Add Probes, Add Resources
 *  - codeActions        : Add resource limits, add probes, add SecurityContext, add NetworkPolicy
 *  - transforms         : Add resource limits, add health checks, add security contexts
 *  - templates          : Deployment+Service+Ingress, Helm scaffold, CronJob, RBAC
 *  - commands           : explainResource, addProbes, addResources, addSecurity, generateManifest, addNetworkPolicy
 *  - statusItem         : shows manifest count
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

const K8S_MARKERS = [
  'kustomization.yaml',
  'kustomization.yml',
  'Chart.yaml',
  'skaffold.yaml',
];

const K8S_DIRS = ['k8s', 'kubernetes', 'manifests'];

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

function isK8sManifest(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 3000);
    return /apiVersion:\s*\S+/.test(content) && /kind:\s*\S+/.test(content);
  } catch { return false; }
}

function hasK8sDirs(wsPath: string): boolean {
  for (const dir of K8S_DIRS) {
    const dirPath = path.join(wsPath, dir);
    if (fs.existsSync(dirPath)) {
      const yamlFiles = globFiles(dirPath, [/\.ya?ml$/], 3);
      if (yamlFiles.some(f => isK8sManifest(f))) { return true; }
    }
  }
  return false;
}

// ── Context data shape ────────────────────────────────────────────────────────

interface ManifestEntry {
  file: string;
  kind: string;
  name: string;
  namespace: string;
}

interface HelmInfo {
  name: string;
  version: string;
  description: string;
  valueKeys: string[];
}

interface K8sContext {
  manifestCount: number;
  manifests: ManifestEntry[];
  helm: HelmInfo | null;
  namespaces: string[];
  hasKustomize: boolean;
  hasSkaffold: boolean;
}

function extractManifestMeta(filePath: string, wsPath: string): ManifestEntry[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const entries: ManifestEntry[] = [];
    // Split on YAML document separator
    const docs = content.split(/^---\s*$/m);
    for (const doc of docs) {
      const kindMatch  = doc.match(/^kind:\s*(\S+)/m);
      const nameMatch  = doc.match(/^\s{0,4}name:\s*(\S+)/m);
      const nsMatch    = doc.match(/^\s{0,4}namespace:\s*(\S+)/m);
      if (kindMatch) {
        entries.push({
          file:      path.relative(wsPath, filePath),
          kind:      kindMatch[1],
          name:      nameMatch?.[1] ?? '(unnamed)',
          namespace: nsMatch?.[1] ?? 'default',
        });
      }
    }
    return entries;
  } catch { return []; }
}

function extractHelmInfo(wsPath: string): HelmInfo | null {
  const chartPath = path.join(wsPath, 'Chart.yaml');
  if (!fs.existsSync(chartPath)) { return null; }
  try {
    const content = fs.readFileSync(chartPath, 'utf8');
    const name    = content.match(/^name:\s*(.+)/m)?.[1]?.trim() ?? '';
    const version = content.match(/^version:\s*(.+)/m)?.[1]?.trim() ?? '';
    const desc    = content.match(/^description:\s*(.+)/m)?.[1]?.trim() ?? '';

    // Extract top-level keys from values.yaml
    let valueKeys: string[] = [];
    const valuesPath = path.join(wsPath, 'values.yaml');
    if (fs.existsSync(valuesPath)) {
      const valContent = fs.readFileSync(valuesPath, 'utf8').slice(0, 4000);
      valueKeys = (valContent.match(/^[a-zA-Z][a-zA-Z0-9_]*:/gm) ?? [])
        .map(k => k.replace(':', '').trim())
        .slice(0, 20);
    }
    return { name, version, description: desc, valueKeys };
  } catch { return null; }
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class KubernetesPlugin implements IPlugin {
  readonly id          = 'kubernetes';
  readonly displayName = 'Kubernetes';
  readonly icon        = '$(server-process)';

  private _wsPath        = '';
  private _manifestCount = 0;

  // ── detect ─────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) { return false; }
    const wsPath = ws.uri.fsPath;

    // Check direct markers
    for (const marker of K8S_MARKERS) {
      if (fs.existsSync(path.join(wsPath, marker))) { return true; }
    }

    // Check k8s/kubernetes/manifests dirs
    if (hasK8sDirs(wsPath)) { return true; }

    // Scan YAML files for apiVersion + kind pattern
    const yamlFiles = globFiles(wsPath, [/\.ya?ml$/], 20);
    for (const f of yamlFiles) {
      if (isK8sManifest(f)) { return true; }
    }

    return false;
  }

  // ── activate ───────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';
    if (this._wsPath) {
      const yamlFiles = globFiles(this._wsPath, [/\.ya?ml$/], 50);
      const manifests = yamlFiles.filter(f => isK8sManifest(f));
      this._manifestCount = manifests.length;
    }
    console.log(`[Evolve AI] Kubernetes plugin activated (${this._manifestCount} manifests)`);
    return [];
  }

  // ── contextHooks ───────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'k8s.manifests',

      async collect(ws): Promise<ManifestEntry[]> {
        const wsPath = ws?.uri.fsPath ?? '';
        if (!wsPath) { return []; }
        const yamlFiles = globFiles(wsPath, [/\.ya?ml$/], 50);
        const manifests = yamlFiles.filter(f => isK8sManifest(f));
        return manifests.flatMap(f => extractManifestMeta(f, wsPath)).slice(0, 40);
      },

      format(data: unknown): string {
        const entries = data as ManifestEntry[];
        if (!entries.length) { return ''; }
        const lines = ['## Kubernetes Manifests'];
        for (const e of entries.slice(0, 20)) {
          lines.push(`- ${e.kind}/${e.name} (ns: ${e.namespace}) — ${e.file}`);
        }
        if (entries.length > 20) {
          lines.push(`... and ${entries.length - 20} more`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'k8s.helm',

      async collect(ws): Promise<HelmInfo | null> {
        const wsPath = ws?.uri.fsPath ?? '';
        if (!wsPath) { return null; }
        return extractHelmInfo(wsPath);
      },

      format(data: unknown): string {
        const info = data as HelmInfo | null;
        if (!info) { return ''; }
        const lines = [
          `## Helm Chart: ${info.name} v${info.version}`,
        ];
        if (info.description) { lines.push(`Description: ${info.description}`); }
        if (info.valueKeys.length > 0) {
          lines.push(`Top-level values keys: ${info.valueKeys.join(', ')}`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'k8s.namespaces',

      async collect(ws): Promise<string[]> {
        const wsPath = ws?.uri.fsPath ?? '';
        if (!wsPath) { return []; }
        const yamlFiles = globFiles(wsPath, [/\.ya?ml$/], 50);
        const manifests = yamlFiles.filter(f => isK8sManifest(f));
        const namespaces = new Set<string>();
        for (const f of manifests) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            const matches = content.matchAll(/^\s{0,4}namespace:\s*(\S+)/gm);
            for (const m of matches) { namespaces.add(m[1]); }
          } catch { /* skip */ }
        }
        return [...namespaces].filter(ns => ns !== 'default').slice(0, 20);
      },

      format(data: unknown): string {
        const namespaces = data as string[];
        if (!namespaces.length) { return ''; }
        return `## Kubernetes Namespaces\n${namespaces.join(', ')}`;
      },
    },
  ];

  // ── systemPromptSection ────────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Kubernetes Expert Knowledge

You are an expert in Kubernetes, Helm, Kustomize, and cloud-native infrastructure. Apply these rules in every response involving Kubernetes manifests, YAML, Helm charts, or cluster operations:

### Pod Spec Fundamentals
- Every Pod spec must define containers with name and image
- Use initContainers for setup tasks that must complete before main containers start
- Volumes are declared at the Pod level; volumeMounts reference them inside containers
- Use env for individual values; use envFrom for ConfigMap/Secret bulk injection
- Never hardcode secrets as env vars — use secretKeyRef or envFrom with Secret

### Deployments
- Always specify selector.matchLabels matching template.metadata.labels exactly
- Use RollingUpdate strategy (maxUnavailable: 1, maxSurge: 1) for zero-downtime deploys
- Use Recreate strategy only when the app cannot run multiple versions simultaneously
- Set minReadySeconds to ensure pods are healthy before marking rollout complete
- Always set replicas explicitly; do not rely on defaults

### Services
- ClusterIP: internal only (default); use for inter-service communication
- NodePort: exposes on every node (30000–32767); avoid in production — use Ingress instead
- LoadBalancer: cloud provider LB; use for L4 external access
- ExternalName: DNS alias; useful for migrating services to Kubernetes
- Port naming: use descriptive names (http, grpc, metrics) not just numbers

### ConfigMaps & Secrets
- Use ConfigMap for non-sensitive configuration (app settings, config files)
- Use Secret for credentials, certificates, and tokens (base64-encoded, not encrypted at rest by default — enable EncryptionConfiguration)
- Set immutable: true on ConfigMaps/Secrets that should not change; improves performance
- Mount as volumes for multi-line configs; use env/envFrom for key-value pairs

### Resource Management
- ALWAYS set resources.requests and resources.limits on every container
- requests: what the scheduler uses for placement; limits: hard cap at runtime
- QoS classes: Guaranteed (req == limit), Burstable (req < limit), BestEffort (none — avoid)
- Use LimitRange to set namespace defaults; use ResourceQuota to cap namespace totals
- CPU is compressible (throttled); memory is not (OOMKilled when exceeded)

### Health Checks
- livenessProbe: restart container if failing (use for deadlock detection)
- readinessProbe: remove from Service endpoints if failing (use for startup/load)
- startupProbe: delays liveness/readiness checks until app is ready (for slow starters)
- Prefer httpGet or tcpSocket over exec; exec probes run a new process each check
- Set initialDelaySeconds generously for slow-starting apps; tune periodSeconds and failureThreshold

### RBAC
- Principle of least privilege: grant only the permissions actually needed
- Use Role + RoleBinding for namespace-scoped permissions
- Use ClusterRole + ClusterRoleBinding for cluster-wide permissions
- Create a dedicated ServiceAccount per application — never use the default SA
- Never grant cluster-admin to application workloads

### Networking
- Ingress requires an IngressController (nginx, traefik, etc.) to be installed
- Use Ingress for L7 HTTP/S routing with TLS termination, host-based, and path-based routing
- NetworkPolicy is default-deny by design: adding a NetworkPolicy restricts all unselected traffic
- DNS: services resolve as <service>.<namespace>.svc.cluster.local
- Headless Services (clusterIP: None): for StatefulSets and direct pod DNS

### Storage
- PersistentVolumeClaim (PVC) requests storage; PersistentVolume (PV) provides it
- Use StorageClass with dynamic provisioning — avoid manually creating PVs
- Access modes: ReadWriteOnce (single node), ReadOnlyMany (multiple nodes read), ReadWriteMany (NFS/EFS)
- Use StatefulSets for stateful apps with stable pod identity and persistent storage

### Jobs & CronJobs
- Job: run-to-completion workload; set completions and parallelism appropriately
- Set backoffLimit to prevent infinite retries; use activeDeadlineSeconds for time caps
- CronJob: scheduled Jobs using cron syntax; set concurrencyPolicy (Allow/Forbid/Replace)
- Use ttlSecondsAfterFinished to auto-clean completed Jobs

### Helm
- Chart structure: Chart.yaml (metadata), values.yaml (defaults), templates/ (manifests), charts/ (dependencies)
- Use {{ .Values.xxx }} for configurable values; use {{ .Release.Name }} for release-scoped names
- helpers (_helpers.tpl): define named templates with {{- define "chart.fullname" -}}
- Hooks: pre-install, post-install, pre-upgrade for migrations and setup
- Use helm lint and helm template to validate before deploying
- Pin dependencies with Chart.lock; use helm dependency update

### Kustomize
- bases: reference base manifests (directory or URL)
- overlays: environment-specific customizations (dev/staging/prod)
- patches: strategic merge patches or JSON patches for targeted changes
- generators: configMapGenerator and secretGenerator create ConfigMaps/Secrets from files
- transformers: add common labels, annotations, name prefixes/suffixes

### Security Best Practices
- Set securityContext.runAsNonRoot: true and runAsUser to a non-zero UID
- Set readOnlyRootFilesystem: true and mount specific writable paths as emptyDir
- Set allowPrivilegeEscalation: false on all containers
- Drop all Linux capabilities and add back only what's needed: capabilities.drop: [ALL]
- Use PodDisruptionBudget to ensure availability during voluntary disruptions
- Use Pod Security Standards (Baseline/Restricted) — PodSecurityPolicy is deprecated

### Labels & Annotations Best Practices
- Always apply standard labels: app.kubernetes.io/name, app.kubernetes.io/version, app.kubernetes.io/component, app.kubernetes.io/managed-by
- Use annotations for non-identifying metadata (deployment tools, documentation links)
- Selectors are immutable once a Deployment is created — choose labels carefully
`.trim();
  }

  // ── codeLensActions ────────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(server-process) Explain K8s resource',
      command:     'aiForge.k8s.explainResource',
      linePattern: /^apiVersion:\s*\S+/,
      languages:   ['yaml'],
      tooltip:     'Explain what this Kubernetes resource does and how to configure it',
    },
    {
      title:       '$(server-process) Add health probes',
      command:     'aiForge.k8s.addProbes',
      linePattern: /^\s+containers:/,
      languages:   ['yaml'],
      tooltip:     'Add liveness, readiness, and startup probes to this container spec',
    },
    {
      title:       '$(server-process) Add resource limits',
      command:     'aiForge.k8s.addResources',
      linePattern: /^\s+- name:\s*\S+/,
      languages:   ['yaml'],
      tooltip:     'Add resource requests and limits to this container definition',
    },
  ];

  // ── codeActions (lightbulb) ────────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(server-process) K8s: Add resource requests/limits',
      command:   'aiForge.k8s.addResources',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['yaml'],
    },
    {
      title:     '$(server-process) K8s: Add liveness + readiness probes',
      command:   'aiForge.k8s.addProbes',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['yaml'],
    },
    {
      title:     '$(server-process) K8s: Add SecurityContext (non-root, read-only)',
      command:   'aiForge.k8s.addSecurity',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['yaml'],
    },
    {
      title:     '$(server-process) K8s: Add NetworkPolicy for namespace isolation',
      command:   'aiForge.k8s.addNetworkPolicy',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['yaml'],
    },
  ];

  // ── transforms ─────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add resource limits to all containers',
      description: 'Add CPU/memory requests and limits to every container in the manifest',
      extensions:  ['.yaml', '.yml'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add resource requests and limits to every container in this Kubernetes manifest.
For each container that is missing resources, add:
  resources:
    requests:
      cpu: "100m"
      memory: "128Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"
Adjust values based on the container's role (web server, worker, database sidecar, etc.).
Return ONLY the complete updated YAML file with no explanation.

File: ${filePath}
\`\`\`yaml
${content}
\`\`\``,
          }],
          system: 'You are a Kubernetes expert. Return only the complete updated YAML manifest.',
          instruction: 'Add resource limits to all containers',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add health checks to all deployments',
      description: 'Add livenessProbe and readinessProbe to every Deployment container',
      extensions:  ['.yaml', '.yml'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add livenessProbe and readinessProbe to every container in this Kubernetes manifest.
Infer the probe type and path from the container image/port if possible:
- For HTTP servers: use httpGet with the appropriate path and port
- For TCP servers: use tcpSocket
- Set reasonable initialDelaySeconds, periodSeconds, and failureThreshold
Return ONLY the complete updated YAML file with no explanation.

File: ${filePath}
\`\`\`yaml
${content}
\`\`\``,
          }],
          system: 'You are a Kubernetes expert. Return only the complete updated YAML manifest.',
          instruction: 'Add health checks to all deployments',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add security contexts to all pods',
      description: 'Add SecurityContext with non-root user, read-only filesystem, dropped capabilities',
      extensions:  ['.yaml', '.yml'],
      async apply(content, filePath, _lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add security hardening to every Pod spec in this Kubernetes manifest:
1. Pod-level securityContext:
   runAsNonRoot: true
   runAsUser: 1000
   fsGroup: 2000
2. Container-level securityContext:
   allowPrivilegeEscalation: false
   readOnlyRootFilesystem: true
   capabilities:
     drop: ["ALL"]
3. Add emptyDir volumes for any paths that need to be writable (e.g., /tmp, /var/cache).
Return ONLY the complete updated YAML file with no explanation.

File: ${filePath}
\`\`\`yaml
${content}
\`\`\``,
          }],
          system: 'You are a Kubernetes security expert. Return only the complete updated YAML manifest.',
          instruction: 'Add security contexts to all pods',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ──────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Deployment + Service + Ingress',
      description: 'Full web application stack with Deployment, Service, Ingress, and ConfigMap',
      prompt: (wsPath) =>
        `Create a complete Kubernetes application stack in YAML.
Include in a single file separated by ---:
- ConfigMap with application configuration
- Deployment with:
  - 3 replicas, RollingUpdate strategy
  - Resource requests and limits
  - livenessProbe (httpGet /health) and readinessProbe (httpGet /ready)
  - SecurityContext: runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities
  - envFrom referencing the ConfigMap
- Service (ClusterIP) exposing port 80 → container port 8080
- Ingress with TLS, host-based routing, and nginx annotations
- PodDisruptionBudget with minAvailable: 2
Use app.kubernetes.io/* standard labels throughout.
Generate as ## app-stack.yaml then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Helm chart scaffold',
      description: 'Complete Helm chart with Chart.yaml, values.yaml, and production-ready templates',
      prompt: (wsPath) =>
        `Create a complete Helm chart scaffold for a web application.
Generate the following files, each prefixed with ## filename:
## Chart.yaml — chart metadata with name, version, appVersion, description, dependencies
## values.yaml — comprehensive defaults (image, replicaCount, resources, ingress, autoscaling, serviceAccount, podSecurityContext)
## templates/_helpers.tpl — fullname, labels, and selectorLabels named templates
## templates/deployment.yaml — Deployment using helpers, values, probes, securityContext, resources
## templates/service.yaml — Service using values.service
## templates/ingress.yaml — Ingress with conditional enabled flag and TLS support
## templates/hpa.yaml — HorizontalPodAutoscaler with conditional enabled flag
## templates/serviceaccount.yaml — ServiceAccount with conditional creation
## templates/NOTES.txt — post-install instructions
Workspace: ${wsPath}`,
    },
    {
      label:       'CronJob manifest',
      description: 'CronJob with retry handling, resource limits, and security context',
      prompt: (wsPath) =>
        `Create a production-ready Kubernetes CronJob manifest.
Include:
- CronJob with configurable schedule (default: "0 * * * *" — every hour)
- concurrencyPolicy: Forbid (prevent overlapping runs)
- successfulJobsHistoryLimit: 3 and failedJobsHistoryLimit: 3
- Job template with:
  - backoffLimit: 3
  - activeDeadlineSeconds: 3600
  - Container with resource requests/limits
  - SecurityContext: runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities
  - envFrom a ConfigMap reference (also include the ConfigMap)
  - restartPolicy: OnFailure
- Standard app.kubernetes.io/* labels
Generate as ## cronjob.yaml then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'RBAC (ServiceAccount + Role + Binding)',
      description: 'Minimal RBAC setup: ServiceAccount, Role with least-privilege rules, and RoleBinding',
      prompt: (wsPath) =>
        `Create a minimal RBAC configuration for a Kubernetes application.
Include in a single file separated by ---:
- Namespace (if not default)
- ServiceAccount with automountServiceAccountToken: false
- Role with minimal permissions appropriate for a typical web app (e.g., get/list/watch Secrets, ConfigMaps, and its own Pods)
- RoleBinding linking the ServiceAccount to the Role
- ClusterRole + ClusterRoleBinding example for metrics reading (Prometheus use case)
Add comments explaining when to use Role vs ClusterRole and least-privilege principles.
Generate as ## rbac.yaml then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ───────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.k8s.explainResource',
      title: 'Evolve AI: Explain K8s Resource',
      async handler(services, _uri, _range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const code = editor.document.getText(editor.selection.isEmpty
          ? undefined
          : editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Kubernetes resource. Include:
- What this resource does and its role in the cluster
- Key fields and their purpose
- Any potential issues or misconfigurations
- Best practice recommendations

\`\`\`yaml
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.k8s.addProbes',
      title: 'Evolve AI: Add Health Probes',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Kubernetes manifest first'); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'K8s: Adding health probes…', cancellable: false },
          async () => {
            const content = editor.document.getText();
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Add livenessProbe and readinessProbe to every container in this Kubernetes manifest.
Infer probe type (httpGet/tcpSocket/exec) and parameters from the container definition.
Set sensible initialDelaySeconds, periodSeconds, timeoutSeconds, and failureThreshold.
Return ONLY the complete updated YAML.

\`\`\`yaml
${content}
\`\`\``,
              }],
              system: sys,
              instruction: 'Add health probes',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'K8s: Probes ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Updated manifest with probes:\n\`\`\`yaml\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.k8s.addResources',
      title: 'Evolve AI: Add Resource Limits',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Kubernetes manifest first'); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'K8s: Adding resource limits…', cancellable: false },
          async () => {
            const content = editor.document.getText();
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Add CPU and memory requests/limits to every container in this Kubernetes manifest.
Infer appropriate values from the container's role and image name.
Return ONLY the complete updated YAML.

\`\`\`yaml
${content}
\`\`\``,
              }],
              system: sys,
              instruction: 'Add resource limits',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'K8s: Resource limits ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Updated manifest with resource limits:\n\`\`\`yaml\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.k8s.addSecurity',
      title: 'Evolve AI: Add Security Context',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Kubernetes manifest first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add security hardening to every Pod and container spec in this Kubernetes manifest.
Apply:
- Pod-level: runAsNonRoot: true, runAsUser: 1000, fsGroup: 2000
- Container-level: allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities.drop: [ALL]
- Add emptyDir volumes for writable paths (/tmp, /var/cache, etc.) as needed.
Return the complete updated YAML.

\`\`\`yaml
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.k8s.generateManifest',
      title: 'Evolve AI: Generate K8s Manifest',
      async handler(services): Promise<void> {
        const desc = await vscode.window.showInputBox({
          prompt: 'Describe the Kubernetes resource to generate',
          placeHolder: 'e.g. "Redis deployment with 3 replicas and persistent storage"',
        });
        if (!desc) { return; }
        const ws    = vscode.workspace.workspaceFolders?.[0];
        const wsPath = ws?.uri.fsPath ?? '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a production-ready Kubernetes manifest for: ${desc}

Requirements:
- Include all necessary resources (Deployment, Service, ConfigMap, PVC, etc.)
- Add resource requests/limits to all containers
- Add liveness and readiness probes
- Add SecurityContext (non-root, read-only rootfs, drop ALL capabilities)
- Use standard app.kubernetes.io/* labels
- Separate multiple resources with ---

Workspace: ${wsPath}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.k8s.addNetworkPolicy',
      title: 'Evolve AI: Add Network Policy',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Kubernetes manifest first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a NetworkPolicy for this Kubernetes application that:
1. Denies all ingress and egress by default
2. Allows ingress only from the Ingress controller and other pods with matching labels
3. Allows egress to kube-dns (UDP/TCP port 53) for DNS resolution
4. Allows egress to other application pods it needs to communicate with (infer from the manifest)
5. Includes comments explaining each rule

Analyze this manifest to determine the correct pod selectors and namespaces:
\`\`\`yaml
${editor.document.getText()}
\`\`\``,
          'new'
        );
      },
    },
  ];

  // ── statusItem ─────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      const count = this._manifestCount;
      return `$(server-process) K8s: ${count} manifest${count !== 1 ? 's' : ''}`;
    },
  };
}
