'use strict';

// Runtime bridge between persisted settings and a concrete request target.
//
// The renderer never decides what reasoning fields reach a provider. This
// module reads the effective setting for the *actual* session/model, resolves
// it against the target's capabilities (local template metadata or documented
// cloud contract), and returns one serializable resolution. Transports map that
// resolution to their own wire shape:
//
//   local  -> reasoning_effort / reasoning_budget_tokens
//   cloud  -> provider-specific fields (./cloudProviders.js)
//
// Automatic always produces an empty mapping, so a provider's own default is
// preserved. An unsupported persisted value resolves to Automatic with a
// warning instead of being silently coerced to another effort or budget.

const controls = require('../lib/reasoningControls.cjs');

function cloudProviderRow(target) {
  if (target?.type !== 'cloud') return null;
  try {
    return require('./cloudProviders').getCloudProviders('text')
      .find(row => row.id === target.provider) || null;
  } catch {
    return null;
  }
}

async function cloudMetadataFor(target) {
  if (target?.type !== 'cloud') return null;
  try {
    const rows = await require('./cloudProviders').getCloudModelMetadata();
    return rows.find(row => row.providerId === target.provider && row.modelId === target.model) || null;
  } catch {
    // Metadata discovery is advisory: a failed lookup must not block a chat.
    // The resolver then reports the capability as unverified.
    return null;
  }
}

function targetFromEngine(engine) {
  if (engine?.provider === 'cloud' || engine?.chatTarget) {
    return { type: 'cloud', provider: engine.chatTarget?.provider, model: engine.chatTarget?.model };
  }
  return { type: 'local' };
}

/**
 * The settings key a child model uses. Cloud models are selected in the UI as
 * `cloud:<provider>:<model>`; local models use their GGUF path.
 */
function settingsModelIdForEngine(engine) {
  const target = targetFromEngine(engine);
  if (target.type === 'cloud') return `cloud:${target.provider}:${target.model}`;
  return typeof engine?.modelId === 'string' ? engine.modelId : '';
}

function effectiveSettings(sessionId, modelId) {
  try {
    return require('./profileSettings').getSessionSettings(sessionId ?? null, modelId).effective;
  } catch {
    return {};
  }
}

function resolveFromSettings({ settings, target, modelId, localModel, metadata, contextSize }) {
  const intent = controls.normalizeIntent(settings || {});
  const capabilities = controls.resolveCapabilities({
    target, provider: cloudProviderRow(target), modelId, metadata, localModel,
  });
  const resolution = controls.resolveReasoning({ intent, capabilities, contextSize });
  return { ...resolution, settings: {
    thinkingBudget: Number.isSafeInteger(settings?.thinkingBudget) ? settings.thinkingBudget : -1,
    reasoningEffort: typeof settings?.reasoningEffort === 'string' ? settings.reasoningEffort : null,
  } };
}

/**
 * Resolve reasoning for a main-chat request. `localModel` is the scanned GGUF
 * metadata for the loaded model (template capabilities), `contextSize` its
 * runtime window.
 */
async function resolveChatReasoning({ sessionId, modelId, target = { type: 'local' }, localModel = null, contextSize = null }) {
  const settings = effectiveSettings(sessionId, modelId);
  const metadata = target.type === 'cloud' ? await cloudMetadataFor(target) : null;
  return resolveFromSettings({
    settings, target, modelId: target.type === 'cloud' ? target.model : modelId,
    localModel, metadata, contextSize,
  });
}

/**
 * Resolve reasoning for a child execution. The child always uses the effective
 * settings of its own model (global + per-model config), never the parent
 * chat's session overrides or wire parameters.
 */
async function resolveChildReasoning({ engine, localModel = null }) {
  const target = targetFromEngine(engine);
  const modelId = target.type === 'cloud' ? target.model : engine?.modelId;
  const settingsModelId = settingsModelIdForEngine(engine);
  const settings = effectiveSettings(null, settingsModelId);
  const metadata = target.type === 'cloud' ? await cloudMetadataFor(target) : null;
  return resolveFromSettings({
    settings, target, modelId,
    localModel: target.type === 'local' ? (localModel ?? engine?.localModel ?? null) : null,
    metadata,
    contextSize: Number.isSafeInteger(engine?.contextLength) ? engine.contextLength : null,
  });
}

function isCloudEngine(engine) {
  return engine?.provider === 'cloud' || Boolean(engine?.chatTarget);
}

/**
 * Wire fields for a child execution. Local children use the runtime's own
 * fields; cloud children carry the serializable resolution descriptor that
 * ./cloudProviders.js maps to the provider's documented contract.
 */
function requestFieldsForEngine(engine, resolution) {
  if (!resolution?.effective || resolution.effective.mode === 'auto') return {};
  if (!isCloudEngine(engine)) return controls.localRequestFields(resolution);
  return { reasoning: {
    effective: resolution.effective,
    capabilities: {
      family: resolution.capabilities?.family ?? 'unknown',
      metadata: {
        supportedParameters: Array.isArray(resolution.capabilities?.metadata?.supportedParameters)
          ? resolution.capabilities.metadata.supportedParameters : [],
      },
    },
  } };
}

/** Capabilities-only view for the settings UI (no secrets, no warnings lost). */
function describeResolution(resolution) {
  return {
    ...controls.publicCapabilities(resolution?.capabilities),
    intent: resolution?.intent ?? { mode: 'auto', effort: null, budget: null },
    effective: resolution?.effective ?? { mode: 'auto', effort: null, budget: null },
    unsupported: resolution?.unsupported === true,
    warnings: Array.isArray(resolution?.warnings) ? [...resolution.warnings] : [],
    settings: resolution?.settings ?? { thinkingBudget: -1, reasoningEffort: null },
  };
}

module.exports = {
  resolveChatReasoning,
  resolveChildReasoning,
  describeResolution,
  requestFieldsForEngine,
  targetFromEngine,
  settingsModelIdForEngine,
};
