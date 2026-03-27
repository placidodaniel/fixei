import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fail: jest.fn() },
}));

let TicketAgent;

beforeAll(async () => {
    ({ TicketAgent } = await import('../../src/agents/ticket-agent.js'));
});

const config = {
    githubRepo: 'owner/repo',
    githubToken: 'tok',
    ticketProvider: 'github',
};

function makeMockFetch(status = 200, body = {}) {
    return jest.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
    });
}

// ── _extractText ──────────────────────────────────────────────────────────────

describe('TicketAgent._extractText', () => {
    let agent;
    beforeEach(() => (agent = new TicketAgent(config, { call: jest.fn() })));

    it('formats a GitHub Issues payload', () => {
        const text = agent._extractText({ title: 'Button broken', body: 'Clicking does nothing' });
        expect(text).toContain('Title: Button broken');
        expect(text).toContain('Clicking does nothing');
    });

    it('formats a Jira payload', () => {
        const text = agent._extractText({ fields: { summary: 'Crash on login', description: 'App crashes' } });
        expect(text).toContain('Summary: Crash on login');
        expect(text).toContain('App crashes');
    });

    it('handles Jira payload with missing description', () => {
        const text = agent._extractText({ fields: { summary: 'Bug' } });
        expect(text).toContain('Summary: Bug');
    });

    it('stringifies unknown payload format as fallback', () => {
        const text = agent._extractText({ weird: 'format', nested: { data: 42 } });
        expect(text).toContain('"weird"');
        expect(text).toContain('"data"');
    });
});

// ── parse ─────────────────────────────────────────────────────────────────────

describe('TicketAgent.parse', () => {
    let llm, agent;

    beforeEach(() => {
        llm = { call: jest.fn() };
        agent = new TicketAgent(config, llm);
        global.fetch = makeMockFetch(200);
    });

    afterEach(() => jest.restoreAllMocks());

    it('parses a GitHub Issues payload via LLM and returns structured ticket', async () => {
        const expected = {
            id: '42', title: 'Bug title', description: 'Bug description',
            stepsToReproduce: ['Step 1'], expectedBehavior: 'Works',
            actualBehavior: 'Crashes', environment: {}, severity: 'high',
            labels: ['bug'], reporter: 'alice', rawLogs: '',
        };
        llm.call.mockResolvedValue(JSON.stringify(expected));

        const raw = { id: 42, number: 42, title: 'Bug title', body: 'Bug description', user: { login: 'alice' }, labels: [] };
        const result = await agent.parse(raw);

        expect(result.title).toBe('Bug title');
        expect(result.severity).toBe('high');
        expect(result._raw).toBe(raw);
        expect(result._provider).toBe('github');
    });

    it('sets _provider from config.ticketProvider', async () => {
        const jiraAgent = new TicketAgent({ ...config, ticketProvider: 'jira' }, llm);
        llm.call.mockResolvedValue('{"id":"J-1","title":"t","description":"d","stepsToReproduce":[],"expectedBehavior":"","actualBehavior":"","environment":{},"severity":"low","labels":[],"reporter":"x","rawLogs":""}');
        const result = await jiraAgent.parse({ id: 'J-1', fields: { summary: 't', description: 'd' } });
        expect(result._provider).toBe('jira');
    });

    it('falls back to raw values when LLM returns invalid JSON', async () => {
        llm.call.mockResolvedValue('this is not json at all');
        const raw = { number: 7, title: 'Raw title', body: 'Details', user: { login: 'bob' } };
        const result = await agent.parse(raw);
        expect(result.title).toBe('Raw title');
        expect(result.id).toBe(7);
        expect(result._raw).toBe(raw);
    });

    it('falls back when LLM call throws', async () => {
        llm.call.mockRejectedValue(new Error('LLM unavailable'));
        const raw = { number: 8, title: 'Another bug', body: 'body', user: { login: 'carol' } };
        const result = await agent.parse(raw);
        expect(result.title).toBe('Another bug');
    });

    it('includes the rawId in the LLM prompt', async () => {
        llm.call.mockResolvedValue('{"id":"99","title":"t","description":"d","stepsToReproduce":[],"expectedBehavior":"","actualBehavior":"","environment":{},"severity":"low","labels":[],"reporter":"x","rawLogs":""}');
        const raw = { id: 99, number: 99, title: 't', body: 'b', user: { login: 'x' } };
        await agent.parse(raw);
        const prompt = llm.call.mock.calls[0][2];
        expect(prompt).toContain('99');
    });
});

// ── closeAsFixed ──────────────────────────────────────────────────────────────

describe('TicketAgent.closeAsFixed', () => {
    let agent, mockFetch;

    beforeEach(() => {
        mockFetch = makeMockFetch(200);
        global.fetch = mockFetch;
        agent = new TicketAgent(config, { call: jest.fn() });
    });

    it('posts a comment and closes the GitHub issue', async () => {
        const ticket = { id: '1', _raw: { number: 1 }, _provider: 'github' };
        const deploy = { branch: 'bugfix/auto-1', prUrl: 'https://github.com/pr/1', environment: 'production' };
        await agent.closeAsFixed(ticket, deploy);

        // Two fetch calls: comment + PATCH close
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[0][0]).toContain('/comments');
        expect(mockFetch.mock.calls[0][1].method).toBe('POST');
        expect(mockFetch.mock.calls[1][0]).toContain('/issues/1');
        expect(mockFetch.mock.calls[1][1].method).toBe('PATCH');
    });

    it('includes the branch name and PR URL in the comment', async () => {
        const ticket = { id: '1', _raw: { number: 1 }, _provider: 'github' };
        const deploy = { branch: 'bugfix/auto-1', prUrl: 'https://github.com/pr/1', environment: 'production' };
        await agent.closeAsFixed(ticket, deploy);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.body).toContain('bugfix/auto-1');
        expect(body.body).toContain('https://github.com/pr/1');
    });
});

// ── closeAsInvalid ────────────────────────────────────────────────────────────

describe('TicketAgent.closeAsInvalid', () => {
    let agent, mockFetch;

    beforeEach(() => {
        mockFetch = makeMockFetch(200);
        global.fetch = mockFetch;
        agent = new TicketAgent(config, { call: jest.fn() });
    });

    it('posts a comment explaining the reason and closes the issue', async () => {
        const ticket = { id: '2', _raw: { number: 2 }, _provider: 'github' };
        await agent.closeAsInvalid(ticket, 'Could not reproduce');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.body).toContain('Could not reproduce');
    });
});

// ── escalate ──────────────────────────────────────────────────────────────────

describe('TicketAgent.escalate', () => {
    let agent, mockFetch;

    beforeEach(() => {
        mockFetch = makeMockFetch(200);
        global.fetch = mockFetch;
        agent = new TicketAgent(config, { call: jest.fn() });
    });

    it('posts an escalation comment and applies the needs-human label', async () => {
        const ticket = { id: '3', _raw: { number: 3 }, _provider: 'github' };
        await agent.escalate(ticket, 'Max retries exceeded');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        // Second call is the label API
        const labelBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(labelBody.labels).toContain('needs-human');
    });

    it('includes the failure details in the escalation comment', async () => {
        const ticket = { id: '3', _raw: { number: 3 }, _provider: 'github' };
        await agent.escalate(ticket, 'Root cause unknown');
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.body).toContain('Root cause unknown');
    });
});
