'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-'));
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      Notification: { isSupported: () => false },
    };
  }
  return originalLoad.call(this, name, ...rest);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const { db } = require('../src/main/db');
const store = require('../src/main/scheduledTasks');
const { saveLoadConfig, getLoadConfig } = require('../src/main/configManager');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 0, 10, 12, 0, 0); // Sat 2026-01-10 12:00 UTC
let clock = BASE;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message = 'Condition was not met', timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(message);
}

test.before(() => { initDatabase(directory); });
test.after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });
test.beforeEach(() => {
  clock = BASE;
  db.prepare('DELETE FROM scheduled_task_runs').run();
  db.prepare('DELETE FROM scheduled_tasks').run();
  db.prepare('DELETE FROM model_load_configs').run();
});

function makeTask(overrides = {}) {
  return store.createTaskRecord({
    name: 'Daily briefing',
    prompt: 'Summarize the day.',
    timezone: 'UTC',
    schedule: { type: 'daily', atTime: '09:00', startAt: Date.UTC(2026, 0, 1) },
    model: { kind: 'local', modelPath: 'model-a' },
    missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 },
    permissionMode: 'read_only',
    ...overrides,
  }, { now: clock });
}

function setNextRun(taskId, at) {
  db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(at, taskId);
}

function makeScheduler(overrides = {}) {
  const calls = [];
  const notifications = [];
  const scheduler = store.createScheduler({
    now: () => clock,
    tickMs: 30_000,
    startupCap: 5,
    startupDeferMs: 60_000,
    modelRetryAttempts: 1,
    modelRetryDelayMs: 0,
    maxWallClockMs: 60_000,
    launchModel: async (modelPath, options) => {
      calls.push({ type: 'launch', modelPath, options });
      return { success: true };
    },
    getEngineConfig: modelPath => ({ port: 1, modelPath }),
    getEngines: () => [],
    getEngineLifecycle: () => null,
    waitForTurnLeases: async () => ({ ok: true, waited: false }),
    prepareChatMessages: ({ sessionId, modelId, userText }) => {
      calls.push({ type: 'prepare', sessionId, modelId, userText });
      return [{ role: 'user', content: userText }];
    },
    getOrCreateSession: (sessionId, modelId, projectId) => {
      calls.push({ type: 'session', sessionId, modelId, projectId });
      return { id: sessionId, model_id: modelId, project_id: projectId };
    },
    updateSession: () => ({}),
    runAgentTurn: async (request, { onEvent, signal }) => {
      calls.push({ type: 'run', request });
      return { text: 'done', stats: { totalTokens: 12 }, message: { status: 'completed' } };
    },
    notify: payload => notifications.push(payload),
    isAppShuttingDown: () => false,
    ...overrides,
  });
  return { scheduler, calls, notifications };
}

test('task validation rejects malformed renderer input and never accepts any-loaded fallback', () => {
  assert.throws(() => store.createTaskRecord({ name: '', prompt: 'x', schedule: { type: 'once', at: BASE + DAY }, model: { kind: 'local', modelPath: 'a' }, timezone: 'UTC' }), /name/);
  assert.throws(() => store.createTaskRecord({ name: 'x', prompt: 'x', schedule: { type: 'once', at: BASE + DAY }, model: { kind: 'local', modelPath: 'a' }, timezone: 'Not/AZone' }), /Invalid IANA timezone/);
  assert.throws(() => store.createTaskRecord({ name: 'x', prompt: 'x', schedule: { type: 'daily', atTime: '25:00' }, model: { kind: 'local', modelPath: 'a' }, timezone: 'UTC' }), /HH:MM/);
  assert.throws(() => store.createTaskRecord({ name: 'x', prompt: 'x', schedule: { type: 'once', at: BASE + DAY }, model: { kind: 'any-loaded' }, timezone: 'UTC' }), /local model or a cloud/);
  assert.throws(() => store.createTaskRecord({
    name: 'x', prompt: 'x', schedule: { type: 'once', at: BASE + DAY }, timezone: 'UTC',
    model: { kind: 'local', modelPath: 'a' }, fallback: [{ kind: 'any-loaded' }],
  }), /local model or a cloud/);
  assert.throws(() => store.createTaskRecord({ name: 'x', prompt: 'x', schedule: { type: 'once', at: BASE + DAY }, model: { kind: 'local', modelPath: 'a' }, timezone: 'UTC', permissionMode: 'root' }), /Permission mode/);
});

test('store CRUD, pause/resume, and history survives task deletion', () => {
  const task = makeTask({ enabled: true });
  assert.equal(task.permissionMode, 'read_only');
  assert.equal(task.enabled, true);
  assert.equal(task.nextRunAt, Date.UTC(2026, 0, 11, 9));
  assert.equal(store.listTaskRecords().length, 1);
  assert.equal(store.getTaskRecord(task.id).name, 'Daily briefing');

  const updated = store.updateTaskRecord(task.id, { name: 'Renamed', prompt: 'New prompt.' }, { now: clock });
  assert.equal(updated.task.name, 'Renamed');
  assert.equal(updated.task.prompt, 'New prompt.');

  const paused = store.setTaskEnabledRecord(task.id, false, { now: clock });
  assert.equal(paused.task.enabled, false);
  const resumed = store.setTaskEnabledRecord(task.id, true, { now: clock });
  assert.equal(resumed.task.enabled, true);

  const run = store.insertRunRecord({
    taskId: task.id, scheduledFor: Date.UTC(2026, 0, 9, 9), trigger: 'manual',
    status: 'completed', model: { kind: 'local', modelPath: 'model-a' }, now: clock,
  });
  assert.ok(run);
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
  store.deleteTaskRecord(task.id);
  assert.equal(store.getTaskRecord(task.id), null);
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
  assert.equal(store.listRunRecords({ taskId: task.id }).runs[0].id, run.id);
});

test('a due occurrence is enqueued and claimed exactly once across repeated ticks', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9)); // 3h before now
  const { scheduler } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  await scheduler.tick({ awaitDrain: true });
  const history = store.listRunRecords({ taskId: task.id });
  assert.equal(history.total, 1);
  assert.equal(history.runs[0].status, 'completed');
  assert.equal(history.runs[0].trigger, 'schedule');
  assert.equal(history.runs[0].fallbackUsed, false);
  assert.equal(store.getTaskRecord(task.id).nextRunAt, Date.UTC(2026, 0, 11, 9));
});

test('grace runs only the latest in-grace occurrence and records older slots as missed', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 7, 9)); // 3 days of occurrences
  const { scheduler } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  const runs = store.listRunRecords({ taskId: task.id }).runs.sort((a, b) => a.scheduledFor - b.scheduledFor);
  assert.deepEqual(runs.map(run => run.status), ['missed', 'missed', 'missed', 'completed']);
  assert.equal(runs.at(-1).scheduledFor, Date.UTC(2026, 0, 10, 9));
  assert.equal(store.getTaskRecord(task.id).nextRunAt, Date.UTC(2026, 0, 11, 9));
});

test('skip records missed occurrences without executing, and still advances the schedule', async () => {
  const task = makeTask({ missedPolicy: { policy: 'skip', graceHours: 24, maxOverdueDays: 7 } });
  setNextRun(task.id, Date.UTC(2026, 0, 8, 9));
  const { scheduler, calls } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  const runs = store.listRunRecords({ taskId: task.id }).runs;
  assert.equal(runs.length, 3);
  assert.ok(runs.every(run => run.status === 'missed'));
  assert.ok(!calls.some(call => call.type === 'run'));
  assert.equal(store.getTaskRecord(task.id).nextRunAt, Date.UTC(2026, 0, 11, 9));
});

test('catch_up executes every eligible occurrence sequentially', async () => {
  const task = makeTask({ missedPolicy: { policy: 'catch_up', graceHours: 24, maxOverdueDays: 7 } });
  setNextRun(task.id, Date.UTC(2026, 0, 8, 9)); // Jan 8, 9, 10 -> 3 runs
  let active = 0;
  let maxActive = 0;
  const { scheduler } = makeScheduler({
    runAgentTurn: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      return { text: 'done', message: { status: 'completed' } };
    },
  });
  await scheduler.tick({ startup: true, awaitDrain: true });
  const runs = store.listRunRecords({ taskId: task.id }).runs;
  assert.equal(runs.filter(run => run.status === 'completed').length, 3);
  assert.equal(maxActive, 1);
  assert.equal(store.getTaskRecord(task.id).nextRunAt, Date.UTC(2026, 0, 11, 9));
});

test('startup cap defers excess automatic runs without discarding them', async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => makeTask({ name: `Task ${index}` }));
  for (const task of tasks) setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  const { scheduler } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.listRunRecords({ status: 'completed' }).total, 5);
  assert.equal(store.listRunRecords({ status: 'deferred' }).total, 2);

  clock += 61_000; // one deferred window
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.listRunRecords({ status: 'completed' }).total, 7);
  assert.equal(store.listRunRecords({ status: 'deferred' }).total, 0);
});

test('model preparation completes before the turn lease is acquired and before runAgentTurn starts', async () => {
  const order = [];
  let loaded = false;
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  const lifecycle = {
    acquireTurnLease() {
      order.push('lease');
      return { release() { order.push('release'); } };
    },
  };
  const { scheduler } = makeScheduler({
    getEngineConfig: modelPath => loaded ? { port: 1, modelPath } : null,
    launchModel: async modelPath => {
      order.push(`launch:${modelPath}`);
      loaded = true;
      return { success: true };
    },
    getEngineLifecycle: () => lifecycle,
    runAgentTurn: async () => {
      order.push('run');
      return { text: 'done', message: { status: 'completed' } };
    },
    runAgentTurnOptions: undefined,
  });
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.deepEqual(order, ['launch:model-a', 'lease', 'run', 'release']);
});

test('a scheduled run waits for a freshly launched engine to become ready before starting the turn', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  const order = [];
  let status = null;
  const { scheduler } = makeScheduler({
    modelReadyPollMs: 5,
    getEngineConfig: modelPath => status === null ? null : { port: 1, modelPath, contextStatus: status },
    launchModel: async modelPath => {
      order.push(`launch:${modelPath}`);
      status = 'loading';
      return { success: true };
    },
    runAgentTurn: async () => {
      order.push('run');
      return { text: 'done', message: { status: 'completed' } };
    },
  });
  const becomesReady = setTimeout(() => { status = 'ready'; }, 10);
  await scheduler.tick({ startup: true, awaitDrain: true });
  clearTimeout(becomesReady);

  assert.deepEqual(order, ['launch:model-a', 'run'], 'the turn must wait until the engine reports ready');
  assert.equal(store.listRunRecords({ taskId: task.id }).runs[0].status, 'completed');
});

test('a scheduled run stays pending with a clear retry reason when the launched engine exits during startup', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  let status = null;
  const { scheduler, calls } = makeScheduler({
    modelReadyPollMs: 5,
    getEngineConfig: modelPath => status === null ? null : { port: 1, modelPath, contextStatus: status },
    launchModel: async () => { status = 'loading'; return { success: true }; },
  });
  const crashes = setTimeout(() => { status = null; }, 10);
  await scheduler.tick({ startup: true, awaitDrain: true });
  clearTimeout(crashes);

  const run = store.listRunRecords({ taskId: task.id }).runs[0];
  assert.equal(run.status, 'deferred');
  assert.match(run.failureReason, /exited while starting/i);
  assert.ok(!calls.some(call => call.type === 'run'), 'a dead engine must never reach the agent turn');
});

test('a scheduled run surfaces a warmup failure instead of a misleading context error', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  let status = null;
  const { scheduler, calls } = makeScheduler({
    modelReadyPollMs: 5,
    getEngineConfig: modelPath => status === null
      ? null
      : { port: 1, modelPath, contextStatus: status, warmupError: 'CUDA out of memory' },
    launchModel: async () => { status = 'loading'; return { success: true }; },
  });
  const failsWarmup = setTimeout(() => { status = 'warmup-failed'; }, 10);
  await scheduler.tick({ startup: true, awaitDrain: true });
  clearTimeout(failsWarmup);

  const run = store.listRunRecords({ taskId: task.id }).runs[0];
  assert.equal(run.status, 'deferred');
  assert.match(run.failureReason, /failed to warm up/i);
  assert.match(run.failureReason, /CUDA out of memory/);
  assert.ok(!calls.some(call => call.type === 'run'));
});

test('scheduled runs load a local model with its remembered settings and preserve them', async () => {
  saveLoadConfig('model-a', {
    contextLength: 90000,
    threads: 3,
    evalBatch: 2048,
    physicalBatch: 1024,
    parallel: 1,
  });
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  let loaded = false;
  const launches = [];
  const { scheduler } = makeScheduler({
    getEngineConfig: modelPath => loaded ? { port: 1, modelPath } : null,
    launchModel: async (modelPath, options) => {
      launches.push({ modelPath, options });
      loaded = true;
      return { success: true };
    },
    runAgentTurn: async () => ({ text: 'done', message: { status: 'completed' } }),
  });
  await scheduler.tick({ startup: true, awaitDrain: true });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.contextLength, 90000, 'the saved context length must be used');
  assert.equal(launches[0].options.threads, 3);
  assert.equal(launches[0].options.rememberSettings, undefined, 'a scheduled load must not rewrite or forget the saved settings');
  assert.equal(getLoadConfig('model-a').remembered, true, 'the saved settings must survive the run');
  assert.equal(getLoadConfig('model-a').config.contextLength, 90000);
  assert.equal(store.listRunRecords({ taskId: task.id }).runs[0].status, 'completed');
});

test('a task-level model config still overrides the remembered load settings', async () => {
  saveLoadConfig('model-a', { contextLength: 90000, threads: 3 });
  const task = makeTask({
    model: { kind: 'local', modelPath: 'model-a', config: { contextLength: 32768 } },
  });
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  let loaded = false;
  const launches = [];
  const { scheduler } = makeScheduler({
    getEngineConfig: modelPath => loaded ? { port: 1, modelPath } : null,
    launchModel: async (modelPath, options) => {
      launches.push({ modelPath, options });
      loaded = true;
      return { success: true };
    },
    runAgentTurn: async () => ({ text: 'done', message: { status: 'completed' } }),
  });
  await scheduler.tick({ startup: true, awaitDrain: true });

  assert.equal(launches[0].options.contextLength, 32768);
  assert.equal(launches[0].options.threads, 3, 'other remembered settings still apply');
  assert.equal(getLoadConfig('model-a').config.contextLength, 90000, 'the task override is not persisted');
});

test('a VRAM conflict uses only an explicitly configured fallback', async () => {
  const primary = makeTask({
    name: 'Primary model conflict',
    model: { kind: 'local', modelPath: 'model-a' },
    fallback: [{ kind: 'local', modelPath: 'model-b' }],
  });
  setNextRun(primary.id, Date.UTC(2026, 0, 10, 9));
  const { scheduler } = makeScheduler({
    getEngineConfig: modelPath => modelPath === 'model-b' ? { port: 2, modelPath } : null,
    launchModel: async modelPath => modelPath === 'model-a'
      ? { success: false, requiresConfirmation: true, assessment: { status: 'warning' } }
      : { success: true },
    runAgentTurn: async () => ({ text: 'fallback done', message: { status: 'completed' } }),
  });
  await scheduler.tick({ startup: true, awaitDrain: true });
  const run = store.listRunRecords({ taskId: primary.id }).runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.fallbackUsed, true);
  assert.equal(run.model.modelPath, 'model-b');

  // No fallback: retain the pending occurrence for retry without substituting a model.
  db.prepare('DELETE FROM scheduled_task_runs').run();
  const noFallback = makeTask({ name: 'No fallback', fallback: [] });
  setNextRun(noFallback.id, Date.UTC(2026, 0, 10, 9));
  const skipped = makeScheduler({
    getEngineConfig: () => null,
    launchModel: async () => ({ success: false, requiresConfirmation: true }),
  });
  await skipped.scheduler.tick({ startup: true, awaitDrain: true });
  const skippedRun = store.listRunRecords({ taskId: noFallback.id }).runs[0];
  assert.equal(skippedRun.status, 'deferred');
  assert.match(skippedRun.failureReason, /GPU memory/i);
});

test('an approval boundary blocks the run instead of silently denying it or reporting success', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  const { scheduler, notifications } = makeScheduler({
    runAgentTurn: async (_request, { onEvent }) => {
      onEvent({ channel: 'engine:request-tool-approval', payload: { name: 'write_file', requestId: 'r1' } });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  await scheduler.tick({ startup: true, awaitDrain: true });
  const run = store.listRunRecords({ taskId: task.id }).runs[0];
  assert.equal(run.status, 'blocked');
  assert.match(run.failureReason, /approval_required/);
  assert.ok(notifications.some(item => item.type === 'action_required'));
});

test('previous-process interrupted runs are marked interrupted and never replayed', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 11, 9));
  const orphan = store.insertRunRecord({
    taskId: task.id, scheduledFor: Date.UTC(2026, 0, 10, 9), trigger: 'schedule',
    status: 'running', startedAt: BASE - HOUR, now: BASE - HOUR,
  });
  const { scheduler, calls } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  const recovered = store.getRunRecord(orphan.id);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.failureReason, /application closed/i);
  assert.ok(!calls.some(call => call.type === 'run'));
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
});

test('pause cancels queued automatic runs but manual run-now still executes', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 11, 9));
  const queued = store.insertRunRecord({
    taskId: task.id, scheduledFor: Date.UTC(2026, 0, 10, 9), trigger: 'schedule',
    status: 'queued', now: clock,
  });
  const { scheduler } = makeScheduler();
  scheduler.pauseTask(task.id);
  assert.equal(store.getRunRecord(queued.id).status, 'cancelled');
  assert.match(store.getRunRecord(queued.id).failureReason, /task-paused/);

  const manual = scheduler.runNow(task.id);
  assert.equal(manual.trigger, 'manual');
  await scheduler.waitForIdle();
  assert.equal(store.getRunRecord(manual.id).status, 'completed');
});

test('delete cancels an active run, removes the task, and preserves run history', async () => {
  const task = makeTask();
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const { scheduler } = makeScheduler({
    runAgentTurn: async (_request, { signal }) => {
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  const run = scheduler.runNow(task.id);
  await startedPromise;
  scheduler.deleteTask(task.id);
  await waitFor(() => store.getRunRecord(run.id).status === 'cancelled');
  assert.equal(store.getTaskRecord(task.id), null);
  const history = store.listRunRecords({ taskId: task.id });
  assert.equal(history.total, 1);
  assert.equal(history.runs[0].status, 'cancelled');
  assert.match(history.runs[0].failureReason, /task-deleted/);
});

test('shutdown marks an in-flight run interrupted and prevents further execution', async () => {
  const task = makeTask();
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const { scheduler, calls } = makeScheduler({
    runAgentTurn: async (_request, { signal }) => {
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  const run = scheduler.runNow(task.id);
  await startedPromise;
  await scheduler.stop({ reason: 'app-shutdown', timeoutMs: 500 });
  assert.equal(store.getRunRecord(run.id).status, 'interrupted');
  const before = calls.filter(call => call.type === 'run').length;
  await scheduler.tick({ awaitDrain: true });
  assert.equal(calls.filter(call => call.type === 'run').length, before);
});

test('concurrent ticks cannot double-enqueue or double-execute one occurrence', async () => {
  const task = makeTask();
  setNextRun(task.id, Date.UTC(2026, 0, 10, 9));
  let runs = 0;
  const { scheduler } = makeScheduler({
    runAgentTurn: async () => {
      runs++;
      await delay(10);
      return { text: 'done', message: { status: 'completed' } };
    },
  });
  await Promise.all([
    scheduler.tick({ startup: true, awaitDrain: true }),
    scheduler.tick({ startup: true, awaitDrain: true }),
    scheduler.tick({ startup: true, awaitDrain: true }),
  ]);
  assert.equal(runs, 1);
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
});

test('completion and failure notifications use the existing notification types', async () => {
  const task = makeTask();
  const { scheduler, notifications } = makeScheduler();
  scheduler.runNow(task.id);
  await scheduler.waitForIdle();
  assert.ok(notifications.some(item => item.type === 'completion'));

  const failing = makeTask({ name: 'Failing task' });
  const failure = makeScheduler({
    runAgentTurn: async () => { throw new Error('model exploded'); },
  });
  failure.scheduler.runNow(failing.id);
  await failure.scheduler.waitForIdle();
  assert.ok(failure.notifications.some(item => item.type === 'error'));
});

test('dependency validation rejects missing predecessors, self references and cycles', () => {
  assert.throws(() => makeTask({ schedule: { type: 'after_task', taskId: 'missing' } }), /does not exist/);
  const a = makeTask();
  const b = makeTask({ schedule: { type: 'after_task', taskId: a.id } });
  assert.equal(b.nextRunAt, null);
  assert.throws(() => store.updateTaskRecord(a.id, { schedule: { type: 'after_task', taskId: a.id } }), /cycle/);
  assert.throws(() => store.updateTaskRecord(a.id, { schedule: { type: 'after_task', taskId: b.id } }), /cycle/);
});

test('dependencies wait for a long-running predecessor, then run once with optional result context', async () => {
  const a = makeTask({ schedule: { type: 'once', at: BASE + 10 * DAY } });
  const b = makeTask({ name: 'With result', schedule: { type: 'after_task', taskId: a.id, includeResult: true } });
  const c = makeTask({ name: 'Without result', schedule: { type: 'after_task', taskId: a.id, includeResult: false } });
  let release;
  let running = false;
  const { scheduler, calls } = makeScheduler({
    maxWallClockMs: HOUR,
    runAgentTurn: async () => {
      if (!running) { running = true; await new Promise(resolve => { release = resolve; }); }
      return { text: 'Parent findings', message: { status: 'completed' } };
    },
  });
  const source = store.createManualRunRecord(a.id, { now: clock });
  await scheduler.tick();
  await waitFor(() => running);
  clock += 2 * DAY;
  await scheduler.tick();
  assert.equal(store.listRunRecords({ taskId: b.id }).total, 0);
  assert.equal(store.listRunRecords({ taskId: c.id }).total, 0);
  release();
  await scheduler.waitForIdle();
  const child = store.listRunRecords({ taskId: b.id }).runs;
  assert.equal(child.length, 1);
  assert.equal(child[0].sourceRunId, source.id);
  assert.equal(child[0].status, 'completed');
  assert.equal(child[0].context.result, 'Parent findings');
  assert.equal(store.listRunRecords({ taskId: c.id }).runs[0].context, null);
  assert.ok(calls.some(call => call.type === 'prepare' && call.userText.includes('Parent findings')));
  assert.ok(calls.some(call => call.type === 'prepare' && call.userText === c.prompt));
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.listRunRecords({ taskId: b.id }).total, 1);
});

test('failed predecessor triggers a chain, but paused dependents do not accumulate triggers', async () => {
  const a = makeTask();
  const b = makeTask({ schedule: { type: 'after_task', taskId: a.id, includeResult: true } });
  const c = makeTask({ schedule: { type: 'after_task', taskId: b.id } });
  const paused = makeTask({ enabled: false, schedule: { type: 'after_task', taskId: a.id } });
  let turns = 0;
  const { scheduler } = makeScheduler({ runAgentTurn: async () => {
    if (++turns === 1) throw new Error('Parent failed');
    return { text: 'Recovered', message: { status: 'completed' } };
  } });
  store.createManualRunRecord(a.id, { now: clock });
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.listRunRecords({ taskId: a.id }).runs[0].status, 'failed');
  const child = store.listRunRecords({ taskId: b.id }).runs[0];
  assert.equal(child.context.failureReason, 'Parent failed');
  assert.equal(child.status, 'completed');
  assert.equal(store.listRunRecords({ taskId: c.id }).runs[0].status, 'completed');
  assert.equal(store.listRunRecords({ taskId: paused.id }).total, 0);
  store.setTaskEnabledRecord(paused.id, true, { now: clock });
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.listRunRecords({ taskId: paused.id }).total, 0);
});

test('interrupted and skipped predecessors do not trigger dependents', async () => {
  for (const outcome of ['interrupted', 'skipped']) {
    const a = makeTask();
    const b = makeTask({ schedule: { type: 'after_task', taskId: a.id } });
    const { scheduler } = makeScheduler(outcome === 'interrupted'
      ? { runAgentTurn: async () => ({ message: { status: 'interrupted' } }) }
      : { launchModel: async () => ({ success: false, error: 'Unavailable' }), getEngineConfig: () => null });
    store.createManualRunRecord(a.id, { now: clock });
    await scheduler.tick({ awaitDrain: true });
    assert.equal(store.listRunRecords({ taskId: b.id }).total, 0);
  }
});

test('interrupted runs retry on reopen before the next slot, including clean shutdown records', async () => {
  for (const status of ['running', 'waiting_for_model', 'waiting_for_lease', 'interrupted']) {
    const task = makeTask({ missedPolicy: 'until_next' });
    const orphan = store.insertRunRecord({ taskId: task.id, scheduledFor: BASE - 3 * HOUR, status, now: BASE - HOUR });
    const { scheduler, calls } = makeScheduler();
    await scheduler.tick({ startup: true, awaitDrain: true });
    const recovered = store.getRunRecord(orphan.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.retryCount, 1);
    assert.match(recovered.sessionId, /retry-1$/);
    assert.ok(calls.some(call => call.type === 'prepare'));
  }
});

test('at the next scheduled instant an older interrupted attempt is superseded', async () => {
  const task = makeTask({ missedPolicy: 'until_next' });
  const previousSlot = Date.UTC(2026, 0, 9, 9);
  const latestSlot = Date.UTC(2026, 0, 10, 9);
  clock = latestSlot;
  const old = store.insertRunRecord({ taskId: task.id, scheduledFor: previousSlot, status: 'interrupted', now: previousSlot });
  setNextRun(task.id, latestSlot);
  const { scheduler, calls } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.getRunRecord(old.id).status, 'interrupted');
  const runs = store.listRunRecords({ taskId: task.id }).runs;
  assert.equal(runs.filter(run => run.status === 'completed').length, 1);
  assert.equal(runs.find(run => run.status === 'completed').scheduledFor, latestSlot);
  assert.equal(calls.filter(call => call.type === 'run').length, 1);
});

test('latest-only catch-up runs just the latest slot after a long absence and one-time tasks never expire', async () => {
  const daily = makeTask({ missedPolicy: 'until_next' });
  setNextRun(daily.id, BASE - 800 * DAY);
  const once = makeTask({ missedPolicy: 'until_next', schedule: { type: 'once', at: BASE - 800 * DAY } });
  const { scheduler, calls } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.listRunRecords({ taskId: daily.id }).total, 1);
  assert.equal(store.listRunRecords({ taskId: daily.id }).runs[0].scheduledFor, BASE - 3 * HOUR);
  assert.equal(store.listRunRecords({ taskId: once.id }).runs[0].status, 'completed');
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(calls.filter(call => call.type === 'run').length, 2);
});

test('pending dependency runs survive restart and source IDs cannot be delivered twice', async () => {
  const a = makeTask();
  const b = makeTask({ schedule: { type: 'after_task', taskId: a.id } });
  const source = store.createManualRunRecord(a.id, { now: clock });
  const child = store.insertRunRecord({ taskId: b.id, scheduledFor: BASE, trigger: 'dependency', sourceRunId: source.id, now: clock });
  assert.equal(store.insertRunRecord({ taskId: b.id, scheduledFor: BASE + 1, trigger: 'dependency', sourceRunId: source.id, now: clock }), null);
  // Simulate a persisted completion plus queued dependent at process exit.
  db.prepare("UPDATE scheduled_task_runs SET status = 'completed' WHERE id = ?").run(source.id);
  const { scheduler } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.getRunRecord(child.id).status, 'completed');
  assert.equal(store.listRunRecords({ taskId: b.id }).total, 1);
});

test('existing catch-up settings migrate once to latest-only recovery and explicit skip stays intact', () => {
  const grace = makeTask({ missedPolicy: 'grace' });
  const catchup = makeTask({ missedPolicy: 'catch_up' });
  const skip = makeTask({ missedPolicy: 'skip' });
  db.prepare('DELETE FROM scheduler_migrations WHERE id = ?').run('latest-recovery-v1');
  closeDatabase();
  initDatabase(directory);
  assert.equal(store.getTaskRecord(grace.id).missedPolicy.policy, 'until_next');
  assert.equal(store.getTaskRecord(catchup.id).missedPolicy.policy, 'until_next');
  assert.equal(store.getTaskRecord(skip.id).missedPolicy.policy, 'skip');
  store.updateTaskRecord(grace.id, { missedPolicy: 'grace' }, { now: clock });
  closeDatabase();
  initDatabase(directory);
  assert.equal(store.getTaskRecord(grace.id).missedPolicy.policy, 'grace');
});

test('deleted predecessors surface missing dependencies and cancel their queued runs', async () => {
  const a = makeTask();
  const b = makeTask({ schedule: { type: 'after_task', taskId: a.id } });
  const source = store.createManualRunRecord(a.id, { now: clock });
  const child = store.insertRunRecord({ taskId: b.id, scheduledFor: BASE + 1, trigger: 'dependency', sourceRunId: source.id });
  const { scheduler } = makeScheduler();
  scheduler.deleteTask(a.id);
  assert.equal(store.getTaskRecord(b.id).predecessorMissing, true);
  assert.equal(store.getRunRecord(child.id).status, 'cancelled');
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.listRunRecords({ taskId: b.id }).runs[0].status, 'cancelled');
});

test('paused tasks do not retry interrupted runs and stale queued occurrences expire at the next slot', async () => {
  const paused = makeTask({ enabled: false, missedPolicy: 'until_next' });
  const orphan = store.insertRunRecord({ taskId: paused.id, scheduledFor: BASE - HOUR, status: 'running' });
  const due = makeTask({ missedPolicy: 'until_next' });
  const old = store.insertRunRecord({ taskId: due.id, scheduledFor: BASE - DAY - 3 * HOUR, status: 'queued' });
  const { scheduler, calls } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.getRunRecord(orphan.id).status, 'interrupted');
  assert.equal(store.getRunRecord(old.id).status, 'expired');
  assert.equal(calls.filter(call => call.type === 'run').length, 0);
});

test('an already-loaded task model waits for active work without consuming its execution budget', async () => {
  const { createEngineLifecycle } = require('../src/main/engineLifecycle');
  const { waitForTurnLeasesToClear } = require('../src/main/modelSwitchCoordinator');
  const lifecycle = createEngineLifecycle({ modelPath: 'model-a', emit: () => {} });
  const busy = lifecycle.acquireTurnLease();
  const task = makeTask();
  const timers = [];
  const { scheduler, calls } = makeScheduler({
    getEngines: () => [{ modelPath: 'model-a', childProcess: {}, lifecycle }],
    waitForTurnLeases: waitForTurnLeasesToClear,
    setTimeoutImpl: (callback, ms) => { timers.push(ms); return setTimeout(callback, ms); },
  });
  const run = store.createManualRunRecord(task.id, { now: clock });
  await scheduler.tick();
  await waitFor(() => store.getRunRecord(run.id).status === 'waiting_for_lease');
  assert.equal(calls.filter(call => call.type === 'run').length, 0);
  assert.ok(!timers.includes(60_000), 'runtime budget must not start during the lease wait');
  busy.release();
  await scheduler.waitForIdle();
  assert.equal(store.getRunRecord(run.id).status, 'completed');
  assert.ok(timers.includes(60_000), 'runtime budget starts with the agent turn');
});

test('model handoff waits for active work, unloads every different model, then loads and runs the selected model', async () => {
  const { createEngineLifecycle } = require('../src/main/engineLifecycle');
  const { waitForTurnLeasesToClear } = require('../src/main/modelSwitchCoordinator');
  const lifecycle = createEngineLifecycle({ modelPath: 'other-a', emit: () => {} });
  const busy = lifecycle.acquireTurnLease();
  const engines = new Map([
    ['other-a', { modelPath: 'other-a', childProcess: {}, lifecycle }],
    ['other-b', { modelPath: 'other-b', childProcess: {} }],
  ]);
  const order = [];
  const task = makeTask();
  const { scheduler } = makeScheduler({
    getEngines: () => engines.values(),
    getEngineConfig: id => engines.get(id) ?? null,
    waitForTurnLeases: waitForTurnLeasesToClear,
    stopEngine: async (id, reason, component, userAction) => {
      assert.equal(lifecycle.hasActiveTurnLease, false);
      assert.equal(component, 'model-loader');
      assert.equal(userAction, false);
      order.push('stop:' + id);
      engines.delete(id);
      return { success: true };
    },
    launchModel: async id => {
      assert.equal(engines.size, 0, 'different models must be gone before loading the task model');
      order.push('load:' + id);
      engines.set(id, { modelPath: id, childProcess: {}, contextStatus: 'ready' });
      return { success: true };
    },
    runAgentTurn: async () => { order.push('run'); return { text: 'done', message: { status: 'completed' } }; },
  });
  const run = store.createManualRunRecord(task.id, { now: clock });
  await scheduler.tick();
  await waitFor(() => store.getRunRecord(run.id).status === 'waiting_for_lease');
  assert.deepEqual(order, []);
  busy.release();
  await scheduler.waitForIdle();
  assert.deepEqual(order, ['stop:other-a', 'stop:other-b', 'load:model-a', 'run']);
  assert.equal(store.getRunRecord(run.id).status, 'completed');
  assert.deepEqual([...engines.keys()], ['model-a']);
});

test('a deferred unload never attempts to load the task model alongside an active model', async () => {
  const task = makeTask();
  let launches = 0;
  const { scheduler } = makeScheduler({
    getEngineConfig: id => id === 'other' ? { modelPath: id } : null,
    getEngines: () => [{ modelPath: 'other', childProcess: {} }],
    stopEngine: async () => ({ success: true, deferred: true }),
    launchModel: async () => { launches++; return { success: true }; },
  });
  const run = store.createManualRunRecord(task.id, { now: clock });
  await scheduler.tick({ awaitDrain: true });
  assert.equal(launches, 0);
  assert.equal(store.getRunRecord(run.id).status, 'deferred');
});

test('model startup failure retries the same occurrence on a later tick and only then triggers dependents', async () => {
  const task = makeTask({ missedPolicy: 'until_next' });
  const dependent = makeTask({ schedule: { type: 'after_task', taskId: task.id } });
  let available = false;
  const { scheduler, calls } = makeScheduler({
    getEngineConfig: id => available ? { modelPath: id, contextStatus: 'ready' } : null,
    launchModel: async () => ({ success: true }),
  });
  setNextRun(task.id, BASE - 3 * HOUR);
  await scheduler.tick({ startup: true, awaitDrain: true });
  const first = store.listRunRecords({ taskId: task.id }).runs[0];
  assert.equal(first.status, 'deferred');
  assert.match(first.failureReason, /retry.*exited while starting/i);
  assert.equal(store.listRunRecords({ taskId: dependent.id }).total, 0);
  available = true;
  clock += 2 * MINUTE;
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.getRunRecord(first.id).status, 'completed');
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
  assert.equal(store.listRunRecords({ taskId: dependent.id }).runs[0].status, 'completed');
  assert.equal(calls.filter(call => call.type === 'run').length, 2);
});

test('older model-startup skips recover on restart before the next occurrence', async () => {
  const task = makeTask({ missedPolicy: 'until_next' });
  const old = store.insertRunRecord({ taskId: task.id, scheduledFor: BASE - 3 * HOUR,
    status: 'skipped', failureReason: 'The local engine exited while starting.' });
  const { scheduler } = makeScheduler();
  await scheduler.tick({ startup: true, awaitDrain: true });
  assert.equal(store.getRunRecord(old.id).status, 'completed');
  assert.equal(store.listRunRecords({ taskId: task.id }).total, 1);
});

test('pausing an automatic task cancels its model wait without unloading active work', async () => {
  const { createEngineLifecycle } = require('../src/main/engineLifecycle');
  const { waitForTurnLeasesToClear } = require('../src/main/modelSwitchCoordinator');
  const lifecycle = createEngineLifecycle({ modelPath: 'other', emit: () => {} });
  const busy = lifecycle.acquireTurnLease();
  const task = makeTask();
  setNextRun(task.id, BASE - 3 * HOUR);
  const { scheduler, calls } = makeScheduler({
    getEngines: () => [{ modelPath: 'other', childProcess: {}, lifecycle }],
    waitForTurnLeases: waitForTurnLeasesToClear,
  });
  await scheduler.tick();
  await waitFor(() => store.listRunRecords({ taskId: task.id }).runs[0]?.status === 'waiting_for_lease');
  scheduler.pauseTask(task.id);
  await scheduler.waitForIdle();
  assert.equal(store.listRunRecords({ taskId: task.id }).runs[0].status, 'cancelled');
  assert.ok(!calls.some(call => call.type === 'run' || call.type === 'launch'));
  assert.equal(lifecycle.hasActiveTurnLease, true);
  busy.release();
});

test('an unload error leaves preparation pending and never triggers a dependent', async () => {
  const task = makeTask();
  const child = makeTask({ schedule: { type: 'after_task', taskId: task.id } });
  const { scheduler } = makeScheduler({
    getEngines: () => [{ modelPath: 'other', childProcess: {} }],
    getEngineConfig: () => null,
    stopEngine: async () => { throw new Error('Cannot unload yet'); },
  });
  const run = store.createManualRunRecord(task.id, { now: clock });
  await scheduler.tick({ awaitDrain: true });
  assert.equal(store.getRunRecord(run.id).status, 'deferred');
  assert.match(store.getRunRecord(run.id).failureReason, /Cannot unload yet/);
  assert.equal(store.listRunRecords({ taskId: child.id }).total, 0);
});
