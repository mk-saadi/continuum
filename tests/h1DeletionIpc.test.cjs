'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-h1-ipc-'));
const handlers = new Map(), load = Module._load;
let fetchMock;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => (new URL(args[0]).pathname === '/props' ? Promise.resolve(Response.json({ default_generation_settings: { n_ctx: 262144 } })) :
    new URL(args[0]).pathname === '/apply-template' ? Promise.resolve(Response.json({ prompt: args[1].body })) :
    new URL(args[0]).pathname === '/tokenize' ? Promise.resolve(Response.json({ tokens: Array(100).fill(0) })) : fetchMock(...args)) };
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager');
let dispose;
test.after(async () => { dispose?.(); await require('../src/main/backgroundCommands').shutdown(); await require('../src/main/mcpManager').close(); storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
test('H1 registered Delete Chat IPC cancels its actual engine request before deleting and rejects stale prepare', async () => {
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
    getEngineConfig: () => ({ port: 12345, modelPath: 'fixture', activeModelConfig: { contextLength: 32768 } }) });
  sessions.getOrCreateSession('actual-run', 'fixture');
  sessions.saveMessage('actual-run', 'user', 'fixture request');
  const mcp = require('../src/main/mcpManager'), init = mcp.init;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  mcp.init = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const sender = new EventEmitter(), foreign = new EventEmitter(), events = [];
  for (const owner of [sender, foreign]) { owner.isDestroyed = () => false; owner.send = (channel, payload) => events.push({ channel, payload }); }
  try {
    const chat = handlers.get('engine:chat')({ sender }, { requestId: 'fixture-request', modelId: 'fixture', sessionId: 'actual-run', messages: [{ role: 'user', content: 'fixture' }] });
    const stopped = assert.rejects(chat, /deletion requested|abort/i);
    await ready;
    await assert.rejects(handlers.get('session:delete')({ sender: foreign }, { sessionId: 'actual-run' }), /another session/);
    const deletion = handlers.get('session:delete')({ sender }, { sessionId: 'actual-run' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(storage.db.prepare('SELECT id FROM sessions WHERE id = ?').get('actual-run'));
    assert.equal(require('../src/main/engineManager').activeStreams.get('actual-run').signal.aborted, true);
    release(); await stopped;
    assert.deepEqual(await deletion, { deleted: true });
    assert.ok(events.some(event => event.channel === 'session:deleted' && event.payload.sessionId === 'actual-run'));
    assert.equal(require('../src/main/engineManager').activeStreams.has('actual-run'), false);
    await assert.rejects(handlers.get('session:get-or-create')({ sender }, { sessionId: 'actual-run', modelId: 'fixture' }), /deleted/);
    await assert.rejects(handlers.get('engine:chat')({ sender }, { requestId: 'stale', sessionId: 'actual-run', modelId: 'fixture', messages: [] }), /deleted/);
  } finally { mcp.init = init; release?.(); }
});

test('H1 real tool approval pending at deletion is invalidated without command execution', async () => {
  const project = require('../src/main/projectManager').createProject({ name: 'fixture approvals', root_path: directory });
  sessions.getOrCreateSession('pending-approval', 'fixture', project.id);
  sessions.saveMessage('pending-approval', 'user', 'fixture command request');
  const mcp = require('../src/main/mcpManager'), init = mcp.init;
  mcp.init = async () => {};
  let ready, approval;
  const pending = new Promise(resolve => { ready = resolve; });
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  sender.send = (channel, payload) => {
    if (channel === 'engine:request-tool-approval' && !payload.resolved) { approval = payload; ready(); }
  };
  fetchMock = async () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'fixture-command', type: 'function', function: {
    name: 'execute_command', arguments: JSON.stringify({ command: 'printf forbidden > must-not-exist' }),
  } }] }, finish_reason: 'tool_calls' }] });
  try {
    const chat = handlers.get('engine:chat')({ sender }, { requestId: 'pending-request', modelId: 'fixture', sessionId: 'pending-approval', permissionMode: 'ask_approval', messages: [{ role: 'user', content: 'fixture' }] });
    const stopped = chat.catch(error => error);
    await pending;
    assert.equal(approval.name, 'execute_command');
    await handlers.get('session:delete')({ sender }, { sessionId: 'pending-approval' });
    await stopped;
    await assert.rejects(handlers.get('engine:tool-approval-response')({ sender }, { requestId: approval.requestId, approvalId: approval.approvalId, action: 'allow' }), /no longer pending/);
    assert.equal(fs.existsSync(path.join(directory, 'must-not-exist')), false);
    assert.equal(storage.db.prepare('SELECT id FROM sessions WHERE id = ?').get('pending-approval'), undefined);
  } finally { mcp.init = init; }
});
