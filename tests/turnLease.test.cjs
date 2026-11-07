'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineLifecycle } = require('../src/main/engineLifecycle');
const { createIdleService } = require('../src/main/engineManager');

function lifecycleFixture() {
  const records = [];
  const lifecycle = createEngineLifecycle({
    generation: 'g1',
    modelPath: '/private/model.gguf',
    pid: 42,
    activeRequests: () => 0,
    emit: record => records.push(record),
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { lifecycle, records };
}

test('a turn lease can be acquired and released idempotently', () => {
  const { lifecycle } = lifecycleFixture();
  assert.equal(lifecycle.hasActiveTurnLease, false);
  const lease = lifecycle.acquireTurnLease();
  assert.equal(lifecycle.hasActiveTurnLease, true);
  assert.equal(lease.active, true);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(lease.active, false);
  assert.equal(lifecycle.hasActiveTurnLease, false);
});

test('nested turn leases keep the model protected until the outer turn ends', () => {
  const { lifecycle } = lifecycleFixture();
  const outer = lifecycle.acquireTurnLease();
  const inner = lifecycle.acquireTurnLease();
  inner.release();
  assert.equal(lifecycle.hasActiveTurnLease, true);
  outer.release();
  assert.equal(lifecycle.hasActiveTurnLease, false);
});

test('automatic unload and model switch are deferred while a turn holds the lease', () => {
  const { lifecycle, records } = lifecycleFixture();
  const lease = lifecycle.acquireTurnLease();
  assert.equal(lifecycle.requestStop('idle-timeout', 'engine-idle-policy', false), false);
  assert.equal(lifecycle.requestStop('model-switch', 'model-loader', true), false);
  assert.equal(lifecycle.stopping, false);
  assert.equal(records.at(-1).event, 'stop-deferred-by-turn-lease');
  lease.release();
  assert.equal(lifecycle.requestStop('idle-timeout', 'engine-idle-policy', false), true);
  assert.equal(lifecycle.stopping, true);
});

test('explicit user unload and app shutdown are never blocked by a turn lease', () => {
  const { lifecycle } = lifecycleFixture();
  const lease = lifecycle.acquireTurnLease();
  assert.equal(lifecycle.requestStop('user-unload', 'model-controls', true), true);
  lease.release();

  const next = lifecycleFixture();
  const lease2 = next.lifecycle.acquireTurnLease();
  assert.equal(next.lifecycle.requestStop('app-shutdown', 'electron-app', false), true);
  lease2.release();
});

test('the idle service stays armed but does not fire while a turn lease is active', () => {
  let timer = null;
  let unloaded = 0;
  const { lifecycle } = lifecycleFixture();
  const idle = createIdleService({
    onIdle: () => unloaded++,
    getIdleMinutes: () => 5,
    setTimer(callback, delay) { timer = { callback, delay }; return timer; },
    clearTimer() { timer = null; },
    hasActiveTurnLease: () => lifecycle.hasActiveTurnLease,
  });

  const lease = lifecycle.acquireTurnLease();
  idle.resetIdleTimer(5);
  assert.equal(timer, null, 'no idle timer may run while the model is in use');

  lease.release();
  idle.resetIdleTimer(5);
  assert.equal(timer.delay, 300000);
  timer.callback();
  assert.equal(unloaded, 1);
  idle.dispose();
});

test('a waiting task resolves as soon as the turn releases its lease', async () => {
  const { lifecycle } = lifecycleFixture();
  const lease = lifecycle.acquireTurnLease();
  let resolved = null;
  const waiting = lifecycle.waitForTurnLeaseRelease({ timeoutMs: 1000 }).then(outcome => { resolved = outcome; });
  assert.equal(resolved, null);
  lease.release();
  await waiting;
  assert.equal(resolved.released, true);
  assert.equal(resolved.timedOut, false);
  assert.equal(resolved.aborted, false);
});

test('waiting on an idle engine resolves immediately', async () => {
  const { lifecycle } = lifecycleFixture();
  const outcome = await lifecycle.waitForTurnLeaseRelease();
  assert.equal(outcome.released, true);
});

test('a waiter is bounded by its timeout and by cancellation', async () => {
  const { lifecycle } = lifecycleFixture();
  const lease = lifecycle.acquireTurnLease();

  const timedOut = await lifecycle.waitForTurnLeaseRelease({ timeoutMs: 5 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.released, false);

  const controller = new AbortController();
  const aborted = lifecycle.waitForTurnLeaseRelease({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  const abortedOutcome = await aborted;
  assert.equal(abortedOutcome.aborted, true);
  assert.equal(abortedOutcome.released, false);

  lease.release();
});

test('an engine exit releases waiters instead of stranding them', async () => {
  const { lifecycle } = lifecycleFixture();
  lifecycle.acquireTurnLease();
  const waiting = lifecycle.waitForTurnLeaseRelease({ timeoutMs: 1000 });
  lifecycle.exited(1, null);
  const outcome = await waiting;
  assert.equal(outcome.terminated, true);
  assert.equal(outcome.released, false);
});

test('a lease acquired in a try block is released on error and cancellation', async () => {
  const { lifecycle } = lifecycleFixture();

  await assert.rejects(async () => {
    const lease = lifecycle.acquireTurnLease();
    try {
      throw new Error('turn failed');
    } finally {
      lease.release();
    }
  }, /turn failed/);
  assert.equal(lifecycle.hasActiveTurnLease, false);

  const controller = new AbortController();
  await assert.rejects(async () => {
    const lease = lifecycle.acquireTurnLease();
    try {
      controller.abort();
      controller.signal.throwIfAborted();
    } finally {
      lease.release();
    }
  });
  assert.equal(lifecycle.hasActiveTurnLease, false);
});
