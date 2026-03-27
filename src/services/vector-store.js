/**
 * VectorStoreService
 *
 * Builds a local semantic index of the target repository's source files using
 * CodeBERT embeddings (@xenova/transformers — runs fully in-process, no API key).
 *
 * Lifecycle:
 *   1. build(files, getContent)  — chunk files, embed, save index to .bugfix-agent/vector-index.json
 *   2. search(query, topK)       — embed query, cosine-rank all chunks, return top-K paths
 *
 * The index is persisted in the target repo so consecutive pipeline runs reuse it
 * without re-embedding. It is rebuilt whenever build() is called (typically after
 * DocumentationAgent updates the docs).
 *
 * Token savings:
 *   Replaces up to 4 LLM triage calls (~2048 tokens of 70b model) per ticket with
 *   a local vector search that takes ~5ms and costs $0.
 */

import { pipeline } from '@xenova/transformers';
import { logger } from './logger.js';

const INDEX_PATH = '.bugfix-agent/vector-index.json';

// Max chars per chunk — roughly 300 tokens, enough for a function/class block
const CHUNK_SIZE = 1200;
// Overlap between consecutive chunks so a function boundary is never split blind
const CHUNK_OVERLAP = 200;

// File extensions worth indexing
const SOURCE_EXT = /\.(js|ts|mjs|cjs|jsx|tsx|vue|php|py|rb|go|java|cs|rs|css|scss|html)$/i;
// Paths to skip
const IGNORE = /node_modules|\.git|dist[/\\]|build[/\\]|migrations?[/\\]|\.snap$|\.min\.|assets[/\\]|public[/\\]/i;

export class VectorStoreService {
    constructor(github, config) {
        this.github = github;
        this.config = config;
        this._embedder = null;        // lazy-loaded
        this._embedderFailed = false;  // true quando download falha → modo TF-IDF
        this._buildPromise = null;     // armazenado para waitReady() aguardar
        this._index = null;            // { builtAt, mode, chunks: [{path, startLine, text, embedding?}] }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Build (or rebuild) the vector index from the repo file list.
     * @param {string[]} allFiles  — full list of paths from github.listFiles()
     */
    async build(allFiles) {
        this._buildPromise = this._doBuild(allFiles);
        return this._buildPromise;
    }

    /**
     * Agenda um build a partir de uma Promise de lista de arquivos.
     * Isso permite que o DocAgent dispare o build SEM precisar aguardar o listFiles(),
     * enquanto o orchestrator pode usar waitReady() para aguardar toda a cadeia.
     * @param {Promise<string[]>} allFilesPromise
     */
    scheduleBuild(allFilesPromise) {
        this._buildPromise = allFilesPromise
            .then(files => this._doBuild(files))
            .catch(e => logger.warn('[VectorStore] Scheduled build failed: ' + e.message));
    }

    /**
     * Aguarda o build terminar sem lançar erro (erros já são logados em _doBuild).
     * Use no orchestrator entre o passo de documentação e o de análise.
     */
    async waitReady() {
        if (this._buildPromise) {
            try { await this._buildPromise; } catch { /* já logado em _doBuild */ }
        }
    }

    async _doBuild(allFiles) {
        const files = allFiles.filter(p => SOURCE_EXT.test(p) && !IGNORE.test(p));
        logger.info(`[VectorStore] Building index for ${files.length} source files...`);

        let embedder = null;
        if (!this._embedderFailed) {
            try {
                embedder = await this._getEmbedder();
            } catch (e) {
                logger.warn(`[VectorStore] Embedder unavailable (${e.message}) — switching to TF-IDF mode`);
                this._embedderFailed = true;
            }
        }

        const chunks = [];

        // Fetch files in bounded batches to avoid exhausting the HTTP connection pool
        // and triggering GitHub API rate-limit connection resets ("fetch failed").
        const CONCURRENCY = 10;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(async path => {
                    try {
                        const content = await this.github.getFileContent(path);
                        const fileChunks = this._chunkFile(path, content);
                        for (const chunk of fileChunks) {
                            if (embedder) {
                                const embedding = await this._embed(embedder, chunk.text);
                                chunks.push({ ...chunk, embedding });
                            } else {
                                chunks.push(chunk); // modo TF-IDF: sem embedding
                            }
                        }
                    } catch (e) {
                        logger.warn(`[VectorStore] Skipping ${path}: ${e.message}`);
                    }
                })
            );
        }

        const mode = this._embedderFailed ? 'TF-IDF' : 'vector';
        this._index = { builtAt: new Date().toISOString(), mode, chunks };
        logger.info(`[VectorStore] Index built [${mode}]: ${chunks.length} chunks from ${files.length} files`);

        // Persist to repo — non-blocking, best-effort
        this._saveIndex().catch(e =>
            logger.warn('[VectorStore] Could not persist index: ' + e.message)
        );

        return this._index;
    }

    /**
     * Load existing index from repo (called at startup to avoid re-embedding on restart).
     * Returns true if a valid index was loaded.
     */
    async load() {
        try {
            const raw = await this.github.getFileContent(INDEX_PATH);
            this._index = JSON.parse(raw);
            // Detecta modo TF-IDF: chunks sem campo embedding ou flag salva
            if (this._index.mode === 'TF-IDF' || !(this._index.chunks?.[0]?.embedding)) {
                this._embedderFailed = true;
            }
            const mode = this._index.mode ?? 'vector';
            logger.info(`[VectorStore] Loaded existing index: ${this._index.chunks?.length ?? 0} chunks [${mode}] (built ${this._index.builtAt})`);
            return true;
        } catch {
            return false; // índice ainda não existe — será criado após a primeira geração de docs
        }
    }

    /**
     * Search for the most relevant source file chunks for a given query.
     * @param {string} query   — natural language or code snippet (e.g. ticket description)
     * @param {number} topK    — number of top-ranked chunks to return (default 8)
     * @returns {Array<{path, startLine, text, score}>}
     */
    async search(query, topK = 8) {
        if (!this._index?.chunks?.length) {
            logger.warn('[VectorStore] Index not built yet — returning empty results');
            return [];
        }

        let scored;
        if (this._embedderFailed) {
            // Modo TF-IDF — sem chamada de rede, sem GPU
            scored = this._index.chunks.map(chunk => ({
                path: chunk.path,
                startLine: chunk.startLine,
                text: chunk.text,
                score: this._tfidfScore(chunk.text, query),
            }));
        } else {
            const embedder = await this._getEmbedder();
            const queryVec = await this._embed(embedder, query);
            scored = this._index.chunks.map(chunk => ({
                path: chunk.path,
                startLine: chunk.startLine,
                text: chunk.text,
                score: this._cosine(queryVec, chunk.embedding),
            }));
        }

        scored.sort((a, b) => b.score - a.score);

        // Deduplicate: keep the best-scoring chunk per file, then fill remaining slots
        const seen = new Set();
        const deduplicated = [];
        for (const item of scored) {
            if (!seen.has(item.path)) {
                seen.add(item.path);
                deduplicated.push(item);
                if (deduplicated.length >= topK) break;
            }
        }

        return deduplicated;
    }

    /**
     * Return the unique file paths from a search result, highest-scored first.
     * Convenient shortcut for the AnalysisAgent triage use case.
     */
    async searchPaths(query, topK = 8) {
        const results = await this.search(query, topK);
        return results.map(r => r.path);
    }

    /** True if the index has been built or loaded. */
    get isReady() {
        return !!(this._index?.chunks?.length);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Lazily initialize the CodeBERT embedder (downloads ~90MB model on first call,
     * then cached in node_modules/.cache/huggingface by the transformers library).
     */
    async _getEmbedder() {
        if (!this._embedder) {
            logger.info('[VectorStore] Loading CodeBERT model (first run may download ~90MB)...');
            this._embedder = await pipeline(
                'feature-extraction',
                'Xenova/codebert-base',
                { revision: 'main' }
            );
            logger.info('[VectorStore] CodeBERT model ready');
        }
        return this._embedder;
    }

    /**
     * Embed a text string — returns a plain number[] (mean-pooled, L2-normalised).
     */
    async _embed(embedder, text) {
        const output = await embedder(text.slice(0, CHUNK_SIZE), {
            pooling: 'mean',
            normalize: true,
        });
        return Array.from(output.data);
    }

    /**
     * Split a file into overlapping text chunks with path and startLine metadata.
     */
    _chunkFile(path, content) {
        const lines = content.split('\n');
        const chunks = [];
        let i = 0;

        while (i < lines.length) {
            const chunkLines = [];
            let charCount = 0;
            let j = i;

            while (j < lines.length && charCount < CHUNK_SIZE) {
                chunkLines.push(lines[j]);
                charCount += lines[j].length + 1;
                j++;
            }

            if (chunkLines.length > 0) {
                chunks.push({
                    path,
                    startLine: i + 1, // 1-based
                    text: `// ${path}\n` + chunkLines.join('\n'),
                });
            }

            // Advance by (chunk size - overlap), minimum 1 line
            const advance = Math.max(1, chunkLines.length - Math.floor(CHUNK_OVERLAP / 80));
            i += advance;
        }

        return chunks;
    }

    /**
     * Tokeniza texto para TF-IDF:
     *   - separa camelCase/PascalCase ("ContactForm" → ["contact","form"])
     *   - separa acrônimos ("WBotService" → ["wbot","service"])
     *   - filtra tokens com < 3 chars e puramente numéricos
     */
    _tokenize(text) {
        return text
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .toLowerCase()
            .split(/[\W_]+/)
            .filter(t => t.length > 2 && !/^\d+$/.test(t));
    }

    /**
     * Verifica se dois tokens fazem match:
     *   1. Igualdade exata
     *   2. Substring (um contém o outro)
     *   3. Prefix de 5 chars — cobre cognatos PT↔EN
     *      ("contatos" ↔ "contact" compartilham "conta")
     */
    _termMatch(a, b) {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        const prefixLen = Math.min(a.length, b.length, 5);
        return prefixLen >= 4 && a.slice(0, prefixLen) === b.slice(0, prefixLen);
    }

    /**
     * TF-IDF melhorado:
     *   - tokens no PATH do arquivo valem 3× (sinal muito mais forte que conteúdo)
     *   - camelCase é decomposto antes da comparação
     *   - prefix match de 5 chars cobre termos PT/EN cognatos
     */
    _tfidfScore(chunkText, query) {
        // Primeira linha do chunk é sempre "// path/to/file.ext"
        const nl = chunkText.indexOf('\n');
        const pathLine = nl > 0 ? chunkText.slice(0, nl) : chunkText;
        const pathTokens = this._tokenize(pathLine);
        const contentTokens = this._tokenize(chunkText.slice(nl > 0 ? nl : 0));

        const queryTerms = this._tokenize(query);
        if (!queryTerms.length) return 0;

        let score = 0;
        for (const qt of queryTerms) {
            if (pathTokens.some(pt => this._termMatch(qt, pt))) {
                score += 3; // match no caminho: peso 3×
            } else if (contentTokens.some(ct => this._termMatch(qt, ct))) {
                score += 1; // match no conteúdo: peso 1×
            }
        }
        // Normaliza para [0,1] usando o máximo teórico (3 × nTermos)
        return score / (queryTerms.length * 3);
    }

    /**
     * Cosine similarity between two equal-length float arrays.
     */
    _cosine(a, b) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    async _saveIndex() {
        await this.github.commitFile(
            this.config?.defaultBranch ?? 'main',
            INDEX_PATH,
            JSON.stringify(this._index),
            'chore: update vector index [skip ci]'
        );
    }
}
