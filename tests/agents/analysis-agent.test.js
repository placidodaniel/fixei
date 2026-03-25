import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../src/services/github.js', () => ({
    GitHubService: jest.fn(),
}));

let AnalysisAgent, MockGitHubService;

beforeAll(async () => {
    ({ AnalysisAgent } = await import('../../src/agents/analysis-agent.js'));
    ({ GitHubService: MockGitHubService } = await import('../../src/services/github.js'));
});

const config = {
    githubRepo: 'owner/repo',
    stack: { backend: 'TypeScript', frontend: 'React' },
};

function makeTicket(overrides = {}) {
    return {
        id: '101',
        title: 'Save button does nothing',
        description: 'When clicking save, nothing happens and no error is shown',
        stepsToReproduce: ['Open form', 'Click save'],
        expectedBehavior: 'Contact is saved',
        actualBehavior: 'Nothing happens',
        rawLogs: '',
        environment: {},
        _raw: { number: 101 },
        ...overrides,
    };
}

function makeAnalysisResponse(overrides = {}) {
    return {
        confirmed: true,
        reason: 'onClick handler missing',
        rootCause: 'Event handler not bound in ContactForm',
        codeLocations: [{ file: 'frontend/src/components/ContactForm/index.js', line: 42, layer: 'frontend', description: 'missing handler' }],
        affectedFiles: ['frontend/src/components/ContactForm/index.js'],
        affectedFunctions: ['handleSave'],
        bugType: 'logic_error',
        backendChanges: 'none',
        frontendChanges: 'Add error handling in ContactForm',
        suggestedApproach: 'Bind the onClick handler and display error messages',
        riskLevel: 'low',
        estimatedComplexity: 'simple',
        ...overrides,
    };
}

describe('AnalysisAgent.analyze', () => {
    let llm, mockGithub, vectorStore;

    beforeEach(() => {
        mockGithub = {
            listFiles: jest.fn().mockResolvedValue([
                'src/api.ts',
                'frontend/src/components/ContactForm/index.js',
                'backend/src/controllers/ContactController.ts',
            ]),
            getFileContent: jest.fn().mockResolvedValue('const x = 1; // file content'),
            postAnalysisComment: jest.fn().mockResolvedValue({}),
        };
        MockGitHubService.mockImplementation(() => mockGithub);

        llm = { call: jest.fn() };

        vectorStore = {
            isReady: true,
            _buildPromise: null,
            build: jest.fn().mockResolvedValue(null),
            waitReady: jest.fn().mockResolvedValue(null),
            searchPaths: jest.fn().mockResolvedValue([
                'frontend/src/components/ContactForm/index.js',
                'backend/src/controllers/ContactController.ts',
            ]),
        };
    });

    it('returns a structured analysis result when LLM confirms the bug', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        const result = await agent.analyze(makeTicket(), 'docs');

        expect(result.confirmed).toBe(true);
        expect(result.bugType).toBe('logic_error');
        expect(result.affectedFiles).toContain('frontend/src/components/ContactForm/index.js');
        expect(result.riskLevel).toBe('low');
    });

    it('uses vector search path when vectorStore.isReady is true', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        await agent.analyze(makeTicket(), '');

        expect(vectorStore.searchPaths).toHaveBeenCalled();
        // Only ONE llm.call: the final analysis. No triage rounds.
        expect(llm.call.mock.calls.length).toBe(1);
    });

    it('triggers on-demand build and waits when vectorStore exists but index is not ready', async () => {
        vectorStore.isReady = false;
        vectorStore._buildPromise = null;
        // After build, become ready
        vectorStore.build.mockImplementation(async () => {
            vectorStore.isReady = true;
        });
        vectorStore.waitReady.mockResolvedValue(undefined);

        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        await agent.analyze(makeTicket(), '');

        expect(vectorStore.build).toHaveBeenCalled();
        expect(vectorStore.waitReady).toHaveBeenCalled();
    });

    it('falls back to LLM triage rounds when vectorStore is null and no index ready', async () => {
        // First call = triage round returning files, second = triage returning []
        // Third call = final analysis
        llm.call
            .mockResolvedValueOnce('["backend/src/controllers/ContactController.ts"]') // triage round 1
            .mockResolvedValueOnce('[]') // triage round 2 → done
            .mockResolvedValue(JSON.stringify(makeAnalysisResponse())); // analysis

        const agent = new AnalysisAgent(config, llm, mockGithub, null);
        const result = await agent.analyze(makeTicket(), '');

        expect(result.confirmed).toBe(true);
        // At least 2 llm.call invocations (triage + analysis)
        expect(llm.call.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('posts an analysis comment to the GitHub issue', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        await agent.analyze(makeTicket(), '');

        expect(mockGithub.postAnalysisComment).toHaveBeenCalledWith(
            101,
            expect.objectContaining({ confirmed: true }),
        );
    });

    it('returns a default confirmed:true fallback when LLM response cannot be parsed', async () => {
        llm.call.mockResolvedValue('I cannot analyze this. The code is unavailable.');
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        const result = await agent.analyze(makeTicket(), '');

        expect(result.confirmed).toBe(true);
        expect(result.rootCause).toBeDefined();
    });

    it('handles empty repo gracefully (no files found)', async () => {
        mockGithub.listFiles.mockResolvedValue([]);
        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        const result = await agent.analyze(makeTicket(), '');
        expect(result).toBeDefined();
    });

    it('includes codebase docs in the LLM prompt', async () => {
        llm.call.mockResolvedValue(JSON.stringify(makeAnalysisResponse()));
        const agent = new AnalysisAgent(config, llm, mockGithub, vectorStore);
        await agent.analyze(makeTicket(), '## Architecture\nBackend is NestJS');

        const prompt = llm.call.mock.calls[0][2];
        expect(prompt).toContain('Architecture');
        expect(prompt).toContain('NestJS');
    });
});
