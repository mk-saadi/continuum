'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { db } = require('./db');
const { validateAttachments, attachmentName } = require('./fileUploads');
const { app } = require('electron');
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_MODEL_KEY = `transformers:${EMBEDDING_MODEL}:quantized:mean:normalized`;
let extractor = null;
const DOCUMENT_MIMES = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'];

function chunkText(text, size = 500, overlap = 50) {
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new Error('Invalid chunk size or overlap.');
  const chars = Array.from(text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim());
  const chunks = [];
  for (let start = 0; start < chars.length; start += size - overlap) {
    const value = chars.slice(start, start + size).join('');
    if (value.trim()) chunks.push(value);
    if (start + size >= chars.length) break;
  }
  if (chunks.length > 10000) throw new Error('Document exceeds the 10,000 chunk limit. Split it into smaller files.');
  return chunks;
}

async function parseDocument(filePath, bytes) {
  if (path.extname(filePath).toLowerCase() !== '.pdf') return bytes.toString('utf8');
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try { return (await parser.getText({ pageJoiner: '' })).text; }
  finally { await parser.destroy(); }
}

function normalized(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 65536 || !vector.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Embedding model returned an invalid vector.');
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding model returned a zero or invalid vector.');
  return vector.map(v => v / norm);
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Embedding dimensions do not match. Reindex with the current embedding model.');
  const x = normalized(a), y = normalized(b);
  return x.reduce((sum, v, i) => sum + v * y[i], 0);
}

async function getEmbedder() {
  if (!extractor) {
    // Cache the promise too: concurrent indexing/query requests share one model.
    extractor = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = path.join(require("./configStore").getConfig().appDataDirectory, 'embedding-models');
      await fs.mkdir(env.cacheDir, { recursive: true });
      return pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true });
    })().catch(error => {
      extractor = null; // Allow retry after a failed first download or model load.
      throw error;
    });
  }
  return extractor;
}

async function generateEmbedding(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function createEmbedder({ signal } = {}) {
  signal?.throwIfAborted();
  return { modelKey: EMBEDDING_MODEL_KEY, async embed(text) {
    signal?.throwIfAborted();
    const vector = await generateEmbedding(text);
    // Native inference cannot be interrupted, but cancelled results are discarded.
    signal?.throwIfAborted();
    return normalized(vector);
  } };
}

async function indexDocuments(attachments, { embedder, signal, onProgress = () => {} } = {}) {
  const files = validateAttachments(attachments).filter(file => DOCUMENT_MIMES.includes(file.mime_type));
  if (!files.length) return [];
  embedder ??= await createEmbedder({ signal });
  const indexed = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const fileName = attachmentName(file.file_path);
    const bytes = await fs.readFile(file.file_path);
    signal?.throwIfAborted();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cached = db.prepare('SELECT COUNT(*) AS n FROM document_chunks WHERE file_path = ? AND content_hash = ? AND embedding_model = ?').get(file.file_path, hash, embedder.modelKey);
    if (cached.n) {
      indexed.push(file.file_path); continue;
    }
    // Cache checks are not indexing work: do not replay old upload banners.
    onProgress({ fileName, completed: 0, total: 0, stage: 'Parsing' });
    const chunks = chunkText(await parseDocument(file.file_path, bytes));
    if (!chunks.length) throw new Error(`${fileName} contains no extractable text. Scanned PDFs require OCR before uploading.`);
    const vectors = [];
    onProgress({ fileName, completed: 0, total: chunks.length, stage: 'Indexing' });
    for (const text of chunks) {
      signal?.throwIfAborted();
      const vector = normalized(await embedder.embed(text));
      if (vectors.length && vector.length !== vectors[0].length) throw new Error('Embedding dimensions changed during indexing.');
      vectors.push(vector);
      onProgress({ fileName, completed: vectors.length, total: chunks.length, stage: 'Indexing' });
    }
    signal?.throwIfAborted();
    // Publish only a complete index. Failed/cancelled requests preserve the old index.
    db.transaction(() => {
      db.prepare('DELETE FROM document_chunks WHERE file_path = ? AND embedding_model = ?').run(file.file_path, embedder.modelKey);
      const insert = db.prepare(`INSERT INTO document_chunks
        (file_name, file_path, content_hash, embedding_model, chunk_index, chunk_text, embedding_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      chunks.forEach((text, i) => insert.run(fileName, file.file_path, hash, embedder.modelKey, i, text, JSON.stringify(vectors[i])));
    }).immediate();
    onProgress({ fileName, completed: chunks.length, total: chunks.length, stage: 'Indexed' });
    indexed.push(file.file_path);
  }
  return indexed;
}

function findRelevantChunks(queryEmbedding, topK = 3, { filePaths, modelKey } = {}) {
  const query = normalized(queryEmbedding);
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new Error('topK must be between 1 and 20.');
  // Callers must scope retrieval to attached documents, never the global library.
  if (!Array.isArray(filePaths) || !filePaths.length || !modelKey) return [];
  const select = db.prepare('SELECT * FROM document_chunks WHERE file_path = ? AND embedding_model = ? ORDER BY chunk_index');
  const best = [];
  for (const filePath of new Set(filePaths)) {
    for (const row of select.all(filePath, modelKey)) {
      const score = cosineSimilarity(query, JSON.parse(row.embedding_json));
      best.push({ ...row, score });
      best.sort((a, b) => b.score - a.score || a.id - b.id);
      if (best.length > topK) best.pop();
    }
  }
  return best.map(({ file_name, chunk_text, chunk_index, score }) => ({ file_name, chunk_text, chunk_index, score }));
}

async function retrieveContext(sessionId, question, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid document chat session.');
  const attachments = db.prepare(`SELECT DISTINCT a.file_path, a.mime_type FROM message_attachments a
    JOIN messages m ON m.id = a.message_id WHERE m.session_id = ?`).all(sessionId)
    .filter(file => DOCUMENT_MIMES.includes(file.mime_type));
  if (!attachments.length) return [];
  const embedder = options.embedder ?? await createEmbedder(options);
  // Historical documents may span many upload batches; validate each managed file.
  const paths = [];
  for (const attachment of attachments) {
    paths.push(...await indexDocuments([attachment], { ...options, embedder }));
  }
  const query = await embedder.embed(question || 'Summarize the attached documents.');
  return findRelevantChunks(query, 3, { filePaths: paths, modelKey: embedder.modelKey });
}
module.exports = { DOCUMENT_MIMES, chunkText, parseDocument, normalized, cosineSimilarity, getEmbedder, generateEmbedding, createEmbedder, indexDocuments, findRelevantChunks, retrieveContext };
