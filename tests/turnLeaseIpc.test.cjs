'use strict';

// Verifies that a real `engine:chat` turn takes the model lease for its whole
// duration and returns it on both success and failure, without changing the
// handler's existing streaming/result contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-lease-ipc-'));
const originalLoad = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      Notification: { isSupported: () => false },
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
    };
  }
  if (name === './localEngineFetch') {
    return { localEngineFetch: (...params) => fetchMock(...params) };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { createEngineLifecycle } = require('../src/main/engineLifecycle');

function response(content) {
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}
function senderFixture() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  return sender;
}

let dispose;
let lifecycle;
test.before(() => {
  initDatabase(directory);
  sessions.getOrCreateSession('lease-session', 'model');
  const mcp = require('../src/main/mcpManager');
  mcp.init = mcp.reload = mcp.load = async () => {};
  mcp.getTools = () => [];
});
test.beforeEach(() => {
  lifecycle = createEngineLifecycle({ generation: 'g1', modelPath: 'model', pid: 42, activeRequests: () => 0, emit: () => {} });
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
    isTrustedSender: () => true,
    getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 65536 } }),
    getEngineLifecycle: () => lifecycle,
    beginEngineRequest: () => () => {},
  });
});
test.afterEach(() => { dispose?.(); dispose = null; });
test.after(() => {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

function chat(sender, requestId) {
  return handlers.get('engine:chat')({ sender }, {
    requestId,
    modelId: 'model',
    sessionId: 'lease-session',
    permissionMode: 'read_only',
    messages: [{ role: 'user', content: 'Say hello.' }],
  });
}

test('a local chat turn holds the lease through the model request and releases it on success', async () => {
  let leaseHeldDuringRequest = null;
  fetchMock = async () => {
    leaseHeldDuringRequest = lifecycle.hasActiveTurnLease;
    return response('hello');
  };
  const sender = senderFixture();
  const result = await chat(sender, 'lease-success');
  assert.equal(leaseHeldDuringRequest, true);
  assert.equal(result.text, 'hello');
  assert.equal(lifecycle.hasActiveTurnLease, false);
  // Once the turn is over, the automatic unload path is no longer deferred.
  assert.equal(lifecycle.requestStop('idle-timeout', 'engine-idle-policy', false), true);
});

test('a failed turn also releases the lease', async () => {
  fetchMock = async () => { throw new Error('model exploded'); };
  const sender = senderFixture();
  await assert.rejects(chat(sender, 'lease-error'), /model exploded/);
  assert.equal(lifecycle.hasActiveTurnLease, false);
  assert.equal(lifecycle.requestStop('idle-timeout', 'engine-idle-policy', false), true);
});
