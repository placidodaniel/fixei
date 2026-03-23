/**
 * BugFix Agent - HTTP Server
 * Receives webhooks from GitHub/Jira and exposes a REST API for the dashboard.
 */

import express from 'express';
import crypto from 'crypto';
import { Orchestrator } from '../orchestrator.js';
import { StateManager } from '../services/state-manager.js';
import { logger } from '../services/logger.js';
import { loadConfig } from './config.js';

const app = express();
app.use(express.json());

const config = loadConfig();
const orchestrator = new Orchestrator(config);
const state = orchestrator.state;

// ── CORS (for dashboard) ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// ── HEALTH ────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── GITHUB WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhook/github', async (req, res) => {
  // Verify signature
  const sig = req.headers['x-hub-signature-256'];
  if (config.webhookSecret && sig) {
    const expected = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(JSON.stringify(req.body))
      .digest();
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  // Only process "issues" events with "opened" or "labeled" action
  if (event !== 'issues') return res.json({ ignored: true });
  if (!['opened', 'labeled'].includes(payload.action)) return res.json({ ignored: true });

  // Check for the trigger label
  const triggerLabel = config.triggerLabel ?? 'ai-fix';
  const hasLabel = payload.issue?.labels?.some(l => l.name === triggerLabel);
  if (!hasLabel) return res.json({ ignored: true, reason: `label '${triggerLabel}' not present` });

  logger.info(`[Webhook] GitHub issue #${payload.issue.number} received`);
  res.json({ accepted: true, issueNumber: payload.issue.number });

  // Run pipeline async (don't block the webhook response)
  orchestrator.run(payload.issue).catch(e => logger.error('Pipeline error:', e));
});

// ── JIRA WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhook/jira', async (req, res) => {
  const payload = req.body;
  const event = payload.webhookEvent;

  if (!['jira:issue_created', 'jira:issue_updated'].includes(event)) {
    return res.json({ ignored: true });
  }

  const issue = payload.issue;
  const labels = issue?.fields?.labels ?? [];
  const triggerLabel = config.triggerLabel ?? 'ai-fix';
  if (!labels.includes(triggerLabel)) {
    return res.json({ ignored: true, reason: `label '${triggerLabel}' not present` });
  }

  logger.info(`[Webhook] Jira issue ${issue.key} received`);
  res.json({ accepted: true, issueKey: issue.key });

  orchestrator.run(issue).catch(e => logger.error('Pipeline error:', e));
});

// ── MANUAL TRIGGER ────────────────────────────────────────────────────────
app.post('/api/trigger', async (req, res) => {
  const { ticket } = req.body;
  if (!ticket) return res.status(400).json({ error: 'ticket payload required' });

  const result = await orchestrator.run(ticket);
  res.json(result);
});

// ── RUNS LIST ─────────────────────────────────────────────────────────────
app.get('/api/runs', async (_, res) => {
  const runs = await state.list();
  res.json(runs.sort((a, b) => b.updatedAt?.localeCompare(a.updatedAt ?? '') ?? 0));
});

app.get('/api/runs/:runId', async (req, res) => {
  const run = await state.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  logger.info(`BugFix Agent server running on port ${PORT}`);
  logger.info(`Webhook endpoints:
  POST /webhook/github
  POST /webhook/jira
  POST /api/trigger  (manual)`);
});

export default app;
