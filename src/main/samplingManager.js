'use strict';
const { db } = require('./db');
const DEFAULT_SAMPLING_PARAMS = Object.freeze({ temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 });
function validateSamplingParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid sampling parameters.');
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SAMPLING_PARAMS, key) || typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid sampling parameter: ${key}.`);
    const valid = key === 'temperature' ? value >= 0 && value <= 2
      : key === 'top_p' ? value >= 0 && value <= 1
      : key === 'top_k' ? Number.isInteger(value) && value >= 1 && value <= 100
      : key === 'repeat_penalty' ? value >= 1 && value <= 1.5
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
