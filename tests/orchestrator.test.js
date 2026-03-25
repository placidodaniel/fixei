import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

// ── Mock all services and agents before any import ────────────────────────────

const mockStateManager = {
    save: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
};
jest.unstable_mockModule('../src/services/state-manager.js', () => ({
    StateManager: jest.fn(() => mockStateManager),
}));

const mockNotify = { send: jest.fn().mockResolvedValue(undefined) };
jest.unstable_mockModule('../src/services/notification.js', () => ({
    NotificationService: jest.fn(() => mockNotify),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGithub = {
    getFileContent: jest.fn(),
    postAuditComment: jest.fn().mockResolvedValue(undefined),
    listFiles: jest.fn().mockResolvedValue([]),
};
jest.unstable_mockModule('../src/services/github.js', () => ({
    GitHubService: jest.fn(() => mockGithub),
}));

const mockVectorStore = {
    load: jest.fn().mockResolvedValue(undefined),
    waitReady: jest.fn().mockResolvedValue(undefined),
    scheduleBuild: jest.fn(),
    build: jest.fn().mockResolvedValue(undefined),
    isReady: true,
    _buildPromise: null,
};
jest.unstable_mockModule('../src/services/vector-store.js', () => ({
    VectorStoreService: jest.fn(() => mockVectorStore),
}));

const mockTicketAgent = {
    parse: jest.fn(),
    closeAsFixed: jest.fn().mockResolvedValue(undefined),
    closeAsInvalid: jest.fn().mockResolvedValue(undefined),
    escalate: jest.fn().mockResolvedValue(undefined),
};
jest.unstable_mockModule('../src/agents/ticket-agent.js', () => ({
    TicketAgent: jest.fn(() => mockTicketAgent),
}));

const mockAnalysisAgent = { analyze: jest.fn() };
jest.unstable_mockModule('../src/agents/analysis-agent.js', () => ({
    AnalysisAgent: jest.fn(() => mockAnalysisAgent),
}));

const mockCodeAgent = { fix: jest.fn() };
jest.unstable_mockModule('../src/agents/code-agent.js', () => ({
    CodeAgent: jest.fn(() => mockCodeAgent),
}));

const mockTestAgent = { run: jest.fn() };
jest.unstable_mockModule('../src/agents/test-agent.js', () => ({
    TestAgent: jest.fn(() => mockTestAgent),
}));

const mockDeployAgent = { deploy: jest.fn() };
jest.unstable_mockModule('../src/agents/deploy-agent.js', () => ({
    DeployAgent: jest.fn(() => mockDeployAgent),
}));

const mockDocAgent = { ensureDocumented: jest.fn() };
jest.unstable_mockModule('../src/agents/documentation-agent.js', () => ({
    DocumentationAgent: jest.fn(() => mockDocAgent),
}));

// ── Load Orchestrator after mocks ─────────────────────────────────────────────

let Orchestrator;

beforeAll(async () => {
    ({ Orchestrator } = await import('../src/orchestrator.js'));
});

// ── Test data helpers ─────────────────────────────────────────────────────────

const CONFIG = {
    githubRepo: 'owner/repo',
    defaultBranch: 'main',
    models: {
        ticket: 'gpt-4',
        analysis: 'gpt-4',
        code: 'gpt-4',
        test: 'gpt-4',
    },
    maxRetries: 2,
    stack: { backend: 'Node.js', frontend: 'React' },
    slack: { webhookUrl: 'https://hooks.slack.com/fake' },
};

const TICKET_PAYLOAD = { id: '42', title: 'Bug report', body: 'Something broke' };

const PARSED_TICKET = {
    id: '42',
    title: 'Contact form save error',
    type: 'bug',
    severity: 'medium',
    labels: ['bug'],
    description: 'When saving a contact, no error is shown',
    _raw: { number: 42 },
};

const ANALYSIS_OK = {
    confirmed: true,
    reason: 'Bug reproduced',
    rootCause: 'Missing validation in ContactController.store',
    bugType: 'logic',
    riskLevel: 'low',
    estimatedComplexity: 'simple',
    affectedFiles: ['backend/src/controllers/ContactController.ts'],
    affectedFunctions: ['store'],
    codeLocations: [],
    backendChanges: ['Add validation'],
    frontendChanges: [],
    suggestedApproach: 'Add try/catch',
};

const FIX_OK = {
    branch: 'fix/contact-form-42',
    prTitle: 'fix: Contact form validation',
    commitMessage: 'fix: add validation to ContactController.store',
    fileChanges: [
        { path: 'backend/src/controllers/ContactController.ts', operation: 'edit', content: 'fixed content' },
    ],
};

const TESTS_PASSED = { passed: 5, total: 5, failureDetails: null };
const DEPLOY_OK = { prUrl: 'https://github.com/owner/repo/pull/99', merged: false };

// ── Helper to reset all mocks before each test ────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockStateManager.save.mockResolvedValue(undefined);
    mockNotify.send.mockResolvedValue(undefined);
    mockVectorStore.load.mockResolvedValue(undefined);
    mockVectorStore.waitReady.mockResolvedValue(undefined);
    mockTicketAgent.parse.mockResolvedValue(PARSED_TICKET);
    mockDocAgent.ensureDocumented.mockResolvedValue('# Docs\n...');
    mockAnalysisAgent.analyze.mockResolvedValue(ANALYSIS_OK);
    mockCodeAgent.fix.mockResolvedValue(FIX_OK);
    mockTestAgent.run.mockResolvedValue(TESTS_PASSED);
    mockDeployAgent.deploy.mockResolvedValue(DEPLOY_OK);
    mockTicketAgent.closeAsFixed.mockResolvedValue(undefined);
    mockTicketAgent.closeAsInvalid.mockResolvedValue(undefined);
    mockTicketAgent.escalate.mockResolvedValue(undefined);
    mockGithub.postAuditComment.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
    describe('constructor', () => {
        it('creates an orchestrator and calls vectorStore.load', () => {
            const orch = new Orchestrator(CONFIG);
            expect(orch).toBeDefined();
            expect(mockVectorStore.load).toHaveBeenCalled();
        });
    });

    describe('run() — happy path', () => {
        it('returns status "success" when all steps succeed', async () => {
            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(result.status).toBe('success');
            expect(result.runId).toMatch(/^run_\d+$/);
        });

        it('calls all pipeline steps in order', async () => {
            const callOrder = [];
            mockTicketAgent.parse.mockImplementation(async () => { callOrder.push('parse'); return PARSED_TICKET; });
            mockDocAgent.ensureDocumented.mockImplementation(async () => { callOrder.push('docs'); return '# Docs'; });
            mockAnalysisAgent.analyze.mockImplementation(async () => { callOrder.push('analyze'); return ANALYSIS_OK; });
            mockCodeAgent.fix.mockImplementation(async () => { callOrder.push('fix'); return FIX_OK; });
            mockTestAgent.run.mockImplementation(async () => { callOrder.push('test'); return TESTS_PASSED; });
            mockDeployAgent.deploy.mockImplementation(async () => { callOrder.push('deploy'); return DEPLOY_OK; });

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            expect(callOrder).toEqual(['parse', 'docs', 'analyze', 'fix', 'test', 'deploy']);
        });

        it('closes the ticket as fixed after successful deploy', async () => {
            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);
            expect(mockTicketAgent.closeAsFixed).toHaveBeenCalledWith(PARSED_TICKET, DEPLOY_OK);
        });

        it('sends a success notification after deploy', async () => {
            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);
            expect(mockNotify.send).toHaveBeenCalledWith(expect.stringContaining('fixed and deployed'));
        });

        it('awaits vectorStore.waitReady between docs and analysis steps', async () => {
            const callOrder = [];
            mockVectorStore.waitReady.mockImplementation(async () => { callOrder.push('waitReady'); });
            mockDocAgent.ensureDocumented.mockImplementation(async () => { callOrder.push('docs'); return '# Docs'; });
            mockAnalysisAgent.analyze.mockImplementation(async () => { callOrder.push('analyze'); return ANALYSIS_OK; });

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            const docsIdx = callOrder.indexOf('docs');
            const waitIdx = callOrder.indexOf('waitReady');
            const analyzeIdx = callOrder.indexOf('analyze');
            expect(docsIdx).toBeLessThan(waitIdx);
            expect(waitIdx).toBeLessThan(analyzeIdx);
        });

        it('posts audit trail to GitHub issue', async () => {
            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);
            expect(mockGithub.postAuditComment).toHaveBeenCalledWith(42, expect.objectContaining({
                auditLog: expect.any(Array),
            }));
        });

        it('saves state multiple times throughout the pipeline', async () => {
            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);
            // updateStatus is called for each pipeline step (parsing, documenting, analyzing, coding, testing, deploying)
            expect(mockStateManager.save).toHaveBeenCalled();
            expect(mockStateManager.save.mock.calls.length).toBeGreaterThan(4);
        });
    });

    describe('run() — analysis not confirmed', () => {
        it('closes ticket as invalid on explicit denial', async () => {
            mockAnalysisAgent.analyze.mockResolvedValue({
                ...ANALYSIS_OK,
                confirmed: false,
                reason: 'The described behavior is expected by design',
                bugType: 'not-a-bug',
            });

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(result.status).toBe('closed_invalid');
            expect(mockTicketAgent.closeAsInvalid).toHaveBeenCalledWith(
                PARSED_TICKET,
                expect.any(String),
            );
        });

        it('forces confirmed=true and continues fix when denial is due to insufficient context', async () => {
            mockAnalysisAgent.analyze.mockResolvedValue({
                ...ANALYSIS_OK,
                confirmed: false,
                reason: 'Insufficient context — could not access code',
                bugType: undefined, // bugType absent → not explicit denial
            });

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            // Bug should NOT be closed as invalid — instead proceeds to fix
            expect(mockTicketAgent.closeAsInvalid).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
        });

        it('forces confirmed=true when reason says "failed"', async () => {
            mockAnalysisAgent.analyze.mockResolvedValue({
                ...ANALYSIS_OK,
                confirmed: false,
                reason: 'Analysis failed due to network error',
            });

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(mockTicketAgent.closeAsInvalid).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
        });
    });

    describe('run() — test failures and retry loop', () => {
        it('retries codeAgent.fix when tests fail', async () => {
            mockTestAgent.run
                .mockResolvedValueOnce({ passed: 0, total: 3, failureDetails: 'AssertionError at line 42' })
                .mockResolvedValueOnce(TESTS_PASSED);

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(mockCodeAgent.fix).toHaveBeenCalledTimes(2);
            expect(result.status).toBe('success');
        });

        it('passes test failureDetails as feedback to codeAgent.fix on retry', async () => {
            const failureDetails = 'TypeError: Cannot read property of undefined at ContactController.ts:55';
            mockTestAgent.run
                .mockResolvedValueOnce({ passed: 0, total: 3, failureDetails })
                .mockResolvedValueOnce(TESTS_PASSED);

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            // Second call to fix() should receive the feedback
            const secondCall = mockCodeAgent.fix.mock.calls[1];
            expect(secondCall[1]).toBe(failureDetails);
        });

        it('escalates after max retries are exceeded', async () => {
            mockTestAgent.run.mockResolvedValue({
                passed: 0,
                total: 3,
                failureDetails: 'AssertionError: expected true, got false',
            });

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(result.status).toBe('escalated');
            expect(mockTicketAgent.escalate).toHaveBeenCalled();
        });

        it('does not deploy when max retries exceeded', async () => {
            mockTestAgent.run.mockResolvedValue({ passed: 0, total: 3, failureDetails: 'fail' });

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            expect(mockDeployAgent.deploy).not.toHaveBeenCalled();
        });
    });

    describe('run() — error handling', () => {
        it('catches pipeline errors and returns status "error"', async () => {
            mockTicketAgent.parse.mockRejectedValue(new Error('GitHub API timeout'));

            const orch = new Orchestrator(CONFIG);
            const result = await orch.run(TICKET_PAYLOAD);

            expect(result.status).toBe('error');
            expect(result.error).toContain('GitHub API timeout');
        });

        it('sends error notification on pipeline exception', async () => {
            mockAnalysisAgent.analyze.mockRejectedValue(new Error('LLM unavailable'));

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            expect(mockNotify.send).toHaveBeenCalledWith(expect.stringContaining('Pipeline failed'));
        });

        it('calls escalate on pipeline exception', async () => {
            mockCodeAgent.fix.mockRejectedValue(new Error('Patch failed'));

            const orch = new Orchestrator(CONFIG);
            await orch.run(TICKET_PAYLOAD);

            expect(mockTicketAgent.escalate).toHaveBeenCalled();
        });
    });

    describe('updateStatus', () => {
        it('saves context with new status', async () => {
            const orch = new Orchestrator(CONFIG);
            const ctx = { runId: 'run_test', status: 'running', auditLog: [] };
            await orch.updateStatus(ctx, 'analyzing');
            expect(ctx.status).toBe('analyzing');
            expect(mockStateManager.save).toHaveBeenCalledWith('run_test', ctx);
        });
    });

    describe('finish', () => {
        it('returns correct shape with runId and status', () => {
            const orch = new Orchestrator(CONFIG);
            const ctx = { runId: 'run_x', auditLog: [] };
            const result = orch.finish(ctx, 'success');
            expect(result).toMatchObject({ runId: 'run_x', status: 'success', error: null });
        });

        it('includes error message on failure', () => {
            const orch = new Orchestrator(CONFIG);
            const ctx = { runId: 'run_x', auditLog: [] };
            const result = orch.finish(ctx, 'error', new Error('boom'));
            expect(result.error).toBe('boom');
        });
    });
});
