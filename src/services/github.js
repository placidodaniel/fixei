/**
 * GitHubService
 * Centralized wrapper for all GitHub REST API calls.
 */

import { logger } from './logger.js';

export class GitHubService {
  constructor(config) {
    this.token = config.githubToken;
    this.repo  = config.githubRepo; // "owner/repo"
    this.defaultBranch = config.defaultBranch ?? 'main';
    this.base  = 'https://api.github.com';
  }

  get _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    };
  }

  /**
   * Get the decoded content of a file at HEAD of defaultBranch.
   */
  async getFileContent(path) {
    const res = await fetch(
      `${this.base}/repos/${this.repo}/contents/${path}?ref=${this.defaultBranch}`,
      { headers: this._headers }
    );
    if (!res.ok) throw new Error(`getFileContent(${path}): ${res.status}`);
    const data = await res.json();
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  /**
   * Create a new branch from HEAD of defaultBranch.
   */
  async createBranch(branchName) {
    // Get current HEAD SHA
    const refRes = await fetch(
      `${this.base}/repos/${this.repo}/git/ref/heads/${this.defaultBranch}`,
      { headers: this._headers }
    );
    if (!refRes.ok) throw new Error(`createBranch: could not get HEAD ref (${refRes.status})`);
    const { object: { sha } } = await refRes.json();

    // Create new ref
    const createRes = await fetch(
      `${this.base}/repos/${this.repo}/git/refs`,
      {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
      }
    );
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`createBranch(${branchName}): ${createRes.status} — ${err}`);
    }
    logger.info(`[GitHub] Branch created: ${branchName}`);
  }

  /**
   * Commit (create or update) a file on a branch.
   */
  async commitFile(branch, path, content, message) {
    // Try to get existing file SHA (needed for updates)
    let sha;
    try {
      const existing = await fetch(
        `${this.base}/repos/${this.repo}/contents/${path}?ref=${branch}`,
        { headers: this._headers }
      );
      if (existing.ok) {
        const data = await existing.json();
        sha = data.sha;
      }
    } catch (_) { /* new file */ }

    const body = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `${this.base}/repos/${this.repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: this._headers,
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`commitFile(${path}): ${res.status} — ${err}`);
    }
    return res.json();
  }

  /**
   * List all files in the repo (recursive tree).
   * Useful for letting Claude explore the structure.
   */
  async listFiles(subPath = '') {
    const res = await fetch(
      `${this.base}/repos/${this.repo}/git/trees/${this.defaultBranch}?recursive=1`,
      { headers: this._headers }
    );
    if (!res.ok) throw new Error(`listFiles: ${res.status}`);
    const data = await res.json();
    return (data.tree ?? [])
      .filter(f => f.type === 'blob')
      .map(f => f.path)
      .filter(p => !subPath || p.startsWith(subPath));
  }

  /**
   * Get a workflow run by ID.
   */
  async getWorkflowRun(runId) {
    const res = await fetch(
      `${this.base}/repos/${this.repo}/actions/runs/${runId}`,
      { headers: this._headers }
    );
    if (!res.ok) throw new Error(`getWorkflowRun(${runId}): ${res.status}`);
    return res.json();
  }
}
