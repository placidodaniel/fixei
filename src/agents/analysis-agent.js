/**
 * AnalysisAgent
 * Uses LLM (via OpenRouter) to read the codebase, reproduce the bug, and identify root cause.
 */

import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';
import { extractJson } from '../services/llm-utils.js';

export class AnalysisAgent {
  constructor(config, llm, github = null, vectorStore = null) {
    this.config = config;
    this.llm = llm;
    this.github = github ?? new GitHubService(config);
    this.vectorStore = vectorStore;
  }

  /**
   * Analyzes a parsed ticket.
   * Returns { confirmed, reason, rootCause, affectedFiles, suggestedApproach }
   */
  async analyze(ticket, codebaseDocs = '') {
    logger.info(`[AnalysisAgent] Analyzing ticket: ${ticket.id}`);

    // Fetch relevant code context from the repo
    const codeContext = await this._fetchCodeContext(ticket);

    const stack = this.config.stack ?? {};
    const stackInfo = `Backend: ${stack.backend ?? 'unknown'} | Frontend: ${stack.frontend ?? 'unknown'}`;

    const docsSection = codebaseDocs
      ? `\n\n--- CODEBASE DOCUMENTATION (architectural context) ---\n${codebaseDocs.slice(0, 6000)}\n--- END DOCUMENTATION ---`
      : '';

    const hasFrontend = (this.config.stack?.frontend ?? 'unknown') !== 'unknown';

    const system = `You are a senior software engineer performing root cause analysis on a full-stack application.
Stack: ${stackInfo}

This application has BOTH a backend AND a frontend. Bugs often span both layers:
- A missing error handler on the backend means the frontend never receives or shows the error message
- A UI bug may originate in a frontend component, a state management store, or the API call layer
- Always trace the full cycle: backend controller → service → frontend API call → component/store → UI render

Your job is to FIND THE BUG — locate the exact file and line where the problem occurs in EACH affected layer.
Do NOT say "insufficient context". Do NOT say "need more information".
${hasFrontend ? 'You MUST explicitly describe what needs to change in the BACKEND (backendChanges) AND what needs to change in the FRONTEND (frontendChanges) — even if one layer has no changes, explain why.' : ''}
Be direct, precise, and technical. Point to the exact code location in both backend and frontend when relevant.
Return ONLY valid JSON. No markdown, no explanation outside JSON.`;

    const userPrompt = `Bug report:
---
Title: ${ticket.title}
Description: ${ticket.description}
Steps to reproduce: ${ticket.stepsToReproduce?.join('\n') ?? 'Not provided'}
Expected: ${ticket.expectedBehavior}
Actual: ${ticket.actualBehavior}
Logs/Stack traces:
${ticket.rawLogs ?? 'None'}
Environment: ${JSON.stringify(ticket.environment)}
---${docsSection}

Source code from the repository (${stackInfo}):
${codeContext}
---

Analyze the code above and find the bug. Return JSON:
{
  "confirmed": true,
  "reason": "one sentence: what is failing and why",
  "rootCause": "precise technical explanation referencing the actual code — function name, variable, condition that is wrong",
  "codeLocations": [
    { "file": "path/to/file.ts", "line": 42, "layer": "backend|frontend", "description": "what is wrong on this line" }
  ],
  "affectedFiles": ["path/to/file.ts"],
  "affectedFunctions": ["functionName"],
  "bugType": "logic_error|null_reference|race_condition|config|dependency|other",
  "backendChanges": "REQUIRED — exact backend files and functions to change, or 'none' if backend is not involved",
  "frontendChanges": "REQUIRED — exact frontend files and functions/components to change, or 'none' if frontend is not involved",
  "suggestedApproach": "combined step-by-step fix instructions covering ALL affected layers (backend AND frontend)",
  "riskLevel": "low|medium|high",
  "estimatedComplexity": "simple|moderate|complex"
}

IMPORTANT: 'affectedFiles' MUST include BOTH backend AND frontend files that need changes.
If the bug cannot be confirmed from the code, still return confirmed: true with rootCause explaining what needs to be checked and where.`;

    const text = await this.llm.call('analysis', system, userPrompt, 4096);
    logger.info(`[AnalysisAgent] Raw LLM response: ${text?.slice(0, 300)}...`);

    try {
      const result = extractJson(text);
      logger.info(`[AnalysisAgent] Bug confirmed: ${result.confirmed}, type: ${result.bugType}`);

      // Post analysis comment on the GitHub issue
      const issueNumber = ticket._raw?.number;
      if (issueNumber) {
        await this.github.postAnalysisComment(issueNumber, result).catch(e =>
          logger.warn('[AnalysisAgent] Could not post GitHub comment: ' + e.message)
        );
      }

      return result;
    } catch (e) {
      logger.error('[AnalysisAgent] Failed to parse analysis response', e);
      return {
        confirmed: true,
        reason: 'Analysis could not be parsed; proceeding with fix attempt',
        rootCause: ticket.description,
        codeLocations: [],
        affectedFiles: [],
        suggestedApproach: 'Investigate the issue described in the ticket',
        bugType: 'other',
        riskLevel: 'medium',
        estimatedComplexity: 'moderate',
      };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Fetches relevant files from the repo based on ticket content.
   * When a vector index is available, uses semantic search instead of LLM triage rounds.
   * Falls back to LLM-based iterative rounds when the index is not ready.
   */
  async _fetchCodeContext(ticket) {
    try {
      // Step 1: get real file tree from the repo
      let allFiles = [];
      try {
        allFiles = await this.github.listFiles();
      } catch (e) {
        logger.warn('[AnalysisAgent] Could not list repo files: ' + e.message);
      }

      // Filter out files unlikely to contain bug logic
      const IGNORE = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|lock|min\.js|min\.css)$|node_modules|\.git|dist\/|build\/|migrations?\/|\.snap$|\.test\.|\.spec\./i;
      const relevantFiles = allFiles.filter(p => !IGNORE.test(p));

      logger.info(`[AnalysisAgent] Repo has ${allFiles.length} file(s), ${relevantFiles.length} relevant after filtering`);

      if (relevantFiles.length === 0) {
        return '(No relevant files found in repository)';
      }

      // Step 2: identify candidate files — via vector search (fast, $0) or LLM triage (fallback)
      const fetchedContents = {}; // path -> content

      // Se o índice ainda não está pronto mas o vectorStore existe,
      // dispara um build on-demand com os arquivos que já temos e aguarda.
      if (this.vectorStore && !this.vectorStore.isReady) {
        if (!this.vectorStore._buildPromise) {
          logger.info('[AnalysisAgent] Vector index missing — triggering on-demand build...');
          this.vectorStore.build(allFiles).catch(e =>
            logger.warn('[AnalysisAgent] On-demand vector build failed: ' + e.message)
          );
        }
        await this.vectorStore.waitReady();
      }

      if (this.vectorStore?.isReady) {
        // ── Vector-search path ──────────────────────────────────────────────
        // Embed the ticket and retrieve the top semantically-similar file chunks.
        // This replaces up to 4 LLM calls (3 triage rounds + 1 frontend pass).
        const query = [ticket.title, ticket.description, ticket.rawLogs].filter(Boolean).join('\n');
        logger.info('[AnalysisAgent] Using vector index for file triage...');
        const candidates = await this.vectorStore.searchPaths(query, 12);

        // Filter to paths that actually exist in the repo and haven't been fetched yet
        const toFetch = candidates.filter(p => relevantFiles.includes(p));
        logger.info(`[AnalysisAgent] Vector search selected ${toFetch.length} file(s): ${toFetch.join(', ')}`);

        const chunks = await Promise.allSettled(toFetch.map(p => this.github.getFileContent(p)));
        chunks.forEach((r, i) => {
          if (r.status === 'fulfilled') fetchedContents[toFetch[i]] = r.value;
          else logger.warn(`[AnalysisAgent] Failed to fetch ${toFetch[i]}: ${r.reason?.message}`);
        });

      } else {
        // ── LLM triage fallback (used when index has not been built yet) ────
        logger.info('[AnalysisAgent] Vector index not ready — falling back to LLM triage rounds...');

        const MAX_ROUNDS = 3;
        const FILES_PER_ROUND = 4;

        for (let round = 0; round < MAX_ROUNDS; round++) {
          const alreadyFetched = Object.keys(fetchedContents);
          const remaining = relevantFiles.filter(p => !alreadyFetched.includes(p));

          if (remaining.length === 0) break;

          // Build context from already-fetched files for LLM to reason about
          const currentContext = alreadyFetched.length > 0
            ? alreadyFetched.map(p => `// ${p}\n${fetchedContents[p]}`).join('\n\n---\n\n')
            : '(no files fetched yet)';

          const { backend, frontend } = this.config.stack ?? {};
          const stackHint = `Full-stack app — Backend: ${backend ?? 'unknown'}, Frontend: ${frontend ?? 'unknown'}. Investigate BOTH layers: follow the backend controller/service AND the frontend component/store/API call.`;

          const triagePrompt = round === 0
            ? `Bug: ${ticket.title}\n${ticket.description}\nLogs: ${ticket.rawLogs ?? ''}\n\n${stackHint}\n\nAvailable files (backend + frontend):\n${remaining.slice(0, 300).join('\n')}\n\nReturn a JSON array of up to ${FILES_PER_ROUND} file paths to start investigating. Include frontend files (components, views, pages, stores, composables, API service files) if the bug is UI-related or involves a missing error message shown to the user.`
            : `Bug: ${ticket.title}\n${ticket.description}\n\n${stackHint}\n\nFiles already read:\n${alreadyFetched.join('\n')}\n\nCode seen so far:\n${currentContext.slice(0, 4000)}\n\nAvailable files not yet read:\n${remaining.slice(0, 200).join('\n')}\n\nContinue tracing the bug across both layers. Return a JSON array of up to ${FILES_PER_ROUND} more paths (e.g. the frontend component that renders the error, the Pinia/Vuex store, the axios service call, the backend error handler). OR return [] if you have enough context.`;

          const triage = await this.llm.call(
            'analysis',
            `You are investigating a full-stack bug by reading source files. ${stackHint} Follow call chains across backend AND frontend like a senior developer would. Return ONLY a JSON array of file path strings from the provided list. No markdown.`,
            triagePrompt,
            512
          );

          let paths = [];
          try {
            const start = triage.indexOf('[');
            const end = triage.lastIndexOf(']');
            if (start !== -1 && end !== -1) {
              paths = JSON.parse(triage.slice(start, end + 1));
            }
          } catch (_) { paths = []; }

          const validPaths = paths.filter(p => relevantFiles.includes(p) && !alreadyFetched.includes(p));
          logger.info(`[AnalysisAgent] Round ${round + 1}: fetching ${validPaths.length} file(s): ${validPaths.join(', ')}`);

          if (validPaths.length === 0) {
            logger.info(`[AnalysisAgent] LLM has enough context after ${round + 1} round(s)`);
            break;
          }

          const chunks = await Promise.allSettled(
            validPaths.map(p => this.github.getFileContent(p))
          );

          chunks.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              fetchedContents[validPaths[i]] = r.value;
            } else {
              logger.warn(`[AnalysisAgent] Failed to fetch ${validPaths[i]}: ${r.reason?.message}`);
            }
          });
        }

        // ── Dedicated frontend pass ─────────────────────────────────────────────
        // When a frontend stack is configured, guarantee at least one frontend file
        // is investigated. The iterative rounds above tend to follow the backend
        // trail and stop — this pass forces the frontend layer to always be covered.
        const FRONTEND_PATH_RE = /(?:^|\/)(?:frontend|client|web)[/\\]|[/\\](?:components?|pages?|views?|stores?|composables?|hooks?)[/\\]/i;
        const { frontend: frontendStack } = this.config.stack ?? {};
        if (frontendStack && frontendStack !== 'unknown') {
          const fetchedPaths = Object.keys(fetchedContents);
          const hasFrontend = fetchedPaths.some(p => FRONTEND_PATH_RE.test(p) || /\.(vue|jsx|tsx)$/.test(p));

          if (!hasFrontend) {
            logger.info('[AnalysisAgent] No frontend files fetched — running dedicated frontend pass...');
            const frontendPool = relevantFiles.filter(
              p => (FRONTEND_PATH_RE.test(p) || /\.(vue|jsx|tsx)$/.test(p)) && !fetchedPaths.includes(p)
            );

            if (frontendPool.length > 0) {
              const backendContext = fetchedPaths
                .map(p => `// ${p}\n${fetchedContents[p]}`)
                .join('\n\n---\n\n');

              const frontendTriage = await this.llm.call(
                'analysis',
                `You are investigating a full-stack bug. The backend has been analyzed. Now identify which frontend files (components, pages, views, stores, composables, API service files) are most likely involved. Return ONLY a JSON array of file paths from the provided list. No markdown.`,
                `Bug: ${ticket.title}\n${ticket.description}\nLogs: ${ticket.rawLogs ?? ''}\n\n` +
                `Backend code already analyzed:\n${backendContext.slice(0, 2500)}\n\n` +
                `Available frontend files:\n${frontendPool.slice(0, 200).join('\n')}\n\n` +
                `Return a JSON array of up to ${FILES_PER_ROUND} frontend file paths most likely involved in this bug.`,
                512
              );

              let frontendPaths = [];
              try {
                const fs = frontendTriage.indexOf('[');
                const fe = frontendTriage.lastIndexOf(']');
                if (fs !== -1 && fe !== -1) frontendPaths = JSON.parse(frontendTriage.slice(fs, fe + 1));
              } catch (_) { frontendPaths = []; }

              const validFrontend = frontendPaths.filter(p => relevantFiles.includes(p) && !fetchedPaths.includes(p));
              logger.info(`[AnalysisAgent] Frontend pass: fetching ${validFrontend.length} file(s): ${validFrontend.join(', ')}`);

              const frontendChunks = await Promise.allSettled(validFrontend.map(p => this.github.getFileContent(p)));
              frontendChunks.forEach((r, idx) => {
                if (r.status === 'fulfilled') fetchedContents[validFrontend[idx]] = r.value;
                else logger.warn(`[AnalysisAgent] Failed to fetch ${validFrontend[idx]}: ${r.reason?.message}`);
              });
            }
          } else {
            logger.info(`[AnalysisAgent] Frontend files already covered: ${Object.keys(fetchedContents).filter(p => FRONTEND_PATH_RE.test(p) || /\.(vue|jsx|tsx)$/.test(p)).join(', ')}`);
          }
        }
      } // end LLM triage fallback else-block
      // ─────────────────────────────────────────────────────────────────────────

      const totalFetched = Object.keys(fetchedContents).length;
      logger.info(`[AnalysisAgent] Investigation complete — ${totalFetched} file(s) fetched`);

      if (totalFetched === 0) {
        return '(No code context fetched)';
      }

      return Object.entries(fetchedContents)
        .map(([path, content]) => `// File: ${path}\n${content}`)
        .join('\n\n---\n\n');

    } catch (e) {
      logger.warn('[AnalysisAgent] Could not fetch code context: ' + e.message);
      return '(Code context unavailable)';
    }
  }
}
