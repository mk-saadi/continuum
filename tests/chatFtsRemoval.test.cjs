// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/chatFtsRemoval.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-fts-removal-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { executeMemoryTool } = require('../src/main/memoryToolExecutor');
const { searchMemoryDatabase } = require('../src/main/memorySearchCore');

(async () => {
  try {
    database.initDatabase();
    const { db } = database;
    db.prepare("INSERT INTO projects(id, name) VALUES ('project', 'Preserved project')").run();
    db.prepare("INSERT INTO sessions(id, model_id, project_id) VALUES ('chat', 'model', 'project')").run();
    const first = sessions.saveMessage('chat', 'user', 'Lunar garden rule', [], null, null).id;
    const answer = sessions.saveMessage('chat', 'assistant', 'Lunar design response', [], null, null).id;
    sessions.editMessage(first, 'Lunar garden revised');
    db.prepare("INSERT INTO permanent_memories(category, content, scope) VALUES ('rule', 'Lunar architecture rule', 'project')").run();
    database.closeDatabase();
    database.initDatabase(); // Existing startup normalization settles variants before the migration snapshot.
    const beforeMessages = db.prepare('SELECT * FROM messages ORDER BY id').all();
    const beforeMemories = db.prepare('SELECT * FROM permanent_memories ORDER BY id').all();
    const beforeSessions = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    const databasePath = database.getDatabasePath();
    assert.ok(beforeMessages.some(row => row.id === answer), 'regenerated branches remain stored as message rows');
    database.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`CREATE VIRTUAL TABLE chat_fts USING fts5(content, content='messages', content_rowid='id');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content); END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.id, old.content); END;
      CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content); END;
      INSERT INTO chat_fts(chat_fts) VALUES ('rebuild');`);
    assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_fts'").get());
    legacy.close();

    database.initDatabase();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map(row => row.name);
    for (const name of ['chat_fts', 'messages_ai', 'messages_ad', 'messages_au']) assert.ok(!names.includes(name));
    assert.ok(!names.some(name => name.startsWith('chat_fts_')), 'FTS shadow tables are removed with the virtual table');
    for (const name of ['messages', 'permanent_memories', 'memory_fts', 'sessions', 'message_attachments', 'session_summaries']) assert.ok(names.includes(name));
    assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), beforeMessages);
    assert.deepEqual(db.prepare('SELECT * FROM permanent_memories ORDER BY id').all(), beforeMemories);
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY id').all(), beforeSessions);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'lunar'").get().n, 1);
    assert.equal(database.searchChatHistory('lunar').length, 3);
    const toolResult = await executeMemoryTool({ name: 'search_memory', modelId: 'model', sessionId: 'chat',
      arguments: { query: 'lunar', target: 'all' } });
    assert.match(toolResult, /Lunar architecture rule/);
    assert.match(toolResult, /\[MATCH\]Lunar\[\/MATCH\] garden revised/);
    const cancellation = new AbortController();
    cancellation.abort();
    assert.equal((await executeMemoryTool({ name: 'search_memory', modelId: 'model', signal: cancellation.signal,
      arguments: { query: 'lunar' } })).success, false);

    const firstPage = searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', limit: 1 });
    assert.equal(firstPage.chatMatches.length, 1);
    assert.equal(firstPage.partial, true);
    const secondPage = searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', limit: 1, cursor: firstPage.nextCursor });
    assert.notEqual(secondPage.chatMatches[0].id, firstPage.chatMatches[0].id);
    const oldest = searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', limit: 1, order: 'oldest' });
    assert.equal(oldest.chatMatches[0].id, first);
    const filtered = searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', role: 'assistant' });
    assert.ok(filtered.chatMatches.every(row => row.role === 'assistant'));
    assert.equal(searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', project_id: 'other' }).chatMatches.length, 0);
    assert.equal(searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', since: '2099-01-01' }).chatMatches.length, 0);
    assert.equal(searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', until: beforeMessages[0].created_at.slice(0, 10) }).chatMatches.length, 3);
    assert.equal(searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', session_id: 'chat' }).chatMatches.length, 3);
    const timedOut = searchMemoryDatabase(db, { query: 'lunar', modelId: 'model', target: 'session', deadline: Date.now() - 1 });
    assert.equal(timedOut.partial, true);
    assert.equal(timedOut.timedOut, true);

    database.closeDatabase();
    database.initDatabase();
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_fts'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), beforeMessages);
    database.closeDatabase();
    const fresh = path.join(directory, 'fresh');
    database.initDatabase(fresh);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_fts'").get(), undefined);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts'").get());
    console.log('Chat FTS removal preserves messages, branches, metadata, permanent memory, and search on existing and fresh databases.');
  } finally {
    database.closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
