'use strict';
const { randomUUID } = require('node:crypto');
const chats = new Map();
const receipts = new WeakSet();
const pending = new Set();
const database = () => require('./db');
function scope(sessionId, projectId) {
  if (!sessionId || !projectId || !database().isInitialized()) return false;
  return database().db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id === projectId;
}
const casualKey = 'casualTerminalApprovals';
function casualSession(sessionId) {
  return Boolean(sessionId && database().isInitialized() &&
    database().db.prepare('SELECT id FROM sessions WHERE id = ? AND project_id IS NULL').get(sessionId));
}
function persistentCasual() {
  if (!database().isInitialized()) return [];
  try {
    const rows = JSON.parse(database().db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(casualKey)?.value_json || '[]');
    return Array.isArray(rows) ? rows.filter(row => row && ['execute_command', 'run_tests'].includes(row.tool) &&
      row.rule_key === JSON.stringify(['native-casual-terminal', row.tool]) && row.scope === 'persistent') : [];
  } catch { return []; }
}
function writeCasual(rows) {
  database().db.prepare('INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(casualKey, JSON.stringify(rows));
}
function revokeCasual() {
  const ids = database().db.prepare('SELECT id FROM sessions WHERE project_id IS NULL').all().map(row => row.id);
  require('./lspExecutionContext').invalidateRules(ids);
  for (const entry of [...pending]) if (ids.includes(entry.sessionId)) entry.stop();
}
function list(projectId, sessionId) {
  if (!projectId && database().isInitialized() && (!sessionId || casualSession(sessionId)))
    return [...persistentCasual(), ...(chats.get(sessionId)?.values() ?? [])];

  if (!database().isInitialized() || !projectId || (sessionId && !scope(sessionId, projectId))) return [];
  const project = database().db.prepare('SELECT *, \'project\' AS scope FROM project_tool_rules WHERE project_id = ?').all(projectId);
  return [...project, ...(scope(sessionId, projectId) ? [...(chats.get(sessionId)?.values() ?? [])].filter(rule => rule.project_id === projectId) : [])];
}
function changed(projectId, sessionId = null, except = null) {
  const ids = sessionId ? [sessionId] : database().db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(projectId).map(row => row.id);
  require('./lspExecutionContext').invalidateRules(ids);
  for (const entry of [...pending]) if (entry !== except && ids.includes(entry.sessionId)) entry.stop();
}
function save({ projectId, sessionId, tool, policy, choice, pendingEntry }) {
  if (!projectId && casualSession(sessionId) && policy?.casualTerminal &&
      policy.rememberable && ['execute_command', 'run_tests'].includes(tool) &&
      policy.rememberKey === JSON.stringify(['native-casual-terminal', tool]) && ['chat', 'project'].includes(choice)) {
    const rule = { id: randomUUID(), tool, rule_key: policy.rememberKey, label: tool, scope: choice === 'chat' ? 'chat' : 'persistent' };
    if (choice === 'chat') {
      if (!chats.has(sessionId)) chats.set(sessionId, new Map());
      chats.get(sessionId).set(rule.rule_key, rule);
    } else writeCasual([...persistentCasual().filter(row => row.rule_key !== rule.rule_key), rule]);
    const receipt = { allowed: true, revision: require('./lspExecutionContext').revision(sessionId) };
    receipts.add(receipt); return receipt;
  }
  if (!scope(sessionId, projectId) || !policy?.rememberable || !policy.rememberKey ||
      !['chat', 'project'].includes(choice)) throw new Error('This approval cannot be remembered.');
  const rule = { id: randomUUID(), project_id: projectId, tool, rule_key: policy.rememberKey, label: policy.rememberLabel,
    scope: choice, created_by_session: sessionId, use_count: 0 };
  if (choice === 'chat') {
    let rules = chats.get(sessionId);
    if (!rules) chats.set(sessionId, rules = new Map());
    if (rules.size >= 200 && !rules.has(rule.rule_key)) throw new Error('Chat tool rule limit (200) reached.');
    rules.set(rule.rule_key, rule);
  } else {
    database().db.transaction(() => {
      const existing = database().db.prepare('SELECT id FROM project_tool_rules WHERE project_id = ? AND rule_key = ?').get(projectId, rule.rule_key);
      if (existing) rule.id = existing.id;
      else database().db.prepare('INSERT INTO project_tool_rules (id, project_id, tool, rule_key, label, created_by_session) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rule.id, projectId, tool, rule.rule_key, rule.label, sessionId);
    }).immediate();
  }
  changed(projectId, choice === 'chat' ? sessionId : null, pendingEntry);
  const receipt = { allowed: true, revision: require('./lspExecutionContext').revision(sessionId) };
  receipts.add(receipt); return receipt;
}
function consumeReceipt(value) { return value && receipts.delete(value); }
function remove(projectId, id, sessionId) {
  if (!projectId) {
    writeCasual(persistentCasual().filter(row => row.id !== id));
    revokeCasual(); return;
  }
  if (scope(sessionId, projectId)) {
    const rules = chats.get(sessionId);
    for (const [key, rule] of rules ?? []) if (rule.id === id) { rules.delete(key); changed(projectId, sessionId); return; }
  }
  const result = database().db.prepare('DELETE FROM project_tool_rules WHERE project_id = ? AND id = ?').run(projectId, id);
  if (result.changes) changed(projectId);
}
function removeAll(projectId) {
  if (!projectId) { writeCasual([]); revokeCasual(); return; }
  database().db.prepare('DELETE FROM project_tool_rules WHERE project_id = ?').run(projectId);
  changed(projectId);
}
function used(rule, sessionId) {
  if (!rule) return;
  if (rule.scope === 'project') database().db.prepare('UPDATE project_tool_rules SET last_used_at = CURRENT_TIMESTAMP, use_count = use_count + 1 WHERE id = ?').run(rule.id);
  else for (const row of chats.get(sessionId)?.values() ?? []) if (row.id === rule.id) { row.use_count++; row.last_used_at = new Date().toISOString(); }
}
function track(entry) { pending.add(entry); return () => pending.delete(entry); }
function forget(sessionId) { chats.delete(sessionId); }
function providerKey(provider) { return JSON.stringify([provider.id ?? provider.providerId ?? null, provider.apiType, provider.baseUrl ?? null]); }
module.exports = { providerKey, list, save, remove, removeAll, used, track, consumeReceipt, forget };
