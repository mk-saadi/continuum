'use strict';

// Parent <-> child communication and lifecycle control (Step 6).
//
// A child session is now a continuable agent session, not a one-shot job:
//
//   Parent
//     |-- sendMessage(childId, msg) --> child.inbox --> next child turn
//     |-- interrupt(childId) -------> active execution stops at a safe boundary
//     `-- resume(childId) ----------> the same child, the same context, again
//
// Three pieces of state make that work, and each lives at the layer that owns
// its meaning:
//
//   session.inbox    (./sessionManager) — ordered parent messages, strict FIFO.
//   session.context  (./agentLoop)      — the child's own conversation, the
//                                         only thing a later turn continues.
//   records          (this module)      — per-child driver state: the turn
//                                         options of the first run, whether a
//                                         driver is scheduled/running, and
//                                         whether the current turn was
//                                         interrupted mid-flight.
//
// Single-turn ownership is enforced here, independently of the Step 3
// scheduler: at most one execution of a given child may mutate its context at
// any time. The scheduler still decides when each individual generation may
// run; this module decides when the child's *next turn* may begin. A message
// that arrives while a turn is active simply waits in the inbox until the
// driver (or the settlement of the first run) picks it up — two turns of one
// child can never overlap.
//
// The driver: one serial loop per child, started on the next tick after a
// wake (setImmediate), one execution per queued instruction:
//
//   wake -> waiting -> [driver] -> running -> turn settles -> completed
//                                      |             |
//                                      |             `-> inbox still full?
//                                      |                    -> waiting (next turn)
//                                      `-> interrupted/failed/cancelled -> stop
//
// Interrupt vs cancellation: both abort the attempt's AbortController — the
// exact signal infrastructure the scheduler and loop already honor — but only
// an interrupt sets the attempt's `interrupted` flag first, so settlement can
// tell them apart. Interrupt stops the current turn, keeps the session (and
// its context) in `interrupted`, and is sticky: no queued work runs until an
// explicit resume()/sendMessage() wakes the child. Cancellation settles the
// attempt and the session as `cancelled`, which is terminal — a cancelled
// child cannot be messaged or resumed.
//
// Deliberate limitations of this step: everything is in-memory. There is no
// persistence, no resume across application restarts, no durable inbox, no
// child-to-child messaging, and no user-facing tool/UI for any of this — the
// runtime API below is the capability, exposure is later work.

const {
  SESSION_STATUS, IS_TERMINAL, getSession, listSessions, deleteSession, noteEvictedChild, wasEvictedChild,
  waitSession, resumeSession, interruptSession, prepareContinuation, rehydrateSession,
  completeSession, failSession, cancelSession,
} = require('./sessionManager');
const {
  EXECUTION_STATUS, createExecution, listExecutions, runningSessionIds, deleteExecutionsForSession,
  completeExecution, failExecution, cancelExecution,
  flagInterrupt, interruptExecution,
} = require('./executionStore');
const backgroundStore = require('./backgroundStore');
const { runInvestigationExecution } = require('./agentLoop');
const { isEngineReady, engineNotReadyError } = require('./providers');
const { resolveRuntimeLimits } = require('./budgets');
const { getBudgetSettings } = require('./budgetSettings');
const continuationState = require('./continuationState');
const persistence = require('./persistence');
const {
  armExecutionDeadline, releaseExecutionDeadline,
  isDeadlineError, isRequestTimeoutError,
} = require('./executionDeadline');

// Per-child continuation state, keyed by child session id. Created when the
// runtime opens an investigation child (registerChild) and consulted by every
// control call and by the driver. `pendingContinuation` marks a turn that was
// interrupted mid-flight: its instruction is already inside the context but
// unanswered, so the driver must re-run that turn before touching the inbox.
const records = new Map();

const MAX_MESSAGE_CHARACTERS = 8000; // aligned with the task seed ceiling// Same stop-vs-failure classification the runtime applies to first turns: an
// aborted signal or an AbortError bubbling out of fetch/fs is a stop, every
// other error is a failure. A timeout is a clock event, not a user action, so
// it is never classified as a cancellation.
function isCancellation(error, signal) {
  if (Boolean(signal?.aborted)) return true;
  if (isDeadlineError(error) || isRequestTimeoutError(error)) return false;
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function mergeUsage(current, addition) {
  if (!addition) return current ?? null;
  if (!current) return addition;
  const merged = { ...current };
  for (const key of Object.keys(addition)) {
    if (Number.isFinite(addition[key])) {
      merged[key] = (Number.isFinite(merged[key]) ? merged[key] : 0) + addition[key];
    }
  }
  return merged;
}

function requireSession(childId) {
  const session = typeof childId === 'string' ? getSession(childId) : null;
  if (!session) {
    // Evicted ids report expiry explicitly: the runtime released the state
    // but the transcript persists, so "unknown" would be misleading.
    if (wasEvictedChild(childId)) {
      throw new Error(`Child session ${childId} has expired and its runtime state was released; its transcript remains available.`);
    }
    throw new Error(`Unknown child session: ${String(childId)}.`);
  }
  return session;
}

// Ownership from Step 2: only the parent session recorded on the child may
// control it. A caller that does not present the exact owning id — including
// one that presents none — is refused before anything is queued or stopped.
function authorize(session, parentSessionId) {
  if (session.parentSessionId !== parentSessionId) {
    throw new Error('Only the owning parent session may control this child.');
  }
}

function requireContinuable(session, verb) {
  const record = records.get(session.id);
  if (!record) {
    throw new Error(`Child ${session.id} cannot be ${verb}; only agent-loop children are continuable.`);
  }
  if (IS_TERMINAL.has(session.status)) {
    throw new Error(`Child ${session.id} is ${session.status} and cannot be ${verb}.`);
  }
  return record;
}

/**
 * Register a child as continuable. Only the agent-loop execution has a context
 * worth continuing (the one-shot file/web executions build an isolated,
 * single-request context by design), so other kinds are simply not registered
 * and their control calls report that clearly.
 * Called by the runtime when the child's first run is opened.
 */
function registerChild(session, options) {
  if (options?.kind !== 'investigation') return null;
  const record = {
    childSessionId: session.id,
    options: {
      kind: options.kind,
      engine: options.engine,
      rootPath: options.rootPath,
      fetchImpl: options.fetchImpl,
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
    },
    driving: false,
    scheduled: false,
    pendingContinuation: false,
  };
  records.set(session.id, record);
  // Phase 1.3C: the delegated objective's routing identity is mirrored onto the
  // session so persistence can store enough to rebuild the child after a
  // restart. Only serializable routing data is kept (never the fetch seam).
  session.continuationOptions = {
    kind: options.kind,
    engine: options.engine ? { ...options.engine } : null,
    rootPath: options.rootPath ?? null,
  };
  session.pendingContinuation = false;
  return record;
}

function scheduleDriver(record) {
  if (record.driving || record.scheduled) return;
  record.scheduled = true;
  // One tick of delay is deliberate: sendMessage()/resume() accept the work
  // synchronously (the child is observably `waiting`), and the driver decides
  // on the next tick — by which time an interrupt may already have won.
  setImmediate(() => {
    record.scheduled = false;
    const session = getSession(record.childSessionId);
    if (!session || session.status !== SESSION_STATUS.WAITING) return;
    drive(record).catch(error => console.error('[subagents] child driver could not be settled:', error));
  });
}

// The single wake path: ask the driver to come for this child's queued work.
// A running child is never re-woken here — if that run is the child's first
// turn, its settlement hook wakes it; if it is a driver turn, the driver loop
// itself sees the new inbox entry.
function scheduleWake(session) {
  const record = records.get(session.id);
  if (!record || record.driving || record.scheduled) return false;
  if (session.status === SESSION_STATUS.RUNNING) return false;
  // Phase 1.3C: prepareContinuation is a superset of waitSession — it also
  // wakes a budget-exhausted/timed-out/cancelled child, but it is only reached
  // here through the authorized continuation control surface.
  prepareContinuation(session);
  if (session.status !== SESSION_STATUS.WAITING) return false;
  scheduleDriver(record);
  return true;
}

/**
 * The per-child turn driver: a serial loop that owns the child's context.
 * One iteration = one execution = one instruction:
 *   - first, an interrupted turn is re-driven (no new user message: its
 *     instruction is already in the context, unfinished), then
 *   - the next inbox message in FIFO order, appended as one user message.
 * The loop stops on any non-completed settlement (interrupt, cancellation, or
 * failure) and on interrupt-wins-over-queue: once the session is interrupted,
 * queued messages wait for an explicit resume.
 */
async function drive(record) {
  const session = getSession(record.childSessionId);
  if (!session) return;
  record.driving = true;
  try {
    for (;;) {
      if (session.status === SESSION_STATUS.INTERRUPTED) return; // sticky until woken
      let mode;
      if (record.pendingContinuation) {
        record.pendingContinuation = false;
        session.pendingContinuation = false;
        mode = 'continue';
      } else if (session.inbox.length > 0) {
        mode = 'message';
      } else {
        return; // drained: the session rests in `completed` (or `waiting`)
      }
      waitSession(session);
      if (resumeSession(session).status !== SESSION_STATUS.RUNNING) return; // defensive: never drive a non-waiting child
      if (mode === 'message') {
        const entry = session.inbox.shift();
        if (!Array.isArray(session.context)) session.context = [];
        // A lone user message is a safe boundary of its own: committing it
        // here means an interrupt at the very start of this turn still leaves
        // a valid context that answers exactly this instruction on resume.
        session.context.push({ role: 'user', content: entry.message });
      }

      // Exactly one execution owns the context now. Its controller is the
      // same signal the scheduler dequeues on and the loop checks between
      // turns — interrupt and cancellation both travel through it, and the
      // `interrupted` flag is what tells them apart at settlement.
      const controller = new AbortController();
      const attempt = createExecution({
        sessionId: session.id, kind: record.options.kind, background: true, controller,
      });
      backgroundStore.track({
        executionId: attempt.id, childSessionId: session.id, kind: record.options.kind, controller,
      });
      // Each continuation turn is its own execution with its own deadline, armed
      // from the saved runtime limits and released in the finally below.
      const deadline = armExecutionDeadline(session, resolveRuntimeLimits(getBudgetSettings()));
      try {
        const result = await runInvestigationExecution({
          session,
          engine: record.options.engine,
          rootPath: record.options.rootPath,
          fetchImpl: record.options.fetchImpl,
          maxTurns: record.options.maxTurns,
          maxToolCalls: record.options.maxToolCalls,
          signal: controller.signal,
          deadline,
        });
        if (result.outcome === 'failed') throw require('./executionBudget').resultError(result);
        completeExecution(attempt, { ...result, result: result.output });
        // The session's usage is the child's lifetime total; its result is
        // the latest answer (the full transcript lives in session.context).
        completeSession(session, { ...result, result: result.output });
        backgroundStore.settle(attempt.id, result.outcome ?? 'completed');
        if (result.outcome && result.outcome !== 'completed') return;
      } catch (error) {
        settleStoppedTurn(record, session, attempt, controller, error);
        return; // any non-completed settlement ends this drive entirely
      } finally {
        releaseExecutionDeadline(session.id);
      }
    }
  } finally {
    record.driving = false;
  }
}

// Settlement of a driver turn, mirroring the first-run settlement in
// ../index.js but adding the interrupt outcome.
function settleStoppedTurn(record, session, attempt, controller, error) {
  if (attempt.interrupted) {
    interruptExecution(attempt);
    interruptSession(session); // running -> interrupted: resumable, context intact
    // The turn stopped with its instruction unanswered inside the context:
    // the next wake must re-drive it before touching the inbox.
    record.pendingContinuation = true;
    session.pendingContinuation = true;
    backgroundStore.settle(attempt.id, 'interrupted');
  } else if (isCancellation(error, controller.signal)) {
    cancelExecution(attempt);
    cancelSession(session);
    backgroundStore.settle(attempt.id, 'cancelled');
  } else if (isDeadlineError(error) || isRequestTimeoutError(error)) {
    // Precedence: explicit cancellation > clock timeout > failure.
    const reason = isDeadlineError(error) ? 'timed_out' : 'request_timeout';
    const output = `[Sub-agent timed out: ${reason}]\n${error?.message ?? 'The child execution deadline was exceeded.'}`;
    completeExecution(attempt, { output, outcome: 'timed_out', stopReason: reason });
    completeSession(session, { output, outcome: 'timed_out', stopReason: reason, result: output });
    attempt.usage = session.usage; attempt.accounting = session.accounting; attempt.stopReason = session.stopReason;
    backgroundStore.settle(attempt.id, 'timed_out', error?.message ?? reason);
  } else {
    failExecution(attempt, error);
    failSession(session, error);
    attempt.usage = session.usage; attempt.accounting = session.accounting; attempt.stopReason = session.stopReason;
    backgroundStore.settle(attempt.id, 'failed', String(error?.message ?? error));
  }
}

/**
 * Called by the runtime when a child's *first* run settles as interrupted —
 * the counterpart of settleStoppedTurn for caller-owned turns. (A turn that
 * finished normally despite an interrupt request needs no note: its instruction
 * was answered, so there is nothing to re-drive.)
 */
function noteInterruptedTurn(session) {
  const record = records.get(session.id);
  if (record) record.pendingContinuation = true;
  if (session && typeof session === 'object') session.pendingContinuation = true;
}

/**
 * The hook the runtime calls after a child's *first* run settles: a completed
 * first turn opens the inbox — if messages arrived while the child was busy,
 * the driver is woken now to process them in order. Interrupted, failed, and
 * cancelled settlements deliberately do not wake anything: interrupt waits for
 * resume(), and terminal states cannot continue.
 */
function onTurnSettled(session) {
  if (session.status !== SESSION_STATUS.COMPLETED) return;
  if (!session.inbox.length) return;
  scheduleWake(session);
}

/**
 * Queue a parent instruction for a child. The message becomes one user turn in
 * the child's own context — never the parent's conversation. A child that is
 * actively executing keeps executing: the message waits in the inbox and is
 * picked up at the next turn boundary, so two turns of one child can never run
 * concurrently. A child that is idle (completed, interrupted, or waiting) is
 * woken and the turn goes through the Step 3 inference scheduler like any
 * other.
 *
 * Returns { childSessionId, status, pending } synchronously; the turn itself
 * runs on the driver.
 */
function sendMessage(childId, message, { parentSessionId = null } = {}) {
  const session = requireSession(childId);
  authorize(session, parentSessionId);
  const record = requireContinuable(session, 'messaged');
  if (typeof message !== 'string' || !message.trim() || message.includes('\0') ||
      message.length > MAX_MESSAGE_CHARACTERS) {
    throw new Error(`message must be a non-empty string of at most ${MAX_MESSAGE_CHARACTERS} characters.`);
  }
  session.inbox.push({ message, enqueuedAt: new Date().toISOString() });
  scheduleWake(session);
  return { childSessionId: session.id, status: session.status, pending: session.inbox.length };
}

/**
 * Stop the child's current active work at the earliest safe boundary, keeping
 * the session and its context for later continuation. This is NOT a
 * cancellation: the attempt's controller is aborted through the existing
 * signal infrastructure (so a queued generation is dequeued and a running one
 * stops at the next loop boundary), but the `interrupted` flag marks it as an
 * interrupt, the session settles as `interrupted` instead of `cancelled`, and
 * the child stays resumable. A child that is waiting (queued, no attempt yet)
 * is stopped before its scheduled driver can start.
 *
 * Returns { childSessionId, status, interrupted }. `interrupted: false` means
 * there was no current work to stop (the child was already resting or
 * terminal) and the session was left untouched.
 */
function interrupt(childId, { parentSessionId = null } = {}) {
  const session = requireSession(childId);
  authorize(session, parentSessionId);
  requireContinuable(session, 'interrupted');
  const handle = extra => ({ childSessionId: session.id, status: session.status, ...extra });

  if (session.status === SESSION_STATUS.RUNNING) {
    const active = listExecutions(session.id)
      .find(execution => execution.status === EXECUTION_STATUS.RUNNING);
    if (!active) return handle({ interrupted: false });
    if (!flagInterrupt(active)) return handle({ interrupted: false }); // settled under us: too late to interrupt
    if (active.controller && !active.controller.signal.aborted) {
      active.controller.abort(Object.assign(
        new Error('The child execution was interrupted.'),
        { name: 'AbortError' },
      ));
    }
    return handle({ interrupted: true }); // settlement moves the session to `interrupted`, and a first-run
    // settlement reports the unfinished turn through noteInterruptedTurn().
  }

  if (session.status === SESSION_STATUS.WAITING) {
    // Queued but not started: flipping the session makes the scheduled driver
    // refuse to start when its tick arrives.
    interruptSession(session);
    return handle({ interrupted: true });
  }

  return handle({ interrupted: false });
}

/**
 * Continue an in-memory child session: interrupted, waiting, or otherwise
 * resumable. Resume continues the SAME session with the SAME context — it never
 * creates a new child, never copies only the last result, and never rebuilds a
 * fresh context. An interrupted turn is re-driven first (its instruction is
 * already in the context), then queued messages drain in order. With no pending
 * instruction at all, resume is a safe no-op: no inference is invented.
 *
 * Returns { childSessionId, status, resumed }.
 */
function resume(childId, { parentSessionId = null } = {}) {
  const session = requireSession(childId);
  authorize(session, parentSessionId);
  const record = requireContinuable(session, 'resumed');

  if (session.status === SESSION_STATUS.RUNNING) {
    return { childSessionId: session.id, status: session.status, resumed: false };
  }
  if (session.status === SESSION_STATUS.COMPLETED && session.inbox.length === 0 &&
      !record.pendingContinuation) {
    // Nothing pending: a completed child stays completed — resuming must not
    // invent a fake task out of thin air.
    return { childSessionId: session.id, status: session.status, resumed: false };
  }
  scheduleWake(session);
  return { childSessionId: session.id, status: session.status, resumed: true };
}

// ---- Phase 1.3C: durable, renewable continuation ------------------------------
//
// The audit's central gap: a child that stopped because a *configured
// allowance* ran out could not be continued, and its in-memory state did not
// survive a restart. The control surface below makes continuation explicit,
// authorized, renewable and durable while reusing the existing driver, agent
// loop, compaction and scheduler unchanged.

const CONTINUATION_MESSAGE_LIMIT = MAX_MESSAGE_CHARACTERS;

function describeAppliedRenewal(applied) {
  if (!applied || !applied.renewals?.length) return null;
  return applied.renewals
    .map(record => `${record.field} ${record.previous}→${record.total === null ? 'unbounded' : record.total}`)
    .join(', ');
}

function continuationInstruction(session, eligibility, applied) {
  const reason = session.stopReason ?? eligibility.reason;
  const granted = describeAppliedRenewal(applied);
  return `[Continuation] The previous attempt stopped because: ${reason}.`
    + (granted ? ` Additional budget was authorized: ${granted}.` : '')
    + ' Continue the original objective from where it left off. Do not repeat tool calls whose results are already'
    + ' present in this conversation; build on them. If the objective is complete, report the result.';
}

/**
 * Read-only snapshot of a stopped child plus the machine-readable continuation
 * decision and the full allowance breakdown (original / granted / current /
 * consumed / remaining / aggregate). Never mutates anything, so it is safe to
 * poll from the UI.
 */
function continuationStatus(childId, { parentSessionId = null } = {}) {
  const session = requireSession(childId);
  if (parentSessionId != null) authorize(session, parentSessionId);
  const record = records.get(session.id) ?? null;
  const eligibility = continuationState.evaluateContinuation(session, {
    pendingContinuation: record?.pendingContinuation === true || session.pendingContinuation === true,
  });
  return {
    childSessionId: session.id,
    parentSessionId: session.parentSessionId,
    status: session.status,
    stopReason: session.stopReason ?? null,
    model: session.model,
    provider: session.provider,
    kind: record?.options?.kind ?? session.continuationOptions?.kind ?? null,
    continuable: Boolean(record),
    eligibility,
    allowance: continuationState.summarizeAllowance(session.budgetState),
    usage: session.usage ?? null,
    accounting: session.accounting ?? null,
    attempts: listExecutions(session.id).length + (session.attemptBase ?? 0),
    pendingMessages: Array.isArray(session.inbox) ? session.inbox.length : 0,
    durableResumable: session.durableResumable === true,
    durable: session.continuation ?? null,
    result: session.result ?? null,
    error: session.error ?? null,
  };
}

/**
 * Authorized, monotonic renewal of a stopped child's finite budgets. The
 * caller must be the owning parent. Consumption is never reset; the shared
 * parent aggregate is never modified (so a renewal can never bypass it).
 * Returns the applied deltas and the new allowance summary.
 */
function renewChildBudget(childId, patch = {}, { parentSessionId = null, reason = null, source = 'user' } = {}) {
  const session = requireSession(childId);
  authorize(session, parentSessionId);
  const record = records.get(session.id);
  if (!record) {
    throw new Error(`Child ${session.id} cannot be renewed; only agent-loop children support budget renewal.`);
  }
  if (session.status === SESSION_STATUS.RUNNING) {
    throw new Error(`Child ${session.id} is running and cannot be renewed; stop or let it settle first.`);
  }
  if (session.status === SESSION_STATUS.COMPLETED && !record.pendingContinuation && session.inbox.length === 0) {
    throw new Error(`Child ${session.id} is completed and does not need a renewal.`);
  }
  if (!session.budgetState) throw new Error(`Child ${session.id} has no budget state to renew.`);
  const applied = require('./executionBudget').renewBudget(session.budgetState, patch, {
    reason, source, parentSessionId: session.parentSessionId ?? null,
  });
  return {
    childSessionId: session.id,
    applied: applied.applied,
    renewals: applied.renewals,
    budgets: applied.budgets,
    allowance: continuationState.summarizeAllowance(session.budgetState),
  };
}

/**
 * Continue a stopped child: renew (if required and authorized), enqueue the
 * continuation work, and wake the existing per-child driver — the same driver,
 * same context, same model, same permissions. Returns a structured result; it
 * never throws for an ineligible child (authorization errors still throw).
 *
 * `renewal` is the same patch shape as renewChildBudget. `message` overrides the
 * default continuation instruction. `allowCancelled`/`allowTimedOut` are the
 * explicit user actions the eligibility rules require for those statuses.
 */
function continueChild(childId, {
  parentSessionId = null, renewal = null, message = null,
  allowCancelled = false, allowTimedOut = false,
} = {}) {
  const session = requireSession(childId);
  authorize(session, parentSessionId);
  if (message != null && (typeof message !== 'string' || !message.trim()
      || message.includes('\0') || message.length > CONTINUATION_MESSAGE_LIMIT)) {
    throw new Error(`message must be a non-empty string of at most ${CONTINUATION_MESSAGE_LIMIT} characters.`);
  }
  const record = records.get(session.id);
  if (!record) {
    return { childSessionId: session.id, continued: false, reason: 'not_continuable',
      detail: 'Only agent-loop children can be continued.', eligibility: null };
  }
  const eligibility = continuationState.evaluateContinuation(session, {
    pendingContinuation: record.pendingContinuation === true || session.pendingContinuation === true,
  });
  if (!eligibility.eligible) {
    return { childSessionId: session.id, continued: false, reason: eligibility.reason,
      detail: eligibility.detail, eligibility };
  }
  if (eligibility.requiresExplicitAction) {
    if (session.status === SESSION_STATUS.CANCELLED && !allowCancelled) {
      return { childSessionId: session.id, continued: false, reason: 'cancelled_requires_explicit_action',
        detail: 'A cancelled child continues only after explicit user action and a safety review.', eligibility };
    }
    if (session.status === SESSION_STATUS.TIMED_OUT && !allowTimedOut) {
      return { childSessionId: session.id, continued: false, reason: 'timed_out_requires_explicit_action',
        detail: 'A timed-out child continues only on explicit action and with a new valid deadline.', eligibility };
    }
  }
  let applied = null;
  if (eligibility.requiresRenewal) {
    if (!renewal || typeof renewal !== 'object' || Array.isArray(renewal)) {
      return { childSessionId: session.id, continued: false, reason: 'renewal_required',
        detail: 'This child stopped at a configured budget; an explicit renewal is required to continue.', eligibility };
    }
    const patch = { ...renewal };
    const renewalReason = patch.reason ?? 'continuation';
    const renewalSource = patch.source ?? 'user';
    delete patch.reason; delete patch.source;
    applied = renewChildBudget(session.id, patch, {
      parentSessionId: session.parentSessionId, reason: renewalReason, source: renewalSource,
    });
    // Re-evaluate after renewal: the child is now eligible to run.
  }
  // Enqueue the work. An interrupted turn is re-driven from the context by the
  // driver, so no message is invented for it; every other continuation gets one
  // explicit instruction (never a replay of completed tool calls).
  const explicit = typeof message === 'string' && message.trim();
  if (explicit) {
    session.inbox.push({ message, enqueuedAt: new Date().toISOString() });
  } else if (!record.pendingContinuation) {
    session.inbox.push({
      message: continuationInstruction(session, eligibility, applied),
      enqueuedAt: new Date().toISOString(), continuation: true,
    });
  }
  prepareContinuation(session);
  scheduleWake(session);
  return {
    childSessionId: session.id,
    continued: true,
    status: session.status,
    renewal: applied,
    eligibility,
    allowance: continuationState.summarizeAllowance(session.budgetState),
    pending: session.inbox.length,
  };
}

// --- Restart recovery (Step 8) ------------------------------------------------
//
// Recovery only *makes durable work available*; it never executes anything.
// After a restart the caller lists recoverable children, inspects them, and
// explicitly continues one — a continuation that is the same authorized,
// renewable path as the in-process one.

function ownerSessionExists(parentSessionId) {
  if (typeof parentSessionId !== 'string' || !parentSessionId) return false;
  try {
    return Boolean(require('../db').db.prepare('SELECT id FROM sessions WHERE id = ?').get(parentSessionId));
  } catch {
    return false;
  }
}

/**
 * Children whose durable state survived a restart and are not currently live
 * in memory. This is a listing, not a resumption: nothing runs.
 */
function listRecoverableChildren({ parentSessionId = null } = {}) {
  let rows = [];
  try {
    const statement = parentSessionId
      ? require('../db').db.prepare('SELECT * FROM subagent_runs WHERE continuation_json IS NOT NULL AND parent_session_id = ? ORDER BY updated_at DESC')
      : require('../db').db.prepare('SELECT * FROM subagent_runs WHERE continuation_json IS NOT NULL ORDER BY updated_at DESC');
    rows = parentSessionId ? statement.all(parentSessionId) : statement.all();
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    if (getSession(row.child_session_id)) continue; // still live: not a restart case
    let continuation = null;
    try { continuation = row.continuation_json ? JSON.parse(row.continuation_json) : null; } catch { continuation = null; }
    if (!continuation) continue;
    out.push({
      childSessionId: row.child_session_id,
      parentSessionId: row.parent_session_id,
      status: row.status,
      stopReason: row.stop_reason ?? null,
      kind: row.kind,
      model: row.model,
      eligibility: {
        eligibility: continuation.eligibility ?? 'not_eligible',
        eligible: continuation.eligible === true,
        requiresRenewal: continuation.requiresRenewal === true,
        requiresExplicitAction: continuation.requiresExplicitAction === true,
        recoveryRequired: continuation.recoveryRequired === true,
        reason: continuation.reason ?? 'unknown',
        detail: continuation.detail ?? null,
      },
      attemptCount: Number.isSafeInteger(row.attempt_count) ? row.attempt_count : continuation.attemptCount ?? 0,
      updatedAt: row.updated_at,
    });
  }
  return out;
}

// Phase 1.4 — the shared aggregate counter is per parent *invocation* and is
// not itself durable. Recovery must NOT silently grant a fresh aggregate: the
// persisted snapshot (ceiling + consumption at the last safe boundary) is
// reattached so the child's original finite aggregate still governs. One
// reconstructed scope is shared per scope id, so recovered siblings of the same
// invocation keep competing for the same allowance instead of each getting a
// copy. Rows written before Phase 1.4 carry no snapshot and fall back to the
// configured aggregate (never "unlimited").
const recoveredScopes = new Map();
const MAX_RECOVERED_SCOPES = 256;

function snapshotScope(scope) {
  return {
    id: typeof scope?.id === 'string' ? scope.id : null,
    toolCalls: Number.isSafeInteger(scope?.toolCalls) && scope.toolCalls >= 0 ? scope.toolCalls : 0,
    maxToolCalls: scope?.maxToolCalls === null || scope?.maxToolCalls === undefined ? null : scope.maxToolCalls,
  };
}

function liveScopeById(id) {
  if (!id) return null;
  for (const session of listSessions()) {
    if (session?.budgetState?.scope?.id === id) return session.budgetState.scope;
  }
  return null;
}

function acquireRecoveredScope(budgetData) {
  const snapshot = budgetData?.scope;
  const id = typeof snapshot?.id === 'string' && snapshot.id ? snapshot.id : null;
  // A still-live sibling of the same parent invocation owns the authoritative
  // counter; reattach to it rather than reconstructing a parallel one.
  const live = liveScopeById(id);
  if (live) return live;
  if (id && recoveredScopes.has(id)) return recoveredScopes.get(id);
  const scope = snapshot && typeof snapshot === 'object'
    ? snapshotScope(snapshot)
    : require('./executionBudget').createParentRunBudget();
  if (id) {
    recoveredScopes.set(id, scope);
    if (recoveredScopes.size > MAX_RECOVERED_SCOPES) recoveredScopes.delete(recoveredScopes.keys().next().value);
  }
  return scope;
}

/**
 * Rebuild a child from durable state into the in-memory runtime so it can be
 * inspected and explicitly continued. Never starts execution. Refuses when the
 * stored routing identity is missing or the (requested) owner no longer exists.
 */
function recoverChild(childId, {
  parentSessionId = null, engine = null, rootPath = null, verifyOwner = false,
} = {}) {
  const live = getSession(childId);
  if (live) {
    return { childSessionId: childId, recovered: false, alreadyLive: true,
      ...continuationStatus(childId, { parentSessionId }) };
  }
  const row = persistence.readPersistedContinuation(childId);
  if (!row.found) throw new Error(`Unknown child session: ${String(childId)}.`);
  if (parentSessionId != null && row.parentSessionId !== parentSessionId) {
    throw new Error('Only the owning parent session may recover this child.');
  }
  if (verifyOwner && !ownerSessionExists(parentSessionId)) {
    throw new Error(`The owner session ${String(parentSessionId)} no longer exists; this child cannot be recovered.`);
  }
  const continuation = row.continuation ?? {};
  const options = continuation.options ?? {};
  if (options.kind && options.kind !== 'investigation') {
    throw new Error(`Child ${childId} is a ${options.kind} child and is not continuable.`);
  }
  const childEngine = engine ?? options.engine ?? null;
  if (!childEngine) {
    throw new Error(`Child ${childId} has no recorded model configuration and cannot be recovered without one.`);
  }
  if (!isEngineReady(childEngine)) throw engineNotReadyError(childEngine, 'continuing a recovered child');
  const session = rehydrateSession({
    id: row.childSessionId,
    parentSessionId: row.parentSessionId,
    model: row.model,
    provider: row.provider,
    status: row.status,
    stopReason: row.stopReason,
    context: row.context,
    rawContext: row.rawContext,
    compactionState: row.compactionState,
    accounting: row.accounting,
    budgetState: continuationState.deserializeBudgetState(row.budget, {
      scope: acquireRecoveredScope(row.budget),
    }),
    continuation,
    attemptBase: row.attemptCount,
    continuationOptions: {
      kind: options.kind ?? 'investigation',
      engine: childEngine,
      rootPath: rootPath ?? options.rootPath ?? null,
    },
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });
  registerChild(session, {
    kind: 'investigation',
    engine: childEngine,
    rootPath: rootPath ?? options.rootPath ?? null,
  });
  // A recovered child gets the same LSP authorization a fresh spawn would:
  // the default child ceiling (Workspace Write), never Full Access, and only
  // while the owning parent is still eligible. Nothing is restored because a
  // previous run had it; a parent that was downgraded keeps its children
  // denied, and an owner that no longer exists grants nothing.
  try {
    const contexts = require('../lspExecutionContext');
    const parentMode = contexts.currentMode(row.parentSessionId, 'read_only');
    if (contexts.eligible(parentMode)) {
      const parentContext = contexts.forTool(row.parentSessionId, parentMode);
      if (parentContext) contexts.authorizeChild(session, parentContext, ['read_only', 'ask_approval', 'workspace_write'].includes(options.lspPermissionMode) ? options.lspPermissionMode : 'read_only');
    }
  } catch { /* recovery must never fail because of LSP authorization */ }
  return { childSessionId: session.id, recovered: true, alreadyLive: false,
    ...continuationStatus(session.id, { parentSessionId }) };
}

// ---- Bounded retention (process-lifetime memory) ----
//
// The sessions/executions/records maps grow with every delegation and nothing
// removed entries: long app sessions with frequent subagent use retain every
// completed child, its context, and its results. Every terminal settlement
// already mirrors to SQLite (persistChildRun), and getChildTranscript falls
// back to the database when the live record is gone — so completed runtime
// records are safe to release once nothing live needs them.
//
// Policy (rationale in docs/subagent-retention-phase3-report.md):
// - never evict: created/running/waiting sessions, non-empty inboxes, sessions
//   with a running execution, driving/scheduled drivers, records without a
//   completion timestamp.
// - evict: completed/interrupted/failed/cancelled/partial sessions older than
//   ttlMs, plus oldest-first beyond maxCompleted (burst backstop; liveness
//   rules still apply, age rule does not).
// - trigger: spawn boundary (openRun in ./index.js) — amortized O(sessions +
//   executions) per spawn via runningSessionIds(), no timers, no sweeps.
// Evicted ids are remembered (bounded) so control calls report expiry instead
// of "unknown"; transcripts keep serving from SQLite.
const COMPLETED_TTL_MS = 30 * 60 * 1000;
const MAX_COMPLETED_SESSIONS = 500;

// Liveness only, no age: true means "hands off regardless of retention".
function isProtectedSession(session, runningIds = null) {
  if (!session || typeof session !== 'object') return true;
  if (!['completed', 'interrupted', 'failed', 'cancelled', 'partial', 'timed_out'].includes(session.status)) return true;
  if (typeof session.completedAt !== 'string' || !session.completedAt
    || !Number.isFinite(Date.parse(session.completedAt))) return true;
  if (Array.isArray(session.inbox) && session.inbox.length > 0) return true;
  const record = records.get(session.id);
  // Driving/scheduled drivers are live work; a pendingContinuation flag means
  // an interrupted turn is still owed a re-drive — valid pending continuation.
  if (record && (record.driving || record.scheduled || record.pendingContinuation)) return true;
  const running = runningIds ?? runningSessionIds();
  if (running.has(session.id)) return true;
  return false;
}

function isSessionEvictable(session, { now = Date.now(), ttlMs = COMPLETED_TTL_MS, runningIds = null } = {}) {
  if (isProtectedSession(session, runningIds)) return false;
  return Date.parse(session.completedAt) <= now - ttlMs;
}

function evictOneSession(session) {
  records.delete(session.id);
  const executions = deleteExecutionsForSession(session.id);
  const removed = deleteSession(session.id);
  if (removed) noteEvictedChild(session.id);
  return { removed, executions };
}

async function forgetParent(parentSessionId) {
  const children = listSessions().filter(session => session.parentSessionId === parentSessionId);
  for (const session of children) {
    // Terminal cancellation suppresses scheduled continuation as well as tools.
    cancelSession(session);
    for (const attempt of listExecutions(session.id)) attempt.controller?.abort(new Error('Owning conversation deleted.'));
  }
  const deadline = Date.now() + 10_000;
  while (children.some(session => runningSessionIds().has(session.id))) {
    if (Date.now() >= deadline) throw new Error('Child execution has not stopped; conversation deletion was not committed.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (const session of children) evictOneSession(session);
}

function pruneChildSessions({ now = Date.now(), ttlMs = COMPLETED_TTL_MS, maxCompleted = MAX_COMPLETED_SESSIONS } = {}) {
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(maxCompleted) || maxCompleted < 0) {
    throw new TypeError('pruneChildSessions requires a finite ttlMs and a non-negative integer maxCompleted.');
  }
  const evicted = [];
  let evictedExecutions = 0;
  const evict = (session) => {
    const outcome = evictOneSession(session);
    if (outcome.removed) {
      evicted.push(session.id);
      evictedExecutions += outcome.executions;
    }
  };
  const runningIds = runningSessionIds();
  for (const session of listSessions()) {
    if (isSessionEvictable(session, { now, ttlMs, runningIds })) evict(session);
  }
  // Count backstop for delegation bursts: oldest completed-first beyond the
  // cap. Liveness rules hold; only the age rule is waived.
  const resting = listSessions()
    .filter((session) => !isProtectedSession(session, runningIds))
    .sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0));
  for (const session of resting.slice(0, Math.max(0, resting.length - maxCompleted))) evict(session);
  return { evicted, evictedExecutions, sessions: listSessions().length };
}

module.exports = {
  forgetParent,
  registerChild, onTurnSettled, noteInterruptedTurn,
  sendMessage, interrupt, resume,
  // Phase 1.3C control surface: inspect, renew, continue, recover.
  continuationStatus, renewChildBudget, continueChild,
  listRecoverableChildren, recoverChild, ownerSessionExists,
  pruneChildSessions, isSessionEvictable, COMPLETED_TTL_MS, MAX_COMPLETED_SESSIONS,
  // Test/diagnostic visibility into the driver state; not part of the control
  // surface, but useful to assert single-turn ownership from the outside.
  getRecord: childId => records.get(childId) ?? null,
};
