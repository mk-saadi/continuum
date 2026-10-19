'use strict';
const { db } = require('./db');
const DEFAULT_SAMPLING_PARAMS = Object.freeze({ temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1, thinking_budget: -1 });
const SAMPLING_KEYS = new Set([...Object.keys(DEFAULT_SAMPLING_PARAMS), 'reasoning_effort']);
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
function validateSamplingParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid sampling parameters.');
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAMPLING_KEYS.has(key)) throw new Error(`Invalid sampling parameter: ${key}.`);
    // Reasoning effort is an enumerated string (or null to clear/auto); every
    // other sampling parameter is numeric. The value is validated against the
    // selected model only when a request is built, because capabilities belong
    // to the target and may change when the user switches models.
    if (key === 'reasoning_effort') {
      if (value === null) { output[key] = null; continue; }
      if (typeof value !== 'string' || !REASONING_EFFORT_PATTERN.test(value.trim().toLowerCase())) {
        throw new Error(`Invalid sampling parameter: ${key}.`);
      }
      output[key] = value.trim().toLowerCase();
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid sampling parameter: ${key}.`);
    const valid = key === 'temperature' ? value >= 0 && value <= 2
      : key === 'top_p' ? value >= 0 && value <= 1
      : key === 'top_k' ? Number.isInteger(value) && value >= 1 && value <= 100
      : key === 'repeat_penalty' ? value >= 1 && value <= 1.5
      : key === 'thinking_budget' ? Number.isSafeInteger(value) && (value === -1 || (value >= 0 && value <= 65536))
      : Number.isSafeInteger(value) && (value === -1 || value > 0);
    if (!valid) throw new Error(`Invalid sampling parameter: ${key}.`);
    output[key] = value;
  }
  return output;
}
function parseSamplingParams(json) {
  if (!json) return {};
  try { return validateSamplingParams(JSON.parse(json)); } catch { return {}; }
}
function getGlobalSamplingParams() {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'sampling_params'").get();
  return { ...DEFAULT_SAMPLING_PARAMS, ...parseSamplingParams(row?.value_json) };
}
function saveGlobalSamplingParams(patch) {
  const valid = validateSamplingParams(patch);
  return db.transaction(() => {
    const params = { ...getGlobalSamplingParams(), ...valid };
    db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('sampling_params', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(params));
    return params;
  }).immediate();
}
module.exports = { DEFAULT_SAMPLING_PARAMS, validateSamplingParams, parseSamplingParams, getGlobalSamplingParams, saveGlobalSamplingParams };
