// Focused unit tests for the isolated terminal-log store.
// Run with: node --test tests/terminalLogStore.test.mjs
//
// The store is framework-agnostic so its batching, ordering, retention and
// subscription semantics can be tested here without a renderer. The React
// binding (useSyncExternalStore) and AppContent isolation are covered by
// tests/terminalLogIsolation.ui.cjs under the Electron harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalLogStore, TERMINAL_LOG_LIMIT } from '../src/lib/terminalLogStore.mjs';

// Deterministic scheduler: nothing flushes until the test runs it, so a burst
// can be inspected mid-flight.
function fakeScheduler() {
  const jobs = [];
  const active = () => jobs.filter(job => !job.cancelled);
  return {
    schedule: (callback, delay) => {
      const job = { callback, delay, cancelled: false };
      jobs.push(job);
      return job;
    },
    cancel: job => { if (job) job.cancelled = true; },
    run() { for (const job of jobs.splice(0)) if (!job.cancelled) job.callback(); },
    pending: () => active().length,
    delays: () => active().map(job => job.delay),
  };
}

// Mirrors the preload `terminalAPI` surface the real store consumes.
function fakeSource() {
  const output = new Set();
  const errors = new Set();
  return {
    source: {
      onOutput: callback => { output.add(callback); return () => output.delete(callback); },
      onError: callback => { errors.add(callback); return () => errors.delete(callback); },
    },
    emit: (data, stream = 'stdout') => { for (const callback of [...output]) callback({ stream, data }); },
    fail: message => { for (const callback of [...errors]) callback(message); },
    attached: () => output.size + errors.size,
  };
}

function trackNotifications(store) {
  let count = 0;
  store.subscribe(() => { count += 1; });
  return () => count;
}

test('coalesces a burst into one notification while preserving order', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });
  const notifications = trackNotifications(store);

  emit('one\n');
  emit('two\n');
  emit('three\n');

  // Batched: nothing is visible and nothing has notified until the cadence.
  assert.equal(scheduler.pending(), 1, 'a burst schedules exactly one flush');
  assert.deepEqual(store.getSnapshot(), [], 'no notification-style snapshot update before flush');
  assert.equal(notifications(), 0);

  scheduler.run();

  assert.deepEqual(store.getSnapshot().map(entry => entry.data), ['one\n', 'two\n', 'three\n']);
  assert.equal(notifications(), 1, 'one render per burst');
  assert.equal(scheduler.pending(), 0, 'no timer left running after the flush');
});

test('a later chunk schedules its own flush', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  emit('a'); scheduler.run();
  emit('b');
  assert.equal(scheduler.pending(), 1);
  scheduler.run();
  assert.deepEqual(store.getSnapshot().map(entry => entry.data), ['a', 'b']);
});

test('keeps each chunk as its own entry (a chunk is not a line)', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  emit('line one\nline two\n');
  emit('no newline yet');
  scheduler.run();

  assert.deepEqual(
    store.getSnapshot(),
    [
      { stream: 'stdout', data: 'line one\nline two\n' },
      { stream: 'stdout', data: 'no newline yet' },
    ],
  );
});

test('retains only the last 2000 entries', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  for (let index = 0; index < TERMINAL_LOG_LIMIT + 10; index += 1) emit(`chunk-${index}`);
  scheduler.run();

  const lines = store.getSnapshot();
  assert.equal(lines.length, TERMINAL_LOG_LIMIT);
  assert.equal(lines[0].data, 'chunk-10', 'oldest entries are dropped, newest retained');
  assert.equal(lines.at(-1).data, `chunk-${TERMINAL_LOG_LIMIT + 9}`);
});

test('bounded history is enforced across separate flushes', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel, limit: 3 });

  emit('a'); scheduler.run();
  emit('b'); scheduler.run();
  emit('c'); scheduler.run();
  emit('d'); scheduler.run();

  assert.deepEqual(store.getSnapshot().map(entry => entry.data), ['b', 'c', 'd']);
});

test('clear empties history and cancels pending output', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });
  const notifications = trackNotifications(store);

  emit('kept'); scheduler.run();
  emit('pending'); // not flushed yet
  store.clear();

  assert.deepEqual(store.getSnapshot(), []);
  assert.equal(scheduler.pending(), 0, 'pending flush is cancelled');
  scheduler.run();
  assert.deepEqual(store.getSnapshot(), [], 'cancelled pending chunk never lands');
  assert.equal(notifications(), 2, 'flush notification plus the clear');
});

test('clear on an empty log does not notify', () => {
  const scheduler = fakeScheduler();
  const { source } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });
  const notifications = trackNotifications(store);

  store.clear();
  assert.equal(notifications(), 0);
});

test('unsubscribing stops notifications without detaching the source', () => {
  const scheduler = fakeScheduler();
  const { source, emit, attached } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  let a = 0;
  let b = 0;
  const unsubscribeA = store.subscribe(() => { a += 1; });
  store.subscribe(() => { b += 1; });

  emit('first'); scheduler.run();
  assert.equal(a, 1);
  assert.equal(b, 1);

  unsubscribeA();
  emit('second'); scheduler.run();
  assert.equal(a, 1, 'removed listener is not called again');
  assert.equal(b, 2);
  assert.equal(store.getSnapshot().length, 2, 'source keeps collecting for other subscribers');
  assert.equal(attached(), 2, 'one output handler plus the error handler');
});

test('source is attached once even if start is re-run', () => {
  const scheduler = fakeScheduler();
  const { source, emit, attached } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  store.start();
  store.start();
  assert.equal(attached(), 2, 'no duplicate output/error handlers');

  emit('only once'); scheduler.run();
  assert.equal(store.getSnapshot().length, 1, 'no duplicated lines');
});

test('snapshot identity is stable between flushes and changes on flush', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  const before = store.getSnapshot();
  emit('x');
  assert.equal(store.getSnapshot(), before, 'unsafe snapshots would loop useSyncExternalStore');
  scheduler.run();
  const after = store.getSnapshot();
  assert.notEqual(after, before);
  assert.equal(store.getSnapshot(), after);
});

test('error messages append as stderr entries', () => {
  const scheduler = fakeScheduler();
  const { source, fail } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  fail('port in use');
  scheduler.run();

  assert.deepEqual(store.getSnapshot(), [{ stream: 'stderr', data: '[error] port in use\n' }]);
});

test('dispose detaches the source and ignores further output', () => {
  const scheduler = fakeScheduler();
  const { source, emit, attached } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });
  trackNotifications(store);

  store.dispose();
  assert.equal(attached(), 0, 'handlers are removed');
  assert.equal(scheduler.pending(), 0);

  emit('after dispose'); // no handlers left
  scheduler.run();
  assert.deepEqual(store.getSnapshot(), []);
});

test('ignores malformed entries without stalling the batch', () => {
  const scheduler = fakeScheduler();
  const { source, emit } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });

  emit('good');
  store.append(null);
  store.append({ stream: 'stdout' }); // no data
  scheduler.run();

  assert.deepEqual(store.getSnapshot().map(entry => entry.data), ['good']);
});

test('flush with nothing pending does not notify', () => {
  const scheduler = fakeScheduler();
  const { source } = fakeSource();
  const store = createTerminalLogStore({ source, schedule: scheduler.schedule, cancel: scheduler.cancel });
  const notifications = trackNotifications(store);

  store.flush();
  assert.equal(notifications(), 0);
});

test('uses the default bounded cadence', () => {
  const { source, emit } = fakeSource();
  // No schedule/cancel override: the store should fall back to a real timer.
  // Use the real clock and assert the flush actually happens.
  const store = createTerminalLogStore({ source });
  emit('timed');
  assert.deepEqual(store.getSnapshot(), []);
  return new Promise(resolve => {
    setTimeout(() => {
      assert.deepEqual(store.getSnapshot().map(entry => entry.data), ['timed']);
      store.dispose();
      resolve();
    }, 120);
  });
});
