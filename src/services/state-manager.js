import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '../../data/state.json');

/**
 * StateManager - persiste o estado do pipeline em arquivo JSON
 */
export class StateManager {
    constructor() {
        this._store = new Map();
        this._loaded = this._load();
    }

    async _load() {
        try {
            const data = await fs.readFile(STATE_FILE, 'utf8');
            const parsed = JSON.parse(data);
            this._store = new Map(parsed);
        } catch (e) {
            // Arquivo não existe ainda - OK
        }
    }

    async _persist() {
        const dir = path.dirname(STATE_FILE);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(STATE_FILE, JSON.stringify([...this._store]));
    }

    async save(runId, ctx) {
        this._store.set(runId, { ...ctx, updatedAt: new Date().toISOString() });
        await this._persist();
    }

    async get(runId) {
        return this._store.get(runId) ?? null;
    }

    async list() {
        return Array.from(this._store.entries()).map(([id, ctx]) => ({ id, ...ctx }));
    }
}
