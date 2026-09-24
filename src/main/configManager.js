'use strict';

const DEFAULT_LOAD_CONFIG = Object.freeze({
  contextLength: 8192, gpuOffload: 'auto', threads: 4, evalBatch: 2048,
  physicalBatch: 512, parallel: 1, loadMode: 'auto', flashAttention: 'auto',
});
const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'];
function normalizeLoadConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid load settings.');
  const config = { ...DEFAULT_LOAD_CONFIG };
  for (const key of Object.keys(config)) if (input[key] !== undefined) config[key] = input[key];
  for (const key of ['contextLength', 'threads', 'evalBatch', 'physicalBatch', 'parallel']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 2147483647) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.gpuOffload !== 'auto' && (!Number.isSafeInteger(config.gpuOffload) || config.gpuOffload < 0 || config.gpuOffload > 2147483647)) throw new Error('GPU offload must be auto or a non-negative integer.');
  if (!LOAD_MODES.includes(config.loadMode)) throw new Error('Invalid load mode.');
  if (!['on', 'off', 'auto'].includes(config.flashAttention)) throw new Error('Invalid flash attention setting.');
  if (config.physicalBatch > config.evalBatch) throw new Error('Physical batch cannot exceed evaluation batch.');
  if (config.parallel > config.contextLength) throw new Error('Parallel predictions cannot exceed context length.');
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') {
    if (!Number.isInteger(input.seed) || input.seed < -1 || input.seed > 4294967295) throw new Error('Seed must be between -1 and 4294967295.');
    config.seed = input.seed;
  }
  return config;
}
function modelKey(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 4096) throw new Error('Invalid model ID.');
  return modelId;
}
function getLoadConfig(modelId) {
  const { db } = require('./db');
  const row = db.prepare('SELECT config_json FROM model_load_configs WHERE model_id = ?').get(modelKey(modelId));
  return { config: normalizeLoadConfig(row ? JSON.parse(row.config_json) : {}), remembered: !!row };
}
function saveLoadConfig(modelId, input) {
  const { db } = require('./db');
  const config = normalizeLoadConfig(input);
  db.prepare(`INSERT INTO model_load_configs(model_id, config_json) VALUES (?, ?)
    ON CONFLICT(model_id) DO UPDATE SET config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP`)
    .run(modelKey(modelId), JSON.stringify(config));
  return config;
}
function forgetLoadConfig(modelId) {
  const { db } = require('./db');
  db.prepare('DELETE FROM model_load_configs WHERE model_id = ?').run(modelKey(modelId));
}
module.exports = { DEFAULT_LOAD_CONFIG, normalizeLoadConfig, getLoadConfig, saveLoadConfig, forgetLoadConfig };


function normalizeAppSettings(input = {}) {
  const apiServerPort = input.apiServerPort === undefined ? 8080 : input.apiServerPort;
  if (apiServerPort !== null && (!Number.isInteger(apiServerPort) || apiServerPort < 1 || apiServerPort > 65535)) {
    throw new Error('Local API Server Port must be an integer from 1 to 65535, or null for automatic selection.');
  }
  return { apiServerPort };
}
function getAppSettings() {
  const { db } = require('./db');
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'apiServerPort'").get();
  return normalizeAppSettings(row ? { apiServerPort: JSON.parse(row.value_json) } : {});
}
function saveAppSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid app settings.');
  const settings = normalizeAppSettings(input);
  const { db } = require('./db');
  db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('apiServerPort', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(settings.apiServerPort));
  return settings;
}
Object.assign(module.exports, { normalizeAppSettings, getAppSettings, saveAppSettings });

function getRagSettings() {
  const { db } = require('./db');
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'rag'").get();
  return row ? JSON.parse(row.value_json) : { embeddingPort: 8081, embeddingModel: '', embeddingApiKey: '' };
}
function saveRagSettings(input) {
  if (!input || !Number.isInteger(input.embeddingPort) || input.embeddingPort < 1 || input.embeddingPort > 65535 ||
      typeof input.embeddingModel !== 'string' || typeof input.embeddingApiKey !== 'string') throw new Error('Invalid local embedding settings.');
  const settings = { embeddingPort: input.embeddingPort, embeddingModel: input.embeddingModel.trim(), embeddingApiKey: input.embeddingApiKey };
  const { db } = require('./db');
  db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('rag', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(settings));
  return settings;
}
Object.assign(module.exports, { getRagSettings, saveRagSettings });
