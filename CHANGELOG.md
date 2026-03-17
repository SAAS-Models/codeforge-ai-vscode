# Changelog

All notable changes to Evolve AI are documented here.

## [1.1.0] — 2026-03-16

### Added

#### Cloud platform API clients
- **Databricks API Client** — REST client with PAT authentication: clusters, jobs, runs, workspace/notebooks, Unity Catalog (catalogs/schemas/tables), SQL warehouses, DBFS, secrets, DLT pipelines (28 API methods)
- **AWS API Client** — Full AWS Signature V4 authentication: STS, Lambda, Glue, S3, CloudFormation, Step Functions, CloudWatch Logs, DynamoDB, EventBridge, SNS/SQS (42 API methods)
- **Google Cloud API Client** — JWT/OAuth2 service account authentication: Cloud Functions v2, Cloud Run, BigQuery, Cloud Storage, Pub/Sub, Firestore, Cloud Logging, Dataflow, Cloud Scheduler (27 API methods)
- **Azure API Client** — OAuth2 client credentials flow: Functions, Logic Apps, Cosmos DB, Storage, DevOps Pipelines, App Service, Key Vault, Monitor/Logs, SQL Database (35 API methods)

#### Databricks Connected plugin (15 commands)
- Connect/disconnect to Databricks workspace with PAT authentication
- List and inspect clusters with AI-powered optimisation suggestions
- List, run, and monitor jobs; analyse failed job runs with AI diagnostics
- Browse and import workspace notebooks; deploy local files as notebooks
- Explore Unity Catalog (catalogs, schemas, tables) with AI data model analysis
- Execute SQL on SQL warehouses; AI-powered query suggestions
- Manage and troubleshoot Delta Live Tables pipelines
- Live context injection: cluster status, recent failures, catalog info in every AI prompt

#### AWS Connected plugin (20 commands)
- Connect/disconnect with IAM credentials (Access Key + Secret + Region)
- Environment variable auto-detection (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
- Lambda: list, inspect, invoke, view CloudWatch logs, debug errors with AI
- Glue: list jobs, inspect details, trigger runs, analyse failures, browse Data Catalog
- S3: browse buckets and objects, download to editor, deploy files
- CloudFormation: list stacks, inspect resources/events/templates with AI architecture analysis
- Step Functions: list state machines, design new workflows with AI-generated ASL
- DynamoDB: explore tables, inspect schemas, sample data, AI access pattern analysis

#### Google Cloud Connected plugin (18 commands)
- Connect with service account JSON key file + project ID
- Cloud Functions: list, inspect, invoke, view logs, debug errors with AI
- Cloud Run: list services, inspect config/scaling/traffic with AI optimisation
- BigQuery: browse datasets/tables, execute SQL, analyse failed jobs with AI
- Cloud Storage: browse buckets/objects, download to editor, deploy files
- Pub/Sub: list topics/subscriptions, publish messages
- Firestore: browse collections/documents with AI data model analysis

#### Azure Connected plugin (20 commands)
- Connect with service principal credentials (Tenant ID, Client ID, Client Secret, Subscription ID)
- Azure Functions: list apps, inspect, invoke, view logs, debug errors with AI
- Logic Apps: list workflows, analyse failed runs with AI diagnostics
- Cosmos DB: browse accounts/databases/containers, execute SQL queries
- Storage: browse accounts/containers/blobs, download to editor, deploy files
- DevOps Pipelines: list pipelines, analyse failed runs with AI
- App Service: list web apps, restart with confirmation
- Monitoring: query Log Analytics with KQL, list active alerts with AI remediation suggestions

#### AWS base plugin (8 commands)
- Offline/context-only AWS assistance: explain stacks, optimise Lambda, generate IAM policies
- SAM/CDK best practices, error handling patterns, CloudWatch logging
- Auto-detects samconfig.toml, cdk.json, serverless.yml, template.yaml, AWS SDK imports

#### Google Cloud base plugin (8 commands)
- Offline/context-only GCP assistance: explain services, optimise functions, BigQuery optimisation
- Cloud Build, Firestore rules, Cloud Logging best practices
- Auto-detects app.yaml, cloudbuild.yaml, firebase.json, GCP SDK imports

#### Azure base plugin (8 commands)
- Offline/context-only Azure assistance: explain resources, optimise functions, pipeline generation
- ARM/Bicep, Managed Identity, retry policy best practices
- Auto-detects host.json, azure-pipelines.yml, main.bicep, Azure SDK imports

#### Documentation
- Comprehensive marketplace README with cloud plugin setup guides
- Per-provider command reference tables
- Troubleshooting guide and FAQ section
- IAM/credential setup instructions for all four cloud platforms

### Fixed
- **Windows IPv6 issue** — Ollama connection now falls back to `127.0.0.1` when `localhost` resolves to IPv6 `::1`

## [1.0.0] — 2026-03-13

### Added

#### Core system
- AI chat sidebar with streaming responses and full project context
- Multi-provider support: Ollama (local/offline), Anthropic Claude, OpenAI-compatible endpoints, HuggingFace Inference API, and built-in offline mode
- Context assembly engine with configurable character budget (default 24,000 chars) shared across active file, related files, diagnostics, git diff, and plugin data
- Plugin architecture: `IPlugin` interface, `PluginRegistry`, automatic detection/activation/deactivation per workspace
- Typed event bus for decoupled communication between services, plugins, and UI
- Dependency injection root (`ServiceContainer`) — all services accessed through `IServices` interfaces
- Secure API key storage via VS Code `SecretStorage` (never in plaintext settings)
- Code Lens provider showing Explain | Tests | Refactor above every function
- Lightbulb Code Action provider ("Fix with AI" on any diagnostic)
- Status bar item showing active provider and active plugin count
- 15 core commands covering chat, code generation, refactoring, documentation, testing, git, and folder transforms
- Undoable file edits via `WorkspaceEdit` batch API; diff preview before applying changes

#### Databricks plugin (10 commands)
- Explain Spark jobs, optimise queries, convert SQL to DataFrame API
- Convert writes to Delta Lake, wrap transformations as Delta Live Tables
- Add MLflow tracking, fix `.collect()` OOM risk, replace Python UDFs with built-ins
- Add Unity Catalog 3-part names, generate Databricks Jobs YAML

#### dbt plugin (6 commands)
- Explain models, add data quality tests, convert to incremental materialisation
- Generate YAML documentation, optimise model SQL, generate source YAML

#### Apache Airflow plugin (6 commands)
- Explain DAGs, convert classic operators to TaskFlow API
- Add sensor tasks, add retry policies, generate new DAGs, add monitoring/alerting

#### pytest plugin (6 commands)
- Generate parametrized tests, extract fixtures, add `@pytest.mark.parametrize`
- Convert `unittest.TestCase` to pytest style, add coverage configuration, explain tests

#### FastAPI plugin (6 commands)
- Explain endpoints, add Pydantic request validation, add response models
- Generate CRUD routers, add JWT/OAuth2 authentication, generate TestClient tests

#### Django plugin (6 commands)
- Explain models, generate DRF serializers, generate Admin registrations
- Generate class-based views, generate URL patterns, generate model and view tests

#### Terraform plugin (6 commands)
- Explain resources, extract hardcoded values to variables, add tags to all resources
- Generate reusable modules, add outputs, audit for security best practices

#### Kubernetes plugin (6 commands)
- Explain manifests, add liveness/readiness probes, add CPU/memory resource limits
- Add security contexts, generate manifests from descriptions, add network policies

#### Docker plugin (6 commands)
- Explain Dockerfiles, optimise layer count and image size, add HEALTHCHECK
- Security audit, generate docker-compose.yml, generate Dockerfile from description

#### Jupyter plugin (5 commands)
- Explain notebooks, add markdown documentation cells, clean outputs
- Convert Python scripts to notebooks, generate notebooks from descriptions

#### PyTorch plugin (6 commands)
- Explain `nn.Module` architectures, generate training loops, add checkpoint save/load
- Optimise training with gradient accumulation, add mixed precision (torch.amp), generate Dataset classes

#### Security plugin (3 commands — always active)
- Scan current file for secrets, SQL injection, hardcoded credentials, insecure patterns
- Scan entire workspace, fix individual security findings

#### Git plugin (4 commands — always active)
- Git blame with AI explanation, generate changelog from git history
- Smart conventional commit message generation, generate PR description templates

#### Test suite
- Unit tests for EventBus, AIService, PluginRegistry, WorkspaceService, ContextService
- Plugin-specific tests for all 13 plugins
- Integration tests: plugin lifecycle, command execution, provider switching
