'use strict';

// Main-process only. No IPC or model tool registration.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const rpc = require('vscode-jsonrpc/node');
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const inside = (root, target) => { const r = path.relative(root, target); return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const languages = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact' };
const methods = { 'textDocument/definition': 'definitionProvider', 'textDocument/references': 'referencesProvider', 'textDocument/hover': 'hoverProvider', 'textDocument/documentSymbol': 'documentSymbolProvider', 'workspace/symbol': 'workspaceSymbolProvider' };
function runtimePath(p) { return p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'); }
function launch(root) {
  const cli = runtimePath(require.resolve('typescript-language-server/lib/cli.mjs'));
  const child = spawn(process.execPath, [cli, '--stdio'], { cwd: root, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' } });
  child.lspOwnedGroup = true; return child; // Never unref: this is an owned process group, not a daemon.
}
function forceKill(child) {
  if (!child) return;
  if (child.lspOwnedGroup && Number.isInteger(child.pid)) {
    if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
  }
  child.kill('SIGKILL');
}

class Client {
  constructor(child, { timeout = 15000, pendingLimit = 64 } = {}) {
    this.child = child; this.timeout = timeout; this.pendingLimit = pendingLimit; this.pending = new Set(); this.wirePending = 0; this.dead = false;
    const reader = new rpc.StreamMessageReader(child.stdout); const writer = new rpc.StreamMessageWriter(child.stdin);
    const awaitingIds = new Set(); this.awaitingIds = awaitingIds;
    const write = writer.write.bind(writer); writer.write = message => {
      if (message.method && message.id != null) awaitingIds.add(message.id);
      return write(message);
    };
    // Filter before the library's dispatch queue: duplicate response IDs in one
    // concatenated packet must not overwrite the first queued response.
    const listen = reader.listen.bind(reader); reader.listen = callback => listen(message => {
      if (message && message.id != null && !message.method && !awaitingIds.delete(message.id)) return;
      callback(message);
    });
    this.connection = rpc.createMessageConnection(reader, writer);
    this.connection.onError(() => this.terminate());
    this.connection.onClose(() => this.terminate());
    child.on('error', () => this.terminate()); child.on('exit', () => this.terminate());
    this.stderr = ''; child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); }); // Drain logs; never parse stderr as protocol.
    this.connection.onRequest(() => { throw new rpc.ResponseError(-32601, 'Client method unavailable'); });
    this.connection.listen();
  }
  notify(method, params) { if (this.dead) throw fail('SERVER_TERMINATED'); return this.connection.sendNotification(method, params); }
  request(method, params, { signal, timeout = this.timeout } = {}) {
    if (signal?.aborted) return Promise.reject(fail('REQUEST_CANCELLED'));
    if (this.dead) return Promise.reject(fail('SERVER_TERMINATED'));
    if (this.wirePending >= this.pendingLimit) return Promise.reject(fail('REQUEST_LIMIT'));
    return new Promise((resolve, reject) => {
      const token = new rpc.CancellationTokenSource(); let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(stop); token.dispose(); error ? reject(error) : resolve(value); };
      const stop = code => { if (!this.dead) { try { token.cancel(); } catch {} } finish(fail(code)); };
      const abort = () => stop('REQUEST_CANCELLED');
      const timer = setTimeout(() => stop('REQUEST_TIMEOUT'), timeout);
      this.pending.add(stop); signal?.addEventListener('abort', abort, { once: true });
      this.wirePending++;
      this.connection.sendRequest(method, params, token.token).then(v => { this.wirePending--; finish(null, v); }, e => { this.wirePending--; finish(e); });
    });
  }
  terminate() { if (this.dead) return; this.dead = true; for (const stop of [...this.pending]) stop('SERVER_TERMINATED'); this.connection.dispose(); this.awaitingIds.clear(); }
}

class LspManager {
  constructor({ authorize, spawnServer = launch, maxInstances = 3, requestTimeout = 15000, initializationTimeout = 20000, shutdownTimeout = 1500 } = {}) {
    if (typeof authorize !== 'function') throw new TypeError('Main-process authorization callback required');
    Object.assign(this, { authorize, spawnServer, maxInstances, requestTimeout, initializationTimeout, shutdownTimeout });
    this.instances = new Map(); this.closed = false; this.epoch = 0;
  }
  async identity(context) {
    if (this.closed) throw fail('SERVER_UNAVAILABLE');
    const root = await this.authorize(context);
    if (!root || typeof root !== 'string') throw fail('WORKSPACE_UNAUTHORIZED');
    const real = await fs.realpath(root);
    if (!(await fs.stat(real)).isDirectory()) throw fail('WORKSPACE_UNAUTHORIZED');
    return real;
  }
  async acquire(context, signal) {
    const epoch = this.epoch; const root = await this.identity(context);
    if (epoch !== this.epoch || this.closed) throw fail('SERVER_UNAVAILABLE');
    if (signal?.aborted) throw fail('REQUEST_CANCELLED');
    let entry = this.instances.get(root);
    if (!entry) {
      if (this.instances.size >= this.maxInstances) throw fail('INSTANCE_LIMIT');
      entry = { root, state: 'starting', documents: new Map(), diagnostics: new Map(), queue: Promise.resolve(), timings: {}, nextVersion: 0, events: new EventEmitter() };
      this.instances.set(root, entry);
      entry.start = this.start(entry);
    }
    // Cancellation belongs to the caller, not to a shared workspace startup.
    if (!signal) { await entry.start; await this.check(context, entry); return entry; }
    await new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(fail('REQUEST_CANCELLED')); };
      signal.addEventListener('abort', abort, { once: true });
      entry.start.then(() => { signal.removeEventListener('abort', abort); resolve(); }, e => { signal.removeEventListener('abort', abort); reject(e); });
      if (signal.aborted) abort();
    });
    await this.check(context, entry);
    return entry;
  }
  async start(e) {
    const began = performance.now();
    try {
      const child = this.spawnServer(e.root); e.client = new Client(child, { timeout: this.requestTimeout });
      child.once('exit', () => { if (e.state !== 'stopping') { e.state = 'failed'; if (child.lspOwnedGroup) forceKill(child); } e.diagnostics.clear(); });
      e.client.connection.onNotification('textDocument/publishDiagnostics', p => {
        const doc = e.documents.get(p?.uri);
        if (e.closing || e.client.dead || !doc || !Array.isArray(p.diagnostics)) return;
        // Unversioned publications cannot prove freshness: retain as explicitly unverified.
        const bounded = []; let bytes = 0;
        for (const item of p.diagnostics.slice(0, 1000)) {
          if (!item || typeof item !== 'object') continue;
          const diagnostic = { ...item, message: String(item.message ?? '').slice(0, 16000), messageTruncated: String(item.message ?? '').length > 16000, relatedInformation: (Array.isArray(item.relatedInformation) ? item.relatedInformation : []).filter(info => info && typeof info === 'object').slice(0, 10).map(info => ({ ...info, message: String(info.message ?? '').slice(0, 1000) })) };
          const size = Buffer.byteLength(JSON.stringify(diagnostic)); if (bytes + size > 1024 * 1024) break; bytes += size; bounded.push(diagnostic);
        }
        e.diagnostics.set(p.uri, { total: p.diagnostics.length, diagnostics: bounded, version: p.version ?? null, contentHash: doc.hash, stale: p.version == null || p.version !== doc.version });
        e.events.emit('diagnostics', p.uri);
      });
      e.state = 'initializing';
      const result = await e.client.request('initialize', {
        processId: process.pid, rootUri: pathToFileURL(e.root).href,
        workspaceFolders: [{ uri: pathToFileURL(e.root).href, name: path.basename(e.root) }],
        capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: { synchronization: { didSave: true }, publishDiagnostics: { versionSupport: true } } },
        initializationOptions: { hostInfo: 'Continuum', disableAutomaticTypingAcquisition: true, maxTsServerMemory: 512, tsserver: { path: runtimePath(require.resolve('typescript/lib/tsserver.js')) }, plugins: [] },
      }, { timeout: this.initializationTimeout });
      if (!result?.capabilities || (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== 'utf-16')) throw fail('INITIALIZATION_FAILED');
      const sync = result.capabilities.textDocumentSync;
      if (![1, 2].includes(typeof sync === 'number' ? sync : sync?.change)) throw fail('INITIALIZATION_FAILED', 'Document synchronization unavailable');
      e.capabilities = result.capabilities;
      await e.client.notify('initialized', {}); e.state = e.closing ? 'stopping' : 'ready'; e.timings.startupMs = performance.now() - began;
    } catch (error) { e.state = 'failed'; e.client?.terminate(); forceKill(e.client?.child); throw fail('INITIALIZATION_FAILED', error.message); }
  }
  async file(e, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\0')) throw fail('INVALID_FILE');
    const target = relative.startsWith('file:') ? fileURLToPath(relative) : path.resolve(e.root, relative);
    if (!inside(e.root, target)) throw fail('WORKSPACE_UNAUTHORIZED');
    let current = target;
    while (true) {
      try { if (!inside(e.root, await fs.realpath(current))) throw fail('WORKSPACE_UNAUTHORIZED'); break; }
      catch (err) { if (err.code !== 'ENOENT') throw err; const parent = path.dirname(current); if (parent === current) throw err; current = parent; }
    }
    let canonical = target; try { canonical = await fs.realpath(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return { target: canonical, uri: pathToFileURL(canonical).href };
  }
  serialized(e, work) { const next = e.queue.then(work); e.queue = next.catch(() => {}); return next; }
  async sync(e, relative) {
    const began = performance.now(); const { target, uri } = await this.file(e, relative);
    const languageId = languages[path.extname(target).toLowerCase()];
    if (!languageId) throw fail('UNSUPPORTED_FILE_TYPE');
    let bytes;
    try { const stat = await fs.stat(target); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fail('DOCUMENT_LIMIT'); bytes = await fs.readFile(target); }
    catch (err) { if (err.code === 'ENOENT') await this.closeDocument(e, uri); throw err; }
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const previous = e.documents.get(uri);
    if (previous?.hash === hash) return previous;
    if (!previous && e.documents.size >= 128) throw fail('DOCUMENT_LIMIT');
    const doc = { uri, text: bytes.toString('utf8'), hash, version: ++e.nextVersion };
    if (previous) {
      e.diagnostics.delete(uri);
      // A full-range replacement is valid incremental synchronization too.
      const lines = previous.text.split('\n');
      const sync = e.capabilities.textDocumentSync; const kind = typeof sync === 'number' ? sync : sync.change;
      await e.client.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ ...(kind === 2 ? { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } } } : {}), text: doc.text }] });
    } else await e.client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: doc.version, text: doc.text } });
    e.documents.set(uri, doc); e.timings.syncMs = performance.now() - began; return doc;
  }
  async closeDocument(e, uri) { if (e.documents.delete(uri)) await e.client.notify('textDocument/didClose', { textDocument: { uri } }); e.diagnostics.delete(uri); }
  async refresh(context, relative, options = {}) { const e = await this.acquire(context, options.signal); return this.serialized(e, async () => { await this.check(context, e); const doc = await this.sync(e, relative); await this.check(context, e); return doc; }); }
  async request(context, method, input = {}, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_REQUEST');
    if (!Object.hasOwn(methods, method)) throw fail('UNSUPPORTED_METHOD');
    const e = await this.acquire(context, options.signal);
    return this.serialized(e, async () => {
      await this.check(context, e);
      if (options.signal?.aborted) throw fail('REQUEST_CANCELLED');
      if (e.state !== 'ready') throw fail('SERVER_UNAVAILABLE');
      if (!e.capabilities[methods[method]]) throw fail('UNSUPPORTED_CAPABILITY');
      // Refresh every open document so imported files cannot remain stale after external edits.
      for (const uri of [...e.documents.keys()]) { try { await this.sync(e, uri); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
      let params;
      if (method === 'workspace/symbol') { if (typeof input.query !== 'string' || input.query.length > 512) throw fail('INVALID_QUERY'); params = { query: input.query }; }
      else {
        const doc = await this.sync(e, input.path); params = { textDocument: { uri: doc.uri } };
        if (method !== 'textDocument/documentSymbol') {
          const p = input.position; const lines = doc.text.split(/\r?\n/);
          if (!p || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.line >= lines.length || p.character < 0 || p.character > lines[p.line].length) throw fail('INVALID_POSITION');
          params.position = { line: p.line, character: p.character };
        }
        if (method === 'textDocument/references') params.context = { includeDeclaration: input.includeDeclaration === true };
      }
      const began = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) controller.abort();
      let accessError = null;
      const timer = setInterval(() => { this.check(context, e).catch(error => { accessError = error; controller.abort(); }); }, 25);
      let result;
      try { result = await e.client.request(method, params, { ...options, signal: controller.signal }); }
      catch (error) { if (accessError) throw accessError; throw error; }
      finally { clearInterval(timer); options.signal?.removeEventListener('abort', abort); }
      await this.check(context, e);
      if (result !== null && (typeof result !== 'object' || result === undefined)) throw fail('INVALID_RESPONSE');
      if (['textDocument/references', 'textDocument/documentSymbol', 'workspace/symbol'].includes(method) && result !== null && !Array.isArray(result)) throw fail('INVALID_RESPONSE');
      // Preserve native shapes, but reject external result locations (including related links).
      const validate = async value => { if (!value || typeof value !== 'object') return; for (const [k, v] of Object.entries(value)) { if ((k === 'uri' || k === 'targetUri') && typeof v === 'string') { if (!v.startsWith('file:')) throw fail('WORKSPACE_UNAUTHORIZED'); await this.file(e, v); } else if (typeof v === 'object') await validate(v); } };
      if (!options.transform) await validate(result);
      const observed = [...e.documents.values()].map(d => ({ uri: d.uri, hash: d.hash }));
      for (const doc of observed) {
        try { if ((await this.sync(e, doc.uri)).hash !== doc.hash) throw fail('STALE_DOCUMENT'); }
        catch (err) { if (err.code === 'ENOENT') throw fail('STALE_DOCUMENT'); throw err; }
      }
      e.timings.requestMs = performance.now() - began; const output = options.transform ? await options.transform(result, e, params) : result;
      await this.check(context, e); return output;
    });
  }
  async check(context, entry) {
    try { if (await this.identity(context) !== entry.root) throw fail('WORKSPACE_UNAUTHORIZED'); }
    catch (err) { void this.closeRoot(entry.root).catch(() => {}); throw err; }
    if (entry.state !== 'ready' || entry.closing) throw fail('SERVER_UNAVAILABLE');
  }
  // Trusted main-process owners call this when a live context's mode changes.
  // Revocation closes the shared server; eligible peers may reacquire on demand.
  async permissionChanged(context, previousRoot) {
    try { if (await this.identity(context) === previousRoot) return; } catch {}
    if (previousRoot) await this.closeRoot(previousRoot);
  }
  async closeFile(context, relative) {
    const root = await this.identity(context); const e = this.instances.get(root); if (!e) return;
    await e.start; return this.serialized(e, async () => { await this.check(context, e); return this.closeDocument(e, (await this.file(e, relative)).uri); });
  }
  async saved(context, relative, options = {}) {
    const e = await this.acquire(context, options.signal);
    return this.serialized(e, async () => {
      await this.check(context, e); const doc = await this.sync(e, relative); const save = e.capabilities.textDocumentSync?.save;
      if (save) await e.client.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(save.includeText ? { text: doc.text } : {}) });
      await this.check(context, e); return doc;
    });
  }
  async diagnostics(context, relative) {
    const e = await this.acquire(context);
    return this.serialized(e, async () => { await this.check(context, e); const doc = await this.sync(e, relative); await this.check(context, e); return e.diagnostics.get(doc.uri) ?? null; });
  }
  async closeRoot(root) {
    this.epoch++;
    if (!this.instances.has(root)) { try { root = await fs.realpath(root); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
    const e = this.instances.get(root); if (!e) return;
    if (e.stop) return e.stop;
    e.closing = true;
    e.stop = (async () => {
      const began = performance.now();
      e.state = 'stopping';
      try { await e.start; e.state = 'stopping'; await e.client.request('shutdown', null, { timeout: this.shutdownTimeout }); await e.client.notify('exit'); } catch {}
      e.client?.terminate();
      const child = e.client?.child;
      if (child && child.exitCode == null && child.signalCode == null) {
        await new Promise(resolve => { const timer = setTimeout(() => { forceKill(child); resolve(); }, this.shutdownTimeout); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      }
      e.documents.clear(); e.diagnostics.clear(); e.state = 'stopped'; e.timings.shutdownMs = performance.now() - began; this.instances.delete(root);
    })(); return e.stop;
  }
  async close() { this.closed = true; this.epoch++; await Promise.all([...this.instances.keys()].map(root => this.closeRoot(root))); }
}

// LSP-specific execution eligibility; unrelated shell policy remains unchanged.
async function authorizeContext(context) {
  const permissions = require('./toolPermissions');
  const project = permissions.sessionProject(context?.sessionId);
  if (!project?.root_path || !['workspace_write', 'full_access'].includes(permissions.effectiveMode(context?.permissionMode, project))) throw fail('WORKSPACE_UNAUTHORIZED');
  return project.root_path;
}
const manager = new LspManager({ authorize: authorizeContext });
module.exports = { LspManager, Client, manager, languages, runtimePath, authorizeContext };
