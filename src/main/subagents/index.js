'use strict';

const { createSession, startSession, completeSession, failSession, cancelSession } = require('./sessionManager');
const { createExecution, completeExecution, failExecution, cancelExecution } = require('./executionStore');
const { runFileAnalysisExecution, runWebExtractionExecution } = require('./executionManager');
const { runInvestigationExecution } = require('./agentLoop');
const backgroundStore = require('./backgroundStore');

// Subagent runtime: the boundary between the tool layer and subagent executions.
// Each call opens a distinct child session, records one execution attempt inside
// it, and runs that attempt against the inference scheduler. The child session
// has its own identity, parent link, lifecycle, usage, and result.
//
// One execution can be *started* in either lifetime, and that is the only
// difference between the two — background is a property of the run, not a
// second subagent implementation:
//
//   runFileAnalysis / runWebExtraction / runInvestigation
//     foreground: awaits the attempt and resolves to the final result (or
//     rethrows the error), exactly as before.
//
//   startFileAnalysis / startWebExtraction / startInvestigation
//     background: registers the attempt, returns
//     { childSessionId, executionId, status } immediately, and never waits.
//     The detached attempt keeps running and settles the same session and
//     execution records on its own.
//
//   tool -> runX(options)            -> child session -> execution -> loop
//        -> startX(options)          -> child session -> execution -> loop
//          (caller returns at once)             |
//                                               v
//                                    inference scheduler (Step 3)
//                                               |
//                                      provider/model lane
//
// Both lifetimes share ./sessionManager, ./executionStore, the agent loop (or
// the one-shot executions), and the Step 3 inference scheduler — there is one
// child-agent implementation and one inference path. Because the background
// run is an ordinary execution, its inference still enters the same
// provider/model lane: on a capacity-1 local model a background child waits in
// the scheduler queue while the main generation runs, and children on lanes
// with free capacity may generate in parallel. Nothing here hard-codes either
// outcome; the scheduler stays authoritative.
//
// Ownership: the runtime owns a background run, not the caller. The caller's
// request has already finished when the child starts, and nothing the caller
// does (or stops doing) terminates the child — it runs until it completes,
// fails, or is cancelled through cancelBackground()/an aborting caller signal.
// Results, usage, and errors are written to the child session, which outlives
// the caller; completion is reported on backgroundEvents (started, completed,
// failed, cancelled).
//
// Deliberate limitations of this step: the runtime is in-memory, so an
// application shutdown drops active background runs — durable job recovery and
// restart resumption belong with persistent sessions later. There is also no
// messaging, inbox, interrupt, or resume: a background child simply runs its
// assigned task to completion, and Step 4's context isolation and read-only
// tool allowlist are unchanged by backgrounding.
//
//   tool -> runFileAnalysis/runWebExtraction/runInvestigation
//        -> child session -> execution
//        -> inference scheduler (one queue per provider/model, capacity-limited)
//        -> local provider -> local model server
//   the investigation execution is an agent loop whose tool calls run
//   against the read-only tool registry directly, outside the scheduler.
//
// The scheduler may queue an execution's model request when that provider/model
// is at capacity; a foreground caller still awaits the normal result, while a
// background caller has already returned — queueing is scheduling either way,
// never a lifetime change.

// The single kind -> implementation map. Foreground and background runs select
// from it identically, so both lifetimes always execute the same loop.
const EXECUTION_BY_KIND = Object.freeze({
  'file-analysis': runFileAnalysisExecution,
  'web-extraction': runWebExtractionExecution,
  investigation: runInvestigationExecution,
});

// --- Foreground: await the attempt, return the final result. ---

async function runFileAnalysis(options) {
  return runInSession(options, 'file-analysis');
}

async function runWebExtraction(options) {
  return runInSession(options, 'web-extraction');
}

// One foreground multi-turn investigation: the child autonomously searches,
// reads, and reasons over several scheduler-gated inference turns before
// returning a single final answer.
async function runInvestigation(options) {
  return runInSession(options, 'investigation');
}

// --- Background: start the attempt, return its identity, never wait. ---

// Synchronous on purpose: the handle exists before any of the child's work can
// finish, so "returns without waiting for completion" is structural rather than
// a matter of timing. Each is the background twin of its run* counterpart and
// executes the identical session -> execution -> loop -> scheduler path.
function startFileAnalysis(options) {
  return startInBackground(options, 'file-analysis');
}

function startWebExtraction(options) {
  return startInBackground(options, 'web-extraction');
}

function startInvestigation(options) {
  return startInBackground(options, 'investigation');
}

function executionFor(kind) {
  const execution = EXECUTION_BY_KIND[kind];
  if (!execution) throw new Error(`Unknown subagent execution kind: ${kind}.`);
  return execution;
}

// An aborted signal (or an AbortError bubbling out of fetch/fs) is a
// cancellation, not a failure; every other error fails the session. In
// foreground the original error is rethrown untouched so callers see the same
// semantics as before; in background there is no caller, so the outcome is
// recorded on the session/execution and announced on backgroundEvents instead.
function isCancellation(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

// Identity first, work second: every run — either lifetime — is exactly one
// child session holding one execution attempt.
function openRun({ parentSessionId, agentId, engine }, { kind, background }) {
  const session = createSession({ parentSessionId, agentId, model: engine?.modelId ?? null });
  startSession(session);
  const attempt = createExecution({ sessionId: session.id, kind, background });
  return { session, attempt };
}

async function runInSession({ parentSessionId = null, agentId = null, engine, signal, background,
  ...executionOptions }, kind) {
  if (background !== undefined) {
    throw new Error('Foreground runs take no "background" option; start a detached run with the matching '
      + 'start* entry point instead.');
  }
  const execution = executionFor(kind);
  const { session, attempt } = openRun({ parentSessionId, agentId, engine }, { kind, background: false });
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

function startInBackground(options, kind) {
  const { parentSessionId = null, agentId = null, engine, signal, ...executionOptions } = options ?? {};
  const execution = executionFor(kind);
  const { session, attempt } = openRun({ parentSessionId, agentId, engine }, { kind, background: true });

  // The run owns its AbortController: once the start call has returned there
  // is no caller frame left to abort, so cancellation must reach the run's own
  // signal. cancelBackground() aborts this controller, and a caller-supplied
  // signal is forwarded into it for the same reason — afterwards both are the
  // existing signal path the scheduler (dequeue/abort) and the agent loop
  // (throwIfAborted between turns) already honor.
  const controller = new AbortController();
  let detach = null;
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const forwardAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', forwardAbort, { once: true });
      detach = () => signal.removeEventListener('abort', forwardAbort);
    }
  }
  backgroundStore.track({ executionId: attempt.id, childSessionId: session.id, kind, controller, detach });

  const handle = () => ({ childSessionId: session.id, executionId: attempt.id, status: attempt.status });

  // Settlement writes the outcome where it belongs — the child session owns
  // the result/usage/error even with no caller present — then announces it
  // exactly once. A failure ends this child only: it is recorded, never
  // rethrown, so it can neither crash nor abort anything else.
  const succeeded = ({ output, usage }) => {
    completeExecution(attempt, { usage, result: output });
    completeSession(session, { usage, result: output });
    backgroundStore.settle(attempt.id, 'completed');
  };
  const failed = error => {
    if (isCancellation(error, controller.signal)) {
      cancelExecution(attempt);
      cancelSession(session);
      backgroundStore.settle(attempt.id, 'cancelled');
    } else {
      failExecution(attempt, error);
      failSession(session, error);
      backgroundStore.settle(attempt.id, 'failed', String(error?.message ?? error));
    }
  };

  let running;
  try {
    running = execution({ session, engine, signal: controller.signal, ...executionOptions });
  } catch (error) {
    failed(error); // an execution that throws before its first await
    return handle();
  }
  // Detached by construction: nothing the caller still holds chains onto this
  // promise, so the child's success, failure, or cancellation can never settle
  // — or reject — the caller's request. The trailing catch only guards against
  // a settlement bug becoming an unhandled rejection.
  Promise.resolve(running)
    .then(succeeded, failed)
    .catch(error => console.error('[subagents] background run could not be settled:', error));
  return handle();
}

module.exports = {
  runFileAnalysis, runWebExtraction, runInvestigation,
  startFileAnalysis, startWebExtraction, startInvestigation,
  cancelBackground: backgroundStore.cancelBackground,
  backgroundEvents: backgroundStore.backgroundEvents,
};
