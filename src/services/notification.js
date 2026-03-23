/**
 * NotificationService - sends messages to Slack
 */
export class NotificationService {
  constructor(config = {}) {
    this.webhookUrl = config.webhookUrl;
    this.channel    = config.channel ?? '#engineering';
  }

  async send(text) {
    if (!this.webhookUrl) {
      console.log('[Notify]', text);
      return;
    }
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, channel: this.channel }),
      });
    } catch (e) {
      console.warn('[Notify] Failed to send Slack message:', e.message);
    }
  }
}

/**
 * StateManager - persists pipeline state in memory (replace with Redis/DB for production)
 */
export class StateManager {
  constructor() {
    this._store = new Map();
  }

  async save(runId, ctx) {
    this._store.set(runId, { ...ctx, updatedAt: new Date().toISOString() });
  }

  async get(runId) {
    return this._store.get(runId) ?? null;
  }

  async list() {
    return Array.from(this._store.entries()).map(([id, ctx]) => ({ id, ...ctx }));
  }
}

/**
 * Logger - simple structured logger
 */
export const logger = {
  info:  (...a) => console.log ('[INFO ]', new Date().toISOString(), ...a),
  warn:  (...a) => console.warn('[WARN ]', new Date().toISOString(), ...a),
  error: (...a) => console.error('[ERROR]', new Date().toISOString(), ...a),
  debug: (...a) => { if (process.env.DEBUG) console.log('[DEBUG]', ...a); },
};
