/**
 * Config loader
 * Reads all environment variables and returns a typed config object.
 */

export function loadConfig() {
  const required = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    // Claude
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,

    // GitHub
    githubToken:     process.env.GITHUB_TOKEN,
    githubRepo:      process.env.GITHUB_REPO,       // "owner/repo"
    defaultBranch:   process.env.DEFAULT_BRANCH ?? 'main',
    webhookSecret:   process.env.GITHUB_WEBHOOK_SECRET ?? null,
    ciWorkflowId:    process.env.CI_WORKFLOW_ID ?? 'ci.yml',
    ciTimeoutMs:     parseInt(process.env.CI_TIMEOUT_MS ?? '600000', 10),
    autoMerge:       process.env.AUTO_MERGE !== 'false',
    mergeMethod:     process.env.MERGE_METHOD ?? 'squash',
    deployEnvironment: process.env.DEPLOY_ENV ?? 'production',

    // Jira (optional)
    ticketProvider:       process.env.TICKET_PROVIDER ?? 'github', // 'github' | 'jira'
    jiraBaseUrl:          process.env.JIRA_BASE_URL ?? null,
    jiraEmail:            process.env.JIRA_EMAIL ?? null,
    jiraToken:            process.env.JIRA_TOKEN ?? null,
    jiraTransitionDoneId: process.env.JIRA_TRANSITION_DONE_ID ?? '31',

    // Slack (optional)
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL ?? null,
      channel:    process.env.SLACK_CHANNEL ?? '#engineering',
    },

    // Pipeline behavior
    triggerLabel:          process.env.TRIGGER_LABEL ?? 'ai-fix',
    maxRetries:            parseInt(process.env.MAX_RETRIES ?? '3', 10),
    commitGeneratedTests:  process.env.COMMIT_TESTS !== 'false',
  };
}
