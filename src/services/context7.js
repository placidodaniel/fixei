/**
 * Context7Service
 *
 * Fetches up-to-date library documentation from Context7 (https://context7.com)
 * and returns it as plain Markdown that can be injected into LLM prompts.
 *
 * API used (Context7 public HTTP API):
 *   Search:  GET https://context7.com/api/v1/search?q={query}&limit=5
 *   Docs:    GET https://context7.com/api/v1/{libraryId}?tokens={n}&topic={topic}
 */

import { logger } from './logger.js';

const API_BASE = 'https://context7.com/api/v1';

// Pre-resolved IDs for the most common stacks — avoids a search round-trip
const KNOWN_LIBRARY_IDS = {
    'typescript': '/microsoft/typescript',
    'javascript': '/tc39/ecma262',
    'express': '/expressjs/express',
    'expressjs': '/expressjs/express',
    'vue': '/vuejs/core',
    'vue.js': '/vuejs/core',
    'vuejs': '/vuejs/core',
    'react': '/facebook/react',
    'next.js': '/vercel/next.js',
    'nextjs': '/vercel/next.js',
    'nestjs': '/nestjs/nest',
    'nest': '/nestjs/nest',
    'laravel': '/laravel/framework',
    'php': '/php/php-src',
    'python': '/python/cpython',
    'django': '/django/django',
    'fastapi': '/tiangolo/fastapi',
    'node': '/nodejs/node',
    'node.js': '/nodejs/node',
    'prisma': '/prisma/prisma',
    'typeorm': '/typeorm/typeorm',
    'sequelize': '/sequelize/sequelize',
    'knex': '/knex/knex',
    'mongoose': '/mongoosejs/mongoose',
    'zod': '/colinhacks/zod',
    'jest': '/jestjs/jest',
    'vitest': '/vitest-dev/vitest',
};

export class Context7Service {
    /**
     * Resolve a library ID from a human-readable name.
     * Tries the pre-built map first, then falls back to the Context7 search API.
     * Returns null if resolution fails.
     */
    async resolveLibrary(name) {
        const key = name.toLowerCase().trim();
        if (KNOWN_LIBRARY_IDS[key]) return KNOWN_LIBRARY_IDS[key];

        try {
            const url = `${API_BASE}/search?q=${encodeURIComponent(name)}&limit=3`;
            const res = await fetch(url, { headers: { 'User-Agent': 'bugfix-agent/1.0' } });
            if (!res.ok) return null;
            const data = await res.json();
            const first = data?.results?.[0];
            if (!first?.id) return null;
            logger.info(`[Context7] Resolved "${name}" → ${first.id}`);
            return first.id;
        } catch (e) {
            logger.warn(`[Context7] Library resolution failed for "${name}": ${e.message}`);
            return null;
        }
    }

    /**
     * Fetch documentation for a library.
     * @param {string} libraryId - e.g. "/expressjs/express"
     * @param {string} topic - focus area, e.g. "error handling async middleware"
     * @param {number} tokens - approximate token budget (default 3000)
     * @returns {string} Markdown documentation, or '' on failure
     */
    async getDocs(libraryId, topic = '', tokens = 3000) {
        try {
            const cleanId = libraryId.startsWith('/') ? libraryId.slice(1) : libraryId;
            const encodedId = cleanId.split('/').map(encodeURIComponent).join('/');
            const url =
                `${API_BASE}/${encodedId}` +
                `?tokens=${tokens}` +
                (topic ? `&topic=${encodeURIComponent(topic)}` : '');

            const res = await fetch(url, { headers: { 'User-Agent': 'bugfix-agent/1.0' } });
            if (!res.ok) {
                logger.warn(`[Context7] getDocs(${libraryId}) returned ${res.status}`);
                return '';
            }
            const text = await res.text();
            logger.info(`[Context7] Fetched ${text.length} chars for ${libraryId} (topic: "${topic}")`);
            return text;
        } catch (e) {
            logger.warn(`[Context7] getDocs failed for ${libraryId}: ${e.message}`);
            return '';
        }
    }

    /**
     * Convenience method: given a list of framework/language names and a topic,
     * resolve and fetch docs for the most relevant ones.
     * Returns a combined Markdown string, or '' if nothing was found.
     *
     * @param {string[]} frameworks - e.g. ["TypeScript", "Express"]
     * @param {string}   topic      - e.g. "null_reference error handling async"
     * @param {number}   tokensEach - token budget per library (default 2500)
     */
    async getBestPractices(frameworks, topic = '', tokensEach = 2500) {
        const unique = [...new Set(frameworks.filter(Boolean).map(f => f.trim()))].slice(0, 2);
        if (!unique.length) return '';

        const results = await Promise.allSettled(
            unique.map(async name => {
                const id = await this.resolveLibrary(name);
                if (!id) return null;
                const docs = await this.getDocs(id, topic, tokensEach);
                if (!docs) return null;
                return `### ${name} — Best Practices\n${docs}`;
            })
        );

        return results
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value)
            .join('\n\n---\n\n');
    }
}
