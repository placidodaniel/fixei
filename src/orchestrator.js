/**
 * BugFix Agent - Orchestrator
 * Coordinates all agents in the autonomous bug fix pipeline
 */

import { TicketAgent } from './agents/ticket-agent.js';
import { AnalysisAgent } from './agents/analysis-agent.js';
import { CodeAgent } from './agents/code-agent.js';
import { TestAgent } from './agents/test-agent.js';
import { DeployAgent } from './agents/deploy-agent.js';
import { DocumentationAgent } from './agents/documentation-agent.js';
import { NotificationService } from './services/notification.js';
import { StateManager } from './services/state-manager.js';
import { GitHubService } from './services/github.js';
import { VectorStoreService } from './services/vector-store.js';
import { logger } from './services/logger.js';

/**
 * Shared LLM service for all agents.
 */
// Rough token estimator: 1 token ≈ 4 chars for English/code (conservative).
// Good enough for budget checks; no external dep required.
function _estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}

class LLMService {
  constructor(config) {
    this.config = config;
    // modelMeta[modelId] = { contextLength: number } — populated by validateModels()
    this._modelMeta = {};
  }

  async call(agentName, system, userPrompt, maxTokens = 1024) {
    const primary = this.config.models[agentName];
    const isOllama = this.config.llmProvider === 'ollama';

    const url = isOllama
      ? `${this.config.ollamaBaseUrl}/v1/chat/completions`
      : 'https://openrouter.ai/api/v1/chat/completions';

    const headers = {
      'Content-Type': 'application/json',
      ...(!isOllama && {
        'Authorization': `Bearer ${this.config.openRouterApiKey}`,
        'HTTP-Referer': 'https://bugfix-agent.local',
        'X-Title': 'Fixei',
      }),
    };

    const body = {
      model: primary,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    };

    // ── Context-length guard ──────────────────────────────────────────────────
    const meta = this._modelMeta[primary];
    if (meta?.contextLength) {
      const MARGIN = 256; // reserve tokens for roles/formatting overhead
      const inputTokens = _estimateTokens(system) + _estimateTokens(userPrompt) + MARGIN;
      const available = meta.contextLength - inputTokens;
      if (available <= 0) {
        const err = new Error(
          `[LLM] Model "${primary}" context limit exceeded for agent "${agentName}": ` +
          `context_length=${meta.contextLength}, estimated input=${inputTokens} tokens. ` +
          `Choose a model with a larger context window or reduce the prompt.`
        );
        err.isLLMConfigError = true;
        throw err;
      }
      // Cap max_tokens to what the context window can actually fit
      body.max_tokens = Math.min(maxTokens, available);
      if (body.max_tokens < maxTokens) {
        logger.warn(
          `[LLM] "${primary}" (agent: ${agentName}): capping max_tokens ` +
          `from ${maxTokens} → ${body.max_tokens} (context_length=${meta.contextLength}, ` +
          `estimated input=${inputTokens} tokens)`
        );
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const provider = isOllama ? 'Ollama' : 'OpenRouter';
      const err = new Error(`${provider} API error: ${response.status} - ${errorBody}`);
      // Auth failures and invalid model IDs are config errors — agents must not swallow them.
      if (response.status === 401 || response.status === 403 ||
        (response.status === 400 && errorBody.includes('not a valid model'))) {
        err.isLLMConfigError = true;
      }
      throw err;
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason;

    // Detect truncation before checking content
    if (finishReason === 'length') {
      const meta = this._modelMeta[primary];
      const ctxInfo = meta?.contextLength ? ` (model context_length: ${meta.contextLength} tokens)` : '';
      throw new Error(
        `[LLM] Model "${primary}" (agent: ${agentName}) ran out of output tokens — ` +
        `finish_reason=length${ctxInfo}. ` +
        `The prompt is too large for this model. Use a model with a larger context window, ` +
        `reduce the number of files sent, or lower CONTEXT7_TOKENS.`
      );
    }

    const content = choice?.message?.content;
    if (content == null) {
      const provider = isOllama ? 'Ollama' : 'OpenRouter';
      throw new Error(`${provider} returned empty content — model may have refused or been rate-limited. finish_reason=${finishReason ?? 'unknown'}, choices: ${JSON.stringify(data.choices ?? data).slice(0, 300)}`);
    }
    return content;
  }

  /**
   * Validates all configured model IDs against the provider's model list.
   * Throws on invalid model IDs; warns (non-blocking) on network errors.
   */
  async validateModels() {
    const isOllama = this.config.llmProvider === 'ollama';
    const url = isOllama
      ? `${this.config.ollamaBaseUrl}/v1/models`
      : 'https://openrouter.ai/api/v1/models';
    const headers = {
      'Content-Type': 'application/json',
      ...(!isOllama && { 'Authorization': `Bearer ${this.config.openRouterApiKey}` }),
    };

    let resp;
    try {
      resp = await fetch(url, { method: 'GET', headers });
    } catch (e) {
      logger.warn(`[LLM] Could not reach ${isOllama ? 'Ollama' : 'OpenRouter'} to validate models: ${e.message}`);
      return;
    }
    if (!resp.ok) {
      logger.warn(`[LLM] Model validation skipped (HTTP ${resp.status})`);
      return;
    }

    const data = await resp.json();
    const modelList = data.data ?? [];
    const byId = Object.fromEntries(modelList.map(m => [m.id, m]));
    const availableIds = new Set(modelList.map(m => m.id));

    // Cache context_length for each configured model (used in call() to cap max_tokens)
    for (const [, modelId] of Object.entries(this.config.models)) {
      if (modelId && byId[modelId]?.context_length) {
        this._modelMeta[modelId] = { contextLength: byId[modelId].context_length };
      }
    }

    const allModels = Object.entries(this.config.models);

    const invalid = allModels.filter(([, id]) => id && !availableIds.has(id));
    if (invalid.length > 0) {
      const list = invalid.map(([agent, id]) => `  - "${id}" (${agent})`).join('\n');
      const ref = isOllama ? 'run `ollama list` to see available models' : 'see https://openrouter.ai/models';
      throw new Error(`[LLM] Invalid model IDs configured:\n${list}\n\nFix your .env file — ${ref}`);
    }
    const metaSummary = Object.entries(this.config.models)
      .map(([agent, id]) => {
        const ctx = this._modelMeta[id]?.contextLength;
        return `${agent}=${id}${ctx ? ` (${(ctx / 1000).toFixed(0)}k ctx)` : ' (ctx unknown)'}`;
      }).join(', ');
    logger.info(`[LLM] Models validated: ${metaSummary}`);

    const noMeta = Object.values(this.config.models).filter(id => id && !this._modelMeta[id]);
    if (noMeta.length > 0) {
      logger.warn(`[LLM] Context-length guard disabled for: ${noMeta.join(', ')} — token budget cannot be enforced. Consider using a model listed at openrouter.ai/models.`);
    }
  }
}

export class Orchestrator {
  constructor(config) {
    this.config = config;
    this.state = new StateManager();
    this.notify = new NotificationService(config.slack);
    this.llm = new LLMService(config);
    this.github = new GitHubService(config);
    this.vectorStore = new VectorStoreService(this.github, config);

    this.ticketAgent = new TicketAgent(config, this.llm);
    this.analysisAgent = new AnalysisAgent(config, this.llm, this.github, this.vectorStore);
    this.codeAgent = new CodeAgent(config, this.llm, this.github);
    this.testAgent = new TestAgent(config, this.llm, this.github);
    this.deployAgent = new DeployAgent(config, this.github);
    this.docAgent = new DocumentationAgent(config, this.llm, this.github, this.vectorStore);

    // Attempt to load a previously persisted index at startup (non-blocking)
    this.vectorStore.load().catch(e =>
      logger.warn('[Orchestrator] Could not load vector index: ' + e.message)
    );
  }

  /**
   * Append a structured entry to the audit log.
   */
  _log(ctx, step, data = {}) {
    ctx.auditLog.push({ step, ts: new Date().toISOString(), ...data });
  }

  /**
   * Entry point: receives a raw ticket payload (from webhook or manual trigger)
   */
  async run(ticketPayload) {
    const runId = `run_${Date.now()}`;
    logger.info(`[${runId}] Pipeline started for ticket: ${ticketPayload.id}`);

    // Fail fast: verify all configured model IDs are valid before touching the repo.
    await this.llm.validateModels();

    const ctx = {
      runId,
      ticket: null,
      analysis: null,
      fix: null,
      tests: null,
      deploy: null,
      retries: 0,
      maxRetries: this.config.maxRetries ?? 3,
      status: 'running',
      startedAt: new Date().toISOString(),
      auditLog: [],
    };

    try {
      // ── Step 1: Parse ticket ──────────────────────────────────────────
      logger.info(`[${runId}] Step 1/6 — Parsing ticket ${ticketPayload.id}...`);
      await this.updateStatus(ctx, 'parsing_ticket');
      ctx.ticket = await this.ticketAgent.parse(ticketPayload);
      logger.info(`[${ctx.runId}] Ticket parsed — "${ctx.ticket.title}" [${ctx.ticket.severity ?? 'unknown'}]`);
      this._log(ctx, 'ticket_parsed', {
        id: ctx.ticket.id,
        title: ctx.ticket.title,
        type: ctx.ticket.type,
        severity: ctx.ticket.severity,
        labels: ctx.ticket.labels,
      });

      // ── Step 1.5: Ensure codebase documentation is up to date ────────
      logger.info(`[${ctx.runId}] Step 2/6 — Building codebase docs...`);
      await this.updateStatus(ctx, 'documenting');
      ctx.docs = await this.docAgent.ensureDocumented(ctx.ticket);
      logger.info(`[${ctx.runId}] Docs ready (${ctx.docs?.length ?? 0} chars)`);
      this._log(ctx, 'documentation', {
        backendDoc: '.bugfix-agent/BACKEND.md',
        frontendDoc: '.bugfix-agent/FRONTEND.md',
        docsLength: ctx.docs?.length ?? 0,
      });

      // Aguarda o índice vetorial ficar pronto (rebuild disparado pelo DocAgent)
      await this.vectorStore.waitReady();

      // ── Step 2: Analyse & reproduce bug ──────────────────────────────
      logger.info(`[${ctx.runId}] Step 3/6 — Analyzing bug...`);
      await this.updateStatus(ctx, 'analyzing');
      ctx.analysis = await this.analysisAgent.analyze(ctx.ticket, ctx.docs);
      logger.info(`[${ctx.runId}] Analysis done — ${ctx.analysis.confirmed ? 'confirmed' : 'not confirmed'} (${ctx.analysis.bugType ?? 'unknown'}, ${ctx.analysis.riskLevel ?? 'unknown'} risk)`);
      this._log(ctx, 'analysis', {
        confirmed: ctx.analysis.confirmed,
        reason: ctx.analysis.reason,
        rootCause: ctx.analysis.rootCause,
        bugType: ctx.analysis.bugType,
        riskLevel: ctx.analysis.riskLevel,
        estimatedComplexity: ctx.analysis.estimatedComplexity,
        affectedFiles: ctx.analysis.affectedFiles,
        affectedFunctions: ctx.analysis.affectedFunctions,
        codeLocations: ctx.analysis.codeLocations,
        backendChanges: ctx.analysis.backendChanges,
        frontendChanges: ctx.analysis.frontendChanges,
        suggestedApproach: ctx.analysis.suggestedApproach,
      });

      if (!ctx.analysis.confirmed) {
        const reason = ctx.analysis.reason ?? '';
        // Só fecha como inválido se o LLM explicitamente negou o bug
        // (não por falha de contexto ou parse)
        const isExplicitDenial = ctx.analysis.bugType !== undefined &&
          !reason.toLowerCase().includes('could not') &&
          !reason.toLowerCase().includes('unavailable') &&
          !reason.toLowerCase().includes('failed') &&
          !reason.toLowerCase().includes('insufficient') &&
          !reason.toLowerCase().includes('not enough') &&
          !reason.toLowerCase().includes('no context') &&
          !reason.toLowerCase().includes('no code');

        if (!isExplicitDenial) {
          logger.warn(`[${ctx.runId}] Analysis inconclusive, proceeding with fix attempt anyway.`);
          ctx.analysis.confirmed = true;
        } else {
          logger.info(`[${ctx.runId}] Bug NOT confirmed. Closing ticket.`);
          await this.ticketAgent.closeAsInvalid(ctx.ticket, reason);
          await this.notify.send(`✅ Ticket *${ctx.ticket.id}* closed: bug could not be reproduced.\n> ${reason}`);
          this._log(ctx, 'closed_invalid', { reason });
          await this._postAuditTrail(ctx);
          return this.finish(ctx, 'closed_invalid');
        }
      }

      logger.info(`[${ctx.runId}] Bug confirmed. Root cause: ${ctx.analysis.rootCause}`);

      // ── Step 3: Code the fix (with retry loop) ────────────────────────
      let fixAccepted = false;
      while (!fixAccepted && ctx.retries <= ctx.maxRetries) {
        if (ctx.retries > 0) {
          logger.warn(`[${ctx.runId}] Retry ${ctx.retries}/${ctx.maxRetries}`);
          await this.notify.send(`🔄 Retry ${ctx.retries}/${ctx.maxRetries} for ticket *${ctx.ticket.id}*`);
        }

        await this.updateStatus(ctx, 'coding');
        logger.info(`[${ctx.runId}] Step 4/6 — Coding fix (attempt ${ctx.retries + 1})...`);
        ctx.fix = await this.codeAgent.fix(ctx.analysis, ctx.fix?.feedback);
        logger.info(`[${ctx.runId}] Fix ready — branch ${ctx.fix.branch}, ${ctx.fix.fileChanges?.length ?? 0} file(s) changed`);
        this._log(ctx, `coding_attempt_${ctx.retries + 1}`, {
          attempt: ctx.retries + 1,
          branch: ctx.fix.branch,
          prTitle: ctx.fix.prTitle,
          filesChanged: (ctx.fix.fileChanges ?? []).map(f => ({ path: f.path, operation: f.operation })),
          commitMessage: ctx.fix.commitMessage,
        });

        // ── Step 4: Run tests ──────────────────────────────────────────
        await this.updateStatus(ctx, 'testing');
        logger.info(`[${ctx.runId}] Step 5/6 — Running tests (attempt ${ctx.retries + 1})...`);
        ctx.tests = await this.testAgent.run(ctx.fix, ctx.analysis);
        if (ctx.tests.passed) {
          logger.info(`[${ctx.runId}] Tests passed — ${ctx.tests.passed}/${ctx.tests.total}`);
        } else {
          logger.fail(`[${ctx.runId}] Tests failed — ${ctx.tests.failureDetails ?? 'see CI logs'}`);
        }
        this._log(ctx, `testing_attempt_${ctx.retries + 1}`, {
          attempt: ctx.retries + 1,
          passed: ctx.tests.passed,
          total: ctx.tests.total,
          failureDetails: ctx.tests.passed ? null : ctx.tests.failureDetails,
        });

        if (ctx.tests.passed) {
          fixAccepted = true;
        } else {
          ctx.retries++;
          ctx.fix.feedback = ctx.tests.failureDetails;
          if (ctx.retries > ctx.maxRetries) {
            logger.fail(`[${ctx.runId}] Max retries reached (${ctx.maxRetries}). Escalating to human.`);
            await this.escalate(ctx);
            this._log(ctx, 'escalated', { reason: 'max_retries', failureDetails: ctx.fix.feedback });
            await this._postAuditTrail(ctx);
            return this.finish(ctx, 'escalated');
          }
        }
      }

      // ── Step 5: Deploy ────────────────────────────────────────────────
      logger.info(`[${ctx.runId}] Step 6/6 — Deploying...`);
      await this.updateStatus(ctx, 'deploying');
      ctx.deploy = await this.deployAgent.deploy(ctx.fix, ctx.tests);
      logger.info(`[${ctx.runId}] Deployed — PR: ${ctx.deploy.prUrl}`);
      this._log(ctx, 'deployed', {
        prUrl: ctx.deploy.prUrl,
        branch: ctx.fix.branch,
        prTitle: ctx.fix.prTitle,
      });

      // ── Step 6: Close ticket & notify ────────────────────────────────
      await this.ticketAgent.closeAsFixed(ctx.ticket, ctx.deploy);
      this._log(ctx, 'ticket_closed', { status: 'fixed', prUrl: ctx.deploy.prUrl });

      await this._postAuditTrail(ctx);

      await this.notify.send(
        `🚀 Ticket *${ctx.ticket.id}* fixed and deployed!\n` +
        `> Branch: \`${ctx.fix.branch}\`\n` +
        `> PR: ${ctx.deploy.prUrl}\n` +
        `> Tests: ${ctx.tests.passed} passed, ${ctx.tests.total} total`
      );

      return this.finish(ctx, 'success');

    } catch (err) {
      logger.fail(`[${ctx.runId}] Pipeline error: ${err.message}`, err);
      this._log(ctx, 'pipeline_error', { error: err.message, step: ctx.status });
      await this._postAuditTrail(ctx).catch(() => { });
      await this.notify.send(`❌ Pipeline failed for ticket *${ticketPayload.id}*\n> ${err.message}`);
      await this.escalate(ctx, err);
      return this.finish(ctx, 'error', err);
    }
  }

  async updateStatus(ctx, status) {
    ctx.status = status;
    await this.state.save(ctx.runId, ctx);
  }

  /**
   * Post the full audit trail as a GitHub comment on the ticket issue.
   */
  async _postAuditTrail(ctx) {
    const issueNumber = ctx.ticket?._raw?.number;
    if (!issueNumber) {
      logger.warn('[Orchestrator] Cannot post audit trail — no GitHub issue number on ticket');
      return;
    }
    try {
      await this.github.postAuditComment(issueNumber, ctx);
      logger.info(`[Orchestrator] Audit trail posted on issue #${issueNumber}`);
    } catch (e) {
      logger.warn('[Orchestrator] Could not post audit trail: ' + e.message);
    }
  }

  async escalate(ctx, err = null) {
    const msg = err
      ? `🚨 Pipeline error on ticket *${ctx.ticket?.id}*. Manual intervention required.\n\`\`\`${err.message}\`\`\``
      : `🚨 Max retries (${ctx.maxRetries}) reached for ticket *${ctx.ticket?.id}*. Test failures:\n\`\`\`${ctx.fix?.feedback}\`\`\``;
    await this.notify.send(msg);
    if (ctx.ticket) {
      await this.ticketAgent.escalate(ctx.ticket, err?.message ?? ctx.fix?.feedback);
    }
  }

  finish(ctx, status, err = null) {
    ctx.status = status;
    logger.info(`[${ctx.runId}] Pipeline finished with status: ${status}`);
    this.state.save(ctx.runId, ctx);
    return { runId: ctx.runId, status, error: err?.message ?? null, ctx };
  }
}
