'use strict';
const SETTING = 'model-capability-overrides';
function keyFor(target) {
  if (target?.type === 'local') {
    if (typeof target.modelId !== 'string' || !require('node:path').isAbsolute(target.modelId) || target.modelId.includes('\0')) throw new Error('Invalid local model.');
    return JSON.stringify(['local', target.modelId]);
  }
  if (target?.type === 'cloud') {
    const provider = require('./cloudProviders').getCloudProviders().find(row => row.id === target.provider);
    if (!provider) throw new Error('Select a saved cloud provider and model.');
    const model = typeof target.model === 'string' ? target.model.trim() : '';
    if (!model) throw new Error('Select a saved cloud provider and model.');
    return JSON.stringify(['cloud', provider.id, provider.baseUrl, model]);
  }
  throw new Error('Invalid capability target.');
}
function readOverrides() {
  const row = require('./db').db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTING);
  const value = row ? JSON.parse(row.value_json) : {};
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function getOverrides(target) { return readOverrides()[keyFor(target)] || {}; }
function saveOverrides(target, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.entries(input).some(([key, value]) => {
    if (key === 'contextLength') return target?.type !== 'cloud' || (value !== null && (!Number.isSafeInteger(value) || value <= 0));
    return !['image', 'audio', 'video'].includes(key) || (value !== null && typeof value !== 'boolean');
  })) throw new Error('Invalid capability overrides.');
  const key = keyFor(target), all = readOverrides();
  const patch = Object.fromEntries(Object.entries(input).filter(([,value]) => value !== null));
  if (Object.keys(patch).length) all[key] = patch; else delete all[key];
  require('./db').db.prepare('INSERT INTO app_settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(SETTING, JSON.stringify(all));
  return all;
}
function applyOverrides(detected = {}, overrides = {}) {
  const result = { ...detected };
  for (const kind of ['image', 'audio', 'video']) if (typeof overrides[kind] === 'boolean') result[kind] = overrides[kind];
  return result;
}
module.exports = { keyFor, readOverrides, getOverrides, saveOverrides, applyOverrides };
