'use strict';

const localProvider = require('./localProvider');

// Registry of the inference providers the runtime may schedule. Each entry
// contributes a stable id, the generation function (`chatCompletion`), and a
// `capability(engine)` descriptor — { provider, model, maxConcurrency } — which
// is everything the scheduler is allowed to know about it. No entry names a
// device, a VRAM size, or a transport detail here; adding a cloud provider later
// is a new registry entry, not a scheduler change.
const registry = new Map([
  [localProvider.PROVIDER_ID, localProvider],
]);

// Pick the provider from the execution's engine descriptor: an explicit
// `engine.provider` id, or the local model server when absent (every engine
// descriptor built by the chat/tool layer today omits it — local is the only
// provider wired for subagent inference yet). An unknown provider fails loudly
// with a clean error instead of silently bypassing scheduling.
function resolveProvider(engine) {
  const providerId = typeof engine?.provider === 'string' && engine.provider.trim()
    ? engine.provider : localProvider.PROVIDER_ID;
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unsupported inference provider: ${providerId}.`);
  return provider;
}

module.exports = { resolveProvider };
