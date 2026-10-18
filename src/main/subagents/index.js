'use strict';

const {
  createSession, startSession, completeSession, failSession, cancelSession, interruptSession,
  getSession,
} = require('./sessionManager');
const {
  createExecution, completeExecution, failExecution, cancelExecution, interruptExecution,
  listExecutions,
} = require('./executionStore');
const { runFileAnalysisExecution, runWebExtractionExecution } = require('./executionManager');
const { runInvestigationExecution } = require('./agentLoop');
const { resolveChildEngine } = require('./modelSelection');
const { summarizeRunInput, mapContextTurns } = require('./persistence');
const backgroundStore = require('./backgroundStore');
const continuationManager = require('./continuationManager');
const { resolveRuntimeLimits } = require('./budgets');
const { getBudgetSettings } = require('./budgetSettings');
const {
  armExecutionDeadline, releaseExecutionDeadline,
  isDeadlineError, isRequestTimeoutError,
} = require('./executionDeadline');

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
// fails, is cancelled through cancelBackground()/an aborting caller signal, or
// is interrupted through interrupt(childId), which stops it without destroying
// it. Results, usage, and errors are written to the child session, which
// outlives the caller; completion is reported on backgroundEvents (started,
// completed, failed, cancelled).
//
// Deliberate limitations carried over: the runtime is in-memory, so an
// application shutdown drops active background runs — durable job recovery and
// restart resumption belong with persistent sessions later. Step 4's context
// isolation and read-only tool allowlist are unchanged by backgrounding, and
// unchanged by whichever model a child runs on (Step 7 routes model choice
// through ./modelSelection.js without touching permissions).
//
// Step 6 adds parent <-> child control on top of both lifetimes (see
// ./continuationManager.js): sendMessage() queues a parent instruction into
// the child's inbox, interrupt() stops the current turn without destroying the
// child, and resume() continues the same child session with its own context.
// Every resumed turn is an ordinary execution of the same agent loop through
// the same Step 3 scheduler; only who owns the turn differs — the runtime
// driver does, with single-turn ownership of the child's context enforced
// there. One-shot (file-analysis/web-extraction) children have no context to
// continue and are not continuable. Still absent by design: persistence across
// restarts, user-facing tools/UI for control, and any form of child-to-child
// or multi-agent messaging.
//
//   tool -> runFileAnalysis/runWebExtraction/runInvestigation
//        -> child engine (./modelSelection.js: main-chat model by default,
//           or the independently configured sub-agent model)
//        -> child session -> execution
//        -> inference scheduler (one queue per provider/model, capacity-limited)
//        -> local provider -> local model server
//           or cloud provider -> saved cloud provider
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
//
// A timeout is deliberately NOT a cancellation even though the deadline error
// rides the abort path (it is an AbortError so transports honor it): the code
// exemption below keeps a clock event from being misreported as a user action.
function isCancellation(error, signal) {
  if (Boolean(signal?.aborted)) return true;
  if (isDeadlineError(error) || isRequestTimeoutError(error)) return false;
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

// A timeout that reaches the runtime without being converted by the execution
// layer (the safety net for one-shot kinds and any future execution): settle the
// attempt and session as `timed_out` with an explicit reason, never as a
// success, and announce the terminal event. Findings already recorded on the
// session are left intact.
function settleTimeout(session, attempt, error, { announce = null } = {}) {
  const reason = isDeadlineError(error) ? 'timed_out' : 'request_timeout';
  const output = `[Sub-agent timed out: ${reason}]\n${error?.message ?? 'The child execution deadline was exceeded.'}`;
  const result = { output, outcome: 'timed_out', stopReason: reason,
    usage: session.usage ?? null, accounting: session.accounting ?? null };
  completeExecution(attempt, { ...result, result: result.output });
  completeSession(session, { ...result, result: result.output });
  attempt.usage = session.usage; attempt.accounting = session.accounting; attempt.stopReason = session.stopReason;
  announce?.(reason === 'timed_out' ? 'timed_out' : 'request_timeout', error?.message ?? reason);
  continuationManager.onTurnSettled(session);
}

// Identity first, work second: every run — either lifetime — is exactly one
// child session opening with one execution attempt. Both lifetimes pass the
// attempt's AbortController here, so every execution — caller-owned or
// runtime-owned — can be interrupted through the same signal path later.
// The session records which model the child runs on (decided by
// ./modelSelection.js before this call), so the record is the observability
// source for provider/model even for a detached background run.
function openRun({ parentSessionId, agentId, engine }, { kind, background, controller }) {
  const provider = typeof engine?.provider === 'string' && engine.provider.trim()
    ? engine.provider.trim()
    : engine?.chatTarget ? 'cloud' : 'local';
  const session = createSession({
    parentSessionId,
    agentId,
    model: engine?.modelId ?? null,
    provider,
    providerId: provider === 'cloud' ? (engine?.chatTarget?.provider ?? null) : null,
  });
  startSession(session);
  const attempt = createExecution({ sessionId: session.id, kind, background, controller });
  try {
    // Amortized bound on completed-runtime retention: every spawn releases
    // long-settled children (contexts, results, driver records) whose
    // transcripts persist in SQLite. Never touches live work (running,
    // waiting, queued, driving) and never throws into the spawn path.
    continuationManager.pruneChildSessions();
  } catch (error) {
    console.error('[subagents] retention prune failed:', error?.message ?? error);
  }
  return { session, attempt };
}

// Forward a caller's AbortSignal into a run-owned controller: the controller
// is the single signal the execution sees, so caller cancellation and
// runtime.interrupt() travel the exact infrastructure the scheduler
// (dequeue/abort) and the agent loop (throwIfAborted between turns) already
// honor. The attempt's `interrupted` flag is what distinguishes the two at
// settlement. Returns a detach function (or null when there is nothing to
// forward).
function forwardAbort(source, controller) {
  if (!source) return null;
  if (source.aborted) {
    controller.abort(source.reason);
    return null;
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

// One settlement vocabulary for a first run (both lifetimes): an interrupt
// stops the child but keeps it continuable, a cancellation ends it for good,
// and any other error fails it. The continuation hook then gets a chance to
// open the inbox — but only a *completed* first turn does; an interrupted
// child waits for an explicit resume, and terminal children cannot continue.
// `announce` is the background registry notification (none for foreground:
// the caller is still there and nothing tracks the attempt).
function settleFirstTurn(session, attempt, controller, error, { announce = null } = {}) {
  if (attempt.interrupted) {
    interruptExecution(attempt);
    interruptSession(session);
    continuationManager.noteInterruptedTurn(session); // unfinished turn: re-drive it on the next wake
    announce?.('interrupted');
  } else if (isCancellation(error, controller.signal)) {
    cancelExecution(attempt);
    cancelSession(session);
    announce?.('cancelled');
  } else if (isDeadlineError(error) || isRequestTimeoutError(error)) {
    // Precedence: explicit cancellation > clock timeout > failure.
    settleTimeout(session, attempt, error, { announce });
  } else {
    failExecution(attempt, error);
    failSession(session, error);
    announce?.('failed', String(error?.message ?? error));
  }
  attempt.usage = session.usage; attempt.accounting = session.accounting;
  attempt.stopReason = session.stopReason;
  continuationManager.onTurnSettled(session);
}

async function runInSession({ parentSessionId = null, parentToolCallId = null, agentId = null, engine, signal, background,
  onSpawn = null, ...executionOptions }, kind) {
  if (background !== undefined) {
    throw new Error('Foreground runs take no "background" option; start a detached run with the matching '
      + 'start* entry point instead.');
  }
  const execution = executionFor(kind);
  // The child's model is decided once, here, before anything exists: the
  // sub-agent model setting (or the parent's own model when it is unset) is
  // resolved into the engine descriptor that this whole run — first turn and
  // any continuation — will keep using.
  const childEngine = resolveChildEngine(engine);
  // The first turn also runs under a run-owned controller (the caller's signal
  // is forwarded into it), which is what lets interrupt(childId) stop a
  // foreground child at the same safe boundaries as any other turn. An
  // interrupted foreground run rethrows the abort to its caller — the caller's
  // await ends, while the child session itself stays interrupted and resumable.
  const controller = new AbortController();
  const detach = forwardAbort(signal, controller);
  const { session, attempt } = openRun({ parentSessionId, agentId, engine: childEngine }, { kind, background: false, controller });
  executionOptions.budgetScope ??= getSession(parentSessionId)?.budgetState?.scope
    ?? getSession(parentSessionId)?.budgetScope ?? require('./executionBudget').createParentRunBudget();
  session.budgetScope = executionOptions.budgetScope;
  session.parentToolCallId = typeof parentToolCallId === 'string' ? parentToolCallId : null;
  try {
    session.inputSummary = summarizeRunInput(kind, executionOptions);
  } catch { session.inputSummary = null; }
  if (typeof onSpawn === 'function') {
    try { onSpawn(session.id); } catch { /* Observability must never break execution. */ }
  }
  continuationManager.registerChild(session, { kind, engine: childEngine, ...executionOptions });
  // Arm the child's execution deadline from the saved runtime limits (null
  // under Automatic). It is armed here — after the session exists, before any
  // work — so cleanup always runs in the finally below, and a nested child can
  // inherit this deadline through the parent session id.
  const deadline = armExecutionDeadline(session, resolveRuntimeLimits(getBudgetSettings()));
  try {
    const result = await execution({ session, engine: childEngine, signal: controller.signal, deadline, ...executionOptions });
    if (result.outcome === 'failed') throw require('./executionBudget').resultError(result);
    completeExecution(attempt, { ...result, result: result.output });
    completeSession(session, { ...result, result: result.output });
    continuationManager.onTurnSettled(session);
    return result.output;
  } catch (error) {
    settleFirstTurn(session, attempt, controller, error);
    // A timeout that reached the runtime (rather than being converted by the
    // execution layer) is reported as a normal sub-agent result carrying the
    // timed-out findings — never as a bare abort, which the parent would read
    // as its own cancellation.
    if (isDeadlineError(error) || isRequestTimeoutError(error)) {
      throw require('./executionBudget').resultError({
        output: session.result, outcome: 'timed_out', stopReason: session.stopReason,
      });
    }
    throw error;
  } finally {
    releaseExecutionDeadline(session.id);
    detach?.();
  }
}

function startInBackground(options, kind) {
  const { parentSessionId = null, parentToolCallId = null, agentId = null, engine, signal, onSpawn = null, ...executionOptions } = options ?? {};
  const execution = executionFor(kind);
  // Same single resolution point as the foreground path: the detached run's
  // model is fixed before the handle exists, so a background child and a
  // foreground child of the same spawn behave identically.
  const childEngine = resolveChildEngine(engine);

  // The run owns its AbortController: once the start call has returned there
  // is no caller frame left to abort, so cancellation must reach the run's own
  // signal. cancelBackground() aborts this controller, a caller-supplied
  // signal is forwarded into it, and interrupt(childId) aborts it as an
  // interrupt — afterwards all three are the existing signal path the
  // scheduler (dequeue/abort) and the agent loop (throwIfAborted) honor.
  const controller = new AbortController();
  const detach = forwardAbort(signal, controller);

  const { session, attempt } = openRun({ parentSessionId, agentId, engine: childEngine }, { kind, background: true, controller });
  executionOptions.budgetScope ??= getSession(parentSessionId)?.budgetState?.scope
    ?? getSession(parentSessionId)?.budgetScope ?? require('./executionBudget').createParentRunBudget();
  session.budgetScope = executionOptions.budgetScope;
  session.parentToolCallId = typeof parentToolCallId === 'string' ? parentToolCallId : null;
  try {
    session.inputSummary = summarizeRunInput(kind, executionOptions);
  } catch { session.inputSummary = null; }
  if (typeof onSpawn === 'function') {
    try { onSpawn(session.id); } catch { /* Observability must never break execution. */ }
  }
  continuationManager.registerChild(session, { kind, engine: childEngine, ...executionOptions });
  backgroundStore.track({ executionId: attempt.id, childSessionId: session.id, kind, controller, detach });
  // Armed once for the detached run; released on settlement (both paths) so a
  // background deadline never outlives its run.
  const deadline = armExecutionDeadline(session, resolveRuntimeLimits(getBudgetSettings()));

  const handle = () => ({ childSessionId: session.id, executionId: attempt.id, status: attempt.status });

  // Settlement writes the outcome where it belongs — the child session owns
  // the result/usage/error even with no caller present — then announces it
  // exactly once. A failure ends this child only: it is recorded, never
  // rethrown, so it can neither crash nor abort anything else.
  const succeeded = result => {
    try {
      if (result.outcome === 'failed') { failed(require('./executionBudget').resultError(result)); return; }
      completeExecution(attempt, { ...result, result: result.output });
      completeSession(session, { ...result, result: result.output });
      backgroundStore.settle(attempt.id, result.outcome ?? 'completed');
      continuationManager.onTurnSettled(session);
    } finally {
      releaseExecutionDeadline(session.id);
    }
  };
  const failed = error => {
    try {
      settleFirstTurn(session, attempt, controller, error, {
        announce: (status, detail) => backgroundStore.settle(attempt.id, status, detail),
      });
    } finally {
      releaseExecutionDeadline(session.id);
    }
  };

  let running;
  try {
    running = execution({ session, engine: childEngine, signal: controller.signal, deadline, ...executionOptions });
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

/**
 * Minimal observability for one child: the identity, model, lifecycle, usage,
 * and attempt info the runtime already keeps, exposed as a single snapshot.
 * Deliberately not a dashboard or an event stream — this is the record the
 * sessions/executions hold, nothing more.
 */
function describeChild(childId) {
  const session = getSession(childId);
  if (!session) return null;
  const attempts = listExecutions(session.id);
  const latest = attempts[attempts.length - 1] ?? null;
  return {
    childSessionId: session.id,
    parentSessionId: session.parentSessionId,
    provider: session.provider,
    providerId: session.providerId,
    model: session.model,
    status: session.status,
    stopReason: session.stopReason ?? null, accounting: session.accounting ?? null,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationMs: session.durationMs,
    usage: session.usage,
    turns: attempts.length,
    kind: latest?.kind ?? null,
    background: latest?.background ?? null,
  };
}

// Bounded per-message preview for the transcript view. Tool results can reach
// 12k characters each and a context holds every turn, so nothing crosses IPC
// uncut: overlong text is truncated with an explicit flag, never silently.
const TRANSCRIPT_MESSAGE_LIMIT = 3000;
const TRANSCRIPT_TURN_LIMIT = 60;

function previewTurnText(value) {
  const text = typeof value === 'string' ? value
    : value == null ? '' : JSON.stringify(value);
  if (text.length <= TRANSCRIPT_MESSAGE_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, TRANSCRIPT_MESSAGE_LIMIT), truncated: true };
}

/**
 * Read-only transcript of one child for the activity modal: lifecycle header
 * plus the child's own committed turns (task, tool calls with short args,
 * truncated tool outputs, final answer or error) and the live activity feed.
 * Falls back to SQLite for past runs after the in-memory runtime is cleared.
 * Returns { found: false } only when neither store contains the child.
 */
function getChildTranscript(childSessionId) {
  if (typeof childSessionId !== 'string' || !childSessionId) return { found: false };
  const session = getSession(childSessionId);
  if (!session) return require('./persistence').readPersistedTranscript(childSessionId);
  const attempts = listExecutions(session.id);
  const latest = attempts[attempts.length - 1] ?? null;
  const turns = mapContextTurns(session.rawContext ?? session.context);
  return {
    found: true,
    childSessionId: session.id,
    parentSessionId: session.parentSessionId,
    kind: latest?.kind ?? null,
    status: session.status,
    stopReason: session.stopReason ?? null, accounting: session.accounting ?? null,
    model: session.model,
    provider: session.provider,
    usage: session.usage ?? null,
    result: typeof session.result === 'string' ? previewTurnText(session.result) : null,
    error: session.error ?? latest?.error ?? null,
    durationMs: session.durationMs,
    turnCount: attempts.length,
    turns, activeTurns: mapContextTurns(session.context),
    compactions: session.compactionState?.events ?? [], rawTurnCount: session.rawContext?.length ?? null,
    // Live feed (turn starts, thoughts, tool start/finish). Bounded at write
    // time; the newest entries are what a viewer polls for.
    liveProgress: session.liveProgress ? { ...session.liveProgress } : null,
    elapsedMs: session.createdAt ? Date.now() - Date.parse(session.createdAt) : null,
    activity: Array.isArray(session.activity) ? session.activity.slice(-40) : [],
  };
}

module.exports = {
  createParentRunBudget: require('./executionBudget').createParentRunBudget,
  runFileAnalysis, runWebExtraction, runInvestigation,
  startFileAnalysis, startWebExtraction, startInvestigation,
  // Parent <-> child control (Step 6): the runtime surface. Authorization is
  // the caller's parentSessionId — only the owning parent may drive its child.
  sendMessage: continuationManager.sendMessage,
  interrupt: continuationManager.interrupt,
  resume: continuationManager.resume,
  cancelBackground: backgroundStore.cancelBackground,
  backgroundEvents: backgroundStore.backgroundEvents,
  // Phase 1.3C durable, renewable continuation: explicit, authorized and
  // restart-aware. `continueChild` renews (when required) and wakes the same
  // child; `recoverChild` rebuilds durable work without ever executing it.
  continuationStatus: continuationManager.continuationStatus,
  renewChildBudget: continuationManager.renewChildBudget,
  continueChild: continuationManager.continueChild,
  listRecoverableChildren: continuationManager.listRecoverableChildren,
  recoverChild: continuationManager.recoverChild,
  // Step 7: one read-only snapshot of a child's model and lifecycle.
  describeChild,
  // Observability: bounded read-only transcript for the activity modal.
  getChildTranscript,
};
