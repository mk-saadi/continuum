'use strict';

const localProvider = require('./localProvider');
const cloudProvider = require('./cloudProvider');

// Registry of the inference providers the runtime may schedule. Each entry
// contributes a stable id, the generation function (`chatCompletion`), and a
// `capability(engine)` descriptor — { provider, model, maxConcurrency } — which
// is everything the scheduler is allowed to know about it. No entry names a
// device, a VRAM size, or a transport detail here; a cloud provider is just
// another registry entry, not a scheduler change.
const registry = new Map([
  [localProvider.PROVIDER_ID, localProvider],
  [cloudProvider.PROVIDER_ID, cloudProvider],
]);

// The provider an engine descriptor points at: an explicit `engine.provider`
// id, the cloud target when only that is present, or the local model server
// when nothing says otherwise (descriptors built by the chat/tool layer
// before Step 7 omit the field).
function providerIdOf(engine) {
  if (typeof engine?.provider === 'string' && engine.provider.trim()) return engine.provider.trim();
  return engine?.chatTarget ? cloudProvider.PROVIDER_ID : localProvider.PROVIDER_ID;
}

// Pick the provider from the execution's engine descriptor. An unknown
// provider fails loudly with a clean error instead of silently bypassing
// scheduling.
function resolveProvider(engine) {
  const providerId = providerIdOf(engine);
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unsupported inference provider: ${providerId}.`);
  return provider;
}

/**
 * Is this descriptor something an execution may actually run with? Readiness
 * is provider-shaped, not transport-specific: the local server needs a live
 * endpoint and a model id, a cloud target needs a saved provider + model.
 * Executions call this instead of checking `engine.port` themselves, which is
 * what lets a cloud child exist at all while local behavior (and its error
 * text) stays exactly as before.
 */
function isEngineReady(engine) {
  if (typeof engine?.modelId !== 'string' || !engine.modelId.trim()) return false;
  const providerId = providerIdOf(engine);
  if (!registry.has(providerId)) return false;
  if (providerId === localProvider.PROVIDER_ID) {
    return Number.isInteger(engine.port) && engine.port >= 1 && engine.port <= 65535;
  }
  const target = engine.chatTarget;
  return target?.type === 'cloud' && typeof target.provider === 'string' && !!target.provider.trim() &&
    typeof target.model === 'string' && !!target.model.trim();
}

/** The matching error for `isEngineReady(engine) === false`. */
function engineNotReadyError(engine, action = 'delegating a task') {
  return new Error(providerIdOf(engine) === localProvider.PROVIDER_ID
    ? `Start the local model server before ${action}.`
    : `The sub-agent model is unavailable. Select one in Settings before ${action}.`);
}

module.exports = { resolveProvider, isEngineReady, engineNotReadyError, providerIdOf };
