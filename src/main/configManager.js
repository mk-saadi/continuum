'use strict';

const DEFAULT_LOAD_CONFIG = Object.freeze({
  contextLength: 8192, gpuOffload: 'auto', threads: 4, evalBatch: 2048,
  physicalBatch: 512, parallel: 1, mlock: false, flashAttention: 'auto',
  cacheTypeK: 'f16', cacheTypeV: 'f16', chatTemplate: 'auto', reasoningFormat: 'auto',
});
const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'];
function normalizeLoadConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid load settings.');
  const config = { ...DEFAULT_LOAD_CONFIG };
  for (const key of Object.keys(config)) if (input[key] !== undefined) config[key] = input[key];
  // Migrate remembered settings without retaining retired load options.
  if (input.kvCacheQuantization !== undefined) {
    if (!['f16', 'q8_0', 'q4_0'].includes(input.kvCacheQuantization)) throw new Error('Invalid KV cache precision.');
    config.cacheTypeK = input.cacheTypeK ?? input.kvCacheQuantization;
    config.cacheTypeV = input.cacheTypeV ?? input.kvCacheQuantization;
  }
  if (input.loadMode !== undefined) {
    if (!LOAD_MODES.includes(input.loadMode)) throw new Error('Invalid load mode.');
    if (input.mlock === undefined) config.mlock = ['mlock', 'mmap+mlock'].includes(input.loadMode);
  }
  for (const key of ['contextLength', 'threads', 'evalBatch', 'physicalBatch', 'parallel']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 2147483647) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.gpuOffload !== 'auto' && (!Number.isSafeInteger(config.gpuOffload) || config.gpuOffload < 0 || config.gpuOffload > 2147483647)) throw new Error('GPU offload must be auto or a non-negative integer.');
  if (typeof config.mlock !== 'boolean') throw new Error('Invalid mlock setting.');
  if (!['on', 'off', 'auto'].includes(config.flashAttention)) throw new Error('Invalid flash attention setting.');
  for (const [key, values] of Object.entries({
    cacheTypeK: ['f16', 'q8_0', 'q4_0'],
    cacheTypeV: ['f16', 'q8_0', 'q4_0'],
    chatTemplate: ['auto', 'llama3', 'chatml', 'deepseek', 'gemma'],
    reasoningFormat: ['auto', 'deepseek', 'none'],
  })) if (!values.includes(config[key])) throw new Error(`Invalid ${key} setting.`);
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
  const mcpMode = input.mcpMode === undefined ? 'auto' : input.mcpMode;
  if (!['auto', 'manual'].includes(mcpMode)) throw new Error('MCP mode must be auto or manual.');
  const maxConsecutiveToolFailures = input.maxConsecutiveToolFailures === undefined ? 5 : input.maxConsecutiveToolFailures;
  const maxTotalToolFailures = input.maxTotalToolFailures === undefined ? 10 : input.maxTotalToolFailures;
  if (!Number.isInteger(maxConsecutiveToolFailures) || maxConsecutiveToolFailures < 3 || maxConsecutiveToolFailures > 10)
    throw new Error('Max Consecutive Tool Failures must be an integer from 3 to 10.');
  if (!Number.isInteger(maxTotalToolFailures) || maxTotalToolFailures < 5 || maxTotalToolFailures > 25)
    throw new Error('Max Total Tool Failures must be an integer from 5 to 25.');
  const notificationsEnabled = input.notificationsEnabled === undefined ? true : input.notificationsEnabled;
  const notifyOnlyWhenBackgrounded = input.notifyOnlyWhenBackgrounded === undefined ? true : input.notifyOnlyWhenBackgrounded;
  if (typeof notificationsEnabled !== 'boolean' || typeof notifyOnlyWhenBackgrounded !== 'boolean')
    throw new Error('Invalid desktop notification preference.');
  const defaultEvents = { completion: true, error: true, contextOverflow: true, action_required: true };
  if (input.notificationEvents !== undefined && (!input.notificationEvents ||
      typeof input.notificationEvents !== 'object' || Array.isArray(input.notificationEvents)))
    throw new Error('Invalid notification events.');
  const notificationEvents = { ...defaultEvents, ...input.notificationEvents };
  if (Object.keys(notificationEvents).some(key => !Object.hasOwn(defaultEvents, key)) ||
      Object.values(notificationEvents).some(value => typeof value !== 'boolean'))
    throw new Error('Invalid notification events.');
  const disabledSkills = input.disabledSkills ?? [];
  if (!Array.isArray(disabledSkills) || disabledSkills.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) throw new Error('Invalid disabledSkills.');
  return { apiServerPort, mcpMode, maxConsecutiveToolFailures, maxTotalToolFailures,
    notificationsEnabled, notifyOnlyWhenBackgrounded, notificationEvents, disabledSkills: [...new Set(disabledSkills)] };
}
function getAppSettings() {
  const { db } = require('./db');
  const rows = db.prepare("SELECT key, value_json FROM app_settings WHERE key IN ('apiServerPort', 'mcpMode', 'maxConsecutiveToolFailures', 'maxTotalToolFailures', 'notificationsEnabled', 'notifyOnlyWhenBackgrounded', 'notificationEvents', 'disabledSkills')").all();
  return normalizeAppSettings(Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value_json)])));
}
function saveAppSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid app settings.');
  const settings = normalizeAppSettings({ ...getAppSettings(), ...input });
  const { db } = require('./db');
  const save = db.prepare('INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
  db.transaction(() => {
    save.run('apiServerPort', JSON.stringify(settings.apiServerPort));
    save.run('mcpMode', JSON.stringify(settings.mcpMode));
    save.run('maxConsecutiveToolFailures', JSON.stringify(settings.maxConsecutiveToolFailures));
    save.run('maxTotalToolFailures', JSON.stringify(settings.maxTotalToolFailures));
    save.run('notificationsEnabled', JSON.stringify(settings.notificationsEnabled));
    save.run('notifyOnlyWhenBackgrounded', JSON.stringify(settings.notifyOnlyWhenBackgrounded));
    save.run('notificationEvents', JSON.stringify(settings.notificationEvents));
    save.run('disabledSkills', JSON.stringify(settings.disabledSkills));
  })();
  return settings;
}
Object.assign(module.exports, { normalizeAppSettings, getAppSettings, saveAppSettings });

function saveNotificationPrefs(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some(key => !['notificationsEnabled', 'notifyOnlyWhenBackgrounded', 'notificationEvents'].includes(key)))
    throw new Error('Invalid notification preferences.');
  if (patch.notificationEvents !== undefined && (!patch.notificationEvents ||
      typeof patch.notificationEvents !== 'object' || Array.isArray(patch.notificationEvents)))
    throw new Error('Invalid notification events.');
  const current = getAppSettings();
  return saveAppSettings({ ...current, ...patch,
    notificationEvents: { ...current.notificationEvents, ...patch.notificationEvents } });
}
module.exports.saveNotificationPrefs = saveNotificationPrefs;

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
