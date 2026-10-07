'use strict';

const { randomUUID } = require('node:crypto');

// Execution records answer "what actually ran", separately from the session,
// which answers "which logical child is this". Step 2 creates exactly one
// execution per newly-created session; retries, resume, background runs, and
// multi-turn continuation are later steps and are deliberately not modeled
// here. In-memory only, like the sessions themselves.
//
// This module only records attempts; ./executionManager performs them.
const executions = new Map();

const EXECUTION_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

function createExecution({ sessionId, kind = null }) {
  const execution = {
    id: randomUUID(),
    sessionId,
    kind,
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

module.exports = {
  EXECUTION_STATUS, createExecution, listExecutions,
  completeExecution, failExecution, cancelExecution,
};
