'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const rpc = require('vscode-jsonrpc/node');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-isolation-'));
const root = path.join(directory, 'project'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'a.ts'), 'export const answer = 42;\n');
const handlers = new Map(); let fetchMock;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false }, ipcMain: { handle: (n, fn) => handlers.set(n, fn), removeHandler: n => handlers.delete(n) } };
  if (name.endsWith('/localEngineFetch') || name.endsWith('/nodeHttpFetch')) return { localEngineFetch: (...a) => fetchMock(...a), nodeHttpFetch: (...a) => fetchMock(...a) };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db');
const contexts = require('../src/main/lspExecutionContext');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const { getToolContext } = require('../src/main/promptBuilder');
const { guardTool, requestToolApproval } = require('../src/main/toolPermissions');
const { manager, LspManager } = require('../src/main/lspManager');
const subagents = require('../src/main/subagents');
const children = require('../src/main/subagents/sessionManager');
const { McpManager } = require('../src/main/mcpManager');
let project, dispose; const servers = [];
const fakeServer = () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const server = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
  server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 2, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true } }));
  server.onRequest('shutdown', () => null); server.onNotification('exit', child.kill);
  server.onRequest('textDocument/hover', () => ({ contents: 'answer: number' }));
  server.onRequest('textDocument/definition', () => []);
  server.onRequest('textDocument/references', () => [0, 1].map(i => ({ uri: require('node:url').pathToFileURL(path.join(root, 'a.ts')).href, range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } } })));
  server.listen(); servers.push(server); return child;
};
function session(id) { require('../src/main/sessionManager').getOrCreateSession(id, 'model', project.id); return id; }
function sender() { const s = new EventEmitter(); s.sent = []; s.isDestroyed = () => false; s.send = (channel, value) => s.sent.push({ channel, value }); return s; }
const response = (calls, content = '') => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const writeArgs = file => ({ relative_path: file, content: 'authorized' });
const dispatch = (id, name, args, extra = {}) => executeAgentTool({ sessionId: id, permissionMode: 'full_access', name, arguments: args, ...extra });
const invoke = (owner, name, args) => handlers.get(name)({ sender: owner }, args);
test.before(() => {
  database.initDatabase(directory);
  project = require('../src/main/projectManager').createProject({ name: 'Permissions', root_path: root });
  const mcp = require('../src/main/mcpManager'); mcp.init = async () => {}; mcp.reload = async () => {}; mcp.load = async () => {}; mcp.getTools = () => [];
  manager.spawnServer = fakeServer;
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
});
test.after(async () => { await manager.close(); servers.forEach(s => s.dispose()); dispose?.(); database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('stale native grants and schemas cannot override current session permissions', async () => {
  const id = session('live-native'); contexts.createContext(id, 'full_access', 'same-run');
  assert.equal((await dispatch(id, 'write_project_file', writeArgs('before.txt'))).success, true);
  await contexts.setMode(id, 'read_only');
  const names = getToolContext([], false, id, 'full_access').tools.map(t => t.function.name);
  assert.equal(names.includes('write_project_file'), false);
  const advertised = await invoke(sender(), 'agent:get-tools', { sessionId: id, permissionMode: 'full_access' });
  assert.equal(advertised.some(t => t.function.name === 'execute_command'), false);
  const denied = await dispatch(id, 'write_project_file', writeArgs('denied.txt'), { permissionGranted: true, approval: { mode: 'full_access', approved: false } });
  assert.equal(denied.success, false); assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
  await contexts.setMode(id, 'workspace_write');
  assert.equal((await dispatch(id, 'write_project_file', writeArgs('resumed.txt'))).success, true);
  assert.equal(fs.readFileSync(path.join(root, 'before.txt'), 'utf8'), 'authorized');
  assert.equal((await dispatch(id, 'write_project_file', writeArgs('../external.txt'))).success, false);
});

test('approval cannot outlive a permission change, even after downgrade then upgrade', async () => {
  const id = session('approval-revoked'); contexts.createContext(id, 'workspace_write');
  let release, started; const pending = new Promise(r => { started = r; });
  const result = guardTool({ sessionId: id, name: 'generate_image', args: { prompt: 'test' }, project, permissionMode: 'workspace_write', requestApproval: () => { started(); return new Promise(r => { release = r; }); } });
  await pending; await contexts.setMode(id, 'read_only'); await contexts.setMode(id, 'workspace_write'); release(true);
  await assert.rejects(result, /permission.*changed|revoked/i);
});

test('approval IDs isolate concurrent callers, denial, cancellation and replay', async () => {
  const owner = sender(), a = new AbortController(), b = new AbortController();
  const aa = requestToolApproval({ controller: a, sender: owner, requestId: 'a', sessionId: 'chat-a', name: 'execute_command', args: { command: 'one' } });
  const bb = requestToolApproval({ controller: b, sender: owner, requestId: 'b', sessionId: 'chat-b', name: 'execute_command', args: { command: 'two' } });
  const [pa, pb] = owner.sent.map(e => e.value);
  assert.notEqual(pa.approvalId, pb.approvalId); assert.equal(pa.args.command, 'one');
  a.toolApprovals.get(pa.approvalId)(true); assert.equal(await aa, true);
  assert.equal(b.toolApprovals.has(pa.approvalId), false); assert.equal(b.toolApprovals.has(pb.approvalId), true);
  b.abort(); assert.equal(await bb, false); assert.equal(a.toolApprovals.size + b.toolApprovals.size, 0);
});

test('shared LSP revokes one caller without closing an authorized peer server', async () => {
  const a = session('lsp-a'), b = session('lsp-b'); const ca = contexts.createContext(a, 'workspace_write'); const cb = contexts.createContext(b, 'workspace_write');
  const args = { path: 'a.ts', line: 1, column: 14 };
  assert.equal((await dispatch(a, 'lsp_hover', args, { executionContext: ca })).success, true);
  const entry = await manager.acquire(cb);
  await contexts.setMode(a, 'read_only');
  assert.equal((await dispatch(a, 'lsp_hover', args, { executionContext: ca })).error.code, 'LSP_PERMISSION_DENIED');
  assert.equal((await dispatch(b, 'lsp_hover', args, { executionContext: cb })).success, true);
  assert.equal(await manager.acquire(cb), entry, 'revocation must preserve the peer process');
});

test('MCP mutation grants cannot cross sessions or tool identities', async () => {
  const mcp = new McpManager(); const calls = [];
  mcp.servers.set('db', { enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'query' }, { name: 'other' }], client: { callTool: async c => { calls.push(c); return { content: [] }; } } });
  const a = session('mcp-a'), b = session('mcp-b'); contexts.createContext(a, 'workspace_write'); contexts.createContext(b, 'workspace_write');
  const args = { query: 'DELETE FROM records' };
  const hash = require('../src/main/safetyGuards').mutationHash(a, 'db', 'query', JSON.stringify(args));
  await assert.rejects(mcp.callTool('db', 'query', args, { sessionId: a, permissionMode: 'workspace_write' }), /approval denied/);
  assert.equal((await dispatch(a, 'approve_mcp_mutation', { hash }, { permissionMode: 'workspace_write', permissionGranted: true, approval: { mode: 'workspace_write', approved: true } })).success, true);
  // A legacy payload hash is never a substitute for explicit outbound approval.
  await assert.rejects(mcp.callTool('db', 'query', args, { sessionId: b, permissionMode: 'workspace_write' }), /approval denied/);
  await assert.rejects(mcp.callTool('db', 'other', args, { sessionId: a, permissionMode: 'workspace_write' }), /approval denied/);
  await mcp.callTool('db', 'query', args, { sessionId: a, permissionMode: 'workspace_write', permissionGranted: true, approval: {mode:'workspace_write',approved:true} });
  assert.equal(calls.length, 1);
  await assert.rejects(mcp.callTool('db', 'query', args, { sessionId: a, permissionMode: 'workspace_write' }), /approval denied/);
  await contexts.setMode(a, 'read_only');
  await assert.rejects(mcp.callTool('db', 'query', { query: 'SELECT 1' }, { sessionId: a, permissionMode: 'full_access', permissionGranted: true }), /Read Only|revoked|permission/i);
});

test('recovery preserves a restricted child ceiling and invalidates old references', async () => {
  const id = session('recover-parent'); const parent = contexts.createContext(id, 'workspace_write');
  fetchMock = async () => response(null, 'Child complete.');
  await dispatch(id, 'spawn_sub_agent', { task: 'Inspect a.ts', investigate: true }, { engine: { port: 12345, modelId: 'model', contextLength: 32768 }, executionContext: parent });
  const child = children.listChildren(id).at(-1); const old = contexts.childContext(child);
  contexts.setChildMode(child, 'read_only');
  children.deleteSession(child.id);
  assert.equal(old.permissionMode, 'read_only');
  subagents.recoverChild(child.id, { parentSessionId: id, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, verifyOwner: true });
  const recovered = contexts.childContext(children.getSession(child.id));
  assert.equal(recovered?.permissionMode ?? 'read_only', 'read_only', 'recovery must not promote a restricted child');
});


test('LSP cursors cannot cross same-workspace callers or policy generations', async () => {
 const a = session('cursor-a'), b = session('cursor-b'); const ca = contexts.createContext(a, 'workspace_write'), cb = contexts.createContext(b, 'workspace_write');
 const args = { path: 'a.ts', line: 1, column: 14, page_size: 1 };
 const first = await dispatch(a, 'lsp_references', args, { executionContext: ca });
 assert.ok(first.nextCursor, JSON.stringify(first));
 const stolen = await dispatch(b, 'lsp_references', { cursor: first.nextCursor }, { executionContext: cb });
 assert.equal(stolen.success, false, 'same root does not authorize another caller cursor');
 const own = await dispatch(a, 'lsp_references', { cursor: first.nextCursor }, { executionContext: ca });
 assert.equal(own.success, true, 'rejected cross-caller attempt does not consume owner cursor');
 const second = await dispatch(a, 'lsp_references', args, { executionContext: ca });
 await contexts.setMode(a, 'read_only'); await contexts.setMode(a, 'workspace_write');
 assert.equal((await dispatch(a, 'lsp_references', { cursor: second.nextCursor }, { executionContext: ca })).success, false);
});

test('end-to-end: one parent run keeps plan, steering, child isolation and scoped approval across revocation/recovery', { timeout: 10000 }, async () => {
 const id = session('e2e-parent'), owner = sender(); let round = 0, runId, planId, approvedCount = 0;
 const parentPayloads = [], childResults = new Map();
 const send = owner.send;
 owner.send = (channel, value) => {
  send(channel, value);
  if (channel === 'engine:request-tool-approval' && !value.resolved) {
   approvedCount++;
   assert.equal(value.sessionId, id); assert.equal(value.name, 'delete_project_file'); assert.equal(value.args.path, 'e2e-before.txt');
   setImmediate(() => invoke(owner, 'engine:tool-approval-response', { requestId: 'e2e-request', approvalId: value.approvalId, action: 'allow' }));
  }
 };
 fetchMock = async (_url, opts) => {
  const payload = JSON.parse(opts.body);
  const user = payload.messages.find(m => m.role === 'user')?.content ?? '';
  if (String(user).includes('child-e2e-')) {
   const restricted = String(user).includes('restricted'); const key = restricted ? 'restricted' : 'eligible';
   const own = children.listChildren(id).find(c => c.inputSummary?.task?.includes(`child-e2e-${key === 'restricted' ? 'restricted' : 'eligible'}`));
   assert.ok(own, 'child routing identity must exist before inference');
   if (!payload.messages.some(m => m.role === 'tool')) {
    if (restricted) contexts.setChildMode(own, 'read_only');
    return response(restricted ? [call('child-illegal-write', 'write_project_file', writeArgs('child-illegal.txt')), call('child-denied-lsp', 'lsp_hover', { path: 'a.ts', line: 1, column: 14 })] : [call('child-allowed-lsp', 'lsp_hover', { path: 'a.ts', line: 1, column: 14 })]);
   }
   const output = payload.messages.filter(m => m.role === 'tool'); childResults.set(key, output);
   assert.equal(JSON.stringify(payload.messages).includes(restricted ? 'child-e2e-eligible' : 'child-e2e-restricted'), false);
   return response(null, `${key} child finished.`);
  }
  if (String(user).includes('cancellable-e2e')) return new Promise((_r, reject) => {
   const stop = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
   opts.signal.addEventListener('abort', stop, { once: true }); opts.signal.throwIfAborted();
   // Cancel only this child's independent controller after its model call starts.
   cancelOne.abort();
  });
  parentPayloads.push(payload);
  const names = payload.tools.map(t => t.function.name);
  if (round === 0) { round++; return response([call('activate-native', 'manage_native_tools', { action: 'activate', groups: ['tasks', 'subagents', 'editing', 'files'] })]); }
  switch (round++ - 1) {
   case 0:
    runId = owner.sent.find(e => e.channel === 'engine:stream-status').value.runId;
    return response([call('plan-create', 'update_plan', { action: 'create', objective: 'Retain authorization evidence', steps: [{ description: 'Verify isolation' }] })]);
   case 1:
    planId = require('../src/main/workspacePlan').updatePlan(id, { action: 'get' }).plan.steps[0].id;
    return response([call('spawn-eligible', 'spawn_sub_agent', { task: 'child-e2e-eligible inspect the answer type', investigate: true }), call('spawn-restricted', 'spawn_sub_agent', { task: 'child-e2e-restricted inspect only', investigate: true })]);
   case 2:
    assert.equal(childResults.size, 2);
    assert.equal(JSON.parse(childResults.get('eligible')[0].content).success, true);
    assert.match(childResults.get('restricted')[0].content, /not available/);
    assert.match(childResults.get('restricted')[1].content, /not available.*not executed/);
    return response([call('before-write', 'write_project_file', writeArgs('e2e-before.txt'))]);
   case 3:
    await invoke(owner, 'engine:set-permission-mode', { sessionId: id, permissionMode: 'read_only' });
    await invoke(owner, 'steering:submit', { sessionId: id, runId, content: 'Preserve the isolation evidence.', idempotencyKey: 'permission-e2e' });
    return response([call('stale-write', 'write_project_file', writeArgs('e2e-denied.txt'))]);
   case 4:
    assert.equal(names.includes('write_project_file'), false);
    assert.match(payload.messages.filter(m => m.role === 'tool').at(-1).content, /TOOL_NOT_ADVERTISED/);
    assert.equal(fs.existsSync(path.join(root, 'e2e-denied.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'e2e-before.txt'), 'utf8'), 'authorized');
    await invoke(owner, 'engine:set-permission-mode', { sessionId: id, permissionMode: 'workspace_write' });
    return response([call('upgrade-read', 'read_project_file', { relative_path: 'a.ts' })]);
   case 5:
    assert.equal(names.includes('write_project_file'), true);
    return response([call('resumed-write', 'write_project_file', writeArgs('e2e-resumed.txt'))]);
   case 6:
    assert.equal(JSON.parse(payload.messages.filter(m => m.role === 'tool').at(-1).content).success, true);
    return response([call('scoped-delete', 'delete_project_file', { path: 'e2e-before.txt' })]);
   case 7: {
    assert.equal(fs.existsSync(path.join(root, 'e2e-before.txt')), false);
    const all = children.listChildren(id); const restricted = all.find(c => c.inputSummary.task.includes('restricted'));
    const eligible = all.find(c => c !== restricted);
    const old = contexts.childContext(restricted); children.deleteSession(restricted.id);
    subagents.recoverChild(restricted.id, { parentSessionId: id, verifyOwner: true, engine: { port: 12345, modelId: 'model', contextLength: 32768 } });
    const recovered = children.getSession(restricted.id);
    assert.equal(old.permissionMode, 'read_only'); assert.equal(contexts.childContext(recovered).permissionMode, 'read_only');
    const denied = await dispatch(null, 'lsp_hover', { path: 'a.ts', line: 1, column: 14 }, { executionContext: contexts.childContext(recovered) });
    assert.equal(denied.error.code, 'LSP_PERMISSION_DENIED');
    const cancelled = await dispatch(id, 'spawn_sub_agent', { task: 'cancellable-e2e', investigate: true }, { signal: cancelOne.signal, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, executionContext: contexts.forTool(id, 'workspace_write') });
    assert.equal(cancelled.success, false); assert.equal(eligible.status, 'completed');
    assert.equal(contexts.childContext(eligible).permissionMode, 'workspace_write');
    return response(null, 'Authorization simulation complete.');
   }
   default: throw new Error('Unexpected duplicate parent request');
  }
 };
 const cancelOne = new AbortController();
 const result = await invoke(owner, 'engine:chat', { requestId: 'e2e-request', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Run the authorization simulation.' }] });
 assert.match(result.text, /simulation complete/, JSON.stringify(result)); assert.equal(result.runId, runId); assert.equal(approvedCount, 1);
 assert.equal(require('../src/main/workspacePlan').updatePlan(id, { action: 'get' }).plan.steps[0].id, planId);
 assert.equal(fs.existsSync(path.join(root, 'child-illegal.txt')), false); assert.equal(fs.readFileSync(path.join(root, 'e2e-resumed.txt'), 'utf8'), 'authorized');
 assert.ok(parentPayloads.some(p => JSON.stringify(p.messages).includes('Preserve the isolation evidence.')));
 const ids = parentPayloads.at(-1).messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
 assert.equal(new Set(ids).size, ids.length, 'every call gets exactly one result');
});

test('all live transitions and concurrent sessions use their own trusted mode', async () => {
 for (const [before, after] of [['full_access', 'workspace_write'], ['workspace_write', 'read_only'], ['workspace_write', 'ask_approval'], ['read_only', 'workspace_write'], ['ask_approval', 'full_access']]) {
  const id = session(`transition-${before}-${after}`); contexts.createContext(id, before);
  await contexts.setMode(id, after);
  const out = await dispatch(id, 'write_project_file', writeArgs(`${id}.txt`), { permissionMode: before });
  assert.equal(out.success, after !== 'read_only', JSON.stringify(out));
  const external = await dispatch(id, 'write_project_file', writeArgs(`../${id}.txt`), { permissionMode: before });
  assert.equal(external.success, after === 'full_access', `${after}: ${JSON.stringify(external)}`);
 }
 const modes = ['workspace_write', 'read_only', 'full_access', 'ask_approval'];
 const results = await Promise.all(modes.map(async mode => {
  const id = session(`concurrent-${mode}`); contexts.createContext(id, mode);
  return dispatch(id, 'write_project_file', writeArgs(`${id}.txt`), { permissionMode: 'full_access' });
 }));
 assert.deepEqual(results.map(o => o.success), [true, false, true, true]);
});

test('independent child ceilings follow parent revocation without changing siblings', async () => {
 const id = session('child-ceilings'); const parent = contexts.createContext(id, 'full_access');
 const a = children.createSession({ parentSessionId: id }), b = children.createSession({ parentSessionId: id });
 const ca = contexts.authorizeChild(a, parent, 'workspace_write'), cb = contexts.authorizeChild(b, parent, 'read_only');
 const args = { path: 'a.ts', line: 1, column: 14 };
 assert.equal(ca.permissionMode, 'workspace_write'); assert.equal(cb.permissionMode, 'read_only');
 assert.equal(contexts.authorizeChild({ id: 'forged', parentSessionId: 'other' }, parent, 'full_access'), null);
 assert.equal((await dispatch(id, 'spawn_sub_agent', { task: 'Escalate', investigate: true, permissionMode: 'full_access' })).success, false);
 await contexts.setMode(id, 'workspace_write'); assert.equal(ca.permissionMode, 'workspace_write');
 contexts.setChildMode(a, 'read_only'); assert.equal(cb.permissionMode, 'read_only');
 contexts.setChildMode(a, 'workspace_write');
 await contexts.setMode(id, 'read_only'); assert.equal(ca.permissionMode, 'read_only');
 assert.equal((await dispatch(null, 'lsp_hover', args, { executionContext: ca })).error.code, 'LSP_PERMISSION_DENIED');
 await contexts.setMode(id, 'workspace_write'); assert.equal(ca.permissionMode, 'workspace_write'); assert.equal(cb.permissionMode, 'read_only');
 a.status = 'cancelled'; assert.equal(ca.permissionMode, 'read_only');
 children.deleteSession(a.id); children.deleteSession(b.id);
});

test('a mode change resolves a pending real IPC approval without performing the action', { timeout: 5000 }, async () => {
 const id = session('pending-approval'), owner = sender(); fs.writeFileSync(path.join(root, 'pending-delete.txt'), 'retain');
 let asked; const pendingApproval = new Promise(r => { asked = r; }); const send = owner.send; let round = 0;
 owner.send = (channel, payload) => { send(channel, payload); if (channel === 'engine:request-tool-approval' && !payload.resolved) asked(payload); };
 fetchMock = async () => {
  const index = round++;
  if (index === 0) return response([call('activate-editing', 'manage_native_tools', { action: 'activate', groups: ['editing'] })]);
  return index > 1 ? response(null, 'Approval was revoked.') : response([call('pending-delete', 'delete_project_file', { path: 'pending-delete.txt' })]);
 };
 const run = invoke(owner, 'engine:chat', { requestId: 'approval-request', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Delete with approval.' }] });
 const approval = await pendingApproval;
 await assert.rejects(invoke(sender(), 'engine:tool-approval-response', { requestId: 'approval-request', approvalId: approval.approvalId, action: 'allow' }), /no longer pending/);
 await invoke(owner, 'engine:set-permission-mode', { sessionId: id, permissionMode: 'read_only' });
 await run;
 assert.equal(fs.readFileSync(path.join(root, 'pending-delete.txt'), 'utf8'), 'retain');
 await assert.rejects(invoke(owner, 'engine:tool-approval-response', { requestId: 'approval-request', approvalId: approval.approvalId, action: 'allow' }), /no longer pending/);
});

test('MCP deactivation and permission revocation are rechecked after asynchronous recovery preparation', async () => {
 const id = session('queued-mcp'); contexts.createContext(id, 'workspace_write');
 const mcp = new McpManager(); let count = 0;
 const server = { enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'write_file' }], client: { callTool: async () => { count++; return { content: [] }; } } };
 mcp.servers.set('files', server);
 const boundary = require('../src/main/recoveryBoundary'), originalScan = boundary.shouldScanMcpCall;
 try {
  for (const revoke of [async () => { server.enabled = false; }, async () => contexts.setMode(id, 'read_only')]) {
   server.enabled = true; await contexts.setMode(id, 'workspace_write');
   let started, release; const prepared = new Promise(r => { started = r; });
   boundary.shouldScanMcpCall = async () => { started(); await new Promise(r => { release = r; }); return false; };
   const operation = mcp.callTool('files', 'write_file', {}, { sessionId: id, permissionMode: 'workspace_write' });
   await prepared; await revoke(); release();
   await assert.rejects(operation, /revoked|unavailable/);
  }
  assert.equal(count, 0);
 } finally { boundary.shouldScanMcpCall = originalScan; }
});

test('a command awaiting recovery preparation cannot start after permission revocation', async () => {
 const id = session('queued-command'); contexts.createContext(id, 'full_access');
 const boundary = require('../src/main/recoveryBoundary'), original = boundary.withShellRecovery;
 let started, release; const prepared = new Promise(r => { started = r; });
 boundary.withShellRecovery = async (_options, execute) => { started(); await new Promise(r => { release = r; }); return execute(); };
 try {
  const operation = require('./helpers/approvedNativeCommand.cjs')({ sessionId: id, name: 'execute_command', arguments: { command: 'printf forbidden > queued-command.txt' }, permissionMode: 'full_access' });
  await prepared; await contexts.setMode(id, 'read_only'); release(); const result = await operation;
  assert.equal(fs.existsSync(path.join(root, 'queued-command.txt')), false, JSON.stringify(result));
  assert.equal(result.success, false);
 } finally { boundary.withShellRecovery = original; }
});
