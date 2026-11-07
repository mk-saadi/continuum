'use strict';
const { createHash } = require('node:crypto');
// Never record paths, request bodies, errors, argv or session content.
function createEngineLifecycle({ generation, modelPath, pid, activeRequests = () => 0, emit = record => console.info('[engine-lifecycle]', JSON.stringify(record)), now = () => new Date().toISOString() }) {
  const modelId = modelPath ? createHash('sha256').update(modelPath).digest('hex').slice(0, 16) : null;
  let stop = null;
  let terminated = false;
  // A turn lease covers a whole agent turn: every generation and every tool call
  // in that turn. Automatic model unloading or switching must wait for it.
  // Explicit user cancellation aborts the turn itself and is never blocked.
  let turnLeaseCount = 0;
  const turnWaiters = new Set();
  // Only these components perform an automatic unload/switch. A user-triggered
  // unload (model-controls) and app shutdown must still be able to proceed.
  const automaticUnloadComponents = new Set(['engine-idle-policy', 'model-loader']);
  const record = (event, { component = 'local-engine', reason = event, userAction = false, code = null, signal = null, serverTerminated = false } = {}) =>
    emit({ event, timestamp: now(), generation, modelId, component, reason, userAction, activeRequests: activeRequests(), pid: pid ?? null, code, signal, serverTerminated });
  const settleWaiters = outcome => {
    for (const waiter of [...turnWaiters]) waiter.settle(outcome);
  };
  return {
    record,
    get terminated() { return terminated; },
    get stopping() { return stop !== null; },
    get hasActiveTurnLease() { return turnLeaseCount > 0; },
    requestStop(reason, component, userAction = false) {
      if (stop) return false;
      if (turnLeaseCount > 0 && automaticUnloadComponents.has(component)) {
        record('stop-deferred-by-turn-lease', { component, reason });
        return false;
      }
      stop = { reason, component, userAction };
      record('stop-requested', stop);
      return true;
    },
    exited(code, signal) {
      if (terminated) return;
      terminated = true;
      // A dead engine cannot protect anything: release anyone waiting on it.
      settleWaiters({ released: false, timedOut: false, aborted: false, terminated: true });
      if (pid == null) { record('server-unavailable', { component: 'model-loader', reason: 'spawn-error', code, signal }); return; }
      record('server-process-exit', { ...(stop ?? { reason: code === 0 && !signal ? 'unexpected-engine-stop' : 'server-crash' }), code, signal, serverTerminated: true });
    },
    /**
     * Acquire the turn lease. The returned handle is idempotent: releasing it
     * more than once is safe, so every exit path can release unconditionally.
     */
    acquireTurnLease() {
      turnLeaseCount++;
      let released = false;
      return {
        get active() { return !released; },
        release() {
          if (released) return false;
          released = true;
          turnLeaseCount = Math.max(0, turnLeaseCount - 1);
          if (turnLeaseCount === 0) settleWaiters({ released: true, timedOut: false, aborted: false, terminated: false });
          return true;
        },
      };
    },
    /**
     * Resolve once no turn lease is held. Always bounded when a timeout or an
     * abort signal is supplied, so a failed turn can never strand a waiter.
     * Resolves (never rejects) with an outcome describing why it returned.
     */
    waitForTurnLeaseRelease({ timeoutMs = 0, signal = null } = {}) {
      if (turnLeaseCount === 0 || terminated) {
        return Promise.resolve({ released: true, timedOut: false, aborted: false, terminated });
      }
      return new Promise(resolve => {
        let timer = null;
        let settled = false;
        const waiter = {
          settle(outcome) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            turnWaiters.delete(waiter);
            resolve(outcome);
          },
        };
        const onAbort = () => waiter.settle({ released: turnLeaseCount === 0, timedOut: false, aborted: true, terminated });
        turnWaiters.add(waiter);
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => waiter.settle({ released: turnLeaseCount === 0, timedOut: true, aborted: false, terminated }), timeoutMs);
        }
      });
    },
  };
}
module.exports = { createEngineLifecycle };
