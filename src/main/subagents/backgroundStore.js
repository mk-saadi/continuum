'use strict';

const { EventEmitter } = require('node:events');

// Registry of detached (background) executions — the small piece of state that
// exists only because nobody awaits a background run:
//
//   startX(...) -> track(execution) -> [caller has its handle and moves on]
//                              |
//                              +-- run settles -> settle(executionId, status)
//
// A record holds the run's AbortController and lives exactly as long as the
// run is active, because after startInBackground() has returned this is the
// only thing that still knows how to cancel it. The child session
// (./sessionManager) — not this store — owns the terminal result, usage, and
// error, so the outcome outlives both the caller and this record.
//
// Deliberate limitation: everything here is in-memory. If the Electron
// process exits, active background runs disappear with it — there is no disk
// queue, no restart recovery, and no cross-process recovery. Durable sessions
// and jobs belong to a later step; so do messaging, interrupt, and resume.
//
// Completion notification is one tiny listener list, not an application event
// bus: `started` when a run is registered, then exactly one of `completed`,
// `failed`, or `cancelled` when it settles. A listener that throws is caught
// and logged, so a consumer can never break a run's settlement.

const active = new Map(); // executionId -> { childSessionId, kind, controller, detach }
const backgroundEvents = new EventEmitter();

function notify(type, payload) {
  try {
    backgroundEvents.emit(type, payload);
  } catch (error) {
    console.error(`[subagents] background "${type}" listener failed:`, error);
  }
}

function payloadFor(record, status, error = null) {
  return { executionId: record.executionId, childSessionId: record.childSessionId, kind: record.kind, status, error };
}

// Register a run that is starting now. Emits `started` synchronously, before
// the execution's first turn, so a listener may cancel the run before it ever
// reaches the scheduler — it then settles through the same single path as any
// other cancellation.
function track({ executionId, childSessionId, kind, controller, detach = null }) {
  const record = { executionId, childSessionId, kind, controller, detach };
  active.set(executionId, record);
  notify('started', payloadFor(record, 'running'));
  return record;
}

// Terminal settlement. Exactly once per run: a second call for the same id is
// a no-op, so the lifecycle event can never fire twice. Drops the forwarded
// caller signal and emits the matching lifecycle event.
function settle(executionId, status, error = null) {
  const record = active.get(executionId);
  if (!record) return false;
  active.delete(executionId);
  try { record.detach?.(); } catch { /* the caller's signal is gone; nothing left to forward */ }
  notify(status, payloadFor(record, status, error));
  return true;
}

// Cancel through the existing AbortSignal infrastructure: aborting this
// controller is the same signal the inference scheduler dequeues on and the
// agent loop checks between turns. A queued run therefore leaves the queue
// without ever touching a slot, and a running run aborts its active
// generation — no separate control channel, and no new interrupt API. Returns
// false for an unknown or already-settled execution: its terminal state is
// final.
function cancelBackground(executionId) {
  const record = active.get(executionId);
  if (!record) return false;
  if (!record.controller.signal.aborted) {
    record.controller.abort(Object.assign(
      new Error('The background execution was cancelled.'),
      { name: 'AbortError' },
    ));
  }
  return true;
}

module.exports = { track, settle, cancelBackground, backgroundEvents };
