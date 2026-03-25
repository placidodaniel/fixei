import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../src/services/github.js', () => ({
    GitHubService: jest.fn(),
}));

let TestAgent, MockGitHubService;

beforeAll(async () => {
    ({ TestAgent } = await import('../../src/agents/test-agent.js'));
    ({ GitHubService: MockGitHubService } = await import('../../src/services/github.js'));
});

const config = {
    githubRepo: 'owner/repo',
    githubToken: 'token',
    ciWorkflowId: 'ci.yml',
    ciTimeoutMs: 100, // very short for tests
    commitGeneratedTests: true,
};

function makeFix(overrides = {}) {
    return {
        branch: 'bugfix/auto-123',
        prTitle: 'fix: null check',
        fileChanges: [{ path: 'src/service.ts', content: 'export function safe(x) { return x ?? null; }' }],
        testHints: 'Test with null inputs',
        ...overrides,
    };
}

function makeAnalysis(overrides = {}) {
    return {
        rootCause: 'Missing null check',
        bugType: 'null_reference',
        affectedFiles: ['src/service.ts'],
        ...overrides,
    };
}

// Helper: create a mock fetch that simulates a full CI polling cycle
function makeCiFetch({ conclusion = 'success', steps = [{ conclusion: 'success' }, { conclusion: 'success' }] } = {}) {
    let callCount = 0;
    return jest.fn().mockImplementation(async (url) => {
        callCount++;
        // trigger dispatch
        if (url.includes('dispatches')) return { ok: true, status: 204 };
        // list runs
        if (url.includes('/runs?branch=')) {
            return {
                ok: true,
                json: async () => ({ workflow_runs: [{ id: 42, html_url: 'https://github.com/runs/42' }] }),
            };
        }
        // get run status
        if (url.includes('/runs/42') && !url.includes('/jobs')) {
            return {
                ok: true,
                json: async () => ({ id: 42, status: 'completed', conclusion, html_url: 'https://github.com/runs/42', run_attempt: 1 }),
            };
        }
        // get jobs
        if (url.includes('/jobs')) {
            return {
                ok: true,
                json: async () => ({
                    jobs: [{ steps }],
                }),
            };
        }
        return { ok: true, json: async () => ({}) };
    });
}

// ── _resolveTestPath ──────────────────────────────────────────────────────────

describe('TestAgent._resolveTestPath', () => {
    let agent;

    beforeEach(() => {
        const github = { commitFile: jest.fn(), getFileContent: jest.fn() };
        MockGitHubService.mockImplementation(() => github);
        agent = new TestAgent(config, { call: jest.fn() }, github);
    });

    it('returns "tests/auto-generated.test.js" when no path is provided', () => {
        expect(agent._resolveTestPath(null)).toBe('tests/auto-generated.test.js');
        expect(agent._resolveTestPath(undefined)).toBe('tests/auto-generated.test.js');
    });

    it('converts a backend/src path by replacing /src/ with /tests/', () => {
        const result = agent._resolveTestPath('backend/src/controllers/ContactController.ts');
        expect(result).toBe('backend/tests/controllers/ContactController.test.ts');
    });

    it('converts a frontend/src path by replacing /src/ with /tests/', () => {
        const result = agent._resolveTestPath('frontend/src/components/ContactForm.jsx');
        expect(result).toBe('frontend/tests/components/ContactForm.test.js');
    });

    it('appends .test.ts to a bare src/ path (no /src/ substring)', () => {
        // 'src/service.ts' does NOT contain the substring '/src/'
        const result = agent._resolveTestPath('src/service.ts');
        expect(result).toBe('src/service.test.ts');
    });

    it('uses .js extension for .js source files', () => {
        const result = agent._resolveTestPath('backend/src/utils/helper.js');
        expect(result).toBe('backend/tests/utils/helper.test.js');
    });
});

// ── _generateTests ────────────────────────────────────────────────────────────

describe('TestAgent._generateTests', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = { commitFile: jest.fn().mockResolvedValue({}) };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn() };
        agent = new TestAgent(config, llm, mockGithub);
    });

    it('returns the LLM-generated test file content', async () => {
        llm.call.mockResolvedValue('import { describe, it } from "@jest/globals";\ndescribe("safe", () => {});');
        const tests = await agent._generateTests(makeFix(), makeAnalysis());
        expect(tests).toContain('describe');
    });

    it('includes the rootCause in the prompt', async () => {
        llm.call.mockResolvedValue('test content');
        await agent._generateTests(makeFix(), makeAnalysis({ rootCause: 'Missing null check in getUser()' }));
        const prompt = llm.call.mock.calls[0][2];
        expect(prompt).toContain('Missing null check in getUser()');
    });

    it('includes testHints from the fix in the prompt', async () => {
        llm.call.mockResolvedValue('test content');
        await agent._generateTests(makeFix({ testHints: 'Test with undefined and empty string' }), makeAnalysis());
        const prompt = llm.call.mock.calls[0][2];
        expect(prompt).toContain('Test with undefined and empty string');
    });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('TestAgent.run', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = { commitFile: jest.fn().mockResolvedValue({}) };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn().mockResolvedValue('describe("test", () => { it("works", () => {}); });') };
        agent = new TestAgent(config, llm, mockGithub);
        // Suppress the 5s sleep in _triggerCI
        agent._sleep = jest.fn().mockResolvedValue(undefined);
    });

    it('commits generated tests to the branch', async () => {
        global.fetch = makeCiFetch();
        await agent.run(makeFix(), makeAnalysis());
        expect(mockGithub.commitFile).toHaveBeenCalledWith(
            'bugfix/auto-123',
            expect.stringContaining('test'),
            expect.any(String),
            expect.any(String),
        );
    });

    it('returns passed=1 and correct ciRunUrl on CI success', async () => {
        global.fetch = makeCiFetch({ conclusion: 'success' });
        const result = await agent.run(makeFix(), makeAnalysis());
        expect(result.passed).toBeGreaterThan(0);
        expect(result.ciRunUrl).toBe('https://github.com/runs/42');
        expect(result.failureDetails).toBeNull();
    });

    it('returns passed=0 and failureDetails on CI failure', async () => {
        global.fetch = makeCiFetch({ conclusion: 'failure', steps: [{ conclusion: 'failure' }] });
        llm.call
            .mockResolvedValueOnce('test file content')  // _generateTests
            .mockResolvedValueOnce('The test "safe returns null" failed because x was undefined'); // _interpretFailure
        const result = await agent.run(makeFix(), makeAnalysis());
        expect(result.passed).toBe(0);
        expect(result.failureDetails).toBeDefined();
    });

    it('does NOT commit tests when commitGeneratedTests is false', async () => {
        const agentNoCi = new TestAgent({ ...config, commitGeneratedTests: false }, llm, mockGithub);
        agentNoCi._sleep = jest.fn().mockResolvedValue(undefined);
        global.fetch = makeCiFetch();
        await agentNoCi.run(makeFix(), makeAnalysis());
        expect(mockGithub.commitFile).not.toHaveBeenCalled();
    });

    it('throws when CI times out', async () => {
        // Mock fetch to always return in_progress status
        global.fetch = jest.fn().mockImplementation(async (url) => {
            if (url.includes('dispatches')) return { ok: true, status: 204 };
            if (url.includes('/runs?branch=')) {
                return { ok: true, json: async () => ({ workflow_runs: [{ id: 99, html_url: 'url' }] }) };
            }
            // Always in_progress
            return { ok: true, json: async () => ({ id: 99, status: 'in_progress', conclusion: null }) };
        });
        agent._sleep = jest.fn().mockResolvedValue(undefined);
        await expect(agent.run(makeFix(), makeAnalysis())).rejects.toThrow('CI timed out');
    });
});
