import { describe, it, expect } from '@jest/globals';
import { extractJson } from '../../src/services/llm-utils.js';

describe('extractJson', () => {
    it('parses a plain JSON object', () => {
        expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('strips text before and after the JSON block', () => {
        expect(extractJson('Here is the response:\n{"ok":true}\nDone.')).toEqual({ ok: true });
    });

    it('handles markdown json code fences', () => {
        expect(extractJson('```json\n{"key":"value"}\n```')).toEqual({ key: 'value' });
    });

    it('handles backtick-delimited content field with embedded double quotes', () => {
        const input = '{"code":`if (x === "y") { return true; }`}';
        expect(extractJson(input)).toEqual({ code: 'if (x === "y") { return true; }' });
    });

    it('handles backtick content with newlines', () => {
        const input = '{"content":`line1\nline2\nline3`}';
        const result = extractJson(input);
        expect(result.content).toContain('line1');
        expect(result.content).toContain('line2');
    });

    it('handles invalid backslash escapes like \\w in strings', () => {
        const input = '{"pattern":"\\w+ token"}';
        expect(() => extractJson(input)).not.toThrow();
        const result = extractJson(input);
        expect(result.pattern).toBeDefined();
    });

    it('handles bare newline inside a double-quoted string', () => {
        // JSON with literal newline inside a string (invalid JSON — extractJson should fix it)
        const input = '{"msg":"line1\nline2"}';
        const result = extractJson(input);
        expect(result.msg).toBe('line1\nline2');
    });

    it('handles nested objects and arrays', () => {
        const input = '{"files":["a.ts","b.ts"],"meta":{"count":2}}';
        expect(extractJson(input)).toEqual({ files: ['a.ts', 'b.ts'], meta: { count: 2 } });
    });

    it('handles boolean and null values', () => {
        const input = '{"confirmed":true,"reason":null,"count":0}';
        expect(extractJson(input)).toEqual({ confirmed: true, reason: null, count: 0 });
    });

    it('throws SyntaxError when no JSON object is found', () => {
        expect(() => extractJson('no json here')).toThrow(SyntaxError);
    });

    it('throws SyntaxError for empty string', () => {
        expect(() => extractJson('')).toThrow(SyntaxError);
    });

    it('extracts a JSON object surrounded by non-JSON text', () => {
        const input = 'prefix {"first":1, "second":2} suffix';
        const result = extractJson(input);
        expect(result.first).toBe(1);
        expect(result.second).toBe(2);
    });

    it('handles a realistic LLM analysis response', () => {
        const json = {
            confirmed: true,
            reason: 'Missing error handler',
            rootCause: 'onClick not bound',
            affectedFiles: ['src/Button.tsx'],
            bugType: 'logic_error',
            riskLevel: 'low',
        };
        const input = `Here is my analysis:\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
        const result = extractJson(input);
        expect(result.confirmed).toBe(true);
        expect(result.bugType).toBe('logic_error');
    });

    it('handles a fileChanges content field using backtick template', () => {
        const input = `{
      "prTitle": "fix: null check",
      "fileChanges": [
        {
          "path": "src/service.ts",
          "content": \`export function doThing(x: string | null) {
  if (!x) throw new Error("x is null");
  return x.toUpperCase();
}\`
        }
      ]
    }`;
        const result = extractJson(input);
        expect(result.prTitle).toBe('fix: null check');
        expect(result.fileChanges[0].content).toContain('toUpperCase');
    });
});
