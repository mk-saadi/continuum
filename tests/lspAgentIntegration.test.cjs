'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp3-'));
const root = path.join(directory, 'project'); fs.mkdirSync(root);
const handlers = new Map(); let fetchMock;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  if (name.endsWith('/localEngineFetch')) return { localEngineFetch: (...params) => fetchMock(...params) };
  if (name.endsWith('/nodeHttpFetch')) return { nodeHttpFetch: (...params) => fetchMock(...params) };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
const contexts = require('../src/main/lspExecutionContext');
const { LSP_TOOL_NAMES, lspTools, validate } = require('../src/main/tools/lspTools');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { manager } = require('../src/main/lspManager');
const { getToolContext } = require('../src/main/promptBuilder');
const childSessions = require('../src/main/subagents/sessionManager');
const files = { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }), 'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\n', 'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 35 }, (_, i) => `const result${i} = answer();`).join('\n'), 'view.tsx': 'export const View = () => <div />;', 'view.jsx': 'export const JsView = () => <div />;', 'plain.js': 'export const plain = 1;' };
const evidence = { schemaBytes: Buffer.byteLength(JSON.stringify(lspTools)), operations: {}, child: {} };
let dispose, project;
function senderFixture() { const s = new EventEmitter(); s.sent = []; s.send = (channel, value) => s.sent.push({ channel, value }); s.isDestroyed = () => false; return s; }
function session(id) { require('../src/main/sessionManager').getOrCreateSession(id, 'model', project.id); return id; }
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, content = '') => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
function sse(calls, content = '') { const delta = calls ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : { content }; return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); }
const toolsFor = (id, mode) => getToolContext([], false, id, mode).tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name));
const dispatch = (id, mode, name, args, extra = {}) => executeAgentTool({ sessionId: id, permissionMode: mode, name, arguments: args, ...extra });
async function publication(predicate) {
  const e = manager.instances.values().next().value;
  await new Promise((resolve, reject) => {
    const done = () => { if ([...e.diagnostics.values()].some(predicate)) { clearTimeout(timer); e.events.removeListener('diagnostics', done); resolve(); } };
    const timer = setTimeout(() => { e.events.removeListener('diagnostics', done); reject(new Error('diagnostic deadline')); }, 15000);
    e.events.on('diagnostics', done); done();
  });
}
test.before(() => {
  initDatabase(directory);
  project = require('../src/main/projectManager').createProject({ name: 'LSP phase 3', root_path: root });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  const mcp = require('../src/main/mcpManager'); mcp.init = async () => {}; mcp.reload = async () => {}; mcp.load = async () => {}; mcp.getTools = () => [];
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
});
test.after(async () => {
  await manager.close(); evidence.cleanShutdown = manager.instances.size === 0; dispose?.(); closeDatabase(); Module._load = originalLoad;
  await fsp.writeFile('/tmp/lsp3-real-evidence.json', JSON.stringify(evidence, null, 2));
  await fsp.rm(directory, { recursive: true, force: true });
});
test('six schemas, native registration, model conversions and strict argument validation', async () => {
  assert.equal(new Set(agentTools.map(t => t.function.name)).size, agentTools.length);
  assert.equal(lspTools.length, 6);
  const cloud = require('../src/main/cloudProviders');
  const converted = cloud.anthropicPayload({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'inspect' }], tools: lspTools }, 'claude-sonnet-4');
  assert.deepEqual(converted.tools.map(t => t.name), LSP_TOOL_NAMES);
  assert.ok(lspTools.every(t => t.function.description.length < 250 && t.function.parameters.additionalProperties === false));
  const id = session('schema');
  for (const args of [{ path: 'a.ts', line: 1, column: 1, executable: 'evil' }, { path: 'a.ts', line: '1', column: 1 }, { path: 'a.ts', line: 1, column: 0 }, { cursor: 'x', path: 'a.ts' }, { path: 'a.ts', method: 'workspace/executeCommand' }]) assert.equal((await dispatch(id, 'workspace_write', 'lsp_definition', args)).error.code, 'LSP_INVALID_REQUEST');
  assert.equal(validate('lsp_references', { path: 'a.ts', line: 1, column: 1, include_declaration: 'true' }), false);
  assert.equal((await dispatch(id, 'workspace_write', 'lsp_hover', { path: 'x.py', line: 1, column: 1 })).error.code, 'LSP_UNSUPPORTED_LANGUAGE');
});
test('visibility and execution matrix, trusted identity, live transitions and child ceilings', async () => {
  const args = { path: 'a.ts', line: 1, column: 18 };
  for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access']) {
    const id = session(`matrix-${mode}`); const allowed = contexts.eligible(mode);
    assert.equal(toolsFor(id, mode).length, allowed ? 6 : 0);
    for (const name of LSP_TOOL_NAMES) {
      const input = name === 'lsp_workspace_symbols' ? { query: 'answer' } : ['lsp_document_symbols', 'lsp_diagnostics'].includes(name) ? { path: 'a.ts' } : args;
      const result = await dispatch(id, mode, name, input, { permissionGranted: true }); assert.equal(result.success, allowed, `${mode} ${name}`);
      if (!allowed) assert.equal(result.error.code, 'LSP_PERMISSION_DENIED');
    }
  }
  assert.equal(toolsFor(null, 'full_access').length, 0);
  const id = session('transition'); const context = contexts.createContext(id, 'workspace_write', 'trusted-run');
  const refs = await dispatch(id, 'workspace_write', 'lsp_references', { ...args, include_declaration: true, page_size: 1 }, { executionContext: context });
  await contexts.setMode(id, 'read_only');
  assert.equal((await dispatch(id, 'full_access', 'lsp_references', { cursor: refs.nextCursor }, { executionContext: context })).error.code, 'LSP_PERMISSION_DENIED');
  await contexts.setMode(id, 'workspace_write'); assert.equal((await dispatch(id, 'read_only', 'lsp_definition', args, { executionContext: context })).success, true);
  await contexts.setMode(id, 'ask_approval'); await contexts.setMode(id, 'full_access');
  const child = { id: 'child-independent', parentSessionId: id }; const childContext = contexts.authorizeChild(child, context);
  assert.equal(childContext.permissionMode, 'workspace_write', 'never inherits Full Access');
  contexts.setChildMode(child, 'read_only'); assert.equal((await dispatch(null, 'full_access', 'lsp_definition', args, { executionContext: childContext })).error.code, 'LSP_PERMISSION_DENIED');
  contexts.setChildMode(child, 'ask_approval'); assert.equal(contexts.eligible(childContext.permissionMode), false);
  contexts.setChildMode(child, 'full_access'); assert.equal((await dispatch(null, 'read_only', 'lsp_definition', args, { executionContext: childContext })).success, true);
  assert.equal(contexts.authorizeChild({ id: 'wrong', parentSessionId: 'other' }, context), null);
});
test('real main IPC: six tools, paging, diagnostic fix, transcript, activity and steering', { timeout: 45000 }, async () => {
  await manager.closeRoot(root);
  const id = session('main-real'); const owner = senderFixture(); const payloads = []; let n = 0, cursor; let runId;
  const steps = [ ['lsp_definition', { path: 'b.ts', line: 2, column: 23 }], ['lsp_references', { path: 'b.ts', line: 2, column: 23, include_declaration: true, page_size: 2 }], ['lsp_references', () => ({ cursor, page_size: 2 })], ['lsp_hover', { path: 'b.ts', line: 2, column: 23 }], ['lsp_document_symbols', { path: 'a.ts' }], ['lsp_workspace_symbols', { query: 'answer' }], ['lsp_diagnostics', { path: 'b.ts', severities: [1] }], ['lsp_diagnostics', { path: 'b.ts', severities: [1] }] ];
  const start = performance.now();
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body); payloads.push(payload);
    assert.equal(payload.tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name)).length, 6);
    const last = payload.messages.filter(m => m.role === 'tool').at(-1);
    if (last) {
      const out = JSON.parse(last.content); assert.equal(out.success, true, last.content);
      cursor = out.nextCursor ?? cursor;
      evidence.operations[`${steps[n-1][0]}-${n}`] = { bytes: Buffer.byteLength(last.content), output: out };
      if (n === 1) { assert.equal(out.results[0].path, 'a.ts'); evidence.coldFirstCallMs = performance.now() - start; }
      if (n === 7) {
        assert.ok(out.results.some(d => d.code === 2322)); assert.notEqual(out.state, 'ready');
        await fsp.writeFile(path.join(root, 'b.ts'), files['b.ts'].replace(': string', ': number'));
        await manager.refresh(contexts.forTool(id, 'workspace_write'), 'b.ts');
        await publication(p => p.diagnostics.length > 0 && !p.diagnostics.some(d => d.code === 2322));
      }
      if (n === 8) { assert.equal(out.results.length, 0); assert.equal(out.state, 'stale'); }
    }
    if (n === 6) await publication(p => p.diagnostics.some(d => d.code === 2322));
    if (n === 1) {
      runId = owner.sent.find(e => e.channel === 'engine:stream-status' && e.value.status === 'generating').value.runId;
      await handlers.get('steering:submit')({ sender: owner }, { sessionId: id, runId, content: 'Mention freshness uncertainty.', idempotencyKey: 'lsp-steering' });
    }
    const step = steps[n++]; return step ? sse([...(n === 1 ? [call('cold-outline', 'lsp_document_symbols', { path: 'a.ts' })] : []), call(`lsp-${n}`, step[0], typeof step[1] === 'function' ? step[1]() : step[1])]) : sse(null, 'Analysis complete; diagnostics remain unverified.');
  };
  const result = await handlers.get('engine:chat')({ sender: owner }, { requestId: 'lsp-main-real', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Inspect without edits.' }] });
  assert.match(result.text, /Analysis complete/); assert.equal(result.runId, runId);
  assert.ok(payloads.some(p => p.messages.some(m => String(m.content).includes('Mention freshness uncertainty.'))));
  const transcript = require('../src/main/sessionManager').loadSession(id).messages;
  const assistant = transcript.filter(m => m.role === 'assistant').at(-1); const execution = assistant.execution_steps ?? assistant.executionSteps;
  assert.ok(Array.isArray(execution));
  const lspSteps = execution.filter(step => LSP_TOOL_NAMES.includes(step.toolName)); assert.ok(lspSteps.length >= 9); assert.ok(lspSteps.every(step => Number.isFinite(step.durationMs)));
  evidence.coldFirstBatchMs = evidence.coldFirstCallMs; evidence.coldFirstCallMs = lspSteps[0].durationMs; evidence.warmDefinitionMs = lspSteps.find(step => step.toolName === 'lsp_definition').durationMs;
  assert.ok(owner.sent.some(e => e.value.type === 'step-update' || e.channel === 'stream:step-update'));
  evidence.main = { runId: result.runId, modelRequests: payloads.length, completed: true, activityEvents: owner.sent.filter(e => e.channel === 'stream:step-update').length, persistedExecution: execution != null };
  const pid = manager.instances.values().next().value.client.child.pid;
  evidence.serverPid = pid;
});
test('real subagent dispatcher: isolated child transcript and shared server reuse', { timeout: 20000 }, async () => {
  const id = session('child-parent'); const context = contexts.createContext(id, 'workspace_write', 'parent-child-run');
  const before = manager.instances.values().next().value; const requests = [];
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body); requests.push(payload);
    assert.equal(payload.tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name)).length, 6);
    return requests.length === 1 ? response([call('child-def', 'lsp_definition', { path: 'b.ts', line: 2, column: 23 }), call('child-ref', 'lsp_references', { path: 'b.ts', line: 2, column: 23, page_size: 2 })]) : response(null, 'The answer function is defined in a.ts.');
  };
  const output = await dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'Find the answer definition and references.', investigate: true }, { executionContext: context, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, id: 'parent-spawn' });
  assert.equal(typeof output, 'string', JSON.stringify(output)); assert.match(output, /a.ts/);
  const child = childSessions.listChildren(id).at(-1); assert.equal(child.parentSessionId, id); assert.equal(child.parentToolCallId, 'parent-spawn');
  const outputs = child.context.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)); assert.equal(outputs.length, 2); assert.ok(outputs.every(o => o.success));
  assert.ok(child.activity.some(a => a.type === 'tool-result' && a.name === 'lsp_definition' && a.ok && a.returnedCount === 1));
  assert.equal(manager.instances.values().next().value, before);
  evidence.child = { parentSessionId: id, childSessionId: child.id, modelRequests: requests.length, tools: child.activity.filter(a => a.type === 'tool-result'), reusedServer: true, output };
});
test('live IPC mode changes are sender-owned and revoke pending LSP without a new run', async () => {
  const id = session('live-mode'); const owner = senderFixture(); const other = senderFixture(); let release; let started;
  const gate = new Promise(r => { release = r; }); const began = new Promise(r => { started = r; }); let n = 0;
  fetchMock = async () => { if (!n++) { started(); await gate; return response([call('denied-after-change', 'lsp_hover', { path: 'a.ts', line: 1, column: 18 })]); } return response(null, 'LSP is unavailable in this mode.'); };
  const pending = handlers.get('engine:chat')({ sender: owner }, { requestId: 'live-change', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Inspect.' }] });
  await began;
  await assert.rejects(handlers.get('engine:set-permission-mode')({ sender: other }, { sessionId: id, permissionMode: 'read_only' }), /does not own/);
  await handlers.get('engine:set-permission-mode')({ sender: owner }, { sessionId: id, permissionMode: 'read_only' });
  release(); const output = await pending; assert.match(output.text, /unavailable/);
  assert.equal(toolsFor(id, 'workspace_write').length, 0);
  await contexts.setMode(id, 'workspace_write'); assert.equal(toolsFor(id, 'read_only').length, 6);
});
test('real cloud agent path: OpenRouter streaming and Anthropic non-streaming conversion', { timeout: 30000 }, async () => {
  const cloud = require('../src/main/cloudProviders');
  for (const apiType of ['openai', 'anthropic']) {
    const providerId = `lsp-${apiType}`;
    cloud.saveCloudProvider({ id: providerId, name: providerId, baseUrl: apiType === 'anthropic' ? 'https://api.anthropic.com' : 'https://openrouter.ai/api/v1', apiKey: 'stub-key', apiType, modelId: apiType === 'anthropic' ? 'claude-sonnet-4' : 'test-model' });
    const id = session(`cloud-${apiType}`); let round = 0; let toolResultSeen = false;
    fetchMock = async (_url, opts) => {
      const wire = JSON.parse(opts.body); const names = wire.tools.map(t => t.name ?? t.function?.name);
      assert.ok(LSP_TOOL_NAMES.every(n => names.includes(n)));
      if (round++ === 0) {
        if (apiType === 'anthropic') return Response.json({ id: 'anthropic-lsp', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'cloud-hover', name: 'lsp_hover', input: { path: 'a.ts', line: 1, column: 18 } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } });
        return sse([call('cloud-hover', 'lsp_hover', { path: 'a.ts', line: 1, column: 18 })]);
      }
      toolResultSeen = JSON.stringify(wire.messages).includes('answer(): number');
      return apiType === 'anthropic' ? Response.json({ id: 'anthropic-final', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Cloud LSP complete.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }) : sse(null, 'Cloud LSP complete.');
    };
    const out = await handlers.get('engine:chat')({ sender: senderFixture() }, { requestId: `cloud-lsp-${apiType}`, sessionId: id, modelId: 'model', activeChatProvider: { type: 'cloud', provider: providerId, model: apiType === 'anthropic' ? 'claude-sonnet-4' : 'test-model' }, permissionMode: 'full_access', messages: [{ role: 'user', content: 'Inspect the type.' }] });
    assert.match(out.text, /Cloud LSP complete/); assert.equal(toolResultSeen, true);
    evidence[`cloud-${apiType}`] = { modelRequests: round, resultDelivered: toolResultSeen, completed: true };
  }
});
test('active cancellation, timeout, revocation and independent shared-server callers', async () => {
  const id = session('pending'); const ctx = contexts.createContext(id, 'workspace_write', 'pending-run');
  const args = { path: 'a.ts', line: 1, column: 18 };
  await dispatch(id, 'workspace_write', 'lsp_hover', args, { executionContext: ctx });
  const entry = manager.instances.values().next().value; const originalRequest = entry.client.request.bind(entry.client);
  let waiting; let started = new Promise(r => { waiting = r; });
  entry.client.request = (method, params, options = {}) => {
    if (method !== 'textDocument/hover') return originalRequest(method, params, options);
    waiting(); return new Promise((_resolve, reject) => {
      const stop = () => { const e = new Error('cancelled'); e.code = 'REQUEST_CANCELLED'; reject(e); };
      options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop();
    });
  };
  const controller = new AbortController(); const cancelled = dispatch(id, 'workspace_write', 'lsp_hover', args, { executionContext: ctx, signal: controller.signal });
  await started; controller.abort(); assert.equal((await cancelled).error.code, 'LSP_CANCELLED');
  assert.equal(entry.state, 'ready');
  started = new Promise(r => { waiting = r; });
  const revoked = dispatch(id, 'workspace_write', 'lsp_hover', args, { executionContext: ctx }); await started;
  await contexts.setMode(id, 'read_only'); assert.equal((await revoked).error.code, 'LSP_PERMISSION_DENIED');
  await contexts.setMode(id, 'full_access');
  const peerId = session('peer');
  const [a, b] = await Promise.all([dispatch(id, 'read_only', 'lsp_definition', args, { executionContext: ctx }), dispatch(peerId, 'workspace_write', 'lsp_hover', args)]);
  assert.ok(a.success && b.success); assert.equal(manager.instances.size, 1);
  const peer = manager.instances.values().next().value;
  const req = peer.client.request.bind(peer.client); peer.client.request = (method, ...rest) => method === 'textDocument/hover' ? Promise.reject(Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' })) : req(method, ...rest);
  assert.equal((await dispatch(peerId, 'workspace_write', 'lsp_hover', args)).error.code, 'LSP_TIMEOUT');
  peer.client.request = req;
});
test('concurrent children keep private transcripts and one child cancellation preserves its peer', { timeout: 20000 }, async () => {
  const id = session('concurrent-parent'); const ctx = contexts.createContext(id, 'workspace_write', 'concurrent-parent-run');
  const controller = new AbortController(); let alphaStarted; const alphaSecond = new Promise(r => { alphaStarted = r; });
  fetchMock = async (_url, opts) => {
    const p = JSON.parse(opts.body); const user = p.messages.find(m => m.role === 'user').content; const alpha = user.includes('alpha-private');
    assert.equal(JSON.stringify(p.messages).includes(alpha ? 'beta-private' : 'alpha-private'), false);
    if (!p.messages.some(m => m.role === 'tool')) return response([call(alpha ? 'alpha-call' : 'beta-call', alpha ? 'lsp_definition' : 'lsp_hover', { path: 'a.ts', line: 1, column: 18 })]);
    if (!alpha) return response(null, 'beta-private found the answer type.');
    alphaStarted(); return new Promise((_resolve, reject) => { const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); opts.signal.addEventListener('abort', abort, { once: true }); if (opts.signal.aborted) abort(); });
  };
  const engine = { port: 12345, modelId: 'model', contextLength: 32768, maxConcurrency: 2 };
  const a = dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'alpha-private: inspect the answer definition.', investigate: true }, { executionContext: ctx, engine, signal: controller.signal, id: 'spawn-alpha' });
  const b = dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'beta-private: inspect the answer type.', investigate: true }, { executionContext: ctx, engine, id: 'spawn-beta' });
  await alphaSecond; const beta = await b; controller.abort(); const alpha = await a;
  assert.match(beta, /beta-private/); assert.equal(alpha.success, false);
  const children = childSessions.listChildren(id); assert.equal(children.length, 2);
  for (const child of children) assert.ok(child.activity.some(a => a.type === 'tool-result' && a.ok));
  assert.equal(manager.instances.size, 1); assert.equal(manager.instances.values().next().value.state, 'ready');
  evidence.concurrentChildren = { independentTranscripts: true, peerCompletedAfterCancellation: true, sharedServers: manager.instances.size };
});
test('second workspace and cursor isolation; context projection retains structured freshness', async () => {
  const root2 = path.join(directory, 'second'); await fsp.mkdir(root2); await fsp.writeFile(path.join(root2, 'only.ts'), 'export const privateSymbol = 1;');
  const project2 = require('../src/main/projectManager').createProject({ name: 'Second', root_path: root2 });
  require('../src/main/sessionManager').getOrCreateSession('second-workspace', 'model', project2.id);
  const primary = session('cursor-owner'); const first = await dispatch(primary, 'workspace_write', 'lsp_references', { path: 'b.ts', line: 2, column: 23, page_size: 1, include_declaration: true }); assert.ok(first.nextCursor);
  assert.equal((await dispatch('second-workspace', 'full_access', 'lsp_references', { cursor: first.nextCursor })).error.code, 'LSP_INVALID_CURSOR');
  const second = await dispatch('second-workspace', 'workspace_write', 'lsp_definition', { path: 'only.ts', line: 1, column: 15 }); assert.equal(second.results[0].path, 'only.ts');
  assert.equal(manager.instances.size, 2);
  assert.equal((await dispatch(primary, 'full_access', 'lsp_hover', { path: path.join(root2, 'only.ts'), line: 1, column: 15 })).success, false);
  const projected = JSON.parse(require('../src/main/subagents/contextRecovery').trimToolResult(JSON.stringify({ ...first, state: 'stale', results: Array.from({ length: 30 }, () => ({ path: 'a.ts', message: 'x'.repeat(1000) })) }), { maxCharacters: 1200 }));
  assert.equal(projected.state, 'stale'); assert.equal(projected.nextCursor, first.nextCursor); assert.equal(projected.sourceVersion, first.sourceVersion); assert.ok(projected.contextOmittedCount > 0);
  await manager.closeRoot(root2); evidence.workspaceIsolation = true;
});
test('independently denied children hide LSP and reject forged calls under an eligible parent', async () => {
  for (const mode of ['read_only', 'ask_approval']) {
    const id = session(`denied-child-parent-${mode}`); const ctx = contexts.createContext(id, 'full_access'); let turn = 0;
    fetchMock = async (_url, opts) => {
      const p = JSON.parse(opts.body); assert.equal(p.tools.some(t => LSP_TOOL_NAMES.includes(t.function.name)), false);
      if (!turn++) return response([call('forged-lsp', 'lsp_definition', { path: 'a.ts', line: 1, column: 18 })]);
      const out = JSON.parse(p.messages.find(m => m.role === 'tool').content); assert.equal(out.error.code, 'LSP_PERMISSION_DENIED'); return response(null, 'LSP permission denied.');
    };
    const answer = await dispatch(id, 'full_access', 'spawn_sub_agent', { task: 'Review without modifying files.', investigate: true }, { executionContext: ctx, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, onChildSession: childId => contexts.setChildMode(childSessions.getSession(childId), mode) });
    assert.match(answer, /permission denied/);
  }
  const entry = manager.instances.get(root); const state = entry.state; entry.state = 'failed';
  assert.equal(toolsFor(session('unavailable-catalog'), 'workspace_write').length, 0); entry.state = state;
  const revoked = contexts.forTool(session('forgotten'), 'full_access'); contexts.forget(revoked.sessionId); assert.equal(revoked.permissionMode, 'read_only');
});
