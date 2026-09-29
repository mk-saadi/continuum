'use strict';
const { db } = require('./db');
const MONTHS = [1, 3, 6, 12];
const KEY = 'token_history_retention_months';
function validateMonths(months) {
  if (!MONTHS.includes(months)) throw new TypeError('Retention must be 1, 3, 6, or 12 months.');
  return months;
}
function getRetention() {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(KEY);
  return row ? validateMonths(JSON.parse(row.value_json)) : 12;
}
function cutoff(months, now) {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
function prune(now = new Date()) {
  db.prepare('DELETE FROM token_usage WHERE timestamp < ?').run(cutoff(getRetention(), now));
}
function setRetention(months, now = new Date()) {
  validateMonths(months);
  db.transaction(() => {
    db.prepare('INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(KEY, JSON.stringify(months));
    prune(now);
  })();
  return months;
}
// One row per generated turn. Repeated cumulative snapshots (pause/resume) replace
// the same row; regeneration uses a fresh turn ID. Chat deletion keeps usage totals.
function logTokenUsage({ turnId, chatId = null, projectId = null, timestamp = new Date().toISOString(), promptTokens, completionTokens }, now = new Date()) {
  if (typeof turnId !== 'string' || !turnId) throw new TypeError('Missing usage turn ID.');
  for (const value of [chatId, projectId]) if (value !== null && typeof value !== 'string') throw new TypeError('Invalid usage identifier.');
  for (const count of [promptTokens, completionTokens]) if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid token count.');
  timestamp = new Date(timestamp).toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens`)
      .run(turnId, chatId, projectId, timestamp, promptTokens, completionTokens);
    prune(now);
  })();
}
function getTokenHistory({ groupBy = 'month', projectId = null, months = getRetention() } = {}, now = new Date()) {
  validateMonths(months);
  if (!['week', 'month'].includes(groupBy)) throw new TypeError('Invalid grouping.');
  if (projectId !== null && typeof projectId !== 'string') throw new TypeError('Invalid project ID.');
  const retentionMonths = getRetention();
  months = Math.min(months, retentionMonths);
  prune(now);
  const from = cutoff(months, now), to = new Date(now).toISOString();
  const bucket = groupBy === 'month' ? "strftime('%Y-%m-01', timestamp)" : "date(timestamp, '-' || ((CAST(strftime('%w', timestamp) AS INTEGER) + 6) % 7) || ' days')";
  const rows = db.prepare(`SELECT ${bucket} AS period, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens, COUNT(*) AS turns
    FROM token_usage WHERE timestamp >= ? AND timestamp <= ? ${projectId === null ? '' : 'AND project_id = ?'} GROUP BY period ORDER BY period`)
    .all(...[from, to, ...(projectId === null ? [] : [projectId])]);
  const byPeriod = new Map(rows.map(row => [row.period, row]));
  const cursor = new Date(from); cursor.setUTCHours(0, 0, 0, 0);
  if (groupBy === 'month') cursor.setUTCDate(1);
  else cursor.setUTCDate(cursor.getUTCDate() - (cursor.getUTCDay() + 6) % 7);
  const data = [];
  while (cursor <= new Date(now)) {
    const period = cursor.toISOString().slice(0, 10);
    data.push(byPeriod.get(period) || { period, promptTokens: 0, completionTokens: 0, turns: 0 });
    if (groupBy === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return { data, retentionMonths, months, groupBy, from, to };
}
module.exports = { logTokenUsage, getTokenHistory, getRetention, setRetention };
