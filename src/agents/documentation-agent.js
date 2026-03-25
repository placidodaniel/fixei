/**
 * DocumentationAgent
 *
 * Maintains two documentation files inside the target repo:
 *   .bugfix-agent/BACKEND.md   — backend architecture, routes, services, models
 *   .bugfix-agent/FRONTEND.md  — frontend routing, stores, API layer, components
 *
 * Lifecycle:
 *   1. If a file does not exist  → generate from scratch
 *   2. If stale for current ticket → update only the relevant layer
 *   3. Otherwise                   → return cached content
 *
 * Both docs are injected into the AnalysisAgent prompt so the LLM
 * has full architectural context before reasoning about a bug.
 */

import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';

const BACKEND_DOC_PATH = '.bugfix-agent/BACKEND.md';
const FRONTEND_DOC_PATH = '.bugfix-agent/FRONTEND.md';
const DOC_MAX_TOKENS = 6000;

// Priority files to read when generating backend docs
const BACKEND_PRIORITY = [
    'package.json', 'composer.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
    'requirements.txt', 'README.md', '.env.example',
];

// Priority files to read when generating frontend docs
const FRONTEND_PRIORITY = [
    'frontend/package.json',
    'frontend/src/main.ts', 'frontend/src/main.js',
    'frontend/src/App.vue', 'frontend/src/App.tsx', 'frontend/src/App.jsx',
    'frontend/src/router/index.ts', 'frontend/src/router/index.js',
    'frontend/src/store/index.ts', 'frontend/src/store/index.js',
    'frontend/src/stores/index.ts',
    'src/router/index.ts', 'src/router/index.js',
    'src/main.ts', 'src/main.js',
    'src/App.vue', 'src/App.tsx',
];

// Files that identify route/controller/handler files (backend + frontend routers/pages)
const ROUTE_REGEX = /routes?[/.]|controllers?[/.]|router\.|\-routes?\.|handlers?[/.]|endpoints?[/.]|[\\/]pages[\\/]|[\\/]views[\\/]|router[\\/]index\.|App\.(jsx?|tsx?|vue)$|main\.(jsx?|tsx?)$/i;

// Source file extensions worth documenting
const SOURCE_EXT = /\.(js|ts|mjs|cjs|jsx|tsx|vue|php|py|rb|go|java|cs|rs)$/i;

// Paths that belong to the frontend layer
const FRONTEND_PATH_REGEX = /(?:^|\/)(?:frontend|client|web)[/\\]|[/\\](?:components?|pages?|views?|stores?|composables?|hooks?)[/\\]/i;

// Paths to ignore entirely
const IGNORE = /node_modules|\.git|dist[/\\]|build[/\\]|migrations?[/\\]|\.snap$|\.test\.|\.spec\.|\.min\.|assets[/\\]|public[/\\]/i;

// Ratio of ticket tokens that must be absent from docs to trigger an update
const UPDATE_THRESHOLD = 0.30;

export class DocumentationAgent {
    constructor(config, llm, github = null, vectorStore = null) {
        this.config = config;
        this.llm = llm;
        this.github = github ?? new GitHubService(config);
        this.vectorStore = vectorStore;
        this._cacheBackend = null;
        this._cacheFrontend = null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Ensure both BACKEND.md and FRONTEND.md are current for the given ticket.
     * Commits changes to the repo automatically.
     * Returns a combined documentation string.
     */
    async ensureDocumented(ticket) {
        logger.info('[DocAgent] Checking documentation status...');

        let existingBackend = null;
        let existingFrontend = null;

        try { existingBackend = await this.github.getFileContent(BACKEND_DOC_PATH); } catch { /* not yet created */ }
        try { existingFrontend = await this.github.getFileContent(FRONTEND_DOC_PATH); } catch { /* not yet created */ }

        // Generate missing documents
        if (!existingBackend) {
            logger.info('[DocAgent] No BACKEND.md found — generating from scratch...');
            existingBackend = await this._generateBackend();
            await this._save(BACKEND_DOC_PATH, existingBackend, 'docs: generate BACKEND.md [skip ci]');
        }

        if (!existingFrontend) {
            logger.info('[DocAgent] No FRONTEND.md found — generating from scratch...');
            existingFrontend = await this._generateFrontend();
            await this._save(FRONTEND_DOC_PATH, existingFrontend, 'docs: generate FRONTEND.md [skip ci]');
        }

        // Update stale documents
        if (await this._needsUpdate(existingBackend + existingFrontend, ticket)) {
            const allFiles = await this.github.listFiles();
            const ticketText = `${ticket.title ?? ''} ${ticket.description ?? ''}`.toLowerCase();

            const backendFiles = this._filterBackendFiles(allFiles, ticketText);
            const frontendFiles = this._filterFrontendFiles(allFiles, ticketText);

            if (backendFiles.length > 0) {
                existingBackend = await this._updateDoc(existingBackend, ticket, backendFiles, 'backend');
                await this._save(BACKEND_DOC_PATH, existingBackend, 'docs: update BACKEND.md [skip ci]');
            }

            if (frontendFiles.length > 0) {
                existingFrontend = await this._updateDoc(existingFrontend, ticket, frontendFiles, 'frontend');
                await this._save(FRONTEND_DOC_PATH, existingFrontend, 'docs: update FRONTEND.md [skip ci]');
            }
        } else {
            logger.info('[DocAgent] Documentation is up to date.');
        }

        this._cacheBackend = existingBackend;
        this._cacheFrontend = existingFrontend;

        // Agenda rebuild do índice vetorial — scheduleBuild() armazena a promise da cadeia
        // completa (listFiles + build) para que o orchestrator possa aguardar via waitReady().
        if (this.vectorStore) {
            this.vectorStore.scheduleBuild(this.github.listFiles());
        }

        return this._combined();
    }

    /**
     * Return cached docs after ensureDocumented() has been called.
     */
    getDoc() {
        return this._combined();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _combined() {
        const parts = [];
        if (this._cacheBackend) parts.push(this._cacheBackend);
        if (this._cacheFrontend) parts.push(this._cacheFrontend);
        return parts.join('\n\n---\n\n');
    }

    async _generateBackend() {
        const allFiles = await this.github.listFiles();
        const relevant = allFiles.filter(p => !IGNORE.test(p) && !FRONTEND_PATH_REGEX.test(p));

        const routeFiles = relevant.filter(p => ROUTE_REGEX.test(p) && SOURCE_EXT.test(p));
        const sourceFiles = relevant.filter(p => SOURCE_EXT.test(p) && !ROUTE_REGEX.test(p));

        const toRead = [
            ...new Set([...BACKEND_PRIORITY, ...routeFiles, ...sourceFiles]),
        ].slice(0, 35);

        logger.info(`[DocAgent] Reading ${toRead.length} backend files...`);
        const codeContext = await this._readFiles(toRead);

        const { backend } = this.config.stack ?? {};
        const fileTree = relevant
            .filter(p => SOURCE_EXT.test(p))
            .slice(0, 400)
            .map(f => `- [${f}](${f})`)
            .join('\n');

        const system =
            `You are a senior backend engineer writing internal technical documentation for AI agents.\n` +
            `The AI agents will read this documentation to understand the codebase when debugging bugs.\n` +
            `Being detailed, precise, and complete is CRITICAL — a missing detail can cause a bug to go unfixed.\n` +
            `Rules:\n` +
            `- Include the EXACT file path for every module, route, function, and model mentioned.\n` +
            `- Format every file path as a markdown link: [path/to/file.ts](path/to/file.ts)\n` +
            `- List ALL routes, ALL exported functions, ALL model fields — do not summarize or truncate.\n` +
            `- Write ALL 11 sections in order. NEVER skip a section, even if it has no content (write "N/A").\n` +
            `- Return ONLY the Markdown documentation, starting with # BACKEND DOCUMENTATION.`;

        const userPrompt =
            `Generate complete backend documentation for this project.\n\n` +
            `Backend stack: ${backend ?? 'unknown'}\n` +
            `Total source files: ${relevant.length}\n` +
            `Route/controller files detected: ${routeFiles.map(f => `[${f}](${f})`).join(', ') || 'none'}\n\n` +
            `--- Key files with full content ---\n${codeContext}\n\n` +
            `--- Full backend file tree ---\n${fileTree}\n\n` +
            `---\n` +
            `Write the documentation with EXACTLY these 11 sections, starting from section 1:\n\n` +
            `# BACKEND DOCUMENTATION\n` +
            `> Auto-generated by BugFix Agent — ${new Date().toISOString()}\n\n` +
            `## 1. Project Overview\n` +
            `What the system does, its domain, main business workflow, and target users.\n\n` +
            `## 2. Tech Stack\n` +
            `- Language and version\n` +
            `- Framework (with version from package.json)\n` +
            `- ORM / query builder\n` +
            `- Database engine\n` +
            `- Cache layer\n` +
            `- Queue / async jobs\n` +
            `- Test runner\n` +
            `- Build tool\n\n` +
            `## 3. Project Structure\n` +
            `Every top-level directory and its purpose. Format each as:\n` +
            `- \`directory/\` — description. Key files: [file.ts](file.ts), [other.ts](other.ts)\n\n` +
            `## 4. Entry Points & Bootstrapping\n` +
            `- Main entry file: [server.ts](server.ts)\n` +
            `- Startup sequence step by step\n` +
            `- Middleware chain (name — file — purpose), in registration order\n\n` +
            `## 5. Routes & HTTP API\n` +
            `For EVERY route file found, use this format:\n` +
            `### [path/to/routes.ts](path/to/routes.ts) | Base prefix: \`/api/v1\`\n` +
            `| Method | Path | Handler | Description |\n` +
            `|--------|------|---------|-------------|\n` +
            `| GET | /endpoint | \`handlerFn()\` | What it does |\n` +
            `| POST | /endpoint | \`handlerFn()\` | What it does |\n\n` +
            `## 6. Services & Modules\n` +
            `For each service or module file:\n` +
            `### [path/to/service.ts](path/to/service.ts)\n` +
            `Purpose: one sentence.\n` +
            `- \`functionName(param: type): returnType\` — what it does\n` +
            `- \`otherFunction(param: type): returnType\` — what it does\n\n` +
            `## 7. Data Models\n` +
            `ORM/ODM used. For each model:\n` +
            `### ModelName — [path/to/model.ts](path/to/model.ts) | table: \`table_name\`\n` +
            `| Field | Type | Constraints | Description |\n` +
            `|-------|------|-------------|-------------|\n` +
            `| id | uuid | PK | Primary key |\n` +
            `Relations: \`hasMany OtherModel\`, \`belongsTo ParentModel\`\n\n` +
            `## 8. External Integrations\n` +
            `For each external API, webhook, or service:\n` +
            `- **Service name** — [path/to/integration.ts](path/to/integration.ts)\n` +
            `  - Purpose, credentials env vars, how/when called\n\n` +
            `## 9. Authentication & Authorization\n` +
            `- Auth strategy (JWT / session / OAuth / API key)\n` +
            `- Middleware file: [auth.middleware.ts](path/to/middleware.ts)\n` +
            `- How tokens are issued, validated, and refreshed\n` +
            `- Role/permission system and where it is enforced\n\n` +
            `## 10. Error Handling\n` +
            `- Global error handler: [error.handler.ts](path/to/handler.ts)\n` +
            `- Error response JSON shape: \`{ status, message, code }\`\n` +
            `- HTTP status codes used per error type\n` +
            `- Business errors vs. unexpected errors\n\n` +
            `## 11. Environment Variables\n` +
            `| Variable | Purpose | Default |\n` +
            `|----------|---------|--------|\n` +
            `| VAR_NAME | description | value |`;

        logger.info('[DocAgent] Calling LLM to generate backend documentation...');
        const doc = await this.llm.call('documentation', system, userPrompt, DOC_MAX_TOKENS);
        logger.info('[DocAgent] Backend documentation generated.');
        return doc;
    }

    async _generateFrontend() {
        const allFiles = await this.github.listFiles();

        // Files that belong to the frontend layer
        const relevant = allFiles.filter(p => !IGNORE.test(p) && FRONTEND_PATH_REGEX.test(p));

        // Fallback: if no explicit frontend/ directory, include all .vue/.jsx/.tsx files
        const allFrontendFiles = relevant.length > 0
            ? relevant
            : allFiles.filter(p => !IGNORE.test(p) && SOURCE_EXT.test(p) && /\.(vue|jsx|tsx)$/.test(p));

        const routeFiles = allFrontendFiles.filter(p => ROUTE_REGEX.test(p) && SOURCE_EXT.test(p));
        const componentFiles = allFrontendFiles.filter(p => /[/\\](components?|pages?|views?)[/\\]/i.test(p) && SOURCE_EXT.test(p));
        const storeFiles = allFrontendFiles.filter(p => /[/\\](stores?|vuex|redux)[/\\]/i.test(p) && SOURCE_EXT.test(p));
        const serviceFiles = allFrontendFiles.filter(p => /[/\\](services?|api|http)[/\\]/i.test(p) && SOURCE_EXT.test(p));
        const composableFiles = allFrontendFiles.filter(p => /[/\\](composables?|hooks?)[/\\]/i.test(p) && SOURCE_EXT.test(p));

        const toRead = [
            ...new Set([
                ...FRONTEND_PRIORITY,
                ...routeFiles,
                ...storeFiles,
                ...serviceFiles,
                ...composableFiles,
                ...componentFiles.slice(0, 10),
            ]),
        ].slice(0, 35);

        logger.info(`[DocAgent] Reading ${toRead.length} frontend files...`);
        const codeContext = await this._readFiles(toRead);

        const { frontend } = this.config.stack ?? {};
        const fileTree = allFrontendFiles
            .slice(0, 400)
            .map(f => `- [${f}](${f})`)
            .join('\n');

        const system =
            `You are a senior frontend engineer writing internal technical documentation for AI agents.\n` +
            `The AI agents will read this documentation to understand the codebase when debugging bugs.\n` +
            `Being detailed, precise, and complete is CRITICAL — a missing detail can cause a bug to go unfixed.\n` +
            `Rules:\n` +
            `- Include the EXACT file path for every component, store, composable, and service mentioned.\n` +
            `- Format every file path as a markdown link: [ComponentName.vue](path/to/Component.vue)\n` +
            `- List ALL routes, ALL store actions/getters, ALL API functions — do not summarize or truncate.\n` +
            `- Write ALL 11 sections in order. NEVER skip a section, even if it has no content (write "N/A").\n` +
            `- Return ONLY the Markdown documentation, starting with # FRONTEND DOCUMENTATION.`;

        const userPrompt =
            `Generate complete frontend documentation for this project.\n\n` +
            `Frontend stack: ${frontend ?? 'unknown'}\n` +
            `Total frontend files: ${allFrontendFiles.length}\n` +
            `Router files: ${routeFiles.map(f => `[${f}](${f})`).join(', ') || 'none'}\n` +
            `Store files: ${storeFiles.map(f => `[${f}](${f})`).join(', ') || 'none'}\n` +
            `API service files: ${serviceFiles.map(f => `[${f}](${f})`).join(', ') || 'none'}\n` +
            `Composable files: ${composableFiles.map(f => `[${f}](${f})`).join(', ') || 'none'}\n\n` +
            `--- Key files with full content ---\n${codeContext}\n\n` +
            `--- Full frontend file tree ---\n${fileTree}\n\n` +
            `---\n` +
            `Write the documentation with EXACTLY these 11 sections, starting from section 1:\n\n` +
            `# FRONTEND DOCUMENTATION\n` +
            `> Auto-generated by BugFix Agent — ${new Date().toISOString()}\n\n` +
            `## 1. Overview\n` +
            `What the frontend does, its purpose, main features and screens.\n\n` +
            `## 2. Tech Stack\n` +
            `- Framework and version\n` +
            `- UI component library\n` +
            `- State management library\n` +
            `- HTTP client\n` +
            `- Build tool (Vite/Webpack)\n` +
            `- Test runner\n\n` +
            `## 3. Project Structure\n` +
            `Every top-level directory and its purpose. Format each as:\n` +
            `- \`directory/\` — description. Key files: [Component.vue](path/file.vue)\n\n` +
            `## 4. Entry Point & App Bootstrap\n` +
            `- Main entry file: [main.ts](path/main.ts)\n` +
            `- How the app mounts (createApp / ReactDOM.render)\n` +
            `- Global plugins registered (name — file — purpose), in order\n\n` +
            `## 5. Routing\n` +
            `- Router file: [router/index.ts](path/router/index.ts)\n` +
            `- Route guard logic (auth guard, etc.) — file and logic description\n` +
            `- For every route:\n` +
            `  | Path | Component | Auth Required | Description |\n` +
            `  |------|-----------|---------------|-------------|\n` +
            `  | /path | [Page.vue](path/Page.vue) | yes/no | screen description |\n\n` +
            `## 6. State Management\n` +
            `State engine: Pinia / Vuex / Redux / Zustand\n` +
            `For each store/module:\n` +
            `### StoreName — [path/to/store.ts](path/to/store.ts)\n` +
            `State:\n` +
            `| Field | Type | Initial Value | Purpose |\n` +
            `|-------|------|---------------|--------|\n` +
            `Actions:\n` +
            `- \`actionName(payload)\` — what it does, API call made (if any)\n` +
            `Getters:\n` +
            `- \`getterName\` — computed value returned\n\n` +
            `## 7. API Layer\n` +
            `- HTTP client file: [services/api.ts](path/services/api.ts)\n` +
            `- Base URL and how it is configured\n` +
            `- How auth token is attached (Authorization header, interceptor)\n` +
            `- Request interceptors: what they do\n` +
            `- Response interceptors: how errors are caught (401 redirect, token refresh, etc.)\n` +
            `For each API module/service file:\n` +
            `### [api/module.ts](path/api/module.ts)\n` +
            `- \`functionName(params): Promise<ReturnType>\` → \`METHOD /endpoint\` — what it returns\n\n` +
            `## 8. Key Components & Pages\n` +
            `For each important component or page:\n` +
            `### [ComponentName.vue](path/ComponentName.vue)\n` +
            `- **Purpose**: what it renders/does\n` +
            `- **Props**: \`propName: type\` — description\n` +
            `- **Emits**: \`event-name\` — when fired\n` +
            `- **Stores used**: StoreName — why\n` +
            `- **API calls**: which service functions are called\n\n` +
            `## 9. Composables & Utilities\n` +
            `For each composable or utility file:\n` +
            `### [useXxx.ts](path/composable.ts)\n` +
            `- **Purpose**: one sentence\n` +
            `- **Params**: \`param: type\`\n` +
            `- **Returns**: \`{ field: type }\`\n\n` +
            `## 10. Error Handling & User Feedback\n` +
            `- How API errors are caught (try/catch, interceptor, error boundary)\n` +
            `- How errors are shown to the user: toast / modal / inline message\n` +
            `- File responsible for displaying errors: [ErrorHandler.vue](path/file.vue)\n` +
            `- What happens on network failure vs. 4xx vs. 5xx\n\n` +
            `## 11. Environment Variables\n` +
            `| Variable | Purpose | Used In |\n` +
            `|----------|---------|--------|\n` +
            `| VITE_VAR_NAME | description | [file.ts](path/file.ts) |`;

        logger.info('[DocAgent] Calling LLM to generate frontend documentation...');
        const doc = await this.llm.call('documentation', system, userPrompt, DOC_MAX_TOKENS);
        logger.info('[DocAgent] Frontend documentation generated.');
        return doc;
    }

    async _needsUpdate(doc, ticket) {
        const ticketText = `${ticket.title ?? ''} ${ticket.description ?? ''} ${ticket.rawLogs ?? ''}`.toLowerCase();
        const tokens = [
            ...new Set((ticketText.match(/\b[a-z_][a-z0-9_]{4,}\b/g) ?? [])),
        ].slice(0, 30);

        if (tokens.length === 0) return false;

        const missing = tokens.filter(t => !doc.toLowerCase().includes(t));
        const ratio = missing.length / tokens.length;

        if (ratio > UPDATE_THRESHOLD) {
            logger.info(
                `[DocAgent] ${missing.length}/${tokens.length} ticket terms absent from docs ` +
                `(${(ratio * 100).toFixed(0)}% > ${UPDATE_THRESHOLD * 100}% threshold) → update needed. ` +
                `Missing: ${missing.slice(0, 8).join(', ')}`
            );
            return true;
        }

        return false;
    }

    _filterBackendFiles(allFiles, ticketText) {
        return allFiles
            .filter(p => !IGNORE.test(p) && SOURCE_EXT.test(p) && !FRONTEND_PATH_REGEX.test(p))
            .filter(p => {
                const base = p.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
                return ticketText.includes(base) || ROUTE_REGEX.test(p);
            })
            .slice(0, 15);
    }

    _filterFrontendFiles(allFiles, ticketText) {
        return allFiles
            .filter(p => !IGNORE.test(p) && SOURCE_EXT.test(p) && FRONTEND_PATH_REGEX.test(p))
            .filter(p => {
                const base = p.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
                return ticketText.includes(base)
                    || ROUTE_REGEX.test(p)
                    || /[/\\](components?|pages?|views?|stores?)[/\\]/i.test(p);
            })
            .slice(0, 15);
    }

    async _updateDoc(existing, ticket, files, layer) {
        const newCode = await this._readFiles(files);

        const system =
            `You are maintaining internal technical ${layer} documentation used by AI agents for debugging.\n` +
            `Update only sections that are missing context about modules referenced in the current ticket.\n` +
            `Rules:\n` +
            `- Return the COMPLETE updated documentation — all existing sections PLUS additions.\n` +
            `- NEVER remove or shorten existing content.\n` +
            `- If sections 1-5 are missing from the existing doc, reconstruct them from context clues.\n` +
            `- Format every file path as a markdown link: [path/to/file.ts](path/to/file.ts)`;

        const userPrompt =
            `Current documentation:\n---\n${existing}\n---\n\n` +
            `Bug ticket:\nTitle: ${ticket.title}\nDescription: ${ticket.description}\n\n` +
            `Newly read files related to this ticket:\n${newCode || '(none found)'}\n\n` +
            `Instructions:\n` +
            `1. ADD or EXPAND sections missing context about files/functions in this ticket.\n` +
            `2. NEVER remove existing content.\n` +
            `3. Ensure ALL sections from 1 onward are present — reconstruct any missing early sections.\n` +
            `4. Append a "## Last Updated" section at the end noting what was added and why.\n` +
            `5. Return the COMPLETE documentation.`;

        const updated = await this.llm.call('documentation', system, userPrompt, DOC_MAX_TOKENS);
        logger.info(`[DocAgent] ${layer} documentation updated.`);
        return updated;
    }

    async _readFiles(paths) {
        const results = await Promise.allSettled(
            paths.map(async p => {
                try {
                    const content = await this.github.getFileContent(p);
                    return `### [${p}](${p})\n\`\`\`\n${content.slice(0, 2500)}\n\`\`\``;
                } catch {
                    return null;
                }
            })
        );
        return results
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value)
            .join('\n\n');
    }

    async _save(path, content, message) {
        try {
            await this.github.commitFile(
                this.config.defaultBranch,
                path,
                content,
                message
            );
            logger.info(`[DocAgent] Saved to ${path}`);
        } catch (e) {
            logger.warn(`[DocAgent] Could not commit ${path}: ` + e.message);
        }
    }
}
