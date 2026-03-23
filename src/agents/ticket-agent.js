/**
 * TicketAgent
 * Parses tickets from Jira or GitHub Issues and manages ticket lifecycle.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../services/logger.js';

export class TicketAgent {
  constructor(config) {
    this.config = config;
    this.claude = new Anthropic({ apiKey: config.anthropicApiKey });
    this.provider = config.ticketProvider ?? 'github'; // 'github' | 'jira'
  }

  /**
   * Parse a raw ticket payload into structured context
   */
  async parse(raw) {
    const rawText = this._extractText(raw);

    const message = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a bug ticket analyst. Extract structured information from the ticket.
Return ONLY valid JSON, no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Extract from this ticket:\n\n${rawText}\n\nReturn JSON with:
{
  "id": "ticket ID",
  "title": "short title",
  "description": "full description",
  "stepsToReproduce": ["step 1", "step 2"],
  "expectedBehavior": "what should happen",
  "actualBehavior": "what actually happens",
  "environment": { "version": "...", "os": "...", "browser": "..." },
  "severity": "low|medium|high|critical",
  "labels": [],
  "reporter": "username",
  "rawLogs": "any error logs or stack traces from the ticket"
}`
      }]
    });

    try {
      const text = message.content.find(b => b.type === 'text')?.text ?? '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return { ...parsed, _raw: raw, _provider: this.provider };
    } catch (e) {
      logger.warn('TicketAgent: failed to parse Claude response, using raw fallback');
      return {
        id: raw.id ?? raw.number ?? 'unknown',
        title: raw.title ?? raw.summary ?? 'Untitled',
        description: rawText,
        stepsToReproduce: [],
        expectedBehavior: '',
        actualBehavior: '',
        environment: {},
        severity: 'medium',
        labels: [],
        reporter: raw.user?.login ?? raw.reporter?.name ?? 'unknown',
        rawLogs: '',
        _raw: raw,
        _provider: this.provider,
      };
    }
  }

  async closeAsFixed(ticket, deploy) {
    const comment = `🤖 **BugFix Agent** resolved this issue automatically.\n\n` +
      `- **Branch:** \`${deploy.branch ?? 'N/A'}\`\n` +
      `- **PR:** ${deploy.prUrl ?? 'N/A'}\n` +
      `- **Deployed to:** ${deploy.environment ?? 'staging'}\n\n` +
      `_This fix was generated, tested, and deployed without human intervention._`;
    await this._postComment(ticket, comment);
    await this._closeTicket(ticket, 'fixed');
  }

  async closeAsInvalid(ticket, reason) {
    const comment = `🤖 **BugFix Agent** investigated this ticket but could not reproduce the issue.\n\n**Reason:** ${reason}\n\nClosing as invalid. Please provide more details if the issue persists.`;
    await this._postComment(ticket, comment);
    await this._closeTicket(ticket, 'invalid');
  }

  async escalate(ticket, details) {
    const comment = `🚨 **BugFix Agent** was unable to resolve this issue automatically after multiple attempts.\n\n**Details:**\n\`\`\`\n${details}\n\`\`\`\n\nEscalating to human engineer.`;
    await this._postComment(ticket, comment);
    await this._labelTicket(ticket, 'needs-human');
  }

  // ── Private helpers ────────────────────────────────────────────────────

  _extractText(raw) {
    // GitHub Issues format
    if (raw.body !== undefined) {
      return `Title: ${raw.title}\n\nBody:\n${raw.body}`;
    }
    // Jira format
    if (raw.fields) {
      const f = raw.fields;
      return `Summary: ${f.summary}\n\nDescription:\n${f.description ?? ''}`;
    }
    // Fallback: stringify
    return JSON.stringify(raw, null, 2);
  }

  async _postComment(ticket, body) {
    const id = ticket.id;
    if (this.provider === 'github') {
      const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
      const num = ticket._raw?.number;
      if (!num) return;
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.githubToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
        }
      );
      if (!res.ok) logger.warn(`GitHub comment failed: ${res.status}`);
    }
    // Jira: POST to /rest/api/2/issue/{id}/comment
    if (this.provider === 'jira') {
      // Validar configuração do Jira antes de fazer requisição
      if (!this.config.jiraBaseUrl || !this.config.jiraEmail || !this.config.jiraToken) {
        logger.warn('[TicketAgent] Jira not configured, skipping comment');
        return;
      }
      const res = await fetch(
        `${this.config.jiraBaseUrl}/rest/api/2/issue/${id}/comment`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.config.jiraEmail}:${this.config.jiraToken}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
        }
      );
      // Não expor credenciais em logs de erro
      if (!res.ok) {
        logger.warn(`[TicketAgent] Jira comment failed: ${res.status}`);
      }
    }
  }

  async _closeTicket(ticket, resolution) {
    const id = ticket.id;
    if (this.provider === 'github') {
      const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
      const num = ticket._raw?.number;
      if (!num) return;
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${this.config.githubToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: 'closed', state_reason: resolution === 'fixed' ? 'completed' : 'not_planned' }),
        }
      );
      if (!res.ok) {
        logger.warn(`[TicketAgent] GitHub close failed: ${res.status}`);
      }
    }
    if (this.provider === 'jira') {
      // Validar configuração do Jira antes de fazer requisição
      if (!this.config.jiraBaseUrl || !this.config.jiraEmail || !this.config.jiraToken) {
        logger.warn('[TicketAgent] Jira not configured, skipping close');
        return;
      }
      // Transition to "Done" — transition ID varies per project; common value is "31"
      const transitionId = this.config.jiraTransitionDoneId ?? '31';
      const res = await fetch(
        `${this.config.jiraBaseUrl}/rest/api/2/issue/${id}/transitions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.config.jiraEmail}:${this.config.jiraToken}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ transition: { id: transitionId } }),
        }
      );
      // Não expor credenciais em logs de erro
      if (!res.ok) {
        logger.warn(`[TicketAgent] Jira close failed: ${res.status}`);
      }
    }
  }

  async _labelTicket(ticket, label) {
    if (this.provider === 'github') {
      const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
      const num = ticket._raw?.number;
      if (!num) return;
      await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${num}/labels`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.githubToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ labels: [label] }),
        }
      );
    }
  }
}
