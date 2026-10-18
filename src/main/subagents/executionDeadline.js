'use strict';

// Phase 1.3B — execution deadlines and model-request timeouts.
//
// Two independent, opt-in time limits, both enforced in the backend:
//
//   * an execution deadline covers one child execution end to end: model
//     requests, tool calls, retries and context compaction. Automatic mode has
//     no deadline, so long-horizon work is never silently cut off; a finite
//     deadline aborts the in-flight work and never reports success.
//   * a model-request timeout bounds a single model request and aborts the
//     in-flight transport. A total-duration limit lives here; the streaming
//     inactivity (stall) watchdog lives in ./providers/streamCompletion.js,
//     where the response shape is known. The effective request deadline can
//     never exceed the remaining execution deadline, because the request
//     signal always also carries the execution deadline signal.
//
// No wall clock is used: elapsed time is measured with a monotonic clock
// (`performance.now`) while the process is alive, and timers are injectable so
// tests can drive expiry deterministically instead of sleeping.
//
// A deadline never aborts the caller's/run's AbortController. It is a separate
// signal that travels alongside the run signal, so cancellation (an explicit
// user/parent action) and timeout (a clock event) stay distinguishable and a
// timeout is never recorded as a cancellation.

// Two error identities with deliberately different shapes:
//   - the deadline error is an AbortError so it rides `signal.throwIfAborted()`
//     and the transports' abort paths exactly like a cancellation, but its code
//     lets the loop convert it to a `timed_out` result before it settles;
//   - the request-timeout error is *not* an AbortError so it is never mistaken
//     for a stop: it maps to the `request_timeout` stop reason.
const DEADLINE_CODE = 'SUBAGENT_DEADLINE_EXCEEDED';
const REQUEST_TIMEOUT_CODE = 'SUBAGENT_REQUEST_TIMEOUT';

const TIMEOUT_REASONS = Object.freeze({
  [DEADLINE_CODE]: 'timed_out',
  [REQUEST_TIMEOUT_CODE]: 'request_timeout',
});

// Monotonic, process-alive elapsed time. performance.now() is monotonic; the
// hrtime fallback is only for environments that do not expose it.
function monotonicNow() {
  const performance = globalThis.performance;
  if (typeof performance?.now === 'function') return performance.now();
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

const defaultTimers = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle),
});

function makeError(name, code, message) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

/** The abort reason carried by a fired execution deadline. */
function deadlineError(message = 'The sub-agent execution deadline was exceeded.') {
  return makeError('AbortError', DEADLINE_CODE, message);
}

/**
 * A model-request timeout. `kind` is 'total' (whole request) or 'inactivity'
 * (a stream that stopped producing data); the value is preserved on the error
 * so callers and telemetry can tell the two apart.
 */
function requestTimeoutError(kind, message) {
  const error = makeError('Error', REQUEST_TIMEOUT_CODE, message ?? (kind === 'inactivity'
    ? 'The model stream produced no data before the inactivity timeout.'
    : 'The model request exceeded its timeout.'));
  error.timeoutKind = kind;
  return error;
}

function isDeadlineError(error) { return error?.code === DEADLINE_CODE; }
function isRequestTimeoutError(error) { return error?.code === REQUEST_TIMEOUT_CODE; }
function isTimeoutError(error) { return isDeadlineError(error) || isRequestTimeoutError(error); }
/** The terminal stop reason for a timeout error, or null for anything else. */
function timeoutReasonOf(error) { return TIMEOUT_REASONS[error?.code] ?? null; }

/**
 * Combine AbortSignals into one that aborts as soon as any input does, with the
 * first abort reason preserved. Returns null when nothing is given, and the
 * single signal (by identity) when only one is given, so the common no-timeout
 * path allocates nothing.
 */
function combineSignals(...signals) {
  const list = signals.filter(signal => signal && typeof signal.addEventListener === 'function');
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * A finite execution deadline. `ms === null` (or non-positive) means "no
 * deadline": the caller gets `null` and no timer is armed, so the default
 * Automatic policy adds nothing. A `parentDeadline` (nested delegation) may
 * only shorten, never extend: the child fires at min(own, parent-remaining),
 * so a descendant can never outlive the deadline it inherited.
 */
function createDeadline({ ms = null, parentDeadline = null, clock = monotonicNow, timers = defaultTimers, onExpire = null } = {}) {
  const own = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : null;
  const parentRemaining = parentDeadline ? parentDeadline.remainingMs(clock) : Infinity;
  if (own === null && parentRemaining === Infinity) return null;

  const effective = Math.max(1, Math.min(own ?? Infinity, parentRemaining));
  const expiresAt = clock() + effective;
  const controller = new AbortController();
  let expired = false;
  let timer = null;
  const fire = () => {
    if (expired) return;
    expired = true;
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    controller.abort(deadlineError());
    onExpire?.();
  };
  timer = timers.setTimeout(fire, effective);
  return {
    ms: effective,
    signal: controller.signal,
    get expired() { return expired; },
    remainingMs: (now = clock) => Math.max(0, expiresAt - now()),
    clear() { if (timer !== null) { timers.clearTimeout(timer); timer = null; } },
    fire, // deterministic expiry for tests; harmless in production
  };
}

/**
 * One model request's total-duration limit, opt-in. Returns a disabled handle
 * (no allocation, `signal` passed through by identity) when no timeout is
 * configured, so the Automatic default is byte-for-byte the previous behavior.
 * The returned `signal` also carries the caller's run signal, so the request
 * still aborts on cancellation/deadline; `timeout` rejects with a request
 * timeout error, `error` is that exact error once fired, and `clear()` must be
 * called when the request settles. Timers are injectable so tests can drive
 * expiry deterministically.
 */
function createRequestTimeout({ signal = null, timeoutMs = null, timers = defaultTimers, onTimeout = null } = {}) {
  const total = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs) : null;
  if (total === null) {
    return { enabled: false, signal, timeout: null, fired: false, clear() {} };
  }
  const controller = new AbortController();
  let fired = false;
  let firedError = null;
  let rejectTimeout = null;
  const timeout = new Promise((_resolve, reject) => { rejectTimeout = reject; });
  // The race that consumes `timeout` always attaches a handler; this guards the
  // narrow window before that race is built.
  timeout.catch(() => {});
  const timer = timers.setTimeout(() => {
    fired = true;
    const error = requestTimeoutError('total', `The model request did not finish within ${total} ms.`);
    // Remember the exact error so the scheduler can report the authoritative
    // cause even when the transport rejects its own abort first.
    firedError = error;
    onTimeout?.(error);
    controller.abort(error);
    rejectTimeout(error);
  }, total);
  return {
    enabled: true,
    timeout,
    get fired() { return fired; },
    get error() { return firedError; },
    signal: combineSignals(signal, controller.signal),
    clear() { timers.clearTimeout(timer); },
  };
}

// --- Parent-deadline inheritance (nested delegation) -------------------------
//
// A run's deadline is remembered by the child session id while it is live, so a
// nested runtime caller that names that session as its parent inherits the
// tighter of the two. The registry is process-lifetime and bounded by the
// number of concurrently armed executions (one entry per live run, released in
// a finally); it holds no timers of its own.
const armed = new Map();

function armExecutionDeadline(session, runtime, { clock = monotonicNow, timers = defaultTimers } = {}) {
  const parentDeadline = session?.parentSessionId ? armed.get(session.parentSessionId) ?? null : null;
  const deadline = createDeadline({ ms: runtime?.maxRuntimeMs ?? null, parentDeadline, clock, timers });
  if (deadline && typeof session?.id === 'string' && session.id) armed.set(session.id, deadline);
  return deadline;
}

function releaseExecutionDeadline(sessionId) {
  if (typeof sessionId === 'string' && sessionId) armed.delete(sessionId);
}

function getExecutionDeadline(sessionId) {
  return armed.get(sessionId) ?? null;
}

/** Test/diagnostic reset: clears every timer and forgets every entry. */
function clearExecutionDeadlines() {
  for (const deadline of armed.values()) deadline.clear();
  armed.clear();
}

module.exports = {
  DEADLINE_CODE, REQUEST_TIMEOUT_CODE, TIMEOUT_REASONS,
  monotonicNow, createDeadline, createRequestTimeout, combineSignals, defaultTimers,
  deadlineError, requestTimeoutError, isDeadlineError, isRequestTimeoutError, isTimeoutError, timeoutReasonOf,
  armExecutionDeadline, releaseExecutionDeadline, getExecutionDeadline, clearExecutionDeadlines,
};
