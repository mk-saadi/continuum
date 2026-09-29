const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-compaction-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db, searchChatHistory } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { checkAndCompressContext } = require('../src/main/compressionEngine');
const { prepareChatMessages } = require('../src/main/promptBuilder');
(async () => {
  try {
    const connection = initDatabase();
    sessions.getOrCreateSession('legacy', 'model');
    sessions.saveMessage('legacy', 'user', 'Legacy retained text');
    db.prepare("UPDATE messages SET archived = 1 WHERE session_id = 'legacy'").run();
    connection.exec('ALTER TABLE messages DROP COLUMN is_summarized');
    closeDatabase(); initDatabase();
    assert.equal(sessions.loadSession('legacy').messages[0].is_summarized, 1);

    sessions.getOrCreateSession('chat', 'model');
    for (let i = 0; i < 20; i++) sessions.saveMessage('chat', i % 2 ? 'assistant' : 'user', `Original${i} `.padEnd(400, 'x'));
    const originals = sessions.loadSession('chat').messages;
    let calls = 0;
    const options = { sessionId: 'chat', modelId: 'model', contextWindowLimit: 2667,
      llmSummarizeCallback: async (old, batch) => { calls++; assert.equal(old, null); assert.ok(batch.length <= 10); return 'First rolling summary'; } };
    assert.equal((await checkAndCompressContext(options)).compressed, false);
    assert.equal(calls, 0);
    const profiles = require('../src/main/profileSettings');
    profiles.saveSessionMemorySettings('chat', 'model', { compactionEnabled: false });
    assert.equal((await checkAndCompressContext({ ...options, contextWindowLimit: 2600 })).compressed, false);
    assert.equal(calls, 0);
    assert.equal(sessions.loadSession('chat').messages.length, 20);
    profiles.saveSessionMemorySettings('chat', 'model', { compactionEnabled: true });
    const cancelled = await checkAndCompressContext({ ...options, contextWindowLimit: 2600, llmSummarizeCallback: async () => {
      profiles.saveSessionMemorySettings('chat', 'model', { compactionEnabled: false });
      return 'Discard this summary';
    } });
    assert.equal(cancelled.compressed, false);
    assert.equal(sessions.getSessionSummary('chat'), null);
    assert.ok(sessions.loadSession('chat').messages.every(row => !row.is_summarized));
    profiles.saveSessionMemorySettings('chat', 'model', { compactionEnabled: true });
    const first = await checkAndCompressContext({ ...options, contextWindowLimit: 2600 });
    assert.equal(first.compressed, true);
    assert.ok(first.summarizedMessageIds.length > 0);
    const rows = sessions.loadSession('chat').messages;
    assert.deepEqual(rows.map(row => row.content), originals.map(row => row.content));
    assert.ok(rows.slice(-10).every(row => row.is_summarized === 0));
    assert.equal(rows.filter(row => row.is_summarized === 1).length, first.archivedCount);
    assert.ok(searchChatHistory('Original0').length);
    const prompt = prepareChatMessages({ sessionId: 'chat', modelId: 'model', userText: '', regenerate: true, regenerateLast: true });
    assert.match(prompt[1].content, /^\[EARLIER CONVERSATION SUMMARY\]:\nFirst rolling summary/);
    for (const row of rows.filter(row => row.is_summarized)) assert.ok(!prompt.some(message => message.content === row.content));
    assert.ok(!prompt.some(message => message.content === rows.at(-1).content));
    for (let i = 0; i < 8; i++) sessions.saveMessage('chat', i % 2 ? 'assistant' : 'user', `More${i} `.padEnd(400, 'y'));
    const before = sessions.loadSession('chat').messages;
    await assert.rejects(checkAndCompressContext({ ...options, contextWindowLimit: 2600, llmSummarizeCallback: async () => { throw new Error('offline'); } }), /offline/);
    assert.deepEqual(sessions.loadSession('chat').messages, before);
    assert.equal(sessions.loadSession('chat').is_compressing, 0);
    await checkAndCompressContext({ ...options, contextWindowLimit: 2600, llmSummarizeCallback: async (old, batch) => {
      assert.equal(old, 'First rolling summary');
      assert.ok(batch.every(row => !first.summarizedMessageIds.includes(row.id)));
      return 'Updated rolling summary';
    } });
    assert.equal(sessions.getSessionSummary('chat'), 'Updated rolling summary');
    assert.equal(sessions.loadSession('chat').messages.length, 28);
    sessions.editMessage(originals[0].id, 'Edited original');
    assert.equal(sessions.getSessionSummary('chat'), null);
    assert.ok(sessions.loadSession('chat').messages.every(row => !row.archived && !row.is_summarized));
    console.log('Context compaction migration, retention, threshold, rolling summary, regeneration, and rollback checks passed.');
  } finally { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
