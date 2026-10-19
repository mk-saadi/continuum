'use strict';

// Shared reasoning/thinking contract for every inference path.
//
// The application stores one user intent, but providers expose different
// controls: a boolean enable/disable, enumerated effort levels, a numeric
// thinking-token budget, or no control at all. This module keeps those concepts
// separate and resolves the intent against the *actual* target before any
// request is built. It never converts a numeric budget into an effort (or the
// reverse), and it never sends a field the target has not been documented or
// reported to support.
//
// `resolveReasoning` returns a serializable resolution you can keep on a request
// payload. `localRequestFields` and `cloudRequestFields` turn exactly that
// resolution into wire fields for the matching transport.

const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORTS = Object.freeze(['low', 'medium', 'high']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function uniqueEfforts(values) {
  if (!Array.isArray(values)) return [];
  const requested = new Set(values.filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  return EFFORT_ORDER.filter(effort => requested.has(effort));
}

function localBudgetCeiling(contextSize) {
  const context = Number.isFinite(contextSize) && contextSize > 0 ? contextSize : 32768;
  return Math.max(0, Math.floor((context - 2048) / 256) * 256);
}

/**
 * Resolve the persisted settings into one normalized intent. Kept separate from
 * capabilities so callers can still show the user what was saved even when the
 * current model cannot honor it.
 */
function normalizeIntent(settings = {}) {
  const budget = finiteInt(settings.thinkingBudget ?? settings.thinking_budget);
  const effortValue = settings.reasoningEffort ?? settings.reasoning_effort;
  const effort = typeof effortValue === 'string' && effortValue.trim()
    ? effortValue.trim().toLowerCase() : null;
  // 0 is the long-standing "off/fast" value. It is a disable intent, not a
  // request for a zero-token budget.
  if (budget === 0) return { mode: 'off', effort: null, budget: null };
  if (budget !== null && budget > 0) return { mode: 'budget', effort: null, budget };
  if (effort) return { mode: 'effort', effort, budget: null };
  return { mode: 'auto', effort: null, budget: null };
}

function settingsForIntent(intent) {
  if (intent?.mode === 'off') return { thinkingBudget: 0, reasoningEffort: null };
  if (intent?.mode === 'budget') return { thinkingBudget: intent.budget, reasoningEffort: null };
  if (intent?.mode === 'effort') return { thinkingBudget: -1, reasoningEffort: intent.effort };
  return { thinkingBudget: -1, reasoningEffort: null };
}

function providerFamily(provider = {}) {
  provider = provider || {};
  if (provider.apiType === 'anthropic') return 'anthropic';
  let host = '';
  try { host = new URL(provider.baseUrl || '').hostname.toLowerCase(); } catch { /* Unknown/custom endpoint. */ }
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  if (host === 'generativelanguage.googleapis.com' || host.endsWith('.googleapis.com')) return 'gemini';
  if (host === 'api.openai.com') return 'openai';
  return 'compatible';
}

function metadataReasoning(metadata) {
  const source = isObject(metadata?.reasoning) ? metadata.reasoning : {};
  return {
    supported: metadata?.capabilities?.reasoning ?? source.supported ?? null,
    efforts: uniqueEfforts(source.efforts ?? source.supported_efforts),
    defaultEffort: typeof source.defaultEffort === 'string' ? source.defaultEffort
      : typeof source.default_effort === 'string' ? source.default_effort : null,
    defaultEnabled: typeof source.defaultEnabled === 'boolean' ? source.defaultEnabled
      : typeof source.default_enabled === 'boolean' ? source.default_enabled : null,
    supportsEffort: typeof source.supportsEffort === 'boolean' ? source.supportsEffort
      : typeof source.supports_effort === 'boolean' ? source.supports_effort : null,
    supportsMaxTokens: typeof source.supportsMaxTokens === 'boolean' ? source.supportsMaxTokens
      : typeof source.supports_max_tokens === 'boolean' ? source.supports_max_tokens : null,
    mandatory: typeof source.mandatory === 'boolean' ? source.mandatory : null,
    minBudget: finiteInt(source.minBudget ?? source.min_tokens),
    maxBudget: finiteInt(source.maxBudget ?? source.max_tokens),
    supportedParameters: Array.isArray(metadata?.supportedParameters) ? metadata.supportedParameters : [],
  };
}

function anthropicVersion(modelId) {
  const value = String(modelId || '').toLowerCase();
  // Current ids look like claude-sonnet-4-6 / claude-opus-4.7, while older ids
  // put the version before the family (claude-3-7-sonnet-...).
  let match = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)[.-](\d+)/.exec(value);
  if (!match) match = /claude-(\d+)[.-](\d+)-(?:opus|sonnet|haiku)/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function anthropicAdaptive(modelId) {
  const version = anthropicVersion(modelId);
  return version !== null && (version.major > 4 || (version.major === 4 && version.minor >= 7));
}

function anthropicCapabilities(modelId, metadata) {
  const adaptive = anthropicAdaptive(modelId);
  const info = metadataReasoning(metadata);
  const maxOutput = finiteInt(metadata?.maxOutputTokens);
  return {
    family: 'anthropic',
    source: 'documented',
    reasoning: true,
    efforts: adaptive ? [...DEFAULT_EFFORTS] : [],
    supportsEffort: adaptive,
    // Adaptive models disable through thinking.type=disabled; legacy models
    // disable by omitting the thinking block (extended thinking defaults off).
    canDisable: true,
    budget: adaptive
      ? { supported: false, min: null, max: null }
      : { supported: true, min: 1024, max: maxOutput ? Math.max(1024, maxOutput - 1) : 128000 },
    enabled: true,
    metadata: info,
  };
}

function openaiModelEfforts(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/gpt-6[.-]?1.*sol/.test(id)) return { efforts: ['low', 'medium', 'high'], canDisable: false };
  if (/gpt-6.*astra/.test(id)) return { efforts: ['low', 'medium', 'high'], canDisable: false };
  if (/gpt-6/.test(id)) return { efforts: ['low', 'medium', 'high'], canDisable: false };
  if (/gpt-5/.test(id)) return { efforts: ['minimal', 'low', 'medium', 'high'], canDisable: false };
  if (/^o[1-4](?:[-.]|$)/.test(id)) return { efforts: ['low', 'medium', 'high'], canDisable: false };
  return { efforts: [], canDisable: null };
}

function geminiCapabilities(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/gemini-3/.test(id)) {
    return { efforts: ['minimal', 'low', 'medium', 'high'], canDisable: false,
      budget: { supported: false, min: null, max: null } };
  }
  if (/gemini-2\.5-pro/.test(id)) {
    return { efforts: ['low', 'medium', 'high'], canDisable: false,
      budget: { supported: true, min: 128, max: 32768 } };
  }
  if (/gemini-2\.5/.test(id)) {
    return { efforts: ['minimal', 'low', 'medium', 'high'], canDisable: true,
      budget: { supported: true, min: 0, max: 24576 } };
  }
  return { efforts: [], canDisable: null, budget: { supported: null, min: null, max: null } };
}

function compatibleCapabilities(metadata) {
  const info = metadataReasoning(metadata);
  const parameters = info.supportedParameters;
  const reportedReasoning = info.supported;
  const hasEffortParameter = parameters.includes('reasoning_effort') || info.supportsEffort === true;
  const hasReasoningParameter = parameters.includes('reasoning');
  const wireOff = hasReasoningParameter || hasEffortParameter;
  const supported = reportedReasoning ?? (hasEffortParameter || hasReasoningParameter ? true : null);
  return {
    family: 'compatible',
    source: metadata ? 'provider-metadata' : 'documented',
    reasoning: supported,
    efforts: info.efforts,
    // An advertised effort list is not a wire contract: without a documented
    // parameter the endpoint has no place to receive the value.
    supportsEffort: supported === true ? (hasEffortParameter || hasReasoningParameter) : supported === false ? false : null,
    canDisable: supported === true && wireOff && info.mandatory !== true ? true : supported === false ? false : null,
    budget: {
      supported: info.supportsMaxTokens === true && hasReasoningParameter ? true : info.supportsMaxTokens === false ? false : null,
      min: info.minBudget,
      max: info.maxBudget,
    },
    wire: { reasoningObject: hasReasoningParameter, reasoningEffort: hasEffortParameter },
    metadata: info,
  };
}

function localCapabilities(localModel) {
  if (!isObject(localModel)) {
    return {
      family: 'local', source: 'unknown', reasoning: null, efforts: [],
      supportsEffort: null, canDisable: null,
      budget: { supported: null, min: 0, max: null },
    };
  }
  const template = typeof localModel.chatTemplate === 'string' ? localModel.chatTemplate : '';
  const efforts = uniqueEfforts(localModel.reasoningEfforts);
  const hasReasoning = typeof localModel.hasReasoning === 'boolean' ? localModel.hasReasoning : null;
  const supportsEffort = typeof localModel.supportsReasoningEffort === 'boolean'
    ? localModel.supportsReasoningEffort
    : efforts.length ? true : /reasoning_effort/.test(template) ? true : hasReasoning === false ? false : null;
  const supportsBudget = typeof localModel.supportsReasoningBudget === 'boolean'
    ? localModel.supportsReasoningBudget
    : /<\/think>|\[\/THINK\]|<\/mm:think>|<channel\|>/i.test(template)
      ? true : hasReasoning === false ? false : null;
  const canDisable = typeof localModel.supportsDisableReasoning === 'boolean'
    ? localModel.supportsDisableReasoning
    : hasReasoning === false ? false
      : supportsEffort || supportsBudget || /enable_thinking|reasoning_effort/i.test(template) ? true : null;
  return {
    family: 'local',
    source: 'local-metadata',
    reasoning: hasReasoning ?? (supportsEffort || supportsBudget ? true : null),
    efforts,
    supportsEffort,
    canDisable,
    budget: { supported: supportsBudget, min: 0, max: null },
  };
}

/**
 * Resolve the target's controls without considering the saved intent.
 * `metadata` is a cached cloud model metadata row (or equivalent).
 */
function resolveCapabilities({ target, provider, modelId, metadata, localModel } = {}) {
  if (target?.type === 'local') return localCapabilities(localModel);
  const family = providerFamily(provider);
  if (family === 'anthropic') return anthropicCapabilities(modelId, metadata);
  if (family === 'openrouter') {
    const info = metadataReasoning(metadata);
    const supported = info.supported;
    const efforts = info.efforts.length ? info.efforts : supported === true ? [...DEFAULT_EFFORTS] : [];
    return {
      family, source: metadata ? 'provider-metadata' : 'documented', reasoning: supported,
      efforts,
      supportsEffort: supported === true ? true : supported === false ? false : null,
      canDisable: supported === true && info.mandatory === true ? false : supported === true ? true : null,
      budget: {
        supported: info.supportsMaxTokens,
        min: info.minBudget ?? (info.supportsMaxTokens === true ? 1024 : null),
        max: info.maxBudget ?? (info.supportsMaxTokens === true ? 128000 : null),
      },
      metadata: info,
    };
  }
  if (family === 'deepseek') {
    return {
      family, source: 'documented', reasoning: true,
      efforts: ['low', 'high', 'max'], supportsEffort: true, canDisable: true,
      budget: { supported: false, min: null, max: null },
    };
  }
  if (family === 'gemini') {
    const gemini = geminiCapabilities(modelId);
    return {
      family, source: 'documented', reasoning: gemini.efforts.length || gemini.budget.supported ? true : null,
      efforts: gemini.efforts, supportsEffort: gemini.efforts.length > 0,
      canDisable: gemini.canDisable, budget: gemini.budget,
    };
  }
  if (family === 'openai') {
    const openai = openaiModelEfforts(modelId);
    return {
      family, source: 'documented',
      reasoning: openai.efforts.length ? true : null,
      efforts: openai.efforts, supportsEffort: openai.efforts.length ? true : null,
      canDisable: openai.canDisable,
      budget: { supported: false, min: null, max: null },
    };
  }
  return compatibleCapabilities(metadata);
}

function warningForUnsupported(intent, capabilities) {
  if (intent.mode === 'off') return capabilities.canDisable === false
    ? 'This model cannot disable reasoning.'
    : 'Disable is not supported for this model.';
  if (intent.mode === 'effort') return capabilities.efforts.length
    ? `Reasoning effort "${intent.effort}" is not supported by this model.`
    : 'Reasoning effort is not supported by this model.';
  if (intent.mode === 'budget') return capabilities.budget.supported === false
    ? 'A numeric thinking-token budget is not supported by this model.'
    : 'A numeric thinking-token budget has not been verified for this model.';
  return null;
}

/**
 * Resolve saved intent against target capabilities.
 *
 * Automatic never sends a field. An unsupported persisted value resolves to
 * Automatic with `unsupported: true` and a warning; it is not silently coerced
 * into a different effort or budget. A numeric budget is clamped only to the
 * target's reported maximum, and the clamp is reported in `warnings`.
 */
function resolveReasoning({ intent: input, capabilities, contextSize = null } = {}) {
  const intent = input?.mode ? input : normalizeIntent(input);
  const resolvedCapabilities = capabilities || localCapabilities(null);
  const warnings = [];
  const base = { intent, capabilities: resolvedCapabilities, effective: { mode: 'auto', effort: null, budget: null },
    unsupported: false, warnings, source: resolvedCapabilities.source || 'unknown' };
  if (intent.mode === 'auto') return base;

  if (intent.mode === 'off') {
    if (resolvedCapabilities.canDisable === true) {
      return { ...base, effective: { mode: 'off', effort: null, budget: null } };
    }
    warnings.push(warningForUnsupported(intent, resolvedCapabilities));
    return { ...base, unsupported: true };
  }

  if (intent.mode === 'effort') {
    if (resolvedCapabilities.supportsEffort === true &&
        (resolvedCapabilities.efforts.length === 0 || resolvedCapabilities.efforts.includes(intent.effort))) {
      return { ...base, effective: { mode: 'effort', effort: intent.effort, budget: null } };
    }
    warnings.push(warningForUnsupported(intent, resolvedCapabilities));
    return { ...base, unsupported: true };
  }

  if (intent.mode === 'budget') {
    const budget = resolvedCapabilities.budget || {};
    if (budget.supported === true) {
      let value = intent.budget;
      const min = finiteInt(budget.min);
      const max = finiteInt(budget.max) ?? localBudgetCeiling(contextSize);
      if (min !== null && value < min) {
        warnings.push(`The saved ${value.toLocaleString('en-US')}-token budget is below this model's ${min.toLocaleString('en-US')}-token minimum; Automatic was used.`);
        return { ...base, unsupported: true };
      }
      if (max !== null && value > max) {
        warnings.push(`The saved ${value.toLocaleString('en-US')}-token budget exceeds this model's ${max.toLocaleString('en-US')}-token maximum; it was limited to ${max.toLocaleString('en-US')}.`);
        value = max;
      }
      if (value === 0 && resolvedCapabilities.family === 'anthropic') {
        warnings.push('A numeric thinking budget of 0 is not valid for this model; Automatic was used.');
        return { ...base, unsupported: true };
      }
      return { ...base, effective: { mode: 'budget', effort: null, budget: value } };
    }
    warnings.push(warningForUnsupported(intent, resolvedCapabilities));
    return { ...base, unsupported: true };
  }

  warnings.push('Unknown reasoning mode; Automatic was used.');
  return { ...base, unsupported: true };
}

function localRequestFields(resolution) {
  if (!resolution?.effective || resolution.effective.mode === 'auto') return {};
  if (resolution.effective.mode === 'off') {
    // The runtime turns `reasoning_effort: "none"` into enable_thinking=false
    // for every template. A zero budget is an additional, template-gated stop
    // signal for models that only expose reasoning end tags.
    return {
      reasoning_effort: 'none',
      ...(resolution?.capabilities?.budget?.supported === true ? { reasoning_budget_tokens: 0 } : {}),
    };
  }
  if (resolution.effective.mode === 'effort') return { reasoning_effort: resolution.effective.effort };
  if (resolution.effective.mode === 'budget') {
    return { reasoning_budget_tokens: resolution.effective.budget };
  }
  return {};
}

/**
 * Build provider fields for an OpenAI-compatible cloud body. `maxTokens` is the
 * caller's max_tokens (-1/0/undefined means unspecified). The returned
 * `maxTokens` is the effective value that must ride the request.
 */
function cloudRequestFields(resolution, { modelId = '', maxTokens = -1 } = {}) {
  const family = resolution?.capabilities?.family ?? resolution?.family;
  const effective = resolution?.effective?.mode ? resolution.effective : resolution;
  const supportedParameters = Array.isArray(resolution?.capabilities?.metadata?.supportedParameters)
    ? resolution.capabilities.metadata.supportedParameters : [];
  if (!effective || effective.mode === 'auto') {
    return { fields: {}, maxTokens: maxTokens && maxTokens > 0 ? maxTokens : undefined };
  }
  if (family === 'anthropic') {
    const adaptive = anthropicAdaptive(modelId);
    if (effective.mode === 'off') {
      return { fields: adaptive ? { thinking: { type: 'disabled' } } : {},
        maxTokens: maxTokens && maxTokens > 0 ? maxTokens : 4096 };
    }
    if (effective.mode === 'effort' && adaptive) {
      return { fields: { thinking: { type: 'adaptive' }, output_config: { effort: effective.effort } },
        maxTokens: maxTokens && maxTokens > 0 ? maxTokens : 4096 };
    }
    if (effective.mode === 'budget' && !adaptive) {
      const budget = effective.budget;
      const base = maxTokens && maxTokens > 0 ? maxTokens : 4096;
      return { fields: { thinking: { type: 'enabled', budget_tokens: budget } },
        maxTokens: Math.max(base, budget + 1) };
    }
    return { fields: {}, maxTokens: maxTokens && maxTokens > 0 ? maxTokens : 4096 };
  }
  if (family === 'openrouter') {
    if (effective.mode === 'off') return { fields: { reasoning: { enabled: false } } };
    if (effective.mode === 'effort') return { fields: { reasoning: { effort: effective.effort } } };
    if (effective.mode === 'budget') return { fields: { reasoning: { max_tokens: effective.budget } } };
  }
  if (family === 'deepseek') {
    if (effective.mode === 'off') return { fields: { thinking: { type: 'disabled' } } };
    if (effective.mode === 'effort') return { fields: {
      thinking: { type: 'enabled' }, reasoning_effort: effective.effort } };
  }
  if (family === 'gemini') {
    if (effective.mode === 'off') return { fields: { reasoning_effort: 'none' } };
    if (effective.mode === 'effort') return { fields: { reasoning_effort: effective.effort } };
    if (effective.mode === 'budget') return { fields: {
      extra_body: { google: { thinking_config: { thinking_budget: effective.budget } } } } };
  }
  if (family === 'openai') {
    if (effective.mode === 'off') return { fields: { reasoning_effort: 'none' } };
    if (effective.mode === 'effort') return { fields: { reasoning_effort: effective.effort } };
  }
  if (family === 'compatible') {
    // Only fields the endpoint's own metadata advertised. Without that
    // evidence the resolver has already marked the intent unsupported.
    const hasReasoningObject = supportedParameters.includes('reasoning') ||
      resolution?.capabilities?.metadata?.supportsReasoningObject === true;
    if (effective.mode === 'off') {
      if (hasReasoningObject) return { fields: { reasoning: { enabled: false } } };
      if (supportedParameters.includes('reasoning_effort')) return { fields: { reasoning_effort: 'none' } };
    }
    if (effective.mode === 'effort') {
      if (hasReasoningObject) return { fields: { reasoning: { effort: effective.effort } } };
      if (supportedParameters.includes('reasoning_effort')) return { fields: { reasoning_effort: effective.effort } };
    }
    if (effective.mode === 'budget' && hasReasoningObject) {
      return { fields: { reasoning: { max_tokens: effective.budget } } };
    }
  }
  return { fields: {} };
}

function publicCapabilities(capabilities) {
  return {
    family: capabilities?.family ?? 'unknown',
    source: capabilities?.source ?? 'unknown',
    reasoning: capabilities?.reasoning ?? null,
    efforts: Array.isArray(capabilities?.efforts) ? [...capabilities.efforts] : [],
    canDisable: capabilities?.canDisable ?? null,
    budget: {
      supported: capabilities?.budget?.supported ?? null,
      min: capabilities?.budget?.min ?? null,
      max: capabilities?.budget?.max ?? null,
    },
  };
}

module.exports = {
  EFFORT_ORDER,
  DEFAULT_EFFORTS,
  normalizeIntent,
  settingsForIntent,
  providerFamily,
  anthropicVersion,
  anthropicAdaptive,
  resolveCapabilities,
  resolveReasoning,
  localRequestFields,
  cloudRequestFields,
  publicCapabilities,
  localBudgetCeiling,
  metadataReasoning,
};
