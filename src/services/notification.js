/**
 * NotificationService - sends messages to Slack
 */
export class NotificationService {
  constructor(config = {}) {
    this.webhookUrl = config.webhookUrl;
    this.channel = config.channel ?? '#engineering';
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

// ── ANSI escape helpers ────────────────────────────────────────────────────
const R = '\x1b[0m';   // reset
const B = '\x1b[1m';   // bold
const D = '\x1b[2m';   // dim
const BG_BLUE = '\x1b[48;5;27m';
const BG_YELLOW = '\x1b[48;5;214m';
const BG_RED = '\x1b[48;5;196m';
const BG_GRAY = '\x1b[48;5;238m';
const FG_WHITE = '\x1b[97m';
const FG_BLACK = '\x1b[30m';
const FG_CYAN = '\x1b[96m';
const FG_YELLOW = '\x1b[93m';
const FG_RED = '\x1b[91m';
const FG_GRAY = '\x1b[90m';

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR == null;

function ts() {
  const n = new Date();
  return [n.getHours(), n.getMinutes(), n.getSeconds()]
    .map(v => String(v).padStart(2, '0')).join(':')
    + '.' + String(n.getMilliseconds()).padStart(3, '0');
}

function badge(text, bg, fg = FG_WHITE) {
  return USE_COLOR ? `${bg}${fg}${B} ${text} ${R}` : `[${text.trim()}]`;
}

// Colorize the leading [Tag] in a message argument
function colorizeMsg(msg, color) {
  if (!USE_COLOR || typeof msg !== 'string') return msg;
  return msg.replace(/^(\[[^\]]+\])/, `${color}${B}$1${R}`);
}

/**
 * Logger - structured, colorized output
 */
export const logger = {
  info(...a) {
    const [first, ...rest] = a;
    console.log(
      `${D}${ts()}${R}  ${badge('INFO', BG_BLUE)}  ${colorizeMsg(first, FG_CYAN)}`,
      ...rest,
    );
  },
  warn(...a) {
    const [first, ...rest] = a;
    console.warn(
      `${D}${ts()}${R}  ${badge('WARN', BG_YELLOW, FG_BLACK)}  ${colorizeMsg(first, FG_YELLOW)}`,
      ...rest,
    );
  },
  error(...a) {
    const [first, ...rest] = a;
    console.error(
      `${D}${ts()}${R}  ${badge('ERR', BG_RED)}  ${colorizeMsg(first, FG_RED)}`,
      ...rest,
    );
  },
  debug(...a) {
    if (!process.env.DEBUG) return;
    const [first, ...rest] = a;
    console.log(
      `${D}${ts()}${R}  ${badge('DBG', BG_GRAY)}  ${colorizeMsg(first, FG_GRAY)}`,
      ...rest,
    );
  },
};
