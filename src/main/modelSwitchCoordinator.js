'use strict';

// Coordinates automatic model loads/switches with active agent turns.
//
// A turn lease belongs to an engine (see engineLifecycle). Before a replacement
// model is spawned, every engine in the pool that still has an active turn must
// release its lease. The wait is always bounded: a failed, cancelled or crashed
// turn can never strand a model load.

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function engineHasActiveLease(engine) {
  return Boolean(engine && !engine.lifecycle?.terminated && engine.lifecycle?.hasActiveTurnLease);
}

/**
 * Wait until none of the supplied engines holds a turn lease.
 *
 * @param {Object} options
 * @param {Iterable|Function} options.engines - engines, or a function returning them
 * @param {number} [options.timeoutMs] - hard upper bound (0 means "do not wait")
 * @param {AbortSignal} [options.signal] - cancels the wait
 * @param {Function} [options.isCancelled] - extra cancellation predicate (e.g. app shutdown)
 * @param {Function} [options.now] - injectable clock (tests)
 * @returns {Promise<{ ok: boolean, reason?: 'timeout'|'cancelled', waited: boolean }>}
 */
async function waitForTurnLeasesToClear({
  engines,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  isCancelled = () => false,
  now = Date.now,
} = {}) {
  const listEngines = typeof engines === 'function' ? engines : () => engines ?? [];
  const bounded = Number.isFinite(timeoutMs) && timeoutMs >= 0;
  const deadline = bounded ? now() + timeoutMs : Infinity;
  let waited = false;

  while (true) {
    if (isCancelled() || signal?.aborted) return { ok: false, reason: 'cancelled', waited };
    const busy = [...listEngines()].filter(engineHasActiveLease);
    if (!busy.length) return { ok: true, waited };

    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, reason: 'timeout', waited };

    waited = true;
    const outcomes = await Promise.all(busy.map(engine =>
      engine.lifecycle.waitForTurnLeaseRelease({ timeoutMs: remaining, signal })));

    if (isCancelled() || signal?.aborted || outcomes.some(outcome => outcome.aborted))
      return { ok: false, reason: 'cancelled', waited };
    if (outcomes.some(outcome => outcome.timedOut))
      return { ok: false, reason: 'timeout', waited };
    // Re-check from the top: a new turn may have started on any engine while
    // the previous waiters were settling.
  }
}

module.exports = { waitForTurnLeasesToClear, engineHasActiveLease, DEFAULT_TIMEOUT_MS };
