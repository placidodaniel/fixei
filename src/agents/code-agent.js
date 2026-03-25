/**
 * CodeAgent
 * Generates a code fix based on the analysis, creates a branch, and commits.
 */

import { GitHubService } from '../services/github.js';
import { Context7Service } from '../services/context7.js';
import { logger } from '../services/logger.js';
import { extractJson } from '../services/llm-utils.js';

export class CodeAgent {
  constructor(config, llm, github = null) {
    this.config = config;
    this.llm = llm;
    this.github = github ?? new GitHubService(config);
    this.ctx7 = this.config.context7Enabled ? new Context7Service() : null;
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
    const affectedPaths = analysis.affectedFiles ?? [];

    // Store originals by path — needed later to merge truncated LLM output
    const originalByPath = {};
    await Promise.allSettled(
      affectedPaths.map(async p => {
        try { originalByPath[p] = await this.github.getFileContent(p); } catch (_) { }
      })
    );

    const fileContents = affectedPaths
      .filter(p => originalByPath[p])
      .map(p => `### ${p}\n\`\`\`\n${originalByPath[p]}\n\`\`\``)
      .join('\n\n') || '(no specific files identified)';

    // Keep a full file list to validate generated paths against real repo paths (non-blocking)
    let allRepoPaths = [];
    try {
      allRepoPaths = await this.github.listFiles();
    } catch (_) { /* non-blocking */ }

    // Fetch framework best practices from Context7 (non-blocking)
    const bestPractices = await this._fetchBestPractices(analysis);

    const feedbackSection = feedback
      ? `\n\nPREVIOUS ATTEMPT FAILED. Test failure details:\n${feedback}\nPlease address these failures in your fix.\n`
      : '';

    // Cap Context7 content to avoid overwhelming the model's output budget
    const bestPracticesCapped = bestPractices ? bestPractices.slice(0, 3000) : '';
    const bestPracticesSection = bestPracticesCapped
      ? `\n\n--- FRAMEWORK BEST PRACTICES (follow these in your fix) ---\n${bestPracticesCapped}\n--- END BEST PRACTICES ---`
      : '';

    const system = `You are a senior software engineer implementing a precise bug fix.
You will receive file contents and an analysis. Generate minimal, targeted changes.
Follow the response format exactly — use the <<<PLAN>>> and <<<FILE>>> sections described below.${bestPracticesSection}`;

    const hasBackendChanges = analysis.backendChanges && analysis.backendChanges !== 'none';
    const hasFrontendChanges = analysis.frontendChanges && analysis.frontendChanges !== 'none';

    const layerSection = (hasBackendChanges || hasFrontendChanges)
      ? `\nBackend changes required:\n${analysis.backendChanges ?? 'none'}\n\nFrontend changes required:\n${analysis.frontendChanges ?? 'none'}\n`
      : '';

    const userPrompt = `Root cause: ${analysis.rootCause}
Bug type: ${analysis.bugType}
Risk level: ${analysis.riskLevel}
Suggested approach: ${analysis.suggestedApproach}${layerSection}
${feedbackSection}

Files to fix (USE THESE EXACT PATHS — do NOT invent new paths or change directories):
${affectedPaths.map(p => `- ${p}`).join('\n') || '(see file contents below)'}

Current file contents:
${fileContents}

Respond in EXACTLY this format — do NOT put file content inside JSON:

<<<PLAN>>>
{
  "prTitle": "fix: short description of what was fixed",
  "prDescription": "Markdown PR description: root cause, changes made, testing notes",
  "commitMessage": "fix(scope): description\\n\\nBody explaining what and why",
  "testHints": "Hints for the test agent on what edge cases to cover",
  "breakingChange": false,
  "rollbackPlan": "how to revert if needed",
  "files": [
    {"path": "EXACT path from the list above", "operation": "update"}
  ]
}
<<<END_PLAN>>>

<<<FILE: EXACT path from the list above>>>
FULL corrected file content — every single line, from first to last
<<<END_FILE>>>

(repeat <<<FILE>>> block for each file)

CRITICAL RULES:
- Each path in "files" MUST be one of the exact paths listed above.
- Do NOT create files outside the existing repository structure.
- Backend files must stay in their backend directory; frontend files in their frontend directory.
- Each <<<FILE>>> block MUST contain the COMPLETE file — every single line.
- NEVER use placeholders: no "//...", "// existing code", "/* ... */", "...", "unchanged", "omitted".
- If a section of the file does not change, copy it verbatim. There are NO shortcuts.`;

    const text = await this.llm.call('code', system, userPrompt, 16384);

    // Helper: if the model used the structured format, stay in that path;
    // if not, fall back to plain JSON. Never mix both — extractJson chokes on
    // <<<FILE>>> blocks that contain { } characters from source code.
    const parse = (txt) => {
      if (txt.includes('<<<PLAN>>>')) {
        return this._parseStructuredResponse(txt);
      }
      return extractJson(txt);
    };

    let fixData;
    try {
      fixData = parse(text);
    } catch (e) {
      // Both formats failed — model may have truncated output. Attempt a recovery pass.
      logger.warn(`[CodeAgent] Parse failed (${e.message}) — attempting recovery pass...`);
      try {
        const recovered = await this._recoverJson(text);
        fixData = parse(recovered);
        logger.info('[CodeAgent] Response recovered successfully');
      } catch (e2) {
        throw new Error('[CodeAgent] Failed to parse fix response (even after recovery): ' + e.message);
      }
    }

    // Expand any truncated content before path validation
    for (const change of fixData.fileChanges ?? []) {
      if (this._hasTruncation(change.content)) {
        const original = originalByPath[change.path];
        if (original) {
          logger.warn(`[CodeAgent] Truncated content detected in ${change.path} — running merge pass...`);
          change.content = await this._expandTruncated(change.path, original, change.content, analysis);
        } else {
          logger.warn(`[CodeAgent] Truncated content in ${change.path} but no original to merge — skipping expansion`);
        }
      }
    }

    // Validate and remap any paths the LLM may have gotten wrong
    if (allRepoPaths.length > 0 && fixData.fileChanges?.length) {
      for (const change of fixData.fileChanges) {
        if (!allRepoPaths.includes(change.path)) {
          // Try to find the closest real path by matching the filename
          const basename = change.path.split('/').pop();
          const match = allRepoPaths.find(p => p.endsWith('/' + basename) || p === basename);
          if (match) {
            logger.warn(`[CodeAgent] Remapping invented path "${change.path}" → "${match}"`);
            change.path = match;
          } else {
            logger.warn(`[CodeAgent] LLM generated unrecognized path, skipping: ${change.path}`);
          }
        }
      }
      // Remove any changes with paths that still don't exist in the repo
      const before = fixData.fileChanges.length;
      fixData.fileChanges = fixData.fileChanges.filter(c => allRepoPaths.includes(c.path));
      const removed = before - fixData.fileChanges.length;
      if (removed > 0) logger.warn(`[CodeAgent] Removed ${removed} file change(s) with invalid paths`);
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

  /**
   * Returns true if the LLM truncated the content with placeholder comments.
   */
  _hasTruncation(content) {
    if (!content) return false;
    return /\/\/\s*\.{2,}|\/\*\s*\.{2,}\s*\*\/|#\s*\.{2,}|\.\.\.|existing code|rest of (the )?code|unchanged|omitted|as before/i.test(content);
  }

  /**
   * Takes an original file and a truncated fix snippet, and asks the LLM
   * to produce the complete merged file with every line present.
   */
  async _expandTruncated(path, original, truncated, analysis) {
    const system =
      `You are a senior software engineer performing a precise code merge.\n` +
      `You will receive the ORIGINAL complete file and a PARTIAL fix that uses placeholders like "//..." or "// existing code".\n` +
      `Your job is to produce the COMPLETE merged file: apply the fix changes into the original, preserving every line that was not changed.\n` +
      `Return ONLY the final file content — plain text, no JSON, no markdown fences, no explanations.\n` +
      `NEVER use "//...", "/* ... */", "// existing code", or any other placeholder. Every line must be real code.`;

    const userPrompt =
      `File path: ${path}\n\n` +
      `Root cause being fixed: ${analysis.rootCause}\n` +
      `Suggested approach: ${analysis.suggestedApproach}\n\n` +
      `--- ORIGINAL FILE (${original.split('\n').length} lines) ---\n${original}\n--- END ORIGINAL ---\n\n` +
      `--- PARTIAL FIX (contains placeholders — DO NOT copy placeholders) ---\n${truncated}\n--- END PARTIAL FIX ---\n\n` +
      `Produce the complete merged file. Include every unchanged line from the original exactly as-is.`;

    try {
      const merged = await this.llm.call('code', system, userPrompt, 8096);
      // Strip any accidental markdown fences
      return merged.replace(/^```[\w]*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    } catch (e) {
      logger.warn(`[CodeAgent] Merge pass failed for ${path}: ${e.message} — using truncated version`);
      return truncated;
    }
  }

  /**
   * Parses the structured <<<PLAN>>> / <<<FILE:>>> response format.
   * Throws SyntaxError if the format is not present.
   */
  _parseStructuredResponse(text) {
    const planMatch = text.match(/<<<PLAN>>>([\s\S]*?)<<<END_PLAN>>>/);
    if (!planMatch) throw new SyntaxError('No <<<PLAN>>> section found in response');

    // Strip optional markdown code fences the model may add around the JSON
    const planRaw = planMatch[1]
      .replace(/^\s*```[\w]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    const plan = JSON.parse(planRaw);

    // Extract <<<FILE: path>>> ... <<<END_FILE>>> blocks
    const contentByPath = {};
    const fileRegex = /<<<FILE:\s*(.+?)>>>([\s\S]*?)<<<END_FILE>>>/g;
    let m;
    while ((m = fileRegex.exec(text)) !== null) {
      // Strip a single leading newline that comes from the newline after the marker
      contentByPath[m[1].trim()] = m[2].replace(/^\n/, '');
    }

    plan.fileChanges = (plan.files ?? []).map(f => ({
      path: f.path,
      operation: f.operation ?? 'update',
      content: contentByPath[f.path] ?? '',
    }));

    return plan;
  }

  /**
   * When the LLM output cannot be parsed, this recovery pass sends the broken
   * text back and asks the model to reformat it using the structured format.
   */
  async _recoverJson(brokenText) {
    const system =
      'You are a code response repair assistant. ' +
      'The user will give you a malformed or truncated LLM response that was supposed to contain a bug fix. ' +
      'Your job: output a complete, valid response using the <<<PLAN>>> / <<<FILE>>> format described below. ' +
      'Return ONLY the reformatted response — no extra explanations.';
    const head = brokenText.slice(0, 2000);
    const tail = brokenText.slice(-4000);
    const separator = head.length + tail.length < brokenText.length ? '\n[... middle omitted ...]\n' : '';
    const userPrompt =
      'The following bug-fix response is malformed or truncated. Repair and complete it.\n' +
      'Use this EXACT format:\n\n' +
      '<<<PLAN>>>\n{\n  "prTitle": "...",\n  "prDescription": "...",\n  "commitMessage": "...",\n' +
      '  "testHints": "...",\n  "breakingChange": false,\n  "rollbackPlan": "...",\n' +
      '  "files": [{"path": "exact/path", "operation": "update"}]\n}\n<<<END_PLAN>>>\n\n' +
      '<<<FILE: exact/path>>>\nfull file content here\n<<<END_FILE>>>\n\n' +
      '--- BROKEN RESPONSE ---\n' + head + separator + tail;
    return await this.llm.call('code', system, userPrompt, 8192);
  }

  /**
   * Fetch best practices from Context7 for the frameworks involved in this fix.
   * Returns '' on any failure (non-blocking).
   */
  async _fetchBestPractices(analysis) {
    if (!this.ctx7) return '';

    const { backend, frontend } = this.config.stack ?? {};
    // Split compound names like "JavaScript/React" or "Node.js/Express" into individual frameworks
    const rawNames = [backend, frontend].filter(Boolean);
    const frameworks = [...new Set(
      rawNames.flatMap(f => f.split(/[/,]/)).map(f => f.trim()).filter(Boolean)
    )].slice(0, 3);
    if (!frameworks.length) return '';

    const topic = [
      analysis.bugType ?? '',
      analysis.suggestedApproach?.slice(0, 80) ?? '',
    ].filter(Boolean).join(' ');

    try {
      logger.info(`[CodeAgent] Fetching Context7 best practices for: ${frameworks.join(', ')}`);
      // Keep Context7 tokens small: total across all libs must leave room for file contents + JSON response.
      // 800 tokens per lib × 3 libs max = ~2400 tokens (~3000 chars), well within budget.
      const docs = await this.ctx7.getBestPractices(frameworks, topic, 800);
      if (docs) logger.info(`[CodeAgent] Context7 docs injected (${docs.length} chars)`);
      return docs;
    } catch (e) {
      logger.warn('[CodeAgent] Context7 fetch failed (skipping): ' + e.message);
      return '';
    }
  }
}
