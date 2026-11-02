'use strict';

const { Agent, fetch } = require('undici');

// Large multimodal prefills can be silent for minutes, both before headers and
// between SSE chunks. Disable response deadlines only for local inference.
// Connection establishment still has its normal timeout; caller aborts work.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const { createContextGuardedFetch } = require('./contextBudget');
const { createMediaGuardedFetch } = require('./modelCapabilities');
let requestOwner = () => null;
function setLocalRequestOwner(provider) { requestOwner = provider; }
const rawFetch = require('./localRequestLifecycle').createTrackedFetch(
  (url, options) => fetch(url, { ...options, dispatcher }), url => requestOwner(url));
let capabilityProvider = () => null;
function setLocalCapabilityProvider(provider) {
  capabilityProvider = provider;
  require('./contextBudget').setContextRuntimeProvider(provider);
}
const localEngineFetch = createContextGuardedFetch(createMediaGuardedFetch(rawFetch, endpoint => {
  // The provider resolves the engine by port so several engines can serve
  // different models at once; an unknown port yields no overrides.
  const engine = capabilityProvider(Number(endpoint.port));
  if (!engine?.modelPath) return {};
  return require('./capabilityOverrides').getOverrides({ type: 'local', modelId: engine.modelPath });
}));

module.exports = { localEngineFetch, setLocalCapabilityProvider, setLocalRequestOwner };
