'use strict';

const { randomUUID } = require('node:crypto');

// Execution records answer "what actually ran", separately from the session,
// which answers "which logical child is this". Each execution is one attempt:
// the child's first run, and — since continuation (Step 6) — every message or
// resumed turn the runtime drives afterwards. A session therefore accumulates
// attempts in order, at most one of them running at any time (the child owns
// its context single-threaded; see ../continuationManager.js).
// In-memory only, like the sessions themselves.
//
// `background` is a property of the attempt itself: the same session, loop,
// and scheduler run either way, only the lifetime differs — a background
// attempt has no caller awaiting it (see ../index.js). Everything else about
// the record, including the terminal statuses, is shared by both lifetimes.
//
// `controller` is the attempt's AbortSignal source: either the caller's
// wrapped controller (first turn) or the runtime driver's controller
// (continuation turns). `interrupted` distinguishes an interrupt (stop now,
// keep the child continuable) from a cancellation (this attempt is finished)
// — both abort the same controller, only the flag tells them apart.
//
// This module only records attempts; ./executionManager and ./agentLoop
// perform them.
const executions = new Map();

const EXECUTION_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  // Interrupted is deliberately its own status: the attempt stopped early on
  // purpose, while the child session behind it stays alive and resumable.
  INTERRUPTED: 'interrupted',
  // A wall-clock limit elapsed (execution deadline or model-request timeout):
  // terminal, and never reported as success.
  TIMED_OUT: 'timed_out',
});

// Terminal attempts are final: a late settlement (a straggling response, a
// second close, a race between timeout and cancellation) must never overwrite
// the first authoritative outcome.
const TERMINAL_EXECUTION_STATUSES = new Set([
  EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.PARTIAL, EXECUTION_STATUS.FAILED,
  EXECUTION_STATUS.CANCELLED, EXECUTION_STATUS.INTERRUPTED, EXECUTION_STATUS.TIMED_OUT,
]);
function isSettled(execution) {
  return TERMINAL_EXECUTION_STATUSES.has(execution.status);
}

function createExecution({ sessionId, kind = null, background = false, controller = null }) {
  const execution = {
    id: randomUUID(),
    sessionId,
    kind,
    background: background === true,
    controller,
    interrupted: false,
    status: EXECUTION_STATUS.RUNNING,
    startedAt: new Date().toISOString(),
    completedAt: null,
    usage: null,
    result: null,
    error: null,
  };
  executions.set(execution.id, execution);
  return execution;
}

function listExecutions(sessionId) {
  return [...executions.values()].filter(item => item.sessionId === sessionId);
}

// Single-pass index of sessions with a live attempt, so retention pruning
// stays O(sessions + executions) instead of re-filtering all executions per
// session. Read-only snapshot for one prune decision.
function runningSessionIds() {
  const ids = new Set();
  for (const execution of executions.values()) {
    if (execution.status === EXECUTION_STATUS.RUNNING) ids.add(execution.sessionId);
  }
  return ids;
}

// Removal for the retention policy: drops every attempt of one child session.
// Callers evict executions only together with their session — never a live
// session's history, which transcript counts and control paths read.
function deleteExecutionsForSession(sessionId) {
  let removed = 0;
  for (const [id, execution] of executions) {
    if (execution.sessionId === sessionId) {
      executions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function completeExecution(execution, { usage = null, result = null, outcome = 'completed', stopReason = 'completed', accounting = null } = {}) {
  if (isSettled(execution)) return execution;
  execution.status = outcome;
  execution.stopReason = stopReason;
  execution.accounting = accounting;
  execution.completedAt = new Date().toISOString();
  if (usage) execution.usage = usage;
  execution.result = result;
  return execution;
}

function failExecution(execution, error) {
  if (isSettled(execution)) return execution;
  execution.status = EXECUTION_STATUS.FAILED;
  execution.completedAt = new Date().toISOString();
  execution.error = String(error?.message ?? error);
  execution.stopReason = error?.stopReason ?? 'runtime_error';
  if (error?.subagentResult) {
    execution.usage = error.subagentResult.usage; execution.accounting = error.subagentResult.accounting;
    execution.result = error.subagentResult.output;
  }
  return execution;
}

function cancelExecution(execution) {
  if (isSettled(execution)) return execution;
  execution.status = EXECUTION_STATUS.CANCELLED;
  execution.stopReason = 'cancelled';
  execution.completedAt = new Date().toISOString();
  return execution;
}

// Interrupt is two steps on purpose: flagInterrupt() marks the running attempt
// as "stop at the next safe boundary" before its controller is aborted, and
// interruptExecution() records the terminal status when the attempt actually
// settles. The flag is what lets the settlement path tell an interrupt apart
// from a plain cancellation of the same signal.
function flagInterrupt(execution) {
  if (execution.status !== EXECUTION_STATUS.RUNNING) return false;
  execution.interrupted = true;
  return true;
}

function interruptExecution(execution) {
  if (isSettled(execution)) return execution;
  execution.status = EXECUTION_STATUS.INTERRUPTED;
  execution.stopReason = 'interrupted';
  execution.completedAt = new Date().toISOString();
  return execution;
}

module.exports = {
  EXECUTION_STATUS, createExecution, listExecutions, runningSessionIds, deleteExecutionsForSession,
  completeExecution, failExecution, cancelExecution,
  flagInterrupt, interruptExecution,
};
