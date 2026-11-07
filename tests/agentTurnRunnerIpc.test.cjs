'use strict';

// Proves that a scheduled-style headless turn goes through the real
// `engine:chat` pipeline and acquires/releases the same turn-level model lease
// as interactive chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-ipc-'));
const originalLoad = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      Notification: { isSupported: () => false },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
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
const { runAgentTurn } = require('../src/main/agentTurnRunner');

function response(content) {
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}

let dispose;
let lifecycle;
test.before(() => {
  initDatabase(directory);
  sessions.getOrCreateSession('scheduled-session', 'model');
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

function request(requestId) {
  return { requestId, modelId: 'model', sessionId: 'scheduled-session', permissionMode: 'read_only', messages: [{ role: 'user', content: 'Say hello.' }] };
}

test('a headless turn uses the agent pipeline and holds the lease during the request', async () => {
  let leaseHeldDuringRequest = null;
  const events = [];
  fetchMock = async () => {
    leaseHeldDuringRequest = lifecycle.hasActiveTurnLease;
    return response('hello from the scheduler');
  };
  const result = await runAgentTurn(request('scheduled-success'), { onEvent: event => events.push(event) });
  assert.equal(result.text, 'hello from the scheduler');
  assert.equal(leaseHeldDuringRequest, true);
  assert.equal(lifecycle.hasActiveTurnLease, false);
  assert.equal(events.some(event => event.channel === 'notify' && event.payload.type === 'message-created'), true);
});

test('cancelling a headless turn releases its lease and does not strand the model', async () => {
  let fetchStarted;
  const fetchStartedPromise = new Promise(resolve => { fetchStarted = resolve; });
  fetchMock = (url, options = {}) => {
    fetchStarted();
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!signal) return;
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
    });
  };
  const controller = new AbortController();
  const running = runAgentTurn(request('scheduled-cancel'), { signal: controller.signal });
  await fetchStartedPromise;
  assert.equal(lifecycle.hasActiveTurnLease, true);
  controller.abort();
  await assert.rejects(running);
  assert.equal(lifecycle.hasActiveTurnLease, false);
});

test('a failed headless turn releases its lease', async () => {
  fetchMock = async () => { throw new Error('scheduled model exploded'); };
  await assert.rejects(runAgentTurn(request('scheduled-failure')), /scheduled model exploded/);
  assert.equal(lifecycle.hasActiveTurnLease, false);
});
