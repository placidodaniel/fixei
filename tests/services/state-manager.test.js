import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

// Mock fs/promises BEFORE importing state-manager (constructor calls _load immediately)
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockMkdir = jest.fn();

jest.unstable_mockModule('fs/promises', () => ({
    default: { readFile: mockReadFile, writeFile: mockWriteFile, mkdir: mockMkdir },
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
}));

let StateManager;

beforeAll(async () => {
    ({ StateManager } = await import('../../src/services/state-manager.js'));
});

describe('StateManager (file-persistent)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: state file does not exist
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockResolvedValue(undefined);
        mockMkdir.mockResolvedValue(undefined);
    });

    it('initializes without throwing when state file is missing', () => {
        expect(() => new StateManager()).not.toThrow();
    });

    it('loads existing state from file on construction', async () => {
        const stored = [['run_1', { status: 'done', updatedAt: '2026-01-01T00:00:00.000Z' }]];
        mockReadFile.mockResolvedValueOnce(JSON.stringify(stored));

        const sm = new StateManager();
        await sm._loaded; // wait for async _load to finish

        const ctx = await sm.get('run_1');
        expect(ctx.status).toBe('done');
    });

    it('saves a run and writes to disk', async () => {
        const sm = new StateManager();
        await sm._loaded;

        await sm.save('run_42', { status: 'running' });

        expect(mockMkdir).toHaveBeenCalled();
        expect(mockWriteFile).toHaveBeenCalled();
        const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
        expect(written).toContainEqual(['run_42', expect.objectContaining({ status: 'running' })]);
    });

    it('adds an updatedAt timestamp on save', async () => {
        const sm = new StateManager();
        await sm._loaded;
        await sm.save('run_ts', { status: 'done' });
        const ctx = await sm.get('run_ts');
        expect(ctx.updatedAt).toBeDefined();
    });

    it('returns null for an unknown runId', async () => {
        const sm = new StateManager();
        await sm._loaded;
        expect(await sm.get('ghost')).toBeNull();
    });

    it('lists all saved run contexts', async () => {
        const sm = new StateManager();
        await sm._loaded;
        await sm.save('run_a', { status: 'done' });
        await sm.save('run_b', { status: 'error' });

        const list = await sm.list();
        expect(list).toHaveLength(2);
        expect(list.map(r => r.id)).toEqual(expect.arrayContaining(['run_a', 'run_b']));
    });

    it('overwrites an existing run entry', async () => {
        const sm = new StateManager();
        await sm._loaded;
        await sm.save('run_x', { status: 'running' });
        await sm.save('run_x', { status: 'done' });
        const ctx = await sm.get('run_x');
        expect(ctx.status).toBe('done');
    });

    it('handles corrupted state file gracefully', async () => {
        mockReadFile.mockResolvedValueOnce('{ invalid json }');
        const sm = new StateManager();
        await sm._loaded;
        // Should not throw, store should be empty
        expect(await sm.get('anything')).toBeNull();
    });
});
