'use strict';
// Trusted runtime state only. No model arguments, persisted grants, or executable configuration.
const sessions = new Map();
let policyRevision = 0;
const inactiveRevisions = new Map();
const revision = sessionId => sessions.get(sessionId)?.revision ?? inactiveRevisions.get(sessionId) ?? null;
const trusted = new WeakSet();
const children = new WeakMap();
const eligible = mode => mode === 'workspace_write' || mode === 'full_access';
function currentMode(sessionId, fallback) {
  const p = require('./toolPermissions');
  return p.effectiveMode(sessions.get(sessionId)?.mode ?? fallback, p.sessionProject(sessionId));
}
function createContext(sessionId, permissionMode, runId = null) {
  if (!sessionId) return null;
  const mode = require('./toolPermissions').effectiveMode(permissionMode, require('./toolPermissions').sessionProject(sessionId));
  sessions.delete(sessionId); sessions.set(sessionId, { mode, revision: ++policyRevision });
  // Bounded live policy cache; eviction revokes old contexts instead of retaining a grant.
  while (sessions.size > 256) sessions.delete(sessions.keys().next().value);
  const context = Object.freeze({ sessionId, runId, get permissionMode() {
    return sessions.has(sessionId) ? currentMode(sessionId) : 'read_only';
  } });
  trusted.add(context); return context;
}
async function setMode(sessionId, mode) {
  const p = require('./toolPermissions');
  if (!require('../lib/permissionModes.json').modes.includes(mode)) throw new Error('Invalid permission mode.');
  const project = p.sessionProject(sessionId);
  const previous = sessions.get(sessionId);
  if (previous) { previous.mode = p.effectiveMode(mode, project); previous.revision = ++policyRevision; }
  else sessions.set(sessionId, { mode: p.effectiveMode(mode, project), revision: ++policyRevision });
  while (sessions.size > 256) sessions.delete(sessions.keys().next().value);
  const context = Object.freeze({ sessionId, get permissionMode() { return currentMode(sessionId, mode); } });
  if (project?.root_path) {
    const root = await require('node:fs/promises').realpath(project.root_path);
    await require('./lspManager').manager.permissionChanged(context, root);
  }
}
function authorizeChild(session, parent, mode = 'workspace_write') {
  if (!session || !parent || !trusted.has(parent) || session.parentSessionId !== parent.sessionId) return null;
  if (!require('../lib/permissionModes.json').modes.includes(mode)) throw new Error('Invalid child permission mode.');
  // Independent child ceiling: Full Access is never implicitly inherited.
  const previous = children.get(session);
  if (previous) previous.state.mode = 'read_only';
  const state = { mode, revision: ++policyRevision };
  const context = Object.freeze({ sessionId: parent.sessionId, childSessionId: session.id,
    get runId() { return session.activeExecutionId ?? null; },
    get childRevision() { return state.revision; },
    get permissionMode() { return session.status !== 'cancelled' && eligible(parent.permissionMode) ? state.mode : 'read_only'; } });
  trusted.add(context); children.set(session, { context, state }); return context;
}
function childMode(session) { return children.get(session)?.state.mode ?? 'read_only'; }
function childContext(session) { return children.get(session)?.context ?? null; }
// Revoke a child's LSP authorization when its live record disappears. The
// context object is demoted as well, so a reference that outlives the session
// can no longer act with the child's former ceiling.
function forgetChild(session) {
  const record = children.get(session);
  if (record) { record.state.mode = 'read_only'; record.state.revision = ++policyRevision; }
  children.delete(session);
}
function setChildMode(session, mode) {
  if (!require('../lib/permissionModes.json').modes.includes(mode)) throw new Error('Invalid child permission mode.');
  const record = children.get(session);
  if (record) {
    record.state.mode = mode; record.state.revision = ++policyRevision;
    // Mode changes to stopped children must also survive recovery.
    if (session.continuationOptions) require('./subagents/persistence').persistChildRun(session);
  }
}
function forTool(sessionId, fallback) {
  if (!sessionId) return null;
  if (!sessions.has(sessionId)) return createContext(sessionId, fallback);
  const context = Object.freeze({ sessionId, get permissionMode() { return sessions.has(sessionId) ? currentMode(sessionId) : 'read_only'; } });
  trusted.add(context); return context;
}
function invalidateRules(sessionIds) {
  for (const id of sessionIds) {
    const state = sessions.get(id);
    if (state) state.revision = ++policyRevision;
    else inactiveRevisions.set(id, ++policyRevision);
  }
}
function forget(sessionId) { sessions.delete(sessionId); inactiveRevisions.delete(sessionId); require('./rememberedToolRules').forget(sessionId); }
function isTrusted(context) { return context != null && trusted.has(context); }
module.exports = { invalidateRules, revision, childMode, eligible, createContext, forTool, currentMode, setMode, authorizeChild, childContext, forgetChild, setChildMode, forget, isTrusted };
