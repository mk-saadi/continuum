'use strict';
// Phase 4 session-history query work: batched attachments/siblings, single
// variants parse, and shared in-flight listing dedup. Deterministic fixtures,
// no wall-clock assertions. Run with: node --test tests/sessionHistoryPerf.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sesshist-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const { fetchSessionGroups } = require('../src/lib/sessionGroups.mjs');

// Test-only statement counter: counts prepared-statement executions by
// normalized SQL so tests pin query bounds without wall-clock assertions.
const stmtCounts = {};
{
  const bs3 = require('better-sqlite3');
  const origPrepare = bs3.prototype.prepare;
  bs3.prototype.prepare = function (sql) {
    const stmt = origPrepare.call(this, sql);
    const key = String(sql).replace(/\s+/g, ' ').trim().slice(0, 80);
    return new Proxy(stmt, {
      get: (target, prop) => {
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          return (...a) => { stmtCounts[`${prop}:${key}`] = (stmtCounts[`${prop}:${key}`] ?? 0) + 1; return target[prop](...a); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}
const resetStmtCounts = () => { for (const key of Object.keys(stmtCounts)) delete stmtCounts[key]; };
const countStatements = (prefix) => Object.entries(stmtCounts)
  .filter(([key]) => key.startsWith(prefix))
  .reduce((sum, [, n]) => sum + n, 0);

test.after(() => {
  try { closeDatabase(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
});

function outcomeReason(outcome) { return String(outcome.reason?.message ?? outcome.reason); }

test('1. concurrent listings share one in-flight request', async () => {
  let calls = 0;
  const api = { getAllSessions: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return [{ folder_name: 'F', sessions: [] }]; } };
  const results = await Promise.all(Array.from({ length: 10 }, () => fetchSessionGroups(api)));
  assert.equal(calls, 1, 'ten simultaneous tabs cause one IPC');
  for (const result of results) assert.equal(result, results[0], 'every waiter shares the identical result');
});

test('2. sequential refreshes always fetch fresh data', async () => {
  let calls = 0;
  const api = { getAllSessions: async () => (++calls, [{ folder_name: 'F', sessions: [{ id: `s${calls}` }] }]) };
  const first = await fetchSessionGroups(api);
  const second = await fetchSessionGroups(api);
  assert.equal(calls, 2, 'resolved results are never served from cache');
  assert.notDeepEqual(first, second);
});

test('3. shared rejection reaches every waiter and clears the slot', async () => {
  let calls = 0;
  const api = { getAllSessions: async () => { calls++; throw new Error('db down'); } };
  const outcomes = await Promise.allSettled([fetchSessionGroups(api), fetchSessionGroups(api), fetchSessionGroups(api)]);
  assert.equal(calls, 1);
  for (const outcome of outcomes) assert.equal(outcome.status, 'rejected');
  assert.equal(outcomeReason(outcomes[0]), 'db down');
  await assert.rejects(fetchSessionGroups(api), /db down/, 'slot cleared: next caller retries');
  assert.equal(calls, 2);
});

test('4. missing API rejects without caching failure', async () => {
  await assert.rejects(fetchSessionGroups(null), /unavailable/);
  await assert.rejects(fetchSessionGroups({}), /unavailable/);
});

// NOTE: loadSession follows the active-leaf chain, so only on-path messages
// load. The chain below is u1 -> a2 -> a3 (leaf); a4 branches off u1 and
// stays off-path, which is exactly what exercises sibling grouping.
test('5. batched attachments preserve associations, order, and shapes', async () => {
  const sid = 'hist-attach-1';
  sessions.getOrCreateSession(sid, 'model-x', null);
  const insertMessage = (row) => db.prepare(`INSERT INTO messages
    (session_id, parent_id, role, content, status, estimated_tokens, stats, tool_calls, thinking_text, thinking_duration, execution_steps, variants, active_variant_index, model_name)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sid, row.parent_id ?? null, row.role, row.content, row.estimated_tokens ?? 10,
    row.stats ?? null, row.tool_calls ?? null, row.thinking_text ?? null, row.thinking_duration ?? null,
    row.execution_steps ?? null, row.variants ?? null, row.active_variant_index ?? 0, row.model_name ?? null,
  ).lastInsertRowid;

  const u1 = insertMessage({ role: 'user', content: 'hello' });
  const a2 = insertMessage({ role: 'assistant', content: 'second answer', parent_id: u1,
    tool_calls: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]),
    thinking_text: 'hmm', thinking_duration: 1.5 });
  const variants = JSON.stringify([
    { content: 'v0 text', status: 'completed', executionSteps: [{ type: 'thought', content: 'v0', durationMs: 10 }] },
    'legacy v1 text',
  ]);
  const a3 = insertMessage({ role: 'assistant', content: 'v1 text', parent_id: a2, variants,
    active_variant_index: 1, model_name: 'm',
    stats: JSON.stringify({ startTime: 0, endTime: 1, time: 1, promptTokens: 5, completionTokens: 3, totalTokens: 8, tokensPerSecond: 3, scope: 'final' }),
    execution_steps: JSON.stringify([{ type: 'thought', content: 't', durationMs: 100 }]) });
  const a4 = insertMessage({ role: 'assistant', content: 'off-path branch', parent_id: u1 });
  for (const [messageId, file] of [[a2, '/f/one.txt'], [a3, '/f/a.txt'], [a3, '/f/b.txt'], [a3, '/f/c.txt']]) {
    db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (?, ?, ?)').run(messageId, file, 'text/plain');
  }
  db.prepare('UPDATE sessions SET active_leaf_id = ? WHERE id = ?').run(a3, sid);

  const loaded = sessions.loadSession(sid);
  assert.deepEqual(loaded.messages.map((m) => m.id), [u1, a2, a3], 'active-leaf chain loads');
  const byId = new Map(loaded.messages.map((m) => [m.id, m]));
  assert.deepEqual(byId.get(u1).attachments, [], 'messages without attachments map to []');
  assert.deepEqual(byId.get(a2).attachments.map((a) => a.file_path), ['/f/one.txt']);
  assert.deepEqual(byId.get(a3).attachments.map((a) => a.file_path), ['/f/a.txt', '/f/b.txt', '/f/c.txt'], 'multi-attachment order preserved');
  assert.equal(byId.get(a2).thinkingText, 'hmm');
  assert.equal(byId.get(a2).toolCalls[0].function.name, 'read');
  assert.equal(byId.get(a2).executionSteps.length, 2, 'steps derived from legacy thinking + tool calls');
  assert.deepEqual(byId.get(a2).executionSteps.map((s) => s.type), ['thought', 'tool_call']);
  assert.equal(byId.get(a3).executionSteps[0].content, 't');
  assert.equal(byId.get(a3).stats.totalTokens, 8);
  assert.equal(byId.get(a3).variants.length, 2);
  assert.equal(byId.get(a3).content, 'legacy v1 text', 'content matches the active variant (single-parse result)');
  assert.equal(byId.get(a3).variants[0].content, 'v0 text');
  assert.equal(byId.get(a3).modelName, 'm');
  assert.deepEqual(byId.get(a2).siblings, [a2, a4], 'siblings span on- and off-path branches');
  assert.deepEqual(byId.get(u1).siblings, [u1]);
  assert.deepEqual(byId.get(a3).siblings, [a3]);
  for (const message of loaded.messages) {
    const direct = db.prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id').all(message.id);
    assert.deepEqual(message.attachments, direct, 'batched rows match per-message reads');
  }
});

test('6. empty transcript loads with no messages', async () => {
  sessions.getOrCreateSession('hist-empty-1', 'model-x', null);
  assert.deepEqual(sessions.getActiveMessages('hist-empty-1'), []);
});

test('6b. large session loads all messages with attachments', async () => {
  const big = 'hist-big-1';
  sessions.getOrCreateSession(big, 'model-x', null);
  for (let i = 0; i < 200; i++) {
    sessions.saveMessage(big, i % 2 ? 'assistant' : 'user', `message ${i} ` + 'word '.repeat(30), [],
      i % 2 ? { startTime: 0, endTime: 1, time: 1, promptTokens: 50, completionTokens: 10, totalTokens: 60, tokensPerSecond: 10, scope: 'final' } : null);
  }
  const rows = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id').all(big);
  rows.forEach((row, idx) => {
    if (idx % 4 === 0) db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (?, ?, ?)').run(row.id, `/f/${idx}.txt`, 'text/plain');
  });
  const loaded = sessions.loadSession(big);
  assert.equal(loaded.messages.length, 200);
  const withAttachments = loaded.messages.filter((m) => m.attachments.length > 0).length;
  assert.equal(withAttachments, 50, 'every fourth message carries its attachment');
});

test('6c. large session issues one attachment and one siblings query', async () => {
  resetStmtCounts();
  const loaded = sessions.loadSession('hist-big-1');
  assert.equal(loaded.messages.length, 200);
  assert.equal(countStatements('all:SELECT * FROM message_attachments'), 1, 'no per-message attachment query at 200 messages');
  assert.equal(countStatements('all:SELECT id, role, parent_id FROM messages'), 1, 'no per-message siblings query at 200 messages');
  const total = Object.values(stmtCounts).reduce((a, b) => a + b, 0);
  assert.ok(total < 250, `load stays bounded (got ${total}, was 602)`);
});

test('7. token aggregates and ordering stay exact', async () => {
  const mk = (id, tokens, active) => {
    sessions.getOrCreateSession(id, 'model-x', null);
    db.prepare('INSERT INTO messages(session_id, role, content, estimated_tokens) VALUES (?, ?, ?, ?)').run(id, 'user', 'x', tokens[0]);
    db.prepare('INSERT INTO messages(session_id, role, content, estimated_tokens) VALUES (?, ?, ?, ?)').run(id, 'assistant', 'y', tokens[1]);
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(active, id);
  };
  mk('hist-tok-a', [100, 50], '2026-01-01 00:00:00');
  mk('hist-tok-b', [7, 8], '2026-06-01 00:00:00');
  db.prepare("INSERT OR IGNORE INTO chat_folders(name) VALUES ('Work')").run();
  db.prepare("UPDATE sessions SET folder_name = 'Work' WHERE id = 'hist-tok-b'").run();
  const groups = sessions.getAllSessions();
  const all = groups.flatMap((g) => g.sessions);
  const a = all.find((s) => s.id === 'hist-tok-a');
  const b = all.find((s) => s.id === 'hist-tok-b');
  assert.equal(a.total_tokens, 150, 'aggregate is the exact estimated-token sum');
  assert.equal(b.total_tokens, 15);
  assert.ok(all.findIndex((s) => s.id === 'hist-tok-b') < all.findIndex((s) => s.id === 'hist-tok-a'), 'last_active_at DESC ordering preserved');
  assert.equal(groups.find((g) => g.folder_name === 'Work').sessions[0].id, 'hist-tok-b', 'folder placement preserved');
  assert.equal(groups.at(-1).folder_name, 'Uncategorized', 'uncategorized group stays last');
  assert.ok(groups.at(-1).sessions.some((s) => s.id === 'hist-tok-a'));
});
