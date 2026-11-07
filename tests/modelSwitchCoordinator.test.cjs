'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineLifecycle } = require('../src/main/engineLifecycle');
const { waitForTurnLeasesToClear, engineHasActiveLease } = require('../src/main/modelSwitchCoordinator');

function engineFixture() {
  const lifecycle = createEngineLifecycle({ generation: 'g1', modelPath: '/private/model.gguf', pid: 42, activeRequests: () => 0, emit: () => {} });
  return { lifecycle, engine: { lifecycle } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('an idle pool is clear immediately', async () => {
  const a = engineFixture();
  const outcome = await waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.waited, false);
});

test('a replacement model waits for the active turn before it may load', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  let replacementSpawned = false;

  const waiting = waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000 })
    .then(outcome => { if (outcome.ok) replacementSpawned = true; return outcome; });

  await tick();
  assert.equal(replacementSpawned, false, 'the replacement must not spawn while model A is in use');
  assert.equal(engineHasActiveLease(a.engine), true);

  lease.release();
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.waited, true);
  assert.equal(replacementSpawned, true);
});

test('waiting is bounded and reports a timeout instead of hanging', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  const outcome = await waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 15 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'timeout');
  lease.release();
});

test('a zero timeout never waits', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  const outcome = await waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'timeout');
  lease.release();
});

test('cancellation releases the wait', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  const controller = new AbortController();
  const waiting = waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cancelled');
  lease.release();
});

test('application shutdown-style cancellation releases the wait', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  const outcome = await waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000, isCancelled: () => true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cancelled');
  lease.release();
});

test('an engine exit unblocks the waiter instead of stranding it', async () => {
  const a = engineFixture();
  a.lifecycle.acquireTurnLease();
  const waiting = waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000 });
  a.lifecycle.exited(1, null);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
});

test('a cancelled wait does not spawn the replacement', async () => {
  const a = engineFixture();
  const lease = a.lifecycle.acquireTurnLease();
  const controller = new AbortController();
  let spawned = false;
  const waiting = waitForTurnLeasesToClear({ engines: () => [a.engine], timeoutMs: 1000, signal: controller.signal })
    .then(outcome => { if (outcome.ok) spawned = true; return outcome; });
  controller.abort();
  await waiting;
  assert.equal(spawned, false);
  lease.release();
});
