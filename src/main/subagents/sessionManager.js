'use strict';

const { randomUUID } = require('node:crypto');

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
//
// The transition table below is the single source of truth: anything not
// listed is an invalid transition and becomes a no-op, so two overlapping
// settlements can never drive a child into an impossible state.
const SESSION_STATUS = Object.freeze({
  CREATED: 'created',
  WAITING: 'waiting',
  RUNNING: 'running',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

// Allowed predecessor states per transition (see the functions below).
const CAN_WAIT = new Set([SESSION_STATUS.CREATED, SESSION_STATUS.COMPLETED, SESSION_STATUS.INTERRUPTED]);
const CAN_INTERRUPT = new Set([SESSION_STATUS.CREATED, SESSION_STATUS.WAITING, SESSION_STATUS.RUNNING]);
const CAN_RESUME = new Set([SESSION_STATUS.WAITING]);
const IS_TERMINAL = new Set([SESSION_STATUS.FAILED, SESSION_STATUS.CANCELLED]);

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
    inbox: [],
    context: null,
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

function listSessions() {
  return [...sessions.values()];
}

// The parent/child relationship: every child records the session that spawned
// it, so one parent's children are enumerable without a full session tree.
function listChildren(parentSessionId) {
  return [...sessions.values()].filter(item => item.parentSessionId === parentSessionId);
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

// Interrupt: stop the current work but keep the session and its context
// continuable. Only a live child can be interrupted; terminal and already
// completed children are untouched (there is no "current work" to stop).
function interruptSession(session) {
  if (!CAN_INTERRUPT.has(session.status)) return session;
  session.status = SESSION_STATUS.INTERRUPTED;
  markCompletedAt(session);
  return session;
}

// Terminal settlements are valid only from `running`: a completed, waiting, or
// already-terminal session has no active execution whose outcome this could be.
function completeSession(session, { usage = null, result = null } = {}) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = SESSION_STATUS.COMPLETED;
  markCompletedAt(session);
  if (usage) session.usage = usage;
  session.result = result;
  return session;
}

function failSession(session, error) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = SESSION_STATUS.FAILED;
  markCompletedAt(session);
  session.error = String(error?.message ?? error);
  return session;
}

function cancelSession(session) {
  if (session.status !== SESSION_STATUS.RUNNING) return session;
  session.status = SESSION_STATUS.CANCELLED;
  markCompletedAt(session);
  return session;
}

module.exports = {
  SESSION_STATUS, IS_TERMINAL, createSession, startSession, getSession, listSessions, listChildren,
  waitSession, resumeSession, interruptSession,
  completeSession, failSession, cancelSession,
};
