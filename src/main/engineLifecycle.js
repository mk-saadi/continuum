'use strict';
const { createHash } = require('node:crypto');
// Never record paths, request bodies, errors, argv or session content.
function createEngineLifecycle({ generation, modelPath, pid, activeRequests = () => 0, emit = record => console.info('[engine-lifecycle]', JSON.stringify(record)), now = () => new Date().toISOString() }) {
  const modelId = modelPath ? createHash('sha256').update(modelPath).digest('hex').slice(0, 16) : null;
  let stop = null;
  let terminated = false;
  const record = (event, { component = 'local-engine', reason = event, userAction = false, code = null, signal = null, serverTerminated = false } = {}) =>
    emit({ event, timestamp: now(), generation, modelId, component, reason, userAction, activeRequests: activeRequests(), pid: pid ?? null, code, signal, serverTerminated });
  return {
    record,
    get terminated() { return terminated; },
    get stopping() { return stop !== null; },
    requestStop(reason, component, userAction = false) {
      if (stop) return false;
      stop = { reason, component, userAction };
      record('stop-requested', stop);
      return true;
    },
    exited(code, signal) {
      if (terminated) return;
      terminated = true;
      if (pid == null) { record('server-unavailable', { component: 'model-loader', reason: 'spawn-error', code, signal }); return; }
      record('server-process-exit', { ...(stop ?? { reason: code === 0 && !signal ? 'unexpected-engine-stop' : 'server-crash' }), code, signal, serverTerminated: true });
    },
  };
}
module.exports = { createEngineLifecycle };
