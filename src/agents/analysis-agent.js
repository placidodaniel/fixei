/**
 * AnalysisAgent
 * Uses Claude to read the codebase, reproduce the bug, and identify root cause.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';

export class AnalysisAgent {
  constructor(config) {
    this.config = config;
    this.claude = new Anthropic({ apiKey: config.anthropicApiKey });
    this.github = new GitHubService(config);
  }

  /**
   * Analyzes a parsed ticket.
   * Returns { confirmed, reason, rootCause, affectedFiles, suggestedApproach }
   */
  async analyze(ticket) {
    logger.info(`[AnalysisAgent] Analyzing ticket: ${ticket.id}`);

    // Fetch relevant code context from the repo
    const codeContext = await this._fetchCodeContext(ticket);

    const system = `You are a senior software engineer performing root cause analysis on a bug report.
You have access to the codebase context provided. Be precise, technical, and actionable.
Return ONLY valid JSON. No markdown, no explanation outside JSON.`;

    const userPrompt = `Bug ticket:
---
Title: ${ticket.title}
Description: ${ticket.description}
Steps to reproduce: ${ticket.stepsToReproduce?.join('\n') ?? 'Not provided'}
Expected: ${ticket.expectedBehavior}
Actual: ${ticket.actualBehavior}
Logs/Stack traces:
${ticket.rawLogs ?? 'None'}
Environment: ${JSON.stringify(ticket.environment)}
---

Relevant codebase context:
${codeContext}
---

Analyze this bug and return JSON:
{
  "confirmed": true|false,
  "reason": "why the bug is or is not reproducible",
  "rootCause": "specific technical explanation of what causes the bug",
  "affectedFiles": ["path/to/file.js", "..."],
  "affectedFunctions": ["functionName in file"],
  "bugType": "logic_error|null_reference|race_condition|config|dependency|other",
  "suggestedApproach": "step-by-step technical approach to fix this bug",
  "riskLevel": "low|medium|high",
  "estimatedComplexity": "simple|moderate|complex"
}`;

    const message = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = message.content.find(b => b.type === 'text')?.text ?? '{}';

    try {
      const result = JSON.parse(text.replace(/```json|```/g, '').trim());
      logger.info(`[AnalysisAgent] Bug confirmed: ${result.confirmed}, type: ${result.bugType}`);
      return result;
    } catch (e) {
      logger.error('[AnalysisAgent] Failed to parse analysis response', e);
      return {
        confirmed: false,
        reason: 'Analysis agent failed to produce structured output',
        rootCause: null,
        affectedFiles: [],
        suggestedApproach: null,
        riskLevel: 'high',
        estimatedComplexity: 'complex',
      };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Fetches relevant files from the repo based on ticket content.
   * Uses Claude to identify which files to fetch, then reads them via GitHub API.
   */
  async _fetchCodeContext(ticket) {
    try {
      // Step 1: ask Claude which files are likely relevant
      const triage = await this.claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: 'You identify file paths likely relevant to a bug. Return ONLY a JSON array of file path strings. No markdown.',
        messages: [{
          role: 'user',
          content: `Bug: ${ticket.title}\n${ticket.description}\nLogs: ${ticket.rawLogs ?? ''}\n\nList up to 8 file paths in this repo (${this.config.githubRepo}) that are likely involved.`
        }]
      });

      const triageText = triage.content.find(b => b.type === 'text')?.text ?? '[]';
      let paths = [];
      try {
        paths = JSON.parse(triageText.replace(/```json|```/g, '').trim());
      } catch (_) { paths = []; }

      // Step 2: fetch actual file contents
      const chunks = await Promise.allSettled(
        paths.slice(0, 8).map(p => this.github.getFileContent(p))
      );

      const context = chunks
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .join('\n\n---\n\n');

      return context || '(No code context fetched — verify GITHUB_TOKEN and GITHUB_REPO config)';
    } catch (e) {
      logger.warn('[AnalysisAgent] Could not fetch code context: ' + e.message);
      return '(Code context unavailable)';
    }
  }
}
