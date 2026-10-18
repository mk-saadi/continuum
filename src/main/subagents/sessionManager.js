'use strict';

const { randomUUID } = require('node:crypto');
const { persistChildRun } = require('./persistence');

// Explicit lifecycle for a subagent child session, extended for continuation
// (Step 6) with the smallest state model that fits:
//
//   created    opened by the runtime, work not started yet
//   running    one active execution owns the child's context
//   waiting    alive with queued work and no active execution (the driver has
//              been asked to run the inbox / a resumed turn, or is between
//              turns) — never a terminal state
//   completed  the latest turn finished with a final answer; continuable
//   interrupted current work was stopped at a safe boundary on purpose; the
//              session and its context are preserved and resumable
//   failed     the latest turn failed; terminal
//   cancelled  the execution was cancelled; terminal (distinct from interrupted)
//   timed_out  a wall-clock limit (execution deadline or model-request timeout)
//              elapsed; terminal and never reported as success
//
// The transition table below is the single source of truth: anything not
// listed is an invalid transition and becomes a no-op, so two overlapping
// settlements can never drive a child into an impossible state.
const SESSION_STATUS = Object.freeze({
  CREATED: 'created',
  WAITING: 'waiting',
  RUNNING: 'running',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
});

// Allowed predecessor states per transition (see the functions below).
const CAN_WAIT = new Set([SESSION_STATUS.CREATED, SESSION_STATUS.COMPLETED, SESSION_STATUS.INTERRUPTED]);
const CAN_INTERRUPT = new Set([SESSION_STATUS.CREATED, SESSION_STATUS.WAITING, SESSION_STATUS.RUNNING]);
const CAN_RESUME = new Set([SESSION_STATUS.WAITING]);
const IS_TERMINAL = new Set([SESSION_STATUS.FAILED, SESSION_STATUS.CANCELLED, SESSION_STATUS.PARTIAL, SESSION_STATUS.TIMED_OUT]);

// Ephemeral, in-memory records only: a subagent execution belongs to a distinct
// child session. Persistence across application restarts is deliberately not
// here — if the process exits, the child disappears with it.
//
// Step 6 additions to the record itself (the session is the durable in-memory
// identity, so continuation state hangs off it):
//   inbox    ordered parent messages waiting to become child turns (FIFO)
//   context  the child's own conversation snapshot, committed only at safe
//            boundaries by the agent loop — never the parent's history
const sessions = new Map();

// A child never reuses the parent's id: session_123 -> session_123_child_<uuid>.
// The lineage is readable from the id itself, and every spawn gets a stable,
// unique identity that later steps (resume, messaging, usage, UI) can key on.
function childSessionId(parentSessionId) {
  const unique = randomUUID();
  return parentSessionId ? `${parentSessionId}_child_${unique}` : `child_${unique}`;
}

function createSession({ parentSessionId = null, agentId = null, model = null,
  provider = 'local', providerId = null } = {}) {
  const now = new Date().toISOString();
  const session = {
    id: childSessionId(parentSessionId),
    parentSessionId,
    agentId,
    // Which model this child runs on — decided once at spawn by
    // ./modelSelection.js and never switched mid-session. `provider` is the
    // registry id ('local' | 'cloud'); `providerId` names the saved cloud
    // provider (null for the local server). Together with the lifecycle fields
    // below they are the runtime's whole observability surface.
    model,
    provider,
    providerId,
    status: SESSION_STATUS.CREATED,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    usage: null,
    result: null,
    error: null,
    stopReason: null,
    accounting: null,
    inbox: [],
    context: null,
    // Phase 1.3C durable-continuation state. `rawContext`/`compactionState` are
    // owned by the agent loop's context adapter; they are declared here so a
    // child has one stable shape, live or rehydrated. `continuationOptions`
    // records the delegated objective's engine/root so a restart can rebuild
    // the child; `pendingContinuation` mirrors the driver's unfinished-turn
    // flag; `continuation`/`durableResumable` are the persisted eligibility.
    rawContext: null,
    compactionState: null,
    budgetState: null,
    inputSummary: null,
    continuationOptions: null,
    pendingContinuation: false,
    attemptBase: 0,
    continuation: null,
    durableResumable: false,
    // Live activity feed for the observability modal: turn starts, captured
    // thinking, tool start/finish, and errors. Observational only — the loop
    // never reads it back, and it is never sent to the model. Bounded so a
    // long run cannot grow the session without limit.
    activity: [],
  };
  sessions.set(session.id, session);
  return session;
}

function startSession(session) {
  if (session.status !== SESSION_STATUS.CREATED) return session;
  session.status = SESSION_STATUS.RUNNING;
  session.startedAt = new Date().toISOString();
  return session;
}

function getSession(id) {
  return sessions.get(id) ?? null;
}

// Bounded registry of evicted child ids so control calls can report an
// explicit expiry instead of "unknown session". Ids only (~70 chars each);
// trimmed FIFO so the registry itself cannot grow without bound.
const EVICTED_CHILD_IDS = [];
const MAX_EVICTED_CHILD_IDS = 1000;
function noteEvictedChild(id) {
  if (typeof id !== 'string' || !id) return;
  EVICTED_CHILD_IDS.push(id);
  while (EVICTED_CHILD_IDS.length > MAX_EVICTED_CHILD_IDS) EVICTED_CHILD_IDS.shift();
}
function wasEvictedChild(id) {
  return typeof id === 'string' && EVICTED_CHILD_IDS.includes(id);
}

// Removal for the retention policy (see continuationManager.pruneChildSessions):
// drops the live record only. Durable history stays in subagent_runs, and the
// id is remembered so later control calls report expiry truthfully.
function deleteSession(id) {
  return sessions.delete(id);
}

function listSessions() {
  return [...sessions.values()];
}

// The parent/child relationship: every child records the session that spawned
// it, so one parent's children are enumerable without a full session tree.
function listChildren(parentSessionId) {
  return [...sessions.values()].filter(item => item.parentSessionId === parentSessionId);
}

function captureAccounting(session) {
  if (!session.budgetState) return;
  const value = require('./executionBudget').outcome(session.budgetState);
  session.usage = value.usage; session.accounting = value.accounting;
}

function markCompletedAt(session) {
  const now = new Date().toISOString();
  session.completedAt = now;
  session.durationMs = session.startedAt ? Date.parse(now) - Date.parse(session.startedAt) : null;
}

// Wake a completed/interrupted child into `waiting`: queued work exists but no
// execution is active yet. The inverse of stopping, so the stop timestamp is
// cleared — the child is alive again, not resting.
function waitSession(session) {
  if (!CAN_WAIT.has(session.status)) return session;
  session.status = SESSION_STATUS.WAITING;
  session.completedAt = null;
  session.durationMs = null;
  return session;
}

// The driver's WAITING -> RUNNING step: exactly one turn may claim the child.
function resumeSession(session) {
  if (!CAN_RESUME.has(session.status)) return session;
  session.status = SESSION_STATUS.RUNNING;
  return session;
}

// Phase 1.3C: wake a child into `waiting` for an *authorized continuation*. Unlike
// waitSession this also accepts a budget-exhausted (`partial`), budget-failed,
// `timed_out` or `cancelled` child — but only the continuation control surface
// (continuationManager.continueChild) calls it, after eligibility has been
// checked and any renewal applied. It never executes anything by itself.
const CAN_CONTINUE = new Set([
  SESSION_STATUS.CREATED, SESSION_STATUS.COMPLETED, SESSION_STATUS.INTERRUPTED,
  SESSION_STATUS.PARTIAL, SESSION_STATUS.FAILED, SESSION_STATUS.TIMED_OUT,
  SESSION_STATUS.CANCELLED,
]);
function prepareContinuation(session) {
  if (session.status === SESSION_STATUS.RUNNING || session.status === SESSION_STATUS.WAITING) return session;
  if (!CAN_CONTINUE.has(session.status)) return session;
  session.status = SESSION_STATUS.WAITING;
  session.completedAt = null;
  session.durationMs = null;
  return session;
}

// Rebuild a child from durable state after a restart (Phase 1.3C Step 8). The
// child is inserted into the in-memory registry in a *stopped* state and is
// never executed here: recovery only makes it available, and an explicit
// continuation is required to run it. A session that was mid-flight when the
// process died (`created`/`waiting`/`running`) is marked `interrupted` — the
// truthful "unexpected termination" state — never silently resumed.
function recoveryStatus(status) {
  if (status === SESSION_STATUS.CREATED || status === SESSION_STATUS.WAITING || status === SESSION_STATUS.RUNNING) {
    return SESSION_STATUS.INTERRUPTED;
  }
  return typeof status === 'string' && status ? status : SESSION_STATUS.INTERRUPTED;
}

function rehydrateSession(record) {
  if (!record || typeof record.id !== 'string' || !record.id) {
    throw new Error('rehydrateSession requires a child session id.');
  }
  if (sessions.has(record.id)) return sessions.get(record.id);
  const now = new Date().toISOString();
  const session = {
    id: record.id,
    parentSessionId: record.parentSessionId ?? null,
    agentId: record.agentId ?? null,
    model: record.model ?? null,
    provider: record.provider ?? 'local',
    providerId: record.providerId ?? null,
    status: recoveryStatus(record.status),
    createdAt: record.createdAt ?? now,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    durationMs: record.durationMs ?? null,
    usage: record.usage ?? null,
    result: record.result ?? null,
    error: record.error ?? null,
    stopReason: record.stopReason ?? null,
    accounting: record.accounting ?? null,
    inbox: [],
    context: record.context ?? null,
    rawContext: record.rawContext ?? null,
    compactionState: record.compactionState ?? null,
    budgetState: record.budgetState ?? null,
    inputSummary: record.inputSummary ?? null,
    continuationOptions: record.continuationOptions ?? null,
    pendingContinuation: false,
    attemptBase: Number.isSafeInteger(record.attemptBase) ? record.attemptBase : 0,
    continuation: record.continuation ?? null,
    durableResumable: false,
    activity: [],
  };
  sessions.set(session.id, session);
  return session;
}

// Interrupt: stop the current work but keep the session and its context
// continuable. Only a live child can be interrupted; terminal and already
// completed children are untouched (there is no "current work" to stop).
function interruptSession(session) {
  if (!CAN_INTERRUPT.has(session.status)) return session;
  session.status = SESSION_STATUS.INTERRUPTED;
  session.stopReason = 'interrupted';
  captureAccounting(session);
  markCompletedAt(session);
  persistChildRun(session);
  return session;
}

// Terminal settlements are valid only from `running`: a completed, waiting, or
// already-terminal session has no active execution whose outcome this could be.
// Each settlement mirrors the run to the database (best-effort, never
// throwing) so every path — first runs, background runs, resumed turns —
// leaves the same durable record.
function completeSession(session, { usage = null, result = null, outcome = 'completed', stopReason = 'completed', accounting = null } = {}) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = outcome;
  session.stopReason = stopReason;
  session.accounting = accounting;
  markCompletedAt(session);
  if (usage) session.usage = usage;
  session.result = result;
  session.error = outcome === 'completed' ? null : result;
  persistChildRun(session);
  return session;
}

function failSession(session, error) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = SESSION_STATUS.FAILED;
  markCompletedAt(session);
  session.error = String(error?.message ?? error);
  session.stopReason = error?.stopReason ?? (error?.code === 'CONTEXT_BUDGET_EXCEEDED' ? 'context_exhausted' : 'runtime_error');
  captureAccounting(session);
  if (error?.subagentResult) session.result = error.subagentResult.output;
  persistChildRun(session);
  return session;
}

function cancelSession(session) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = SESSION_STATUS.CANCELLED;
  session.stopReason = 'cancelled';
  captureAccounting(session);
  markCompletedAt(session);
  persistChildRun(session);
  return session;
}

// Live activity feed (see the `activity` field on createSession). The agent
// loop appends here as work happens; the transcript view reads it. Append
// only — nothing in the runtime consumes these events, so recording can never
// change loop behavior. Bounded per session.
const ACTIVITY_LIMIT = 80;
const ACTIVITY_TEXT_LIMIT = 600;
function pushActivity(session, event) {
  if (!session || typeof session !== 'object') return null;
  if (!Array.isArray(session.activity)) session.activity = [];
  const entry = { t: Date.now(), ...event };
  for (const key of ['text', 'error', 'arguments']) {
    if (typeof entry[key] === 'string' && entry[key].length > ACTIVITY_TEXT_LIMIT) {
      entry[key] = `${entry[key].slice(0, ACTIVITY_TEXT_LIMIT)}…`;
    }
  }
  session.activity.push(entry);
  while (session.activity.length > ACTIVITY_LIMIT) session.activity.shift();
  return entry;
}

module.exports = {
  SESSION_STATUS, IS_TERMINAL, createSession, startSession, getSession, listSessions, listChildren,
  deleteSession, noteEvictedChild, wasEvictedChild, MAX_EVICTED_CHILD_IDS,
  waitSession, resumeSession, interruptSession, prepareContinuation, CAN_CONTINUE,
  rehydrateSession, recoveryStatus,
  completeSession, failSession, cancelSession,
  pushActivity, ACTIVITY_LIMIT,
};
