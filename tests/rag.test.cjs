const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
const originalLoad = Module._load;
const handlers = new Map();
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => root }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const { processUploads } = require('../src/main/fileUploads');
const sessions = require('../src/main/sessionManager');
const rag = require('../src/main/ragManager');
const { getRagSettings, saveRagSettings } = require('../src/main/configManager');
function pdf(text) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
(async () => {
  try {
    initDatabase();
    assert.equal(getRagSettings().embeddingPort, 8081);
    saveRagSettings({ embeddingPort: 9091, embeddingModel: 'embed', embeddingApiKey: '' });
    closeDatabase(); initDatabase();
    assert.equal(getRagSettings().embeddingPort, 9091);
    assert.throws(() => saveRagSettings({ embeddingPort: 0 }), /Invalid/);
    const chunks = rag.chunkText('a'.repeat(900));
    assert.deepEqual(chunks.map(s => s.length), [500, 450]);
    assert.equal(rag.chunkText('😀'.repeat(501))[0].length, 1000);
    assert.deepEqual(rag.chunkText(' \n '), []);
    assert.throws(() => rag.chunkText('test', 50, 50), /Invalid/);
    assert.equal(rag.cosineSimilarity([1, 0], [2, 0]), 1);
    assert.equal(rag.cosineSimilarity([1, 0], [0, 1]), 0);
    assert.throws(() => rag.cosineSimilarity([0, 0], [1, 0]), /zero/);
    assert.throws(() => rag.cosineSimilarity([1], [1, 0]), /dimensions/);
    assert.throws(() => rag.normalized([null]), /invalid/);
    const parsed = await rag.parseDocument('sample.pdf', pdf('PDF offline document text'));
    assert.match(parsed, /PDF offline document text/);
    assert.equal((await rag.parseDocument('blank.pdf', pdf(''))).trim(), '');
    const source = path.join(root, 'guide.txt');
    fs.writeFileSync(source, 'alpha '.repeat(150));
    const other = path.join(root, 'other.csv'); fs.writeFileSync(other, 'beta,private\n1,2');
    const markdown = path.join(root, 'readme.md'); fs.writeFileSync(markdown, '# markdown');
    const pdfFile = path.join(root, 'guide.pdf'); fs.writeFileSync(pdfFile, pdf('PDF offline document text'));
    const files = await processUploads([source, other, markdown, pdfFile]);
    let calls = 0;
    const embedder = { modelKey: 'test:embed', embed: async text => { calls++; return text.includes('alpha') ? [1, 0] : [0, 1]; } };
    const progress = [];
    await rag.indexDocuments(files, { embedder, onProgress: value => progress.push(value) });
    assert.ok(progress.some(p => p.stage === 'Indexing' && p.total > 1));
    assert.ok(progress.some(p => p.fileName === 'guide.pdf' && p.stage === 'Indexed'));
    const count = calls;
    await rag.indexDocuments(files, { embedder });
    assert.equal(calls, count);
    const matches = rag.findRelevantChunks([1, 0], 3, { filePaths: [files[0].file_path], modelKey: embedder.modelKey });
    assert.ok(matches.length > 0 && matches.every(row => row.file_name === 'guide.txt' && row.score === 1));
    assert.deepEqual(rag.findRelevantChunks([1, 0]), []);
    assert.deepEqual(rag.findRelevantChunks([1, 0], 3, { filePaths: [files[0].file_path], modelKey: 'different' }), []);
    sessions.getOrCreateSession('a', 'chat');
    const saved = sessions.saveMessage('a', 'user', 'alpha?', [files[0]]);
    sessions.getOrCreateSession('b', 'chat');
    sessions.saveMessage('b', 'user', 'beta?', [files[1]]);
    assert.ok((await rag.retrieveContext('a', 'alpha?', { embedder })).every(row => row.file_name === 'guide.txt'));
    const branch = sessions.branchChat('a', saved.id);
    assert.ok((await rag.retrieveContext(branch.sessionId, 'alpha?', { embedder })).length);
    sessions.deleteMessage('a', saved.id);
    assert.deepEqual(await rag.retrieveContext('a', 'alpha?', { embedder }), []);
    const before = db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get().n;
    fs.writeFileSync(files[0].file_path, 'changed '.repeat(200));
    let n = 0;
    await assert.rejects(rag.indexDocuments([files[0]], { embedder: { ...embedder, embed: async () => { if (++n === 2) throw new Error('offline'); return [1, 0]; } } }), /offline/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get().n, before);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(rag.indexDocuments([files[0]], { embedder, signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(rag.indexDocuments([{ file_path: source, mime_type: 'text/plain' }], { embedder }), /Invalid managed/);
    const requests = [];
    const client = await rag.createEmbedder({ settings: { embeddingPort: 8081, embeddingModel: '', embeddingApiKey: 'secret' }, fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(url.endsWith('/models') ? { data: [{ id: 'embed' }] } : { data: [{ embedding: [3, 4] }] });
    } });
    assert.deepEqual(await client.embed('query'), [0.6, 0.8]);
    assert.equal(requests[1].url, 'http://127.0.0.1:8081/v1/embeddings');
    assert.equal(JSON.parse(requests[1].options.body).input, 'query');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer secret');
    const { EventEmitter } = require('node:events');
    const manager = require('../src/main/mcpManager');
    const originalInit = manager.init, originalFetch = global.fetch;
    manager.init = async () => {};
    const events = [];
    const sender = new EventEmitter(); sender.isDestroyed = () => false;
    sender.send = (_channel, value) => events.push(value);
    const { registerIpcHandlers } = require('../src/main/ipcHandlers');
    const dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted, getEngineConfig: () => ({ port: 8080 }) });
    global.fetch = async (url, options) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'embed' }] });
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: [0, 1] }] });
      const payload = JSON.parse(options.body);
      assert.match(payload.messages[0].content, /beta,private/);
      assert.doesNotMatch(payload.messages[0].content, /changed changed|alpha alpha/);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'CSV answer' } }] });
    };
    try {
      await assert.rejects(handlers.get('rag:index')({ trusted: false, sender }, { requestId: 'bad', attachments: [files[1]] }), /Unauthorized/);
      await handlers.get('rag:index')({ trusted: true, sender }, { requestId: 'index', attachments: [files[1]] });
      assert.ok(events.some(event => event.requestId === 'index' && event.type === 'indexing' && event.stage === 'Indexed'));
      const result = await handlers.get('engine:chat')({ trusted: true, sender }, {
        requestId: 'chat', sessionId: 'b', modelId: 'chat', messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'beta?' }],
      });
      assert.equal(result.text, 'CSV answer');
      assert.equal(sender.listenerCount('destroyed'), 0);
    } finally { dispose(); manager.init = originalInit; global.fetch = originalFetch; }
    console.log('PDF/TXT/MD/CSV parsing, chunking, local embedding payload, persistence, cache, scoped retrieval, branches, cancellation, and atomic failure passed.');
  } finally { closeDatabase(); Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
