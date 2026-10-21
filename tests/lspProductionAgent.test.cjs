'use strict';
// Phase 2.6A-4 — main-agent and subagent LSP execution verification.
//
// These tests drive the real native dispatcher, the real child-agent runtime
// and the real bundled language server. Model responses are deterministic
// stubs; no provider, network or paid inference is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp4-agent-'));
const root = path.join(directory, 'project');
fs.mkdirSync(root);
const handlers = new Map();
let fetchMock;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  if (name.endsWith('/localEngineFetch')) return { localEngineFetch: (...params) => fetchMock(...params) };
  if (name.endsWith('/nodeHttpFetch')) return { nodeHttpFetch: (...params) => fetchMock(...params) };
  return originalLoad.call(this, name, ...args);
};

const { db, initDatabase, closeDatabase } = require('../src/main/db');
const contexts = require('../src/main/lspExecutionContext');
const { LSP_TOOL_NAMES, lspTools } = require('../src/main/tools/lspTools');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { manager } = require('../src/main/lspManager');
const { getToolContext } = require('../src/main/promptBuilder');
const childSessions = require('../src/main/subagents/sessionManager');
const subagents = require('../src/main/subagents');

const files = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }),
  'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\n',
  'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 12 }, (_, i) => `const result${i} = answer();`).join('\n'),
};
let dispose, project;
const evidence = { main: {}, child: {}, recovered: {} };

function senderFixture() { const s = new EventEmitter(); s.sent = []; s.send = (channel, value) => s.sent.push({ channel, value }); s.isDestroyed = () => false; return s; }
function session(id) { require('../src/main/sessionManager').getOrCreateSession(id, 'model', project.id); return id; }
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, content = '') => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
function sse(calls, content = '') {
  const delta = calls ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : { content };
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const dispatch = (id, mode, name, args, extra = {}) => executeAgentTool({ sessionId: id, permissionMode: mode, name, arguments: args, ...extra });
const toolsFor = (id, mode) => getToolContext([], false, id, mode).tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name));

test.before(() => {
  initDatabase(directory);
  project = require('../src/main/projectManager').createProject({ name: 'LSP phase 4', root_path: root });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  const mcp = require('../src/main/mcpManager'); mcp.init = async () => {}; mcp.reload = async () => {}; mcp.load = async () => {}; mcp.getTools = () => [];
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
});

test.after(async () => {
  await manager.close();
  const pids = [...manager.instances.values()].map(e => e.client?.child?.pid).filter(Boolean);
  evidence.cleanShutdown = manager.instances.size === 0;
  await new Promise(r => setTimeout(r, 200));
  evidence.orphanSurvivors = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  dispose?.(); closeDatabase(); Module._load = originalLoad;
  await fsp.writeFile('/tmp/lsp4-agent-evidence.json', JSON.stringify(evidence, null, 2));
  await fsp.rm(directory, { recursive: true, force: true });
});

test('the six native tools are registered once and dispatched through the real pipeline', async () => {
  assert.equal(new Set(agentTools.map(t => t.function.name)).size, agentTools.length);
  assert.equal(lspTools.length, 6);
  const id = session('phase4-registration');
  assert.equal(toolsFor(id, 'workspace_write').length, 6);
  assert.equal(toolsFor(id, 'read_only').length, 0);
  assert.equal(toolsFor(id, 'ask_approval').length, 0);
  // The schemas stay compact and are byte-identical to the registered catalog.
  assert.equal(JSON.stringify(lspTools).length, Buffer.byteLength(JSON.stringify(lspTools)));
  assert.ok(JSON.stringify(lspTools).length < 6000);
});

test('the real main agent runs all six tools in one run and delivers every result', { timeout: 60000 }, async () => {
  const id = session('phase4-main'); const owner = senderFixture(); const payloads = []; let n = 0; let runId;
  const steps = [
    ['lsp_definition', { path: 'b.ts', line: 2, column: 23 }],
    ['lsp_references', { path: 'b.ts', line: 2, column: 23, include_declaration: true, page_size: 5 }],
    ['lsp_hover', { path: 'b.ts', line: 2, column: 23 }],
    ['lsp_document_symbols', { path: 'a.ts' }],
    ['lsp_workspace_symbols', { query: 'answer' }],
    ['lsp_diagnostics', { path: 'b.ts' }],
  ];
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body); payloads.push(payload);
    assert.equal(payload.tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name)).length, 6);
    const last = payload.messages.filter(m => m.role === 'tool').at(-1);
    if (last) {
      const out = JSON.parse(last.content);
      assert.equal(out.success, true, `${steps[n - 1][0]}: ${last.content}`);
      evidence.main[steps[n - 1][0]] = { bytes: Buffer.byteLength(last.content), state: out.state ?? null, returnedCount: out.returnedCount ?? null };
    }
    if (n === 0) {
      runId = owner.sent.find(e => e.channel === 'engine:stream-status' && e.value.status === 'generating').value.runId;
      await handlers.get('steering:submit')({ sender: owner }, { sessionId: id, runId, content: 'Keep freshness caveats explicit.', idempotencyKey: 'lsp4-steering' });
    }
    const step = steps[n++];
    return step ? sse([call(`lsp4-${n}`, step[0], step[1])]) : sse(null, 'All six LSP operations completed.');
  };
  const result = await handlers.get('engine:chat')({ sender: owner }, { requestId: 'lsp4-main', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Inspect the workspace without editing it.' }] });
  assert.match(result.text, /All six LSP operations completed/);
  assert.equal(result.runId, runId, 'the run must keep its identity across every tool call');
  assert.ok(payloads.some(p => p.messages.some(m => String(m.content).includes('Keep freshness caveats explicit.'))), 'steering must arrive at the next checkpoint');
  const transcript = require('../src/main/sessionManager').loadSession(id).messages;
  const assistant = transcript.filter(m => m.role === 'assistant').at(-1);
  const execution = assistant.execution_steps ?? assistant.executionSteps;
  const lspSteps = execution.filter(step => LSP_TOOL_NAMES.includes(step.toolName));
  assert.equal(lspSteps.length, 6);
  assert.ok(lspSteps.every(step => Number.isFinite(step.durationMs)));
  assert.ok(owner.sent.some(e => e.value.type === 'step-update' || e.channel === 'stream:step-update'));
  evidence.main.runId = result.runId;
  evidence.main.modelRequests = payloads.length;
  evidence.main.executionSteps = lspSteps.length;
  evidence.main.activityEvents = owner.sent.filter(e => e.channel === 'stream:step-update').length;
  evidence.main.persistedExecution = execution != null;
  evidence.main.steeringObserved = true;
});

test('a main-agent permission downgrade cancels the pending call and denies the rest', { timeout: 30000 }, async () => {
  const id = session('phase4-downgrade'); const owner = senderFixture(); let n = 0; let release; const gate = new Promise(r => { release = r; });
  fetchMock = async () => {
    if (!n++) { await gate; return response([call('pending-hover', 'lsp_hover', { path: 'a.ts', line: 1, column: 18 })]); }
    return response(null, 'LSP is unavailable in this mode.');
  };
  const pending = handlers.get('engine:chat')({ sender: owner }, { requestId: 'lsp4-downgrade', sessionId: id, modelId: 'model', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Inspect.' }] });
  await new Promise(r => setTimeout(r, 60));
  await handlers.get('engine:set-permission-mode')({ sender: owner }, { sessionId: id, permissionMode: 'read_only' });
  release();
  const output = await pending;
  assert.match(output.text, /unavailable/);
  assert.equal(toolsFor(id, 'workspace_write').length, 0, 'LSP must disappear from the catalog after a downgrade');
  await contexts.setMode(id, 'workspace_write');
  assert.equal(toolsFor(id, 'read_only').length, 6, 'LSP must return when the mode is upgraded again');
});

test('an authorized child receives the LSP tools and returns real results to its parent', { timeout: 60000 }, async () => {
  const id = session('phase4-child-parent'); const context = contexts.createContext(id, 'workspace_write', 'phase4-child-run');
  // The parent already uses the workspace server, so the child must reuse it.
  await dispatch(id, 'workspace_write', 'lsp_hover', { path: 'a.ts', line: 1, column: 18 }, { executionContext: context });
  const shared = [...manager.instances.values()][0];
  assert.ok(shared);
  const requests = [];
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body); requests.push(payload);
    assert.equal(payload.tools.filter(t => LSP_TOOL_NAMES.includes(t.function.name)).length, 6);
    if (requests.length === 1) return response([
      call('child-def', 'lsp_definition', { path: 'b.ts', line: 2, column: 23 }),
      call('child-ref', 'lsp_references', { path: 'b.ts', line: 2, column: 23, page_size: 3 }),
    ]);
    if (requests.length === 2) return response([call('child-diag', 'lsp_diagnostics', { path: 'b.ts' })]);
    return response(null, 'The answer function is defined in a.ts.');
  };
  const output = await dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'Find the answer definition, references and diagnostics.', investigate: true }, { executionContext: context, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, id: 'phase4-spawn' });
  assert.equal(typeof output, 'string', JSON.stringify(output));
  assert.match(output, /a\.ts/);
  const child = childSessions.listChildren(id).at(-1);
  assert.equal(child.parentSessionId, id);
  const outputs = child.context.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(outputs.length, 3);
  assert.ok(outputs.every(o => o.success), JSON.stringify(outputs));
  assert.ok(outputs[0].results.length > 0);
  assert.ok(['ready', 'stale', 'pending'].includes(outputs[2].state));
  // Activity is attributed to the child, not to the parent.
  const lspActivity = child.activity.filter(a => a.type === 'tool-result' && LSP_TOOL_NAMES.includes(a.name));
  assert.equal(lspActivity.length, 3);
  assert.ok(lspActivity.every(a => Number.isFinite(a.durationMs)));
  assert.equal([...manager.instances.values()][0], shared, 'the child must reuse the parent workspace server');
  assert.equal(manager.instances.size, 1);
  evidence.child = { childSessionId: child.id, modelRequests: requests.length, tools: lspActivity.map(a => a.name), sharedServer: true, output };
});

test('cancelling one child leaves its peer and the shared server working', { timeout: 60000 }, async () => {
  const id = session('phase4-concurrent'); const context = contexts.createContext(id, 'workspace_write', 'phase4-concurrent-run');
  const controller = new AbortController(); let alphaStarted; const alphaSecond = new Promise(r => { alphaStarted = r; });
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    const user = payload.messages.find(m => m.role === 'user').content;
    const alpha = user.includes('alpha-private');
    assert.equal(JSON.stringify(payload.messages).includes(alpha ? 'beta-private' : 'alpha-private'), false);
    if (!payload.messages.some(m => m.role === 'tool')) return response([call(alpha ? 'alpha-call' : 'beta-call', alpha ? 'lsp_definition' : 'lsp_hover', { path: 'a.ts', line: 1, column: 18 })]);
    if (!alpha) return response(null, 'beta-private found the answer type.');
    alphaStarted(); return new Promise((_resolve, reject) => { const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); opts.signal.addEventListener('abort', abort, { once: true }); if (opts.signal.aborted) abort(); });
  };
  const engine = { port: 12345, modelId: 'model', contextLength: 32768, maxConcurrency: 2 };
  const a = dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'alpha-private: inspect the answer definition.', investigate: true }, { executionContext: context, engine, signal: controller.signal, id: 'spawn-alpha' });
  const b = dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'beta-private: inspect the answer type.', investigate: true }, { executionContext: context, engine, id: 'spawn-beta' });
  await alphaSecond; const beta = await b; controller.abort(); const alpha = await a;
  assert.match(beta, /beta-private/);
  assert.equal(alpha.success, false);
  const children = childSessions.listChildren(id);
  assert.equal(children.length, 2);
  assert.ok(children.every(child => child.activity.some(a => a.type === 'tool-result' && a.ok)));
  assert.equal(manager.instances.size, 1);
  assert.equal(manager.instances.values().next().value.state, 'ready');
  evidence.child.cancelledPeerSurvived = true;
});

test('a child never inherits more than its own approved ceiling', async () => {
  const id = session('phase4-child-ceiling'); const context = contexts.createContext(id, 'full_access', 'phase4-ceiling-run');
  const child = { id: 'phase4-ceiling-child', parentSessionId: id };
  const childContext = contexts.authorizeChild(child, context);
  assert.equal(childContext.permissionMode, 'workspace_write', 'Full Access is never implicitly inherited');
  contexts.setChildMode(child, 'read_only');
  assert.equal(contexts.eligible(childContext.permissionMode), false);
  contexts.setChildMode(child, 'ask_approval');
  assert.equal(contexts.eligible(childContext.permissionMode), false);
  contexts.setChildMode(child, 'full_access');
  assert.equal(contexts.eligible(childContext.permissionMode), true);
  // A parent downgrade is an additional ceiling for the child.
  contexts.setChildMode(child, 'workspace_write');
  assert.equal(childContext.permissionMode, 'workspace_write');
  await contexts.setMode(id, 'read_only');
  assert.equal(childContext.permissionMode, 'read_only');
  const denied = await executeAgentTool({ sessionId: null, permissionMode: 'full_access', name: 'lsp_definition', arguments: { path: 'a.ts', line: 1, column: 14 }, executionContext: childContext });
  assert.equal(denied.error.code, 'LSP_PERMISSION_DENIED', 'a child of a downgraded parent must be denied');
  await contexts.setMode(id, 'full_access');
});

test('a recovered child is re-authorized at the default ceiling, never Full Access', { timeout: 60000 }, async () => {
  const id = session('phase4-recovery'); const context = contexts.createContext(id, 'workspace_write', 'phase4-recovery-run');
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    if (!payload.messages.some(m => m.role === 'tool')) return response([call('recovery-def', 'lsp_definition', { path: 'a.ts', line: 1, column: 18 })]);
    return response(null, 'Recovered child finished.');
  };
  await dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'Inspect the answer definition.', investigate: true }, { executionContext: context, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, id: 'phase4-recovery-spawn' });
  const spawned = childSessions.listChildren(id).at(-1);
  assert.ok(spawned);
  // A live child keeps its own authorization.
  assert.ok(contexts.childContext(spawned));
  // Simulate an application restart: the live record disappears, the durable
  // record does not.
  childSessions.deleteSession(spawned.id);
  assert.equal(contexts.childContext(spawned), null);
  const recovered = subagents.recoverChild(spawned.id, { parentSessionId: id, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, verifyOwner: true });
  assert.equal(recovered.recovered, true);
  const recoveredSession = childSessions.getSession(spawned.id);
  const recoveredContext = contexts.childContext(recoveredSession);
  assert.ok(recoveredContext, 'a recovered child is re-authorized by trusted runtime code');
  assert.equal(recoveredContext.permissionMode, 'workspace_write', 'recovery never restores Full Access');
  const result = await executeAgentTool({ sessionId: null, permissionMode: 'read_only', name: 'lsp_definition', arguments: { path: 'a.ts', line: 1, column: 18 }, executionContext: recoveredContext });
  assert.equal(result.success, true, 'a recovered child may use LSP again');
  evidence.recovered = { childSessionId: spawned.id, mode: recoveredContext.permissionMode, usable: true };
});

test('a recovered child of a downgraded parent stays denied', { timeout: 60000 }, async () => {
  const id = session('phase4-recovery-denied'); const context = contexts.createContext(id, 'workspace_write', 'phase4-recovery-denied-run');
  fetchMock = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    if (!payload.messages.some(m => m.role === 'tool')) return response([call('recovery-def', 'lsp_definition', { path: 'a.ts', line: 1, column: 18 })]);
    return response(null, 'Recovered child finished.');
  };
  await dispatch(id, 'workspace_write', 'spawn_sub_agent', { task: 'Inspect the answer definition.', investigate: true }, { executionContext: context, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, id: 'phase4-recovery-denied-spawn' });
  const spawned = childSessions.listChildren(id).at(-1);
  childSessions.deleteSession(spawned.id);
  // The parent is downgraded before the child is recovered.
  await contexts.setMode(id, 'read_only');
  const recovered = subagents.recoverChild(spawned.id, { parentSessionId: id, engine: { port: 12345, modelId: 'model', contextLength: 32768 }, verifyOwner: true });
  assert.equal(recovered.recovered, true);
  const recoveredSession = childSessions.getSession(spawned.id);
  const recoveredContext = contexts.childContext(recoveredSession);
  assert.equal(recoveredContext, null, 'a downgraded parent must not re-authorize a recovered child');
  const result = await executeAgentTool({ sessionId: null, permissionMode: 'full_access', name: 'lsp_definition', arguments: { path: 'a.ts', line: 1, column: 18 }, executionContext: recoveredContext });
  assert.equal(result.error.code, 'LSP_PERMISSION_DENIED');
  await contexts.setMode(id, 'workspace_write');
});

test('a child LSP result survives context compaction as valid structured JSON', async () => {
  const { trimToolResult } = require('../src/main/subagents/contextRecovery');
  const original = { success: true, untrusted: true, provenance: 'immutable-query-snapshot', state: 'stale', sourceVersion: 'sha256:abc', nextCursor: 'cursor-1', results: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, message: 'x'.repeat(400) })) };
  const projected = JSON.parse(trimToolResult(JSON.stringify(original), { maxCharacters: 1200 }));
  assert.equal(projected.state, 'stale');
  assert.equal(projected.nextCursor, 'cursor-1');
  assert.equal(projected.sourceVersion, 'sha256:abc');
  assert.equal(projected.context_trimmed, true);
  assert.ok(projected.contextOmittedCount > 0);
  assert.ok(JSON.stringify(projected).length <= 1200);
});
