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
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  // Interrupted is deliberately its own status: the attempt stopped early on
  // purpose, while the child session behind it stays alive and resumable.
  INTERRUPTED: 'interrupted',
});

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

function completeExecution(execution, { usage = null, result = null } = {}) {
  execution.status = EXECUTION_STATUS.COMPLETED;
  execution.completedAt = new Date().toISOString();
  if (usage) execution.usage = usage;
  execution.result = result;
  return execution;
}

function failExecution(execution, error) {
  execution.status = EXECUTION_STATUS.FAILED;
  execution.completedAt = new Date().toISOString();
  execution.error = String(error?.message ?? error);
  return execution;
}

function cancelExecution(execution) {
  execution.status = EXECUTION_STATUS.CANCELLED;
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
  execution.status = EXECUTION_STATUS.INTERRUPTED;
  execution.completedAt = new Date().toISOString();
  return execution;
}

module.exports = {
  EXECUTION_STATUS, createExecution, listExecutions,
  completeExecution, failExecution, cancelExecution,
  flagInterrupt, interruptExecution,
};
