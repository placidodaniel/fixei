import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fail: jest.fn() },
}));

let Context7Service;

beforeAll(async () => {
    ({ Context7Service } = await import('../../src/services/context7.js'));
});

describe('Context7Service.resolveLibrary', () => {
    let ctx7;

    beforeEach(() => {
        ctx7 = new Context7Service();
        global.fetch = jest.fn();
    });

    afterEach(() => jest.restoreAllMocks());

    it('resolves a known library from the static map (lowercase)', async () => {
        const id = await ctx7.resolveLibrary('typescript');
        expect(id).toBe('/microsoft/typescript');
        expect(global.fetch).not.toHaveBeenCalled(); // no network call needed
    });

    it('resolves a known library case-insensitively', async () => {
        expect(await ctx7.resolveLibrary('React')).toBe('/facebook/react');
        expect(await ctx7.resolveLibrary('VUE')).toBe('/vuejs/core');
        expect(await ctx7.resolveLibrary('JEST')).toBe('/jestjs/jest');
    });

    it('resolves compound name "Vue.js" from the map', async () => {
        expect(await ctx7.resolveLibrary('Vue.js')).toBe('/vuejs/core');
    });

    it('falls back to API search for an unknown library', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ id: '/someone/somelib' }] }),
        });

        const id = await ctx7.resolveLibrary('someunknownlib');
        expect(id).toBe('/someone/somelib');
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('search?q=someunknownlib'),
            expect.any(Object),
        );
    });

    it('returns null when API search returns empty results', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: [] }),
        });
        expect(await ctx7.resolveLibrary('phantom')).toBeNull();
    });

    it('returns null when API search returns non-ok status', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false });
        expect(await ctx7.resolveLibrary('bad')).toBeNull();
    });

    it('returns null when API search throws a network error', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
        expect(await ctx7.resolveLibrary('broken')).toBeNull();
    });
});

describe('Context7Service.getDocs', () => {
    let ctx7;

    beforeEach(() => {
        ctx7 = new Context7Service();
    });

    it('returns the documentation text on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => '## Express API\nError handling docs...',
        });

        const docs = await ctx7.getDocs('/expressjs/express', 'error handling', 1000);
        expect(docs).toContain('Express');
    });

    it('builds the URL with tokens and topic query params', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => 'docs' });
        await ctx7.getDocs('/microsoft/typescript', 'async error', 2000);
        const url = global.fetch.mock.calls[0][0];
        expect(url).toContain('tokens=2000');
        expect(url).toContain('topic=');
        expect(url).toContain('async');
    });

    it('returns empty string when response is not ok', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
        expect(await ctx7.getDocs('/unknown/lib')).toBe('');
    });

    it('returns empty string and does not throw on network failure', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));
        await expect(ctx7.getDocs('/expressjs/express')).resolves.toBe('');
    });

    it('handles libraryId without leading slash', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => 'result' });
        await ctx7.getDocs('expressjs/express');
        const url = global.fetch.mock.calls[0][0];
        expect(url).toContain('expressjs/express');
    });
});

describe('Context7Service.getBestPractices', () => {
    let ctx7;

    beforeEach(() => {
        ctx7 = new Context7Service();
        // Default: return docs for known libraries
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => '# Docs content',
        });
    });

    it('returns a combined string for known frameworks', async () => {
        const result = await ctx7.getBestPractices(['TypeScript', 'React'], 'error handling');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty string for an empty frameworks array', async () => {
        const result = await ctx7.getBestPractices([]);
        expect(result).toBe('');
    });

    it('limits to 2 frameworks maximum', async () => {
        await ctx7.getBestPractices(['TypeScript', 'React', 'Vue', 'Express'], 'topic');
        // Each framework in known map = 1 fetch (getDocs). Max 2 frameworks × 1 fetch each.
        expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('filters out null/empty values from frameworks array', async () => {
        const result = await ctx7.getBestPractices([null, '', 'TypeScript'], 'topic');
        expect(typeof result).toBe('string');
    });

    it('returns empty string when all docs fetches fail', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        const result = await ctx7.getBestPractices(['TypeScript']);
        expect(result).toBe('');
    });
});
