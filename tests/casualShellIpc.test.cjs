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
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => (new URL(args[0]).pathname === '/props' ? Promise.resolve(Response.json({ default_generation_settings: { n_ctx: 262144 } })) : new URL(args[0]).pathname === '/apply-template' ? Promise.resolve(Response.json({ prompt: args[1].body })) : new URL(args[0]).pathname === '/tokenize' ? Promise.resolve(Response.json({ tokens: Array(100).fill(0) })) : fetchMock(...args)) };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase(directory);
require('../src/main/sessionManager').getOrCreateSession('casual-shell', 'model');
test.after(async () => { dispose?.(); await require('../src/main/backgroundCommands').shutdown(); database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

const response = message => Response.json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
for (const kind of ['casual']) test(`${kind} shell prompts once and executes the same call after saving approval`, async () => {
  const sessionId = `${kind}-approval`;
  const project = kind === 'workspace' ? require('../src/main/projectManager').createProject({ name: 'Approval', root_path: workspace }) : null;
  require('../src/main/sessionManager').getOrCreateSession(sessionId, 'model', project?.id);
  dispose?.();
  const mcp = require('../src/main/mcpManager'); mcp.init = async () => {}; mcp.reload = async () => {}; mcp.load = async () => {}; mcp.getTools = () => [];
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
  const owner = new EventEmitter(); owner.isDestroyed = () => false;
  let prompts = 0;
  const outputs = [];
  owner.send = (channel, value) => {
    if (channel === 'engine:request-tool-approval' && !value.resolved) {
      prompts++;
      queueMicrotask(() => handlers.get('engine:tool-approval-response')({ sender: owner }, { requestId: value.requestId, approvalId: value.approvalId, action: 'chat' }));
    }
  };
  for (let turn = 0; turn < 2; turn++) {
    let round = 0;
    fetchMock = async (_url, request) => {
      const body = JSON.parse(request.body);
      if (round++ === 0) return response({ tool_calls: [call('activate', 'manage_native_tools', { action: 'activate', groups: ['commands'] })] });
      if (round === 2) return response({ tool_calls: [call('shell', 'execute_command', { command: 'printf CASUAL_SHELL_OK', cwd: directory })] });
      const result = body.messages.findLast(m => m.role === 'tool' && m.tool_call_id === 'shell');
      assert.ok(result, JSON.stringify(body.messages));
      const output = JSON.parse(result.content);
      assert.equal(output.success, true, JSON.stringify(output));
      assert.equal(output.exitCode, 0); assert.match(output.stdout, /CASUAL_SHELL_OK/);
      outputs.push(output);
      return response({ content: 'Command finished.' });
    };
    await handlers.get('engine:chat')({ sender: owner }, { requestId: `casual-${turn}`, modelId: 'model', sessionId, permissionMode: 'ask_approval', messages: [{ role: 'user', content: 'Run a shell command.' }] });
  }
  assert.equal(prompts, 1);
  assert.equal(outputs.length, 2, 'both turns must receive a successful shell result');
});
