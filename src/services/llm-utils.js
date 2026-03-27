/**
 * Shared LLM utilities used across all agents.
 */

// Valid JSON string escape chars per RFC 8259
const VALID_JSON_ESC = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Walk forward from `openIdx` (a '{' character) and return the index of its
 * matching '}', respecting string literals and backtick template blocks so that
 * braces inside string values do not affect the depth counter.
 * Returns -1 if no matching close is found.
 */
function _findMatchingClose(text, openIdx) {
    let depth = 0;
    let inString = false;
    let inBacktick = false;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (inBacktick) {
            if (c === '\\') { i++; continue; }          // skip escaped char
            if (c === '`') inBacktick = false;
            continue;
        }
        if (inString) {
            if (c === '\\') { i++; continue; }          // skip escaped char
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '`') { inBacktick = true; continue; } // LLM backtick template
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/**
 * Robustly extracts and parses the first JSON object from LLM output.
 * Handles:
 *   - Prose / code before AND after the JSON (common in smaller models)
 *   - Backtick template literals used by LLM (e.g. "content": `export class...`)
 *   - Bare control characters inside strings
 *   - Invalid backslash escapes (\d, \s, \w, \0, etc.)
 *   - Missing opening quote on first property key  (confirmed": → "confirmed":)
 *   - Trailing commas before } or ]
 */
export function extractJson(text) {
    if (text == null) throw new SyntaxError(`extractJson received ${text === null ? 'null' : 'undefined'} — the LLM returned an empty response`);
    if (typeof text !== 'string') throw new SyntaxError(`extractJson expected string, got ${typeof text}`);
    // Find the first '{' that opens a real object (with a quoted key).
    // Skips trivial `{}` placeholders and `{variable}` patterns that appear in
    // prose or log output before the actual JSON the model was asked to return.
    const realObjectIdx = text.search(/\{[\s\n\r]*"/);
    const start = realObjectIdx !== -1 ? realObjectIdx : text.indexOf('{');
    if (start === -1) throw new SyntaxError('No JSON object found in LLM response');

    // Use depth-tracking to find the MATCHING closing '}' rather than the LAST
    // '}' in the text.  lastIndexOf('}') is too greedy — it grabs braces from
    // source code / prose that the model may have appended after the JSON.
    const end = _findMatchingClose(text, start);
    if (end === -1) throw new SyntaxError('No JSON object found in LLM response');

    const slice = text.slice(start, end + 1);
    let raw = '';
    let inString = false;   // inside a JSON double-quoted string
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

    try {
        return JSON.parse(raw);
    } catch (firstErr) {
        // ── Repair pass ──────────────────────────────────────────────────────
        // Smaller/fallback models frequently return JSON with various defects:
        //   1. key":  value  — missing opening quote on key
        //   2. key:   value  — completely unquoted key
        //   3. "key": text   — unquoted string value
        //   4. adjacent pairs with no comma between them
        //   5. trailing comma before } or ]
        // We apply targeted fixes in order from most-specific to most-broad.

        let repaired = raw
            // 1. Missing opening quote only: {, key": → {, "key":
            .replace(/([{,\n]\s*)(\w[\w\d]*)"\s*:/g, '$1"$2":')
            // 2. Completely unquoted keys: {, key: → {, "key":
            //    [A-Za-z_] won't start a match on an already-quoted "key" → safe
            .replace(/([{,\n]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
            // 3. Unquoted string values — wrap in quotes when the value is not a
            //    JSON primitive (true/false/null), number, array, object, or already a string.
            //    Captures everything up to the next newline, comma, or closing bracket.
            .replace(/:\s*(?!true\b|false\b|null\b|-?[\d]|\[|\{|")([^\n,}\]]+)/g, (_, val) => {
                const t = val.trim();
                if (!t) return ': null';
                return `: "${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            })
            // 4. Add missing commas between adjacent value→key transitions
            //    e.g.  "value"\n  "nextKey":  →  "value",\n  "nextKey":
            .replace(/(true|false|null|-?[\d]+(?:\.[\d]+)?|"(?:[^"\\]|\\.)*"|\]|\})\s*\n(\s*")/g, '$1,\n$2')
            // 5. Remove trailing commas before } or ]
            .replace(/,\s*([}\]])/g, '$1');
        try {
            return JSON.parse(repaired);
        } catch {
            throw firstErr; // surface original error for clearer diagnostics
        }
    }
}

