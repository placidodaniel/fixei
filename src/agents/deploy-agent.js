/**
 * DeployAgent
 * Creates a Pull Request and handles auto-merge to trigger deployment.
 */

import { GitHubService } from '../services/github.js';
import { logger } from '../services/logger.js';

export class DeployAgent {
  constructor(config, github = null) {
    this.config = config;
    this.github = github ?? new GitHubService(config);
  }

  /**
   * Creates a PR for the fix branch and optionally auto-merges.
   * Returns { prUrl, prNumber, branch, environment, merged }
   */
  async deploy(fix, tests) {
    logger.info(`[DeployAgent] Creating PR for branch: ${fix.branch}`);

    const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
    const base = this.config.defaultBranch ?? 'main';

    const body = this._buildPRBody(fix, tests);

    // Create PR
    const prRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: fix.prTitle ?? `fix: automated bug fix`,
          body,
          head: fix.branch,
          base,
          draft: false,
        }),
      }
    );

    if (!prRes.ok) {
      const err = await prRes.text();
      throw new Error(`[DeployAgent] PR creation failed (${prRes.status}): ${err}`);
    }

    const pr = await prRes.json();
    logger.info(`[DeployAgent] PR created: ${pr.html_url}`);

    // Add labels
    await this._addLabels(pr.number, ['auto-fix', 'bugfix']);

    // Auto-merge if configured
    let merged = false;
    if (this.config.autoMerge !== false) {
      merged = await this._autoMerge(pr.number);
      if (merged) {
        logger.info(`[DeployAgent] PR #${pr.number} auto-merged`);
      } else {
        logger.warn(`[DeployAgent] Auto-merge not available — PR requires manual approval`);
      }
    }

    return {
      prUrl: pr.html_url,
      prNumber: pr.number,
      branch: fix.branch,
      environment: merged ? (this.config.deployEnvironment ?? 'production') : 'staging',
      merged,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _buildPRBody(fix, tests) {
    return `## 🤖 Automated Bug Fix

${fix.prDescription ?? '_No description generated._'}

---

### ✅ Test Results
- **Status:** ${tests.passed > 0 ? '✅ All tests passed' : '⚠️ See details'}
- **New test file:** ${tests.newTestsFile ?? '_none_'}
- **CI Run:** ${tests.ciRunUrl ?? '_N/A_'}

### 📁 Files Changed
${(fix.fileChanges ?? []).map(f => `- \`${f.path}\``).join('\n') || '_none_'}

### ⚠️ Breaking Change
${fix.breakingChange ? '**Yes** — review carefully before merging' : 'No'}

### 🔄 Rollback Plan
${fix.rollbackPlan ?? '_Revert this PR_'}

---
_This PR was generated autonomously by **BugFix Agent**. Review before merging to production._`;
  }

  async _addLabels(prNumber, labels) {
    const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/labels`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ labels }),
      }
    );
  }

  async _waitForChecks(owner, repo, prNumber, timeout = 60000) {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 segundos entre verificações

    while (Date.now() - startTime < timeout) {
      // Verificar status do PR via API de pull request
      const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${this.config.githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (prRes.status === 200) {
        const pr = await prRes.json();

        // Verificar se o PR está mergeable
        if (pr.mergeable === true && pr.mergeable_state === 'clean') {
          logger.info('[DeployAgent] PR is ready for merge');
          return true;
        }

        // Se há checks falhando, não proceed
        if (pr.mergeable_state === 'blocked' || pr.mergeable_state === 'dirty') {
          logger.warn(`[DeployAgent] PR mergeable_state: ${pr.mergeable_state}`);
        }
      }

      // Aguardar próximo poll
      await new Promise(r => setTimeout(r, pollInterval));
    }

    logger.warn('[DeployAgent] Timeout waiting for checks');
    return false;
  }

  async _autoMerge(prNumber) {
    const [owner, repo] = (this.config.githubRepo ?? '/').split('/');
    const mergeMethod = this.config.mergeMethod ?? 'squash';

    // Wait for status checks to be ready with polling
    const checksReady = await this._waitForChecks(owner, repo, prNumber, 60000);
    if (!checksReady) {
      logger.warn('[DeployAgent] Checks not ready, proceeding anyway');
    }

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          merge_method: mergeMethod,
          commit_title: `Auto-merge: PR #${prNumber}`,
        }),
      }
    );

    if (res.status === 200) return true;
    if (res.status === 405) {
      logger.warn('[DeployAgent] Merge not allowed (branch protection or checks pending)');
      return false;
    }
    logger.warn(`[DeployAgent] Merge returned ${res.status}`);
    return false;
  }
}
