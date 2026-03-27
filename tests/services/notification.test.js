import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// notification.js references only console + fetch — no source module mocking needed.
// Import statically then spy/mock globals per test.
const { NotificationService, StateManager, logger } = await import('../../src/services/notification.js');

// ── NotificationService ───────────────────────────────────────────────────────

describe('NotificationService', () => {
    let mockFetch;

    beforeEach(() => {
        mockFetch = jest.fn().mockResolvedValue({ ok: true });
        global.fetch = mockFetch;
    });

    it('sends a POST request to the Slack webhookUrl', async () => {
        const svc = new NotificationService({ webhookUrl: 'https://hooks.slack.com/test', channel: '#dev' });
        await svc.send('hello world');
        expect(mockFetch).toHaveBeenCalledWith(
            'https://hooks.slack.com/test',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('includes the message text and channel in the POST body', async () => {
        const svc = new NotificationService({ webhookUrl: 'https://hooks.slack.com/x', channel: '#eng' });
        await svc.send('deploy done');
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.text).toBe('deploy done');
        expect(body.channel).toBe('#eng');
    });

    it('defaults to #engineering channel when none is specified', async () => {
        const svc = new NotificationService({ webhookUrl: 'https://hooks.slack.com/x' });
        await svc.send('msg');
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.channel).toBe('#engineering');
    });

    it('falls back to console.log when no webhookUrl is configured', async () => {
        const svc = new NotificationService({});
        const spy = jest.spyOn(console, 'log').mockImplementation(() => { });
        await svc.send('fallback message');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith('[Notify]', 'fallback message');
        spy.mockRestore();
    });

    it('swallows fetch errors silently', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
        const svc = new NotificationService({ webhookUrl: 'https://hooks.slack.com/x' });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        await expect(svc.send('test')).resolves.not.toThrow();
        warnSpy.mockRestore();
    });
});

// ── StateManager (in-memory) ──────────────────────────────────────────────────

describe('StateManager (in-memory)', () => {
    let sm;

    beforeEach(() => {
        sm = new StateManager();
    });

    it('saves and retrieves a run context', async () => {
        await sm.save('run_1', { status: 'running' });
        const ctx = await sm.get('run_1');
        expect(ctx.status).toBe('running');
    });

    it('adds updatedAt timestamp on save', async () => {
        await sm.save('run_2', { status: 'done' });
        const ctx = await sm.get('run_2');
        expect(ctx.updatedAt).toBeDefined();
        expect(() => new Date(ctx.updatedAt)).not.toThrow();
    });

    it('returns null for an unknown runId', async () => {
        expect(await sm.get('nope')).toBeNull();
    });

    it('lists all saved runs', async () => {
        await sm.save('run_a', { status: 'done' });
        await sm.save('run_b', { status: 'error' });
        const list = await sm.list();
        expect(list).toHaveLength(2);
        expect(list.map(r => r.id)).toEqual(expect.arrayContaining(['run_a', 'run_b']));
    });

    it('overwrites an existing run on duplicate save', async () => {
        await sm.save('run_1', { status: 'running' });
        await sm.save('run_1', { status: 'done' });
        const ctx = await sm.get('run_1');
        expect(ctx.status).toBe('done');
    });
});

// ── logger ───────────────────────────────────────────────────────────────────

describe('logger', () => {
    afterEach(() => jest.restoreAllMocks());

    it('forwards info messages to stdout or console.log', () => {
        // TTY mode writes via process.stdout.write; non-TTY falls back to console.log
        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        logger.info('[Test] info message');
        expect(stdoutSpy.mock.calls.length + logSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('forwards warn messages to stdout or console.warn', () => {
        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        logger.warn('[Test] warn message');
        expect(stdoutSpy.mock.calls.length + warnSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('forwards error messages to stderr or console.error', () => {
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        logger.error('[Test] error message');
        expect(stderrSpy.mock.calls.length + errorSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('does not print debug output when DEBUG env is not set', () => {
        const spy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const prev = process.env.DEBUG;
        delete process.env.DEBUG;
        logger.debug('should not appear');
        expect(spy).not.toHaveBeenCalled();
        if (prev !== undefined) process.env.DEBUG = prev;
        spy.mockRestore();
    });

    it('prints debug output when DEBUG env is set', () => {
        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        process.env.DEBUG = '1';
        logger.debug('should appear');
        expect(stdoutSpy.mock.calls.length + logSpy.mock.calls.length).toBeGreaterThan(0);
        delete process.env.DEBUG;
        stdoutSpy.mockRestore();
        logSpy.mockRestore();
    });
});
