// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/sessionHistory.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-history-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const legacy = new Database(path.join(directory, 'memory_palace.db'));
legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, title TEXT, model_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_active_at TEXT DEFAULT CURRENT_TIMESTAMP,
  is_compressing INTEGER DEFAULT 0); INSERT INTO sessions(id) VALUES ('legacy');`);
legacy.close();
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { prepareChatMessages } = require('../src/main/promptBuilder');
try {
  initDatabase();
  assert.equal(sessions.loadSession('legacy').folder_name, 'Uncategorized');
  closeDatabase(); initDatabase();
  sessions.getOrCreateSession('a', 'model');
  sessions.getOrCreateSession('b', 'model');
  sessions.createFolder('Projects');
  sessions.createFolder('Empty folder');
  assert.throws(() => sessions.createFolder(' Projects '), /already exists/);
  assert.throws(() => sessions.createFolder('Uncategorized'), /reserved/);
  assert.throws(() => sessions.createFolder(' '), /non-empty/);
  assert.throws(() => sessions.updateSession('missing', 'folder_name', 'Ghost'), /not found/);
  assert.ok(!sessions.getAllSessions().some(group => group.folder_name === 'Ghost'));
  sessions.updateSession('a', 'folder_name', 'Projects');
  assert.equal(sessions.loadSession('a').folder_name, 'Projects');
  assert.equal(sessions.loadSession('b').folder_name, 'Uncategorized');
  closeDatabase(); initDatabase();
  assert.equal(sessions.getAllSessions().find(group => group.folder_name === 'Empty folder').sessions.length, 0);
  assert.equal(sessions.getAllSessions().at(-1).folder_name, 'Uncategorized');
  const first = sessions.saveMessage('a', 'user', 'original').id;
  const reply = sessions.saveMessage('a', 'assistant', 'discard').id;
  sessions.saveMessage('b', 'user', 'keep other session');
  db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (?, ?, ?)').run(reply, '/tmp/file', 'text/plain');
  db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run('a', 'stale');
  db.prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(first);
  const tokenTotal = sessions.getAllSessions().flatMap(group => group.sessions).find(session => session.id === 'a').total_tokens;
  assert.equal(tokenTotal, sessions.estimateTokens('original') + sessions.estimateTokens('discard'));
  const retained = sessions.editMessage(first, 'edited');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].content, 'edited');
  assert.equal(retained[0].archived, 0);
  assert.equal(sessions.getSessionSummary('a'), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_attachments').get().n, 0);
  assert.equal(sessions.loadSession('b').messages.length, 1);
  const prompt = prepareChatMessages({sessionId: 'a', modelId: 'model', userText: 'edited', regenerate: true});
  assert.equal(prompt.filter(m => m.role === 'user').length, 1);
  assert.equal(sessions.loadSession('a').messages.length, 1);
  sessions.updateSession('a', 'title', 'Renamed');
  sessions.updateSession('a', 'folder_name', '__proto__');
  assert.equal(sessions.getAllSessions().find(g => g.folder_name === '__proto__').sessions[0].title, 'Renamed');
  db.prepare('UPDATE sessions SET is_compressing = 1 WHERE id = ?').run('a');
  assert.throws(() => sessions.editMessage(first, 'blocked'), /summarized/);
  assert.equal(sessions.loadSession('a').messages[0].content, 'edited');
  db.prepare('UPDATE sessions SET is_compressing = 0 WHERE id = ?').run('a');
  db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (?, ?, ?)').run(first, '/tmp/file', 'text/plain');
  sessions.deleteSession('a');
  assert.equal(sessions.getAllSessions().find(group => group.folder_name === '__proto__').sessions.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_attachments').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH 'edited'").get().n, 0);
  assert.throws(() => sessions.loadSession('a'), /not found/);
  console.log('Session history migration, edit, regeneration, grouping, and cascade checks passed.');
} finally {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}
