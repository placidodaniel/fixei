<div align="right">

[🇧🇷 Português](README.pt.md) | 🇺🇸 English

</div>

# Fixei

> *"Corrigiu sozinho."* — Autonomous bug-fixing pipeline, from ticket to production deploy, zero human intervention.

**Author:** Daniel Plácido
**License:** MIT

Fixei receives a bug report (GitHub Issue or Jira), deeply analyzes your codebase using semantic search and LLMs, generates a complete code fix, writes new tests, opens a Pull Request, waits for CI/CD to pass, merges automatically, and closes the original ticket — all without touching a keyboard.

---

## Table of Contents

- [How it works](#how-it-works)
- [Agent Pipeline & Context Exchange](#agent-pipeline--context-exchange)
  - [Orchestrator](#orchestrator)
  - [TicketAgent](#ticketagent)
  - [DocumentationAgent](#documentationagent)
  - [AnalysisAgent](#analysisagent)
  - [CodeAgent](#codeagent)
  - [TestAgent](#testagent)
  - [DeployAgent](#deployagent)
- [Services](#services)
  - [VectorStoreService](#vectorstoreservice)
  - [Context7Service](#context7service)
  - [LLMService & Model Fallback](#llmservice--model-fallback)
  - [GitHubService](#githubservice)
  - [StateManager](#statemanager)
  - [NotificationService](#notificationservice)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Running in Production](#running-in-production)
- [Webhook Setup](#webhook-setup)
- [REST API](#rest-api)
- [Dashboard](#dashboard)
- [Running Tests](#running-tests)
- [Security Considerations](#security-considerations)

---

## How it works

```
GitHub Issue / Jira ticket (labeled "ai-fix")
    │
    ▼
[1] TicketAgent          → normalizes and structures the raw ticket
    │
    ▼
[2] DocumentationAgent   → ensures codebase docs are fresh
    │                       (.bugfix-agent/BACKEND.md + FRONTEND.md)
    │                       triggers vector index rebuild
    ▼
[3] AnalysisAgent        → semantic search over codebase + LLM analysis
    │                       confirms root cause, identifies affected files
    ▼
[4] CodeAgent            → fetches current file contents + Context7 best practices
    │                       generates complete fix via LLM (structured format)
    │                       creates branch, commits files
    ▼
[5] TestAgent            → generates new test file via LLM
    │                       commits tests, triggers GitHub Actions CI
    │                       polls until pass/fail (up to 10 min)
    ▼  if tests fail ────────────────────────────────────┐
[6] DeployAgent          → creates PR + labels            │ retry loop
    │                       waits for CI checks           │ (up to MAX_RETRIES)
    │                       auto-merges                   │
    ▼                                                    ◄┘
[7] TicketAgent          → closes ticket as fixed
    │
    ▼
    Slack notification + GitHub audit trail comment
```

If all retries are exhausted, the agent **escalates** — posts a Slack alert, adds a `needs-human` label to the ticket, and stops.

---

## Agent Pipeline & Context Exchange

Every agent is a stateless class that receives dependencies through its constructor. The **Orchestrator** manages a `ctx` object that accumulates results at each stage and passes them to the next agent. Below is the exact data that flows between each step.

### Orchestrator

`src/orchestrator.js`

The Orchestrator owns the pipeline lifecycle. It instantiates every agent at startup and runs them sequentially via the `run(ticketPayload)` method.

The shared context object `ctx` evolves through the pipeline:

```js
ctx = {
  runId: "run_1234567890",
  ticket: null,       // ← filled by TicketAgent
  docs: null,         // ← filled by DocumentationAgent
  analysis: null,     // ← filled by AnalysisAgent
  fix: null,          // ← filled by CodeAgent (updated each retry)
  tests: null,        // ← filled by TestAgent
  deploy: null,       // ← filled by DeployAgent
  retries: 0,
  maxRetries: 3,
  status: 'running',
  auditLog: [],       // ← each agent appends an entry
}
```

The `auditLog` is posted as a structured comment on the GitHub Issue at the end of every run (success or failure), giving full traceability.

---

### TicketAgent

`src/agents/ticket-agent.js`

**Input:** raw webhook payload (GitHub Issue or Jira format)

**Output:**
```js
{
  id: "123",
  title: "Form does not show validation errors",
  description: "Full normalized description",
  stepsToReproduce: ["1. Open form", "2. Submit empty"],
  expectedBehavior: "Should show error messages",
  actualBehavior: "Form silently fails",
  environment: "production",
  severity: "medium",
  labels: ["ai-fix", "bug"],
  reporter: "john",
  rawLogs: "...",
  _provider: "github"  // or "jira"
}
```

The LLM normalizes the raw ticket into a typed structure regardless of the source format. If parsing fails, a fallback extracts data from the raw text directly.

**Context passed forward:** `ctx.ticket` is used by all subsequent agents as the source of truth for the bug description.

Also responsible for `closeAsFixed()`, `closeAsInvalid()`, and `escalate()` which post comments and update the ticket state.

---

### DocumentationAgent

`src/agents/documentation-agent.js`

**Input:** `ctx.ticket`

**Output:** combined string of `BACKEND.md` + `FRONTEND.md`

**What it does:**

Maintains two living documentation files **inside the target repository** itself:

```
(target repo)/
  .bugfix-agent/
    BACKEND.md    ← architecture, routes, services, models, auth, queue, patterns
    FRONTEND.md   ← components, routing, state management, API calls, i18n, build
```

Each document has **11 structured sections** generated by the LLM after reading the most relevant source files (up to 35 files per layer).

**Staleness check (`_needsUpdate`):** extracts all tokens ≥ 5 characters from the current ticket. If more than 30% of those tokens are absent from the existing docs, the documentation is considered stale and is regenerated. This ensures the vector index always has context relevant to the current bug.

**After updating docs:** triggers an async rebuild of the VectorStore index so the AnalysisAgent's semantic search is fresh.

**Context passed forward:** `ctx.docs` is injected into the AnalysisAgent prompt so the LLM understands the full architecture before looking at code.

---

### AnalysisAgent

`src/agents/analysis-agent.js`

**Input:** `ctx.ticket` + `ctx.docs`

**Output:**
```js
{
  confirmed: true,
  reason: "Validation errors are caught but not forwarded to the component",
  rootCause: "ContactController returns 422 but ContactForm ignores non-2xx responses",
  codeLocations: ["ContactController.ts:L87", "ContactForm/index.js:L134"],
  affectedFiles: [
    "backend/src/controllers/ContactController.ts",
    "frontend/src/components/ContactForm/index.js"
  ],
  affectedFunctions: ["store()", "handleSubmit()"],
  bugType: "error-handling",
  backendChanges: "Return validation errors in response body under `errors` key",
  frontendChanges: "Read `errors` from 422 response and display per-field messages",
  suggestedApproach: "Catch non-2xx in ContactForm, map errors to form state",
  riskLevel: "low",
  estimatedComplexity: "simple"
}
```

**How the code context is fetched (`_fetchCodeContext`):**

1. Lists all repository files via GitHub API
2. Filters out irrelevant extensions (images, lock files, binaries, etc.)
3. **Fast path (vector index is ready):** embeds the ticket text → runs `vectorStore.searchPaths()` → fetches top-12 semantically similar files in parallel
4. **Fallback (no index):** up to 3 rounds of LLM-based triage asking for 4 files at a time, plus a dedicated frontend pass if no `.vue/.jsx/.tsx` files were selected
5. Full file contents are concatenated and injected into the analysis prompt

The agent also posts a formatted comment directly on the GitHub Issue summarizing the root cause and affected code locations.

**Context passed forward:** `ctx.analysis` is the most critical handoff — it tells the CodeAgent exactly *what* to fix, *where*, and *how*.

---

### CodeAgent

`src/agents/code-agent.js`

**Input:** `ctx.analysis` + optional `ctx.fix.feedback` (test failure details from a previous attempt)

**Output:**
```js
{
  branch: "bugfix/auto-1711234567890",
  prTitle: "fix(contacts): show validation errors in ContactForm",
  prDescription: "## Root Cause\n...",
  fileChanges: [
    { path: "backend/src/controllers/ContactController.ts", operation: "update", content: "..." },
    { path: "frontend/src/components/ContactForm/index.js", operation: "update", content: "..." }
  ],
  testHints: "Test 422 response handling; test empty form submission",
  breakingChange: false,
  rollbackPlan: "Revert PR #N or cherry-pick the previous controller commit",
  feedback: null
}
```

**What it does:**

1. **Fetches current file contents** for every `affectedFile` from GitHub
2. **Fetches best practices from Context7** (see [Context7Service](#context7service))
3. **Builds a structured prompt** that includes:
   - Root cause, bug type, risk level, suggested approach
   - Backend and frontend change descriptions (from AnalysisAgent)
   - Previous test failure feedback (on retries)
   - Full current file contents
   - Context7 best practices for the tech stack (capped at ~3000 chars)
4. **Calls the LLM** requesting a structured response format (no JSON-embedded code):

```
<<<PLAN>>>
{ "prTitle": "...", "files": [{"path": "...", "operation": "update"}] }
<<<END_PLAN>>>

<<<FILE: backend/src/controllers/ContactController.ts>>>
(full file content — every single line)
<<<END_FILE>>>

<<<FILE: frontend/src/components/ContactForm/index.js>>>
(full file content)
<<<END_FILE>>>
```

This format separates metadata (JSON) from file content, preventing JSON parse failures caused by TypeScript braces, template literals, and other syntax inside strings.

5. **Truncation detection:** if the LLM used placeholders like `// ...`, `/* existing code */`, or `// unchanged`, the agent runs a dedicated merge pass (`_expandTruncated`) that combines the original file + the partial fix into a complete file
6. **Path validation:** if the LLM invented a file path not in the repository, it is remapped to the closest real path by filename match, or dropped
7. **Branch creation and commits** via GitHub API

**Recovery pass:** if the LLM output cannot be parsed at all (e.g. truncated mid-response), `_recoverJson()` sends the broken text back to the LLM and asks it to reformat using the structured format.

**Context passed forward:** `ctx.fix` contains the branch name, PR metadata, and the list of changed files — used by TestAgent, DeployAgent, and the audit log.

---

### TestAgent

`src/agents/test-agent.js`

**Input:** `ctx.fix` + `ctx.analysis`

**Output:**
```js
{
  passed: true,
  total: 24,
  failureDetails: null,  // or LLM summary of failures on failure
  newTestsFile: "tests/controllers/ContactController.test.ts",
  ciRunUrl: "https://github.com/owner/repo/actions/runs/12345"
}
```

**What it does:**

1. **Generates a new test file** — the LLM receives: the bug description, root cause, test hints from CodeAgent, and the changed file contents. It produces a complete test file (Jest/Vitest/Mocha — inferred from existing imports in the repo). Test path resolved from source path: `src/foo/bar.ts` → `tests/foo/bar.test.ts`

2. **Commits the test file** to the fix branch (if `COMMIT_TESTS !== false`)

3. **Triggers GitHub Actions CI** — calls `POST /repos/{owner}/{repo}/actions/workflows/{ciWorkflowId}/dispatches`. Then retries up to **10 times** (every 5 seconds, totaling 50 seconds) waiting for the workflow run to appear in the API

4. **Polls CI status** — checks every 15 seconds until `CI_TIMEOUT_MS` (default: 10 minutes). Reads step counts from the workflow run to estimate `passed/total`

5. On failure: **`_interpretFailure(logs)`** — asks the LLM to summarize the test failure in 2-3 sentences

**Context passed forward:** if `tests.passed === false`, the Orchestrator sets `ctx.fix.feedback = tests.failureDetails` and loops back to CodeAgent with this feedback, so the next attempt addresses the specific test failures.

---

### DeployAgent

`src/agents/deploy-agent.js`

**Input:** `ctx.fix` + `ctx.tests`

**Output:**
```js
{
  prUrl: "https://github.com/owner/repo/pull/42",
  prNumber: 42,
  branch: "bugfix/auto-1711234567890",
  environment: "production",  // or "staging" if not merged
  merged: true
}
```

**What it does:**

1. **Creates a Pull Request** with a fully formatted markdown body that includes: description, test results (pass count), files changed table, breaking change flag, and rollback plan
2. **Adds labels** `auto-fix` and `bugfix` to the PR
3. **Waits for CI checks** — polls `mergeable_state` every 5 seconds for up to 60 seconds
4. **Auto-merges** using the configured method (`squash` / `merge` / `rebase`) if `AUTO_MERGE=true`

---

## Services

### VectorStoreService

`src/services/vector-store.js`

Provides semantic search over the target repository's source files without any external vector database.

**How it works:**

1. **Chunking:** every source file is split into ~1200-character chunks with 200-character overlap
2. **Embeddings:** uses [CodeBERT](https://huggingface.co/Xenova/codebert-base) (`@xenova/transformers`, ~90MB, downloaded once and cached locally) to generate 768-dimensional embedding vectors for each chunk
3. **Similarity search:** cosine similarity between the query embedding and all chunk embeddings; top-K results deduplicated by file path
4. **Persistence:** the index is saved as `.bugfix-agent/vector-index.json` inside the target repository — shared across runs

**TF-IDF fallback:**

If the CodeBERT model cannot be downloaded (network restrictions, air-gapped environments), the service automatically switches to an enhanced TF-IDF mode with:
- **3× weight for tokens that appear in the file path** (e.g. a query for "contact" will rank `ContactController.ts` higher)
- **camelCase/PascalCase decomposition** (`ContactController` → `contact`, `controller`)
- **5-character prefix matching** for cross-language cognates (`contato` ↔ `contact`, `clique` ↔ `click`)

The `scheduleBuild()` method accepts a `Promise<string[]>` so it can run asynchronously while the pipeline continues. `waitReady()` is called before any search to ensure the index is fully built.

---

### Context7Service

`src/services/context7.js`

Injects up-to-date framework documentation and best practices directly into the CodeAgent's LLM prompt.

**Why this matters:** LLMs have a training cutoff and may suggest outdated patterns. Context7 provides live documentation for the exact framework versions in use, so the generated code follows current best practices.

**How it works:**

1. The CodeAgent reads `STACK_BACKEND` and `STACK_FRONTEND` from the environment (e.g. `TypeScript/NestJS`, `Vue`)
2. `getBestPractices(frameworks, topic, tokensEach)` is called with the framework names and a topic derived from the bug type + suggested approach
3. For each framework, `resolveLibrary(name)` maps it to a Context7 library ID using a built-in lookup table (TypeScript, Express, Vue, React, Next.js, NestJS, Laravel, Django, FastAPI, Prisma, Mongoose, Jest, Vitest, and others — or via API search for unknown frameworks)
4. Docs are fetched from `https://context7.com/api/v1/{libraryId}?tokens=800&topic=...`
5. Results from up to 2 frameworks are concatenated and **capped at ~3000 characters** before being injected into the code generation prompt

**If Context7 is unavailable** or the framework is not found, the agent proceeds without best practices — it is entirely non-blocking.

To disable: set `CONTEXT7_ENABLED=false`.

To configure the token budget per library: `CONTEXT7_TOKENS=2500` (default).

---

### LLMService & Model Fallback

`src/orchestrator.js (LLMService class)`

All agents share a single `LLMService` instance. Each call passes the `agentName` so the correct model is selected.

```js
llm.call(agentName, systemPrompt, userPrompt, maxTokens)
```

**OpenRouter native fallback:**

Instead of implementing retry logic in the application, Fixei uses [OpenRouter](https://openrouter.ai)'s native `models[]` + `route: "fallback"` feature. The provider automatically tries the next model if the primary fails due to quota limits, rate limiting, or unavailability — zero retry code in the application.

```js
// What gets sent to OpenRouter:
{
  models: ["deepseek/deepseek-chat", "qwen/qwen2.5-coder-7b-instruct", "google/gemini-flash-1.5"],
  route: "fallback",
  max_tokens: 16384,
  messages: [...]
}
```

The array is limited to **3 models** (1 primary + 2 fallbacks) — the OpenRouter API limit.

**Per-agent model configuration:**

| Agent | Env Var (primary) | Default fallback chain |
|---|---|---|
| analysis | `MODEL_ANALYSIS` | `qwen/qwen2.5-coder-7b-instruct`, `google/gemini-flash-1.5` |
| code | `MODEL_CODE` | `deepseek/deepseek-chat`, `google/gemini-flash-1.5` |
| test | `MODEL_TEST` | `deepseek/deepseek-chat`, `google/gemini-flash-1.5` |
| ticket | `MODEL_TICKET` | `deepseek/deepseek-chat`, `qwen/qwen2.5-coder-7b-instruct` |
| documentation | `MODEL_DOCUMENTATION` | `qwen/qwen2.5-coder-7b-instruct`, `google/gemini-flash-1.5` |

Fallbacks are also configurable via env vars (comma-separated, no spaces):

```bash
MODEL_FALLBACKS_CODE=anthropic/claude-3-haiku,google/gemini-flash-1.5
```

If a fallback model is actually used, a `WARN` log entry records which model ran.

---

### GitHubService

`src/services/github.js`

Thin wrapper around the GitHub REST API v3. All calls use the `GITHUB_TOKEN` bearer token.

| Method | Description |
|---|---|
| `getFileContent(path)` | Reads a file from the default branch (base64 decode) |
| `createBranch(name)` | Resolves HEAD SHA → creates ref |
| `commitFile(branch, path, content, message)` | Create or update a file (fetches existing SHA for updates) |
| `listFiles(subPath?)` | Recursive tree listing → flat array of blob paths |
| `getWorkflowRun(runId)` | Fetches Actions workflow run data |
| `postAnalysisComment(issueNumber, analysis)` | Posts root cause + locations as a formatted issue comment |
| `postAuditComment(issueNumber, ctx)` | Posts full pipeline audit trail as an issue comment |

---

### StateManager

`src/services/state-manager.js`

Persists pipeline run state to `data/state.json` on disk (upsert by `runId`). Used by the REST API to serve `/api/runs`.

---

### NotificationService

`src/services/notification.js`

Sends Slack messages via incoming webhook. If `SLACK_WEBHOOK_URL` is not configured, messages are printed to stdout instead.

---

## Project Structure

```
fixei/
├── src/
│   ├── orchestrator.js           # Pipeline coordinator + LLMService
│   ├── agents/
│   │   ├── ticket-agent.js       # Parses & manages GitHub/Jira tickets
│   │   ├── analysis-agent.js     # Root cause analysis + file triage
│   │   ├── code-agent.js         # Fix generation + branch/commit
│   │   ├── test-agent.js         # Test generation + CI polling
│   │   ├── deploy-agent.js       # PR creation + auto-merge
│   │   └── documentation-agent.js# Codebase docs maintenance
│   ├── api/
│   │   ├── server.js             # Express server + webhook handlers
│   │   └── config.js             # Environment variable loader
│   └── services/
│       ├── github.js             # GitHub REST API wrapper
│       ├── vector-store.js       # CodeBERT / TF-IDF semantic index
│       ├── context7.js           # Framework best practices injection
│       ├── llm-utils.js          # Robust JSON extractor for LLM output
│       ├── state-manager.js      # Run state persistence (data/state.json)
│       ├── notification.js       # Slack notifications
│       └── logger.js             # ANSI-colored structured logger
├── tests/
│   ├── agents/                   # Unit tests for each agent
│   └── services/                 # Unit tests for each service
├── dashboard/
│   └── index.html                # Real-time monitoring dashboard (vanilla JS)
├── data/                         # Runtime state (auto-created, gitignored)
│   └── state.json
├── .env.example                  # Environment variable template
├── package.json
└── README.md
```

---

## Quick Start

### Prerequisites

- Node.js 20 or higher
- An [OpenRouter](https://openrouter.ai) account and API key
- A GitHub personal access token with `repo` and `workflow` scopes
- The **target repository** must have GitHub Actions configured with a CI workflow

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/danielplacido/fixei.git
cd fixei

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env with your credentials (see Configuration Reference below)

# 4. Start in development mode (auto-reload on file changes)
npm run dev
# → Server running at http://localhost:3000

# 5. Open the monitoring dashboard
# Open dashboard/index.html in your browser
```

### Trigger manually (no webhook needed)

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "ticket": {
      "id": "BUG-123",
      "title": "Contact form does not show validation errors",
      "description": "When submitting an empty contact form, no error message is displayed. The form silently fails and the user does not know what went wrong.",
      "stepsToReproduce": "1. Open Add Contact screen\n2. Click Save without filling in any fields",
      "expectedBehavior": "Show per-field validation error messages",
      "actualBehavior": "Form closes or stays open with no feedback",
      "rawLogs": "POST /contacts → 422 Unprocessable Entity"
    }
  }'
```

---

## Configuration Reference

### Required

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | API key from [openrouter.ai/keys](https://openrouter.ai/keys) |
| `GITHUB_TOKEN` | Personal access token — needs `repo` + `workflow` scopes |
| `GITHUB_REPO` | Target repository in `owner/repo` format |

### LLM Models

| Variable | Default | Description |
|---|---|---|
| `MODEL_ANALYSIS` | `anthropic/claude-3.5-sonnet` | Model for root cause analysis (heavier reasoning) |
| `MODEL_CODE` | `anthropic/claude-3.5-sonnet` | Model for code generation |
| `MODEL_TEST` | `anthropic/claude-3.5-sonnet` | Model for test generation |
| `MODEL_TICKET` | `anthropic/claude-3.5-sonnet` | Model for ticket parsing |
| `MODEL_DOCUMENTATION` | same as `MODEL_ANALYSIS` | Model for codebase docs generation |
| `MODEL_FALLBACKS_ANALYSIS` | `qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5` | Comma-separated fallback chain (max 2) |
| `MODEL_FALLBACKS_CODE` | `deepseek/deepseek-chat,google/gemini-flash-1.5` | |
| `MODEL_FALLBACKS_TEST` | `deepseek/deepseek-chat,google/gemini-flash-1.5` | |
| `MODEL_FALLBACKS_TICKET` | `deepseek/deepseek-chat,qwen/qwen2.5-coder-7b-instruct` | |
| `MODEL_FALLBACKS_DOCUMENTATION` | `qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5` | |

Browse available models at [openrouter.ai/models](https://openrouter.ai/models).

### Tech Stack (for Context7)

| Variable | Example | Description |
|---|---|---|
| `STACK_BACKEND` | `TypeScript/NestJS` | Backend language/framework — used to fetch best practices |
| `STACK_FRONTEND` | `Vue` | Frontend framework — used to fetch best practices |
| `CONTEXT7_ENABLED` | `true` | Set to `false` to disable Context7 best practice injection |
| `CONTEXT7_TOKENS` | `2500` | Max tokens fetched per library from Context7 |

### GitHub

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_BRANCH` | `main` | Branch the agent reads code from and creates fix branches off |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC secret for webhook signature verification (strongly recommended) |
| `TRIGGER_LABEL` | `ai-fix` | GitHub Issue label that activates the pipeline |
| `CI_WORKFLOW_ID` | `ci.yml` | Filename of the GitHub Actions workflow the agent triggers |
| `CI_TIMEOUT_MS` | `600000` | How long to wait for CI to complete (milliseconds) |
| `AUTO_MERGE` | `true` | Automatically merge the PR when CI passes |
| `MERGE_METHOD` | `squash` | `squash` / `merge` / `rebase` |
| `DEPLOY_ENV` | `production` | Label shown in notifications when merged |

### Pipeline Behavior

| Variable | Default | Description |
|---|---|---|
| `MAX_RETRIES` | `3` | Maximum fix attempts before escalating to a human |
| `COMMIT_TESTS` | `true` | Set to `false` to skip committing generated tests |

### Ticket Sources

| Variable | Default | Description |
|---|---|---|
| `TICKET_PROVIDER` | `github` | `github` or `jira` |
| `JIRA_BASE_URL` | — | e.g. `https://yourcompany.atlassian.net` |
| `JIRA_EMAIL` | — | Jira account email |
| `JIRA_TOKEN` | — | Jira API token |
| `JIRA_TRANSITION_DONE_ID` | `31` | Transition ID for "Done" status |

### Notifications

| Variable | Default | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | — | Incoming webhook URL for Slack notifications |
| `SLACK_CHANNEL` | `#engineering` | Channel name (informational only, set in the webhook itself) |

---

## Running in Production

### Option 1 — systemd (Linux VPS)

```ini
# /etc/systemd/system/fixei.service
[Unit]
Description=Fixei
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/fixei
EnvironmentFile=/opt/fixei/.env
ExecStart=/usr/bin/node src/api/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fixei
sudo journalctl -u fixei -f
```

### Option 2 — Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/api/server.js"]
```

```bash
docker build -t fixei .
docker run -d \
  --name fixei \
  --env-file .env \
  -p 3000:3000 \
  -v fixei-data:/app/data \
  fixei
```

### Option 3 — PM2

```bash
npm install -g pm2
pm2 start src/api/server.js --name fixei
pm2 save
pm2 startup
```

### Production checklist

- [ ] Set `GITHUB_WEBHOOK_SECRET` — the server verifies HMAC-SHA256 on every webhook
- [ ] The server must be publicly reachable by GitHub (use a reverse proxy like Nginx or expose with a tunnel like Cloudflare Tunnel for private networks)
- [ ] `data/` directory must be writable (state persistence and vector index cache)
- [ ] First run will download the CodeBERT model (~90MB) — pre-warm with: `node -e "import('./src/services/vector-store.js')"`
- [ ] Review `MAX_RETRIES` and `CI_TIMEOUT_MS` for your CI speed
- [ ] Set `STACK_BACKEND` and `STACK_FRONTEND` for optimal Context7 best practices injection

### Reverse proxy (Nginx example)

```nginx
server {
    listen 80;
    server_name fixei.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;  # long enough for CI polling
    }
}
```

---

## Webhook Setup

### GitHub

1. Go to your **target repository** → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://your-server.com/webhook/github`
3. **Content type:** `application/json`
4. **Secret:** same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
5. **Events:** select "Issues" only
6. Create the label `ai-fix` in your repository (Issues → Labels → New label)

Any issue with the `ai-fix` label added will trigger the pipeline automatically.

### Jira

1. Go to Jira → Settings → System → Webhooks → Create a WebHook
2. **URL:** `https://your-server.com/webhook/jira`
3. **Events:** Issue Created, Issue Updated
4. **Filter (optional):** `labels = "ai-fix"`

---

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check: `{ ok: true, ts: "..." }` |
| `POST` | `/webhook/github` | GitHub Issues webhook receiver |
| `POST` | `/webhook/jira` | Jira webhook receiver |
| `POST` | `/api/trigger` | Manual trigger: `{ ticket: {...} }` — synchronous, returns pipeline result |
| `GET` | `/api/runs` | List all runs (sorted by `updatedAt` desc) |
| `GET` | `/api/runs/:runId` | Full details of a specific run including audit log |

---

## Dashboard

Open `dashboard/index.html` directly in your browser (no build step required). It connects to `http://localhost:3000` by default.

**Features:**
- Live list of all pipeline runs with color-coded status (green = success, red = error, amber = running, purple = escalated)
- Per-run detail: full audit trail for every pipeline step, files changed, PR link, CI run link, failure details
- Auto-polling — updates in real time without manual refresh

---

## Running Tests

```bash
# Run all tests with coverage report
npm test

# Run without coverage (faster)
npm test -- --no-coverage

# Run a specific test file
npm test -- tests/agents/code-agent.test.js
```

The test suite covers all 6 agents and all services (13 test files, ~197 assertions). GitHub service and Express server are intentionally excluded from coverage as they require live API calls.

---

## Security Considerations

- **Webhook verification:** all GitHub webhooks are verified using HMAC-SHA256 (`crypto.timingSafeEqual`). Always set `GITHUB_WEBHOOK_SECRET`.
- **Token scope:** the GitHub token only needs `repo` + `workflow` scopes. Do not use a token with admin or org-wide permissions.
- **`.env` file:** never commit your `.env` file. It contains API keys. The `.gitignore` in this repository excludes it.
- **State file:** `data/state.json` may contain ticket titles and PR URLs. Keep the `data/` directory private.
- **LLM output:** generated code is committed to a branch and goes through CI before merge. The pipeline never pushes directly to the default branch.
- **Auto-merge:** if your CI is not comprehensive, set `AUTO_MERGE=false` and review PRs manually.
- **CORS:** the API has open CORS for the local dashboard. If you expose the API publicly, restrict CORS to known origins.
