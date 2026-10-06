'use strict';

const { randomUUID } = require('node:crypto');

// Ephemeral, in-memory records only: a subagent execution belongs to a distinct
// child session even though today each session lives for exactly one one-shot
// execution. Persistence, resume, messaging, and inbox handling are deliberately
// not here yet — this module only establishes the identity and lifecycle.
const sessions = new Map();

function createSession({ parentSessionId = null, agentId = null, model = null } = {}) {
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    parentSessionId,
    agentId,
    model,
    status: 'running',
    createdAt: now,
    completedAt: null,
    usage: null,
    error: null,
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(id) {
  return sessions.get(id) ?? null;
}

function listSessions() {
  return [...sessions.values()];
}

function completeSession(session, usage = null) {
  session.status = 'completed';
  session.completedAt = new Date().toISOString();
  if (usage) session.usage = usage;
  return session;
}

function failSession(session, error) {
  session.status = 'failed';
  session.completedAt = new Date().toISOString();
  session.error = String(error?.message ?? error);
  return session;
}

module.exports = { createSession, getSession, listSessions, completeSession, failSession };
