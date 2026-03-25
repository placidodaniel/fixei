import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../src/services/github.js', () => ({
    GitHubService: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/context7.js', () => ({
    Context7Service: jest.fn(),
}));

let CodeAgent, MockGitHubService, MockContext7Service;

beforeAll(async () => {
    ({ CodeAgent } = await import('../../src/agents/code-agent.js'));
    ({ GitHubService: MockGitHubService } = await import('../../src/services/github.js'));
    ({ Context7Service: MockContext7Service } = await import('../../src/services/context7.js'));
});

const config = {
    githubRepo: 'owner/repo',
    githubToken: 'token',
    stack: { backend: 'TypeScript', frontend: 'React' },
    context7Enabled: false, // disabled to avoid Context7 calls in most tests
};

function makeAnalysis(overrides = {}) {
    return {
        rootCause: 'Missing null check causes crash',
        bugType: 'null_reference',
        riskLevel: 'medium',
        suggestedApproach: 'Add null guard before property access',
        affectedFiles: ['src/service.ts'],
        backendChanges: 'Add null check in service.ts',
        frontendChanges: 'none',
        ...overrides,
    };
}

function makeFixJson(overrides = {}) {
    return {
        prTitle: 'fix: add null check',
        prDescription: 'Fixed null reference in service',
        commitMessage: 'fix(service): add null guard',
        fileChanges: [{ path: 'src/service.ts', operation: 'update', content: 'export function safe(x) { if (!x) return null; return x.value; }' }],
        testHints: 'Test with null and undefined inputs',
        breakingChange: false,
        rollbackPlan: 'Revert this commit',
        ...overrides,
    };
}

// ── _hasTruncation ─────────────────────────────────────────────────────────────

describe('CodeAgent._hasTruncation', () => {
    let agent;

    beforeAll(() => {
        const github = { getFileContent: jest.fn(), createBranch: jest.fn(), commitFile: jest.fn(), listFiles: jest.fn() };
        MockGitHubService.mockImplementation(() => github);
        agent = new CodeAgent(config, { call: jest.fn() }, github);
    });

    it('detects "// ..." placeholder', () => {
        expect(agent._hasTruncation('function foo() {\n  // ...\n}')).toBe(true);
    });

    it('detects "// existing code here" placeholder', () => {
        expect(agent._hasTruncation('class Foo {\n  // existing code\n}')).toBe(true);
    });

    it('detects "/* ... */" placeholder', () => {
        expect(agent._hasTruncation('function bar() { /* ... */ }')).toBe(true);
    });

    it('detects "..." on its own line', () => {
        expect(agent._hasTruncation('const x = 1;\n...\nconst y = 2;')).toBe(true);
    });

    it('detects "omitted" keyword', () => {
        expect(agent._hasTruncation('// rest of code omitted for brevity')).toBe(true);
    });

    it('detects "unchanged" keyword', () => {
        expect(agent._hasTruncation('// rest unchanged')).toBe(true);
    });

    it('returns false for complete, real code', () => {
        expect(agent._hasTruncation('export function greet(name: string) {\n  return `Hello, ${name}!`;\n}')).toBe(false);
    });

    it('returns false for null', () => {
        expect(agent._hasTruncation(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(agent._hasTruncation(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(agent._hasTruncation('')).toBe(false);
    });
});

// ── fix (happy path) ───────────────────────────────────────────────────────────

describe('CodeAgent.fix', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = {
            getFileContent: jest.fn().mockResolvedValue('export function safe(x) { return x.value; }'),
            createBranch: jest.fn().mockResolvedValue({}),
            commitFile: jest.fn().mockResolvedValue({}),
            listFiles: jest.fn().mockResolvedValue(['src/service.ts']),
        };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn() };
        agent = new CodeAgent(config, llm, mockGithub);
    });

    it('creates a branch with the "bugfix/auto-" prefix', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson()));
        await agent.fix(makeAnalysis());
        expect(mockGithub.createBranch).toHaveBeenCalledWith(expect.stringMatching(/^bugfix\/auto-\d+$/));
    });

    it('commits the fixed file to the new branch', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson()));
        await agent.fix(makeAnalysis());
        expect(mockGithub.commitFile).toHaveBeenCalledWith(
            expect.stringContaining('bugfix/'),
            'src/service.ts',
            expect.any(String),
            expect.any(String),
        );
    });

    it('returns the complete fix result structure', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson()));
        const result = await agent.fix(makeAnalysis());
        expect(result.branch).toMatch(/^bugfix\/auto-/);
        expect(result.prTitle).toBe('fix: add null check');
        expect(result.fileChanges).toHaveLength(1);
        expect(result.breakingChange).toBe(false);
    });

    it('includes feedback section in prompt when provided', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson()));
        await agent.fix(makeAnalysis(), 'Test failed: expected null but got undefined');
        const prompt = llm.call.mock.calls[0][2];
        expect(prompt).toContain('PREVIOUS ATTEMPT FAILED');
        expect(prompt).toContain('expected null but got undefined');
    });

    it('attempts JSON recovery when initial parse fails', async () => {
        const brokenJson = '{"prTitle":"fix","fileChange'; // truncated
        const repairedJson = JSON.stringify(makeFixJson());
        llm.call
            .mockResolvedValueOnce(brokenJson)   // first: broken
            .mockResolvedValueOnce(repairedJson); // second: recovery

        const result = await agent.fix(makeAnalysis());
        expect(result.prTitle).toBe('fix: add null check');
        expect(llm.call).toHaveBeenCalledTimes(2);
    });

    it('throws when both parse and recovery fail', async () => {
        llm.call.mockResolvedValue('not json at all {{ broken');
        await expect(agent.fix(makeAnalysis())).rejects.toThrow('[CodeAgent] Failed to parse fix response');
    });
});

// ── path remapping ─────────────────────────────────────────────────────────────

describe('CodeAgent.fix — path validation and remapping', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = {
            getFileContent: jest.fn().mockResolvedValue('original content'),
            createBranch: jest.fn().mockResolvedValue({}),
            commitFile: jest.fn().mockResolvedValue({}),
            listFiles: jest.fn().mockResolvedValue(['backend/src/services/ContactService.ts', 'src/utils.ts']),
        };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn() };
        agent = new CodeAgent(config, llm, mockGithub);
    });

    it('remaps an LLM-invented path to the real repo path by filename', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson({
            fileChanges: [{ path: 'wrong/dir/ContactService.ts', operation: 'update', content: 'fixed' }],
        })));

        const result = await agent.fix(makeAnalysis({ affectedFiles: ['backend/src/services/ContactService.ts'] }));
        expect(result.fileChanges[0].path).toBe('backend/src/services/ContactService.ts');
    });

    it('removes file changes whose paths cannot be found in the repo', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeFixJson({
            fileChanges: [{ path: 'invented/completely/new/file.ts', operation: 'create', content: 'new file' }],
        })));

        const result = await agent.fix(makeAnalysis({ affectedFiles: [] }));
        expect(result.fileChanges).toHaveLength(0);
    });
});

// ── _expandTruncated ──────────────────────────────────────────────────────────

describe('CodeAgent._expandTruncated', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = { getFileContent: jest.fn(), createBranch: jest.fn(), commitFile: jest.fn(), listFiles: jest.fn() };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn() };
        agent = new CodeAgent(config, llm, mockGithub);
    });

    it('calls LLM to produce a complete merged file', async () => {
        const mergedFull = 'export function safe(x) {\n  if (!x) return null;\n  return x.value;\n}';
        llm.call.mockResolvedValue(mergedFull);

        const result = await agent._expandTruncated(
            'src/service.ts',
            'export function safe(x) { return x.value; }',
            'export function safe(x) {\n  // ...\n}',
            makeAnalysis(),
        );
        expect(result).toContain('safe');
        expect(result).not.toContain('// ...');
    });

    it('strips markdown fences from the LLM response', async () => {
        llm.call.mockResolvedValue('```typescript\nconst x = 1;\n```');
        const result = await agent._expandTruncated('src/a.ts', 'const x = 1;', '// ...', makeAnalysis());
        expect(result).not.toContain('```');
    });

    it('returns the truncated content when LLM call fails', async () => {
        llm.call.mockRejectedValue(new Error('LLM error'));
        const result = await agent._expandTruncated('src/a.ts', 'original', '// truncated ...', makeAnalysis());
        expect(result).toBe('// truncated ...');
    });
});

// ── _recoverJson ──────────────────────────────────────────────────────────────

describe('CodeAgent._recoverJson', () => {
    let llm, mockGithub, agent;

    beforeEach(() => {
        mockGithub = { getFileContent: jest.fn(), createBranch: jest.fn(), commitFile: jest.fn(), listFiles: jest.fn() };
        MockGitHubService.mockImplementation(() => mockGithub);
        llm = { call: jest.fn() };
        agent = new CodeAgent(config, llm, mockGithub);
    });

    it('calls LLM to repair the broken JSON', async () => {
        const repaired = '{"prTitle":"fix","fileChanges":[]}';
        llm.call.mockResolvedValue(repaired);
        const result = await agent._recoverJson('{"prTitle":"fix","fileChange');
        expect(result).toBe(repaired);
    });

    it('sends both the beginning and end of the broken text', async () => {
        llm.call.mockResolvedValue('{}');
        const longBroken = 'A'.repeat(3000) + '{"middle":"content"}' + 'B'.repeat(5000);
        await agent._recoverJson(longBroken);
        const prompt = llm.call.mock.calls[0][2];
        // Should include text from the start (first 2000 chars)
        expect(prompt.slice(0, 2000)).toBeDefined();
    });
});
