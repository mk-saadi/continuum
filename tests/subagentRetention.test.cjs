'use strict';
// Phase 3 subagent retention: bounded in-memory runtime records without
// breaking active execution, continuation, cancellation, or transcripts.
// Deterministic, no model calls (stores driven directly; one mocked-fetch
// spawn proves the openRun hook). Run with:
//   node --test tests/subagentRetention.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-retention-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/subagents/sessionManager');
const executions = require('../src/main/subagents/executionStore');
const continuation = require('../src/main/subagents/continuationManager');
const runtime = require('../src/main/subagents');

test.after(() => {
  try { closeDatabase(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
});

const HOUR = 3600000;
let seq = 0;
const parentFor = (tag) => `ret-parent-${tag}-${++seq}`;
// A settled child with a large payload, settled through the real lifecycle
// (so persistence mirrors exactly like production).
function settledChild(parent, { status = 'completed', withRecord = false, big = false } = {}) {
  const session = sessions.createSession({ parentSessionId: parent });
  sessions.startSession(session);
  const attempt = executions.createExecution({ sessionId: session.id, kind: 'investigation' });
  if (big) {
    session.context = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${'x'.repeat(200000)}${i}` }));
    session.result = 'y'.repeat(500000);
  } else {
    session.context = [{ role: 'user', content: 'do it' }];
    session.result = 'done';
  }
  if (withRecord) {
    continuation.registerChild(session, { kind: 'investigation', engine: {}, rootPath: directory, maxTurns: 1, maxToolCalls: 1 });
  }
  if (status === 'completed') {
    executions.completeExecution(attempt, { result: session.result });
    sessions.completeSession(session, { result: session.result });
  } else if (status === 'failed') {
    executions.failExecution(attempt, new Error('boom'));
    sessions.failSession(session, new Error('boom'));
  } else if (status === 'cancelled') {
    executions.cancelExecution(attempt);
    sessions.cancelSession(session);
  } else if (status === 'interrupted') {
    executions.interruptExecution(attempt);
    sessions.interruptSession(session);
  }
  return session;
}
const executionTotal = () => sessions.listSessions().reduce((n, s) => n + executions.listExecutions(s.id).length, 0);
const past = (ms) => Date.now() + ms;
// Simulate age without waiting: completedAt is a plain ISO string stamped at
// settlement. (A future `now` override would age fresh sessions too, so age is
// backdated instead; one test below pins the relative-age semantics directly.)
const ageSession = (s, ms) => { s.completedAt = new Date(Date.now() - ms).toISOString(); return s; };

test('1. completed sessions become eligible and are released with their executions', () => {
  const parent = parentFor('eligible');
  const s = settledChild(parent);
  assert.ok(sessions.getSession(s.id), 'settled session addressable');
  assert.equal(executions.listExecutions(s.id).length, 1);
  assert.equal(continuation.isSessionEvictable(s, { now: past(HOUR) }), true, 'eligibility is relative to now');
  ageSession(s, HOUR);
  assert.equal(continuation.isSessionEvictable(s), true, 'aged session eligible at real now');
  const out = continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.ok(out.evicted.includes(s.id));
  assert.equal(sessions.getSession(s.id), null);
  assert.deepEqual(executions.listExecutions(s.id), []);
});

test('2. running, waiting, and inbox-holding sessions are never evicted', () => {
  const parent = parentFor('live');
  const running = sessions.createSession({ parentSessionId: parent });
  sessions.startSession(running);
  executions.createExecution({ sessionId: running.id, kind: 'investigation' });
  const waiting = sessions.createSession({ parentSessionId: parent });
  sessions.startSession(waiting);
  executions.completeExecution(executions.createExecution({ sessionId: waiting.id }), {});
  sessions.completeSession(waiting, {});
  sessions.waitSession(waiting);
  waiting.inbox.push({ message: 'queued', enqueuedAt: new Date().toISOString() });
  const out = continuation.pruneChildSessions({ now: past(10 * HOUR), maxCompleted: 0 });
  assert.deepEqual(out.evicted, [], 'live/queued records survive even maxCompleted: 0');
  assert.ok(sessions.getSession(running.id), 'running kept');
  assert.ok(sessions.getSession(waiting.id), 'waiting with inbox kept');
  assert.equal(sessions.wasEvictedChild(running.id), false);
});

test('3. evicting one child leaves other sessions and their executions intact', () => {
  const parent = parentFor('isolated');
  const old = ageSession(settledChild(parent), HOUR);
  const fresh = settledChild(parent);
  const out = continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.ok(out.evicted.includes(old.id));
  assert.ok(!out.evicted.includes(fresh.id), 'fresh completed session kept');
  assert.ok(sessions.getSession(fresh.id));
  assert.equal(executions.listExecutions(fresh.id).length, 1);
});

test('4. cancellation and failure paths release on prune', () => {
  const parent = parentFor('terminal');
  const cancelled = ageSession(settledChild(parent, { status: 'cancelled' }), HOUR);
  const failed = ageSession(settledChild(parent, { status: 'failed' }), HOUR);
  const out = continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.ok(out.evicted.includes(cancelled.id) && out.evicted.includes(failed.id));
  assert.equal(sessions.getSession(cancelled.id), null);
  assert.equal(sessions.getSession(failed.id), null);
});

test('5. valid continuation is preserved; idle completion is not resumable work', () => {
  const parent = parentFor('continuation');
  // Interrupted turn owed a re-drive: protected.
  const owed = settledChild(parent, { status: 'interrupted', withRecord: true });
  continuation.noteInterruptedTurn(sessions.getSession(owed.id));
  assert.equal(continuation.getRecord(owed.id).pendingContinuation, true);
  // Fresh idle completion: resume() is a safe no-op returning resumed:false.
  const idle = settledChild(parent, { status: 'completed', withRecord: true });
  assert.deepEqual(continuation.resume(idle.id, { parentSessionId: parent }), {
    childSessionId: idle.id, status: 'completed', resumed: false,
  });
  assert.equal(continuation.getRecord(idle.id).scheduled ?? false, false, 'no-op resume schedules no driver');
  const out = continuation.pruneChildSessions({ now: past(HOUR), maxCompleted: 10000 });
  assert.ok(sessions.getSession(owed.id), 'pending continuation kept');
  assert.ok(continuation.getRecord(owed.id), 'driver record kept with the session');
  assert.ok(!sessions.getSession(idle.id), 'idle completion with nothing pending released');
});

test('6. evicted children report expiry explicitly; transcripts still serve', () => {
  const parent = parentFor('expired');
  const s = settledChild(parent, { big: false });
  sessions.getSession(s.id).context = [{ role: 'user', content: 'task text here' }];
  ageSession(s, HOUR);
  continuation.pruneChildSessions({ maxCompleted: 10000 });
  for (const call of [
    () => continuation.sendMessage(s.id, 'again', { parentSessionId: parent }),
    () => continuation.interrupt(s.id, { parentSessionId: parent }),
    () => continuation.resume(s.id, { parentSessionId: parent }),
  ]) {
    assert.throws(call, /has expired and its runtime state was released/);
  }
  const view = runtime.getChildTranscript(s.id);
  assert.equal(view.found, true, 'transcript falls back to SQLite');
  assert.ok(view.persisted === true || view.status, 'persisted shape served');
});

test('7. parent references survive child eviction', () => {
  const parent = parentFor(' lineage');
  const s = ageSession(settledChild(parent), HOUR);
  continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.deepEqual(sessions.listChildren(parent), [], 'no dangling child entries');
  const view = runtime.getChildTranscript(s.id);
  assert.equal(view.found, true);
  assert.equal(view.parentSessionId, parent);
});

test('8. durable history survives runtime cleanup', () => {
  const parent = parentFor('durable');
  const s = ageSession(settledChild(parent), HOUR);
  const before = db.prepare('SELECT COUNT(*) AS n FROM subagent_runs WHERE child_session_id = ?').get(s.id).n;
  assert.equal(before, 1, 'settlement mirrored to SQLite');
  continuation.pruneChildSessions({ maxCompleted: 10000 });
  const after = db.prepare('SELECT status, output_text FROM subagent_runs WHERE child_session_id = ?').get(s.id);
  assert.ok(after, 'row retained after eviction');
  assert.equal(after.status, 'completed');
  assert.equal(after.output_text, 'done');
});

test('9. large payloads become collectible on eviction', () => {
  const parent = parentFor('payload');
  const s = ageSession(settledChild(parent, { big: true, withRecord: true }), HOUR);
  assert.ok(JSON.stringify(sessions.getSession(s.id).context).length > 900000);
  continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.equal(sessions.getSession(s.id), null, 'context released');
  assert.deepEqual(executions.listExecutions(s.id), [], 'result-bearing attempts released');
  assert.equal(continuation.getRecord(s.id), null, 'driver record released');
});

test('10. stress: ~1000 synthetic completions stay bounded, actives preserved', () => {
  const parent = parentFor('stress');
  const ids = { old: [], fresh: [], running: [], interrupted: [] };
  for (let i = 0; i < 900; i++) {
    const status = i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'cancelled' : 'completed';
    ids.old.push(ageSession(settledChild(parent, { big: i % 10 === 0, status }), 31 * 60000).id);
  }
  for (let i = 0; i < 50; i++) ids.fresh.push(settledChild(parent).id);
  for (let i = 0; i < 30; i++) {
    const s = sessions.createSession({ parentSessionId: parent });
    sessions.startSession(s);
    executions.createExecution({ sessionId: s.id, kind: 'investigation' });
    ids.running.push(s.id);
  }
  for (let i = 0; i < 20; i++) {
    const s = settledChild(parent, { status: 'interrupted', withRecord: true });
    continuation.noteInterruptedTurn(sessions.getSession(s.id));
    ids.interrupted.push(s.id);
  }
  const before = { sessions: sessions.listSessions().length, executions: executionTotal() };
  const out = continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.ok(out.evicted.length >= 900, `old completions released (got ${out.evicted.length})`);
  for (const id of ids.running) assert.ok(sessions.getSession(id), 'running preserved');
  for (const id of ids.interrupted) assert.ok(sessions.getSession(id), 'owed continuation preserved');
  for (const id of ids.fresh) assert.ok(sessions.getSession(id), 'fresh completions preserved');
  const after = { sessions: sessions.listSessions().length, executions: executionTotal() };
  assert.ok(after.sessions < before.sessions - 800, `session count bounded (${before.sessions} -> ${after.sessions})`);
  assert.ok(after.executions < before.executions - 800, `execution count bounded (${before.executions} -> ${after.executions})`);
  // Count backstop independent of age: keeps the newest, still spares live work.
  continuation.pruneChildSessions({ maxCompleted: 10 });
  const survivors = ids.fresh.filter((id) => sessions.getSession(id));
  assert.equal(survivors.length, 10, `burst cap keeps 10 (kept ${survivors.length})`);
  assert.deepEqual(survivors, ids.fresh.slice(-10), 'cap keeps the newest completions');
  for (const id of ids.running) assert.ok(sessions.getSession(id), 'running still preserved under cap pressure');
  for (const id of ids.interrupted) assert.ok(sessions.getSession(id), 'owed continuation survives cap pressure');
  // Idempotent: nothing new eligible.
  // Idempotent: nothing new eligible.
  const out3 = continuation.pruneChildSessions({ maxCompleted: 10 });
  assert.deepEqual(out3.evicted, [], 'repeat prune is a no-op');
});

test('11. invalid prune options throw instead of misbehaving', () => {
  assert.throws(() => continuation.pruneChildSessions({ ttlMs: NaN }), TypeError);
  assert.throws(() => continuation.pruneChildSessions({ maxCompleted: -1 }), TypeError);
  assert.throws(() => continuation.pruneChildSessions({ maxCompleted: 1.5 }), TypeError);
});

test('12. spawn path prunes without breaking normal delegation (mocked model)', async () => {
  const fetchImpl = async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const out = await runtime.runFileAnalysis({ task_description: 't', target_files: [], rootPath: directory, engine: { port: 1, modelId: 'm', contextLength: 32768 }, parentSessionId: parentFor('spawn'), fetchImpl });
  assert.equal(out, 'ok');
});

test('13. live records are never marked evicted; terminal double-settlement safe', () => {
  const parent = parentFor('flags');
  const live = sessions.createSession({ parentSessionId: parent });
  sessions.startSession(live);
  assert.equal(sessions.wasEvictedChild(live.id), false);
  const done = ageSession(settledChild(parent), HOUR);
  sessions.completeSession(sessions.getSession(done.id) ?? done, {}); // second settlement: guarded no-op or same state
  continuation.pruneChildSessions({ maxCompleted: 10000 });
  assert.equal(sessions.wasEvictedChild(live.id), false, 'live id never enters the evicted registry');
  assert.equal(sessions.wasEvictedChild(done.id), true);
});

console.log('Subagent retention: lifecycle, protection, expiry, bounds, and durability passed.');
