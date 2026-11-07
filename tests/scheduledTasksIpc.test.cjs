'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-ipc-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      Notification: { isSupported: () => false },
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: channel => handlers.delete(channel),
      },
    };
  }
  return originalLoad.call(this, name, ...rest);
};

const database = require('../src/main/db');
database.initDatabase(directory);
const store = require('../src/main/scheduledTasks');

let clock = Date.UTC(2026, 0, 10, 12);
const taskInput = () => ({
  name: 'IPC task',
  prompt: 'Summarize the day.',
  timezone: 'UTC',
  schedule: { type: 'daily', atTime: '09:00', startAt: Date.UTC(2026, 0, 1) },
  model: { kind: 'local', modelPath: 'model-a' },
  missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 },
  permissionMode: 'read_only',
});

const runEvents = [];
const scheduler = store.createScheduler({
  now: () => clock,
  tickMs: 30_000,
  launchModel: async () => ({ success: true }),
  getEngineConfig: modelPath => ({ port: 1, modelPath }),
  getEngineLifecycle: () => null,
  waitForTurnLeases: async () => ({ ok: true, waited: false }),
  prepareChatMessages: ({ userText }) => [{ role: 'user', content: userText }],
  getOrCreateSession: () => ({}),
  updateSession: () => ({}),
  runAgentTurn: async () => {
    runEvents.push('run');
    return { text: 'done', stats: { totalTokens: 3 }, message: { status: 'completed' } };
  },
  notify: () => {},
  isAppShuttingDown: () => false,
});

const trustedSender = Object.assign(new EventEmitter(), {
  destroyed: false,
  sent: [],
  isDestroyed() { return this.destroyed; },
  send(channel, value) { this.sent.push({ channel, value }); },
});
const event = { sender: trustedSender };
const invoke = (channel, payload) => handlers.get(channel)(event, payload);

const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
  isTrustedSender: incoming => incoming?.sender === trustedSender,
  getScheduledTasks: () => scheduler,
});

test.after(async () => {
  try { dispose(); } catch { /* already disposed */ }
  await scheduler.stop({ timeoutMs: 0 });
  database.closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('scheduled-task IPC exposes CRUD, history, lifecycle, manual run, and cancel', async () => {
  const created = await invoke('scheduled-task:create', taskInput());
  assert.equal(created.name, 'IPC task');
  assert.equal(created.permissionMode, 'read_only');
  assert.equal(created.nextRunAt, Date.UTC(2026, 0, 11, 9));

  const list = await invoke('scheduled-task:list', {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  const fetched = await invoke('scheduled-task:get', { id: created.id });
  assert.equal(fetched.id, created.id);

  const updated = await invoke('scheduled-task:update', { id: created.id, name: 'Renamed over IPC' });
  assert.equal(updated.name, 'Renamed over IPC');

  const paused = await invoke('scheduled-task:pause', { id: created.id });
  assert.equal(paused.enabled, false);
  const resumed = await invoke('scheduled-task:resume', { id: created.id });
  assert.equal(resumed.enabled, true);

  const manual = await invoke('scheduled-task:run-now', { id: created.id });
  assert.equal(manual.trigger, 'manual');
  await scheduler.waitForIdle();
  assert.equal(store.getRunRecord(manual.id).status, 'completed');
  assert.equal(runEvents.length, 1);

  const history = await invoke('scheduled-task:history', { taskId: created.id });
  assert.equal(history.total, 1);
  assert.equal(history.runs[0].id, manual.id);

  const queued = store.insertRunRecord({
    taskId: created.id,
    scheduledFor: Date.UTC(2026, 0, 9, 9),
    trigger: 'schedule',
    status: 'queued',
    now: clock,
  });
  const cancelled = await invoke('scheduled-task:cancel', { runId: queued.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.failureReason, /user-cancelled/);

  const deleted = await invoke('scheduled-task:delete', { id: created.id });
  assert.deepEqual(deleted, { deleted: true, id: created.id });
  await assert.rejects(invoke('scheduled-task:get', { id: created.id }), /not found/i);
  // History outlives the task definition.
  assert.equal((await invoke('scheduled-task:history', { taskId: created.id })).total, 2);
});

test('scheduled-task IPC re-validates renderer input in the main process', async () => {
  await assert.rejects(invoke('scheduled-task:create', { ...taskInput(), timezone: 'Not/AZone' }), /Invalid IANA timezone/);
  await assert.rejects(invoke('scheduled-task:create', { ...taskInput(), schedule: { type: 'daily', atTime: '25:00' } }), /HH:MM/);
  await assert.rejects(invoke('scheduled-task:create', { ...taskInput(), model: { kind: 'any-loaded' } }), /local model or a cloud/);
  await assert.rejects(invoke('scheduled-task:create', { ...taskInput(), permissionMode: 'root' }), /Permission mode/);
  await assert.rejects(invoke('scheduled-task:create', { ...taskInput(), unexpected: true }), /Unknown scheduled-task field/);
  await assert.rejects(invoke('scheduled-task:update', { id: 'missing', name: 'x' }), /not found/i);
  await assert.rejects(invoke('scheduled-task:cancel', {}), /runId or taskId/);
});

test('scheduled-task IPC subscription forwards scheduler events', async () => {
  const subscribed = await invoke('scheduled-task:subscribe');
  assert.deepEqual(subscribed, { subscribed: true });

  const task = scheduler.createTask(taskInput());
  const forwarded = trustedSender.sent.filter(item => item.channel === 'scheduled-task:event');
  assert.ok(forwarded.length >= 1);
  assert.ok(forwarded.some(item => item.value.type === 'task-created' && item.value.task.id === task.id));
});

test('scheduled-task IPC rejects untrusted senders', async () => {
  const untrusted = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: () => {},
  });
  await assert.rejects(
    handlers.get('scheduled-task:list')({ sender: untrusted }, {}),
    /Unauthorized IPC sender/,
  );
});

test('disposal detaches scheduler event forwarding and removes handlers', async () => {
  const before = trustedSender.sent.filter(item => item.channel === 'scheduled-task:event').length;
  dispose();
  scheduler.createTask({ ...taskInput(), name: 'After disposal' });
  assert.equal(
    trustedSender.sent.filter(item => item.channel === 'scheduled-task:event').length,
    before,
  );
  assert.ok(!handlers.has('scheduled-task:list'));
});
