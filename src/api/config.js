/**
 * Config loader
 * Reads all environment variables and returns a typed config object.
 */

export function loadConfig() {
  const required = ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
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

    // Cadeia de fallback enviada ao OpenRouter (route: "fallback").
    // O OpenRouter tenta os modelos em ordem; se o primário falhar por quota/rate-limit
    // o próximo da lista é usado automaticamente — sem retry na aplicação.
    // OpenRouter limita o array `models` a 3 itens (1 primário + 2 fallbacks).
    // Sobrescrito por MODEL_FALLBACKS_<AGENT>=model1,model2 (vírgula, sem espaços).
    modelFallbacks: {
      analysis: (process.env.MODEL_FALLBACKS_ANALYSIS ?? 'qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5').split(',').slice(0, 2),
      code: (process.env.MODEL_FALLBACKS_CODE ?? 'deepseek/deepseek-chat,google/gemini-flash-1.5').split(',').slice(0, 2),
      test: (process.env.MODEL_FALLBACKS_TEST ?? 'deepseek/deepseek-chat,google/gemini-flash-1.5').split(',').slice(0, 2),
      ticket: (process.env.MODEL_FALLBACKS_TICKET ?? 'deepseek/deepseek-chat,qwen/qwen2.5-coder-7b-instruct').split(',').slice(0, 2),
      documentation: (process.env.MODEL_FALLBACKS_DOCUMENTATION ?? 'qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5').split(',').slice(0, 2),
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
