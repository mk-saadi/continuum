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
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => root }, Notification: { isSupported: () => false }, ipcMain: {
    handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key),
  } };
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => fetchMock(...params) };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const { runSubAgent, SUB_AGENT_SYSTEM_PROMPT, resolveSubAgentPath, resolveTargetFiles, targetFileBudget } = require('../src/main/subAgentRunner');
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
    fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE PROJECT CONTENT');
    for (const file of ['../outside.txt', 'escape/outside.txt', path.join(root, 'outside.txt')]) {
      assert.equal(await runSubAgent({ ...task, target_files: [file] }), summary);
      assert.match(payload.messages[1].content, /OUTSIDE PROJECT CONTENT/);
    }
    assert.equal(resolveSubAgentPath('../outside.txt', workspace), path.join(root, 'outside.txt'));
    assert.equal(resolveSubAgentPath('C:\\Users\\Alice\\notes.txt', workspace), 'C:\\Users\\Alice\\notes.txt');
    for (const file of ['missing', path.join(root, 'missing.txt')]) {
      await assert.rejects(runSubAgent({ ...task, target_files: [file] }), /FILE_NOT_FOUND: The file at/);
    }
    fs.mkdirSync(path.join(workspace, 'source', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'source', 'nested', 'feature.js'), 'NESTED SOURCE CONTENT');
    for (const excluded of ['node_modules', '.git', 'dist']) {
      fs.mkdirSync(path.join(workspace, 'source', excluded));
      fs.writeFileSync(path.join(workspace, 'source', excluded, 'ignored.js'), 'EXCLUDED CONTENT');
    }
    assert.deepEqual((await resolveTargetFiles(['source'], workspace)).map(file => file.targetPath), ['source/nested/feature.js']);
    assert.equal(await runSubAgent({ ...task, target_files: ['source'] }), summary);
    assert.match(payload.messages[1].content, /NESTED SOURCE CONTENT/);
    assert.doesNotMatch(payload.messages[1].content, /EXCLUDED CONTENT/);
for (const target_files of [['binary.txt'], 'code.js', [null]]) await assert.rejects(runSubAgent({ ...task, target_files }));
    // Task descriptions may not soak the file-text reserve; oversized ones are rejected.
    await assert.rejects(runSubAgent({ ...task, task_description: 'x'.repeat(40000) }), /context budget/);
    // A single oversized file is truncated, not rejected, and the batch still completes.
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'L'.repeat(200000));
    assert.equal(await runSubAgent({ ...task, target_files: ['large.txt'] }), summary);
assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.ok(!payload.messages[1].content.includes('L'.repeat(targetFileBudget(engine.contextLength) + 1)));
// Truncation is per file: the overflowing file yields to a later small one.
    const perFileBudget = targetFileBudget(engine.contextLength);
    fs.writeFileSync(path.join(workspace, 'part-a.txt'), 'a'.repeat(perFileBudget));
    fs.writeFileSync(path.join(workspace, 'part-b.txt'), 'b'.repeat(100));
    assert.equal(await runSubAgent({ ...task, target_files: ['part-b.txt', 'part-a.txt'] }), summary);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.match(payload.messages[1].content, /\[FILE: part-b\.txt\]\nb{100}\n\[END FILE\]/);
// The aggregate character budget is respected, and the payload fills it closely.
    const injected = [...payload.messages[1].content.matchAll(/\[FILE: [^\]]+\]\n([\s\S]*?)\n\[END FILE\]/g)]
      .map(match => match[1]).join('').length;
    assert.ok(injected <= targetFileBudget(engine.contextLength),
      `injected ${injected} exceeds budget ${targetFileBudget(engine.contextLength)}`);
    assert.ok(injected > targetFileBudget(engine.contextLength) - 4096);
    // A small-context model gets a proportionally smaller payload, so prefill cannot overflow.
    fetchMock = async (_url, options) => { payload = JSON.parse(options.body); return response(summary); };
    fs.writeFileSync(path.join(workspace, 'wide.txt'), 'w'.repeat(120000));
    assert.equal(await runSubAgent({ ...task, target_files: ['wide.txt'], engine: { ...engine, contextLength: 8192 } }), summary);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    const smallWindow = [...payload.messages[1].content.matchAll(/\[FILE: [^\]]+\]\n([\s\S]*?)\n\[END FILE\]/g)]
      .map(match => match[1]).join('').length;
    assert.ok(smallWindow <= targetFileBudget(8192));
    assert.ok(smallWindow < injected, 'smaller context must yield a smaller payload');
// An unknown context window falls back to the safe default rather than assuming a large one.
    const fallbackBudget = targetFileBudget(undefined);
    fs.writeFileSync(path.join(workspace, 'mid.txt'), 'm'.repeat(fallbackBudget + 5000));
    assert.equal(await runSubAgent({ ...task, target_files: ['mid.txt'], engine: { ...engine, contextLength: undefined } }), summary);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    const fallbackInjected = [...payload.messages[1].content.matchAll(/\[FILE: [^\]]+\]\n([\s\S]*?)\n\[END FILE\]/g)]
      .map(match => match[1]).join('').length;
    assert.ok(fallbackInjected <= fallbackBudget);
    assert.equal(targetFileBudget(undefined), 64000);
    // Budget derivation is clamped at both ends.
    assert.equal(targetFileBudget(null), 64000);
    assert.equal(targetFileBudget(0), 64000);
    assert.equal(targetFileBudget(2048), 8000);
assert.equal(targetFileBudget(8192), 22268);
    assert.equal(targetFileBudget(1048576), 128000);
    // A 3-byte character truncated mid-sequence must not corrupt the decode.
    fs.writeFileSync(path.join(workspace, 'widechar.txt'), '\u65e5'.repeat(60000));
    assert.equal(await runSubAgent({ ...task, target_files: ['widechar.txt'] }), summary);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.doesNotMatch(payload.messages[1].content, /\uFFFD/);
    await assert.rejects(runSubAgent({ ...task, engine: null }), /Start the local/);
    fetchMock = async () => new Response('Do not leak this server body', { status: 500 });
    await assert.rejects(runSubAgent(task), /HTTP 500/);
    fetchMock = async () => response('');
    await assert.rejects(runSubAgent(task), /no output tokens/);
    fetchMock = async () => response('  ## Findings\nRaw assistant answer  ');
    assert.equal(await runSubAgent(task), '## Findings\nRaw assistant answer');
    fetchMock = async () => Response.json({ choices: [{ message: { content: '  ' }, text: '  Alternate answer  ' }] });
    assert.equal(await runSubAgent(task), 'Alternate answer');
    fetchMock = async () => Response.json({ choices: [{ message: { content: '' } }], usage: { completion_tokens: 3 } });
    assert.equal(await runSubAgent(task), 'Sub-agent generated tokens but returned no visible answer.');
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
    const invalid = await executeAgentTool({ name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: ['../missing'] }, sessionId: 'chat', engine });
    assert.equal(invalid.success, false);
    assert.match(invalid.error, /FILE_NOT_FOUND/);
    fetchMock = async (_url, options) => { payload = JSON.parse(options.body); return response(summary); };
    assert.equal(await executeAgentTool({ name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: [path.join(root, 'outside.txt')] }, sessionId: 'chat', engine }), summary);
    assert.equal(await executeAgentTool({ name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: [path.join(root, 'outside.txt')] }, sessionId: 'casual', permissionMode: 'read_only', engine }), summary);
    for (const sessionId of ['chat', 'casual']) {
      const rejected = await executeAgentTool({ name: 'spawn_sub_agent', arguments: { task: 'Inspect the external file',
        target_files: [path.join(root, 'outside.txt')] }, sessionId, permissionMode: 'read_only', engine });
      assert.equal(rejected.success, false);
      assert.match(rejected.error, /Do NOT use sub-agents for file inspection/);
    }
    const missingPath = path.join(root, 'missing.txt');
    const missing = await executeAgentTool({ name: 'spawn_sub_agent', arguments: { task: 'Inspect the missing file',
      target_files: [missingPath] }, sessionId: 'casual', permissionMode: 'read_only', engine });
    assert.match(missing.error, /Do NOT use sub-agents for file inspection/);

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
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
    fetchMock = async () => response(summary);
    assert.equal(await handlers.get('agent:execute-tool')({ sender }, { name: 'delegate_task', arguments: { task_description: 'Analyze', target_files: ['code.js'] }, sessionId: 'chat' }), summary);
    assert.equal(activeRequests, 0);
    console.log('Sub-agent isolation, sequential IPC execution, summary-only history, file scope, dynamic context-scaled budgets, truncate-and-continue, cancellation and errors passed.');
  } finally { dispose?.(); manager.init = originalInit; closeDatabase(); Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
