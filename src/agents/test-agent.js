/**
 * TestAgent
 * Triggers CI tests and uses Claude to generate new test cases for the fix.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';

export class TestAgent {
  constructor(config) {
    this.config = config;
    this.claude = new Anthropic({ apiKey: config.anthropicApiKey });
    this.github = new GitHubService(config);
  }

  /**
   * Runs tests for a fix.
   * Returns { passed, total, failureDetails, newTestsFile, ciRunUrl }
   */
  async run(fix, analysis) {
    logger.info(`[TestAgent] Running tests on branch: ${fix.branch}`);

    // Step 1: Generate new test cases with Claude
    const newTests = await this._generateTests(fix, analysis);

    // Step 2: Commit generated tests to the branch
    if (newTests && this.config.commitGeneratedTests !== false) {
      const testPath = this._resolveTestPath(analysis.affectedFiles?.[0]);
      await this.github.commitFile(
        fix.branch,
        testPath,
        newTests,
        'test: add automated tests for bug fix'
      );
      logger.info(`[TestAgent] Committed new tests: ${testPath}`);
      fix.testFile = testPath;
    }

    // Step 3: Trigger GitHub Actions workflow
    const ciRun = await this._triggerCI(fix.branch);
    logger.info(`[TestAgent] CI triggered, run ID: ${ciRun.id}`);

    // Step 4: Poll for CI result
    const result = await this._pollCI(ciRun.id);
    logger.info(`[TestAgent] CI result: ${result.conclusion}`);

    if (result.conclusion === 'success') {
      return {
        passed: result.passedCount ?? 1,
        total: result.totalCount ?? 1,
        failureDetails: null,
        newTestsFile: fix.testFile ?? null,
        ciRunUrl: result.htmlUrl,
      };
    }

    // CI failed: ask Claude to interpret the failure
    const failureDetails = await this._interpretFailure(result.logs ?? result.conclusion);

    return {
      passed: 0,
      total: result.totalCount ?? 1,
      failureDetails,
      newTestsFile: fix.testFile ?? null,
      ciRunUrl: result.htmlUrl,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  async _generateTests(fix, analysis) {
    const system = `You are a senior QA engineer writing automated tests.
Generate comprehensive, production-ready test code.
Return ONLY the test file content (no markdown fences, no explanation).`;

    const fileChangeSummary = fix.fileChanges
      .map(f => `${f.path}:\n${f.content?.slice(0, 1500) ?? '(large file)'}`)
      .join('\n\n---\n\n');

    const message = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages: [{
        role: 'user',
        content: `Bug that was fixed: ${analysis.rootCause}
Bug type: ${analysis.bugType}
Test hints from coder: ${fix.testHints}

Changed files:
${fileChangeSummary}

Write a complete test file using the project's testing framework (Jest/Vitest/Mocha — infer from imports).
Include:
1. A test that reproduces the original bug (should now pass)
2. Edge case tests around the fix
3. Regression tests
Use descriptive test names that document the expected behavior.`
      }]
    });

    return message.content.find(b => b.type === 'text')?.text ?? null;
  }

  async _triggerCI(branch) {
    const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
    const workflowId = this.config.ciWorkflowId ?? 'ci.yml';

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: branch }),
      }
    );

    if (!res.ok && res.status !== 204) {
      logger.warn(`[TestAgent] CI trigger returned ${res.status}. Attempting to find recent run.`);
    }

    // Give GitHub a moment to register the run
    await this._sleep(5000);

    // Find the run we just triggered
    const runsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=${branch}&per_page=1`,
      { headers: { Authorization: `Bearer ${this.config.githubToken}` } }
    );
    const runsData = await runsRes.json();
    const run = runsData.workflow_runs?.[0];

    if (!run) throw new Error('[TestAgent] Could not find CI run after trigger');
    return { id: run.id, htmlUrl: run.html_url };
  }

  async _pollCI(runId) {
    const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
    const maxWait = this.config.ciTimeoutMs ?? 10 * 60 * 1000; // 10 min default
    const interval = 15000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await this._sleep(interval);

      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
        { headers: { Authorization: `Bearer ${this.config.githubToken}` } }
      );
      const run = await res.json();

      logger.info(`[TestAgent] CI status: ${run.status} / ${run.conclusion}`);

      if (run.status === 'completed') {
        // Fetch jobs to get test counts
        const jobsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
          { headers: { Authorization: `Bearer ${this.config.githubToken}` } }
        );
        const jobsData = await jobsRes.json();

        // Extract test counts from jobs
        let passedCount = 0;
        let totalCount = 0;

        if (jobsData.jobs && Array.isArray(jobsData.jobs)) {
          for (const job of jobsData.jobs) {
            // Count steps with conclusion (completed jobs have conclusion field)
            if (job.steps && Array.isArray(job.steps)) {
              for (const step of job.steps) {
                if (step.conclusion) {
                  totalCount++;
                  if (step.conclusion === 'success') {
                    passedCount++;
                  }
                }
              }
            }
          }
        }

        // If no steps found, use run stats as fallback
        if (totalCount === 0) {
          const stats = run.stats || {};
          totalCount = run.run_attempt * (stats.total_tests ?? stats.total ?? 1);
          passedCount = run.conclusion === 'success' ? totalCount : 0;
        }

        return {
          conclusion: run.conclusion,
          htmlUrl: run.html_url,
          passedCount,
          totalCount,
          logs: null,
        };
      }
    }

    throw new Error('[TestAgent] CI timed out after ' + maxWait / 1000 + 's');
  }

  async _interpretFailure(rawLogs) {
    const message = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: 'You summarize CI test failures concisely for an autonomous fix agent. Be specific about what failed and why.',
      messages: [{
        role: 'user',
        content: `CI failure output:\n${String(rawLogs).slice(0, 3000)}\n\nSummarize the root cause of the test failure in 2-3 sentences.`
      }]
    });
    return message.content.find(b => b.type === 'text')?.text ?? rawLogs;
  }

  _resolveTestPath(sourcePath) {
    if (!sourcePath) return 'tests/auto-generated.test.js';
    const ext = sourcePath.endsWith('.ts') ? '.ts' : '.js';
    const base = sourcePath.replace(/\.[jt]sx?$/, '');
    if (sourcePath.includes('/src/')) {
      return base.replace('/src/', '/tests/') + `.test${ext}`;
    }
    return base + `.test${ext}`;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
