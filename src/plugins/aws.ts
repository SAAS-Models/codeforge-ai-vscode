/**
 * plugins/aws.ts — AWS cloud plugin for Evolve AI
 *
 * Activates when the workspace contains any AWS project marker.
 * Contributes:
 *  - contextHooks      : SAM/CloudFormation resources, CDK stacks, Lambda handlers, AWS imports
 *  - systemPromptSection: full AWS Lambda/IAM/DynamoDB/S3/API Gateway/CDK domain knowledge
 *  - codeLensActions   : Lambda handlers, CloudFormation resources, CDK constructs
 *  - codeActions       : Optimize Lambda, Add IAM policy, Add error handling
 *  - transforms        : Add AWS SDK error handling, Add CloudWatch logging
 *  - templates         : Lambda function, SAM app, CDK stack, API+Lambda+DynamoDB
 *  - commands          : explainStack, optimizeLambda, generateIAM, addErrorHandling,
 *                        convertToCDK, generateSAM, explainCost, addLogging
 *  - statusItem        : shows detected AWS services count
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

const AWS_MARKER_FILES = [
  'samconfig.toml',
  'samconfig.yaml',
  'cdk.json',
  'serverless.yml',
  'serverless.yaml',
  'buildspec.yml',
  'appspec.yml',
  'taskdef.json',
  'Dockerrun.aws.json',
];

/** template.yaml / template.yml need content check for AWSTemplateFormatVersion */
const CFN_TEMPLATE_FILES = ['template.yaml', 'template.yml'];

const AWS_IMPORT_PATTERN = /import\s+boto3|from\s+boto3|from\s+aws_cdk|require\(['"]aws-sdk['"]\)|@aws-sdk\//;

function findMarkerFile(wsPath: string): string | null {
  for (const marker of AWS_MARKER_FILES) {
    if (fs.existsSync(path.join(wsPath, marker))) return marker;
  }
  return null;
}

function hasCfnTemplate(wsPath: string): boolean {
  for (const name of CFN_TEMPLATE_FILES) {
    const full = path.join(wsPath, name);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, 'utf8').slice(0, 2000);
        if (/AWSTemplateFormatVersion/i.test(content)) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

function hasAwsCredentials(wsPath: string): boolean {
  const awsDir = path.join(wsPath, '.aws');
  return fs.existsSync(path.join(awsDir, 'credentials')) ||
         fs.existsSync(path.join(awsDir, 'config'));
}

function hasAwsImportsInDeps(wsPath: string): boolean {
  for (const depFile of ['requirements.txt', 'pyproject.toml', 'setup.py', 'package.json']) {
    const full = path.join(wsPath, depFile);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        if (/boto3|aws-cdk|@aws-sdk|aws-sdk|serverless|aws-lambda/i.test(content)) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

// ── Helper: walk for specific file patterns ───────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', 'cdk.out', '.aws-sam']);
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

// ── Context data shape ────────────────────────────────────────────────────────

interface AwsContext {
  projectType:     string;
  marker:          string | null;
  cfnResources:    string[];
  cdkStacks:       string[];
  lambdaHandlers:  string[];
  awsServices:     string[];
  templateSnippet: string | null;
  cdkConfig:       string | null;
  serviceCount:    number;
}

// ── Detect project type ───────────────────────────────────────────────────────

function detectProjectType(wsPath: string): string {
  if (fs.existsSync(path.join(wsPath, 'cdk.json')))                                      return 'AWS CDK';
  if (fs.existsSync(path.join(wsPath, 'samconfig.toml')) ||
      fs.existsSync(path.join(wsPath, 'samconfig.yaml')))                                return 'AWS SAM';
  if (fs.existsSync(path.join(wsPath, 'serverless.yml')) ||
      fs.existsSync(path.join(wsPath, 'serverless.yaml')))                               return 'Serverless Framework';
  if (hasCfnTemplate(wsPath))                                                             return 'CloudFormation';
  if (fs.existsSync(path.join(wsPath, 'buildspec.yml')))                                 return 'CodeBuild';
  if (fs.existsSync(path.join(wsPath, 'appspec.yml')))                                   return 'CodeDeploy';
  if (fs.existsSync(path.join(wsPath, 'taskdef.json')))                                  return 'ECS';
  if (fs.existsSync(path.join(wsPath, 'Dockerrun.aws.json')))                            return 'Elastic Beanstalk';
  return 'AWS';
}

/** Extract CloudFormation resource types from a template file */
function extractCfnResources(wsPath: string): string[] {
  const resources: string[] = [];
  const re = /Type:\s*['"]?(AWS::\w+::\w+)/g;
  for (const name of [...CFN_TEMPLATE_FILES, 'template.json']) {
    const full = path.join(wsPath, name);
    if (!fs.existsSync(full)) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        if (!resources.includes(m[1])) resources.push(m[1]);
      }
      re.lastIndex = 0;
    } catch { /* skip */ }
  }
  return resources;
}

/** Extract AWS service names from imports across source files */
function extractAwsServices(wsPath: string): string[] {
  const services = new Set<string>();
  const srcFiles = globFiles(wsPath, [/\.py$/, /\.ts$/, /\.js$/], 50);
  const reBoto3  = /(?:client|resource)\s*\(\s*['"](\w+)['"]/g;
  const reSdkV3  = /@aws-sdk\/client-(\w[\w-]*)/g;
  const reAwsV2  = /new\s+AWS\.(\w+)/g;
  for (const f of srcFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 3000);
      // boto3 clients/resources
      let m: RegExpExecArray | null;
      reBoto3.lastIndex = 0;
      while ((m = reBoto3.exec(content)) !== null) services.add(m[1]);
      // @aws-sdk/client-xxx
      reSdkV3.lastIndex = 0;
      while ((m = reSdkV3.exec(content)) !== null) services.add(m[1]);
      // require('aws-sdk') usage
      if (/new\s+AWS\.\w+/i.test(content)) {
        reAwsV2.lastIndex = 0;
        while ((m = reAwsV2.exec(content)) !== null) services.add(m[1]);
      }
    } catch { /* skip */ }
  }
  return Array.from(services);
}

/** Find Lambda handler function files */
function findLambdaHandlers(wsPath: string): string[] {
  const handlers: string[] = [];
  const srcFiles = globFiles(wsPath, [/\.py$/, /\.ts$/, /\.js$/], 50);
  for (const f of srcFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 4000);
      if (/def\s+handler\s*\(event|exports\.handler\s*=|export\s+(?:async\s+)?function\s+handler|module\.exports\.handler/.test(content)) {
        handlers.push(path.relative(wsPath, f));
      }
    } catch { /* skip */ }
  }
  return handlers;
}

/** Find CDK stack files */
function findCdkStacks(wsPath: string): string[] {
  const stacks: string[] = [];
  const srcFiles = globFiles(wsPath, [/\.ts$/, /\.py$/, /\.js$/], 40);
  for (const f of srcFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8').slice(0, 3000);
      if (/extends\s+(?:cdk\.)?Stack|class\s+\w+Stack|from\s+aws_cdk\s+import/.test(content)) {
        stacks.push(path.relative(wsPath, f));
      }
    } catch { /* skip */ }
  }
  return stacks;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class AwsPlugin implements IPlugin {
  readonly id          = 'aws';
  readonly displayName = 'AWS';
  readonly icon        = '$(cloud)';

  private _projectType = 'AWS';
  private _wsPath      = '';
  private _serviceCount = 0;

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Fast: check marker files first
    if (findMarkerFile(wsPath)) return true;
    if (hasCfnTemplate(wsPath)) return true;
    if (hasAwsCredentials(wsPath)) return true;
    if (hasAwsImportsInDeps(wsPath)) return true;

    // Slower: scan source files for AWS imports
    const srcFiles = globFiles(wsPath, [/\.py$/, /\.ts$/, /\.js$/], 50);
    for (const f of srcFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (AWS_IMPORT_PATTERN.test(sample)) return true;
      } catch { /* skip */ }
    }

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath      = ws?.uri.fsPath ?? '';
    this._projectType = this._wsPath ? detectProjectType(this._wsPath) : 'AWS';
    this._serviceCount = this._wsPath ? extractAwsServices(this._wsPath).length : 0;
    console.log(`[Evolve AI] AWS plugin activated: ${this._projectType} (${this._serviceCount} services detected)`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'aws',

      async collect(ws): Promise<AwsContext> {
        const wsPath = ws?.uri.fsPath ?? '';

        const cfnResources   = extractCfnResources(wsPath);
        const cdkStacks      = findCdkStacks(wsPath);
        const lambdaHandlers = findLambdaHandlers(wsPath);
        const awsServices    = extractAwsServices(wsPath);

        // Read template snippet if available
        let templateSnippet: string | null = null;
        for (const name of [...CFN_TEMPLATE_FILES, 'template.json']) {
          const full = path.join(wsPath, name);
          if (fs.existsSync(full)) {
            try {
              templateSnippet = fs.readFileSync(full, 'utf8').slice(0, 2000);
            } catch { /* skip */ }
            break;
          }
        }

        // Read CDK config if available
        let cdkConfig: string | null = null;
        const cdkJsonPath = path.join(wsPath, 'cdk.json');
        if (fs.existsSync(cdkJsonPath)) {
          try {
            cdkConfig = fs.readFileSync(cdkJsonPath, 'utf8').slice(0, 1500);
          } catch { /* skip */ }
        }

        return {
          projectType: detectProjectType(wsPath),
          marker:      findMarkerFile(wsPath),
          cfnResources,
          cdkStacks,
          lambdaHandlers,
          awsServices,
          templateSnippet,
          cdkConfig,
          serviceCount: awsServices.length,
        };
      },

      format(data: unknown): string {
        const d = data as AwsContext;
        const lines = [
          `## AWS Context (${d.projectType})`,
        ];

        if (d.templateSnippet) {
          lines.push(`### CloudFormation/SAM Template:\n\`\`\`yaml\n${d.templateSnippet.slice(0, 800)}\n\`\`\``);
        }

        if (d.cdkConfig) {
          lines.push(`### CDK Config:\n\`\`\`json\n${d.cdkConfig.slice(0, 500)}\n\`\`\``);
        }

        if (d.cfnResources.length > 0) {
          lines.push(`### CloudFormation Resources: ${d.cfnResources.slice(0, 10).join(', ')}`);
        }

        if (d.cdkStacks.length > 0) {
          lines.push(`### CDK Stacks: ${d.cdkStacks.slice(0, 5).join(', ')}`);
        }

        if (d.lambdaHandlers.length > 0) {
          lines.push(`### Lambda Handlers: ${d.lambdaHandlers.slice(0, 8).join(', ')}`);
        }

        if (d.awsServices.length > 0) {
          lines.push(`### AWS Services Used: ${d.awsServices.slice(0, 15).join(', ')}`);
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## AWS Cloud Expert Knowledge

You are an expert in Amazon Web Services (AWS), including Lambda, IAM, DynamoDB, S3, API Gateway, CloudFormation, SAM, CDK, and the broader AWS serverless and cloud-native ecosystem. Apply these rules in every response involving AWS infrastructure or services:

### AWS Lambda Best Practices
- Keep handler functions thin — delegate business logic to separate modules for testability
- Minimize cold starts: keep deployment packages small, use provisioned concurrency for latency-sensitive workloads
- Set memory between 128 MB and 10240 MB — CPU scales proportionally with memory
- Set timeout appropriately (max 15 min); use Step Functions for longer workflows
- Use Lambda Layers for shared dependencies across functions
- Use environment variables (never hardcoded) for configuration; use Secrets Manager or Parameter Store for secrets
- Reuse SDK clients outside the handler (module-level) to benefit from connection pooling across invocations
- Use /tmp (up to 10 GB) for ephemeral file operations; clean up after use
- Enable X-Ray tracing for observability; use structured JSON logging with correlation IDs

### IAM Least-Privilege Principles
- NEVER use wildcards (*) in Resource or Action unless absolutely necessary
- Scope permissions to specific resources using ARNs, not account-wide
- Use condition keys (aws:SourceArn, aws:PrincipalOrgID) to restrict cross-service access
- Prefer managed policies for common patterns; use inline policies for resource-specific permissions
- Use IAM roles (not access keys) for service-to-service communication
- Enable IAM Access Analyzer to identify unused and overly broad permissions
- Apply permission boundaries to limit maximum possible permissions for roles

### DynamoDB Patterns
- Design for access patterns first — single-table design reduces costs and latency
- Use composite keys (PK + SK) to model hierarchical relationships in a single table
- Use GSIs sparingly — each GSI doubles write cost for projected attributes
- Use DynamoDB Streams for event-driven architectures and CDC
- Use on-demand capacity for unpredictable workloads; provisioned + auto-scaling for steady-state
- Use batch operations (BatchWriteItem, BatchGetItem) to reduce API calls
- Always handle ConditionalCheckFailedException for optimistic locking patterns

### S3 Security & Best Practices
- Enable server-side encryption (SSE-S3 or SSE-KMS) on all buckets
- Block public access at the account level; use bucket policies for fine-grained control
- Enable versioning for critical data buckets; use lifecycle rules to manage costs
- Use S3 event notifications to trigger Lambda for event-driven file processing
- Prefer S3 Transfer Acceleration or multipart uploads for large files
- Use presigned URLs for temporary access instead of making buckets public

### API Gateway Patterns
- Use HTTP APIs for simple Lambda proxies — lower cost and latency than REST APIs
- Use REST APIs when you need request validation, WAF integration, or usage plans
- Enable request/response models and validation to reject bad input early
- Use Lambda authorizers or Cognito for authentication
- Set appropriate throttling limits and burst capacity
- Use stages (dev/staging/prod) with stage variables for environment separation

### CloudFormation / SAM / CDK Best Practices
- Use SAM for serverless applications — it simplifies Lambda, API Gateway, and DynamoDB definitions
- Use CDK for complex infrastructure — type-safe constructs prevent configuration errors
- Always define outputs for cross-stack references
- Use parameters and mappings for environment-specific values
- Enable termination protection on production stacks
- Use change sets to preview changes before applying them
- Prefer nested stacks or CDK constructs for reusable infrastructure patterns

### Common Anti-Patterns to Flag
- Lambda monoliths: single function handling all routes — split into per-route functions
- Over-permissive IAM: Action: "*", Resource: "*" — always scope down
- Missing error handling: unhandled SDK exceptions crash Lambda and cause retries
- Synchronous chaining: Lambda calling Lambda — use SQS, SNS, or Step Functions instead
- Hardcoded ARNs or account IDs — use CloudFormation Refs, SSM parameters, or environment variables
- Missing DLQ/destination: failed async invocations are silently dropped without a dead-letter queue
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud) Optimize Lambda',
      command:     'aiForge.aws.optimizeLambda',
      linePattern: /async\s+def\s+handler\s*\(event|def\s+handler\s*\(event|exports\.handler\s*=|export\s+(?:async\s+)?function\s+handler/,
      languages:   ['python', 'javascript', 'typescript'],
      tooltip:     'Optimize this Lambda handler for cold starts, memory, and best practices',
    },
    {
      title:       '$(cloud) Explain Resource',
      command:     'aiForge.aws.explainStack',
      linePattern: /Type:\s*['"]?AWS::/,
      languages:   ['yaml', 'json'],
      tooltip:     'Explain this CloudFormation resource and its configuration',
    },
    {
      title:       '$(cloud) Convert to CDK',
      command:     'aiForge.aws.convertToCDK',
      linePattern: /AWSTemplateFormatVersion|Resources:|Type:\s*['"]?AWS::/,
      languages:   ['yaml', 'json'],
      tooltip:     'Convert this CloudFormation template to AWS CDK (TypeScript)',
    },
    {
      title:       '$(cloud) Explain CDK Construct',
      command:     'aiForge.aws.explainStack',
      linePattern: /new\s+\w+\.\w+Function|new\s+lambda\.\w+|new\s+dynamodb\.\w+|new\s+s3\.\w+|new\s+apigateway\.\w+|new\s+sqs\.\w+/,
      languages:   ['typescript', 'javascript', 'python'],
      tooltip:     'Explain this CDK construct and its configuration',
    },
    {
      title:       '$(cloud) Add Error Handling',
      command:     'aiForge.aws.addErrorHandling',
      linePattern: /boto3\.client|boto3\.resource|new\s+\w+Client\(|\.send\(new\s+\w+Command/,
      languages:   ['python', 'typescript', 'javascript'],
      tooltip:     'Add proper error handling for this AWS SDK call',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(cloud) AWS: Optimize Lambda handler',
      command:   'aiForge.aws.optimizeLambda',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python', 'javascript', 'typescript'],
    },
    {
      title:     '$(cloud) AWS: Add IAM least-privilege policy',
      command:   'aiForge.aws.generateIAM',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['python', 'javascript', 'typescript', 'yaml', 'json'],
    },
    {
      title:     '$(cloud) AWS: Add AWS SDK error handling',
      command:   'aiForge.aws.addErrorHandling',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python', 'javascript', 'typescript'],
    },
    {
      title:     '$(cloud) AWS: Convert CloudFormation to CDK',
      command:   'aiForge.aws.convertToCDK',
      kind:      'refactor',
      requiresSelection: true,
      languages: ['yaml', 'json'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add AWS SDK error handling',
      description: 'Wrap all AWS SDK calls with proper try/catch, retries, and error logging',
      extensions:  ['.py', '.ts', '.js'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add comprehensive AWS SDK error handling to this ${lang} file. Apply these rules:
- Wrap every AWS SDK call (boto3 client/resource calls, @aws-sdk client calls) in try/catch
- Handle specific exceptions: ClientError, BotoCoreError (Python) or service-specific errors (JS/TS)
- Add exponential backoff retry logic for throttling errors (ThrottlingException, TooManyRequestsException)
- Log errors with structured JSON including request ID, service name, and operation
- Add fallback behavior where appropriate (return cached data, use defaults)
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are an AWS SDK error handling expert. Return only the complete updated file.',
          instruction: 'Add AWS SDK error handling',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add CloudWatch logging to Lambda handlers',
      description: 'Add structured JSON logging with correlation IDs and X-Ray tracing',
      extensions:  ['.py', '.ts', '.js'],
      async apply(content, filePath, lang, services): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add CloudWatch logging best practices to this Lambda handler file:
- Use structured JSON logging (not print() or console.log with plain strings)
- Include correlation ID from the event or generate one (use aws_request_id from context)
- Log at appropriate levels: INFO for business events, WARN for retries, ERROR for failures
- Add cold start detection logging (module-level flag set to True on first invocation)
- Include relevant context in every log line: function name, request ID, trace ID
- For Python: use aws_lambda_powertools Logger or structlog; for JS/TS: use @aws-lambda-powertools/logger
- Add X-Ray tracing annotations for key business operations
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`${lang}
${content}
\`\`\``,
          }],
          system: 'You are an AWS observability expert. Return only the complete updated file.',
          instruction: 'Add CloudWatch logging',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'AWS Lambda Function (Python)',
      description: 'Production Lambda handler with structured logging, error handling, and typing',
      prompt: (wsPath) =>
        `Create a production-quality AWS Lambda function in Python.
Include:
- Proper handler signature: def handler(event: dict, context: LambdaContext) -> dict
- Type hints using typing and aws_lambda_powertools if available
- Structured JSON logging with aws_request_id correlation
- Cold start detection (module-level boolean flag)
- Reusable boto3 client initialized outside the handler (module-level) for connection reuse
- Environment variable reading for configuration (os.environ)
- Comprehensive error handling with specific boto3 exception types
- Input validation of the event payload
- X-Ray tracing via aws_xray_sdk or powertools tracer
- Return proper API Gateway response format (statusCode, body, headers)
Generate as ## handler.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'AWS Lambda Function (Node.js/TypeScript)',
      description: 'Production Lambda handler with TypeScript types, structured logging, and SDK v3',
      prompt: (wsPath) =>
        `Create a production-quality AWS Lambda function in TypeScript.
Include:
- Proper handler type: APIGatewayProxyHandler or custom type from @types/aws-lambda
- @aws-sdk/client-* (v3) imports — not the legacy aws-sdk v2
- Structured JSON logging with requestId from context
- Cold start detection with module-level flag
- Reusable SDK client initialized outside the handler for connection reuse
- Environment variable reading for configuration
- Comprehensive error handling with specific SDK exception types
- Input validation with proper TypeScript types
- Middy middleware for common concerns (if appropriate)
- Return proper API Gateway response format
Generate as ## handler.ts then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'AWS SAM Application',
      description: 'SAM template with Lambda, API Gateway, DynamoDB, and proper IAM',
      prompt: (wsPath) =>
        `Create a complete AWS SAM application with template and handler.
Include in template.yaml:
- AWSTemplateFormatVersion and Transform: AWS::Serverless-2016-10-31
- Globals section with default Lambda settings (timeout, memory, runtime, tracing)
- API Gateway (HttpApi) with CORS configuration
- At least 2 Lambda functions with different HTTP methods (GET, POST)
- DynamoDB table with on-demand billing and appropriate key schema
- IAM policies scoped to specific resources (least-privilege)
- Environment variables passing table name, stage, etc.
- CloudWatch Logs retention policy
- Outputs section with API endpoint URL and table name
Include a sample handler.py with proper error handling.
Generate as ## template.yaml then ## handler.py with complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'AWS CDK Stack (TypeScript)',
      description: 'CDK stack with Lambda, API Gateway, DynamoDB, and S3',
      prompt: (wsPath) =>
        `Create a complete AWS CDK stack in TypeScript.
Include:
- Stack class extending cdk.Stack with proper constructor
- Lambda function with bundling (NodejsFunction or PythonFunction)
- API Gateway (HttpApi or RestApi) with Lambda integration
- DynamoDB table with appropriate key schema and billing mode
- S3 bucket with encryption, versioning, and lifecycle rules
- IAM roles with least-privilege permissions (grant* helper methods)
- CloudWatch alarms for Lambda errors and DynamoDB throttling
- Stack outputs for important resource ARNs and URLs
- Environment-aware configuration using cdk.Environment
- Tags applied to all resources
Generate as ## lib/my-stack.ts then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'API Gateway + Lambda + DynamoDB',
      description: 'Complete serverless CRUD API with SAM template',
      prompt: (wsPath) =>
        `Create a complete serverless CRUD API using AWS SAM.
Include in template.yaml:
- HttpApi with CORS
- 5 Lambda functions: Create, Read, List, Update, Delete
- DynamoDB table with partition key (id) and appropriate GSI for listing
- Shared Lambda Layer for common utilities (validation, response formatting)
- Cognito User Pool authorizer for authentication
- IAM policies scoped per-function (read functions get read-only, write functions get write)
Include handler files:
- create.py — validates input, writes to DynamoDB, returns 201
- read.py — gets single item by ID, returns 200 or 404
- list.py — queries with pagination support, returns 200
- update.py — conditional update with optimistic locking, returns 200 or 409
- delete.py — soft delete or hard delete, returns 204
- shared/utils.py — response builder, input validator, error handler
Generate as ## template.yaml then each handler file.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.aws.explainStack',
      title: 'AWS: Explain CloudFormation / SAM / CDK Stack',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this AWS infrastructure code in detail, including:
- What each resource/construct does and how they connect
- IAM permissions and security implications
- Cost implications (estimated monthly cost for moderate usage)
- Potential issues or misconfigurations
- Suggestions for improvement (security, cost, reliability)

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.aws.optimizeLambda',
      title: 'AWS: Optimize Lambda Function',
      async handler(services, uri, range): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Lambda handler file first'); return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Optimizing Lambda...', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimize this Lambda function for performance and cost. Apply:
- Move SDK client initialization outside the handler (module-level) for connection reuse
- Minimize deployment package size (lazy imports where possible)
- Optimize memory/timeout settings (add comments with recommendations)
- Reduce cold start time (minimize top-level imports, use provisioned concurrency hints)
- Add proper error handling with retries for transient failures
- Use batch operations where possible (BatchWriteItem, etc.)
- Add structured logging with minimal overhead

Return ONLY the optimized code block, no explanation.

\`\`\`
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimize Lambda function',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'AWS: Optimized Lambda code ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimized Lambda handler:\n\`\`\`\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.aws.generateIAM',
      title: 'AWS: Generate Least-Privilege IAM Policy',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Analyze this code and generate a least-privilege IAM policy that covers exactly the AWS API calls made.
Rules:
- Use specific Actions (never Action: "*")
- Use specific Resource ARNs (never Resource: "*" unless truly required like sts:GetCallerIdentity)
- Add Condition keys where applicable (aws:SourceArn, aws:RequestedRegion)
- Output as both JSON IAM policy and CloudFormation/SAM YAML policy
- Explain each permission and why it is needed

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.aws.addErrorHandling',
      title: 'AWS: Add SDK Error Handling',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add comprehensive error handling to all AWS SDK calls in this code:
- Catch specific exceptions (ClientError, BotoCoreError for Python; service exceptions for JS/TS SDK v3)
- Handle throttling with exponential backoff and jitter
- Handle transient errors (network timeouts, 5xx) with retries
- Handle resource-not-found gracefully (return None/null or create the resource)
- Log errors with request ID and operation context
- Preserve the original code logic; only add error handling around SDK calls

\`\`\`
${code}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.aws.convertToCDK',
      title: 'AWS: Convert CloudFormation to CDK',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a CloudFormation template first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Convert this CloudFormation / SAM YAML template to an equivalent AWS CDK stack in TypeScript.
Rules:
- Use L2 (high-level) constructs wherever available
- Preserve all resource configurations and properties
- Use grant* helper methods instead of inline IAM policies
- Add proper TypeScript types
- Add stack outputs matching the original Outputs section
- Include CDK context for environment-specific values
- Add tags and removal policies

\`\`\`
${editor.document.getText()}
\`\`\``,
          'new'
        );
      },
    },
    {
      id:    'aiForge.aws.generateSAM',
      title: 'AWS: Generate SAM Template',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete AWS SAM template (template.yaml) for this application code.
Include:
- Proper AWSTemplateFormatVersion and Transform
- Lambda function definitions with appropriate runtime, memory, and timeout
- API Gateway (HttpApi) with route mappings matching the handler routes
- Any required DynamoDB tables, S3 buckets, or SQS queues detected from the code
- Least-privilege IAM policies for each function
- Environment variables for resource references
- Outputs for the API URL and resource ARNs
- Globals section with sensible defaults

${code ? `\`\`\`\n${code}\n\`\`\`` : '(No file open — generate a template for a typical serverless API)'}`,
          'new'
        );
      },
    },
    {
      id:    'aiForge.aws.explainCost',
      title: 'AWS: Explain Cost Implications',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Analyze the AWS cost implications of this infrastructure/code:
- Estimate monthly cost for low, moderate, and high traffic scenarios
- Identify the most expensive resources and operations
- Suggest cost optimization strategies (reserved capacity, savings plans, right-sizing)
- Flag any potential cost surprises (data transfer, API calls, provisioned throughput)
- Compare alternative architectures that could reduce cost
- Note any free tier coverage that applies

\`\`\`
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.aws.addLogging',
      title: 'AWS: Add CloudWatch Logging Best Practices',
      async handler(services): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Lambda handler file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add CloudWatch logging best practices to this Lambda handler:
- Replace print() / console.log with structured JSON logging
- Add correlation ID tracking (from event headers or context.aws_request_id)
- Log at appropriate levels (INFO, WARN, ERROR)
- Add cold start detection and logging
- Include X-Ray trace ID in log context
- Add metric-friendly log formats for CloudWatch Insights queries
- For Python: use aws_lambda_powertools Logger; for JS/TS: use @aws-lambda-powertools/logger

\`\`\`
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      const count = this._serviceCount;
      return `$(cloud) ${this._projectType}${count > 0 ? ` (${count} services)` : ''}`;
    },
  };
}
