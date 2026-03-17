/**
 * plugins/terraform.ts — Terraform / IaC stack plugin for Evolve AI
 *
 * Activates when the workspace contains any Terraform project marker.
 * Contributes:
 *  - contextHooks       : providers, resources, variables
 *  - systemPromptSection: full HCL/Terraform/Terragrunt domain knowledge (~4KB)
 *  - codeLensActions    : Explain Resource, Add Variable, Add Output
 *  - codeActions        : Extract to variable, add lifecycle, add tags, extract module
 *  - transforms         : Add tags to all resources, extract hardcoded values, generate outputs
 *  - templates          : Module structure, AWS VPC, Azure RG, Backend config
 *  - commands           : explainResource, extractVariable, addTags, generateModule, addOutput, validateSecurity
 *  - statusItem         : shows count of detected resources
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

const TERRAFORM_MARKERS = [
  '.terraform',
  'terragrunt.hcl',
];

function hasTfFiles(wsPath: string): boolean {
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith('.tf') || e.name.endsWith('.tfvars'))) {
        return true;
      }
    }
  } catch { /* skip */ }
  return false;
}

function hasTfFilesDeep(wsPath: string): boolean {
  return globFiles(wsPath, [/\.tf$/, /\.tfvars$/], 5).length > 0;
}

function findMarker(wsPath: string): string | null {
  for (const marker of TERRAFORM_MARKERS) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.terraform']);
  function walk(d: string) {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) { results.push(full); }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

/** Parse provider blocks from HCL content */
function extractProviders(content: string): string[] {
  const providers: string[] = [];
  const re = /provider\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!providers.includes(m[1])) {
      providers.push(m[1]);
    }
  }
  return providers;
}

/** Parse resource blocks: type + name */
function extractResources(content: string): Array<{ type: string; name: string }> {
  const resources: Array<{ type: string; name: string }> = [];
  const re = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    resources.push({ type: m[1], name: m[2] });
  }
  return resources;
}

/** Parse variable blocks: name + optional type/default */
function extractVariables(content: string): Array<{ name: string; type?: string; default?: string }> {
  const variables: Array<{ name: string; type?: string; default?: string }> = [];
  const re = /variable\s+"([^"]+)"\s*\{([^}]*)\}/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const typeMatch = /type\s*=\s*(\S+)/.exec(body);
    const defaultMatch = /default\s*=\s*"?([^"\n]+)"?/.exec(body);
    variables.push({
      name,
      type:    typeMatch?.[1],
      default: defaultMatch?.[1]?.trim(),
    });
  }
  return variables;
}

// ── Context data shape ────────────────────────────────────────────────────────

interface TerraformContext {
  providers:       string[];
  resources:       Array<{ type: string; name: string }>;
  variables:       Array<{ name: string; type?: string; default?: string }>;
  hasTerragrunt:   boolean;
  hasBackend:      boolean;
  hasModules:      boolean;
  tfFiles:         string[];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class TerraformPlugin implements IPlugin {
  readonly id          = 'terraform';
  readonly displayName = 'Terraform';
  readonly icon        = '$(cloud-upload)';

  private _resourceCount = 0;
  private _wsPath        = '';

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    if (findMarker(wsPath)) return true;
    if (hasTfFiles(wsPath)) return true;
    if (hasTfFilesDeep(wsPath)) return true;

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Count resources for status bar
    if (this._wsPath) {
      const tfFiles = globFiles(this._wsPath, [/\.tf$/], 50);
      let count = 0;
      for (const f of tfFiles) {
        try {
          const content = fs.readFileSync(f, 'utf8');
          count += extractResources(content).length;
        } catch { /* skip */ }
      }
      this._resourceCount = count;
    }

    console.log(`[Evolve AI] Terraform plugin activated: ${this._resourceCount} resources`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'terraform.providers',

      async collect(ws): Promise<string[]> {
        const wsPath = ws?.uri.fsPath ?? '';
        const tfFiles = globFiles(wsPath, [/\.tf$/], 50);
        const providers: string[] = [];
        for (const f of tfFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            for (const p of extractProviders(content)) {
              if (!providers.includes(p)) { providers.push(p); }
            }
          } catch { /* skip */ }
        }
        return providers;
      },

      format(data: unknown): string {
        const providers = data as string[];
        if (providers.length === 0) return '';
        return `## Terraform Providers\n${providers.map(p => `- ${p}`).join('\n')}`;
      },
    },

    {
      key: 'terraform.resources',

      async collect(ws): Promise<Array<{ type: string; name: string }>> {
        const wsPath = ws?.uri.fsPath ?? '';
        const tfFiles = globFiles(wsPath, [/\.tf$/], 50);
        const resources: Array<{ type: string; name: string }> = [];
        for (const f of tfFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            for (const r of extractResources(content)) {
              resources.push(r);
            }
          } catch { /* skip */ }
        }
        return resources.slice(0, 40);
      },

      format(data: unknown): string {
        const resources = data as Array<{ type: string; name: string }>;
        if (resources.length === 0) return '';
        const lines = ['## Terraform Resources'];
        for (const r of resources) {
          lines.push(`- resource "${r.type}" "${r.name}"`);
        }
        return lines.join('\n');
      },
    },

    {
      key: 'terraform.variables',

      async collect(ws): Promise<Array<{ name: string; type?: string; default?: string }>> {
        const wsPath = ws?.uri.fsPath ?? '';
        const tfFiles = globFiles(wsPath, [/\.tf$/], 50);
        const variables: Array<{ name: string; type?: string; default?: string }> = [];
        for (const f of tfFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8');
            for (const v of extractVariables(content)) {
              variables.push(v);
            }
          } catch { /* skip */ }
        }
        return variables.slice(0, 30);
      },

      format(data: unknown): string {
        const variables = data as Array<{ name: string; type?: string; default?: string }>;
        if (variables.length === 0) return '';
        const lines = ['## Terraform Variables'];
        for (const v of variables) {
          const parts = [`- var.${v.name}`];
          if (v.type) { parts.push(`(${v.type})`); }
          if (v.default !== undefined) { parts.push(`= ${v.default}`); }
          lines.push(parts.join(' '));
        }
        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## Terraform / HCL Expert Knowledge

You are an expert in Terraform, HashiCorp Configuration Language (HCL), cloud infrastructure as code, and Terragrunt. Apply these rules in every response involving .tf files, Terraform modules, or infrastructure configuration:

### HCL Syntax and Structure
- Terraform configuration uses HCL (HashiCorp Configuration Language) — a declarative, JSON-compatible language
- Top-level blocks: terraform {}, provider {}, resource {}, data {}, variable {}, output {}, locals {}, module {}
- String interpolation: \`"\${var.name}"\` — use for dynamic values
- For expressions: \`[for item in list : item.attribute]\`
- Conditional expressions: \`condition ? true_value : false_value\`
- Functions: toset(), tolist(), merge(), lookup(), length(), concat(), flatten(), try(), can()
- References: var.name, local.name, resource_type.resource_name.attribute, data.type.name.attr, module.name.output

### Resources
- Every resource has a type (e.g. aws_instance) and a local name (e.g. web_server)
- Use meaningful names: \`resource "aws_s3_bucket" "audit_logs"\` not \`resource "aws_s3_bucket" "bucket1"\`
- Always set required arguments; optional arguments should have documented defaults
- Use depends_on only when implicit dependencies (via references) are insufficient
- Use count or for_each for creating multiple similar resources — prefer for_each for maps/sets
- Avoid hardcoded values; use variables and locals instead

### Variables and Outputs
- Always add description and type constraints to variable blocks
- Use validation blocks for complex input validation:
  \`\`\`hcl
  validation {
    condition     = length(var.name) <= 64
    error_message = "Name must be 64 characters or fewer."
  }
  \`\`\`
- Sensitive variables: set sensitive = true to redact from output/state
- Outputs: add description, mark sensitive outputs with sensitive = true
- Use locals {} for intermediate computed values to avoid repetition

### Data Sources
- data blocks read existing infrastructure without managing it
- Always reference data sources after they are defined — Terraform resolves these at plan time
- Use data.aws_caller_identity.current, data.aws_region.current for dynamic account/region values
- Prefer data sources over hardcoded IDs for cross-stack references

### Modules
- Modules encapsulate reusable infrastructure: source can be local path, Git URL, or Terraform Registry
- Pin module versions: \`version = "~> 3.0"\` for registry modules; use Git ref/tag for Git sources
- Pass all required inputs; expose needed attributes as outputs
- Keep modules focused — one module per logical resource group (e.g. networking, compute, database)
- Use module composition over inheritance; avoid deeply nested modules

### State and Backends
- Remote backends (S3+DynamoDB, GCS, Azure Blob, Terraform Cloud) are required for teams
- S3 backend with DynamoDB locking is the standard AWS pattern:
  \`\`\`hcl
  backend "s3" {
    bucket         = "my-tfstate-bucket"
    key            = "env/prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-lock"
  }
  \`\`\`
- Never commit terraform.tfstate to version control — add to .gitignore
- Use workspaces for lightweight environment separation; use separate state files for strong isolation
- State locking prevents concurrent applies — never bypass unless explicitly recovering from a stuck lock

### Workspaces
- terraform.workspace interpolation allows per-workspace resource naming
- Use workspaces for dev/staging/prod only if infrastructure is structurally identical
- For significantly different environments, prefer separate root modules with shared modules

### Meta-Arguments
- lifecycle { prevent_destroy = true } — prevents accidental deletion of critical resources
- lifecycle { create_before_destroy = true } — zero-downtime replacement
- lifecycle { ignore_changes = [tags] } — ignore drift on specific attributes
- provider = alias for multi-region/multi-account patterns
- depends_on = [resource] — explicit dependency when implicit is insufficient

### Best Practices
- Format code with \`terraform fmt\` before committing
- Validate with \`terraform validate\`; lint with tflint or checkov
- Structure projects: separate main.tf, variables.tf, outputs.tf, providers.tf, versions.tf
- Pin Terraform and provider versions in required_providers block:
  \`\`\`hcl
  terraform {
    required_version = ">= 1.5.0"
    required_providers {
      aws = {
        source  = "hashicorp/aws"
        version = "~> 5.0"
      }
    }
  }
  \`\`\`
- Use .tfvars files for environment-specific values; never commit secrets.tfvars
- Tag all resources consistently: environment, owner, project, managed-by = "terraform"

### Security Best Practices
- Never hardcode credentials, secrets, or API keys in .tf files
- Use aws_secretsmanager_secret, Azure Key Vault, or GCP Secret Manager for secrets
- Use data "aws_ssm_parameter" or similar data sources to retrieve secrets at plan time
- Enable encryption at rest: S3 server_side_encryption_configuration, RDS storage_encrypted = true
- Restrict security group ingress: avoid 0.0.0.0/0 for SSH (22) and RDP (3389)
- Use least-privilege IAM policies — avoid wildcards (*) in Action or Resource
- Enable versioning on S3 buckets storing state or important data
- Enable CloudTrail / audit logging for production environments
- Use private subnets for databases and internal services; expose only load balancers publicly
- Scan .tf files with checkov or tfsec before applying to production

### Terragrunt
- Terragrunt wraps Terraform to provide DRY configuration via terragrunt.hcl
- Use remote_state block in root terragrunt.hcl to define backend once
- Include parent configs with include {} blocks to avoid duplication across environments
- Use inputs = {} to pass variable values from terragrunt.hcl instead of .tfvars
- generate blocks inject provider/backend configuration dynamically
- Use dependency blocks to reference outputs from other Terragrunt modules
- run_all apply applies all modules in dependency order

### Common Patterns
- For each resource group, output the resource ID and ARN/name for cross-module references
- Use null_resource with local-exec for operations not covered by providers
- Use terraform_remote_state data source to read outputs from another state file
- Dynamic blocks for repeated nested configuration:
  \`\`\`hcl
  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port   = ingress.value.from_port
      to_port     = ingress.value.to_port
      protocol    = ingress.value.protocol
      cidr_blocks = ingress.value.cidr_blocks
    }
  }
  \`\`\`
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud-upload) Explain resource',
      command:     'aiForge.terraform.explainResource',
      linePattern: /^resource\s+"[^"]+"\s+"[^"]+"/,
      languages:   ['terraform'],
      tooltip:     'Explain what this Terraform resource does and its configuration options',
    },
    {
      title:       '$(cloud-upload) Add variable',
      command:     'aiForge.terraform.extractVariable',
      linePattern: /^\s+[a-z_]+\s*=\s*"[^"]*[0-9][^"]*"/,
      languages:   ['terraform'],
      tooltip:     'Extract this hardcoded value into a Terraform variable',
    },
    {
      title:       '$(cloud-upload) Add output',
      command:     'aiForge.terraform.addOutput',
      linePattern: /^resource\s+"[^"]+"\s+"[^"]+"/,
      languages:   ['terraform'],
      tooltip:     'Generate an output block for this resource',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(cloud-upload) Terraform: Extract hardcoded value to variable',
      command:   'aiForge.terraform.extractVariable',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['terraform'],
    },
    {
      title:     '$(cloud-upload) Terraform: Add lifecycle rule',
      command:   'aiForge.terraform.addTags',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['terraform'],
    },
    {
      title:     '$(cloud-upload) Terraform: Add tags block to resource',
      command:   'aiForge.terraform.addTags',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['terraform'],
    },
    {
      title:     '$(cloud-upload) Terraform: Extract resource group to module',
      command:   'aiForge.terraform.generateModule',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['terraform'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add tags to all resources',
      description: 'Inject a standard tags block into every resource that supports tagging',
      extensions:  ['.tf'],
      async apply(content: string, filePath: string, _lang: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add a standard tags block to every resource in this Terraform file that supports tagging.
Use a consistent tagging structure with locals or merge() where appropriate:
- environment = var.environment (or local.environment if already defined)
- project     = var.project_name (or a sensible placeholder)
- managed_by  = "terraform"
- owner       = var.owner (or a sensible placeholder)

If a local.common_tags or similar already exists, use merge(local.common_tags, { ... }).
Return ONLY the complete updated .tf file with no explanation.

File: ${filePath}
\`\`\`hcl
${content}
\`\`\``,
          }],
          system: 'You are a Terraform expert. Return only the complete updated HCL file.',
          instruction: 'Add tags to all resources',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Extract hardcoded values to variables',
      description: 'Replace hardcoded strings and numbers with variable references',
      extensions:  ['.tf'],
      async apply(content: string, filePath: string, _lang: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Refactor this Terraform file to extract hardcoded values into variable declarations.
Rules:
- Move hardcoded strings (region names, instance types, CIDR blocks, AMI IDs, etc.) to variable blocks
- Add description, type, and default to each new variable
- Replace the hardcoded value with var.<name> reference
- Collect new variables at the top of the file or in a separate variables section
- Do NOT extract resource names or block labels (only argument values)
Return ONLY the complete updated .tf file with no explanation.

File: ${filePath}
\`\`\`hcl
${content}
\`\`\``,
          }],
          system: 'You are a Terraform expert. Return only the complete updated HCL file.',
          instruction: 'Extract hardcoded values to variables',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Generate outputs for all resources',
      description: 'Add output blocks for every resource ID, ARN, and key attribute',
      extensions:  ['.tf'],
      async apply(content: string, filePath: string, _lang: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add output blocks to this Terraform file for every resource's key attributes.
For each resource, generate outputs for: id, arn (if applicable), name, endpoint/url (if applicable).
Follow these conventions:
- Output name: <resource_name>_<attribute> (e.g. web_server_id)
- Add description to each output
- Mark sensitive = true for outputs containing credentials, passwords, or connection strings
Return the COMPLETE updated file including all existing content plus the new outputs appended at the end.
Return ONLY the complete updated .tf file with no explanation.

File: ${filePath}
\`\`\`hcl
${content}
\`\`\``,
          }],
          system: 'You are a Terraform expert. Return only the complete updated HCL file.',
          instruction: 'Generate outputs for all resources',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'Terraform module structure',
      description: 'Scaffolded module with main.tf, variables.tf, outputs.tf, versions.tf',
      prompt: (wsPath: string) =>
        `Create a complete, production-ready Terraform module structure.
Generate the following files with full content:

## main.tf
A sample resource (aws_s3_bucket or similar generic resource) with best-practice configuration, tags, and lifecycle rules.

## variables.tf
All input variables with type, description, default, and validation blocks where appropriate.
Include: environment, project_name, region, tags (map(string)).

## outputs.tf
Outputs for all key resource attributes (id, arn, name). Mark sensitive outputs appropriately.

## versions.tf
terraform {} block with required_version and required_providers (AWS, pinned to ~> 5.0).

## README.md
Brief module description, inputs table, outputs table, and example usage.

Follow Terraform best practices: no hardcoded values, consistent tagging, least-privilege IAM.
Workspace: ${wsPath}`,
    },
    {
      label:       'AWS VPC + subnets',
      description: 'VPC with public/private subnets, IGW, NAT Gateway, route tables',
      prompt: (wsPath: string) =>
        `Create a complete Terraform configuration for an AWS VPC with public and private subnets.
Include:

## main.tf
- aws_vpc with DNS support enabled
- aws_subnet (public) × 2 across different AZs (use data.aws_availability_zones)
- aws_subnet (private) × 2 across different AZs
- aws_internet_gateway attached to VPC
- aws_eip + aws_nat_gateway in one public subnet (single NAT for cost, note HA alternative)
- aws_route_table for public (route to IGW) and private (route to NAT)
- aws_route_table_association for each subnet
- Consistent tags on every resource using merge(local.common_tags, { Name = "..." })

## variables.tf
- vpc_cidr (default "10.0.0.0/16")
- public_subnet_cidrs (list(string), default ["10.0.1.0/24","10.0.2.0/24"])
- private_subnet_cidrs (list(string), default ["10.0.10.0/24","10.0.11.0/24"])
- environment, project_name, region

## outputs.tf
- vpc_id, vpc_cidr_block
- public_subnet_ids, private_subnet_ids
- nat_gateway_id, internet_gateway_id

## versions.tf
Pinned AWS provider ~> 5.0, Terraform >= 1.5.0

Workspace: ${wsPath}`,
    },
    {
      label:       'Azure resource group + resources',
      description: 'Azure resource group with storage account, key vault, and virtual network',
      prompt: (wsPath: string) =>
        `Create a complete Terraform configuration for Azure infrastructure.
Include:

## main.tf
- azurerm_resource_group
- azurerm_virtual_network with two subnets (app, data)
- azurerm_storage_account (LRS, HTTPS only, blob public access disabled, versioning enabled)
- azurerm_key_vault with RBAC authorization, purge protection enabled, soft delete 90 days
- azurerm_network_security_group with sensible default rules, associated to subnets
- Tags on every resource: environment, project, managed_by = "terraform"

## variables.tf
- resource_group_name, location (default "East US"), environment, project_name
- storage_account_tier, storage_replication_type
- key_vault_sku (default "standard")

## outputs.tf
- resource_group_id, resource_group_name
- storage_account_id, storage_account_name, storage_primary_connection_string (sensitive)
- key_vault_id, key_vault_uri
- vnet_id, subnet_ids

## versions.tf
Pinned AzureRM provider ~> 3.0, Terraform >= 1.5.0

Workspace: ${wsPath}`,
    },
    {
      label:       'Backend configuration (S3/GCS)',
      description: 'Remote state backend with locking: S3+DynamoDB or GCS',
      prompt: (wsPath: string) =>
        `Create Terraform backend configuration files for remote state storage.
Generate both AWS (S3) and GCP (GCS) options as separate files:

## backend-aws.tf
- S3 backend with:
  - bucket, key (path includes environment via partial configuration)
  - region, encrypt = true
  - dynamodb_table for state locking
  - kms_key_id (variable placeholder)
  - Comments explaining partial backend configuration usage (terraform init -backend-config=...)

## backend-gcs.tf
- GCS backend with:
  - bucket, prefix
  - encryption_key (variable placeholder)
  - Comments on impersonation for service account auth

## bootstrap/main.tf
The Terraform code to CREATE the S3 bucket + DynamoDB table (chicken-and-egg bootstrap):
- aws_s3_bucket with versioning, server-side encryption (AES256), block public access
- aws_dynamodb_table for locking (PAY_PER_REQUEST billing, LockID hash key)
- aws_s3_bucket_lifecycle_configuration to expire old state versions after 90 days
- Outputs: bucket_name, dynamodb_table_name

## .gitignore
Common Terraform entries: .terraform/, *.tfstate, *.tfstate.backup, .tfvars, crash.log, override.tf

Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.terraform.explainResource',
      title: 'Evolve AI: Explain Terraform Resource',
      async handler(_services: IServices, _uri: unknown, range: unknown): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this Terraform resource configuration, including:
- What cloud resource it creates and its purpose
- What each argument controls and its default behaviour
- Any security or cost implications
- Best-practice improvements or missing arguments

\`\`\`hcl
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.terraform.extractVariable',
      title: 'Evolve AI: Extract to Variable',
      async handler(_services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Terraform file first'); return; }
        const selection = editor.document.getText(editor.selection);
        if (!selection.trim()) { vscode.window.showWarningMessage('Select a value to extract'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Extract this hardcoded value from the Terraform file into a properly-typed variable block.
Provide:
1. The variable block with type, description, and default
2. The updated resource argument using var.<name>
3. A brief explanation of why this value should be a variable

Selected value: \`${selection}\`

Full file context:
\`\`\`hcl
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.terraform.addTags',
      title: 'Evolve AI: Add Tags to Resource',
      async handler(_services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Terraform file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add a comprehensive tags block to all taggable resources in this Terraform file.
Use locals to define common_tags and merge with resource-specific tags:
- environment, project, managed_by = "terraform", owner
- If variables for these already exist, reference them; otherwise add variable declarations.

Return the complete updated file.

\`\`\`hcl
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.terraform.generateModule',
      title: 'Evolve AI: Generate Terraform Module',
      async handler(_services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText(editor.selection) || editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert the following Terraform resources into a reusable module.
Create separate files:
- main.tf — the resource definitions, referencing var.* for all configurable values
- variables.tf — all input variables with type, description, and default
- outputs.tf — outputs for all key attributes (id, arn, name, etc.)
- README.md — module description, inputs table, outputs table, example usage

${code ? `\`\`\`hcl\n${code}\n\`\`\`` : '(No selection — generate a generic reusable module template)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.terraform.addOutput',
      title: 'Evolve AI: Add Output',
      async handler(_services: IServices, _uri: unknown, range: unknown): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Terraform file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate output blocks for the Terraform resource(s) in the following code.
For each resource, create outputs for: id, arn (if applicable), name/dns_name/endpoint (if applicable).
Follow these conventions:
- Name: <resource_name>_<attribute>
- Include description
- Mark sensitive = true for passwords, connection strings, keys

\`\`\`hcl
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.terraform.validateSecurity',
      title: 'Evolve AI: Check Security Best Practices',
      async handler(_services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Terraform file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Review this Terraform file for security issues and best-practice violations.
Check for:
- Hardcoded credentials, secrets, API keys, or passwords
- Overly permissive security group rules (0.0.0.0/0 on sensitive ports)
- S3 buckets with public access enabled
- Missing encryption at rest (S3, RDS, EBS, etc.)
- IAM policies with wildcard (*) actions or resources
- Missing logging/audit trails (CloudTrail, VPC flow logs)
- Resources missing lifecycle { prevent_destroy = true } for critical infrastructure
- Missing encryption in transit (HTTP endpoints, unencrypted DB connections)
- Publicly accessible databases or internal services

For each issue found, provide:
1. The specific resource and argument that is problematic
2. The risk it introduces
3. The corrected HCL snippet

\`\`\`hcl
${editor.document.getText()}
\`\`\``,
          'chat'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      return `$(cloud-upload) ${this._resourceCount} resource${this._resourceCount !== 1 ? 's' : ''}`;
    },
  };
}
