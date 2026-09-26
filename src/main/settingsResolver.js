'use strict';
const KEYS = ['systemPrompt', 'temperature', 'topP', 'topK', 'repeatPenalty', 'maxTokens'];
const SAMPLING_KEYS = { temperature: 'temperature', topP: 'top_p', topK: 'top_k', repeatPenalty: 'repeat_penalty', maxTokens: 'max_tokens' };
function getEffectiveSettings(session, modelPath, globalSettings) {
  const model = Object.hasOwn(globalSettings.perModelConfigs || {}, modelPath) ? globalSettings.perModelConfigs[modelPath] : {};
  const overrides = session?.overrides || {};
  return Object.fromEntries(KEYS.map(key => [key, overrides[key] ?? model?.[key] ?? globalSettings[key]]));
}
const toSamplingParams = settings => Object.fromEntries(Object.entries(SAMPLING_KEYS).filter(([key]) => settings[key] !== undefined).map(([key, wire]) => [wire, settings[key]]));
const fromSamplingParams = params => Object.fromEntries(Object.entries(SAMPLING_KEYS).filter(([, wire]) => params[wire] !== undefined).map(([key, wire]) => [key, params[wire]]));
module.exports = { KEYS, getEffectiveSettings, toSamplingParams, fromSamplingParams };
