'use strict';

const { randomUUID } = require('node:crypto');

// Explicit lifecycle for a subagent child session: created when the runtime
// opens it, running for the single one-shot execution, then terminal. Queued,
// waiting, paused, and resuming states belong to later scheduling steps.
const SESSION_STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

// Ephemeral, in-memory records only: a subagent execution belongs to a distinct
// child session even though today each session lives for exactly one one-shot
// execution. Persistence, resume, messaging, and inbox handling are deliberately
// not here yet — this module only establishes the identity and lifecycle.
const sessions = new Map();

// A child never reuses the parent's id: session_123 -> session_123_child_<uuid>.
// The lineage is readable from the id itself, and every spawn gets a stable,
// unique identity that later steps (resume, messaging, usage, UI) can key on.
function childSessionId(parentSessionId) {
  const unique = randomUUID();
  return parentSessionId ? `${parentSessionId}_child_${unique}` : `child_${unique}`;
}

function createSession({ parentSessionId = null, agentId = null, model = null } = {}) {
  const now = new Date().toISOString();
  const session = {
    id: childSessionId(parentSessionId),
    parentSessionId,
    agentId,
    model,
    status: SESSION_STATUS.CREATED,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    usage: null,
    result: null,
    error: null,
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

function completeSession(session, { usage = null, result = null } = {}) {
  session.status = SESSION_STATUS.COMPLETED;
  markCompletedAt(session);
  if (usage) session.usage = usage;
  session.result = result;
  return session;
}

function failSession(session, error) {
  session.status = SESSION_STATUS.FAILED;
  markCompletedAt(session);
  session.error = String(error?.message ?? error);
  return session;
}

function cancelSession(session) {
  session.status = SESSION_STATUS.CANCELLED;
  markCompletedAt(session);
  return session;
}

module.exports = {
  SESSION_STATUS, createSession, startSession, getSession, listSessions, listChildren,
  completeSession, failSession, cancelSession,
};
