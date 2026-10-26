'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'response-cost-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');

const { getSessionCost } = require('../src/main/sessionCosts');
const { logTokenUsage, setRetention } = require('../src/main/tokenUsage');
const now = new Date('2026-10-27T00:00:00Z');
const log = (turnId, chatId, total, provider = 'cloud') => logTokenUsage({
  turnId, chatId, provider, promptTokens: 100, completionTokens: 10,
  timestamp: '2026-08-01T00:00:00Z',
  cost: total == null ? null : { total, currency: 'USD', completeness: 'complete' },
}, now);

test('chat spend survives compaction, retention, and restart without counting snapshots twice', () => {
  try {
    initDatabase(directory);
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run('chat-a');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run('chat-b');
    log('turn-a', 'chat-a', 0.01);
    log('turn-a', 'chat-a', 0.02);
    log('turn-b', 'chat-b', 9);
    log('local-turn', 'chat-a', null, 'local');
    assert.deepEqual(getSessionCost({ sessionId: 'chat-a' }), { total: 0.02, partial: false, currency: 'USD' });
    db.prepare(`INSERT INTO subagent_runs(child_session_id, parent_session_id, provider, status, updated_at,
      cost_total, cost_completeness) VALUES ('child-a', 'chat-a', 'cloud', 'completed', ?, 0.03, 'complete')`).run(now.toISOString());
    db.prepare(`UPDATE subagent_runs SET cost_total = 0.04 WHERE child_session_id = 'child-a'`).run();
    assert.equal(getSessionCost({ sessionId: 'chat-a' }).total, 0.06);
    // Existing usage records are imported when an older database is opened.
    db.prepare('DELETE FROM session_cost_entries').run();
    closeDatabase(); initDatabase(directory);
    assert.equal(getSessionCost({ sessionId: 'chat-a' }).total, 0.06);
    log('unknown', 'chat-a', null);
    assert.equal(getSessionCost({ sessionId: 'chat-a' }).partial, true);
    db.prepare(`INSERT INTO messages(session_id, role, content) VALUES ('chat-a', 'assistant', 'Old reply')`).run();
    db.prepare(`UPDATE messages SET archived = 1, is_summarized = 1 WHERE session_id = 'chat-a'`).run();
    assert.equal(getSessionCost({ sessionId: 'chat-a' }).total, 0.06);
    db.prepare(`DELETE FROM messages WHERE session_id = 'chat-a'`).run();
    setRetention(1, now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get().n, 0);
    assert.equal(getSessionCost({ sessionId: 'chat-a' }).total, 0.06);
    closeDatabase(); initDatabase(directory);
    assert.deepEqual(getSessionCost({ sessionId: 'chat-a' }), { total: 0.06, partial: true, currency: 'USD' });
    assert.equal(getSessionCost({ sessionId: 'chat-b' }).total, 9);
    db.prepare(`DELETE FROM sessions WHERE id = 'chat-a'`).run();
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_cost_entries WHERE chat_id = 'chat-a'`).get().n, 0);
    assert.equal(getSessionCost({ sessionId: 'chat-b' }).total, 9);
    assert.throws(() => getSessionCost({ sessionId: '' }), /Invalid session/);
  } finally {
    closeDatabase(); Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
