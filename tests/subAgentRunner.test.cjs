const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-agent-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'code.js'), 'PRIVATE RAW FILE CONTENT\nfunction greet() { return "hello"; }');
fs.writeFileSync(path.join(workspace, 'binary.txt'), '\0binary');
fs.symlinkSync(root, path.join(workspace, 'escape'));
const originalLoad = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => root }, ipcMain: {
    handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key),
  } };
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => fetchMock(...params) };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const { runSubAgent, SUB_AGENT_SYSTEM_PROMPT } = require('../src/main/subAgentRunner');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const manager = require('../src/main/mcpManager');
const originalInit = manager.init;
const engine = { port: 12345, modelId: 'model', contextLength: 32768 };
const task = { task_description: 'Find the greeting function.', target_files: ['code.js'], rootPath: workspace, engine };
const summary = 'The greeting function is greet in code.js. It returns hello.\n\nUse this function as the entry point for greeting changes.';
const response = content => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
(async () => {
  let dispose;
  try {
    initDatabase(root);
    const project = require('../src/main/projectManager').createProject({ name: 'Research', root_path: workspace });
    require('../src/main/sessionManager').getOrCreateSession('chat', 'model', project.id);
    let payload;
    fetchMock = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:12345/v1/chat/completions');
      payload = JSON.parse(options.body);
      return response(summary);
    };
    assert.equal(await runSubAgent(task), summary);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].content, SUB_AGENT_SYSTEM_PROMPT);
    assert.match(payload.messages[1].content, /PRIVATE RAW FILE CONTENT/);
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 1024);
    assert.equal(payload.model, 'model');
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.tool_choice, 'none');
    for (const target_files of [['../outside'], ['escape/outside'], ['/tmp/outside'], ['binary.txt'], ['missing'], ['.'], 'code.js', [null]]) {
      await assert.rejects(runSubAgent({ ...task, target_files }));
    }
    await assert.rejects(runSubAgent({ ...task, task_description: 'x'.repeat(40000) }), /context budget/);
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'x'.repeat(40000));
    await assert.rejects(runSubAgent({ ...task, target_files: ['large.txt'] }), /context budget/);
    await assert.rejects(runSubAgent({ ...task, engine: null }), /Start the local/);
    fetchMock = async () => new Response('Do not leak this server body', { status: 500 });
    await assert.rejects(runSubAgent(task), /HTTP 500/);
    fetchMock = async () => response('');
    await assert.rejects(runSubAgent(task), /no summary/);
    fetchMock = async () => Response.json({ choices: [{ message: { tool_calls: [{}] } }] });
    await assert.rejects(runSubAgent(task), /tool call/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runSubAgent({ ...task, signal: aborted.signal }), { name: 'AbortError' });
    const controller = new AbortController();
    fetchMock = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort();
    });
    await assert.rejects(runSubAgent({ ...task, signal: controller.signal }), { name: 'AbortError' });
    fetchMock = async () => response('x'.repeat(9000));
    assert.equal((await runSubAgent(task)).length, 6020);
    const invalid = await executeAgentTool({ name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: ['../outside'] }, sessionId: 'chat', engine });
    assert.equal(invalid.success, false);

    // Exercise the real IPC and main loop, pausing the isolated response to prove order.
    manager.init = async () => {};
    let activeRequests = 0;
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
      getEngineConfig: () => ({ port: engine.port, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }),
      beginEngineRequest: () => { activeRequests++; return () => activeRequests--; },
    });
    const sender = new EventEmitter(); sender.isDestroyed = () => false;
    const events = []; sender.send = (channel, event) => events.push({ channel, ...structuredClone(event) });
    const requests = [];
    let release;
    let isolatedStarted;
    const started = new Promise(resolve => { isolatedStarted = resolve; });
    fetchMock = async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (requests.length === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'delegate1', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ task_description: task.task_description, target_files: task.target_files }) } },
      ] } }] });
      if (requests.length === 2) { isolatedStarted(); return new Promise(resolve => { release = () => resolve(response(summary)); }); }
      assert.equal(requests.length, 3);
      return response('Main agent final answer [TASK COMPLETE]');
    };
    const generation = handlers.get('engine:chat')({ sender }, { requestId: 'main', modelId: 'model', sessionId: 'chat', messages: [{ role: 'user', content: 'MAIN HISTORY SECRET' }] });
    await started;
    assert.equal(requests.length, 2);
    assert.equal(activeRequests, 1);
    assert.ok(!JSON.stringify(requests[1]).includes('MAIN HISTORY SECRET'));
    assert.ok(events.some(event => event.executionSteps?.some(step => step.toolName === 'delegate_task' && step.status === 'running')));
    await assert.rejects(handlers.get('agent:execute-tool')({ sender }, { name: 'delegate_task', arguments: {}, sessionId: 'chat' }), /active chat/);
    release();
    const result = await generation;
    assert.equal(result.text, 'Main agent final answer [TASK COMPLETE]');
    assert.equal(activeRequests, 0);
    assert.equal(requests[2].messages.at(-1).role, 'tool');
    assert.equal(requests[2].messages.at(-1).content, summary);
    assert.ok(!JSON.stringify(requests[2]).includes('PRIVATE RAW FILE CONTENT'));
    assert.equal(result.executionSteps.find(step => step.toolName === 'delegate_task').result, summary);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
    fetchMock = async () => response(summary);
    assert.equal(await handlers.get('agent:execute-tool')({ sender }, { name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: ['code.js'] }, sessionId: 'chat' }), summary);
    assert.equal(activeRequests, 0);
    console.log('Sub-agent isolation, sequential IPC execution, summary-only history, file scope, bounds, cancellation and errors passed.');
  } finally { dispose?.(); manager.init = originalInit; closeDatabase(); Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
