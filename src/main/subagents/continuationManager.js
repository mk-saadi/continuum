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
  SESSION_STATUS, IS_TERMINAL, getSession,
  waitSession, resumeSession, interruptSession,
  completeSession, failSession, cancelSession,
} = require('./sessionManager');
const {
  EXECUTION_STATUS, createExecution, listExecutions,
  completeExecution, failExecution, cancelExecution,
  flagInterrupt, interruptExecution,
} = require('./executionStore');
const backgroundStore = require('./backgroundStore');
const { runInvestigationExecution } = require('./agentLoop');

// Per-child continuation state, keyed by child session id. Created when the
// runtime opens an investigation child (registerChild) and consulted by every
// control call and by the driver. `pendingContinuation` marks a turn that was
// interrupted mid-flight: its instruction is already inside the context but
// unanswered, so the driver must re-run that turn before touching the inbox.
const records = new Map();

const MAX_MESSAGE_CHARACTERS = 8000; // aligned with the task seed ceiling

// Same stop-vs-failure classification the runtime applies to first turns: an
// aborted signal or an AbortError bubbling out of fetch/fs is a stop, every
// other error is a failure.
function isCancellation(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
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
  if (!session) throw new Error(`Unknown child session: ${String(childId)}.`);
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
  waitSession(session);
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
      try {
        const { output, usage } = await runInvestigationExecution({
          session,
          engine: record.options.engine,
          rootPath: record.options.rootPath,
          fetchImpl: record.options.fetchImpl,
          maxTurns: record.options.maxTurns,
          maxToolCalls: record.options.maxToolCalls,
          signal: controller.signal,
        });
        completeExecution(attempt, { usage, result: output });
        // The session's usage is the child's lifetime total; its result is
        // the latest answer (the full transcript lives in session.context).
        completeSession(session, { usage: mergeUsage(session.usage, usage), result: output });
        backgroundStore.settle(attempt.id, 'completed');
      } catch (error) {
        settleStoppedTurn(record, session, attempt, controller, error);
        return; // any non-completed settlement ends this drive entirely
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
    backgroundStore.settle(attempt.id, 'interrupted');
  } else if (isCancellation(error, controller.signal)) {
    cancelExecution(attempt);
    cancelSession(session);
    backgroundStore.settle(attempt.id, 'cancelled');
  } else {
    failExecution(attempt, error);
    failSession(session, error);
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

module.exports = {
  registerChild, onTurnSettled, noteInterruptedTurn,
  sendMessage, interrupt, resume,
  // Test/diagnostic visibility into the driver state; not part of the control
  // surface, but useful to assert single-turn ownership from the outside.
  getRecord: childId => records.get(childId) ?? null,
};
