'use strict';

// Phase 2.1 — run-scoped live steering persistence and lifecycle.
//
// These tests exercise the real SQLite schema and the queue module without any
// inference call. They cover ordering, idempotency, the claimed/delivered/
// undelivered transitions, explicit withdrawal, run finalization, startup
// recovery of a crash window, and per-session isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-steering-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return { app: { isReady: () => true, getPath: () => directory } };
  }
  return originalLoad.call(this, name, ...args);
};

const { db, initDatabase, closeDatabase } = require('../src/main/db');
const steering = require('../src/main/runSteering');

initDatabase(directory);
db.prepare("INSERT INTO sessions(id) VALUES ('session-a')").run();
db.prepare("INSERT INTO sessions(id) VALUES ('session-b')").run();

function submit(overrides = {}) {
  return steering.submitSteering({
    sessionId: 'session-a',
    runId: 'run-a',
    content: 'Focus on the failing tests first.',
    idempotencyKey: require('node:crypto').randomUUID(),
    ...overrides,
  }).record;
}

test.after(() => {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a submission starts queued and duplicate idempotency keys are deduplicated', () => {
  const first = submit({ idempotencyKey: 'idem-1' });
  assert.equal(first.state, 'queued');
  assert.equal(first.sessionId, 'session-a');
  assert.equal(first.runId, 'run-a');
  assert.equal(first.content, 'Focus on the failing tests first.');

  const duplicate = steering.submitSteering({
    sessionId: 'session-a',
    runId: 'run-a',
    content: 'Different text that must not replace the original.',
    idempotencyKey: 'idem-1',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, first.id);
  assert.equal(duplicate.record.content, first.content);
  assert.equal(steering.getRunSteering('session-a', 'run-a').length, 1);
  steering.finalizeRun({ sessionId: 'session-a', runId: 'run-a' });
});

test('claims are ordered, scoped to one run, and delivered only after confirmation', () => {
  const one = submit({ runId: 'run-order', idempotencyKey: 'order-1', content: 'First' });
  const two = submit({ runId: 'run-order', idempotencyKey: 'order-2', content: 'Second' });
  submit({ runId: 'other-run', idempotencyKey: 'order-other', content: 'Elsewhere' });

  const claimed = steering.takeSteering({
    sessionId: 'session-a', runId: 'run-order', requestId: 'request-1',
  });
  assert.deepEqual(claimed.map((row) => row.content), ['First', 'Second']);
  assert.ok(claimed.every((row) => row.state === 'claimed'));
  assert.ok(claimed.every((row) => row.deliveryRequestId === 'request-1'));

  // A second claim at the same boundary cannot consume the same rows.
  assert.deepEqual(
    steering.takeSteering({ sessionId: 'session-a', runId: 'run-order', requestId: 'request-2' }),
    [],
  );

  const delivered = steering.markDelivered({
    sessionId: 'session-a', runId: 'run-order', ids: claimed.map((row) => row.id),
    requestId: 'request-1',
  });
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((row) => row.state === 'delivered' && row.deliveredAt));
  assert.equal(steering.getRunSteering('session-a', 'other-run')[0].state, 'queued');
  steering.finalizeRun({ sessionId: 'session-a', runId: 'other-run' });
});

test('a failed request marks claimed rows undelivered with a reason', () => {
  const row = submit({ runId: 'run-fail', idempotencyKey: 'fail-1' });
  steering.takeSteering({ sessionId: 'session-a', runId: 'run-fail', requestId: 'request-fail' });
  const [failed] = steering.markUndelivered({
    sessionId: 'session-a', runId: 'run-fail', ids: [row.id],
    reason: 'Transport refused the request.',
  });
  assert.equal(failed.state, 'undelivered');
  assert.equal(failed.failureReason, 'Transport refused the request.');
  assert.equal(failed.deliveredAt, null);
});

test('finalize reports every queued and claimed row without claiming delivery', () => {
  const claimed = submit({ runId: 'run-end', idempotencyKey: 'end-1' });
  steering.takeSteering({ sessionId: 'session-a', runId: 'run-end', requestId: 'request-end' });
  const queued = submit({ runId: 'run-end', idempotencyKey: 'end-2' });

  const closed = steering.finalizeRun({
    sessionId: 'session-a', runId: 'run-end', reason: 'The user stopped the run.',
  });
  assert.equal(closed.length, 2);
  const byId = new Map(closed.map((row) => [row.id, row]));
  assert.equal(byId.get(queued.id).state, 'undelivered');
  assert.equal(byId.get(queued.id).failureReason, 'The user stopped the run.');
  assert.equal(byId.get(claimed.id).state, 'undelivered');
  assert.match(byId.get(claimed.id).failureReason, /delivery could not be confirmed/i);
});

test('only a still-queued instruction can be withdrawn', () => {
  const row = submit({ runId: 'run-cancel', idempotencyKey: 'cancel-1' });
  const cancelled = steering.cancelSteering({ sessionId: 'session-a', steeringId: row.id });
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.failureReason, /withdrawn/i);
  assert.throws(
    () => steering.cancelSteering({ sessionId: 'session-a', steeringId: row.id }),
    /already been taken up/i,
  );

  const claimed = submit({ runId: 'run-cancel', idempotencyKey: 'cancel-2' });
  steering.takeSteering({ sessionId: 'session-a', runId: 'run-cancel', requestId: 'request-cancel' });
  assert.throws(
    () => steering.cancelSteering({ sessionId: 'session-a', steeringId: claimed.id }),
    /already been taken up/i,
  );
});

test('history is scoped to its session and run', () => {
  submit({ sessionId: 'session-b', runId: 'run-b', idempotencyKey: 'scope-b' });
  assert.equal(steering.getSteeringHistory('session-b').length, 1);
  assert.ok(steering.getSteeringHistory('session-a').every((row) => row.sessionId === 'session-a'));
  assert.ok(steering.getRunSteering('session-b', 'run-a').length === 0);
  steering.finalizeRun({ sessionId: 'session-b', runId: 'run-b' });
});

test('invalid content, identifiers, and oversized queues are rejected', () => {
  assert.throws(() => submit({ content: '   ' }), /Write a steering instruction/i);
  assert.throws(() => submit({ content: 'x'.repeat(steering.MAX_STEERING_CHARS + 1) }), /limited to/i);
  assert.throws(() => submit({ idempotencyKey: '' }), /idempotency key/i);
  assert.throws(() => submit({ sessionId: 'missing-session' }), /Session not found/i);
  assert.throws(
    () => steering.takeSteering({ sessionId: 'session-a', runId: 'run-a', requestId: '', limit: 1 }),
    /requestId/i,
  );

  for (let index = 0; index < steering.MAX_PENDING_PER_RUN; index++) {
    submit({ runId: 'run-full', idempotencyKey: `full-${index}` });
  }
  assert.throws(() => submit({ runId: 'run-full', idempotencyKey: 'full-overflow' }), /Too many steering/i);
  steering.finalizeRun({ sessionId: 'session-a', runId: 'run-full' });
});

test('deleting a session removes its steering rows', () => {
  db.prepare("INSERT INTO sessions(id) VALUES ('session-delete')").run();
  submit({ sessionId: 'session-delete', runId: 'run-delete', idempotencyKey: 'delete-1' });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM run_steering_messages WHERE session_id = 'session-delete'").get().count,
    1,
  );
  db.prepare("DELETE FROM sessions WHERE id = 'session-delete'").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM run_steering_messages WHERE session_id = 'session-delete'").get().count,
    0,
  );
});

test('startup reconciliation never replays an interrupted instruction', () => {
  // Simulate a crash with both a never-claimed row and one whose request was
  // in flight when the process died.
  const queued = submit({ runId: 'run-crash', idempotencyKey: 'crash-queued' });
  const inFlight = submit({ runId: 'run-crash', idempotencyKey: 'crash-claimed' });
  steering.takeSteering({ sessionId: 'session-a', runId: 'run-crash', requestId: 'request-crash' });
  assert.equal(steering.getSteering('session-a', inFlight.id).state, 'claimed');

  closeDatabase();
  initDatabase(directory);

  const after = new Map(
    steering.getRunSteering('session-a', 'run-crash').map((row) => [row.id, row]),
  );
  assert.equal(after.get(queued.id).state, 'undelivered');
  assert.equal(after.get(inFlight.id).state, 'undelivered');
  assert.equal(after.get(inFlight.id).failureReason, steering.INTERRUPTED_REASON);
  assert.ok(steering.getSteeringHistory('session-a').every((row) => row.state !== 'queued'));
});
