const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-branches-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db, branchUserMessage } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { buildBranchContext, createMessagePersistence } = require('../src/main/engineManager');

(async () => {
try {
  initDatabase();
  sessions.getOrCreateSession('chat', 'model');
  const first = sessions.saveMessage('chat', 'user', 'Original prompt');
  const originalReply = sessions.saveMessage('chat', 'assistant', 'Original answer');
  const followup = sessions.saveMessage('chat', 'user', 'Original follow-up');
  const nestedEdit = branchUserMessage({ messageId: followup.id, newContent: 'Revised follow-up' });
  assert.deepEqual(buildBranchContext(nestedEdit.userMessageId).messages.map(row => row.content),
    ['Original prompt', 'Original answer', 'Revised follow-up']);

  const { userMessageId } = branchUserMessage({ messageId: first.id, newContent: 'Revised prompt' });
  assert.equal(db.prepare('SELECT parent_id FROM messages WHERE id = ?').get(userMessageId).parent_id, first.parent_id);
  assert.deepEqual(buildBranchContext(userMessageId).messages.map(row => row.content), ['Revised prompt']);
  assert.deepEqual(sessions.loadSession('chat').messages.map(row => row.content), ['Revised prompt']);

  const response = createMessagePersistence({ sessionId: 'chat', modelId: 'model' });
  response.update({ content: 'Revised answer', executionSteps: [], stats: null, status: 'completed' });
  assert.equal(db.prepare('SELECT parent_id FROM messages WHERE id = ?').get(response.messageId).parent_id, userMessageId);
  assert.deepEqual(sessions.loadSession('chat').messages.map(row => row.content), ['Revised prompt', 'Revised answer']);

  const siblings = sessions.loadSession('chat').messages[0].siblings;
  assert.deepEqual(siblings, [first.id, userMessageId]);
  sessions.selectMessageBranch('chat', first.id);
  assert.deepEqual(sessions.loadSession('chat').messages.map(row => row.content),
    ['Original prompt', 'Original answer', 'Original follow-up']);
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(originalReply.id).content, 'Original answer');
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(followup.id).content, 'Original follow-up');
  sessions.selectMessageBranch('chat', userMessageId);
  assert.deepEqual(sessions.getActiveMessages('chat').map(row => row.content), ['Revised prompt', 'Revised answer']);
  const mcp = require('../src/main/mcpManager');
  const originalInit = mcp.init;
  const originalReload = mcp.reload;
  const originalFetch = global.fetch;
  mcp.init = async () => {};
  mcp.reload = async () => {};
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
    getEngineConfig: () => ({ port: 12345 }) });
  try {
    global.fetch = async (_url, options) => {
      const userTurns = JSON.parse(options.body).messages.filter(row => row.role === 'user').map(row => row.content);
      assert.deepEqual(userTurns, ['Another revision']);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Another answer' } }] });
    };
    const result = await handlers.get('engine:branch-and-execute')({ sender }, {
      sessionId: 'chat', messageId: first.id, newContent: 'Another revision', modelId: 'model',
      requestId: 'branch-request', activeChatProvider: { type: 'local' },
    });
    assert.equal(db.prepare('SELECT parent_id FROM messages WHERE id = ?').get(result.message.id).parent_id, result.userMessageId);
    assert.deepEqual(sessions.loadSession('chat').messages.map(row => row.content), ['Another revision', 'Another answer']);
  } finally {
    dispose(); mcp.init = originalInit; mcp.reload = originalReload; global.fetch = originalFetch;
  }
  console.log('Message branches: edits, ancestry, replies, and navigation passed.');
} finally {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}
})().catch(error => { console.error(error); process.exitCode = 1; });
