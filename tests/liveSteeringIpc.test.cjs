'use strict';

// Phase 2.1 — steering IPC ownership and run lifecycle.
//
// Starts a real `engine:chat` run against a deterministic fetch mock, then
// exercises the registered steering handlers. No inference call is made. The
// first model request is held open so an instruction can be submitted while the
// run is genuinely executing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-steering-ipc-'));
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

function response(content) {
  return Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}
function senderFixture() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  return sender;
}
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
};

let dispose;
test.before(() => {
  initDatabase(directory);
  sessions.getOrCreateSession('steering-ipc', 'model');
});
test.after(() => {
  dispose?.();
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('steering IPC is scoped to the owning sender and delivers at the final-answer race', async () => {
  const mcpManager = require('../src/main/mcpManager');
  mcpManager.init = async () => {};
  mcpManager.reload = async () => {};
  mcpManager.load = async () => {};
  mcpManager.getTools = () => [];
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
    isTrustedSender: () => true,
    getEngineConfig: () => ({
      port: 12345,
      modelPath: 'model',
      activeModelConfig: { contextLength: 32768 },
    }),
    beginEngineRequest: () => () => {},
  });

  let releaseFirstRequest;
  const firstRequestGate = new Promise((resolve) => { releaseFirstRequest = resolve; });
  let markFirstRequestStarted;
  const firstRequestStarted = new Promise((resolve) => { markFirstRequestStarted = resolve; });
  let requests = 0;
  fetchMock = async () => {
    requests++;
    if (requests === 1) {
      markFirstRequestStarted();
      await firstRequestGate;
      return response('Starting the run.');
    }
    return response('Completed with the steering instruction.');
  };

  const owner = senderFixture();
  const stranger = senderFixture();
  const runPromise = handlers.get('engine:chat')({ sender: owner }, {
    requestId: 'steering-ipc-run',
    modelId: 'model',
    sessionId: 'steering-ipc',
    permissionMode: 'read_only',
    messages: [{ role: 'user', content: 'Start the task.' }],
  });

  await waitFor(
    () => owner.sent.some(({ channel, value }) => channel === 'engine:stream-status' && value.status === 'generating'),
    'generating status was not emitted',
  );
  const generating = owner.sent.find(
    ({ channel, value }) => channel === 'engine:stream-status' && value.status === 'generating',
  ).value;
  assert.ok(generating.runId, 'the main process must mint a run id');
  const { runId } = generating;

  // Wait until the first request is actually in flight, so the instructions
  // below arrive after that request's payload snapshot.
  await firstRequestStarted;

  assert.deepEqual(
    await handlers.get('steering:active')({ sender: owner }, { sessionId: 'steering-ipc' }),
    { sessionId: 'steering-ipc', runId },
  );
  assert.equal(
    await handlers.get('steering:active')({ sender: stranger }, { sessionId: 'steering-ipc' }),
    null,
    'another sender cannot discover the run id',
  );

  // A stranger cannot steer even with the correct session and run ids.
  await assert.rejects(
    handlers.get('steering:submit')({ sender: stranger }, {
      sessionId: 'steering-ipc', runId, content: 'Do something else.', idempotencyKey: 'stranger-1',
    }),
    /No active run matches/i,
  );
  await assert.rejects(
    handlers.get('steering:submit')({ sender: owner }, {
      sessionId: 'some-other-session', runId, content: 'Wrong session.', idempotencyKey: 'wrong-session-1',
    }),
    /No active run matches/i,
  );
  await assert.rejects(
    handlers.get('steering:submit')({ sender: owner }, {
      sessionId: 'steering-ipc', runId: 'invented-run', content: 'Wrong run.', idempotencyKey: 'wrong-run-1',
    }),
    /No active run matches/i,
  );

  const submitted = await handlers.get('steering:submit')({ sender: owner }, {
    sessionId: 'steering-ipc', runId, content: 'Mention the caveat.', idempotencyKey: 'owner-1',
  });
  assert.equal(submitted.record.state, 'queued');
  assert.equal(submitted.duplicate, false);

  const duplicate = await handlers.get('steering:submit')({ sender: owner }, {
    sessionId: 'steering-ipc', runId, content: 'A retry must not duplicate.', idempotencyKey: 'owner-1',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, submitted.record.id);

  // A second instruction can be explicitly withdrawn while still queued.
  const second = await handlers.get('steering:submit')({ sender: owner }, {
    sessionId: 'steering-ipc', runId, content: 'Withdraw this one.', idempotencyKey: 'owner-2',
  });
  await assert.rejects(
    handlers.get('steering:cancel')({ sender: stranger }, {
      sessionId: 'steering-ipc', runId, steeringId: second.record.id,
    }),
    /No active run matches/i,
  );
  const cancelled = await handlers.get('steering:cancel')({ sender: owner }, {
    sessionId: 'steering-ipc', runId, steeringId: second.record.id,
  });
  assert.equal(cancelled.state, 'cancelled');

  const history = await handlers.get('steering:history')({ sender: owner }, { sessionId: 'steering-ipc' });
  assert.equal(history.length, 2);
  assert.equal(history.find((row) => row.id === submitted.record.id).state, 'queued');

  // Release the held response. The instruction arrived after the request
  // snapshot, so the loop must take the bounded continuation path.
  releaseFirstRequest();
  const result = await runPromise;
  await waitFor(() => requests === 2, 'the continuation request was not sent');

  assert.equal(result.runId, runId, 'the run result identifies the run that produced the reply');
  assert.equal(result.text, 'Starting the run.Completed with the steering instruction.');
  const delivered = owner.sent
    .filter(({ channel, value }) => channel === 'steering:updated' && value.id === submitted.record.id)
    .map(({ value }) => value);
  assert.ok(delivered.some((event) => event.state === 'delivered'), 'delivery must be announced');
  assert.ok(delivered.every((event) => event.state !== 'queued' || event.content === 'Mention the caveat.'));

  const finalHistory = await handlers.get('steering:history')({ sender: owner }, { sessionId: 'steering-ipc' });
  assert.equal(finalHistory.find((row) => row.id === submitted.record.id).state, 'delivered');
  assert.equal(finalHistory.find((row) => row.id === second.record.id).state, 'cancelled');

  const assistantRow = sessions.loadSession('steering-ipc').messages.at(-1);
  assert.equal(assistantRow.role, 'assistant');
  assert.equal(assistantRow.run_id, runId, 'the reply must be linked to the run for its additional prompts');

  assert.ok(
    owner.sent.some(({ channel, value }) => channel === 'engine:stream-status' && value.status === 'idle' && value.runId === runId),
    'idle status must identify the finished run',
  );
  // Once the run is gone, even the owner can no longer steer it.
  await assert.rejects(
    handlers.get('steering:submit')({ sender: owner }, {
      sessionId: 'steering-ipc', runId, content: 'Too late.', idempotencyKey: 'late-1',
    }),
    /No active run matches/i,
  );
});

// Regression: the renderer mints a session id for a tab when it opens, but
// the `sessions` row is only persisted once the first message is sent. The
// renderer asks for the steering history of that not-yet-persisted session on
// every startup, so the handler must answer with an empty history instead of
// throwing "Session not found." — which used to surface as an unhandled
// rejection in the main process at every launch.
test('steering history for a not-yet-persisted session is empty, not an error', async () => {
  const history = await handlers.get('steering:history')({ sender: senderFixture() }, {
    sessionId: 'session-that-was-never-saved',
  });
  assert.deepEqual(history, [], 'an unsaved session has no steering history');
});

// The handler still rejects a malformed session id outright, and a session
// that does exist still returns its real history.
test('steering history validates the session id and returns real rows', async () => {
  await assert.rejects(
    handlers.get('steering:history')({ sender: senderFixture() }, { sessionId: '' }),
    /Invalid session/i,
  );
  const history = await handlers.get('steering:history')({ sender: senderFixture() }, {
    sessionId: 'steering-ipc',
  });
  assert.ok(Array.isArray(history), 'history must be an array');
});
