'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'background-ipc-'));
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const handlers = new Map(); const originalLoad = Module._load; let fetchMock, dispose;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => fetchMock(...args) };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase(directory);
const project = require('../src/main/projectManager').createProject({ name: 'IPC background', root_path: workspace });
require('../src/main/sessionManager').getOrCreateSession('background-ipc', 'model', project.id);
const sandboxAvailable = process.platform === 'linux' && require('node:child_process').spawnSync('bwrap', ['--ro-bind','/','/','--unshare-user','--unshare-pid','--unshare-net','--proc','/proc','/bin/sh','-c','true']).status === 0;
test.after(async () => { dispose?.(); await require('../src/main/backgroundCommands').shutdown(); database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });
test('engine:chat owns real background command, pushes Activity and delivers same-run completion without polling', { skip: !sandboxAvailable ? 'Linux bwrap namespaces unavailable on host' : false }, async () => {
  const mcp = require('../src/main/mcpManager'); mcp.init = async () => {}; mcp.reload = async () => {}; mcp.load = async () => {}; mcp.getTools = () => [];
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
  const owner = new EventEmitter(); owner.isDestroyed = () => false; owner.sent = []; owner.send = (channel, value) => { owner.sent.push({ channel, value }); if (channel === 'engine:request-tool-approval' && !value.resolved) queueMicrotask(() => handlers.get('engine:tool-approval-response')({ sender: owner }, { requestId: value.requestId, approvalId: value.approvalId, action: 'allow' })); };
  let requests = 0, commandId, usefulBeforeCompletion = false, notified = false;
  const response = message => Response.json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let completedResolve;
  const completed = new Promise(resolve => { completedResolve = resolve; });
  const manager = require('../src/main/backgroundCommands');
  const completion = record => { if (record.session_id === 'background-ipc' && !['starting', 'running'].includes(record.status)) completedResolve(record); };
  manager.events.on('change', completion);
  fetchMock = async (_url, request) => {
    const body = JSON.parse(request.body); const index = requests++ - 1;
    if (index === -1) return response({ tool_calls: [call('activate', 'manage_native_tools', { action: 'activate', groups: ['commands', 'files'] })] });
    if (index === 0) return response({ tool_calls: [call('background-start', 'execute_command', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>require('fs').writeSync(1,'IPC_BUILD_OK'),700)")}`, background: true })] });
    if (index === 1) {
      const immediate = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'background-start'); assert.ok(immediate);
      const toolResult = JSON.parse(immediate.content); commandId = toolResult.command_id; assert.ok(commandId); assert.equal(toolResult.exitCode, null);
      const records = manager.list('background-ipc', workspace); assert.ok(['starting', 'running'].includes(records[0].status)); usefulBeforeCompletion = true;
      const runId = owner.sent.find(event => event.channel === 'engine:stream-status' && event.value.status === 'generating').value.runId;
      await handlers.get('steering:submit')({ sender: owner }, { sessionId: 'background-ipc', runId, content: 'Preserve the plan', idempotencyKey: 'ipc-steer' });
      return response({ tool_calls: [call('inspect', 'list_directory', { path: '.' })] });
    }
    if (index === 2) {
      assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'inspect'));
      assert.ok(body.messages.some(m => String(m.content).includes('Preserve the plan')));
      await completed;
      return response({ content: 'Build status arrived while generating this response.' });
    }
    assert.equal(index, 3);
    assert.ok(body.messages.some(m => String(m.content).includes('Runtime background command events') && String(m.content).includes(commandId)));
    notified = true;
    return response({ content: 'Build completed in the original run.' });
  };
  try {
    const result = await handlers.get('engine:chat')({ sender: owner }, { requestId: 'background-ipc-request', modelId: 'model', sessionId: 'background-ipc', permissionMode: 'workspace_write', messages: [{ role: 'user', content: 'Build while inspecting.' }] });
    assert.ok(usefulBeforeCompletion); assert.ok(notified); assert.equal(requests, 5);
    const history = await handlers.get('session:get-background-commands')({ sender: owner }, { sessionId: 'background-ipc' });
    assert.equal(history.length, 1); assert.equal(history[0].run_id, result.runId); assert.equal(history[0].notification_state, 'delivered'); assert.equal(history[0].exitCode, 0); assert.match(history[0].stdout, /IPC_BUILD_OK/);
    assert.ok(owner.sent.some(event => event.channel === 'session:background-command' && event.value.record.notification_state === 'delivered'));
    assert.equal(result.executionSteps.find(step => step.result?.command_id === commandId).result.exitCode, 0);
  } finally { manager.events.removeListener('change', completion); }
});
