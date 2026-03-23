/**
 * CodeAgent
 * Generates a code fix based on the analysis, creates a branch, and commits.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';

export class CodeAgent {
  constructor(config) {
    this.config = config;
    this.claude = new Anthropic({ apiKey: config.anthropicApiKey });
    this.github = new GitHubService(config);
  }

  /**
   * Generates the fix for a confirmed bug.
   * @param {object} analysis - output from AnalysisAgent
   * @param {string|null} feedback - test failure details from a previous attempt
   * Returns { branch, commits, prDescription, fileChanges }
   */
  async fix(analysis, feedback = null) {
    logger.info(`[CodeAgent] Generating fix for ${analysis.affectedFiles?.length ?? 0} files`);

    // Fetch current content of all affected files
    const fileContents = await this._fetchFiles(analysis.affectedFiles ?? []);

    const feedbackSection = feedback
      ? `\n\nPREVIOUS ATTEMPT FAILED. Test failure details:\n${feedback}\nPlease address these failures in your fix.\n`
      : '';

    const system = `You are a senior software engineer implementing a precise bug fix.
You will receive file contents and an analysis. Generate minimal, targeted changes.
Return ONLY valid JSON. No markdown, no explanations outside JSON.`;

    const userPrompt = `Root cause: ${analysis.rootCause}
Bug type: ${analysis.bugType}
Risk level: ${analysis.riskLevel}
Suggested approach: ${analysis.suggestedApproach}
${feedbackSection}

Current file contents:
${fileContents}

Generate the fix and return JSON:
{
  "prTitle": "fix: short description of what was fixed",
  "prDescription": "Markdown PR description explaining root cause, changes made, testing notes",
  "commitMessage": "fix(scope): description\\n\\nBody explaining what and why",
  "fileChanges": [
    {
      "path": "src/example/file.js",
      "operation": "update",
      "content": "FULL file content after the fix (not a diff, the complete file)"
    }
  ],
  "testHints": "Hints for the test agent on what edge cases to cover",
  "breakingChange": false,
  "rollbackPlan": "how to revert if needed"
}`;

    const message = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = message.content.find(b => b.type === 'text')?.text ?? '{}';

    let fixData;
    try {
      fixData = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      throw new Error('[CodeAgent] Failed to parse fix response: ' + e.message);
    }

    // Create branch and commit changes
    const branchName = `bugfix/auto-${Date.now()}`;
    logger.info(`[CodeAgent] Creating branch: ${branchName}`);

    await this.github.createBranch(branchName);

    for (const change of fixData.fileChanges ?? []) {
      await this.github.commitFile(
        branchName,
        change.path,
        change.content,
        fixData.commitMessage
      );
      logger.info(`[CodeAgent] Committed: ${change.path}`);
    }

    return {
      branch: branchName,
      prTitle: fixData.prTitle,
      prDescription: fixData.prDescription,
      fileChanges: fixData.fileChanges ?? [],
      testHints: fixData.testHints ?? '',
      breakingChange: fixData.breakingChange ?? false,
      rollbackPlan: fixData.rollbackPlan ?? '',
      feedback: null,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _fetchFiles(paths) {
    if (!paths.length) return '(no specific files identified)';

    const results = await Promise.allSettled(
      paths.map(p => this.github.getFileContent(p).then(c => `### ${p}\n\`\`\`\n${c}\n\`\`\``))
    );

    return results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .join('\n\n');
  }
}
