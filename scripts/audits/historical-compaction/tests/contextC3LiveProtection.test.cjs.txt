'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-live-protection-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  if (name === './mcpManager') return { getTools: () => [], getStatus: () => ({ servers: [] }) };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const engine = require('../src/main/compressionEngine');
const { rebuildChatMessages } = require('../src/main/promptBuilder');
let sequence = 0;
function fixture() {
  const id = `c3-${++sequence}`;
  sessions.getOrCreateSession(id, 'model');
  for (let i = 0; i < 24; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `record-${i} ` + 'x'.repeat(1000));
  return { id, rows: sessions.getActiveMessages(id) };
}
function options(id, summarize) {
  return { sessionId: id, modelId: 'model', contextWindowLimit: 100000,
    force: true, tools: [], llmSummarizeCallback: summarize };
}
function markLive(row) { db.prepare("UPDATE messages SET status = 'in_progress' WHERE id = ?").run(row.id); }
function archived(row) { return db.prepare('SELECT archived FROM messages WHERE id = ?').get(row.id).archived; }
function unlocked(id) { assert.equal(sessions.loadSession(id).is_compressing, 0); }
test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('idle pause protects partial content, then final update survives prompt reconstruction', async () => {
  const { id } = fixture();
  const persistence = require('../src/main/engineManager').createMessagePersistence({ sessionId: id, modelId: 'model', displayName: 'Agent' });
  const live = { id: persistence.messageId };
  persistence.update({ content: 'partial', executionSteps: [] });
  let calls = 0;
  const result = await engine.checkAndCompressContext({ ...options(id, async () => { calls++; return 'summary'; }), force: false });
  assert.equal(result.compressed, false); assert.equal(calls, 0); assert.equal(archived(live), 0);
  persistence.update({ content: 'C3 final unique finding', executionSteps: [], status: 'completed' });
  assert.ok(rebuildChatMessages({ sessionId: id, modelId: 'model' }).some(m => m.content === 'C3 final unique finding'));
  unlocked(id);
});

test('forced recovery without caller exclusions preserves the live row and entire later suffix', async () => {
  const { id, rows } = fixture(); const live = rows[11]; markLive(live);
  const result = await engine.checkAndCompressContext(options(id, async (_prior, batch) => {
    assert.ok(batch.every(m => m.id < live.id)); return 'completed historical investigation';
  }));
  assert.equal(result.compressed, true);
  assert.equal(result.archivedCount, 11);
  assert.ok(rows.slice(11).every(row => archived(row) === 0));
  assert.deepEqual(sessions.loadSession(id).messages.map(m => m.content), rows.map(m => m.content));
  unlocked(id);
});

test('status-only transition during summary generation rolls back all archival and summary writes', async () => {
  const { id, rows } = fixture();
  await assert.rejects(engine.checkAndCompressContext(options(id, async () => {
    markLive(rows[3]); return 'must never commit';
  })), /Messages changed/);
  assert.ok(rows.every(row => archived(row) === 0));
  assert.equal(sessions.getSessionSummary(id), null); unlocked(id);
});

test('live first row is irreducible without invoking generation', async () => {
  const { id, rows } = fixture(); markLive(rows[0]);
  const result = await engine.checkAndCompressContext(options(id, async () => { throw new Error('must not generate'); }));
  assert.equal(result.compressed, false); assert.equal(result.reason, 'protected-context-too-large');
  assert.ok(rows.every(row => archived(row) === 0)); unlocked(id);
});

test('overlapping compression stays locked and other sessions remain independent', async () => {
  const a = fixture(), b = fixture(); markLive(b.rows[1]);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = engine.checkAndCompressContext(options(a.id, async () => {
    entered(); await new Promise(resolve => { release = resolve; }); return 'completed historical investigation';
  }));
  await ready;
  const overlap = engine.checkAndCompressContext(options(a.id, async () => { throw new Error('duplicate generation'); }));
  release(); assert.equal((await pending).compressed, true);
  assert.equal(await overlap, await pending, 'same session shares the existing operation');
  const other = await engine.checkAndCompressContext({ ...options(b.id, async () => { throw new Error('live session'); }), force: false });
  assert.equal(other.compressed, false);
  assert.ok(b.rows.every(row => archived(row) === 0)); unlocked(a.id); unlocked(b.id);
});
