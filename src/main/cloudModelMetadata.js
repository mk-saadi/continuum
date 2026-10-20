'use strict';
const integer = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const support = value => typeof value === 'boolean' ? value : typeof value?.supported === 'boolean' ? value.supported : null;
function providerName(baseUrl, apiType) {
  const host = new URL(baseUrl).hostname;
  const known = { 'openrouter.ai': 'OpenRouter', 'api.anthropic.com': 'Anthropic', 'api.openai.com': 'OpenAI', 'generativelanguage.googleapis.com': 'Google', 'api.deepseek.com': 'DeepSeek' };
  return known[host] || (apiType === 'anthropic' ? 'Anthropic-compatible' : host);
}
function normalizeCloudModel(model, baseUrl, apiType) {
  const modalities = model.architecture?.input_modalities;
  const parameters = model.supported_parameters;
  const capabilities = model.capabilities || {};
  const reasoningInfo = model.reasoning && typeof model.reasoning === 'object' ? model.reasoning : {};
  const modality = kind => Array.isArray(modalities) ? modalities.includes(kind) : support(capabilities[kind] ?? capabilities[`${kind}_input`]);
  const parameter = names => Array.isArray(parameters) ? names.some(name => parameters.includes(name)) : null;
  const price = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const boolean = value => typeof value === 'boolean' ? value : null;
  const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const supportedEfforts = Array.isArray(reasoningInfo.supported_efforts) ? reasoningInfo.supported_efforts
    : Array.isArray(reasoningInfo.efforts) ? reasoningInfo.efforts : [];
  return {
    id: model.id, name: model.name || model.display_name || model.id,
    providerName: providerName(baseUrl, apiType), metadataSource: 'provider-api',
    contextLength: integer(model.context_length ?? model.max_input_tokens ?? model.inputTokenLimit),
    maxOutputTokens: integer(model.top_provider?.max_completion_tokens ?? model.max_tokens ?? model.outputTokenLimit),
    capabilities: { image: modality('image'), audio: modality('audio'), video: modality('video'),
      reasoning: parameter(['reasoning', 'reasoning_effort', 'include_reasoning']) ?? support(capabilities.thinking ?? capabilities.reasoning ?? model.thinking),
      tools: parameter(['tools', 'tool_choice']) ?? support(capabilities.tools ?? capabilities.tool_use ?? capabilities.client_tools) },
    supportedParameters: Array.isArray(parameters) ? [...parameters] : [],
    reasoning: {
      supported: parameter(['reasoning', 'reasoning_effort', 'include_reasoning']) ?? support(capabilities.thinking ?? capabilities.reasoning),
      efforts: supportedEfforts.filter(value => typeof value === 'string'),
      defaultEffort: typeof reasoningInfo.default_effort === 'string' ? reasoningInfo.default_effort
        : typeof reasoningInfo.defaultEffort === 'string' ? reasoningInfo.defaultEffort : null,
      defaultEnabled: boolean(reasoningInfo.default_enabled ?? reasoningInfo.defaultEnabled),
      supportsMaxTokens: boolean(reasoningInfo.supports_max_tokens ?? reasoningInfo.supportsMaxTokens),
      mandatory: boolean(reasoningInfo.mandatory),
      minBudget: nonNegative(reasoningInfo.min_tokens ?? reasoningInfo.minBudget),
      maxBudget: nonNegative(reasoningInfo.max_tokens ?? reasoningInfo.maxBudget),
    },
    pricing: { input: price(model.pricing?.prompt), output: price(model.pricing?.completion) },
    // Raw provider price metadata, preserved untouched so the cost estimator
    // can normalize cache rates, conditional overrides and units once, in one
    // place. Never used as a display value directly.
    pricingRaw: model.pricing && typeof model.pricing === 'object' ? model.pricing : null,
  };
}
module.exports = { normalizeCloudModel, providerName };
