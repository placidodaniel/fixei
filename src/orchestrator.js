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
 *
 * Uses the OpenRouter native `models[]` + `route: "fallback"` feature so the
 * provider itself handles model switching — zero retry logic needed here.
 * The fallback list per agent is configured in config.modelFallbacks[agentName].
 */
class LLMService {
  constructor(config) {
    this.config = config;
  }

  async call(agentName, system, userPrompt, maxTokens = 1024) {
    const primary = this.config.models[agentName];
    const fallbacks = (this.config.modelFallbacks?.[agentName] ?? []).slice(0, 2); // max 3 total (OpenRouter limit)
    const models = [primary, ...fallbacks];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://bugfix-agent.local',
        'X-Title': 'BugFix Agent',
      },
      body: JSON.stringify({
        models,           // OpenRouter tenta na ordem; se o primeiro falhar vai para o próximo
        route: 'fallback',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const usedModel = data.model;
    if (usedModel && usedModel !== primary) {
      logger.warn(`[LLM] ${agentName} routed to fallback model: "${usedModel}"`);
    }
    return data.choices[0].message.content;
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
      await this.updateStatus(ctx, 'parsing_ticket');
      ctx.ticket = await this.ticketAgent.parse(ticketPayload);
      logger.info(`[${ctx.runId}] Ticket parsed: ${ctx.ticket.title}`);
      this._log(ctx, 'ticket_parsed', {
        id: ctx.ticket.id,
        title: ctx.ticket.title,
        type: ctx.ticket.type,
        severity: ctx.ticket.severity,
        labels: ctx.ticket.labels,
      });

      // ── Step 1.5: Ensure codebase documentation is up to date ────────
      await this.updateStatus(ctx, 'documenting');
      ctx.docs = await this.docAgent.ensureDocumented(ctx.ticket);
      this._log(ctx, 'documentation', {
        backendDoc: '.bugfix-agent/BACKEND.md',
        frontendDoc: '.bugfix-agent/FRONTEND.md',
        docsLength: ctx.docs?.length ?? 0,
      });

      // Aguarda o índice vetorial ficar pronto (rebuild disparado pelo DocAgent)
      await this.vectorStore.waitReady();

      // ── Step 2: Analyse & reproduce bug ──────────────────────────────
      await this.updateStatus(ctx, 'analyzing');
      ctx.analysis = await this.analysisAgent.analyze(ctx.ticket, ctx.docs);
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
        ctx.fix = await this.codeAgent.fix(ctx.analysis, ctx.fix?.feedback);
        this._log(ctx, `coding_attempt_${ctx.retries + 1}`, {
          attempt: ctx.retries + 1,
          branch: ctx.fix.branch,
          prTitle: ctx.fix.prTitle,
          filesChanged: (ctx.fix.fileChanges ?? []).map(f => ({ path: f.path, operation: f.operation })),
          commitMessage: ctx.fix.commitMessage,
        });

        // ── Step 4: Run tests ──────────────────────────────────────────
        await this.updateStatus(ctx, 'testing');
        ctx.tests = await this.testAgent.run(ctx.fix, ctx.analysis);
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
            logger.error(`[${ctx.runId}] Max retries reached. Escalating to human.`);
            await this.escalate(ctx);
            this._log(ctx, 'escalated', { reason: 'max_retries', failureDetails: ctx.fix.feedback });
            await this._postAuditTrail(ctx);
            return this.finish(ctx, 'escalated');
          }
        }
      }

      // ── Step 5: Deploy ────────────────────────────────────────────────
      await this.updateStatus(ctx, 'deploying');
      ctx.deploy = await this.deployAgent.deploy(ctx.fix, ctx.tests);
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
      logger.error(`[${ctx.runId}] Pipeline error: ${err.message}`, err);
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
