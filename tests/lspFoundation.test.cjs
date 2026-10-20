'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const rpc = require('vscode-jsonrpc/node');
const { Client, LspManager, languages, runtimePath } = require('../src/main/lspManager');
function fake() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const server = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
  server.listen(); return { child, server };
}
test('transport correlation, concurrency, notifications, errors, timeout, cancellation and termination', async () => {
  const { child, server } = fake(); const client = new Client(child, { timeout: 2000, pendingLimit: 4 });
  try {
    server.onRequest('echo', p => p); server.onRequest('error', () => { throw new rpc.ResponseError(-32001, 'fixture error'); });
    server.onRequest('wait', () => new Promise(() => {}));
    assert.deepEqual(await Promise.all([client.request('echo', 1), client.request('echo', 2)]), [1, 2]);
    const note = new Promise(resolve => server.onNotification('note', resolve)); await client.notify('note', { a: 1 }); assert.deepEqual(await note, { a: 1 });
    await assert.rejects(client.request('error'), /fixture error/);
    await assert.rejects(client.request('wait', {}, { timeout: 40 }), { code: 'REQUEST_TIMEOUT' });
    const controller = new AbortController(); const waiting = client.request('wait', {}, { signal: controller.signal }); controller.abort(); await assert.rejects(waiting, { code: 'REQUEST_CANCELLED' });
    await assert.rejects(client.request('echo', {}, { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
    const pending = client.request('wait'); child.emit('exit', 1); await assert.rejects(pending, { code: 'SERVER_TERMINATED' }); assert.equal(client.pending.size, 0);
  } finally { client.terminate(); server.dispose(); }
});
test('all supported extensions and packaged runtime path', () => {
  assert.equal(Object.keys(languages).length, 8); assert.equal(languages['.jsx'], 'javascriptreact'); assert.equal(languages['.tsx'], 'typescriptreact');
  assert.equal(runtimePath('/a/app.asar/node_modules/a'), '/a/app.asar.unpacked/node_modules/a');
});
test('lifecycle, isolation, hash refresh, traversal, symlinks, deletion, capabilities and positions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-unit-')); const fixtures = []; let starts = 0;
  const manager = new LspManager({ authorize: c => c?.allowed ? root : null, spawnServer: () => {
    starts++; const f = fake(); fixtures.push(f);
    f.server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 2, hoverProvider: true } }));
    f.server.onRequest('textDocument/hover', () => null); f.server.onRequest('shutdown', () => null); f.server.onNotification('exit', () => f.child.kill()); return f.child;
  } });
  const ctx = { allowed: true }; await fs.writeFile(path.join(root, '空 😀.ts'), 'const x = "😀";\n');
  try {
    await assert.rejects(manager.acquire({}), { code: 'WORKSPACE_UNAUTHORIZED' });
    const [a, b] = await Promise.all([manager.acquire(ctx), manager.acquire(ctx)]); assert.equal(a, b); assert.equal(starts, 1); assert.equal(a.state, 'ready');
    const doc = await manager.refresh(ctx, '空 😀.ts'); assert.equal(doc.version, 1); assert.match(doc.uri, /%/); assert.match(doc.hash, /^sha256:/);
    assert.equal((await manager.refresh(ctx, '空 😀.ts')).version, 1);
    await fs.writeFile(path.join(root, '空 😀.ts'), ''); assert.equal((await manager.refresh(ctx, '空 😀.ts')).version, 2);
    assert.equal(await manager.request(ctx, 'textDocument/hover', { path: '空 😀.ts', position: { line: 0, character: 0 } }), null);
    await assert.rejects(manager.request(ctx, 'textDocument/hover', { path: '空 😀.ts', position: { line: 0, character: 1 } }), { code: 'INVALID_POSITION' });
    await assert.rejects(manager.request(ctx, 'workspace/executeCommand'), { code: 'UNSUPPORTED_METHOD' });
    await assert.rejects(manager.request(ctx, 'textDocument/definition'), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(manager.refresh(ctx, '../escape.ts'), { code: 'WORKSPACE_UNAUTHORIZED' });
    await fs.symlink(os.tmpdir(), path.join(root, 'escape')); await assert.rejects(manager.refresh(ctx, 'escape/a.ts'), { code: 'WORKSPACE_UNAUTHORIZED' });
    await fs.unlink(path.join(root, '空 😀.ts')); await assert.rejects(manager.refresh(ctx, '空 😀.ts'), { code: 'ENOENT' }); assert.equal(a.documents.size, 0);
    await manager.closeRoot(root); assert.equal(a.state, 'stopped'); await manager.acquire(ctx); assert.equal(starts, 2);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fs.rm(root, { recursive: true, force: true }); }
});
test('real bundled server: diagnostics, fix, definitions, references, hover, TSX, JS and cleanup', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-real-'));
  const manager = new LspManager({ authorize: () => root });
  const files = { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' }, include: ['**/*'] }), 'a.ts': 'export const answer: number = 42;\n', 'b.ts': 'import { answer } from "./a";\nconst value: string = answer;\n', 'view.tsx': 'const element = <div />;\n', 'plain.js': 'const value = 1;\n' };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  try {
    const e = await manager.acquire({}); const pid = e.client.child.pid; assert.equal(e.state, 'ready');
    await manager.refresh({}, 'a.ts'); await manager.refresh({}, 'b.ts'); await manager.refresh({}, 'view.tsx'); await manager.refresh({}, 'plain.js');
    async function diagnostic(predicate) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const d = await manager.diagnostics({}, 'b.ts'); if (d && predicate(d)) return d; await new Promise(r => setTimeout(r, 50)); } throw new Error('Expected diagnostics did not arrive'); }
    const started = performance.now(); const error = await diagnostic(d => d.diagnostics.some(x => x.code === 2322)); assert.ok(error.diagnostics.length); const diagnosticsMs = performance.now() - started;
    const input = { path: 'b.ts', position: { line: 1, character: 23 }, includeDeclaration: true };
    assert.ok((await manager.request({}, 'textDocument/definition', input)).length);
    assert.ok((await manager.request({}, 'textDocument/references', input)).length);
    assert.ok(await manager.request({}, 'textDocument/hover', input));
    await fs.writeFile(path.join(root, 'b.ts'), files['b.ts'].replace(': string', ': number')); await manager.refresh({}, 'b.ts');
    await diagnostic(d => !d.diagnostics.some(x => x.code === 2322));
    await manager.close(); assert.equal(e.state, 'stopped'); assert.throws(() => process.kill(pid, 0));
    console.log('LSP_BENCHMARK', JSON.stringify({ ...e.timings, diagnosticsMs }));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('instance limits, separate roots, crash, explicit restart, init failure and bounded forced cleanup', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-lifecycle-')); const roots = [path.join(base, 'a'), path.join(base, 'b')];
  await Promise.all(roots.map(r => fs.mkdir(r))); const fixtures = [];
  const manager = new LspManager({ authorize: c => roots[c.index], maxInstances: 2, shutdownTimeout: 20, spawnServer: () => {
    const f = fake(); fixtures.push(f); f.server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 1 } }));
    f.server.onRequest('shutdown', () => new Promise(() => {})); return f.child;
  } });
  try {
    const a = await manager.acquire({ index: 0 }); const b = await manager.acquire({ index: 1 }); assert.notEqual(a, b);
    a.client.child.kill(); assert.equal(a.state, 'failed');
    await manager.closeRoot(roots[0]); assert.equal(a.state, 'stopped'); assert.notEqual(await manager.acquire({ index: 0 }), a);
    await assert.rejects(manager.acquire({ index: 2 }), { code: 'WORKSPACE_UNAUTHORIZED' });
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(manager.acquire({ index: 0 }, cancelled.signal), { code: 'REQUEST_CANCELLED' });
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); }
  const f = fake(); f.server.onRequest('initialize', () => ({ nope: true }));
  const broken = new LspManager({ authorize: () => roots[0], spawnServer: () => f.child });
  try { await assert.rejects(broken.acquire({}), { code: 'INITIALIZATION_FAILED' }); assert.equal([...broken.instances.values()][0].state, 'failed'); }
  finally { await broken.close(); f.server.dispose(); await fs.rm(base, { recursive: true, force: true }); }
});
test('pending bound, initialization timeout and cancellation while shared startup continues', async () => {
  const f = fake(); const client = new Client(f.child, { pendingLimit: 1, timeout: 30 });
  f.server.onRequest('wait', () => new Promise(() => {}));
  const wait = client.request('wait'); await assert.rejects(client.request('wait'), { code: 'REQUEST_LIMIT' }); await assert.rejects(wait, { code: 'REQUEST_TIMEOUT' }); client.terminate(); f.server.dispose();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-init-')); const fixtures = [];
  const manager = new LspManager({ authorize: () => root, initializationTimeout: 100, shutdownTimeout: 10, spawnServer: () => {
    const fixture = fake(); fixtures.push(fixture); fixture.server.onRequest('initialize', () => new Promise(() => {})); return fixture.child;
  } });
  try {
    const controller = new AbortController(); const cancelled = manager.acquire({}, controller.signal); setTimeout(() => controller.abort(), 10);
    await assert.rejects(cancelled, { code: 'REQUEST_CANCELLED' });
    await assert.rejects(manager.acquire({}), { code: 'INITIALIZATION_FAILED' }); assert.equal(manager.instances.size, 1);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fs.rm(root, { recursive: true, force: true }); }
});
test('malformed protocol terminates pending work safely', async () => {
  const f = fake(); const client = new Client(f.child, { timeout: 1000 });
  f.server.onRequest('wait', () => new Promise(() => {}));
  const pending = client.request('wait');
  f.child.stdout.write('Content-Length: 1\r\n\r\n{');
  await assert.rejects(pending, { code: 'SERVER_TERMINATED' }); assert.equal(client.pending.size, 0);
  client.terminate(); f.server.dispose();
});
test('real JS-only project without configuration provides hover', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-js-')); const manager = new LspManager({ authorize: () => root });
  try {
    await fs.writeFile(path.join(root, 'plain.js'), 'const greeting = "hello 😀";\ngreeting;\n');
    const hover = await manager.request({}, 'textDocument/hover', { path: 'plain.js', position: { line: 1, character: 2 } }); assert.ok(hover?.contents);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('incremental UTF-16 changes, diagnostics freshness, save, rename and close notifications', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-sync-')); const f = fake(); const notices = [];
  f.server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: { openClose: true, change: 2, save: { includeText: true } }, hoverProvider: true } }));
  f.server.onRequest('shutdown', () => null); f.server.onNotification('exit', () => f.child.kill());
  for (const method of ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didSave']) f.server.onNotification(method, params => notices.push({ method, params }));
  const manager = new LspManager({ authorize: () => root, spawnServer: () => f.child }); const file = path.join(root, 'old.ts');
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    await fs.writeFile(file, '😀'); const doc = await manager.refresh({}, 'old.ts'); await manager.refresh({}, 'old.ts'); await tick();
    assert.equal(notices.filter(n => n.method.endsWith('didOpen')).length, 1);
    await f.server.sendNotification('textDocument/publishDiagnostics', { uri: doc.uri, version: 1, diagnostics: [{ code: 1, message: 'fixture', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }] }); await tick(); assert.equal((await manager.diagnostics({}, 'old.ts')).stale, false);
    await fs.writeFile(file, 'x'); await manager.saved({}, 'old.ts'); await tick();
    const change = notices.find(n => n.method.endsWith('didChange')).params; assert.equal(change.textDocument.version, 2); assert.equal(change.contentChanges[0].range.end.character, 2);
    assert.equal(await manager.diagnostics({}, 'old.ts'), null); assert.equal(notices.find(n => n.method.endsWith('didSave')).params.text, 'x');
    await f.server.sendNotification('textDocument/publishDiagnostics', { uri: doc.uri, version: 1, diagnostics: [] }); await tick(); assert.equal((await manager.diagnostics({}, 'old.ts')).stale, true);
    await fs.rename(file, path.join(root, 'new.ts')); await assert.rejects(manager.refresh({}, 'old.ts'), { code: 'ENOENT' }); await manager.refresh({}, 'new.ts'); await manager.closeFile({}, 'new.ts'); await tick();
    assert.equal(notices.filter(n => n.method.endsWith('didClose')).length, 2); assert.equal((await manager.acquire({})).documents.size, 0);
  } finally { await manager.close(); f.server.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
test('split/concatenated framing and duplicate responses retain request correlation', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
  const client = new Client(child, { timeout: 1000 }); const requests = [];
  child.stdin.on('data', chunk => {
    const wire = chunk.toString(); const start = wire.indexOf('{'); if (start >= 0) requests.push(JSON.parse(wire.slice(start)));
  });
  try {
    const first = client.request('first'); const second = client.request('second'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2); assert.notEqual(requests[0].id, requests[1].id);
    const frame = (id, result) => { const body = JSON.stringify({ jsonrpc: '2.0', id, result }); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; };
    const wire = frame(requests[1].id, 'two') + frame(requests[0].id, 'one') + frame(requests[0].id, 'duplicate');
    child.stdout.write(wire.slice(0, 8)); child.stdout.write(wire.slice(8, 37)); child.stdout.write(wire.slice(37));
    assert.deepEqual(await Promise.all([first, second]), ['one', 'two']); assert.equal(client.pending.size, 0);
  } finally { client.terminate(); }
});
