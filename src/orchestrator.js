/**
 * BugFix Agent - Orchestrator
 * Coordinates all agents in the autonomous bug fix pipeline
 */

import { TicketAgent } from './agents/ticket-agent.js';
import { AnalysisAgent } from './agents/analysis-agent.js';
import { CodeAgent } from './agents/code-agent.js';
import { TestAgent } from './agents/test-agent.js';
import { DeployAgent } from './agents/deploy-agent.js';
import { NotificationService } from './services/notification.js';
import { StateManager } from './services/state-manager.js';
import { logger } from './services/logger.js';

export class Orchestrator {
  constructor(config) {
    this.config = config;
    this.state = new StateManager();
    this.notify = new NotificationService(config.slack);

    this.ticketAgent   = new TicketAgent(config);
    this.analysisAgent = new AnalysisAgent(config);
    this.codeAgent     = new CodeAgent(config);
    this.testAgent     = new TestAgent(config);
    this.deployAgent   = new DeployAgent(config);
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
    };

    try {
      // ── Step 1: Parse ticket ──────────────────────────────────────────
      await this.updateStatus(ctx, 'parsing_ticket');
      ctx.ticket = await this.ticketAgent.parse(ticketPayload);
      logger.info(`[${ctx.runId}] Ticket parsed: ${ctx.ticket.title}`);

      // ── Step 2: Analyse & reproduce bug ──────────────────────────────
      await this.updateStatus(ctx, 'analyzing');
      ctx.analysis = await this.analysisAgent.analyze(ctx.ticket);

      if (!ctx.analysis.confirmed) {
        logger.info(`[${ctx.runId}] Bug NOT confirmed. Closing ticket.`);
        await this.ticketAgent.closeAsInvalid(ctx.ticket, ctx.analysis.reason);
        await this.notify.send(`✅ Ticket *${ctx.ticket.id}* closed: bug could not be reproduced.\n> ${ctx.analysis.reason}`);
        return this.finish(ctx, 'closed_invalid');
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

        // ── Step 4: Run tests ──────────────────────────────────────────
        await this.updateStatus(ctx, 'testing');
        ctx.tests = await this.testAgent.run(ctx.fix, ctx.analysis);

        if (ctx.tests.passed) {
          fixAccepted = true;
        } else {
          ctx.retries++;
          ctx.fix.feedback = ctx.tests.failureDetails;
          if (ctx.retries > ctx.maxRetries) {
            logger.error(`[${ctx.runId}] Max retries reached. Escalating to human.`);
            await this.escalate(ctx);
            return this.finish(ctx, 'escalated');
          }
        }
      }

      // ── Step 5: Deploy ────────────────────────────────────────────────
      await this.updateStatus(ctx, 'deploying');
      ctx.deploy = await this.deployAgent.deploy(ctx.fix, ctx.tests);

      // ── Step 6: Close ticket & notify ────────────────────────────────
      await this.ticketAgent.closeAsFixed(ctx.ticket, ctx.deploy);
      await this.notify.send(
        `🚀 Ticket *${ctx.ticket.id}* fixed and deployed!\n` +
        `> Branch: \`${ctx.fix.branch}\`\n` +
        `> PR: ${ctx.deploy.prUrl}\n` +
        `> Tests: ${ctx.tests.passed} passed, ${ctx.tests.total} total`
      );

      return this.finish(ctx, 'success');

    } catch (err) {
      logger.error(`[${ctx.runId}] Pipeline error: ${err.message}`, err);
      await this.notify.send(`❌ Pipeline failed for ticket *${ticketPayload.id}*\n> ${err.message}`);
      await this.escalate(ctx, err);
      return this.finish(ctx, 'error', err);
    }
  }

  async updateStatus(ctx, status) {
    ctx.status = status;
    await this.state.save(ctx.runId, ctx);
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
