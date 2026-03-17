# Evolve AI — Context-Aware AI Coding Assistant for VS Code

**Evolve AI** brings powerful AI code assistance directly into your editor. It works with **Ollama** (local/offline), **Anthropic Claude**, **OpenAI-compatible APIs**, and **Hugging Face** — so you choose where your code goes.

What sets it apart: a **plugin architecture** that automatically detects your tech stack and injects deep domain knowledge into every AI interaction. Working on Databricks? The Databricks plugin activates with live workspace integration. Deploying to AWS? Lambda, Glue, S3, and CloudFormation commands appear automatically. No configuration needed.

---

## Features

### Multi-Provider AI Support

| Provider | Privacy | Setup |
|---|---|---|
| **Ollama** (local) | Code never leaves your machine | Free, runs locally |
| **Anthropic Claude** | Cloud API | API key required |
| **OpenAI / Compatible** | Cloud API (Groq, Mistral, Together AI, LM Studio) | API key required |
| **Hugging Face** | Cloud API | API key required |
| **Offline mode** | Fully offline, pattern-based | No setup needed |

### AI Chat Sidebar

- Streaming responses with full project context
- Understands your active file, related files, diagnostics, and git state
- Context budget system ensures efficient token usage

### Smart Code Actions

- **CodeLens hints** above every function: Explain | Tests | Refactor
- **Lightbulb actions**: "Fix with AI" on any diagnostic
- **Right-click menu**: Explain, refactor, fix, document, generate tests
- **Keyboard shortcuts**: Quick access to common actions

### 15 Core Commands

- Open AI Chat (`Ctrl+Shift+A`)
- Generate Code from Description (`Ctrl+Alt+G`)
- Fix Current Errors (`Ctrl+Alt+F`)
- Explain Selected Code (`Ctrl+Alt+E`)
- Generate Commit Message (`Ctrl+Alt+M`)
- Refactor Selection, Add Documentation, Generate Tests, Apply Folder Transforms
- Explain Changes, Generate PR Description, Build Framework, Run & Auto-Fix
- Switch Provider, Setup Ollama

### 16 Auto-Detecting Plugins

Plugins activate automatically based on your workspace files. No configuration required.

| Plugin | Detects | Highlights |
|---|---|---|
| **Databricks** | `databricks.yml`, PySpark imports | 10+ commands, live workspace API: clusters, jobs, notebooks, Unity Catalog, SQL warehouse, DLT pipelines |
| **AWS** | `serverless.yml`, `template.yaml`, AWS SDK | 28+ commands, live API: Lambda, Glue, S3, CloudFormation, Step Functions, DynamoDB, IAM, SAM, CDK |
| **Google Cloud** | `app.yaml`, GCP SDK imports | 26+ commands, live API: Cloud Functions, Cloud Run, BigQuery, GCS, Pub/Sub, Firestore, Cloud Build |
| **Azure** | `host.json`, Azure SDK imports | 28+ commands, live API: Functions, Logic Apps, Cosmos DB, Storage, DevOps Pipelines, Bicep, Log Analytics |
| **dbt** | `dbt_project.yml` | 6 commands: explain models, tests, incremental, docs, optimize |
| **Apache Airflow** | `airflow.cfg`, DAG files | 6 commands: explain DAGs, TaskFlow, sensors, retry, monitoring |
| **pytest** | `pytest.ini`, `conftest.py` | 6 commands: generate tests, fixtures, parametrize, coverage |
| **FastAPI** | FastAPI imports | 6 commands: endpoints, validation, CRUD, auth, tests |
| **Django** | `manage.py` | 6 commands: models, serializers, admin, views, URLs, tests |
| **Terraform** | `*.tf` files | 6 commands: explain, variables, tags, modules, outputs, security |
| **Kubernetes** | K8s YAML manifests | 6 commands: explain, probes, resources, security, manifests, network |
| **Docker** | `Dockerfile` | 6 commands: explain, optimize, healthcheck, security, compose |
| **Jupyter** | `*.ipynb` files | 5 commands: explain, document, clean, convert, generate |
| **PyTorch** | PyTorch imports | 6 commands: models, training loops, checkpoints, mixed precision |
| **Security** | Always active | 3 commands: scan file, scan workspace, fix findings |
| **Git** | Always active | 4 commands: blame, changelog, commit messages, PR templates |

### Cloud Platform Integration

The **Databricks**, **AWS**, **Google Cloud**, and **Azure** plugins go beyond code assistance. They connect to your actual cloud accounts to:

- **Manage resources** — list and inspect Lambda functions, Cloud Run services, Azure Functions, Databricks clusters
- **Execute queries** — run SQL on BigQuery, Cosmos DB, Databricks SQL warehouses
- **Browse storage** — navigate S3 buckets, GCS objects, Azure Blob containers, Unity Catalog
- **Trigger and monitor jobs** — run Glue jobs, Databricks workflows, Step Functions
- **AI-powered diagnostics** — analyze failed job runs with AI explanations and fix suggestions
- **Deploy from VS Code** — deploy notebooks, upload to S3/GCS/Azure Storage, manage DLT pipelines

### Secure by Design

- API keys stored in VS Code's encrypted `SecretStorage` — never in plaintext settings
- Cloud credentials use standard provider SDKs and authentication flows
- All file edits go through VS Code's undo stack
- Diff preview before applying AI-generated changes
- Context budget caps prevent excessive token usage

---

## Quick Start

1. **Install the extension** from the VS Code Marketplace
2. **Choose your AI provider**:
   - For **local/private**: Install [Ollama](https://ollama.com), pull a model (`ollama pull qwen2.5-coder:7b`), and you're ready
   - For **cloud AI**: Run `Evolve AI: Switch AI Provider` from the command palette, select your provider, and enter your API key when prompted
3. **Start coding**: Open the AI Chat sidebar (`Ctrl+Shift+A`) or use any command from the command palette
4. **Cloud plugins** activate automatically when they detect relevant files in your workspace

---

## AI Providers

### Ollama (local, recommended)

Run AI completely on your machine — no API key, no cost, no data leaving your network.

```bash
# Install Ollama: https://ollama.ai
ollama pull qwen2.5-coder:7b
```

Set `aiForge.provider` to `ollama` (or leave on `auto` — it detects Ollama automatically).

Also compatible with **LM Studio**, **llama.cpp**, and **Jan** — point `aiForge.ollamaHost` at your server.

### Anthropic Claude

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Run command: **Switch AI Provider** -> select Anthropic
3. Enter your API key when prompted (stored in VS Code SecretStorage)

### OpenAI / Compatible

Works with OpenAI, Groq, Mistral, Together AI, LiteLLM, and any OpenAI-compatible endpoint.

1. Set `aiForge.openaiBaseUrl` to your endpoint (default: `https://api.openai.com/v1`)
2. Set `aiForge.openaiModel` to your model name
3. Run **Switch AI Provider** -> select OpenAI -> enter API key

### HuggingFace Inference API

Access thousands of open models via the HuggingFace Inference API.

1. Get a token from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. Set `aiForge.huggingfaceModel` (default: `Qwen/Qwen2.5-Coder-32B-Instruct`)
3. Run **Switch AI Provider** -> select HuggingFace -> enter token

### Built-in Offline AI

Pattern-based code analysis — works instantly with no setup, no network, no LLM.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `aiForge.provider` | `auto` | AI provider: `auto`, `ollama`, `anthropic`, `openai`, `huggingface`, `offline` |
| `aiForge.ollamaHost` | `http://localhost:11434` | Ollama server URL (also LM Studio, llama.cpp) |
| `aiForge.ollamaModel` | `qwen2.5-coder:7b` | Ollama model name |
| `aiForge.openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `aiForge.openaiModel` | `gpt-4o` | OpenAI model name |
| `aiForge.anthropicModel` | `claude-sonnet-4-6` | Anthropic model name |
| `aiForge.huggingfaceModel` | `Qwen/Qwen2.5-Coder-32B-Instruct` | Hugging Face model ID |
| `aiForge.codeLensEnabled` | `true` | Show CodeLens hints above functions |
| `aiForge.contextBudgetChars` | `24000` | Total character cap for AI context |
| `aiForge.maxContextFiles` | `5` | Max related files in context |
| `aiForge.disabledPlugins` | `[]` | Plugin IDs to disable (e.g., `["databricks", "aws"]`) |

---

## Keyboard Shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| Open chat panel | `Ctrl+Shift+A` | `Cmd+Shift+A` |
| Generate code from description | `Ctrl+Alt+G` | `Cmd+Alt+G` |
| Fix current file errors | `Ctrl+Alt+F` | `Cmd+Alt+F` |
| Explain selected code | `Ctrl+Alt+E` | `Cmd+Alt+E` |
| Generate commit message | `Ctrl+Alt+M` | `Cmd+Alt+M` |

---

## How Context Works

Every AI call automatically includes:

1. **Active file** — full content of your current file (priority budget allocation)
2. **Related files** — imported/importing files (remaining budget, capped at `maxContextFiles`)
3. **Diagnostics** — current errors and warnings (if `includeErrorsInContext` is enabled)
4. **Git diff** — unstaged changes (if `includeGitDiffInContext` is enabled)
5. **Plugin context** — domain-specific data from active plugins (e.g., dbt manifest, Terraform state, Databricks cluster info)

Total characters capped by `contextBudgetChars` (default 24,000). Increase for larger models; decrease for faster/cheaper ones.

---

## Cloud Plugin Setup Guides

### Databricks Connected

Connect to your Databricks workspace for live cluster management, job monitoring, notebook deployment, Unity Catalog browsing, and SQL execution.

**What you need:** A Databricks workspace URL and a Personal Access Token (PAT).

**Setup:**
1. Open the command palette (`Ctrl+Shift+P`)
2. Run **AI Forge: Databricks: Connect to Workspace**
3. Enter your workspace URL (e.g., `https://adb-1234567890.12.azuredatabricks.net`)
4. Enter your Personal Access Token
   - Generate one at: Workspace > User Settings > Developer > Access Tokens > Generate New Token
5. The status bar will show a green dot with your workspace name when connected

**Available commands after connecting:**

| Command | What it does |
|---|---|
| List Clusters | Shows all clusters with status, type, and Spark version |
| Cluster Details & Optimization | AI analyses a cluster's config and suggests optimizations |
| List Jobs | Shows all jobs with schedule and last run status |
| Run Job | Triggers a job run and monitors it |
| Analyse Failed Job Run | Fetches error logs from a failed run — AI diagnoses the root cause |
| Design Workflow with AI | Describe what you need — AI designs a complete Databricks workflow |
| Browse & Import Notebook | Navigate workspace notebooks and open them locally |
| Deploy Current File as Notebook | Push the current file to your Databricks workspace |
| Explore Unity Catalog | Browse catalogs, schemas, and tables with AI-powered data model analysis |
| AI Query Suggestion for Table | Select a table — AI generates useful queries for it |
| Execute SQL on Warehouse | Run SQL against a SQL warehouse and see results |
| Manage DLT Pipeline | View, start, stop, and troubleshoot Delta Live Tables pipelines |

---

### AWS Connected

Connect to your AWS account for Lambda management, Glue job monitoring, S3 browsing, CloudFormation analysis, Step Functions design, and DynamoDB exploration.

**What you need:** An IAM user or role with programmatic access (Access Key ID + Secret Access Key).

**Recommended IAM permissions:** `ReadOnlyAccess` for browsing, plus `lambda:InvokeFunction`, `glue:StartJobRun`, `s3:PutObject`, `states:StartExecution` for execution commands.

**Setup:**
1. Open the command palette (`Ctrl+Shift+P`)
2. Run **AI Forge: AWS: Connect to Account**
3. Enter your AWS Access Key ID
4. Enter your AWS Secret Access Key
5. Enter your AWS Region (e.g., `us-east-1`, `eu-west-1`)
6. The extension tests the connection with STS GetCallerIdentity

**Environment variable alternative:** Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION` — the plugin picks these up automatically.

**Available commands after connecting:**

| Command | What it does |
|---|---|
| List Lambda Functions | Shows all functions with runtime, memory, and timeout |
| Lambda Function Details | Deep-dive into a function's config — AI suggests optimizations |
| Invoke Lambda Function | Run a function with custom payload and see the response |
| View Lambda Logs | Fetch recent CloudWatch logs for a function |
| Debug Lambda Errors | Fetches error logs + config for functions with recent errors — AI diagnoses issues |
| List Glue Jobs | Shows all Glue jobs with type, version, and worker count |
| Glue Job Details | Inspect job config, script location, connections |
| Run Glue Job | Trigger a Glue job with optional arguments |
| Analyse Glue Job Failure | Pick a failed run — AI analyses the error and suggests fixes |
| Browse Glue Data Catalog | Navigate databases and tables with schema details |
| Browse S3 | Drill into buckets and folders, download files to editor |
| Deploy File to S3 | Upload the current file to an S3 bucket |
| List CloudFormation Stacks | Shows stacks with status and drift detection |
| CloudFormation Stack Details | Resources, outputs, events, template — AI explains the architecture |
| List Step Functions | Shows state machines with definition analysis |
| Design Step Function with AI | Describe a workflow — AI generates the complete ASL definition |
| Explore DynamoDB | Browse tables, inspect schemas, sample data — AI suggests access patterns |

---

### Google Cloud Connected

Connect to your GCP project for Cloud Functions management, Cloud Run monitoring, BigQuery analysis, GCS browsing, Pub/Sub messaging, and Firestore exploration.

**What you need:** A GCP service account JSON key file and your project ID.

**Setup:**
1. Open the command palette (`Ctrl+Shift+P`)
2. Run **AI Forge: Google Cloud: Connect to Project**
3. Select your service account JSON key file (file picker dialog)
   - Create one at: GCP Console > IAM & Admin > Service Accounts > Keys > Add Key > JSON
4. Enter your GCP project ID
5. The extension tests the connection by fetching project info

**Recommended roles:** `Viewer` for browsing, plus `Cloud Functions Invoker`, `BigQuery User`, `Storage Object Admin` for execution commands.

**Available commands after connecting:**

| Command | What it does |
|---|---|
| List Cloud Functions | Shows all functions with runtime, status, and trigger type |
| Function Details | Deep-dive into config — AI suggests optimizations |
| Invoke Function | Call an HTTP function with custom payload |
| View Function Logs | Fetch Cloud Logging entries for a function |
| Debug Function Errors | Scans for functions with errors — AI diagnoses issues |
| List Cloud Run Services | Shows services with URL, revision, and scaling config |
| Cloud Run Details | Inspect config, scaling, traffic routing — AI optimizes |
| Explore BigQuery | Browse datasets and tables with schema details — AI explains data model |
| Run BigQuery SQL | Execute a query and see results — AI analyses the output |
| Analyse BigQuery Failures | Inspect failed BigQuery jobs — AI diagnoses query issues |
| Browse Cloud Storage | Navigate buckets and objects, download to editor |
| Deploy to Cloud Storage | Upload current file to a GCS bucket |
| List Pub/Sub Topics | Shows topics and subscriptions — AI explains messaging architecture |
| Publish Pub/Sub Message | Send a message to a topic |
| Explore Firestore | Browse collections and documents — AI explains data model |

---

### Azure Connected

Connect to your Azure subscription for Functions management, Logic Apps monitoring, Cosmos DB querying, Storage browsing, DevOps pipeline analysis, and Log Analytics.

**What you need:** An Azure service principal (App Registration) with Tenant ID, Client ID, Client Secret, and Subscription ID.

**Setup:**
1. Open the command palette (`Ctrl+Shift+P`)
2. Run **AI Forge: Azure: Connect to Subscription**
3. Enter your Tenant ID
4. Enter your Application (Client) ID
5. Enter your Client Secret
6. Enter your Subscription ID
7. The extension tests the connection by fetching subscription info

**Creating a service principal:**
```bash
# Using Azure CLI
az ad sp create-for-rbac --name "Evolve-AI" --role "Reader" \
  --scopes /subscriptions/<your-subscription-id>
```
This outputs `appId` (Client ID), `password` (Client Secret), and `tenant` (Tenant ID).

**Available commands after connecting:**

| Command | What it does |
|---|---|
| List Function Apps | Shows all Azure Functions apps with runtime and status |
| Function App Details | Pick an app — AI analyses config and suggests optimizations |
| Invoke Function | Call a function with custom payload |
| View Function Logs | Fetch recent logs — AI analyses errors |
| Debug Function Errors | AI diagnoses problematic function apps |
| List Logic Apps | Shows Logic Apps with status and workflow info |
| Analyse Logic App Failure | Inspect failed runs — AI diagnoses issues |
| Explore Cosmos DB | Browse accounts, databases, containers — AI explains data model |
| Query Cosmos DB | Run SQL queries against a container |
| Browse Storage | Navigate storage accounts, containers, blobs — download to editor |
| Deploy to Storage | Upload current file to blob storage |
| List DevOps Pipelines | Shows pipelines with recent run status |
| Analyse Pipeline Failure | Pick a failed pipeline run — AI diagnoses the issue |
| List Web Apps | Shows App Service web apps with status |
| Restart Web App | Restart a web app with confirmation |
| Query Log Analytics | Run KQL queries against a Log Analytics workspace |
| List Active Alerts | Shows Azure Monitor alerts — AI explains and suggests remediation |

---

## Troubleshooting

### Chat shows OFFLINE / No response

**Ollama not detected:**
1. Verify Ollama is running: open `http://localhost:11434` in your browser — it should say "Ollama is running"
2. If using Windows and `localhost` doesn't work, try setting `aiForge.ollamaHost` to `http://127.0.0.1:11434`
3. Make sure you have a model pulled: `ollama list` should show at least one model
4. Check the model name matches `aiForge.ollamaModel` (default: `qwen2.5-coder:7b`)

**Cloud provider not responding:**
1. Check your API key is set: run **AI Forge: Switch AI Provider** and re-enter your key
2. Verify network connectivity to the provider's API endpoint
3. Check VS Code's Developer Tools console (`Help > Toggle Developer Tools`) for error messages

### Chat input not responding / buttons don't work

1. Reload the window: `Ctrl+Shift+P` > "Developer: Reload Window"
2. If the issue persists, close and reopen the chat panel
3. Check VS Code's Developer Tools console for JavaScript errors in the webview

### Plugin not activating

Plugins activate automatically based on workspace files. If a plugin isn't showing:
1. Make sure the workspace contains the expected marker files (see the plugin table above)
2. Check `aiForge.disabledPlugins` in settings — make sure the plugin ID isn't listed
3. Reload the window to trigger re-detection

### Cloud plugin shows "not connected"

1. Run the connect command for your provider (e.g., **AWS: Connect to Account**)
2. Verify your credentials are correct — the connect command tests the connection
3. Check that your credentials have sufficient permissions (see setup guides above)
4. For AWS: ensure your region is correct and your IAM user/role is active
5. For GCP: ensure the service account JSON key is valid and not expired
6. For Azure: ensure the client secret hasn't expired
7. For Databricks: ensure the PAT hasn't expired and your workspace URL is correct

### Commands show "command not found"

This happens when a cloud plugin command is triggered but the plugin isn't active. Cloud plugin commands only register when:
1. The plugin **detects** matching files in your workspace (e.g., `serverless.yml` for AWS)
2. The plugin has **activated** (connected to the cloud provider)

**Fix:** Open a workspace that contains files for that cloud platform, then run the connect command.

### Slow responses

1. **Ollama:** Use a smaller model (e.g., `qwen2.5-coder:3b` instead of `7b`)
2. **Context too large:** Reduce `aiForge.contextBudgetChars` (try `12000`) or `aiForge.maxContextFiles` (try `3`)
3. **Cloud context:** Connected plugins add live data to context — this adds a small delay on each request

### How to disconnect / change credentials

Run the disconnect command for your provider:
- **AI Forge: AWS: Disconnect**
- **AI Forge: Google Cloud: Disconnect**
- **AI Forge: Azure: Disconnect**
- **AI Forge: Databricks: Disconnect**

Then run the connect command again with new credentials.

---

## FAQ

### General

**Q: Is my code sent to the cloud?**
A: It depends on your provider. With **Ollama**, everything stays on your machine — no data leaves your network. With cloud providers (Anthropic, OpenAI, HuggingFace), your code context is sent to their API. Choose based on your privacy requirements.

**Q: Which AI provider should I use?**
A: For **privacy and cost**: Ollama (free, local). For **best quality**: Anthropic Claude or OpenAI GPT-4o. For **speed on a budget**: Groq (via OpenAI-compatible endpoint). For **no setup**: the built-in offline mode (limited to pattern-based analysis).

**Q: Can I use multiple providers?**
A: You can switch providers at any time via **AI Forge: Switch AI Provider**. The extension uses one provider at a time.

**Q: What models work with Ollama?**
A: Any model Ollama supports. Recommended: `qwen2.5-coder:7b` (default, good balance), `codellama:13b` (larger, better quality), `deepseek-coder:6.7b`, or `starcoder2:7b`. Run `ollama list` to see installed models.

**Q: Does Evolve AI work with LM Studio / llama.cpp / Jan?**
A: Yes. Set `aiForge.ollamaHost` to your server's URL (e.g., `http://localhost:1234/v1` for LM Studio). These servers implement the same API as Ollama.

### Plugins

**Q: How do plugins activate?**
A: Automatically. When you open a workspace, Evolve AI scans for marker files (e.g., `Dockerfile` for Docker, `manage.py` for Django). Matching plugins activate silently and start injecting domain knowledge into every AI interaction. The status bar shows active plugins.

**Q: Can I disable a plugin?**
A: Yes. Add the plugin ID to `aiForge.disabledPlugins` in settings. Example: `["databricks", "docker"]`. Plugin IDs: `databricks`, `databricks-connected`, `aws`, `aws-connected`, `gcp`, `gcp-connected`, `azure`, `azure-connected`, `dbt`, `airflow`, `pytest`, `fastapi`, `django`, `terraform`, `kubernetes`, `docker`, `jupyter`, `pytorch`, `security`, `git`.

**Q: What's the difference between the base and connected versions of cloud plugins?**
A: The **base** plugin (e.g., AWS) activates on file detection and injects best-practice knowledge into AI responses — no credentials needed. The **connected** plugin (e.g., AWS Connected) adds live API access — browse resources, run queries, analyze failures, deploy code. Both can be active simultaneously.

**Q: Do cloud plugins cost anything?**
A: The plugins themselves are free. But they call your cloud provider's APIs, which may incur costs depending on your plan. Read-only operations (listing resources, reading logs) are typically free or low-cost. Execution operations (invoking Lambda, running BigQuery queries) may have associated costs.

### Cloud Credentials

**Q: Where are my credentials stored?**
A: In VS Code's encrypted `SecretStorage` — the same mechanism VS Code uses for its own authentication. Credentials are never written to settings files, `.env` files, or any plaintext location.

**Q: Can I use temporary/session credentials?**
A: For **AWS**, yes — you can provide a session token along with your access key and secret key. For **Azure**, the client secret has an expiry set in Azure AD. For **GCP**, service account keys don't expire but can be rotated. For **Databricks**, PATs have configurable expiry.

**Q: What permissions do I need?**
A: At minimum, read-only access to list and inspect resources. For execution features (invoking functions, running jobs, deploying files), you need the corresponding write permissions. See each cloud plugin's setup guide above for specific IAM recommendations.

**Q: Is it safe to use in production?**
A: The extension only performs the actions you explicitly trigger via commands. It never modifies cloud resources automatically. Execution commands (run job, invoke function, deploy) always require your manual action.

---

## Contributing

Evolve AI uses a plugin architecture that makes adding new stack support straightforward.

1. Read `docs/ARCHITECTURE.md` for the full structural design
2. Read `docs/PLUGIN_GUIDE.md` for the step-by-step plugin template
3. Create `src/plugins/<name>.ts` implementing the `IPlugin` interface
4. Register it in `src/plugins/index.ts`
5. Add commands to `package.json` under `contributes.commands`

Future plugin ideas (community contributions welcome):
- **Next.js** — App Router, Server Components, API routes
- **Rust** — ownership, lifetimes, async patterns
- **Go** — goroutines, interfaces, error handling
- **GraphQL** — schema, resolvers, queries

---

## Requirements

- VS Code 1.85.0 or later
- For local AI: [Ollama](https://ollama.com) with a pulled model
- For cloud AI: An API key from your chosen provider
- For cloud plugins: Appropriate credentials (see setup guides above)

---

## License

[MIT](LICENSE)
