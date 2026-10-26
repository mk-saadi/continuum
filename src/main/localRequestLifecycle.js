'use strict';
// Account for the entire body lifetime, including streaming and body failures.
// The lease belongs to the process captured at dispatch, never its successor.
function createTrackedFetch(fetchImpl, getOwner) {
  return async (url, options = {}) => {
    const owner = getOwner(url);
    if (!owner) return fetchImpl(url, options);
    if (owner.unavailable || (options.engineRuntimeIdentity && owner.generation && options.engineRuntimeIdentity !== owner.generation)) {
      owner.record('server-unavailable', { component: 'local-transport', reason: owner.unavailable ? 'server-unavailable' : 'engine-generation-changed', serverTerminated: owner.terminated ?? false });
      throw Object.assign(new Error('The local engine is unavailable or changed. Load the intended model and continue from the saved conversation.'), { code: 'LOCAL_ENGINE_UNAVAILABLE' });
    }
    const release = owner.beginRequest();
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      if (error) {
        const event = options.signal?.aborted ? 'request-cancelled'
          : error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED' ? 'server-unavailable' : 'transport-disconnected';
        const cancellation = options.signal?.reason?.code;
        const reason = event === 'request-cancelled' && ['renderer-destroyed', 'compaction-cancelled', 'deleted-conversation', 'ipc-disposed'].includes(cancellation) ? cancellation : event;
        owner.record(event, { component: 'local-transport', reason, serverTerminated: false });
      }
      release?.();
    };
    try {
      const { engineRuntimeIdentity: _generation, ...wireOptions } = options;
      const response = await fetchImpl(url, wireOptions);
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { finish(error); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { finish(options.signal?.aborted ? options.signal.reason ?? new Error('Cancelled') : null); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(error); throw error; }
  };
}
module.exports = { createTrackedFetch };
