/**
 * Config loader
 * Reads all environment variables and returns a typed config object.
 */

export function loadConfig() {
  const llmProvider = process.env.LLM_PROVIDER ?? 'openrouter'; // 'openrouter' | 'ollama'

  const required = llmProvider === 'ollama'
    ? ['GITHUB_TOKEN', 'GITHUB_REPO']
    : ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    // LLM provider ('openrouter' or 'ollama')
    llmProvider,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',

    // OpenRouter (unified LLM provider)
    openRouterApiKey: process.env.OPENROUTER_API_KEY,

    // Modelo primário por agente (sobrescrito via env vars)
    models: {
      analysis: process.env.MODEL_ANALYSIS ?? 'anthropic/claude-3.5-sonnet',
      code: process.env.MODEL_CODE ?? 'anthropic/claude-3.5-sonnet',
      test: process.env.MODEL_TEST ?? 'anthropic/claude-3.5-sonnet',
      ticket: process.env.MODEL_TICKET ?? 'anthropic/claude-3.5-sonnet',
      documentation: process.env.MODEL_DOCUMENTATION ?? process.env.MODEL_ANALYSIS ?? 'anthropic/claude-3.5-sonnet',
    },

    // GitHub
    githubToken: process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITHUB_REPO,       // "owner/repo"
    defaultBranch: process.env.DEFAULT_BRANCH ?? 'main',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
    ciWorkflowId: process.env.CI_WORKFLOW_ID ?? 'ci.yml',
    ciTimeoutMs: parseInt(process.env.CI_TIMEOUT_MS ?? '600000', 10),
    autoMerge: process.env.AUTO_MERGE !== 'false',
    mergeMethod: process.env.MERGE_METHOD ?? 'squash',
    deployEnvironment: process.env.DEPLOY_ENV ?? 'production',

    // Jira (optional)
    ticketProvider: process.env.TICKET_PROVIDER ?? 'github', // 'github' | 'jira'
    jiraBaseUrl: process.env.JIRA_BASE_URL ?? null,
    jiraEmail: process.env.JIRA_EMAIL ?? null,
    jiraToken: process.env.JIRA_TOKEN ?? null,
    jiraTransitionDoneId: process.env.JIRA_TRANSITION_DONE_ID ?? '31',

    // Slack (optional)
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL ?? null,
      channel: process.env.SLACK_CHANNEL ?? '#engineering',
    },

    // Pipeline behavior
    triggerLabel: process.env.TRIGGER_LABEL ?? 'ai-fix',
    maxRetries: parseInt(process.env.MAX_RETRIES ?? '3', 10),
    commitGeneratedTests: process.env.COMMIT_TESTS !== 'false',

    // Context7 — inject framework best practices into code agent prompts
    context7Enabled: process.env.CONTEXT7_ENABLED !== 'false', // enabled by default
    context7TokensPerLib: parseInt(process.env.CONTEXT7_TOKENS ?? '2500', 10),

    // Stack languages (used to guide LLM analysis and code generation)
    stack: {
      backend: process.env.STACK_BACKEND ?? 'unknown',   // e.g. TypeScript, Python, Ruby
      frontend: process.env.STACK_FRONTEND ?? 'unknown', // e.g. Vue, React, Angular
    },
  };
}
