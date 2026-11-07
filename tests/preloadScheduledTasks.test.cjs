'use strict';

// The renderer only ever sees what src/preload.js exposes through
// contextBridge. A binding attached to the wrong bridge (or omitted entirely)
// fails at runtime with "not available", long after tests pass, so this test
// pins the exact renderer-visible surface of the scheduled-task bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const preloadPath = path.join(__dirname, '..', 'src', 'preload.js');
const source = fs.readFileSync(preloadPath, 'utf8');

const exposed = new Map();
const invokes = [];
const listeners = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'electron') {
    return {
      contextBridge: {
        exposeInMainWorld: (key, value) => exposed.set(key, value),
      },
      ipcRenderer: {
        invoke: (channel, payload) => {
          invokes.push({ channel, payload });
          return Promise.resolve({ channel, payload });
        },
        send: () => {},
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          if (listeners.get(channel) === listener) listeners.delete(channel);
        },
      },
      webUtils: { getPathForFile: () => null },
    };
  }
  return originalLoad.call(this, name, ...rest);
};

try {
  require(preloadPath);
} finally {
  Module._load = originalLoad;
}

const EXPECTED = {
  list: 'scheduled-task:list',
  get: 'scheduled-task:get',
  history: 'scheduled-task:history',
  create: 'scheduled-task:create',
  update: 'scheduled-task:update',
  pause: 'scheduled-task:pause',
  resume: 'scheduled-task:resume',
  delete: 'scheduled-task:delete',
  runNow: 'scheduled-task:run-now',
  cancel: 'scheduled-task:cancel',
};

test('the scheduled-task bridge lives on window.api, where the Tasks page reads it', () => {
  assert.ok(exposed.has('api'), 'window.api is exposed');
  const api = exposed.get('api');
  assert.ok(api.scheduledTasks, 'window.api.scheduledTasks is exposed');
  assert.deepEqual(
    Object.keys(api.scheduledTasks).sort(),
    [...Object.keys(EXPECTED), 'onEvent'].sort(),
  );
});

test('every scheduled-task bridge method invokes the documented IPC channel', async () => {
  const bridge = exposed.get('api').scheduledTasks;
  for (const [method, channel] of Object.entries(EXPECTED)) {
    invokes.length = 0;
    if (method === 'update') await bridge.update('task-1', { name: 'Renamed' });
    else if (method === 'cancel') await bridge.cancel({ runId: 'run-1' });
    else await bridge[method]('task-1');
    assert.equal(invokes.length, 1, `${method} invokes exactly once`);
    assert.equal(invokes[0].channel, channel, method);
  }
  invokes.length = 0;
  await bridge.list();
  assert.deepEqual(invokes[0].payload, {}, 'list sends an empty options object by default');
  invokes.length = 0;
  await bridge.history({ taskId: 'task-1', limit: 25 });
  assert.deepEqual(invokes[0].payload, { taskId: 'task-1', limit: 25 });
  invokes.length = 0;
  await bridge.update('task-1', { name: 'Renamed' });
  assert.deepEqual(invokes[0].payload, { name: 'Renamed', id: 'task-1' }, 'update always carries the id');
});

test('onEvent subscribes to task events, opts in once and unsubscribes locally', () => {
  const bridge = exposed.get('api').scheduledTasks;
  invokes.length = 0;
  listeners.clear();
  const seen = [];
  const off = bridge.onEvent(event => seen.push(event));

  assert.ok(listeners.has('scheduled-task:event'), 'listener attached to the event channel');
  assert.deepEqual(
    invokes.map(call => call.channel),
    ['scheduled-task:subscribe'],
    'the main process is told this renderer wants events',
  );

  listeners.get('scheduled-task:event')({}, { type: 'run-updated', run: { id: 'r1' } });
  assert.deepEqual(seen, [{ type: 'run-updated', run: { id: 'r1' } }]);

  off();
  assert.equal(listeners.has('scheduled-task:event'), false, 'listener removed on unsubscribe');
});

test('a listener that throws cannot starve sibling subscribers', () => {
  const bridge = exposed.get('api').scheduledTasks;
  listeners.clear();
  const seen = [];
  const off = bridge.onEvent(() => {
    throw new Error('consumer closed');
  });
  const dispatch = listeners.get('scheduled-task:event');
  assert.doesNotThrow(() => dispatch({}, { type: 'tick' }));
  off();
  const offSecond = bridge.onEvent(event => seen.push(event));
  listeners.get('scheduled-task:event')({}, { type: 'tick' });
  assert.equal(seen.length, 1);
  offSecond();
});

test('preload never exposes the bridge twice or on chatAPI', () => {
  const occurrences = (source.match(/scheduledTasks:\s*\{/g) ?? []).length;
  assert.equal(occurrences, 1, 'exactly one scheduledTasks bridge definition');
  const chat = exposed.get('chatAPI');
  assert.equal(chat?.scheduledTasks, undefined, 'chatAPI is not the scheduled-task bridge');
});
