import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../src/services/github.js', () => ({
    GitHubService: jest.fn(),
}));

let DocumentationAgent, MockGitHubService;

beforeAll(async () => {
    ({ DocumentationAgent } = await import('../../src/agents/documentation-agent.js'));
    ({ GitHubService: MockGitHubService } = await import('../../src/services/github.js'));
});

const config = {
    githubRepo: 'owner/repo',
    defaultBranch: 'main',
    stack: { backend: 'TypeScript/Express', frontend: 'React' },
};

function makeTicket(overrides = {}) {
    return {
        id: '1',
        title: 'Contact form save error',
        description: 'When saving a contact, no error message is shown',
        labels: ['bug'],
        ...overrides,
    };
}

const BACKEND_DOC = `# BACKEND Architecture
## Stack
Node.js + TypeScript + Express

## Routes
- POST /contacts → ContactController.store
- GET  /contacts → ContactController.index

## Services
ContactService, UserService
`;

const FRONTEND_DOC = `# FRONTEND Architecture
## Stack
React + Vite

## Components
- ContactForm — form to add/edit contacts
- ContactModal — modal wrapper for ContactForm

## State Management
React hooks (useContacts)
`;

// ── _needsUpdate ──────────────────────────────────────────────────────────────

describe('DocumentationAgent._needsUpdate', () => {
    let agent;

    beforeEach(() => {
        MockGitHubService.mockImplementation(() => ({}));
        agent = new DocumentationAgent(config, { call: jest.fn() }, {});
    });

    it('returns false when most ticket terms are already in the docs', async () => {
        // Docs contain every significant token from the ticket
        const richDocs =
            '# Architecture\n' +
            'ContactController handles saving contacts with proper error message shown to user.\n' +
            'ContactService manages contact persistence and validation.\n';
        const ticket = makeTicket({
            title: 'ContactController saving error message',
            description: 'When saving a contact, no error message is shown',
        });
        const result = await agent._needsUpdate(richDocs, ticket);
        expect(result).toBe(false);
    });

    it('returns true when many ticket terms are absent from the docs', async () => {
        const result = await agent._needsUpdate('# Short doc\nNothing relevant here.', makeTicket({
            title: 'Stripe payment webhook integration',
            description: 'PaymentService webhook validation fails for charge.succeeded events in pipeline',
        }));
        expect(result).toBe(true);
    });

    it('returns false when the ticket has no significant tokens (all short words)', async () => {
        const result = await agent._needsUpdate('', makeTicket({ title: 'Bug fix', description: 'Bad' }));
        expect(result).toBe(false);
    });
});

// ── ensureDocumented ──────────────────────────────────────────────────────────

describe('DocumentationAgent.ensureDocumented', () => {
    let mockLlm, mockGithub, mockVectorStore, agent;

    beforeEach(() => {
        mockLlm = { call: jest.fn().mockResolvedValue('# Generated\nContent.') };
        mockGithub = {
            getFileContent: jest.fn(),
            commitFile: jest.fn().mockResolvedValue({}),
            listFiles: jest.fn().mockResolvedValue([
                'backend/src/controllers/ContactController.ts',
                'backend/src/services/ContactService.ts',
                'frontend/src/components/ContactForm/index.js',
            ]),
        };
        MockGitHubService.mockImplementation(() => mockGithub);
        mockVectorStore = { scheduleBuild: jest.fn() };
        agent = new DocumentationAgent(config, mockLlm, mockGithub, mockVectorStore);
    });

    it('returns existing docs without LLM call when docs are current', async () => {
        mockGithub.getFileContent
            .mockResolvedValueOnce(BACKEND_DOC)    // BACKEND.md
            .mockResolvedValueOnce(FRONTEND_DOC);  // FRONTEND.md

        // Prevent the update path from interfering
        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        const result = await agent.ensureDocumented(makeTicket());

        expect(result).toContain('BACKEND');
        expect(result).toContain('FRONTEND');
        expect(mockLlm.call).not.toHaveBeenCalled();
    });

    it('generates BACKEND.md when it does not exist', async () => {
        mockGithub.getFileContent
            .mockRejectedValueOnce(new Error('Not Found')) // BACKEND.md missing
            .mockResolvedValueOnce(FRONTEND_DOC)           // FRONTEND.md exists
            .mockRejectedValue(new Error('Not Found'));     // priority file reads → empty context

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        await agent.ensureDocumented(makeTicket());

        expect(mockLlm.call).toHaveBeenCalledTimes(1);
        expect(mockGithub.commitFile).toHaveBeenCalledWith(
            'main',
            '.bugfix-agent/BACKEND.md',
            expect.any(String),
            expect.any(String),
        );
    });

    it('generates FRONTEND.md when it does not exist', async () => {
        mockGithub.getFileContent
            .mockResolvedValueOnce(BACKEND_DOC)             // BACKEND.md exists
            .mockRejectedValueOnce(new Error('Not Found'))  // FRONTEND.md missing
            .mockRejectedValue(new Error('Not Found'));      // priority file reads → empty context

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        await agent.ensureDocumented(makeTicket());

        expect(mockGithub.commitFile).toHaveBeenCalledWith(
            'main',
            '.bugfix-agent/FRONTEND.md',
            expect.any(String),
            expect.any(String),
        );
    });

    it('generates both docs when neither exists', async () => {
        mockGithub.getFileContent.mockRejectedValue(new Error('Not Found'));

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        await agent.ensureDocumented(makeTicket());

        expect(mockGithub.commitFile).toHaveBeenCalledTimes(2);
    });

    it('schedules a vector index rebuild via vectorStore.scheduleBuild', async () => {
        mockGithub.getFileContent
            .mockResolvedValueOnce(BACKEND_DOC)
            .mockResolvedValueOnce(FRONTEND_DOC);

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        await agent.ensureDocumented(makeTicket());

        expect(mockVectorStore.scheduleBuild).toHaveBeenCalled();
    });

    it('returns combined backend + frontend docs when both exist', async () => {
        mockGithub.getFileContent
            .mockResolvedValueOnce(BACKEND_DOC)
            .mockResolvedValueOnce(FRONTEND_DOC);

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(false);

        const result = await agent.ensureDocumented(makeTicket());
        expect(result).toContain('BACKEND');
        expect(result).toContain('FRONTEND');
    });

    it('updates stale docs when _needsUpdate returns true', async () => {
        mockGithub.getFileContent
            .mockResolvedValueOnce(BACKEND_DOC)   // BACKEND.md
            .mockResolvedValueOnce(FRONTEND_DOC)  // FRONTEND.md
            .mockRejectedValue(new Error('Not Found')); // subsequent reads (update path)

        jest.spyOn(agent, '_needsUpdate').mockResolvedValue(true);
        mockLlm.call.mockResolvedValue('# Updated Docs\nNew content.');

        await agent.ensureDocumented(makeTicket());

        expect(mockLlm.call).toHaveBeenCalled();
    });
});

// ── getDoc ────────────────────────────────────────────────────────────────────

describe('DocumentationAgent.getDoc', () => {
    it('returns empty string before ensureDocumented is called', () => {
        MockGitHubService.mockImplementation(() => ({}));
        const agent = new DocumentationAgent(config, { call: jest.fn() }, {});
        expect(agent.getDoc()).toBe('');
    });
});
