/**
 * plugins/awsConnected.ts — AWS Connected plugin for Evolve AI
 *
 * Activates alongside the base AWS plugin when the workspace contains AWS
 * project markers. Provides live API access to AWS services via stored
 * credentials (Access Key ID, Secret Key, Region).
 *
 * Contributes:
 *  - contextHooks      : live Lambda/Glue/CloudFormation status (60s cache)
 *  - systemPromptSection: connected-account knowledge + live capabilities
 *  - codeLensActions    : List Lambdas, Glue Jobs, Browse S3 on boto3 lines
 *  - commands (20)      : connect, disconnect, status, Lambda (5), Glue (5),
 *                         S3 (2), CloudFormation (2), Step Functions (2),
 *                         DynamoDB (1)
 *  - statusItem         : shows connection status + region
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

// ── Detection markers (same as base AWS plugin) ─────────────────────────────

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

function globSourceFiles(dir: string, patterns: RegExp[], maxFiles = 30): string[] {
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

// ── AWS REST API client ──────────────────────────────────────────────────────

/** AWS Signature Version 4 signer + lightweight REST client */
class AwsClient {
  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly region: string,
  ) {}

  get currentRegion(): string { return this.region; }

  // ── AWS Sig V4 ──────────────────────────────────────────────────────────

  private async _hmac(key: Buffer, data: string): Promise<Buffer> {
    const crypto = await import('crypto');
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  }

  private async _sha256(data: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  private async _getSignatureKey(dateStamp: string, regionName: string, serviceName: string): Promise<Buffer> {
    const kDate    = await this._hmac(Buffer.from('AWS4' + this.secretAccessKey, 'utf8'), dateStamp);
    const kRegion  = await this._hmac(kDate, regionName);
    const kService = await this._hmac(kRegion, serviceName);
    return this._hmac(kService, 'aws4_request');
  }

  private async _signedRequest(
    service: string,
    method: string,
    urlPath: string,
    host: string,
    headers: Record<string, string>,
    body: string,
    queryString = '',
  ): Promise<{ signedHeaders: Record<string, string> }> {
    const crypto = await import('crypto');
    const now = new Date();
    const amzDate   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);

    headers['host']       = host;
    headers['x-amz-date'] = amzDate;

    const payloadHash = await this._sha256(body);
    headers['x-amz-content-sha256'] = payloadHash;

    // Canonical headers
    const signedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeadersStr = signedHeaderKeys.join(';');

    // Canonical request
    const canonicalRequest = [
      method,
      urlPath,
      queryString,
      canonicalHeaders,
      signedHeadersStr,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await this._sha256(canonicalRequest),
    ].join('\n');

    const signingKey = await this._getSignatureKey(dateStamp, this.region, service);
    const signature  = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    return { signedHeaders: headers };
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────

  private async _httpRequest<T>(
    service: string,
    method: string,
    apiPath: string,
    body = '',
    extraHeaders: Record<string, string> = {},
    queryString = '',
  ): Promise<T> {
    const host = `${service}.${this.region}.amazonaws.com`;
    const url  = `https://${host}${apiPath}${queryString ? '?' + queryString : ''}`;

    const headers: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.1',
      ...extraHeaders,
    };

    const { signedHeaders } = await this._signedRequest(
      service, method, apiPath, host, headers, body, queryString
    );

    const https = await import('https');
    const parsed = new URL(url);

    return new Promise<T>((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port:     443,
        path:     parsed.pathname + parsed.search,
        method,
        headers:  signedHeaders,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`AWS ${service} API ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : ({} as T));
          } catch {
            reject(new Error(`Invalid JSON from AWS ${service}: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`AWS ${service} request timed out`)); });

      if (body) req.write(body);
      req.end();
    });
  }

  // ── STS ─────────────────────────────────────────────────────────────────

  async getCallerIdentity(): Promise<{ Account: string; Arn: string; UserId: string }> {
    const host = `sts.${this.region}.amazonaws.com`;
    const body = 'Action=GetCallerIdentity&Version=2011-06-15';
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };

    const { signedHeaders } = await this._signedRequest(
      'sts', 'POST', '/', host, headers, body
    );

    const https = await import('https');
    return new Promise<{ Account: string; Arn: string; UserId: string }>((resolve, reject) => {
      const req = https.request({
        hostname: host,
        port: 443,
        path: '/',
        method: 'POST',
        headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`AWS STS ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          // Parse XML response
          const account = raw.match(/<Account>([^<]+)<\/Account>/)?.[1] ?? '';
          const arn     = raw.match(/<Arn>([^<]+)<\/Arn>/)?.[1] ?? '';
          const userId  = raw.match(/<UserId>([^<]+)<\/UserId>/)?.[1] ?? '';
          resolve({ Account: account, Arn: arn, UserId: userId });
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('STS request timed out')); });
      req.write(body);
      req.end();
    });
  }

  // ── Lambda ──────────────────────────────────────────────────────────────

  async listLambdaFunctions(): Promise<Array<{
    FunctionName: string; Runtime: string; MemorySize: number;
    Timeout: number; LastModified: string; CodeSize: number;
    Description: string; Handler: string;
  }>> {
    const resp = await this._httpRequest<{ Functions?: unknown[] }>(
      'lambda', 'GET', '/2015-03-31/functions', '', { 'content-type': 'application/json' }
    );
    return (resp.Functions ?? []) as Array<{
      FunctionName: string; Runtime: string; MemorySize: number;
      Timeout: number; LastModified: string; CodeSize: number;
      Description: string; Handler: string;
    }>;
  }

  async getLambdaFunction(functionName: string): Promise<{
    Configuration: {
      FunctionName: string; Runtime: string; MemorySize: number;
      Timeout: number; Handler: string; Description: string;
      Environment?: { Variables?: Record<string, string> };
      Layers?: Array<{ Arn: string; CodeSize: number }>;
      LastModified: string; CodeSize: number;
      VpcConfig?: { SubnetIds: string[]; SecurityGroupIds: string[] };
    };
  }> {
    return this._httpRequest(
      'lambda', 'GET',
      `/2015-03-31/functions/${encodeURIComponent(functionName)}`,
      '', { 'content-type': 'application/json' }
    );
  }

  async invokeLambda(functionName: string, payload: string): Promise<{
    StatusCode: number; ExecutedVersion?: string; FunctionError?: string;
    Payload?: string; LogResult?: string;
  }> {
    return this._httpRequest(
      'lambda', 'POST',
      `/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations`,
      payload,
      { 'content-type': 'application/json', 'x-amz-invocation-type': 'RequestResponse', 'x-amz-log-type': 'Tail' }
    );
  }

  // ── CloudWatch Logs ─────────────────────────────────────────────────────

  async getLogEvents(logGroupName: string, limit = 50): Promise<Array<{
    timestamp: number; message: string;
  }>> {
    const body = JSON.stringify({
      logGroupName,
      limit,
      interleaved: true,
    });
    const resp = await this._httpRequest<{ events?: Array<{ timestamp: number; message: string }> }>(
      'logs', 'POST', '/',
      body,
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Logs_20140328.FilterLogEvents' }
    );
    return resp.events ?? [];
  }

  async getLambdaErrors(functionName: string, limit = 20): Promise<Array<{
    timestamp: number; message: string;
  }>> {
    const logGroup = `/aws/lambda/${functionName}`;
    const body = JSON.stringify({
      logGroupName: logGroup,
      filterPattern: 'ERROR',
      limit,
      interleaved: true,
    });
    try {
      const resp = await this._httpRequest<{ events?: Array<{ timestamp: number; message: string }> }>(
        'logs', 'POST', '/',
        body,
        { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Logs_20140328.FilterLogEvents' }
      );
      return resp.events ?? [];
    } catch {
      return [];
    }
  }

  // ── Glue ────────────────────────────────────────────────────────────────

  async listGlueJobs(): Promise<Array<{
    Name: string; Command?: { Name: string; ScriptLocation: string };
    MaxRetries?: number; Timeout?: number; GlueVersion?: string;
    NumberOfWorkers?: number; WorkerType?: string;
  }>> {
    const body = JSON.stringify({});
    const resp = await this._httpRequest<{ Jobs?: unknown[] }>(
      'glue', 'POST', '/',
      body,
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.GetJobs' }
    );
    return (resp.Jobs ?? []) as Array<{
      Name: string; Command?: { Name: string; ScriptLocation: string };
      MaxRetries?: number; Timeout?: number; GlueVersion?: string;
      NumberOfWorkers?: number; WorkerType?: string;
    }>;
  }

  async getGlueJob(jobName: string): Promise<{
    Job: {
      Name: string; Command?: { Name: string; ScriptLocation: string };
      Connections?: { Connections: string[] };
      DefaultArguments?: Record<string, string>;
      MaxRetries?: number; Timeout?: number; GlueVersion?: string;
      NumberOfWorkers?: number; WorkerType?: string;
      Description?: string;
    };
  }> {
    return this._httpRequest(
      'glue', 'POST', '/',
      JSON.stringify({ JobName: jobName }),
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.GetJob' }
    );
  }

  async startGlueJobRun(jobName: string, args?: Record<string, string>): Promise<{ JobRunId: string }> {
    const body: Record<string, unknown> = { JobName: jobName };
    if (args) body.Arguments = args;
    return this._httpRequest(
      'glue', 'POST', '/',
      JSON.stringify(body),
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.StartJobRun' }
    );
  }

  async getGlueJobRuns(jobName: string, maxResults = 20): Promise<Array<{
    Id: string; JobName: string; JobRunState: string;
    StartedOn?: number; CompletedOn?: number;
    ErrorMessage?: string; Arguments?: Record<string, string>;
  }>> {
    const resp = await this._httpRequest<{ JobRuns?: unknown[] }>(
      'glue', 'POST', '/',
      JSON.stringify({ JobName: jobName, MaxResults: maxResults }),
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.GetJobRuns' }
    );
    return (resp.JobRuns ?? []) as Array<{
      Id: string; JobName: string; JobRunState: string;
      StartedOn?: number; CompletedOn?: number;
      ErrorMessage?: string; Arguments?: Record<string, string>;
    }>;
  }

  async getGlueDatabases(): Promise<Array<{ Name: string; Description?: string; LocationUri?: string }>> {
    const resp = await this._httpRequest<{ DatabaseList?: unknown[] }>(
      'glue', 'POST', '/',
      JSON.stringify({}),
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.GetDatabases' }
    );
    return (resp.DatabaseList ?? []) as Array<{ Name: string; Description?: string; LocationUri?: string }>;
  }

  async getGlueTables(databaseName: string): Promise<Array<{
    Name: string; DatabaseName: string; TableType?: string;
    StorageDescriptor?: { Columns: Array<{ Name: string; Type: string; Comment?: string }>; Location?: string };
    PartitionKeys?: Array<{ Name: string; Type: string }>;
  }>> {
    const resp = await this._httpRequest<{ TableList?: unknown[] }>(
      'glue', 'POST', '/',
      JSON.stringify({ DatabaseName: databaseName }),
      { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSGlue.GetTables' }
    );
    return (resp.TableList ?? []) as Array<{
      Name: string; DatabaseName: string; TableType?: string;
      StorageDescriptor?: { Columns: Array<{ Name: string; Type: string; Comment?: string }>; Location?: string };
      PartitionKeys?: Array<{ Name: string; Type: string }>;
    }>;
  }

  // ── S3 ──────────────────────────────────────────────────────────────────

  async listS3Buckets(): Promise<Array<{ Name: string; CreationDate: string }>> {
    const host = `s3.${this.region}.amazonaws.com`;
    const headers: Record<string, string> = { 'content-type': 'application/xml' };
    const { signedHeaders } = await this._signedRequest('s3', 'GET', '/', host, headers, '');

    const https = await import('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: '/', method: 'GET', headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`S3 ListBuckets ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          const buckets: Array<{ Name: string; CreationDate: string }> = [];
          const re = /<Name>([^<]+)<\/Name>\s*<CreationDate>([^<]+)<\/CreationDate>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(raw)) !== null) {
            buckets.push({ Name: m[1], CreationDate: m[2] });
          }
          resolve(buckets);
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('S3 ListBuckets timed out')); });
      req.end();
    });
  }

  async listS3Objects(bucket: string, prefix = '', delimiter = '/'): Promise<{
    prefixes: string[];
    objects: Array<{ Key: string; Size: number; LastModified: string }>;
  }> {
    const host = `${bucket}.s3.${this.region}.amazonaws.com`;
    const qs = `list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=${encodeURIComponent(delimiter)}&max-keys=100`;
    const headers: Record<string, string> = { 'content-type': 'application/xml' };
    const { signedHeaders } = await this._signedRequest('s3', 'GET', '/', host, headers, '', qs);

    const https = await import('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: '/?' + qs, method: 'GET', headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`S3 ListObjects ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          const prefixes: string[] = [];
          const prefixRe = /<Prefix>([^<]+)<\/Prefix>/g;
          // Extract CommonPrefixes
          const cpRe = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g;
          let m: RegExpExecArray | null;
          while ((m = cpRe.exec(raw)) !== null) {
            prefixes.push(m[1]);
          }
          const objects: Array<{ Key: string; Size: number; LastModified: string }> = [];
          const contentsRe = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g;
          while ((m = contentsRe.exec(raw)) !== null) {
            objects.push({ Key: m[1], Size: parseInt(m[3], 10), LastModified: m[2] });
          }
          resolve({ prefixes, objects });
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('S3 ListObjects timed out')); });
      req.end();
    });
  }

  async getS3Object(bucket: string, key: string): Promise<string> {
    const host = `${bucket}.s3.${this.region}.amazonaws.com`;
    const objPath = '/' + key.split('/').map(encodeURIComponent).join('/');
    const headers: Record<string, string> = {};
    const { signedHeaders } = await this._signedRequest('s3', 'GET', objPath, host, headers, '');

    const https = await import('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: objPath, method: 'GET', headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`S3 GetObject ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          resolve(raw);
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('S3 GetObject timed out')); });
      req.end();
    });
  }

  async putS3Object(bucket: string, key: string, content: string): Promise<void> {
    const host = `${bucket}.s3.${this.region}.amazonaws.com`;
    const objPath = '/' + key.split('/').map(encodeURIComponent).join('/');
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    const { signedHeaders } = await this._signedRequest('s3', 'PUT', objPath, host, headers, content);

    const https = await import('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: objPath, method: 'PUT', headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const raw = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`S3 PutObject ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('S3 PutObject timed out')); });
      req.write(content);
      req.end();
    });
  }

  // ── CloudFormation ──────────────────────────────────────────────────────

  async listCloudFormationStacks(): Promise<Array<{
    StackName: string; StackStatus: string; CreationTime: string;
    Description?: string; StackId?: string;
  }>> {
    const body = 'Action=ListStacks&Version=2010-05-15&StackStatusFilter.member.1=CREATE_COMPLETE&StackStatusFilter.member.2=UPDATE_COMPLETE&StackStatusFilter.member.3=UPDATE_ROLLBACK_COMPLETE&StackStatusFilter.member.4=CREATE_IN_PROGRESS&StackStatusFilter.member.5=UPDATE_IN_PROGRESS&StackStatusFilter.member.6=DELETE_IN_PROGRESS&StackStatusFilter.member.7=ROLLBACK_COMPLETE';
    const host = `cloudformation.${this.region}.amazonaws.com`;
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const { signedHeaders } = await this._signedRequest('cloudformation', 'POST', '/', host, headers, body);

    const https = await import('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: '/', method: 'POST', headers: signedHeaders,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`CloudFormation ListStacks ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          const stacks: Array<{ StackName: string; StackStatus: string; CreationTime: string; Description?: string; StackId?: string }> = [];
          const re = /<StackName>([^<]+)<\/StackName>[\s\S]*?<StackStatus>([^<]+)<\/StackStatus>[\s\S]*?<CreationTime>([^<]+)<\/CreationTime>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(raw)) !== null) {
            stacks.push({ StackName: m[1], StackStatus: m[2], CreationTime: m[3] });
          }
          resolve(stacks);
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('CloudFormation ListStacks timed out')); });
      req.write(body);
      req.end();
    });
  }

  async describeStack(stackName: string): Promise<{
    StackName: string; StackStatus: string; Resources: string[];
    Outputs: Array<{ Key: string; Value: string }>; Events: string[];
    TemplateBody?: string;
  }> {
    // Describe stack
    const descBody = `Action=DescribeStacks&Version=2010-05-15&StackName=${encodeURIComponent(stackName)}`;
    const host = `cloudformation.${this.region}.amazonaws.com`;
    const headers1: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const { signedHeaders: sh1 } = await this._signedRequest('cloudformation', 'POST', '/', host, headers1, descBody);

    const https = await import('https');
    const descRaw = await new Promise<string>((resolve, reject) => {
      const req = https.request({ hostname: host, port: 443, path: '/', method: 'POST', headers: sh1 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('DescribeStacks timed out')); });
      req.write(descBody);
      req.end();
    });

    const status = descRaw.match(/<StackStatus>([^<]+)<\/StackStatus>/)?.[1] ?? 'UNKNOWN';

    // List resources
    const resBody = `Action=ListStackResources&Version=2010-05-15&StackName=${encodeURIComponent(stackName)}`;
    const headers2: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const { signedHeaders: sh2 } = await this._signedRequest('cloudformation', 'POST', '/', host, headers2, resBody);

    const resRaw = await new Promise<string>((resolve, reject) => {
      const req = https.request({ hostname: host, port: 443, path: '/', method: 'POST', headers: sh2 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('ListStackResources timed out')); });
      req.write(resBody);
      req.end();
    });

    const resources: string[] = [];
    const resRe = /<ResourceType>([^<]+)<\/ResourceType>[\s\S]*?<LogicalResourceId>([^<]+)<\/LogicalResourceId>[\s\S]*?<ResourceStatus>([^<]+)<\/ResourceStatus>/g;
    let rm: RegExpExecArray | null;
    while ((rm = resRe.exec(resRaw)) !== null) {
      resources.push(`${rm[2]} (${rm[1]}) [${rm[3]}]`);
    }

    // Outputs
    const outputs: Array<{ Key: string; Value: string }> = [];
    const outRe = /<OutputKey>([^<]+)<\/OutputKey>[\s\S]*?<OutputValue>([^<]+)<\/OutputValue>/g;
    let om: RegExpExecArray | null;
    while ((om = outRe.exec(descRaw)) !== null) {
      outputs.push({ Key: om[1], Value: om[2] });
    }

    // Recent events
    const evtBody = `Action=DescribeStackEvents&Version=2010-05-15&StackName=${encodeURIComponent(stackName)}`;
    const headers3: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const { signedHeaders: sh3 } = await this._signedRequest('cloudformation', 'POST', '/', host, headers3, evtBody);

    const evtRaw = await new Promise<string>((resolve, reject) => {
      const req = https.request({ hostname: host, port: 443, path: '/', method: 'POST', headers: sh3 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('DescribeStackEvents timed out')); });
      req.write(evtBody);
      req.end();
    });

    const events: string[] = [];
    const evtRe = /<ResourceStatus>([^<]+)<\/ResourceStatus>[\s\S]*?<LogicalResourceId>([^<]+)<\/LogicalResourceId>/g;
    let em: RegExpExecArray | null;
    let evtCount = 0;
    while ((em = evtRe.exec(evtRaw)) !== null && evtCount < 15) {
      events.push(`${em[2]}: ${em[1]}`);
      evtCount++;
    }

    return { StackName: stackName, StackStatus: status, Resources: resources, Outputs: outputs, Events: events };
  }

  // ── Step Functions ──────────────────────────────────────────────────────

  async listStateMachines(): Promise<Array<{
    name: string; stateMachineArn: string; type: string; creationDate: number;
  }>> {
    const resp = await this._httpRequest<{ stateMachines?: unknown[] }>(
      'states', 'POST', '/',
      JSON.stringify({}),
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AWSStepFunctions.ListStateMachines' }
    );
    return (resp.stateMachines ?? []) as Array<{
      name: string; stateMachineArn: string; type: string; creationDate: number;
    }>;
  }

  async describeStateMachine(arn: string): Promise<{
    name: string; stateMachineArn: string; definition: string;
    roleArn: string; type: string; status: string;
  }> {
    return this._httpRequest(
      'states', 'POST', '/',
      JSON.stringify({ stateMachineArn: arn }),
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AWSStepFunctions.DescribeStateMachine' }
    );
  }

  // ── DynamoDB ────────────────────────────────────────────────────────────

  async listDynamoDBTables(): Promise<string[]> {
    const resp = await this._httpRequest<{ TableNames?: string[] }>(
      'dynamodb', 'POST', '/',
      JSON.stringify({}),
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.ListTables' }
    );
    return resp.TableNames ?? [];
  }

  async describeDynamoDBTable(tableName: string): Promise<{
    Table: {
      TableName: string; TableStatus: string;
      KeySchema: Array<{ AttributeName: string; KeyType: string }>;
      AttributeDefinitions: Array<{ AttributeName: string; AttributeType: string }>;
      ProvisionedThroughput?: { ReadCapacityUnits: number; WriteCapacityUnits: number };
      BillingModeSummary?: { BillingMode: string };
      GlobalSecondaryIndexes?: Array<{
        IndexName: string;
        KeySchema: Array<{ AttributeName: string; KeyType: string }>;
        Projection: { ProjectionType: string };
      }>;
      ItemCount: number; TableSizeBytes: number;
    };
  }> {
    return this._httpRequest(
      'dynamodb', 'POST', '/',
      JSON.stringify({ TableName: tableName }),
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.DescribeTable' }
    );
  }

  async scanDynamoDBTable(tableName: string, limit = 10): Promise<{
    Items?: Array<Record<string, unknown>>;
    Count: number; ScannedCount: number;
  }> {
    return this._httpRequest(
      'dynamodb', 'POST', '/',
      JSON.stringify({ TableName: tableName, Limit: limit }),
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.Scan' }
    );
  }
}

// ── Cached context data shape ────────────────────────────────────────────────

interface AwsConnectedContextData {
  accountId: string;
  region: string;
  lambdaCount: number;
  lambdaErrors: Array<{ functionName: string; message: string; timestamp: string }>;
  glueJobSummary: Array<{ name: string; state: string; type: string }>;
  cfnStacks: Array<{ name: string; status: string }>;
}

// ── The plugin ───────────────────────────────────────────────────────────────

const SECRET_ACCESS_KEY_ID     = 'aws-access-key-id';
const SECRET_SECRET_ACCESS_KEY = 'aws-secret-access-key';
const SECRET_REGION            = 'aws-region';
const CACHE_TTL_MS             = 60_000; // 60 seconds

export class AwsConnectedPlugin implements IPlugin {
  readonly id          = 'aws-connected';
  readonly displayName = 'AWS Connected';
  readonly icon        = '$(cloud-upload)';

  private _client: AwsClient | null = null;
  private _connected = false;
  private _accountId = '';
  private _region    = '';
  private _wsPath    = '';

  // Cache for context data
  private _cachedContext: AwsConnectedContextData | null = null;
  private _cacheTimestamp = 0;

  // ── detect ────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) return false;
    const wsPath = ws.uri.fsPath;

    // Fast: check marker files first
    if (findMarkerFile(wsPath)) return true;
    if (hasCfnTemplate(wsPath)) return true;
    if (hasAwsImportsInDeps(wsPath)) return true;

    // Slower: scan source files for AWS imports
    const srcFiles = globSourceFiles(wsPath, [/\.py$/, /\.ts$/, /\.js$/], 30);
    for (const f of srcFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (AWS_IMPORT_PATTERN.test(sample)) return true;
      } catch { /* skip */ }
    }

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Try to initialise client from stored secrets
    const accessKeyId     = await services.ai.getSecret(SECRET_ACCESS_KEY_ID);
    const secretAccessKey = await services.ai.getSecret(SECRET_SECRET_ACCESS_KEY);
    const region          = await services.ai.getSecret(SECRET_REGION);

    if (accessKeyId && secretAccessKey && region) {
      try {
        this._client = new AwsClient(accessKeyId, secretAccessKey, region);
        const identity = await this._client.getCallerIdentity();
        this._connected = true;
        this._accountId = identity.Account;
        this._region    = region;
        console.log(`[Evolve AI] AWS Connected: account ${this._accountId} in ${this._region}`);
      } catch (e) {
        console.warn(`[Evolve AI] AWS Connected: stored credentials invalid — ${e}`);
        this._client = null;
        this._connected = false;
        vscode.window.showWarningMessage(
          'AWS Connected: stored credentials are invalid or expired. Use "AWS: Connect" to reconfigure.',
          'Connect Now',
        ).then(choice => {
          if (choice === 'Connect Now') {
            vscode.commands.executeCommand('aiForge.aws.connect');
          }
        });
      }
    } else {
      // Try environment variables
      const envAccessKey = process.env.AWS_ACCESS_KEY_ID;
      const envSecret    = process.env.AWS_SECRET_ACCESS_KEY;
      const envRegion    = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION;
      if (envAccessKey && envSecret && envRegion) {
        try {
          this._client = new AwsClient(envAccessKey, envSecret, envRegion);
          const identity = await this._client.getCallerIdentity();
          this._connected = true;
          this._accountId = identity.Account;
          this._region    = envRegion;
          // Persist to SecretStorage for future sessions
          await services.ai.storeSecret(SECRET_ACCESS_KEY_ID, envAccessKey);
          await services.ai.storeSecret(SECRET_SECRET_ACCESS_KEY, envSecret);
          await services.ai.storeSecret(SECRET_REGION, envRegion);
          console.log(`[Evolve AI] AWS Connected (env): account ${this._accountId} in ${this._region}`);
        } catch (e) {
          console.warn(`[Evolve AI] AWS Connected: env credentials invalid — ${e}`);
          this._client = null;
          this._connected = false;
        }
      }

      if (!this._connected) {
        vscode.window.showInformationMessage(
          'AWS Connected plugin detected an AWS workspace. Configure API credentials to enable live features.',
          'Connect Now',
        ).then(choice => {
          if (choice === 'Connect Now') {
            vscode.commands.executeCommand('aiForge.aws.connect');
          }
        });
      }
    }

    return [];
  }

  // ── deactivate ────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    this._client = null;
    this._connected = false;
    this._cachedContext = null;
    this._cacheTimestamp = 0;
  }

  // ── Context cache helper ──────────────────────────────────────────────

  private async _fetchContextData(): Promise<AwsConnectedContextData | null> {
    if (!this._client || !this._connected) return null;

    const now = Date.now();
    if (this._cachedContext && (now - this._cacheTimestamp) < CACHE_TTL_MS) {
      return this._cachedContext;
    }

    try {
      // Fetch Lambda function count and recent errors
      let lambdaCount = 0;
      const lambdaErrors: Array<{ functionName: string; message: string; timestamp: string }> = [];
      try {
        const functions = await this._client.listLambdaFunctions();
        lambdaCount = functions.length;
        // Check recent errors for first 5 functions
        for (const fn of functions.slice(0, 5)) {
          const errors = await this._client.getLambdaErrors(fn.FunctionName, 3);
          for (const err of errors.slice(0, 2)) {
            lambdaErrors.push({
              functionName: fn.FunctionName,
              message:      err.message.slice(0, 200),
              timestamp:    new Date(err.timestamp).toISOString(),
            });
          }
        }
      } catch { /* Lambda may not be accessible */ }

      // Fetch Glue job status
      const glueJobSummary: Array<{ name: string; state: string; type: string }> = [];
      try {
        const glueJobs = await this._client.listGlueJobs();
        for (const job of glueJobs.slice(0, 10)) {
          const runs = await this._client.getGlueJobRuns(job.Name, 1);
          const lastState = runs[0]?.JobRunState ?? 'NO_RUNS';
          glueJobSummary.push({
            name:  job.Name,
            state: lastState,
            type:  job.Command?.Name ?? 'unknown',
          });
        }
      } catch { /* Glue may not be accessible */ }

      // Fetch active CloudFormation stacks
      const cfnStacks: Array<{ name: string; status: string }> = [];
      try {
        const stacks = await this._client.listCloudFormationStacks();
        for (const s of stacks.slice(0, 10)) {
          cfnStacks.push({ name: s.StackName, status: s.StackStatus });
        }
      } catch { /* CloudFormation may not be accessible */ }

      this._cachedContext = {
        accountId:    this._accountId,
        region:       this._region,
        lambdaCount,
        lambdaErrors,
        glueJobSummary,
        cfnStacks,
      };
      this._cacheTimestamp = now;
      return this._cachedContext;
    } catch (e) {
      console.warn(`[Evolve AI] AWS Connected context fetch failed: ${e}`);
      return this._cachedContext; // return stale cache if available
    }
  }

  // ── contextHooks ──────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'aws-live',

      collect: async (_ws): Promise<AwsConnectedContextData | null> => {
        return this._fetchContextData();
      },

      format(data: unknown): string {
        const d = data as AwsConnectedContextData | null;
        if (!d) return '';

        const lines = [`## AWS Live Account (${d.accountId}, ${d.region})`];

        lines.push(`**Lambda functions:** ${d.lambdaCount}`);

        if (d.lambdaErrors.length > 0) {
          lines.push('\n### Recent Lambda Errors');
          for (const e of d.lambdaErrors) {
            lines.push(`- **${e.functionName}** (${e.timestamp}): ${e.message.slice(0, 150)}`);
          }
        }

        if (d.glueJobSummary.length > 0) {
          lines.push('\n### Glue Jobs');
          for (const j of d.glueJobSummary) {
            lines.push(`- **${j.name}** [${j.state}] (${j.type})`);
          }
        }

        if (d.cfnStacks.length > 0) {
          lines.push('\n### CloudFormation Stacks');
          for (const s of d.cfnStacks) {
            lines.push(`- **${s.name}**: ${s.status}`);
          }
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────

  systemPromptSection(): string {
    const base = `
## AWS Connected Account

You have access to a live AWS account. The user can ask you to manage Lambda functions, Glue jobs, check logs, query DynamoDB, browse S3, manage CloudFormation stacks, inspect Step Functions, and more.

When the user asks about their AWS environment, use the live data available in context.
When suggesting fixes for failed Lambda functions or Glue jobs, be specific — reference the actual error message and configuration.
When exploring data, suggest efficient queries and access patterns.
`.trim();

    if (this._connected) {
      return `${base}\n\n**AWS Account:** ${this._accountId}\n**Region:** ${this._region}`;
    }
    return `${base}\n\n_Credentials not yet configured. The user should run "AWS: Connect" to enable live features._`;
  }

  // ── codeLensActions ───────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(cloud-upload) List Lambda Functions',
      command:     'aiForge.aws.listLambdas',
      linePattern: /boto3\.client\s*\(\s*['"]lambda['"]/,
      languages:   ['python'],
      tooltip:     'List Lambda functions in your AWS account',
    },
    {
      title:       '$(cloud-upload) List Glue Jobs',
      command:     'aiForge.aws.listGlueJobs',
      linePattern: /boto3\.client\s*\(\s*['"]glue['"]/,
      languages:   ['python'],
      tooltip:     'List Glue jobs in your AWS account',
    },
    {
      title:       '$(cloud-upload) Browse S3',
      command:     'aiForge.aws.browseS3',
      linePattern: /boto3\.client\s*\(\s*['"]s3['"]/,
      languages:   ['python'],
      tooltip:     'Browse S3 buckets in your AWS account',
    },
  ];

  // ── Helper: ensure connected ──────────────────────────────────────────

  private _requireClient(action: string): AwsClient {
    if (!this._client || !this._connected) {
      vscode.window.showWarningMessage(
        'AWS: Not connected. Run "AWS: Connect" first.',
        'Connect Now',
      ).then(choice => {
        if (choice === 'Connect Now') {
          vscode.commands.executeCommand('aiForge.aws.connect');
        }
      });
      throw new Error(`AWS not connected — cannot ${action}`);
    }
    return this._client;
  }

  // ── commands (20) ─────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [

    // ─────────────────── 1. Connect ───────────────────
    {
      id:    'aiForge.aws.connect',
      title: 'AWS: Connect to Account',
      handler: async (services): Promise<void> => {
        const accessKeyId = await vscode.window.showInputBox({
          prompt:      'AWS Access Key ID',
          placeHolder: 'AKIA...',
          ignoreFocusOut: true,
          validateInput: (v) => {
            if (!v.trim()) return 'Access Key ID is required';
            if (!/^[A-Z0-9]{16,128}$/i.test(v.trim())) return 'Enter a valid Access Key ID';
            return null;
          },
        });
        if (!accessKeyId) return;

        const secretAccessKey = await vscode.window.showInputBox({
          prompt:      'AWS Secret Access Key',
          placeHolder: 'Your secret key...',
          password:    true,
          ignoreFocusOut: true,
          validateInput: (v) => v.trim() ? null : 'Secret Access Key is required',
        });
        if (!secretAccessKey) return;

        const region = await vscode.window.showInputBox({
          prompt:      'AWS Region (e.g. us-east-1, eu-west-1)',
          placeHolder: 'us-east-1',
          value:       'us-east-1',
          ignoreFocusOut: true,
          validateInput: (v) => {
            if (!v.trim()) return 'Region is required';
            if (!/^[a-z]{2}-[a-z]+-\d+$/.test(v.trim())) return 'Enter a valid AWS region (e.g. us-east-1)';
            return null;
          },
        });
        if (!region) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Testing connection...' },
          async () => {
            try {
              const client = new AwsClient(accessKeyId.trim(), secretAccessKey.trim(), region.trim());
              const identity = await client.getCallerIdentity();

              await services.ai.storeSecret(SECRET_ACCESS_KEY_ID, accessKeyId.trim());
              await services.ai.storeSecret(SECRET_SECRET_ACCESS_KEY, secretAccessKey.trim());
              await services.ai.storeSecret(SECRET_REGION, region.trim());

              this._client = client;
              this._connected = true;
              this._accountId = identity.Account;
              this._region    = region.trim();
              this._cachedContext = null;
              this._cacheTimestamp = 0;

              vscode.window.showInformationMessage(
                `AWS: Connected to account ${identity.Account} (${identity.Arn}) in ${region.trim()}`
              );
              services.events.emit('ui.status.update', {});
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Connection failed — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 2. Disconnect ───────────────────
    {
      id:    'aiForge.aws.disconnect',
      title: 'AWS: Disconnect',
      handler: async (services): Promise<void> => {
        await services.ai.storeSecret(SECRET_ACCESS_KEY_ID, '');
        await services.ai.storeSecret(SECRET_SECRET_ACCESS_KEY, '');
        await services.ai.storeSecret(SECRET_REGION, '');
        this._client = null;
        this._connected = false;
        this._accountId = '';
        this._region = '';
        this._cachedContext = null;
        this._cacheTimestamp = 0;
        vscode.window.showInformationMessage('AWS: Disconnected. Credentials cleared.');
        services.events.emit('ui.status.update', {});
      },
    },

    // ─────────────────── 3. Account Status ───────────────────
    {
      id:    'aiForge.aws.accountStatus',
      title: 'AWS: Account Status',
      handler: async (services): Promise<void> => {
        if (!this._connected || !this._client) {
          vscode.window.showInformationMessage(
            'AWS: Not connected.',
            'Connect Now',
          ).then(choice => {
            if (choice === 'Connect Now') {
              vscode.commands.executeCommand('aiForge.aws.connect');
            }
          });
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Fetching account info...' },
          async () => {
            try {
              const client = this._requireClient('get account status');
              const [lambdas, glueJobs, stacks] = await Promise.all([
                client.listLambdaFunctions().catch(() => []),
                client.listGlueJobs().catch(() => []),
                client.listCloudFormationStacks().catch(() => []),
              ]);

              const msg = [
                `**Account:** ${this._accountId}`,
                `**Region:** ${this._region}`,
                `**Lambda Functions:** ${lambdas.length}`,
                `**Glue Jobs:** ${glueJobs.length}`,
                `**CloudFormation Stacks:** ${stacks.length}`,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Summarize this AWS account status and highlight anything noteworthy:\n\n${msg}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Account status failed — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 4. List Lambdas ───────────────────
    {
      id:    'aiForge.aws.listLambdas',
      title: 'AWS: List Lambda Functions',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Fetching Lambda functions...' },
          async () => {
            try {
              const client = this._requireClient('list Lambda functions');
              const functions = await client.listLambdaFunctions();

              if (functions.length === 0) {
                vscode.window.showInformationMessage('AWS: No Lambda functions found.');
                return;
              }

              const summary = functions.map(fn => {
                const sizeMB = (fn.CodeSize / (1024 * 1024)).toFixed(1);
                return `| ${fn.FunctionName} | ${fn.Runtime ?? 'N/A'} | ${fn.MemorySize}MB | ${fn.Timeout}s | ${sizeMB}MB |`;
              }).join('\n');

              const header = '| Function | Runtime | Memory | Timeout | Code Size |\n| --- | --- | --- | --- | --- |';

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze these Lambda functions. Highlight any that have unusual configurations (high memory, long timeout, deprecated runtime, large code size):\n\n${header}\n${summary}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Failed to list Lambda functions — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 5. Lambda Details ───────────────────
    {
      id:    'aiForge.aws.lambdaDetails',
      title: 'AWS: Lambda Function Details',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get Lambda details');
          const functions = await client.listLambdaFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('AWS: No Lambda functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            functions.map(fn => ({
              label:        fn.FunctionName,
              description:  `${fn.Runtime ?? 'N/A'} | ${fn.MemorySize}MB | ${fn.Timeout}s`,
              detail:       fn.Description || 'No description',
              functionName: fn.FunctionName,
            })),
            { placeHolder: 'Select a Lambda function to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching ${pick.label}...` },
            async () => {
              const detail = await client.getLambdaFunction(pick.functionName);
              const config = detail.Configuration;

              const envVars = config.Environment?.Variables
                ? Object.entries(config.Environment.Variables).map(([k, v]) => `  - \`${k}\`: ${v}`).join('\n')
                : '  (none)';

              const layers = config.Layers
                ? config.Layers.map(l => `  - ${l.Arn}`).join('\n')
                : '  (none)';

              const vpc = config.VpcConfig?.SubnetIds?.length
                ? `Subnets: ${config.VpcConfig.SubnetIds.join(', ')} | SGs: ${config.VpcConfig.SecurityGroupIds.join(', ')}`
                : 'Not in VPC';

              const info = [
                `**Function:** ${config.FunctionName}`,
                `**Runtime:** ${config.Runtime}`,
                `**Handler:** ${config.Handler}`,
                `**Memory:** ${config.MemorySize}MB`,
                `**Timeout:** ${config.Timeout}s`,
                `**Code Size:** ${(config.CodeSize / (1024 * 1024)).toFixed(1)}MB`,
                `**Last Modified:** ${config.LastModified}`,
                `**VPC:** ${vpc}`,
                `\n**Environment Variables:**\n${envVars}`,
                `\n**Layers:**\n${layers}`,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze this Lambda function configuration. Suggest optimizations for performance, cost, and security:\n\n${info}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Lambda details failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 6. Invoke Lambda ───────────────────
    {
      id:    'aiForge.aws.invokeLambda',
      title: 'AWS: Invoke Lambda Function',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('invoke Lambda');
          const functions = await client.listLambdaFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('AWS: No Lambda functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            functions.map(fn => ({
              label:        fn.FunctionName,
              description:  `${fn.Runtime ?? 'N/A'} | ${fn.MemorySize}MB`,
              functionName: fn.FunctionName,
            })),
            { placeHolder: 'Select a Lambda function to invoke' },
          );
          if (!pick) return;

          const payloadStr = await vscode.window.showInputBox({
            prompt:      'JSON payload (leave empty for empty event)',
            placeHolder: '{"key": "value"}',
            value:       '{}',
            ignoreFocusOut: true,
            validateInput: (v) => {
              if (!v.trim()) return null;
              try { JSON.parse(v); return null; } catch { return 'Invalid JSON'; }
            },
          });
          if (payloadStr === undefined) return;

          const confirm = await vscode.window.showWarningMessage(
            `Invoke "${pick.label}" with payload?`,
            { modal: true },
            'Invoke',
          );
          if (confirm !== 'Invoke') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Invoking ${pick.label}...`, cancellable: false },
            async () => {
              const result = await client.invokeLambda(pick.functionName, payloadStr || '{}');

              const logOutput = result.LogResult
                ? Buffer.from(result.LogResult, 'base64').toString('utf8')
                : '(no logs returned)';

              const responsePayload = result.Payload ?? '(no response payload)';
              const hasError = !!result.FunctionError;

              const prompt = hasError
                ? `This Lambda invocation returned an error. Analyze the response and logs, diagnose the issue, and suggest a fix:

**Function:** ${pick.functionName}
**Status Code:** ${result.StatusCode}
**Function Error:** ${result.FunctionError}

**Response:**
\`\`\`json
${responsePayload}
\`\`\`

**Execution Logs:**
\`\`\`
${logOutput}
\`\`\``
                : `Analyze this Lambda invocation result:

**Function:** ${pick.functionName}
**Status Code:** ${result.StatusCode}

**Response:**
\`\`\`json
${responsePayload}
\`\`\`

**Execution Logs:**
\`\`\`
${logOutput}
\`\`\`

Summarize what the function did and highlight any performance or cost concerns from the logs.`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Lambda invocation failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 7. Lambda Logs ───────────────────
    {
      id:    'aiForge.aws.lambdaLogs',
      title: 'AWS: Lambda CloudWatch Logs',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('fetch Lambda logs');
          const functions = await client.listLambdaFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('AWS: No Lambda functions found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            functions.map(fn => ({
              label:        fn.FunctionName,
              description:  fn.Runtime ?? 'N/A',
              functionName: fn.FunctionName,
            })),
            { placeHolder: 'Select a Lambda function to view logs' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching logs for ${pick.label}...` },
            async () => {
              const logGroup = `/aws/lambda/${pick.functionName}`;
              const events = await client.getLogEvents(logGroup, 50);

              if (events.length === 0) {
                vscode.window.showInformationMessage(`AWS: No recent logs found for ${pick.functionName}.`);
                return;
              }

              const logText = events.map(e =>
                `[${new Date(e.timestamp).toISOString()}] ${e.message.trim()}`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze these recent CloudWatch logs for Lambda function "${pick.functionName}". Look for errors, patterns, performance issues, and cold starts:\n\n\`\`\`\n${logText.slice(0, 4000)}\n\`\`\``,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Lambda logs failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 8. Debug Lambda (killer feature) ───────────────────
    {
      id:    'aiForge.aws.debugLambda',
      title: 'AWS: Debug Lambda Function Errors',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('debug Lambda');
          const functions = await client.listLambdaFunctions();

          if (functions.length === 0) {
            vscode.window.showInformationMessage('AWS: No Lambda functions found.');
            return;
          }

          // Show functions and indicate which ones have recent errors
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'AWS: Checking Lambda functions for errors...' },
            async () => {
              const functionsWithErrors: Array<{
                functionName: string; runtime: string; memorySize: number;
                errors: Array<{ timestamp: number; message: string }>;
              }> = [];

              for (const fn of functions.slice(0, 20)) {
                const errors = await client.getLambdaErrors(fn.FunctionName, 5);
                if (errors.length > 0) {
                  functionsWithErrors.push({
                    functionName: fn.FunctionName,
                    runtime:      fn.Runtime,
                    memorySize:   fn.MemorySize,
                    errors,
                  });
                }
              }

              if (functionsWithErrors.length === 0) {
                vscode.window.showInformationMessage('AWS: No recent Lambda errors found. All functions are healthy!');
                return;
              }

              const pick = await vscode.window.showQuickPick(
                functionsWithErrors.map(fn => ({
                  label:        `$(error) ${fn.functionName}`,
                  description:  `${fn.errors.length} recent errors | ${fn.runtime} | ${fn.memorySize}MB`,
                  detail:       fn.errors[0]?.message.slice(0, 120) ?? '',
                  functionName: fn.functionName,
                })),
                { placeHolder: 'Select a Lambda function with errors to debug' },
              );
              if (!pick) return;

              // Fetch full details
              const detail = await client.getLambdaFunction(pick.functionName);
              const config = detail.Configuration;
              const fnWithErrors = functionsWithErrors.find(f => f.functionName === pick.functionName)!;

              const errorLogs = fnWithErrors.errors.map(e =>
                `[${new Date(e.timestamp).toISOString()}] ${e.message.trim()}`
              ).join('\n');

              const envVars = config.Environment?.Variables
                ? Object.entries(config.Environment.Variables).map(([k, v]) => `  ${k}=${v}`).join('\n')
                : '(none)';

              const prompt = `This Lambda function is experiencing errors. Here's the config, recent error logs, and details. Diagnose the issue, explain the root cause, and provide a fix.

**Function:** ${config.FunctionName}
**Runtime:** ${config.Runtime}
**Handler:** ${config.Handler}
**Memory:** ${config.MemorySize}MB
**Timeout:** ${config.Timeout}s
**Last Modified:** ${config.LastModified}

**Environment Variables:**
\`\`\`
${envVars}
\`\`\`

**Recent Error Logs (${fnWithErrors.errors.length} errors):**
\`\`\`
${errorLogs.slice(0, 3000)}
\`\`\`

Provide:
1. Root cause analysis — what exactly went wrong
2. The most likely fix (with code if applicable)
3. How to prevent this failure in the future
4. Any Lambda best practices that apply to this issue`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Debug Lambda failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 9. List Glue Jobs ───────────────────
    {
      id:    'aiForge.aws.listGlueJobs',
      title: 'AWS: List Glue Jobs',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Fetching Glue jobs...' },
          async () => {
            try {
              const client = this._requireClient('list Glue jobs');
              const jobs = await client.listGlueJobs();

              if (jobs.length === 0) {
                vscode.window.showInformationMessage('AWS: No Glue jobs found.');
                return;
              }

              const header = '| Job Name | Type | Glue Version | Workers | Timeout |\n| --- | --- | --- | --- | --- |';
              const rows = jobs.map(j =>
                `| ${j.Name} | ${j.Command?.Name ?? 'N/A'} | ${j.GlueVersion ?? 'N/A'} | ${j.NumberOfWorkers ?? 'N/A'} ${j.WorkerType ?? ''} | ${j.Timeout ?? 'N/A'}min |`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze these AWS Glue jobs. Highlight any with unusual configurations (old Glue version, too many/few workers, long timeout):\n\n${header}\n${rows}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Failed to list Glue jobs — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 10. Glue Job Details ───────────────────
    {
      id:    'aiForge.aws.glueJobDetails',
      title: 'AWS: Glue Job Details',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get Glue job details');
          const jobs = await client.listGlueJobs();

          if (jobs.length === 0) {
            vscode.window.showInformationMessage('AWS: No Glue jobs found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            jobs.map(j => ({
              label:   j.Name,
              description: `${j.Command?.Name ?? 'N/A'} | ${j.GlueVersion ?? 'N/A'}`,
              jobName: j.Name,
            })),
            { placeHolder: 'Select a Glue job to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching ${pick.label}...` },
            async () => {
              const detail = await client.getGlueJob(pick.jobName);
              const job = detail.Job;

              const connections = job.Connections?.Connections?.join(', ') ?? '(none)';
              const defaultArgs = job.DefaultArguments
                ? Object.entries(job.DefaultArguments).map(([k, v]) => `  ${k}: ${v}`).join('\n')
                : '(none)';

              const info = [
                `**Job:** ${job.Name}`,
                `**Description:** ${job.Description ?? '(none)'}`,
                `**Type:** ${job.Command?.Name ?? 'N/A'}`,
                `**Script Location:** ${job.Command?.ScriptLocation ?? 'N/A'}`,
                `**Glue Version:** ${job.GlueVersion ?? 'N/A'}`,
                `**Workers:** ${job.NumberOfWorkers ?? 'N/A'} ${job.WorkerType ?? ''}`,
                `**Max Retries:** ${job.MaxRetries ?? 0}`,
                `**Timeout:** ${job.Timeout ?? 'N/A'} minutes`,
                `**Connections:** ${connections}`,
                `\n**Default Arguments:**\n\`\`\`\n${defaultArgs}\n\`\`\``,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze this AWS Glue job configuration. Suggest optimizations for performance, cost, and reliability:\n\n${info}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Glue job details failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 11. Run Glue Job ───────────────────
    {
      id:    'aiForge.aws.runGlueJob',
      title: 'AWS: Run Glue Job',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('run Glue job');
          const jobs = await client.listGlueJobs();

          if (jobs.length === 0) {
            vscode.window.showInformationMessage('AWS: No Glue jobs found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            jobs.map(j => ({
              label:   j.Name,
              description: `${j.Command?.Name ?? 'N/A'} | Workers: ${j.NumberOfWorkers ?? 'N/A'}`,
              jobName: j.Name,
            })),
            { placeHolder: 'Select a Glue job to run' },
          );
          if (!pick) return;

          // Optional arguments
          const argsStr = await vscode.window.showInputBox({
            prompt:      'Optional: Job arguments as JSON (leave empty for defaults)',
            placeHolder: '{"--key": "value"}',
            ignoreFocusOut: true,
            validateInput: (v) => {
              if (!v.trim()) return null;
              try { JSON.parse(v); return null; } catch { return 'Invalid JSON'; }
            },
          });
          if (argsStr === undefined) return;

          const confirm = await vscode.window.showWarningMessage(
            `Run Glue job "${pick.label}"?`,
            { modal: true },
            'Run',
          );
          if (confirm !== 'Run') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Starting ${pick.label}...` },
            async () => {
              const args = argsStr?.trim() ? JSON.parse(argsStr) : undefined;
              const result = await client.startGlueJobRun(pick.jobName, args);
              vscode.window.showInformationMessage(
                `AWS: Glue job "${pick.label}" started. Run ID: ${result.JobRunId}`
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Run Glue job failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 12. Analyze Glue Failure ───────────────────
    {
      id:    'aiForge.aws.analyzeGlueFailure',
      title: 'AWS: Analyze Failed Glue Job Run',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('analyze Glue failure');
          const jobs = await client.listGlueJobs();

          if (jobs.length === 0) {
            vscode.window.showInformationMessage('AWS: No Glue jobs found.');
            return;
          }

          const jobPick = await vscode.window.showQuickPick(
            jobs.map(j => ({
              label:   j.Name,
              description: j.Command?.Name ?? 'N/A',
              jobName: j.Name,
            })),
            { placeHolder: 'Select a Glue job to analyze failures' },
          );
          if (!jobPick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching runs for ${jobPick.label}...` },
            async () => {
              const runs = await client.getGlueJobRuns(jobPick.jobName, 20);
              const failedRuns = runs.filter(r => r.JobRunState === 'FAILED');

              if (failedRuns.length === 0) {
                vscode.window.showInformationMessage(`AWS: No failed runs found for "${jobPick.label}".`);
                return;
              }

              const runPick = await vscode.window.showQuickPick(
                failedRuns.map(r => ({
                  label:       `Run ${r.Id}`,
                  description: r.StartedOn ? new Date(r.StartedOn * 1000).toLocaleString() : 'Unknown time',
                  detail:      r.ErrorMessage?.slice(0, 120) ?? 'No error message',
                  runId:       r.Id,
                  errorMsg:    r.ErrorMessage ?? 'Unknown error',
                })),
                { placeHolder: 'Select a failed run to analyze' },
              );
              if (!runPick) return;

              // Fetch job config for context
              const jobDetail = await client.getGlueJob(jobPick.jobName);
              const job = jobDetail.Job;

              const prompt = `This AWS Glue job failed. Analyze the error, explain the root cause, and suggest a specific fix.

**Job:** ${job.Name}
**Type:** ${job.Command?.Name ?? 'N/A'}
**Script Location:** ${job.Command?.ScriptLocation ?? 'N/A'}
**Glue Version:** ${job.GlueVersion ?? 'N/A'}
**Workers:** ${job.NumberOfWorkers ?? 'N/A'} ${job.WorkerType ?? ''}
**Run ID:** ${runPick.runId}

**Error Message:**
\`\`\`
${runPick.errorMsg}
\`\`\`

Provide:
1. Root cause analysis — what exactly went wrong
2. The most likely fix (with code if applicable)
3. How to prevent this failure in the future
4. Any Glue best practices that apply`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Analyze Glue failure failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 13. Glue Data Catalog ───────────────────
    {
      id:    'aiForge.aws.glueDataCatalog',
      title: 'AWS: Browse Glue Data Catalog',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('browse Glue Data Catalog');

          // Step 1: Pick database
          const databases = await client.getGlueDatabases();
          if (databases.length === 0) {
            vscode.window.showInformationMessage('AWS: No Glue databases found.');
            return;
          }

          const dbPick = await vscode.window.showQuickPick(
            databases.map(db => ({
              label:       db.Name,
              description: db.Description ?? '',
              detail:      db.LocationUri ?? '',
            })),
            { placeHolder: 'Select a Glue database' },
          );
          if (!dbPick) return;

          // Step 2: List tables
          const tables = await client.getGlueTables(dbPick.label);
          if (tables.length === 0) {
            vscode.window.showInformationMessage(`AWS: No tables in database "${dbPick.label}".`);
            return;
          }

          const tablePick = await vscode.window.showQuickPick(
            tables.map(t => ({
              label:       t.Name,
              description: t.TableType ?? '',
              detail:      t.StorageDescriptor?.Location ?? '',
              tableName:   t.Name,
            })),
            { placeHolder: `Select a table in ${dbPick.label}` },
          );
          if (!tablePick) return;

          // Step 3: Show table schema
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching schema for ${tablePick.label}...` },
            async () => {
              const table = tables.find(t => t.Name === tablePick.tableName)!;
              const columns = table.StorageDescriptor?.Columns
                ?.map(c => `  - \`${c.Name}\` ${c.Type}${c.Comment ? ` — ${c.Comment}` : ''}`)
                .join('\n') ?? '  (no column info)';

              const partKeys = table.PartitionKeys
                ?.map(p => `  - \`${p.Name}\` ${p.Type}`)
                .join('\n') ?? '  (none)';

              const prompt = `Explain this Glue Data Catalog table and suggest useful queries:

**Database:** ${dbPick.label}
**Table:** ${table.Name}
**Type:** ${table.TableType ?? 'N/A'}
**Location:** ${table.StorageDescriptor?.Location ?? 'N/A'}

**Columns:**
${columns}

**Partition Keys:**
${partKeys}

Please:
1. Explain what this table likely represents based on column names and types
2. Suggest 3-5 useful queries using Athena or Spark SQL
3. Identify any data quality concerns
4. Suggest optimal partition strategies if applicable`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Glue Data Catalog failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 14. Browse S3 ───────────────────
    {
      id:    'aiForge.aws.browseS3',
      title: 'AWS: Browse S3',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('browse S3');

          // Step 1: Pick bucket
          const buckets = await client.listS3Buckets();
          if (buckets.length === 0) {
            vscode.window.showInformationMessage('AWS: No S3 buckets found.');
            return;
          }

          const bucketPick = await vscode.window.showQuickPick(
            buckets.map(b => ({
              label:       b.Name,
              description: `Created: ${b.CreationDate}`,
              bucketName:  b.Name,
            })),
            { placeHolder: 'Select an S3 bucket' },
          );
          if (!bucketPick) return;

          // Step 2: Navigate folders
          let currentPrefix = '';
          let selectedKey: string | null = null;

          while (!selectedKey) {
            const listing = await client.listS3Objects(bucketPick.bucketName, currentPrefix);

            const items: Array<{ label: string; description: string; isFolder: boolean; key: string }> = [];

            // Go up option
            if (currentPrefix) {
              const parentPrefix = currentPrefix.split('/').slice(0, -2).join('/');
              items.push({
                label:       '$(arrow-up) ..',
                description: 'Go up one level',
                isFolder:    true,
                key:         parentPrefix ? parentPrefix + '/' : '',
              });
            }

            // Folders
            for (const prefix of listing.prefixes) {
              const folderName = prefix.replace(currentPrefix, '').replace(/\/$/, '');
              items.push({
                label:       `$(folder) ${folderName}`,
                description: 'Folder',
                isFolder:    true,
                key:         prefix,
              });
            }

            // Files
            for (const obj of listing.objects) {
              if (obj.Key === currentPrefix) continue; // skip the prefix itself
              const fileName = obj.Key.replace(currentPrefix, '');
              const sizeMB = (obj.Size / (1024 * 1024)).toFixed(2);
              items.push({
                label:       `$(file) ${fileName}`,
                description: `${sizeMB}MB | ${obj.LastModified}`,
                isFolder:    false,
                key:         obj.Key,
              });
            }

            if (items.length === 0) {
              vscode.window.showInformationMessage(`AWS: Empty location s3://${bucketPick.bucketName}/${currentPrefix}`);
              return;
            }

            const pick = await vscode.window.showQuickPick(items, {
              placeHolder: `s3://${bucketPick.bucketName}/${currentPrefix}`,
            });
            if (!pick) return;

            if (pick.isFolder) {
              currentPrefix = pick.key;
            } else {
              selectedKey = pick.key;
            }
          }

          // Download and open file
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Downloading s3://${bucketPick.bucketName}/${selectedKey}...` },
            async () => {
              const content = await client.getS3Object(bucketPick.bucketName, selectedKey!);
              const fileName = path.basename(selectedKey!);
              const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (!wsFolder) {
                // Open in untitled editor
                const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
                await vscode.window.showTextDocument(doc);
                return;
              }

              const filePath = path.join(wsFolder, '.aws-s3-downloads', fileName);
              await services.workspace.writeFile(filePath, content, true);
              vscode.window.showInformationMessage(`AWS: Downloaded ${fileName} from S3`);
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Browse S3 failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 15. Deploy to S3 ───────────────────
    {
      id:    'aiForge.aws.deployToS3',
      title: 'AWS: Upload Current File to S3',
      handler: async (services): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file to upload to S3.');
          return;
        }

        try {
          const client = this._requireClient('deploy to S3');

          const buckets = await client.listS3Buckets();
          if (buckets.length === 0) {
            vscode.window.showInformationMessage('AWS: No S3 buckets found.');
            return;
          }

          const bucketPick = await vscode.window.showQuickPick(
            buckets.map(b => ({
              label:      b.Name,
              bucketName: b.Name,
            })),
            { placeHolder: 'Select target S3 bucket' },
          );
          if (!bucketPick) return;

          const defaultKey = path.basename(editor.document.fileName);
          const s3Key = await vscode.window.showInputBox({
            prompt:      'S3 object key (path within the bucket)',
            placeHolder: defaultKey,
            value:       defaultKey,
            ignoreFocusOut: true,
            validateInput: (v) => v.trim() ? null : 'Key is required',
          });
          if (!s3Key) return;

          const confirm = await vscode.window.showWarningMessage(
            `Upload to s3://${bucketPick.bucketName}/${s3Key}?`,
            { modal: true },
            'Upload',
          );
          if (confirm !== 'Upload') return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Uploading to s3://${bucketPick.bucketName}/${s3Key}...` },
            async () => {
              await client.putS3Object(bucketPick.bucketName, s3Key.trim(), editor.document.getText());
              vscode.window.showInformationMessage(`AWS: Uploaded to s3://${bucketPick.bucketName}/${s3Key}`);
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Upload to S3 failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 16. List CloudFormation Stacks ───────────────────
    {
      id:    'aiForge.aws.listStacks',
      title: 'AWS: List CloudFormation Stacks',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Fetching CloudFormation stacks...' },
          async () => {
            try {
              const client = this._requireClient('list CloudFormation stacks');
              const stacks = await client.listCloudFormationStacks();

              if (stacks.length === 0) {
                vscode.window.showInformationMessage('AWS: No CloudFormation stacks found.');
                return;
              }

              const header = '| Stack Name | Status | Created |\n| --- | --- | --- |';
              const rows = stacks.map(s =>
                `| ${s.StackName} | ${s.StackStatus} | ${s.CreationTime} |`
              ).join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze these CloudFormation stacks. Highlight any in unusual states (rollback, failed, in-progress):\n\n${header}\n${rows}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Failed to list stacks — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 17. Stack Details ───────────────────
    {
      id:    'aiForge.aws.stackDetails',
      title: 'AWS: CloudFormation Stack Details',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('get stack details');
          const stacks = await client.listCloudFormationStacks();

          if (stacks.length === 0) {
            vscode.window.showInformationMessage('AWS: No CloudFormation stacks found.');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            stacks.map(s => ({
              label:       s.StackName,
              description: s.StackStatus,
              stackName:   s.StackName,
            })),
            { placeHolder: 'Select a stack to inspect' },
          );
          if (!pick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching ${pick.label}...` },
            async () => {
              const detail = await client.describeStack(pick.stackName);

              const resources = detail.Resources.length > 0
                ? detail.Resources.map(r => `  - ${r}`).join('\n')
                : '  (no resources)';

              const outputs = detail.Outputs.length > 0
                ? detail.Outputs.map(o => `  - **${o.Key}**: ${o.Value}`).join('\n')
                : '  (no outputs)';

              const events = detail.Events.length > 0
                ? detail.Events.slice(0, 10).map(e => `  - ${e}`).join('\n')
                : '  (no recent events)';

              const info = [
                `**Stack:** ${detail.StackName}`,
                `**Status:** ${detail.StackStatus}`,
                `\n**Resources (${detail.Resources.length}):**\n${resources}`,
                `\n**Outputs:**\n${outputs}`,
                `\n**Recent Events:**\n${events}`,
              ].join('\n');

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze this CloudFormation stack. Explain the architecture, resource relationships, and suggest improvements:\n\n${info}`,
                'chat',
              );
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Stack details failed — ${msg}`);
        }
      },
    },

    // ─────────────────── 18. List State Machines ───────────────────
    {
      id:    'aiForge.aws.listStateMachines',
      title: 'AWS: List Step Functions State Machines',
      handler: async (services): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AWS: Fetching Step Functions...' },
          async () => {
            try {
              const client = this._requireClient('list state machines');
              const machines = await client.listStateMachines();

              if (machines.length === 0) {
                vscode.window.showInformationMessage('AWS: No Step Functions state machines found.');
                return;
              }

              const header = '| Name | Type | Created |\n| --- | --- | --- |';
              const rows = machines.map(m =>
                `| ${m.name} | ${m.type} | ${new Date(m.creationDate).toISOString()} |`
              ).join('\n');

              // For each machine, try to get the definition for analysis
              let definitions = '';
              for (const m of machines.slice(0, 3)) {
                try {
                  const detail = await client.describeStateMachine(m.stateMachineArn);
                  const defn = JSON.parse(detail.definition);
                  const stateCount = Object.keys(defn.States ?? {}).length;
                  definitions += `\n\n### ${m.name} (${stateCount} states)\nStates: ${Object.keys(defn.States ?? {}).join(', ')}`;
                } catch { /* skip */ }
              }

              await vscode.commands.executeCommand(
                'aiForge._sendToChat',
                `Analyze these Step Functions state machines and their workflow designs:\n\n${header}\n${rows}${definitions}`,
                'chat',
              );
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              vscode.window.showErrorMessage(`AWS: Failed to list state machines — ${msg}`);
            }
          }
        );
      },
    },

    // ─────────────────── 19. Design Step Function ───────────────────
    {
      id:    'aiForge.aws.designStepFunction',
      title: 'AWS: Design Step Function Workflow',
      handler: async (services): Promise<void> => {
        const description = await vscode.window.showInputBox({
          prompt:      'Describe the workflow (e.g. "process uploaded CSV, validate data, transform, load to DynamoDB, send notification")',
          placeHolder: 'Describe your workflow...',
          ignoreFocusOut: true,
        });
        if (!description) return;

        // Gather existing Lambda functions for context
        let lambdaInfo = '';
        if (this._client && this._connected) {
          try {
            const functions = await this._client.listLambdaFunctions();
            if (functions.length > 0) {
              lambdaInfo = `\n\nAvailable Lambda functions: ${functions.map(f => f.FunctionName).join(', ')}`;
            }
          } catch { /* ignore */ }
        }

        const prompt = `Design a complete AWS Step Functions state machine (ASL — Amazon States Language) for this requirement:

"${description}"
${lambdaInfo}

Generate a complete ASL JSON definition that includes:
- StartAt and States
- Appropriate state types (Task, Choice, Parallel, Map, Wait, Pass, Fail, Succeed)
- Error handling with Catch and Retry on Task states
- Timeouts (TimeoutSeconds and HeartbeatSeconds) on long-running tasks
- Input/Output processing with Parameters, ResultPath, OutputPath where needed
- Comments on each state explaining its purpose

Also explain:
1. Why you structured the workflow this way
2. Error handling strategy
3. Cost and performance considerations
4. How to test and debug the workflow

${this._connected ? 'The user has a live AWS account — offer to help deploy this state machine.' : ''}`;

        await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
      },
    },

    // ─────────────────── 20. Explore DynamoDB ───────────────────
    {
      id:    'aiForge.aws.exploreDynamo',
      title: 'AWS: Explore DynamoDB Table',
      handler: async (services): Promise<void> => {
        try {
          const client = this._requireClient('explore DynamoDB');

          // Step 1: List tables
          const tableNames = await client.listDynamoDBTables();
          if (tableNames.length === 0) {
            vscode.window.showInformationMessage('AWS: No DynamoDB tables found.');
            return;
          }

          const tablePick = await vscode.window.showQuickPick(
            tableNames.map(name => ({ label: name, tableName: name })),
            { placeHolder: 'Select a DynamoDB table' },
          );
          if (!tablePick) return;

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `AWS: Fetching ${tablePick.label}...` },
            async () => {
              // Step 2: Describe table
              const tableInfo = await client.describeDynamoDBTable(tablePick.tableName);
              const table = tableInfo.Table;

              // Step 3: Sample scan
              const scanResult = await client.scanDynamoDBTable(tablePick.tableName, 10);
              const items = scanResult.Items ?? [];

              // Format key schema
              const keySchema = table.KeySchema.map(k => {
                const attrDef = table.AttributeDefinitions.find(a => a.AttributeName === k.AttributeName);
                return `  - \`${k.AttributeName}\` (${attrDef?.AttributeType ?? '?'}) — ${k.KeyType}`;
              }).join('\n');

              // Format GSIs
              const gsis = table.GlobalSecondaryIndexes
                ?.map(gsi => {
                  const keys = gsi.KeySchema.map(k => `${k.AttributeName}(${k.KeyType})`).join(', ');
                  return `  - **${gsi.IndexName}**: ${keys} | Projection: ${gsi.Projection.ProjectionType}`;
                }).join('\n') ?? '  (none)';

              // Format billing
              const billing = table.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST'
                ? 'On-Demand'
                : `Provisioned (RCU: ${table.ProvisionedThroughput?.ReadCapacityUnits ?? '?'}, WCU: ${table.ProvisionedThroughput?.WriteCapacityUnits ?? '?'})`;

              // Format sample items
              const sampleItems = items.length > 0
                ? '```json\n' + JSON.stringify(items.slice(0, 5), null, 2).slice(0, 2000) + '\n```'
                : '(no items)';

              const sizeMB = (table.TableSizeBytes / (1024 * 1024)).toFixed(2);

              const prompt = `Analyze this DynamoDB table, its schema, and sample data. Suggest access patterns and identify potential issues.

**Table:** ${table.TableName}
**Status:** ${table.TableStatus}
**Item Count:** ${table.ItemCount.toLocaleString()}
**Size:** ${sizeMB}MB
**Billing:** ${billing}

**Key Schema:**
${keySchema}

**Global Secondary Indexes:**
${gsis}

**Sample Items (${items.length} of ${scanResult.Count} scanned):**
${sampleItems}

Please:
1. Explain the data model and what this table represents
2. Suggest optimal access patterns based on the key schema and GSIs
3. Identify potential issues (hot partitions, missing GSIs for common queries, over-provisioning)
4. Recommend improvements to the table design
5. Provide example queries using AWS SDK (both Python boto3 and JS SDK v3)`;

              await vscode.commands.executeCommand('aiForge._sendToChat', prompt, 'chat');
            }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`AWS: Explore DynamoDB failed — ${msg}`);
        }
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async () => {
      if (this._connected) {
        return `$(cloud-upload) AWS ${this._region}`;
      }
      return '$(cloud-upload) AWS (disconnected)';
    },
  };
}
