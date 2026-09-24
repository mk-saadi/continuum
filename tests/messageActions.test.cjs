const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-actions-'));
const originalLoad = Module._load;
const handlers = new Map();
Module._load = function(name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
  };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
(async () => {
  let dispose;
  try {
    initDatabase();
    dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted });
    const invoke = (channel, payload) => handlers.get(channel)({ trusted: true }, payload);
    sessions.getOrCreateSession('source', 'model');
    sessions.updateSession('source', 'folder_name', 'Work');
    const user = sessions.saveMessage('source', 'user', 'First question');
    const assistant = sessions.saveMessage('source', 'assistant', 'First answer', [], { completionTokens: 7 }, [{ id: 'tool', toolName: 'search' }], { text: 'Thinking', duration: 1 });
    sessions.saveMessage('source', 'user', 'Later question');
    db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type, estimated_tokens) VALUES (?, ?, ?, ?)').run(user.id, '/managed/image.jpg', 'image/jpeg', 100);
    db.prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(user.id);
    db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run('source', 'Includes later turns');
    await assert.rejects(handlers.get('session:branch-chat')({ trusted: false }, { sourceSessionId: 'source', targetMessageId: user.id }), /Unauthorized/);
    const branch = await invoke('session:branch-chat', { sourceSessionId: 'source', targetMessageId: assistant.id });
    const loaded = sessions.loadSession(branch.sessionId);
    assert.equal(loaded.folder_name, 'Work');
    assert.equal(loaded.model_id, 'model');
    assert.deepEqual(loaded.messages.map(m => m.content), ['First question', 'First answer']);
    assert.ok(loaded.messages.every(m => m.id !== user.id && m.id !== assistant.id && m.archived === 0));
    assert.equal(loaded.messages[0].attachments[0].estimated_tokens, 100);
    assert.equal(loaded.messages[1].stats.completionTokens, 7);
    assert.equal(loaded.messages[1].toolCalls[0].toolName, 'search');
    assert.equal(loaded.messages[1].thinkingText, 'Thinking');
    assert.equal(sessions.getSessionSummary(branch.sessionId), null);
    assert.equal(sessions.loadSession('source').messages.length, 3);
    const userBranch = sessions.branchChat('source', user.id);
    assert.equal(sessions.loadSession(userBranch.sessionId).messages.length, 1);
    await assert.rejects(invoke('session:delete-message', { sessionId: branch.sessionId, messageId: user.id }), /not found/);
    assert.throws(() => sessions.branchChat(branch.sessionId, user.id), /not found/);
    db.prepare('UPDATE sessions SET is_compressing = 1 WHERE id = ?').run('source');
    assert.throws(() => sessions.deleteMessage('source', user.id), /summarized/);
    db.prepare('UPDATE sessions SET is_compressing = 0 WHERE id = ?').run('source');
    const retained = await invoke('session:delete-message', { sessionId: 'source', messageId: user.id });
    assert.equal(retained.length, 2);
    assert.equal(sessions.getSessionSummary('source'), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ?').get(user.id).n, 0);
    assert.equal(sessions.loadSession(branch.sessionId).messages[0].attachments.length, 1);
    sessions.deleteMessage('source', assistant.id);
    assert.equal(sessions.loadSession('source').messages.length, 1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    db.prepare("CREATE TRIGGER fail_branch BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'copy failed'); END").run();
    assert.throws(() => sessions.branchChat(branch.sessionId, loaded.messages[1].id), /copy failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, count);
    console.log('Message deletion, branch boundaries, metadata, attachments, IPC authorization, and transaction rollback passed.');
  } finally {
    dispose?.(); closeDatabase(); Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
