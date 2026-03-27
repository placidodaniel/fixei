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
const FG_GREEN = '\x1b[92m';

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

// Flatten logger arguments to a single string suitable for a one-liner
function fmt(...args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

// Same as fmt but keeps full stack traces (used for errors)
function fmtError(...args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

// ── Spinner ───────────────────────────────────────────────────────────────
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinTimer = null;
let _spinFrame = 0;
let _spinLine = ''; // full text of the active spinner line

function _spinRender() {
  const dot = `${FG_CYAN}${SPIN_FRAMES[_spinFrame % SPIN_FRAMES.length]}${R}`;
  const maxLen = Math.max(10, (process.stdout.columns ?? 120) - 6);
  const visible = _spinLine.length > maxLen ? _spinLine.slice(0, maxLen - 1) + '\u2026' : _spinLine;
  process.stdout.write(`\r\x1b[2K  ${dot}  ${visible}`);
  _spinFrame++;
}

// result='ok'/true  → replace spinner with ✓ (green) and keep the line in scroll-back
// result='fail'     → replace spinner with ✗ (red)  and keep the line in scroll-back
// result=false      → erase the line silently
function _spinStop(result = false) {
  if (_spinTimer) { clearInterval(_spinTimer); _spinTimer = null; }
  if (!_spinLine) return;
  if (result === true || result === 'ok') {
    process.stdout.write(`\r\x1b[2K  ${FG_GREEN}\u2713${R}  ${_spinLine}\n`);
  } else if (result === 'fail') {
    process.stdout.write(`\r\x1b[2K  ${FG_RED}\u2717${R}  ${_spinLine}\n`);
  } else {
    process.stdout.write('\r\x1b[2K');
  }
  _spinLine = '';
}

function _spinStart(line) {
  _spinStop(true);  // commit previous line with ✓ before starting the next
  _spinLine = line.replace(/\r?\n\s*/g, '  ');
  _spinFrame = 0;
  _spinRender();
  _spinTimer = setInterval(_spinRender, 80);
}

process.on('exit', () => { _spinStop(true); });
['SIGINT', 'SIGTERM'].forEach(sig =>
  process.on(sig, () => { _spinStop(true); process.exit(sig === 'SIGINT' ? 130 : 0); })
);

/**
 * Logger - structured, colorized output with inline spinner.
 * - info / warn  : replace previous spinner line (ephemeral)
 * - error / debug: print permanently (preserved in scroll-back)
 */
export const logger = {
  info(...a) {
    const line = `${D}${ts()}${R}  ${badge('INFO', BG_BLUE)}  ${colorizeMsg(fmt(...a), FG_CYAN)}`;
    if (USE_COLOR) { _spinStart(line); } else { console.log(line); }
  },
  warn(...a) {
    const line = `${D}${ts()}${R}  ${badge('WARN', BG_YELLOW, FG_BLACK)}  ${colorizeMsg(fmt(...a), FG_YELLOW)}`;
    if (USE_COLOR) { _spinStart(line); } else { console.warn(line); }
  },
  fail(...a) {
    const line = `${D}${ts()}${R}  ${badge('FAIL', BG_RED)}  ${colorizeMsg(fmtError(...a), FG_RED)}`;
    if (USE_COLOR) {
      _spinStop('fail'); // mark previous spinner line with ✗
      process.stderr.write(line + '\n');
    } else { console.error(line); }
  },
  error(...a) {
    const line = `${D}${ts()}${R}  ${badge('ERR', BG_RED)}  ${colorizeMsg(fmtError(...a), FG_RED)}`;
    if (USE_COLOR) {
      _spinStop('fail'); // mark previous spinner line with ✗
      process.stderr.write(line + '\n');
    } else {
      console.error(line);
    }
  },
  debug(...a) {
    if (!process.env.DEBUG) return;
    const line = `${D}${ts()}${R}  ${badge('DBG', BG_GRAY)}  ${colorizeMsg(fmt(...a), FG_GRAY)}`;
    if (USE_COLOR) {
      _spinStop(true);
      process.stdout.write(line + '\n');
    } else {
      console.log(line);
    }
  },
};
