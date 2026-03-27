import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fail: jest.fn() },
}));

jest.unstable_mockModule('../../src/services/github.js', () => ({
    GitHubService: jest.fn(),
}));

let DeployAgent, MockGitHubService;

beforeAll(async () => {
    ({ DeployAgent } = await import('../../src/agents/deploy-agent.js'));
    ({ GitHubService: MockGitHubService } = await import('../../src/services/github.js'));
});

const config = {
    githubRepo: 'owner/repo',
    githubToken: 'token',
    defaultBranch: 'main',
    autoMerge: true,
    mergeMethod: 'squash',
    deployEnvironment: 'production',
};

function makeFix(overrides = {}) {
    return {
        branch: 'bugfix/auto-456',
        prTitle: 'fix: handle null user',
        prDescription: 'Fixes null reference when user is not logged in.',
        fileChanges: [{ path: 'src/auth.ts' }],
        breakingChange: false,
        rollbackPlan: 'Revert commit abc123',
        ...overrides,
    };
}

function makeTests(overrides = {}) {
    return {
        passed: 5,
        total: 5,
        failureDetails: null,
        newTestsFile: 'tests/auth.test.ts',
        ciRunUrl: 'https://github.com/runs/99',
        ...overrides,
    };
}

// Fast poll mock: PR is immediately mergeable
function makeMergeableFetch(prNumber = 1) {
    return jest.fn().mockImplementation(async (url, opts = {}) => {
        const method = (opts?.method ?? 'GET').toUpperCase();
        // Create PR (POST /pulls)
        if (url.includes('/pulls') && method === 'POST') {
            return {
                ok: true,
                json: async () => ({ number: prNumber, html_url: `https://github.com/pr/${prNumber}` }),
            };
        }
        // Labels (POST /issues/N/labels)
        if (url.includes('/labels')) {
            return { ok: true, json: async () => ({}) };
        }
        // PR status check (GET /pulls/N) — used by _waitForChecks
        if (url.includes(`/pulls/${prNumber}`) && !url.includes('/merge') && method === 'GET') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ mergeable: true, mergeable_state: 'clean' }),
            };
        }
        // Merge (PUT /pulls/N/merge)
        if (url.includes('/merge')) {
            return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'abc123' }) };
        }
        return { ok: true, json: async () => ({}) };
    });
}

// ── _buildPRBody ──────────────────────────────────────────────────────────────

describe('DeployAgent._buildPRBody', () => {
    let agent;

    beforeEach(() => {
        const github = {};
        MockGitHubService.mockImplementation(() => github);
        agent = new DeployAgent(config, github);
    });

    it('includes the pr description', () => {
        const body = agent._buildPRBody(makeFix(), makeTests());
        expect(body).toContain('Fixes null reference when user is not logged in');
    });

    it('lists all changed files', () => {
        const body = agent._buildPRBody(makeFix(), makeTests());
        expect(body).toContain('src/auth.ts');
    });

    it('shows CI run URL', () => {
        const body = agent._buildPRBody(makeFix(), makeTests());
        expect(body).toContain('https://github.com/runs/99');
    });

    it('shows rollback plan', () => {
        const body = agent._buildPRBody(makeFix(), makeTests());
        expect(body).toContain('Revert commit abc123');
    });

    it('marks breaking change clearly when true', () => {
        const body = agent._buildPRBody(makeFix({ breakingChange: true }), makeTests());
        expect(body).toContain('Yes');
    });

    it('marks breaking change as No when false', () => {
        const body = agent._buildPRBody(makeFix({ breakingChange: false }), makeTests());
        expect(body).toContain('No');
    });
});

// ── deploy ────────────────────────────────────────────────────────────────────

describe('DeployAgent.deploy', () => {
    let mockGithub, agent;

    beforeEach(() => {
        mockGithub = {};
        MockGitHubService.mockImplementation(() => mockGithub);
    });

    it('creates a PR and returns its URL and number', async () => {
        global.fetch = makeMergeableFetch(7);
        agent = new DeployAgent(config, mockGithub);
        const result = await agent.deploy(makeFix(), makeTests());
        expect(result.prUrl).toBe('https://github.com/pr/7');
        expect(result.prNumber).toBe(7);
    });

    it('sets branch from the fix object', async () => {
        global.fetch = makeMergeableFetch(8);
        agent = new DeployAgent(config, mockGithub);
        const result = await agent.deploy(makeFix({ branch: 'bugfix/auto-789' }), makeTests());
        expect(result.branch).toBe('bugfix/auto-789');
    });

    it('auto-merges when autoMerge is true and checks pass', async () => {
        global.fetch = makeMergeableFetch(9);
        agent = new DeployAgent(config, mockGithub);
        const result = await agent.deploy(makeFix(), makeTests());
        expect(result.merged).toBe(true);
        expect(result.environment).toBe('production');
    });

    it('does not auto-merge when autoMerge is false', async () => {
        const noMergeConfig = { ...config, autoMerge: false };
        global.fetch = jest.fn().mockImplementation(async (url) => {
            if (url.includes('/pulls') && !url.includes('/pulls/')) {
                return { ok: true, json: async () => ({ number: 10, html_url: 'https://github.com/pr/10' }) };
            }
            if (url.includes('/labels')) return { ok: true, json: async () => ({}) };
            return { ok: true, json: async () => ({}) };
        });
        agent = new DeployAgent(noMergeConfig, mockGithub);
        const result = await agent.deploy(makeFix(), makeTests());
        expect(result.merged).toBe(false);
        expect(result.environment).toBe('staging');
    });

    it('throws when PR creation fails', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 422,
            text: async () => 'Validation Failed',
        });
        agent = new DeployAgent(config, mockGithub);
        await expect(agent.deploy(makeFix(), makeTests())).rejects.toThrow('PR creation failed');
    });

    it('adds auto-fix and bugfix labels to the PR', async () => {
        const calls = [];
        global.fetch = jest.fn().mockImplementation(async (url, opts = {}) => {
            calls.push({ url, opts });
            const method = (opts?.method ?? 'GET').toUpperCase();
            if (url.includes('/pulls') && method === 'POST') {
                return { ok: true, json: async () => ({ number: 11, html_url: 'https://github.com/pr/11' }) };
            }
            if (url.includes('/labels')) return { ok: true, json: async () => ({}) };
            if (url.includes('/pulls/11') && !url.includes('/merge') && method === 'GET') {
                return { ok: true, status: 200, json: async () => ({ mergeable: true, mergeable_state: 'clean' }) };
            }
            if (url.includes('/merge')) return { ok: true, status: 200, json: async () => ({}) };
            return { ok: true, json: async () => ({}) };
        });

        agent = new DeployAgent(config, mockGithub);
        await agent.deploy(makeFix(), makeTests());

        const labelCall = calls.find(c => c.url.includes('/labels'));
        expect(labelCall).toBeDefined();
        const body = JSON.parse(labelCall.opts.body);
        expect(body.labels).toEqual(expect.arrayContaining(['auto-fix', 'bugfix']));
    });
});
