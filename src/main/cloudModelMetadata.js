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
  const modality = kind => Array.isArray(modalities) ? modalities.includes(kind) : support(capabilities[kind] ?? capabilities[`${kind}_input`]);
  const parameter = names => Array.isArray(parameters) ? names.some(name => parameters.includes(name)) : null;
  const price = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  return {
    id: model.id, name: model.name || model.display_name || model.id,
    providerName: providerName(baseUrl, apiType), metadataSource: 'provider-api',
    contextLength: integer(model.context_length ?? model.max_input_tokens ?? model.inputTokenLimit),
    maxOutputTokens: integer(model.top_provider?.max_completion_tokens ?? model.max_tokens ?? model.outputTokenLimit),
    capabilities: { image: modality('image'), audio: modality('audio'), video: modality('video'),
      reasoning: parameter(['reasoning', 'reasoning_effort', 'include_reasoning']) ?? support(capabilities.thinking ?? capabilities.reasoning ?? model.thinking),
      tools: parameter(['tools', 'tool_choice']) ?? support(capabilities.tools ?? capabilities.tool_use ?? capabilities.client_tools) },
    pricing: { input: price(model.pricing?.prompt), output: price(model.pricing?.completion) },
  };
}
module.exports = { normalizeCloudModel, providerName };
