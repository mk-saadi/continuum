'use strict';
const { randomUUID } = require('node:crypto');
const { db } = require('./db');
const { DEFAULT_SAMPLING_PARAMS, validateSamplingParams } = require('./samplingManager');
function identifier(id) {
  if (typeof id !== 'string' || !id.trim() || id.includes('\0')) throw new Error('Invalid agent or session ID.');
}
function validateAgent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent.');
  for (const [field, max, required] of [['name', 120, true], ['description', 2000, false], ['system_prompt', 32000, true]]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\0')) throw new Error(`Invalid agent ${field}.`);
  }
  const avatar = input.avatar_url || null;
  if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 500000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar))) throw new Error('Choose an avatar image using the file picker.');
  const model = input.model_id || null;
  if (model !== null && (typeof model !== 'string' || model.length > 4096 || model.includes('\0'))) throw new Error('Invalid agent model.');
  return { name: input.name.trim(), description: (input.description || '').trim(), system_prompt: input.system_prompt.trim(), avatar_url: avatar,
    model_id: model, sampling_params: { ...DEFAULT_SAMPLING_PARAMS, ...validateSamplingParams(input.sampling_params ?? {}) } };
}
function decode(row) {
  return { ...row, sampling_params: JSON.parse(row.sampling_params || '{}') };
}
function listAgents() { return db.prepare('SELECT * FROM agents ORDER BY created_at, name, id').all().map(decode); }
function getAgent(id) {
  identifier(id);
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) throw new Error('Agent not found.');
  return decode(row);
}
function createAgent(input) {
  const agent = validateAgent(input), id = randomUUID();
  db.prepare('INSERT INTO agents(id, name, description, system_prompt, avatar_url, model_id, sampling_params) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, agent.name, agent.description, agent.system_prompt, agent.avatar_url, agent.model_id, JSON.stringify(agent.sampling_params));
  return getAgent(id);
}
function updateAgent(id, input) {
  identifier(id); const agent = validateAgent(input);
  const result = db.prepare('UPDATE agents SET name = ?, description = ?, system_prompt = ?, avatar_url = ?, model_id = ?, sampling_params = ? WHERE id = ?')
    .run(agent.name, agent.description, agent.system_prompt, agent.avatar_url, agent.model_id, JSON.stringify(agent.sampling_params), id);
  if (!result.changes) throw new Error('Agent not found.');
  return getAgent(id);
}
function duplicateAgent(id) { const agent = getAgent(id); return createAgent({ ...agent, name: `${agent.name.slice(0, 113)} (copy)` }); }
function deleteAgent(id) {
  identifier(id);
  if (!db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes) throw new Error('Agent not found.');
  return { deleted: true };
}
function getSessionAgent(sessionId) {
  identifier(sessionId);
  const row = db.prepare('SELECT agent_profile FROM sessions WHERE id = ?').get(sessionId);
  return row?.agent_profile ? JSON.parse(row.agent_profile) : null;
}
function applyAgent(sessionId, agentId, modelId) {
  identifier(sessionId);
  if (modelId != null && typeof modelId !== 'string') throw new Error('Invalid model ID.');
  return db.transaction(() => {
    const agent = agentId === null ? null : getAgent(agentId);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (session?.is_compressing) throw new Error('History is being summarized. Please retry shortly.');
    const model = agent?.model_id || session?.model_id || modelId || null;
    if (!session) db.prepare('INSERT INTO sessions(id, model_id) VALUES (?, ?)').run(sessionId, model);
    db.prepare('UPDATE sessions SET agent_profile = ?, sampling_params = ?, model_id = ? WHERE id = ?')
      .run(agent ? JSON.stringify(agent) : null, agent ? JSON.stringify(agent.sampling_params) : null, model, sessionId);
    return { agent, modelId: model };
  }).immediate();
}
module.exports = { listAgents, getAgent, createAgent, updateAgent, duplicateAgent, deleteAgent, getSessionAgent, applyAgent };

function saveSessionPrompt(sessionId, prompt, modelId) {
  identifier(sessionId);
  if (typeof prompt !== 'string' || prompt.length > 32000 || prompt.includes('\0')) throw new Error('Invalid session system prompt.');
  if (modelId != null && typeof modelId !== 'string') throw new Error('Invalid model ID.');
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (row?.is_compressing) throw new Error('History is being summarized. Please retry shortly.');
    if (!row) db.prepare('INSERT INTO sessions(id, model_id) VALUES (?, ?)').run(sessionId, modelId || null);
    const previous = getSessionAgent(sessionId);
    const profile = previous ? { ...previous, system_prompt: prompt } : prompt.trim() ? { id: null, name: 'Assistant', system_prompt: prompt, avatar_url: null, model_id: modelId || null } : null;
    db.prepare('UPDATE sessions SET agent_profile = ? WHERE id = ?').run(profile ? JSON.stringify(profile) : null, sessionId);
    return profile;
  }).immediate();
}
module.exports.saveSessionPrompt = saveSessionPrompt;
