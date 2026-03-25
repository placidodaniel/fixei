/**
 * GitHubService
 * Centralized wrapper for all GitHub REST API calls.
 */

import { logger } from './logger.js';

export class GitHubService {
  constructor(config) {
    this.token = config.githubToken;
    this.repo = config.githubRepo; // "owner/repo"
    this.defaultBranch = config.defaultBranch ?? 'main';
    this.base = 'https://api.github.com';
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

  /**
   * Post a structured analysis comment on a GitHub issue.
   * Includes file locations, line numbers, and fix instructions.
   */
  async postAnalysisComment(issueNumber, analysis) {
    const confirmed = analysis.confirmed;
    const emoji = confirmed ? '🔍' : '✅';
    const status = confirmed ? 'Bug confirmed' : 'Not a bug';

    const locationLines = (analysis.codeLocations ?? []).map(loc =>
      `- \`${loc.file}\` [linha ${loc.line ?? '?'}](https://github.com/${this.repo}/blob/${this.defaultBranch}/${loc.file}${loc.line ? `#L${loc.line}` : ''}) — ${loc.description}`
    ).join('\n') || '_Localização não identificada_';

    const body = [
      `## ${emoji} BugFix Agent — Análise: ${status}`,
      '',
      `**Motivo:** ${analysis.reason}`,
      '',
      `**Causa raiz:** ${analysis.rootCause ?? '_não identificada_'}`,
      '',
      '### 📍 Localização no código',
      locationLines,
      '',
      `### 🛠 Abordagem sugerida`,
      analysis.suggestedApproach ?? '_não disponível_',
      '',
      `**Tipo:** \`${analysis.bugType ?? 'other'}\` | **Risco:** \`${analysis.riskLevel ?? 'medium'}\` | **Complexidade:** \`${analysis.estimatedComplexity ?? 'moderate'}\``,
    ].join('\n');

    const res = await fetch(
      `${this.base}/repos/${this.repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) logger.warn(`[GitHub] Failed to post analysis comment: ${res.status}`);
  }

  /**
   * Post a full audit trail comment with every step the AI executed.
   */
  async postAuditComment(issueNumber, ctx) {
    const finishedAt = new Date().toISOString();
    const durationMs = ctx.startedAt
      ? Date.now() - new Date(ctx.startedAt).getTime()
      : 0;
    const duration = durationMs < 60000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`;

    const statusEmoji = {
      success: '✅', error: '❌', escalated: '🚨',
      closed_invalid: '🚫', running: '⏳',
    }[ctx.status] ?? '⏳';

    const lines = [
      `## 🤖 BugFix Agent — Histórico Completo de Execução`,
      '',
      `| Campo | Valor |`,
      `|-------|-------|`,
      `| **Run ID** | \`${ctx.runId}\` |`,
      `| **Iniciado** | ${ctx.startedAt} |`,
      `| **Finalizado** | ${finishedAt} |`,
      `| **Duração** | ${duration} |`,
      `| **Status final** | ${statusEmoji} \`${ctx.status}\` |`,
      `| **Tentativas de fix** | ${ctx.retries} de ${ctx.maxRetries} |`,
      '',
      '---',
      '',
    ];

    for (const entry of ctx.auditLog ?? []) {
      switch (entry.step) {

        case 'ticket_parsed':
          lines.push(`### 📋 Etapa 1 — Parsing do Ticket`);
          lines.push(`> \`${entry.ts}\``);
          lines.push('');
          lines.push(`- **ID:** \`${entry.id ?? 'N/A'}\``);
          lines.push(`- **Título:** ${entry.title ?? 'N/A'}`);
          lines.push(`- **Tipo:** \`${entry.type ?? 'N/A'}\``);
          lines.push(`- **Severidade:** \`${entry.severity ?? 'N/A'}\``);
          if (entry.labels?.length) lines.push(`- **Labels:** ${entry.labels.map(l => `\`${l}\``).join(', ')}`);
          lines.push('');
          break;

        case 'documentation':
          lines.push(`### 📚 Etapa 2 — Documentação do Codebase`);
          lines.push(`> \`${entry.ts}\``);
          lines.push('');
          lines.push(`- [BACKEND.md](https://github.com/${this.repo}/blob/${this.defaultBranch}/${entry.backendDoc}) gerado/atualizado`);
          lines.push(`- [FRONTEND.md](https://github.com/${this.repo}/blob/${this.defaultBranch}/${entry.frontendDoc}) gerado/atualizado`);
          lines.push(`- Tamanho total dos docs injetados: ${entry.docsLength.toLocaleString()} chars`);
          lines.push('');
          break;

        case 'analysis': {
          lines.push(`### 🔍 Etapa 3 — Análise de Causa Raiz`);
          lines.push(`> \`${entry.ts}\``);
          lines.push('');
          lines.push(`- **Bug confirmado:** ${entry.confirmed ? '✅ Sim' : '❌ Não'}`);
          lines.push(`- **Motivo:** ${entry.reason ?? 'N/A'}`);
          lines.push(`- **Causa raiz:** ${entry.rootCause ?? 'N/A'}`);
          lines.push(`- **Tipo:** \`${entry.bugType ?? 'N/A'}\` | **Risco:** \`${entry.riskLevel ?? 'N/A'}\` | **Complexidade:** \`${entry.estimatedComplexity ?? 'N/A'}\``);

          if (entry.affectedFiles?.length) {
            lines.push('');
            lines.push(`**Arquivos afetados:**`);
            for (const f of entry.affectedFiles) {
              lines.push(`- [\`${f}\`](https://github.com/${this.repo}/blob/${this.defaultBranch}/${f})`);
            }
          }

          if (entry.codeLocations?.length) {
            lines.push('');
            lines.push(`**Localizações exatas no código:**`);
            for (const loc of entry.codeLocations) {
              const link = `https://github.com/${this.repo}/blob/${this.defaultBranch}/${loc.file}${loc.line ? `#L${loc.line}` : ''}`;
              const layer = loc.layer ? ` \`[${loc.layer}]\`` : '';
              lines.push(`- [\`${loc.file}\` linha ${loc.line ?? '?'}](${link})${layer} — ${loc.description}`);
            }
          }

          if (entry.backendChanges && entry.backendChanges !== 'none') {
            lines.push('');
            lines.push(`**Mudanças backend necessárias:**`);
            lines.push(`> ${entry.backendChanges}`);
          }
          if (entry.frontendChanges && entry.frontendChanges !== 'none') {
            lines.push('');
            lines.push(`**Mudanças frontend necessárias:**`);
            lines.push(`> ${entry.frontendChanges}`);
          }

          if (entry.suggestedApproach) {
            lines.push('');
            lines.push(`**Abordagem sugerida:**`);
            lines.push(`> ${entry.suggestedApproach.replace(/\n/g, '\n> ')}`);
          }
          lines.push('');
          break;
        }

        default:
          if (entry.step.startsWith('coding_attempt_')) {
            const n = entry.attempt;
            lines.push(`### 💻 Etapa 4.${n} — Geração do Fix (Tentativa ${n})`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Branch:** \`${entry.branch ?? 'N/A'}\``);
            lines.push(`- **PR title:** ${entry.prTitle ?? 'N/A'}`);
            if (entry.commitMessage) lines.push(`- **Commit:** \`${entry.commitMessage.split('\n')[0]}\``);
            if (entry.filesChanged?.length) {
              lines.push('');
              lines.push(`**Arquivos alterados (${entry.filesChanged.length}):**`);
              for (const f of entry.filesChanged) {
                lines.push(`- [\`${f.path}\`](https://github.com/${this.repo}/blob/${entry.branch}/${f.path}) — \`${f.operation}\``);
              }
            }
            lines.push('');
          } else if (entry.step.startsWith('testing_attempt_')) {
            const n = entry.attempt;
            const icon = entry.passed ? '✅' : '❌';
            lines.push(`### 🧪 Etapa 5.${n} — Testes (Tentativa ${n})`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Resultado:** ${icon} ${entry.passed ? 'Passou' : 'Falhou'} (${entry.total ?? '?'} testes)`);
            if (!entry.passed && entry.failureDetails) {
              lines.push(`- **Detalhes da falha:**`);
              lines.push('```');
              lines.push(String(entry.failureDetails).slice(0, 600));
              lines.push('```');
            }
            lines.push('');
          } else if (entry.step === 'deployed') {
            lines.push(`### 🚀 Etapa 6 — Deploy / Pull Request`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **PR aberto:** [${entry.prTitle ?? 'Ver Pull Request'}](${entry.prUrl ?? '#'})`);
            lines.push(`- **Branch:** \`${entry.branch ?? 'N/A'}\``);
            lines.push('');
          } else if (entry.step === 'ticket_closed') {
            lines.push(`### ✅ Etapa 7 — Ticket Encerrado`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Status:** \`${entry.status}\``);
            if (entry.prUrl) lines.push(`- **PR:** ${entry.prUrl}`);
            lines.push('');
          } else if (entry.step === 'closed_invalid') {
            lines.push(`### 🚫 Ticket Encerrado — Bug Não Confirmado`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Motivo:** ${entry.reason}`);
            lines.push('');
          } else if (entry.step === 'escalated') {
            lines.push(`### 🚨 Escalado para Revisão Humana`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Motivo:** \`${entry.reason ?? 'N/A'}\``);
            if (entry.failureDetails) {
              lines.push('```');
              lines.push(String(entry.failureDetails).slice(0, 400));
              lines.push('```');
            }
            lines.push('');
          } else if (entry.step === 'pipeline_error') {
            lines.push(`### ❌ Erro no Pipeline`);
            lines.push(`> \`${entry.ts}\``);
            lines.push('');
            lines.push(`- **Etapa em execução:** \`${entry.step_at ?? entry.step}\``);
            lines.push(`- **Erro:** \`${entry.error}\``);
            lines.push('');
          }
      }
    }

    lines.push('---');
    lines.push(`> _Gerado automaticamente pelo BugFix Agent · Run \`${ctx.runId}\`_`);

    const body = lines.join('\n');

    const res = await fetch(
      `${this.base}/repos/${this.repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) logger.warn(`[GitHub] Failed to post audit comment: ${res.status}`);
  }
}
