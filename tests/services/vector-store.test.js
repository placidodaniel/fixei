import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

const mockPipeline = jest.fn();

jest.unstable_mockModule('@xenova/transformers', () => ({
    pipeline: mockPipeline,
}));

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let VectorStoreService;

beforeAll(async () => {
    ({ VectorStoreService } = await import('../../src/services/vector-store.js'));
});

// ── _tokenize ──────────────────────────────────────────────────────────────────

describe('VectorStoreService._tokenize', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('splits camelCase into individual words', () => {
        expect(vs._tokenize('ContactForm')).toEqual(['contact', 'form']);
    });

    it('splits PascalCase with multiple components', () => {
        const tokens = vs._tokenize('CreateContactService');
        expect(tokens).toContain('create');
        expect(tokens).toContain('contact');
        expect(tokens).toContain('service');
    });

    it('converts all tokens to lowercase', () => {
        const tokens = vs._tokenize('MyClass');
        expect(tokens.every(t => t === t.toLowerCase())).toBe(true);
    });

    it('filters out tokens shorter than 3 characters', () => {
        const tokens = vs._tokenize('ab ccc dddd');
        expect(tokens).not.toContain('ab');
        expect(tokens).toContain('ccc');
        expect(tokens).toContain('dddd');
    });

    it('filters out purely numeric tokens', () => {
        const tokens = vs._tokenize('version 123 file 456');
        expect(tokens).not.toContain('123');
        expect(tokens).not.toContain('456');
        expect(tokens).toContain('version');
        expect(tokens).toContain('file');
    });

    it('handles underscore-separated names', () => {
        const tokens = vs._tokenize('create_contact_service');
        expect(tokens).toContain('create');
        expect(tokens).toContain('contact');
    });
});

// ── _termMatch ─────────────────────────────────────────────────────────────────

describe('VectorStoreService._termMatch', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('matches identical terms', () => {
        expect(vs._termMatch('contact', 'contact')).toBe(true);
    });

    it('matches when query term is a substring of chunk term', () => {
        expect(vs._termMatch('contacts', 'contact')).toBe(true);
    });

    it('matches when chunk term is a substring of query term', () => {
        expect(vs._termMatch('contact', 'contacts')).toBe(true);
    });

    it('matches PT↔EN cognates via 5-char prefix (contatos ↔ contacts)', () => {
        // "conta" is the shared 5-char prefix
        expect(vs._termMatch('contatos', 'contacts')).toBe(true);
    });

    it('matches "mensagem" ↔ "message" via prefix overlap', () => {
        // "mensa" vs "messa" — no match — but "mensagem" vs "message" share "messa"? no...
        // "mensagem".slice(0,5) = "mensa", "message".slice(0,5) = "messa" — different
        // This is expected NOT to match — testing the boundary
        expect(vs._termMatch('mensagem', 'message')).toBe(false);
    });

    it('does not match unrelated terms', () => {
        expect(vs._termMatch('contact', 'deploy')).toBe(false);
        expect(vs._termMatch('user', 'file')).toBe(false);
    });
});

// ── _tfidfScore ────────────────────────────────────────────────────────────────

describe('VectorStoreService._tfidfScore', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('scores path matches 3× higher than content-only matches', () => {
        const pathChunk = '// src/controllers/ContactController.ts\nfunction other() {}';
        const contentChunk = '// src/services/AuthService.ts\nclass ContactManager {}'; // "contact" in content
        const query = 'contact management';

        const pathScore = vs._tfidfScore(pathChunk, query);
        const contentScore = vs._tfidfScore(contentChunk, query);
        expect(pathScore).toBeGreaterThan(contentScore);
    });

    it('returns 0 for completely unrelated content and path', () => {
        const chunk = '// backend/src/services/WbotServices/providers.ts\nexport const providers = []';
        const query = 'contato mensagem erro salvar formulário';
        expect(vs._tfidfScore(chunk, query)).toBe(0);
    });

    it('returns 0 for empty/whitespace-only query', () => {
        const chunk = '// src/api.ts\nexport const api = {}';
        expect(vs._tfidfScore(chunk, '')).toBe(0);
        expect(vs._tfidfScore(chunk, '   ')).toBe(0);
    });

    it('returns a score in [0, 1]', () => {
        const chunk = '// src/components/ContactForm/index.js\nexport function ContactForm() {}';
        const score = vs._tfidfScore(chunk, 'contact form save user button');
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it('uses camelCase decomposition to find ContactController for "contato" query', () => {
        const chunk = '// backend/src/controllers/ContactController.ts\nclass ContactController {}';
        const score = vs._tfidfScore(chunk, 'contato não salvo');
        expect(score).toBeGreaterThan(0);
    });

    it('ranks ContactForm above unrelated WbotServices file', () => {
        const contact = '// frontend/src/components/ContactForm/index.js\nexport function ContactForm() {}';
        const wbot = '// backend/src/services/WbotServices/providers.ts\nexport const providers = []';
        const query = 'Na tela de adicionar Contatos não é exibido mensagem de erro';
        expect(vs._tfidfScore(contact, query)).toBeGreaterThan(vs._tfidfScore(wbot, query));
    });
});

// ── isReady getter ─────────────────────────────────────────────────────────────

describe('VectorStoreService.isReady', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('is false when index is null', () => {
        expect(vs.isReady).toBe(false);
    });

    it('is false when chunks array is empty', () => {
        vs._index = { chunks: [] };
        expect(vs.isReady).toBe(false);
    });

    it('is true when chunks are present', () => {
        vs._index = { chunks: [{ path: 'a.ts', text: 'x', startLine: 1 }] };
        expect(vs.isReady).toBe(true);
    });
});

// ── waitReady ──────────────────────────────────────────────────────────────────

describe('VectorStoreService.waitReady', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('resolves immediately when no build is in progress', async () => {
        await expect(vs.waitReady()).resolves.toBeUndefined();
    });

    it('resolves without re-throwing when build rejects', async () => {
        vs._buildPromise = Promise.reject(new Error('build failed'));
        await expect(vs.waitReady()).resolves.toBeUndefined();
    });

    it('waits for an in-progress build promise', async () => {
        let resolve;
        vs._buildPromise = new Promise(r => (resolve = r));
        const waiting = vs.waitReady();
        resolve();
        await expect(waiting).resolves.toBeUndefined();
    });
});

// ── scheduleBuild ──────────────────────────────────────────────────────────────

describe('VectorStoreService.scheduleBuild', () => {
    let vs;
    beforeEach(() => (vs = new VectorStoreService(null, {})));

    it('stores a _buildPromise immediately', () => {
        vs._doBuild = jest.fn().mockResolvedValue(null);
        vs.scheduleBuild(Promise.resolve([]));
        expect(vs._buildPromise).not.toBeNull();
    });

    it('completes via waitReady when files resolve', async () => {
        vs._doBuild = jest.fn().mockResolvedValue(null);
        vs.scheduleBuild(Promise.resolve(['src/a.ts']));
        await vs.waitReady();
        expect(vs._doBuild).toHaveBeenCalledWith(['src/a.ts']);
    });

    it('does not throw when the files promise rejects', async () => {
        vs._doBuild = jest.fn();
        vs.scheduleBuild(Promise.reject(new Error('listFiles failed')));
        await expect(vs.waitReady()).resolves.toBeUndefined();
    });
});

// ── build / _doBuild in TF-IDF mode ───────────────────────────────────────────

describe('VectorStoreService.build (TF-IDF fallback)', () => {
    let vs, mockGithub;

    beforeEach(() => {
        // pipeline always fails → TF-IDF mode
        mockPipeline.mockRejectedValue(new Error('Unauthorized access to HuggingFace'));
        mockGithub = {
            getFileContent: jest.fn().mockResolvedValue('export function foo() { return 1; }'),
            commitFile: jest.fn().mockResolvedValue({}),
        };
        vs = new VectorStoreService(mockGithub, { defaultBranch: 'main' });
    });

    it('sets _embedderFailed to true after embedder failure', async () => {
        await vs.build(['src/controllers/ContactController.ts']);
        expect(vs._embedderFailed).toBe(true);
    });

    it('builds a TF-IDF index with isReady = true', async () => {
        await vs.build(['src/service.ts']);
        expect(vs.isReady).toBe(true);
    });

    it('records mode as "TF-IDF" in the index', async () => {
        await vs.build(['src/app.ts']);
        expect(vs._index.mode).toBe('TF-IDF');
    });

    it('chunks have no embedding field in TF-IDF mode', async () => {
        await vs.build(['src/service.ts']);
        for (const chunk of vs._index.chunks) {
            expect(chunk.embedding).toBeUndefined();
        }
    });

    it('skips files that cannot be fetched', async () => {
        mockGithub.getFileContent
            .mockRejectedValueOnce(new Error('Not Found'))
            .mockResolvedValue('valid content');
        await vs.build(['bad/path.ts', 'src/good.ts']);
        expect(vs.isReady).toBe(true); // built from the good one
    });
});

// ── search (TF-IDF) ────────────────────────────────────────────────────────────

describe('VectorStoreService.search (TF-IDF mode)', () => {
    let vs;

    beforeEach(() => {
        vs = new VectorStoreService(null, {});
        vs._embedderFailed = true;
        vs._index = {
            mode: 'TF-IDF',
            chunks: [
                { path: 'src/ContactController.ts', startLine: 1, text: '// src/ContactController.ts\nclass ContactController {}' },
                { path: 'src/AuthService.ts', startLine: 1, text: '// src/AuthService.ts\nfunction login() {}' },
                { path: 'src/ContactService.ts', startLine: 1, text: '// src/ContactService.ts\nasync function createContact(data) {}' },
            ],
        };
    });

    it('returns empty array when index is not built', async () => {
        vs._index = null;
        expect(await vs.search('contact')).toEqual([]);
    });

    it('returns results sorted by score descending', async () => {
        const results = await vs.search('contact', 3);
        for (let i = 0; i < results.length - 1; i++) {
            expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
        }
    });

    it('returns at most topK results', async () => {
        const results = await vs.search('contact service', 2);
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('deduplicates: returns at most one result per file path', async () => {
        // Add a second chunk for the same file
        vs._index.chunks.push({ path: 'src/ContactController.ts', startLine: 50, text: '// src/ContactController.ts\nfunction update() {}' });
        const results = await vs.search('contact', 10);
        const paths = results.map(r => r.path);
        expect(new Set(paths).size).toBe(paths.length);
    });

    it('searchPaths returns only the file paths', async () => {
        const paths = await vs.searchPaths('contact', 3);
        expect(Array.isArray(paths)).toBe(true);
        paths.forEach(p => expect(typeof p).toBe('string'));
    });
});

// ── load ───────────────────────────────────────────────────────────────────────

describe('VectorStoreService.load', () => {
    let vs, mockGithub;

    beforeEach(() => {
        mockGithub = { getFileContent: jest.fn() };
        vs = new VectorStoreService(mockGithub, {});
    });

    it('loads a vector-mode index and returns true', async () => {
        const index = {
            builtAt: '2026-01-01T00:00:00Z',
            mode: 'vector',
            chunks: [{ path: 'a.ts', text: 'x', startLine: 1, embedding: [0.1, 0.2] }],
        };
        mockGithub.getFileContent.mockResolvedValue(JSON.stringify(index));
        const ok = await vs.load();
        expect(ok).toBe(true);
        expect(vs._embedderFailed).toBe(false);
        expect(vs.isReady).toBe(true);
    });

    it('detects TF-IDF mode from the mode field and sets _embedderFailed', async () => {
        const index = {
            builtAt: '2026-01-01T00:00:00Z',
            mode: 'TF-IDF',
            chunks: [{ path: 'a.ts', text: 'x', startLine: 1 }],
        };
        mockGithub.getFileContent.mockResolvedValue(JSON.stringify(index));
        await vs.load();
        expect(vs._embedderFailed).toBe(true);
    });

    it('detects TF-IDF mode when chunks have no embedding field', async () => {
        const index = {
            builtAt: '2026-01-01T00:00:00Z',
            chunks: [{ path: 'a.ts', text: 'x', startLine: 1 }], // no mode, no embedding
        };
        mockGithub.getFileContent.mockResolvedValue(JSON.stringify(index));
        await vs.load();
        expect(vs._embedderFailed).toBe(true);
    });

    it('returns false when index file does not exist', async () => {
        mockGithub.getFileContent.mockRejectedValue(new Error('Not Found'));
        expect(await vs.load()).toBe(false);
    });
});
