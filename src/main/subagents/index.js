'use strict';

const { createSession, startSession, completeSession, failSession, cancelSession } = require('./sessionManager');
const { createExecution, completeExecution, failExecution, cancelExecution } = require('./executionStore');
const { runFileAnalysisExecution, runWebExtractionExecution } = require('./executionManager');
const { runInvestigationExecution } = require('./agentLoop');

// Subagent runtime: the boundary between the tool layer and subagent executions.
// Each call opens a distinct child session, records one execution attempt inside
// it, and runs that attempt against the inference scheduler. The child session
// has its own identity, parent link, lifecycle, usage, and result. One call is
// still exactly one foreground execution: the investigation execution performs
// many model/tool turns *inside* that single execution (one session, one
// execution, a bounded agent loop), while file analysis and web extraction
// remain one-shot. Background runs, continuation, messaging, and resume are
// deliberately not part of this step.
//
//   tool -> runFileAnalysis/runWebExtraction/runInvestigation
//        -> child session -> execution
//        -> inference scheduler (one queue per provider/model, capacity-limited)
//        -> local provider -> local model server
//   runInvestigation only: the execution is an agent loop whose tool calls run
//   against the read-only tool registry directly, outside the scheduler.
//
// The scheduler may queue an execution's model request when that provider/model
// is at capacity; the caller still awaits the normal result, so concurrency here
// is scheduling, not background execution.

async function runFileAnalysis(options) {
  return runInSession(options, runFileAnalysisExecution, 'file-analysis');
}

async function runWebExtraction(options) {
  return runInSession(options, runWebExtractionExecution, 'web-extraction');
}

// One foreground multi-turn investigation: the child autonomously searches,
// reads, and reasons over several scheduler-gated inference turns before
// returning a single final answer.
async function runInvestigation(options) {
  return runInSession(options, runInvestigationExecution, 'investigation');
}

// An aborted signal (or an AbortError bubbling out of fetch/fs) is a
// cancellation, not a failure; every other error fails the session. Either way
// the original error is rethrown untouched so callers see the same semantics.
function isCancellation(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

async function runInSession({ parentSessionId = null, agentId = null, engine, signal, ...executionOptions }, execution, kind) {
  const session = createSession({ parentSessionId, agentId, model: engine?.modelId ?? null });
  startSession(session);
  const attempt = createExecution({ sessionId: session.id, kind });
  try {
    const { output, usage } = await execution({ session, engine, signal, ...executionOptions });
    completeExecution(attempt, { usage, result: output });
    completeSession(session, { usage, result: output });
    return output;
  } catch (error) {
    if (isCancellation(error, signal)) {
      cancelExecution(attempt);
      cancelSession(session);
    } else {
      failExecution(attempt, error);
      failSession(session, error);
    }
    throw error;
  }
}

module.exports = { runFileAnalysis, runWebExtraction, runInvestigation };
