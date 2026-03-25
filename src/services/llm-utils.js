/**
 * Shared LLM utilities used across all agents.
 */

// Valid JSON string escape chars per RFC 8259
const VALID_JSON_ESC = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Robustly extracts and parses the first JSON object from LLM output.
 * Handles:
 *   - Text before/after the JSON
 *   - Backtick template literals used by LLM (e.g. "content": `export class...`)
 *   - Bare control characters inside strings
 *   - Invalid backslash escapes (\d, \s, \w, \0, etc.)
 */
export function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new SyntaxError('No JSON object found in LLM response');

    const slice = text.slice(start, end + 1);
    let raw = '';
    let inString = false; // inside a JSON double-quoted string
    let inBacktick = false; // inside an LLM backtick template literal
    let i = 0;

    while (i < slice.length) {
        const c = slice[i];

        // ── Structural level ──────────────────────────────────────────────
        if (!inString && !inBacktick) {
            if (c === '"') { inString = true; raw += c; i++; continue; }
            if (c === '`') { inBacktick = true; raw += '"'; i++; continue; } // open as JSON string
            raw += c; i++; continue;
        }

        // ── Inside a backtick template literal ───────────────────────────
        if (inBacktick) {
            if (c === '`') { inBacktick = false; raw += '"'; i++; continue; } // close → "
            if (c === '"') { raw += '\\"'; i++; continue; }  // escape embedded double quotes
            if (c === '\\') {
                const next = slice[i + 1] ?? '';
                if (next === '`') { raw += '`'; i += 2; continue; }  // \` → literal backtick
                if (VALID_JSON_ESC.has(next)) { raw += '\\' + next; i += 2; if (next === 'u') { raw += slice.slice(i, i + 4); i += 4; } continue; }
                raw += '\\\\'; i++; continue;  // invalid escape → double backslash
            }
            if (c === '\n') { raw += '\\n'; i++; continue; }
            if (c === '\r') { raw += '\\r'; i++; continue; }
            if (c === '\t') { raw += '\\t'; i++; continue; }
            if (c.charCodeAt(0) < 0x20) { i++; continue; }
            raw += c; i++; continue;
        }

        // ── Inside a JSON double-quoted string ───────────────────────────
        if (c === '"') { inString = false; raw += c; i++; continue; }
        if (c === '\\') {
            const next = slice[i + 1] ?? '';
            if (VALID_JSON_ESC.has(next)) { raw += '\\' + next; i += 2; if (next === 'u') { raw += slice.slice(i, i + 4); i += 4; } continue; }
            raw += '\\\\'; i++; continue;
        }
        if (c === '\n') { raw += '\\n'; i++; continue; }
        if (c === '\r') { raw += '\\r'; i++; continue; }
        if (c === '\t') { raw += '\\t'; i++; continue; }
        if (c.charCodeAt(0) < 0x20) { i++; continue; }
        raw += c; i++;
    }

    return JSON.parse(raw);
}
