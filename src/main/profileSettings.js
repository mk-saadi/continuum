'use strict';
const { db } = require('./db');
const { getGlobalSamplingParams, saveGlobalSamplingParams, validateSamplingParams, parseSamplingParams } = require('./samplingManager');
const { KEYS, getEffectiveSettings, toSamplingParams, fromSamplingParams } = require('./settingsResolver');
function getProfileSettings() {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'model_profiles'").get();
  const saved = row ? JSON.parse(row.value_json) : {};
  return { systemPrompt: saved.systemPrompt ?? '', ...fromSamplingParams(getGlobalSamplingParams()), perModelConfigs: saved.perModelConfigs || {} };
}
function validateProfile(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid profile settings.');
  for (const key of Object.keys(patch)) if (!KEYS.includes(key)) throw new Error(`Unknown profile setting: ${key}`);
  if (patch.systemPrompt !== undefined && (typeof patch.systemPrompt !== 'string' || patch.systemPrompt.length > 32000 || patch.systemPrompt.includes('\0'))) throw new Error('Invalid system prompt.');
  validateSamplingParams(toSamplingParams(patch));
  return patch;
}
function saveProfileSettings(modelPath, patch) {
  if (modelPath != null && (typeof modelPath !== 'string' || !modelPath.trim() || modelPath.includes('\0'))) throw new Error('Invalid model path.');
  if (patch !== null) validateProfile(patch);
  if (modelPath == null && patch === null) throw new Error('Global defaults cannot be removed.');
  return db.transaction(() => {
    const settings = getProfileSettings();
    if (modelPath != null) {
      if (patch === null) delete settings.perModelConfigs[modelPath];
      else settings.perModelConfigs = { ...settings.perModelConfigs, [modelPath]: { ...settings.perModelConfigs[modelPath], ...patch } };
    } else {
      if (patch.systemPrompt !== undefined) settings.systemPrompt = patch.systemPrompt;
      saveGlobalSamplingParams(toSamplingParams(patch));
    }
    db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('model_profiles', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(JSON.stringify({ systemPrompt: settings.systemPrompt, perModelConfigs: settings.perModelConfigs }));
    return getProfileSettings();
  }).immediate();
}
function sessionOverrides(session) {
  const overrides = fromSamplingParams(parseSamplingParams(session?.sampling_params));
  let agent;
  try { agent = JSON.parse(session?.agent_profile || 'null'); } catch { /* Legacy malformed profile. */ }
  if (typeof agent?.system_prompt === 'string') overrides.systemPrompt = agent.system_prompt;
  return overrides;
}
function getSessionSettings(sessionId, modelPath) {
  const session = sessionId ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) : null;
  const settings = getProfileSettings();
  const overrides = sessionOverrides(session);
  const effective = getEffectiveSettings({ overrides }, modelPath || session?.model_id, settings);
  return { effective, params: toSamplingParams(effective), overrides, exists: !!session, source: Object.keys(overrides).length ? 'chat' : 'model' };
}
module.exports = { getProfileSettings, saveProfileSettings, sessionOverrides, getSessionSettings };
