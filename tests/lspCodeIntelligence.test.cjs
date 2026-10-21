'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const rpc = require('vscode-jsonrpc/node');
const { LspManager } = require('../src/main/lspManager');
const { LspCodeIntelligence } = require('../src/main/lspCodeIntelligence');
const r = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp2-'));
  await fs.writeFile(path.join(root, '空 😀.tsx'), 'const emoji = "😀"; const value = 1;\n');
  await fs.writeFile(path.join(root, 'other.ts'), 'export const value = 1;\n');
  const servers = []; let calls = 0;
  const context = { permissionMode: 'workspace_write' };
  const manager = new LspManager({ authorize: c => ['workspace_write', 'full_access'].includes(c?.permissionMode) ? root : null, shutdownTimeout: 30, spawnServer: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    const server = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
    server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 2, definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, ...options.capabilities } }));
    server.onRequest('shutdown', () => null); server.onNotification('exit', () => child.kill());
    server.onRequest('textDocument/definition', p => { calls++; return options.definition ? options.definition(p) : [{ targetUri: pathToFileURL(path.join(root, 'other.ts')).href, targetRange: r, targetSelectionRange: r }, { uri: pathToFileURL('/tmp/outside.ts').href, range: r }]; });
    server.onRequest('textDocument/references', p => { calls++; options.onReferences?.(p); return Array.from({ length: 80 }, (_, i) => ({ uri: pathToFileURL(path.join(root, 'other.ts')).href, range: { start: { line: i % 40, character: 0 }, end: { line: i % 40, character: 1 } } })); });
    server.onRequest('textDocument/hover', p => { calls++; return options.hover ? options.hover(p) : { contents: [{ language: 'typescript', value: 'const value: 1' }, 'Documentation <script>untrusted</script>'], range: r }; });
    server.onRequest('textDocument/documentSymbol', () => options.symbols ?? [{ name: 'Class', kind: 5, range: r, selectionRange: r, children: [{ name: 'method', kind: 6, range: r, selectionRange: r }] }]);
    server.onRequest('workspace/symbol', () => [{ name: 'value', kind: 13, containerName: 'module', location: { uri: pathToFileURL(path.join(root, 'other.ts')).href, range: r } }]);
    server.listen(); servers.push(server); return child;
  } });
  const api = new LspCodeIntelligence(manager, options.pagination);
  const input = { executionContext: context, filePath: '空 😀.tsx', line: 1, column: 26 };
  return { root, manager, api, context, input, servers, calls: () => calls, close: async () => { await manager.close(); servers.forEach(s => s.dispose()); await fs.rm(root, { recursive: true, force: true }); } };
}
test('six normalized internal operations: links, hierarchy, UTF-16, exclusion, pagination and hover', async () => {
  const f = await fixture({ onReferences: p => assert.equal(p.context.includeDeclaration, true) });
  try {
    const d = await f.api.definition(f.input); assert.equal(d.success, true); assert.equal(d.results[0].path, 'other.ts'); assert.equal(d.results[0].startLine, 1); assert.equal(d.excludedCount, 1); assert.match(d.sourceVersion, /^sha256:/);
    const refs = await f.api.references({ ...f.input, includeDeclaration: true, pageSize: 10 }); assert.equal(refs.totalCount, 40); assert.equal(refs.results.length, 10);
    const calls = f.calls(); await fs.writeFile(path.join(f.root, 'other.ts'), 'changed');
    const next = await f.api.references({ executionContext: f.context, cursor: refs.nextCursor, pageSize: 10 }); assert.equal(next.results[0].startLine, 11); assert.equal(next.snapshotId, refs.snapshotId); assert.equal(f.calls(), calls); assert.equal(next.provenance, 'immutable-query-snapshot');
    assert.equal((await f.api.hover(f.input)).untrusted, true);
    assert.equal((await f.api.hover({ ...f.input, maxCharacters: 5 })).truncated, true);
    const outline = await f.api.documentSymbols(f.input); assert.equal(outline.results[1].parentId, outline.results[0].id); assert.equal(outline.results[1].depth, 1);
    assert.equal((await f.api.workspaceSymbols({ executionContext: f.context, query: 'value' })).results[0].kind, 13);
    assert.equal((await f.api.diagnostics(f.input)).state, 'pending');
    assert.equal((await f.api.definition({ ...f.input, line: 0 })).error.code, 'LSP_INVALID_POSITION');
    assert.equal((await f.api.definition({ ...f.input, column: 1000 })).error.code, 'LSP_INVALID_POSITION');
    for (const filePath of ['../other.ts', '/tmp/a.ts', 'C:\\private.ts', 'file:///tmp/a.ts']) assert.equal((await f.api.definition({ ...f.input, filePath })).success, false);
  } finally { await f.close(); }
});
test('mode matrix, independent callers, transitions, cursor revocation and pending request downgrade', async () => {
  const f = await fixture({ hover: () => new Promise(resolve => setTimeout(() => resolve(null), 150)) });
  try {
    for (const mode of ['read_only', 'ask_approval']) {
      const executionContext = { permissionMode: mode };
      await assert.rejects(f.manager.acquire(executionContext), { code: 'WORKSPACE_UNAUTHORIZED' });
      for (const op of ['definition', 'references', 'hover', 'documentSymbols', 'workspaceSymbols', 'diagnostics']) assert.equal((await f.api[op]({ ...f.input, query: 'value', executionContext })).error.code, 'LSP_PERMISSION_DENIED');
    }
    for (const permissionMode of ['workspace_write', 'full_access']) {
      f.context.permissionMode = permissionMode;
      for (const op of ['definition', 'references', 'hover', 'documentSymbols', 'workspaceSymbols', 'diagnostics']) assert.equal((await f.api[op]({ ...f.input, query: 'value' })).success, true, op);
    }
    const refs = await f.api.references(f.input);
    f.context.permissionMode = 'read_only';
    assert.equal((await f.api.references({ ...f.input, cursor: refs.nextCursor })).error.code, 'LSP_PERMISSION_DENIED');
    const shared = f.manager.instances.get(f.root);
    await f.manager.permissionChanged(f.context, f.root); assert.equal(f.manager.instances.get(f.root), shared, 'caller revocation retains the shared process');
    f.context.permissionMode = 'workspace_write'; assert.equal((await f.api.definition(f.input)).success, true);
    const waiting = f.api.hover(f.input); setTimeout(() => { f.context.permissionMode = 'ask_approval'; }, 40);
    assert.equal((await waiting).error.code, 'LSP_PERMISSION_DENIED');
    await f.manager.closeRoot(f.root);
    f.context.permissionMode = 'full_access'; assert.equal((await f.api.definition(f.input)).success, true);
  } finally { await f.close(); }
});
test('diagnostics readiness, version mismatch, unversioned, clearing, filtering and bounds', async () => {
  const f = await fixture();
  try {
    await f.api.diagnostics(f.input); const e = await f.manager.acquire(f.context); const doc = [...e.documents.values()][0];
    const publish = async (version, diagnostics) => { const arrived = once(e.events, 'diagnostics'); await f.servers[0].sendNotification('textDocument/publishDiagnostics', { uri: doc.uri, ...(version === undefined ? {} : { version }), diagnostics }); await arrived; };
    const diag = { range: r, severity: 1, code: 2322, source: 'ts', message: 'x'.repeat(3000), relatedInformation: [{ location: { uri: pathToFileURL('/tmp/private.ts').href, range: r }, message: 'private' }] };
    await publish(undefined, [diag]); assert.equal((await f.api.diagnostics(f.input)).state, 'stale');
    await publish(doc.version, [diag, diag]); const d = await f.api.diagnostics(f.input); assert.equal(d.state, 'ready'); assert.equal(d.results.length, 1); assert.equal(d.results[0].message.length, 2000); assert.equal(d.excludedCount, 2);
    assert.equal((await f.api.diagnostics({ ...f.input, severities: [2] })).results.length, 0);
    await publish(doc.version - 1, []); assert.equal((await f.api.diagnostics(f.input)).state, 'stale');
    await publish(doc.version, []); assert.equal((await f.api.diagnostics(f.input)).state, 'ready');
    await fs.writeFile(path.join(f.root, f.input.filePath), ''); assert.equal((await f.api.diagnostics(f.input)).state, 'pending');
    await fs.unlink(path.join(f.root, f.input.filePath)); assert.equal((await f.api.diagnostics(f.input)).error.code, 'LSP_FILE_NOT_FOUND'); assert.equal(e.diagnostics.size, 0);
  } finally { await f.close(); }
});
test('snapshot expiration, bounded memory, operation scoping, restart and cancellation', async () => {
  let now = 1000; const f = await fixture({ pagination: { ttl: 100, maxSnapshots: 2, maxResults: 30, maxBytes: 10000, now: () => now } });
  try {
    const a = await f.api.references(f.input); assert.equal(a.truncated, true); assert.equal(a.totalCount, 30);
    assert.equal((await f.api.documentSymbols({ ...f.input, cursor: a.nextCursor })).error.code, 'LSP_INVALID_CURSOR');
    const authorize = f.manager.authorize; f.manager.authorize = c => c.other ? os.tmpdir() : authorize(c);
    assert.equal((await f.api.references({ ...f.input, executionContext: { permissionMode: 'full_access', other: true }, cursor: a.nextCursor })).error.code, 'LSP_INVALID_CURSOR');
    now += 101; assert.equal((await f.api.references({ ...f.input, cursor: a.nextCursor })).error.code, 'LSP_STALE_CURSOR');
    for (let i = 0; i < 5; i++) await f.api.references(f.input);
    assert.ok(f.api.snapshots.size <= 2); assert.ok(f.api.snapshotBytes <= 10000);
    const b = await f.api.references(f.input); await f.manager.closeRoot(f.root);
    assert.equal((await f.api.references({ ...f.input, cursor: b.nextCursor })).error.code, 'LSP_STALE_CURSOR');
    const c = new AbortController(); c.abort(); assert.equal((await f.api.hover({ ...f.input, signal: c.signal })).error.code, 'LSP_CANCELLED');
  } finally { await f.close(); }
});
test('null results, flat symbols, capability unavailable, empty source and timeout', async () => {
  const f = await fixture({ definition: () => null, hover: () => new Promise(() => {}), symbols: [], capabilities: { workspaceSymbolProvider: false } });
  try {
    assert.equal((await f.api.definition(f.input)).totalCount, 0);
    assert.equal((await f.api.documentSymbols(f.input)).totalCount, 0);
    assert.equal((await f.api.workspaceSymbols({ ...f.input, query: 'x' })).error.code, 'LSP_CAPABILITY_UNAVAILABLE');
    assert.equal((await f.api.hover({ ...f.input, timeout: 10 })).error.code, 'LSP_TIMEOUT');
    await fs.writeFile(path.join(f.root, f.input.filePath), '');
    assert.equal((await f.api.definition({ ...f.input, line: 1, column: 1 })).success, true);
  } finally { await f.close(); }
});
test('real bundled server: all six operations, pagination, JS/JSX/TS/TSX, fix and evidence', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp2-real-'));
  const context = { permissionMode: 'workspace_write' };
  const manager = new LspManager({ authorize: c => ['workspace_write', 'full_access'].includes(c.permissionMode) ? root : null });
  const api = new LspCodeIntelligence(manager);
  const files = { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }), 'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\nexport const list: Array<number> = [];\n', 'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 60 }, (_, i) => `const result${i} = answer();`).join('\n'), 'plain.js': 'export const plain = 1;\n', 'view.jsx': 'export const View = () => <div />;\n', 'view.tsx': 'export const ViewTS = () => <div />;\n', 'emoji 空.ts': 'const emoji = "😀"; export const symbol = 1;\n' };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const evidence = { serverVersion: require('typescript-language-server/package.json').version, typescriptVersion: require('typescript/package.json').version, operations: {} };
  const input = { executionContext: context, filePath: 'b.ts', line: 2, column: 23 };
  async function measure(name, fn) { const t = performance.now(); const output = await fn(); assert.equal(output.success, true, JSON.stringify(output)); evidence.operations[name] = { ms: performance.now() - t, bytes: Buffer.byteLength(JSON.stringify(output)), output }; return output; }
  try {
    const cold = performance.now(); const e = await manager.acquire(context); evidence.startupMs = performance.now() - cold;
    for (const name of Object.keys(files).filter(n => !n.endsWith('.json'))) await manager.refresh(context, name);
    await measure('definition', () => api.definition(input));
    await measure('warmDefinition', () => api.definition(input));
    const refs = await measure('references', () => api.references({ ...input, includeDeclaration: true, pageSize: 10 })); assert.ok(refs.totalCount >= 60); assert.equal(refs.hasMore, true);
    const page2 = await api.references({ executionContext: context, cursor: refs.nextCursor, pageSize: 10 }); assert.equal(page2.returnedCount, 10);
    const symbols = await measure('documentSymbols', () => api.documentSymbols({ ...input, filePath: 'a.ts' })); assert.ok(symbols.results.some(s => s.name === 'Service'));
    const workspace = await measure('workspaceSymbols', () => api.workspaceSymbols({ executionContext: context, query: 'answer' })); assert.ok(workspace.results.some(s => s.name === 'answer'));
    const hover = await measure('hover', () => api.hover(input)); assert.match(hover.content, /answer/);
    const external = await api.definition({ ...input, filePath: 'a.ts', line: 3, column: files['a.ts'].split('\n')[2].indexOf('Array') + 1 });
    assert.equal(external.success, true); assert.ok(external.excludedCount > 0); assert.equal(external.results.length, 0); evidence.externalLocations = external;
    // Publication events, bounded timer: no sleep/poll used for readiness.
    async function waitDiagnostic(predicate) {
      const deadline = Date.now() + 15000;
      while (true) {
        const result = await api.diagnostics(input); if (predicate(result)) return result;
        if (Date.now() >= deadline) throw new Error('diagnostics deadline');
        await new Promise((resolve, reject) => {
          const on = () => { clearTimeout(timer); e.events.removeListener('diagnostics', on); resolve(); };
          const timer = setTimeout(() => { e.events.removeListener('diagnostics', on); reject(new Error('publication deadline')); }, deadline - Date.now());
          e.events.on('diagnostics', on);
        });
      }
    }
    const diagnostic = await measure('diagnostics', () => waitDiagnostic(d => d.results?.some(x => x.code === 2322))); assert.ok(['ready', 'stale'].includes(diagnostic.state));
    const fix = performance.now(); await fs.writeFile(path.join(root, 'b.ts'), files['b.ts'].replace(': string', ': number')); await manager.refresh(context, 'b.ts');
    const cleared = await waitDiagnostic(d => ['ready', 'stale'].includes(d.state) && !d.results.some(x => x.code === 2322)); evidence.diagnosticRefreshMs = performance.now() - fix; evidence.cleared = cleared;
    assert.equal((await api.definition(input)).success, true);
    const emojiHover = await api.hover({ ...input, filePath: 'emoji 空.ts', line: 1, column: files['emoji 空.ts'].indexOf('symbol') + 1 }); assert.match(emojiHover.content, /symbol/);
    for (const filePath of ['plain.js', 'view.jsx', 'view.tsx', 'emoji 空.ts']) assert.equal((await api.documentSymbols({ ...input, filePath })).success, true);
    context.permissionMode = 'full_access'; assert.equal((await api.hover(input)).success, true);
    for (const permissionMode of ['read_only', 'ask_approval']) assert.equal((await api.hover({ ...input, executionContext: { permissionMode } })).error.code, 'LSP_PERMISSION_DENIED');
    evidence.paginationBytes = api.snapshotBytes; evidence.snapshotCount = api.snapshots.size;
    for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), name === 'b.ts' ? text.replace(': string', ': number') : text);
    await manager.close(); evidence.shutdown = e.state;
    await fs.writeFile('/tmp/lsp2-real-evidence.json', JSON.stringify(evidence, null, 2));
    console.log('LSP2_REAL_EVIDENCE', JSON.stringify({ startupMs: evidence.startupMs, operations: Object.fromEntries(Object.entries(evidence.operations).map(([k, v]) => [k, { ms: v.ms, bytes: v.bytes }])), diagnosticRefreshMs: evidence.diagnosticRefreshMs, paginationBytes: evidence.paginationBytes }));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('production authorization uses canonical modes without changing shell policy', async () => {
  const vm = require('node:vm'); const source = await fs.readFile(path.join(__dirname, '../src/main/lspManager.js'), 'utf8');
  let project = { root_path: '/trusted' }; const modes = [];
  const loaded = { exports: {} };
  vm.runInNewContext(source, { require: name => name === './toolPermissions' ? { sessionProject: id => id === 'trusted' ? project : null, effectiveMode: (mode, p) => { modes.push([mode, p]); return mode; } } : require(name), module: loaded, process, performance, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
  for (const permissionMode of ['workspace_write', 'full_access']) assert.equal(await loaded.exports.authorizeContext({ sessionId: 'trusted', permissionMode }), '/trusted');
  for (const permissionMode of ['read_only', 'ask_approval']) await assert.rejects(loaded.exports.authorizeContext({ sessionId: 'trusted', permissionMode }), { code: 'WORKSPACE_UNAUTHORIZED' });
  await assert.rejects(loaded.exports.authorizeContext({ sessionId: 'other', permissionMode: 'full_access' }), { code: 'WORKSPACE_UNAUTHORIZED' });
  assert.equal(modes.length, 4); project = null;
  await assert.rejects(loaded.exports.authorizeContext({ sessionId: 'trusted', permissionMode: 'workspace_write' }), { code: 'WORKSPACE_UNAUTHORIZED' });
});
test('flat symbol containers, hover forms, exact protocol coordinates, symlink exclusion and constrained native registrations', async () => {
  let hoverResult = { contents: { kind: 'plaintext', value: 'plain documentation' } };
  const f = await fixture({ hover: p => { assert.deepEqual(p.position, { line: 0, character: 25 }); return hoverResult; } });
  try {
    assert.equal((await f.api.hover(f.input)).format, 'plaintext');
    hoverResult = { contents: { kind: 'markdown', value: '**docs**' } }; assert.equal((await f.api.hover(f.input)).content, '**docs**');
    hoverResult = null; assert.equal((await f.api.hover(f.input)).content, '');
    await fs.symlink(os.tmpdir(), path.join(f.root, 'escape')); assert.equal((await f.api.documentSymbols({ ...f.input, filePath: 'escape/secret.ts' })).error.code, 'LSP_PERMISSION_DENIED');
    const e = await f.manager.acquire(f.context);
    assert.equal(await f.api.location(e, { uri: pathToFileURL(path.join(f.root, 'escape/private.ts')).href, range: r }), null);
    const toolSource = await fs.readFile(path.join(__dirname, '../src/main/tools/agentTools.js'), 'utf8');
    for (const name of ['lsp_definition', 'lsp_references', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_hover', 'lsp_diagnostics']) assert.ok(require('../src/main/tools/lspTools').LSP_TOOL_NAMES.includes(name));
  } finally { await f.close(); }
  const flat = await fixture();
  try {
    const e = await flat.manager.acquire(flat.context);
    flat.servers[0].onRequest('textDocument/documentSymbol', () => [{ name: 'method', kind: 6, containerName: 'Class', location: { uri: pathToFileURL(path.join(e.root, 'other.ts')).href, range: r } }]);
    const result = await flat.api.documentSymbols(flat.input); assert.equal(result.results[0].container, 'Class');
  } finally { await flat.close(); }
});
test('stale source during request, concurrent callers, active cancellation and reopen generations', async () => {
  const f = await fixture({ hover: () => new Promise(resolve => setTimeout(() => resolve({ contents: 'type signature' }), 80)) });
  try {
    const pending = f.api.hover(f.input); setTimeout(() => fs.writeFile(path.join(f.root, f.input.filePath), 'const changed = 1;\n'), 40);
    assert.equal((await pending).error.code, 'LSP_STALE_RESULT');
    const atStart = { ...f.input, line: 1, column: 1 };
    const controller = new AbortController(); const cancelled = f.api.hover({ ...atStart, signal: controller.signal }); setTimeout(() => controller.abort(), 20);
    assert.equal((await cancelled).error.code, 'LSP_CANCELLED');
    const results = await Promise.all([f.api.definition(atStart), f.api.documentSymbols(atStart), f.api.references(atStart)]); assert.ok(results.every(r => r.success)); assert.equal(f.manager.instances.size, 1);
    const doc = await f.manager.refresh(f.context, f.input.filePath); await f.manager.closeFile(f.context, f.input.filePath);
    const reopened = await f.manager.refresh(f.context, f.input.filePath); assert.ok(reopened.version > doc.version);
    const e = await f.manager.acquire(f.context); const arrived = once(e.events, 'diagnostics'); await f.servers[0].sendNotification('textDocument/publishDiagnostics', { uri: reopened.uri, version: doc.version, diagnostics: [] }); await arrived;
    assert.equal((await f.api.diagnostics(atStart)).state, 'stale');
  } finally { await f.close(); }
});
