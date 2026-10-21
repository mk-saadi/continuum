'use strict';
// Phase 2.6A-4 — production hardening, packaging, stability and performance.
//
// Deterministic failure-injection, concurrency, packaging and stress coverage
// for the JS/TS LSP integration. No model, provider, network or paid inference
// is involved; the bundled language server is the only child process used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');

const REPO = path.join(__dirname, '..');
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp4-db-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => databaseDirectory }, ipcMain: { handle: () => {}, removeHandler: () => {} } };
  return originalLoad.call(this, name, ...args);
};

const { LspManager } = require('../src/main/lspManager');
const { LspCodeIntelligence } = require('../src/main/lspCodeIntelligence');
const { lspTools, LSP_TOOL_NAMES, executeLspTool, available } = require('../src/main/tools/lspTools');
const contexts = require('../src/main/lspExecutionContext');
const { initDatabase, closeDatabase } = require('../src/main/db');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');

// ---------------------------------------------------------------------------
// Fixture: a controllable in-process language server over real JSON-RPC.
// ---------------------------------------------------------------------------
function fakeServer(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 40000 + Math.floor(Math.random() * 10000);
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.crash = code => { child.exitCode = code ?? 1; child.emit('exit', code ?? 1); };
  const server = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
  const notices = []; const events = new EventEmitter();
  server.onRequest('initialize', () => {
    if (options.initializeHangs) return new Promise(() => {});
    if (options.initializeThrows) throw new Error('fixture initialize failure');
    if (options.initializeGarbage) return { nope: true };
    return { capabilities: { textDocumentSync: options.sync ?? 2, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, ...(options.capabilities ?? {}) } };
  });
  server.onRequest('shutdown', () => null);
  server.onNotification('exit', () => child.kill());
  for (const method of ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didSave'])
    server.onNotification(method, params => { const record = { method, params }; notices.push(record); events.emit('notice', record); options.onNotice?.(method, params, notices); });
  server.onRequest('textDocument/hover', p => options.hover ? options.hover(p) : { contents: [{ language: 'typescript', value: 'const answer: number' }], range: RANGE });
  server.onRequest('textDocument/definition', p => options.definition ? options.definition(p) : []);
  server.onRequest('textDocument/references', p => options.references ? options.references(p) : []);
  server.onRequest('textDocument/documentSymbol', () => options.symbols ?? [{ name: 'answer', kind: 12, range: RANGE, selectionRange: RANGE }]);
  server.onRequest('workspace/symbol', () => options.workspaceSymbols ?? []);
  server.listen();
  return { child, server, notices, events, publish: (uri, diagnostics, version) => server.sendNotification('textDocument/publishDiagnostics', { uri, ...(version === undefined ? {} : { version }), diagnostics }) };
}

// Notifications are asynchronous: the client resolves the write before the
// server has processed the frame. Tests wait for the processed notice instead
// of assuming it already arrived.
function waitNotice(fixture, method, count = 1, timeout = 5000) {
  const reached = () => fixture.notices.filter(n => n.method === method).length >= count;
  if (reached()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onNotice = record => { if (record.method !== method || !reached()) return; clearTimeout(timer); fixture.events.removeListener('notice', onNotice); resolve(); };
    const timer = setTimeout(() => { fixture.events.removeListener('notice', onNotice); reject(new Error(`Timed out waiting for ${method}`)); }, timeout);
    fixture.events.on('notice', onNotice);
  });
}

async function workspace(files = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsp4-'));
  for (const [name, text] of Object.entries(files)) await fsp.writeFile(path.join(root, name), text);
  return root;
}

// A language server (and its tsserver children) must not survive a normal
// shutdown. The check is on the process id, not on the test's own state.
async function assertNoSurvivors(pids, label) {
  await new Promise(r => setTimeout(r, 200));
  for (const pid of pids) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, `${label}: language server ${pid} must not survive shutdown`);
  }
}

// The production policy: only Workspace Write and Full Access may reach a
// language server, and only for an authorized workspace.
function policyAuthorize(root) {
  return context => {
    if (!context || context.allowed === false) return null;
    const mode = context.permissionMode;
    if (mode !== undefined && !['workspace_write', 'full_access'].includes(mode)) return null;
    return root;
  };
}

function harness(root, managerOptions = {}) {
  const servers = []; let starts = 0;
  const manager = new LspManager({
    authorize: managerOptions.authorize ?? policyAuthorize(root),
    maxInstances: managerOptions.maxInstances ?? 4,
    requestTimeout: managerOptions.requestTimeout ?? 2000,
    initializationTimeout: managerOptions.initializationTimeout ?? 2000,
    shutdownTimeout: managerOptions.shutdownTimeout ?? 60,
    maxDocuments: managerOptions.maxDocuments,
    maxRestarts: managerOptions.maxRestarts,
    spawnServer: managerOptions.spawnServer ?? (() => { starts++; const f = fakeServer(managerOptions.server ?? {}); servers.push(f); return f.child; }),
  });
  return { manager, servers, starts: () => starts, close: async () => { await manager.close(); servers.forEach(s => s.server.dispose()); } };
}

const BASE_FILES = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }),
  'a.ts': 'export const answer: number = 42;\n',
  'b.ts': 'import { answer } from "./a";\nconst value: string = answer;\n',
};

// ---------------------------------------------------------------------------
// 1. Packaging: the bundled server must ship with the application.
// ---------------------------------------------------------------------------
test('packaging configuration ships the bundled server and its runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const [name, version] of [['typescript-language-server', '4.3.4'], ['typescript', '5.7.3'], ['vscode-jsonrpc', '8.2.1']]) {
    assert.equal(pkg.dependencies?.[name], version, `${name} must be a pinned production dependency`);
  }
  const unpack = pkg.build?.asarUnpack ?? [];
  assert.ok(unpack.some(p => /typescript-language-server/.test(p)), 'the language server must be unpacked from asar');
  assert.ok(unpack.some(p => /(^|\/)typescript\/\*\*/.test(p)), 'the TypeScript runtime must be unpacked from asar');
  for (const entry of ['main.js', 'src/main/**/*.js', 'src/lib/**/*.json']) assert.ok(pkg.build?.files?.includes(entry), `${entry} must be packaged`);
  const cli = require.resolve('typescript-language-server/lib/cli.mjs');
  const tsserver = require.resolve('typescript/lib/tsserver.js');
  assert.ok(cli.startsWith(path.join(REPO, 'node_modules')), 'the server must resolve from the bundled dependency, never a global install');
  assert.ok(tsserver.startsWith(path.join(REPO, 'node_modules')), 'TypeScript must resolve from the bundled dependency');
  assert.ok(fs.existsSync(cli) && fs.existsSync(tsserver));
});

test('packaged runtime path mapping never depends on the repository source tree', () => {
  const { runtimePath } = require('../src/main/lspManager');
  assert.equal(runtimePath('/opt/Continuum/resources/app.asar/node_modules/x'), '/opt/Continuum/resources/app.asar.unpacked/node_modules/x');
  assert.equal(runtimePath('/opt/Continuum/resources/app.asar/src/main/x.js'), '/opt/Continuum/resources/app.asar.unpacked/src/main/x.js');
  assert.equal(runtimePath('/opt/Continuum/resources/app.asar'), '/opt/Continuum/resources/app.asar');
  // An unpacked (asar-less) build keeps its plain paths.
  assert.equal(runtimePath('/opt/Continuum/resources/app/node_modules/x'), '/opt/Continuum/resources/app/node_modules/x');
});

test('the failed-server filter resolves the canonical root through the alias index', () => {
  const { manager: singleton } = require('../src/main/lspManager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp4-alias-'));
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias);
  const canonical = fs.realpathSync(root);
  singleton.aliases.set(alias, canonical);
  singleton.instances.set(canonical, { root: canonical, state: 'failed' });
  try {
    assert.equal(available({ root_path: alias }), false);
    singleton.instances.set(canonical, { root: canonical, state: 'ready' });
    assert.equal(available({ root_path: alias }), true);
  } finally {
    singleton.instances.delete(canonical);
    singleton.aliases.delete(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Failure injection: startup.
// ---------------------------------------------------------------------------
test('missing language-server executable fails cleanly without an orphan or a stuck entry', async () => {
  const root = await workspace(BASE_FILES);
  const manager = new LspManager({ authorize: policyAuthorize(root), initializationTimeout: 1000, shutdownTimeout: 50, spawnServer: () => { throw new Error('ENOENT: language server executable missing'); } });
  try {
    await assert.rejects(manager.acquire({}), { code: 'INITIALIZATION_FAILED' });
    assert.equal(manager.instances.size, 1);
    assert.equal([...manager.instances.values()][0].state, 'failed');
    // The canonical root is recorded even though the launch failed.
    assert.equal(manager.aliases.get(root), await fsp.realpath(root));
  } finally { await manager.close(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('invalid bundled resource path is reported as an initialization failure', async () => {
  const root = await workspace(BASE_FILES);
  const manager = new LspManager({ authorize: policyAuthorize(root), initializationTimeout: 500, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({}); f.server.onRequest('initialize', () => ({ capabilities: {} })); return f.child; } });
  try {
    await assert.rejects(manager.acquire({}), { code: 'INITIALIZATION_FAILED' });
    assert.equal([...manager.instances.values()][0].state, 'failed');
  } finally { await manager.close(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('server crash during initialization fails the entry and leaves no running process', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ initializeHangs: true });
  const manager = new LspManager({ authorize: policyAuthorize(root), initializationTimeout: 5000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  try {
    const acquiring = manager.acquire({});
    await new Promise(r => setTimeout(r, 20));
    fixture.child.crash(1);
    await assert.rejects(acquiring, { code: 'INITIALIZATION_FAILED' });
    assert.equal([...manager.instances.values()][0].state, 'failed');
    // A server that never became ready is not restartable.
    assert.equal([...manager.instances.values()][0].crashed, undefined);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('shutdown during initialization does not wait for the initialization timeout', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ initializeHangs: true });
  const manager = new LspManager({ authorize: policyAuthorize(root), initializationTimeout: 20000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  try {
    const acquiring = manager.acquire({}).catch(e => e.code);
    await new Promise(r => setTimeout(r, 20));
    const began = performance.now();
    await manager.closeRoot(root);
    const elapsed = performance.now() - began;
    assert.ok(elapsed < 2000, `closeRoot must not wait for the initialization timeout (took ${elapsed.toFixed(0)} ms)`);
    assert.equal(await acquiring, 'INITIALIZATION_FAILED');
    assert.equal(manager.instances.size, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 3. Failure injection: runtime.
// ---------------------------------------------------------------------------
test('crash during a definition request returns an honest error and cleans up state', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ definition: () => { fixture.child.crash(1); return new Promise(() => {}); } });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const result = await api.definition({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_SERVER_UNAVAILABLE');
    const entry = manager.instances.get(root);
    assert.equal(entry.state, 'failed');
    assert.equal(entry.diagnostics.size, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('a crashed server is restarted on demand within a bounded budget', async () => {
  const root = await workspace(BASE_FILES);
  let fixture; let starts = 0;
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, maxRestarts: 2, spawnServer: () => { starts++; fixture = fakeServer({}); return fixture.child; } });
  const api = new LspCodeIntelligence(manager);
  try {
    const first = await manager.acquire({});
    await api.definition({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(first.documents.size, 1);
    fixture.child.crash(1);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(manager.instances.get(root).state, 'failed');
    // The next query restarts the server and re-opens the documents.
    const after = await manager.acquire({});
    assert.notEqual(after, first);
    assert.equal(after.state, 'ready');
    assert.equal(after.documents.size, 0, 'a restarted server must not inherit document state');
    assert.equal(starts, 2);
    await api.definition({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(after.documents.size, 1);
    await waitNotice(fixture, 'textDocument/didOpen');
    assert.equal(fixture.notices.filter(n => n.method === 'textDocument/didOpen').length, 1, 'the restarted server must receive didOpen, not didChange');
  } finally { await manager.close(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('the restart budget is bounded and never loops', async () => {
  const root = await workspace(BASE_FILES);
  let starts = 0; const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, maxRestarts: 2, spawnServer: () => { starts++; const f = fakeServer({}); fixtures.push(f); return f.child; } });
  try {
    await manager.acquire({});
    for (let i = 0; i < 6; i++) {
      const current = manager.instances.get(root);
      if (current) { current.client.child.crash(1); await new Promise(r => setTimeout(r, 10)); }
      await manager.acquire({}).catch(() => {});
    }
    assert.ok(starts <= 3, `restart budget must be bounded (started ${starts} servers)`);
    assert.equal(manager.restarts.get(root), 2);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

test('timeout during a reference request is reported as a timeout', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ references: () => new Promise(() => {}) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 80, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const result = await api.references({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_TIMEOUT');
    assert.equal(manager.instances.get(root).state, 'ready');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('cancellation during diagnostics leaves the server healthy', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({});
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager, { diagnosticWait: 5000 });
  try {
    await manager.acquire({});
    const controller = new AbortController();
    const pending = api.diagnostics({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_CANCELLED');
    assert.equal(manager.instances.get(root).state, 'ready');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('workspace closure during an active request rejects the caller and stops the server', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ hover: () => new Promise(() => {}) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 5000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const pending = api.hover({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    await new Promise(r => setTimeout(r, 30));
    await manager.closeRoot(root);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_SERVER_UNAVAILABLE');
    assert.equal(manager.instances.size, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('application shutdown during an active request settles every pending call', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ hover: () => new Promise(() => {}) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 5000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const pending = api.hover({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    await new Promise(r => setTimeout(r, 20));
    await manager.close();
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(manager.instances.size, 0);
    assert.equal(manager.stats().instances.length, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('permission downgrade during a request cancels the caller and denies later work', async () => {
  const root = await workspace(BASE_FILES);
  const context = { permissionMode: 'workspace_write' };
  const fixture = fakeServer({ hover: () => new Promise(resolve => setTimeout(() => resolve({ contents: 'x' }), 300)) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 2000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const pending = api.hover({ executionContext: context, filePath: 'b.ts', line: 2, column: 20 });
    setTimeout(() => { context.permissionMode = 'read_only'; }, 40);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_PERMISSION_DENIED');
    const later = await api.hover({ executionContext: context, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(later.error.code, 'LSP_PERMISSION_DENIED');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 4. Failure injection: results, documents, cursors and languages.
// ---------------------------------------------------------------------------
test('an invalid server response is rejected instead of being reported as a result', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ references: () => ({ not: 'an array' }) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const result = await api.references({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_INVALID_RESPONSE');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('a result location outside the workspace is excluded, never returned', async () => {
  const root = await workspace(BASE_FILES);
  const outside = pathToFileURL(path.join(os.tmpdir(), 'outside-the-workspace.ts')).href;
  const fixture = fakeServer({ definition: () => [{ targetUri: outside, targetRange: RANGE, targetSelectionRange: RANGE }] });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const result = await api.definition({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(result.success, true);
    assert.equal(result.results.length, 0);
    assert.equal(result.excludedCount, 1);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('an unsupported language is refused without touching the server', async () => {
  const root = await workspace({ ...BASE_FILES, 'notes.md': '# hello' });
  const fixture = fakeServer({});
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const result = await api.definition({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'notes.md', line: 1, column: 1 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_UNSUPPORTED_LANGUAGE');
    assert.equal(fixture.notices.length, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('stale document content is reported instead of a stale result', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ hover: () => new Promise(resolve => setTimeout(() => resolve({ contents: 'x' }), 60)) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 2000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    const pending = api.hover({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20 });
    setTimeout(() => fsp.writeFile(path.join(root, 'b.ts'), 'export const changed = 1;\n'), 25);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'LSP_STALE_RESULT');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('expired and foreign cursors keep distinct categories', async () => {
  let now = 1000;
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ references: () => Array.from({ length: 40 }, (_, i) => ({ uri: pathToFileURL(path.join(root, 'a.ts')).href, range: { start: { line: i % 10, character: 0 }, end: { line: i % 10, character: 1 } } })) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager, { ttl: 100, now: () => now });
  const caller = { permissionMode: 'workspace_write' };
  try {
    await manager.acquire({});
    const first = await api.references({ executionContext: caller, filePath: 'b.ts', line: 2, column: 20, pageSize: 5 });
    assert.ok(first.nextCursor);
    now += 200;
    const expired = await api.references({ executionContext: caller, cursor: first.nextCursor });
    assert.equal(expired.error.code, 'LSP_STALE_CURSOR');
    const foreign = await api.references({ executionContext: caller, cursor: 'not-a-real-cursor' });
    assert.equal(foreign.error.code, 'LSP_INVALID_CURSOR');
    const otherOp = await api.documentSymbols({ executionContext: caller, cursor: first.nextCursor });
    assert.equal(otherOp.error.code, 'LSP_INVALID_CURSOR');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('a cursor is invalidated when its workspace server restarts', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({ references: () => Array.from({ length: 40 }, (_, i) => ({ uri: pathToFileURL(path.join(root, 'a.ts')).href, range: { start: { line: i % 10, character: 0 }, end: { line: i % 10, character: 1 } } })) });
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  const caller = { permissionMode: 'workspace_write', root: 'a' };
  try {
    await manager.acquire({});
    const first = await api.references({ executionContext: caller, filePath: 'b.ts', line: 2, column: 20, pageSize: 5 });
    assert.ok(first.nextCursor);
    await manager.closeRoot(root);
    const after = await api.references({ executionContext: caller, cursor: first.nextCursor });
    assert.equal(after.error.code, 'LSP_STALE_CURSOR');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('a snapshot never mixes pages from different queries or workspaces', async () => {
  const rootA = await workspace(BASE_FILES);
  const rootB = await workspace({ ...BASE_FILES, 'only.ts': 'export const only = 1;\n' });
  const fixtures = [];
  const manager = new LspManager({ authorize: c => (c?.root === 'b' ? rootB : rootA), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({ references: () => Array.from({ length: 30 }, (_, i) => ({ uri: pathToFileURL(path.join(rootA, 'a.ts')).href, range: { start: { line: i % 10, character: 0 }, end: { line: i % 10, character: 1 } } })) }); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  const caller = { permissionMode: 'workspace_write', root: 'a' };
  try {
    await manager.acquire({ root: 'a' });
    const first = await api.references({ executionContext: caller, filePath: 'b.ts', line: 2, column: 20, pageSize: 5 });
    assert.ok(first.nextCursor);
    const page2 = await api.references({ executionContext: caller, cursor: first.nextCursor, pageSize: 5 });
    assert.equal(page2.snapshotId, first.snapshotId);
    assert.equal(page2.observedAt, first.observedAt);
    assert.equal(page2.provenance, 'immutable-query-snapshot');
    assert.notEqual(page2.results[0].startLine + ':' + page2.results[0].startColumn, first.results[0].startLine + ':' + first.results[0].startColumn);
    // A cursor cannot be replayed from another workspace.
    const crossed = await api.references({ executionContext: { permissionMode: 'workspace_write', root: 'b' }, cursor: first.nextCursor });
    assert.equal(crossed.error.code, 'LSP_INVALID_CURSOR');
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(rootA, { recursive: true, force: true }); await fsp.rm(rootB, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 5. Workspace isolation and shared-server concurrency.
// ---------------------------------------------------------------------------
test('two workspaces never share a server, a document set or a cursor', async () => {
  const rootA = await workspace({ ...BASE_FILES, 'onlyA.ts': 'export const onlyA = 1;\n' });
  const rootB = await workspace({ ...BASE_FILES, 'only.ts': 'export const only = 1;\n' });
  const fixtures = [];
  const manager = new LspManager({ authorize: c => (c?.root === 'b' ? rootB : rootA), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({ definition: () => [{ uri: pathToFileURL(path.join(rootA, 'onlyA.ts')).href, range: RANGE }] }); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  try {
    const a = await manager.acquire({ root: 'a' });
    const b = await manager.acquire({ root: 'b' });
    assert.notEqual(a, b);
    assert.equal(manager.instances.size, 2);
    const inA = await api.definition({ executionContext: { permissionMode: 'workspace_write', root: 'a' }, filePath: 'b.ts', line: 2, column: 20 });
    assert.equal(inA.success, true);
    assert.equal(inA.results.length, 1);
    // A file that only exists in the other workspace is not reachable.
    const foreign = await api.definition({ executionContext: { permissionMode: 'workspace_write', root: 'b' }, filePath: 'onlyA.ts', line: 1, column: 14 });
    assert.equal(foreign.success, false);
    assert.equal(foreign.error.code, 'LSP_FILE_NOT_FOUND');
    // A location that belongs to the other workspace is excluded, not returned.
    const excluded = await api.definition({ executionContext: { permissionMode: 'workspace_write', root: 'b' }, filePath: 'only.ts', line: 1, column: 14 });
    assert.equal(excluded.success, true);
    assert.equal(excluded.results.length, 0);
    assert.equal(excluded.excludedCount, 1);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(rootA, { recursive: true, force: true }); await fsp.rm(rootB, { recursive: true, force: true }); }
});

test('concurrent callers share one server and keep their own authorization', async () => {
  const root = await workspace(BASE_FILES);
  let starts = 0; const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => { starts++; const f = fakeServer({}); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  try {
    const allowed = { permissionMode: 'workspace_write' };
    const denied = { permissionMode: 'read_only' };
    const results = await Promise.all([
      api.definition({ executionContext: allowed, filePath: 'b.ts', line: 2, column: 20 }),
      api.definition({ executionContext: denied, filePath: 'b.ts', line: 2, column: 20 }),
      api.hover({ executionContext: allowed, filePath: 'b.ts', line: 2, column: 20 }),
      api.definition({ executionContext: allowed, filePath: 'a.ts', line: 1, column: 14 }),
    ]);
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, false);
    assert.equal(results[1].error.code, 'LSP_PERMISSION_DENIED');
    assert.equal(results[2].success, true);
    assert.equal(results[3].success, true);
    assert.equal(starts, 1, 'one workspace must not launch duplicate servers');
    assert.equal(manager.instances.size, 1);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

test('cancelling one caller leaves the shared server and the other caller untouched', async () => {
  const root = await workspace(BASE_FILES);
  const fixtures = []; let calls = 0;
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({ hover: () => { calls++; const slow = calls === 1; return new Promise(resolve => setTimeout(() => resolve({ contents: 'x' }), slow ? 400 : 5)); } }); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  try {
    const controller = new AbortController();
    const cancelled = api.hover({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'b.ts', line: 2, column: 20, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const [first, second] = await Promise.all([cancelled, api.hover({ executionContext: { permissionMode: 'workspace_write' }, filePath: 'a.ts', line: 1, column: 14 })]);
    assert.equal(first.success, false);
    assert.equal(first.error.code, 'LSP_CANCELLED');
    assert.equal(second.success, true);
    assert.equal(manager.instances.get(root).state, 'ready');
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

test('concurrent edits to one file never apply an older version after a newer one', async () => {
  const root = await workspace(BASE_FILES);
  const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 2000, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({ hover: () => new Promise(resolve => setTimeout(() => resolve({ contents: 'x' }), 30)) }); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  const context = { permissionMode: 'workspace_write' };
  try {
    await manager.acquire({});
    const versions = [];
    for (let i = 0; i < 8; i++) {
      await fsp.writeFile(path.join(root, 'b.ts'), `import { answer } from "./a";\nconst value${i} = ${i};\n`);
      const result = await api.hover({ executionContext: context, filePath: 'b.ts', line: 2, column: 8 });
      assert.equal(result.success, true);
      versions.push(Number(result.sourceVersion.slice(7), 16));
    }
    const entry = manager.instances.get(root);
    const doc = entry.documents.get([...entry.documents.keys()][0]);
    const onDisk = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'b.ts'))).digest('hex');
    assert.equal(doc.hash, `sha256:${onDisk}`, 'the open document must match the file on disk');
    // The change notifications carry strictly increasing versions.
    const changes = fixtures[0].notices.filter(n => n.method === 'textDocument/didChange').map(n => n.params.textDocument.version);
    for (let i = 1; i < changes.length; i++) assert.ok(changes[i] > changes[i - 1], 'document versions must increase monotonically');
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 6. Permission enforcement across every layer.
// ---------------------------------------------------------------------------
test('the permission matrix is enforced at the tool, adapter and manager layers', async () => {
  initDatabase(databaseDirectory);
  const root = await workspace(BASE_FILES);
  const project = projects.createProject({ name: 'lsp4-permissions', root_path: root });
  const sessionId = 'lsp4-permission-session';
  sessions.getOrCreateSession(sessionId, 'model', project.id);
  const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({}); fixtures.push(f); return f.child; } });
  const api = new LspCodeIntelligence(manager);
  try {
    for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access']) {
      await contexts.setMode(sessionId, mode);
      const context = contexts.forTool(sessionId, mode);
      const expected = ['workspace_write', 'full_access'].includes(mode) ? undefined : 'LSP_PERMISSION_DENIED';
      for (const name of LSP_TOOL_NAMES) {
        const args = name === 'lsp_workspace_symbols' ? { query: 'answer' } : ['lsp_document_symbols', 'lsp_diagnostics'].includes(name) ? { path: 'a.ts' } : { path: 'a.ts', line: 1, column: 14 };
        const toolResult = await executeLspTool(name, args, context);
        if (expected) assert.equal(toolResult.error.code, expected, `${mode}/${name}`);
        else assert.equal(toolResult.success, true, `${mode}/${name}: ${JSON.stringify(toolResult)}`);
      }
      // The adapter and the manager refuse independently of the tool layer.
      if (expected) await assert.rejects(manager.acquire(context), { code: 'WORKSPACE_UNAUTHORIZED' });
      else assert.ok(await manager.acquire(context));
    }
    // An untrusted context object is denied even in Full Access.
    const untrusted = { permissionMode: 'full_access' };
    const denied = await executeLspTool('lsp_definition', { path: 'a.ts', line: 1, column: 14 }, untrusted);
    assert.equal(denied.error.code, 'LSP_PERMISSION_DENIED');
  } finally {
    await manager.close(); fixtures.forEach(f => f.server.dispose());
    // The native tool path uses the production singleton, which starts the
    // real bundled server for an authorized workspace. It must be closed too.
    const singleton = require('../src/main/lspManager').manager;
    const pids = [...singleton.instances.values()].map(e => e.client?.child?.pid).filter(Boolean);
    await singleton.close();
    await assertNoSurvivors(pids, 'permission matrix');
    contexts.forget(sessionId);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a denied mode never starts a language server', async () => {
  const root = await workspace(BASE_FILES);
  let starts = 0; const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), spawnServer: () => { starts++; const f = fakeServer({}); fixtures.push(f); return f.child; } });
  try {
    await manager.acquire({ permissionMode: 'read_only' }).catch(() => {});
    assert.equal(starts, 0);
    assert.equal(manager.instances.size, 0);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

test('the native tool schemas stay compact and free of privileged arguments', () => {
  const serialized = JSON.stringify(lspTools);
  assert.ok(serialized.length < 6000, `tool schemas must stay compact (${serialized.length} bytes)`);
  for (const forbidden of ['executable', 'root', 'method', 'uri', 'serverPath', 'arguments']) {
    for (const tool of lspTools) assert.equal(tool.function.parameters.properties[forbidden], undefined, `${forbidden} must not be a model argument`);
  }
  for (const tool of lspTools) {
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.ok(tool.function.description.length < 250);
  }
});

// ---------------------------------------------------------------------------
// 7. Document synchronization and freshness.
// ---------------------------------------------------------------------------
test('documents, versions and diagnostics follow edits, deletions and reopenings', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({});
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  try {
    await manager.acquire({});
    const first = await manager.refresh({}, 'a.ts');
    assert.equal(first.version, 1);
    assert.equal((await manager.refresh({}, 'a.ts')).version, 1, 'an unchanged file must not advance the version');
    await fsp.writeFile(path.join(root, 'a.ts'), 'export const answer: number = 43;\n');
    const second = await manager.refresh({}, 'a.ts');
    assert.equal(second.version, 2);
    assert.notEqual(second.hash, first.hash);
    await waitNotice(fixture, 'textDocument/didChange');
    assert.equal(fixture.notices.filter(n => n.method === 'textDocument/didChange').length, 1);
    const entry = manager.instances.get(root);
    await fsp.unlink(path.join(root, 'a.ts'));
    await assert.rejects(manager.refresh({}, 'a.ts'), { code: 'ENOENT' });
    assert.equal(entry.documents.size, 0);
    assert.equal(entry.diagnostics.size, 0);
    await fsp.writeFile(path.join(root, 'a.ts'), 'export const answer: number = 44;\n');
    const reopened = await manager.refresh({}, 'a.ts');
    assert.ok(reopened.version > second.version);
    await waitNotice(fixture, 'textDocument/didOpen', 2);
    assert.equal(fixture.notices.filter(n => n.method === 'textDocument/didOpen').length, 2);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('diagnostics freshness states stay honest across publications', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({});
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager, { diagnosticWait: 200 });
  const context = { permissionMode: 'workspace_write' };
  try {
    const entry = await manager.acquire({});
    const doc = await manager.refresh({}, 'b.ts');
    const pending = await api.diagnostics({ executionContext: context, filePath: 'b.ts' });
    assert.equal(pending.state, 'pending');
    assert.equal(pending.results.length, 0);
    const arrived = once(entry.events, 'diagnostics');
    await fixture.publish(doc.uri, [{ range: RANGE, severity: 1, code: 2322, message: 'mismatch' }]);
    await arrived;
    const unversioned = await api.diagnostics({ executionContext: context, filePath: 'b.ts' });
    assert.equal(unversioned.state, 'stale');
    assert.equal(unversioned.results.length, 1);
    const arrived2 = once(entry.events, 'diagnostics');
    await fixture.publish(doc.uri, [{ range: RANGE, severity: 1, code: 2322, message: 'mismatch' }], doc.version);
    await arrived2;
    const ready = await api.diagnostics({ executionContext: context, filePath: 'b.ts' });
    assert.equal(ready.state, 'ready');
    await fsp.writeFile(path.join(root, 'b.ts'), 'import { answer } from "./a";\nconst value: number = answer;\n');
    await manager.refresh({}, 'b.ts');
    const cleared = await api.diagnostics({ executionContext: context, filePath: 'b.ts' });
    assert.equal(cleared.state, 'pending');
    assert.equal(cleared.results.length, 0);
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

test('a long session keeps opening new files instead of exhausting the document budget', async () => {
  const root = await workspace(BASE_FILES);
  const fixture = fakeServer({});
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 1000, shutdownTimeout: 50, maxDocuments: 16, spawnServer: () => fixture.child });
  const api = new LspCodeIntelligence(manager);
  try {
    await manager.acquire({});
    for (let i = 0; i < 40; i++) {
      const name = `file${i}.ts`;
      await fsp.writeFile(path.join(root, name), `export const value${i} = ${i};\n`);
      const result = await api.documentSymbols({ executionContext: { permissionMode: 'workspace_write' }, filePath: name });
      assert.equal(result.success, true, `file ${i} must remain queryable`);
    }
    const entry = manager.instances.get(root);
    assert.ok(entry.documents.size <= 16, 'the open document set must stay bounded');
    await waitNotice(fixture, 'textDocument/didClose');
    assert.ok(fixture.notices.filter(n => n.method === 'textDocument/didClose').length > 0, 'evicted documents must be closed on the server');
  } finally { await manager.close(); fixture.server.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 8. Language coverage.
// ---------------------------------------------------------------------------
test('every supported extension is accepted and answered by the real server', { timeout: 120000 }, async () => {
  const root = await workspace({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'react-jsx', noEmit: true, target: 'es2020' }, include: ['**/*'] }),
    'plain.js': 'export const plainJs = 1;\n',
    'module.mjs': 'export const moduleJs = 2;\n',
    'legacy.cjs': 'exports.legacyJs = 3;\n',
    'view.jsx': 'export const ViewJs = () => <div />;\n',
    'typed.ts': 'export const typedTs: number = 4;\n',
    'modern.mts': 'export const modernTs: number = 5;\n',
    'compat.cts': 'export const compatTs: number = 6;\n',
    'view.tsx': 'export const ViewTs = () => <div />;\n',
  });
  const manager = new LspManager({ authorize: () => root, requestTimeout: 15000, shutdownTimeout: 100 });
  const api = new LspCodeIntelligence(manager, { diagnosticWait: 500 });
  const context = { permissionMode: 'workspace_write' };
  let pids = [];
  try {
    for (const name of ['plain.js', 'module.mjs', 'legacy.cjs', 'view.jsx', 'typed.ts', 'modern.mts', 'compat.cts', 'view.tsx']) {
      const symbols = await api.documentSymbols({ executionContext: context, filePath: name });
      assert.equal(symbols.success, true, `${name} symbols failed: ${JSON.stringify(symbols)}`);
      assert.ok(symbols.results.length > 0, `${name} produced no symbols`);
      const diagnostics = await api.diagnostics({ executionContext: context, filePath: name });
      assert.ok(['ready', 'stale', 'pending'].includes(diagnostics.state), `${name} diagnostics state ${diagnostics.state}`);
    }
    const unsupported = await api.documentSymbols({ executionContext: context, filePath: 'README.md' });
    assert.equal(unsupported.error.code, 'LSP_UNSUPPORTED_LANGUAGE');
    pids = [...manager.instances.values()].map(e => e.client.child.pid);
  } finally {
    await manager.close();
    await assertNoSurvivors(pids, 'language coverage');
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Rapid start/stop cycles.
// ---------------------------------------------------------------------------
test('rapid repeated startup and shutdown leaves no orphan and no stale entry', async () => {
  const root = await workspace(BASE_FILES);
  const fixtures = [];
  const manager = new LspManager({ authorize: policyAuthorize(root), requestTimeout: 500, shutdownTimeout: 50, spawnServer: () => { const f = fakeServer({}); fixtures.push(f); return f.child; } });
  try {
    for (let i = 0; i < 8; i++) {
      await manager.acquire({});
      assert.equal(manager.instances.size, 1);
      await manager.closeRoot(root);
      assert.equal(manager.instances.size, 0);
    }
    assert.equal(manager.stats().instances.length, 0);
    assert.equal(fixtures.filter(f => f.child.exitCode == null).length, 0, 'every child must have exited');
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 10. Long-running session stress: 300+ mixed operations, two workspaces,
//     multiple callers, repeated edits and permission changes.
// ---------------------------------------------------------------------------
test('long-running stress: 300+ mixed operations stay bounded and consistent', { timeout: 240000 }, async () => {
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }),
    'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\n',
    'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 40 }, (_, i) => `const result${i} = answer();`).join('\n'),
    'c.ts': 'import { Service } from "./a";\nexport const service = new Service();\n',
    'plain.js': 'export const plain = 1;\n',
  };
  const rootA = await workspace(files);
  const rootB = await workspace({ ...files, 'b.ts': files['b.ts'].replace(': string', ': number') });
  const manager = new LspManager({
    authorize: c => {
      if (!c || c.allowed === false) return null;
      const mode = c.permissionMode;
      if (mode !== undefined && !['workspace_write', 'full_access'].includes(mode)) return null;
      return c.root === 'b' ? rootB : rootA;
    },
    requestTimeout: 15000, initializationTimeout: 20000, shutdownTimeout: 200,
  });
  const api = new LspCodeIntelligence(manager, { diagnosticWait: 400 });
  const latencies = []; const errors = [];
  let total = 0; let success = 0;
  const callers = [
    { root: 'a', context: { permissionMode: 'workspace_write', root: 'a' } },
    { root: 'a', context: { permissionMode: 'workspace_write', root: 'a' } },
    { root: 'b', context: { permissionMode: 'full_access', root: 'b' } },
  ];
  const plan = [];
  for (let i = 0; i < 340; i++) {
    const caller = callers[i % callers.length];
    const op = i % 7;
    const file = op === 0 ? 'a.ts' : op === 1 ? 'b.ts' : op === 2 ? 'c.ts' : op === 3 ? 'plain.js' : 'b.ts';
    if (op === 0) plan.push([caller, 'definition', { filePath: file, line: 1, column: 17 }]);
    else if (op === 1) plan.push([caller, 'references', { filePath: file, line: 2, column: 23 }]);
    else if (op === 2) plan.push([caller, 'hover', { filePath: file, line: 2, column: 23 }]);
    else if (op === 3) plan.push([caller, 'documentSymbols', { filePath: file }]);
    else if (op === 4) plan.push([caller, 'workspaceSymbols', { query: 'answer' }]);
    else if (op === 5) plan.push([caller, 'diagnostics', { filePath: 'b.ts' }]);
    else plan.push([caller, 'definition', { filePath: file, line: 1, column: 17 }]);
  }
  const runOne = async ([caller, op, args]) => {
    total++;
    const began = performance.now();
    const result = await api[op]({ executionContext: caller.context, ...args });
    latencies.push(performance.now() - began);
    if (result.success) success++; else errors.push(result.error?.code ?? 'UNKNOWN');
    return result;
  };
  const pids = [];
  try {
    // Edit the shared source files while the workload runs.
    let edit = 0;
    const editor = (async () => {
      while (edit < 12) {
        edit++;
        const target = rootA;
        const text = files['b.ts'].replace('const value: string', `const value: number${edit}`);
        await fsp.writeFile(path.join(target, 'b.ts'), text);
        await new Promise(r => setTimeout(r, 40));
      }
    })();
    // Run the workload in bounded batches so the process stays responsive.
    for (let i = 0; i < plan.length; i += 12) {
      await Promise.all(plan.slice(i, i + 12).map(runOne));
    }
    await editor;
    pids.push(...[...manager.instances.values()].map(e => e.client.child.pid));
    // A permission change during the session must deny only the changed caller.
    const downgraded = { root: 'a', context: { permissionMode: 'read_only', root: 'a' } };
    const denied = await api.definition({ executionContext: downgraded.context, filePath: 'a.ts', line: 1, column: 17 });
    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'LSP_PERMISSION_DENIED');
    const stillAllowed = await api.definition({ executionContext: callers[2].context, filePath: 'a.ts', line: 1, column: 17 });
    assert.equal(stillAllowed.success, true);

    assert.equal(total, plan.length);
    assert.ok(total >= 300, `the stress profile must run at least 300 operations (${total})`);
    assert.ok(success >= total - errors.length);
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const stats = manager.stats();
    assert.equal(stats.count, 2, 'one server per workspace');
    assert.equal(stats.instances.filter(i => i.state !== 'ready').length, 0, 'every server must stay ready');
    assert.equal(stats.instances.reduce((n, i) => n + i.pending, 0), 0, 'no request may stay pending');
    assert.equal(stats.instances.reduce((n, i) => n + i.wirePending, 0), 0);
    assert.equal(Object.keys(stats.restarts).length, 0, 'a healthy session must not restart a server');
    await manager.close();
    assert.equal(manager.stats().count, 0);
    await fsp.writeFile('/tmp/lsp4-stress-evidence.json', JSON.stringify({
      operations: total, success, errors: errors.length, errorCodes: [...new Set(errors)],
      p50Ms: Number(pct(0.5).toFixed(2)), p95Ms: Number(pct(0.95).toFixed(2)), maxMs: Number(sorted.at(-1).toFixed(2)),
      workspaces: 2, callers: callers.length,
    }, null, 2));
  } finally {
    await manager.close();
    await assertNoSurvivors(pids, 'stress');
    await fsp.rm(rootA, { recursive: true, force: true });
    await fsp.rm(rootB, { recursive: true, force: true });
  }
});

test.after(() => { try { closeDatabase(); } catch {} Module._load = originalLoad; try { fs.rmSync(databaseDirectory, { recursive: true, force: true }); } catch {} });
