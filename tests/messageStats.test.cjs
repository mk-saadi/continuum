// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/messageStats.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-stats-'));
const handlers = new Map();
const bridges = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    contextBridge: { exposeInMainWorld: (name, bridge) => bridges.set(name, bridge) },
    ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)({ trusted: true }, payload) },
  };
  return originalLoad.call(this, name, ...args);
};
// Simulate a database created before the stats migration.
const legacy = new Database(path.join(directory, 'memory_palace.db'));
legacy.pragma('foreign_keys = OFF');
legacy.exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content TEXT NOT NULL, estimated_tokens INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); INSERT INTO messages(session_id, role, content) VALUES ('legacy', 'assistant', 'Old reply');`);
legacy.close();
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
require('../src/preload');
(async () => {
  let dispose;
  try {
    initDatabase();
    sessions.getOrCreateSession('legacy', 'model');
    assert.equal(sessions.loadSession('legacy').messages[0].stats, null);
    assert.equal(sessions.loadSession('legacy').messages[0].modelName, null);
    assert.equal(sessions.loadSession('legacy').messages[0].toolCalls, null);
    assert.equal(sessions.loadSession('legacy').messages[0].thinkingText, null);
    assert.equal(sessions.loadSession('legacy').messages[0].thinkingDuration, null);
    dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted === true });
    const api = bridges.get('memoryPalace');
    const first = { startTime: 100, endTime: 2100, time: 2, promptTokens: 10, completionTokens: 20, totalTokens: 30, tokensPerSecond: 10 };
    const second = { ...first, completionTokens: 40, totalTokens: 50, tokensPerSecond: 20 };
    const toolCalls = [
      { id: 'tool1', serverName: 'terminal', toolName: 'run_command', status: 'complete', result: { content: [{ type: 'text', text: 'tool result' }] } },
      { id: 'tool2', serverName: 'filesystem', toolName: 'read_file', status: 'error', error: 'File not found' },
    ];
    const thinking = { text: 'Model reasoning text', duration: 0 };
    const identity = { displayName: 'qwey', modelName: 'Gemma4-26B-A4B-Uncensored', modelId: '/models/gemma.gguf', agentName: 'Senior Code Reviewer' };
    const saved = await api.saveMessage('legacy', 'assistant', 'First', [], first, toolCalls, thinking, null, identity);
    assert.equal(saved.displayName, 'qwey');
    assert.equal(saved.variants[0].displayName, 'qwey');
    assert.equal(db.prepare('SELECT display_name FROM messages WHERE id = ?').get(saved.id).display_name, 'qwey');
    assert.equal(saved.modelName, identity.modelName);
    assert.equal(saved.modelId, identity.modelId);
    assert.equal(saved.agentName, identity.agentName);
    assert.equal(db.prepare('SELECT model_name FROM messages WHERE id = ?').get(saved.id).model_name, identity.modelName);
    await api.saveMessage('legacy', 'assistant', 'First', [], null, null, null, saved.id);
    await api.saveMessage('legacy', 'assistant', 'First', [], null, null, null, saved.id,
      { modelName: 'Switched Model', modelId: '/models/new.gguf', agentName: 'Switched Agent' });
    assert.equal(sessions.loadSession('legacy').messages.at(-1).agent_name, identity.agentName);
    assert.equal(sessions.loadSession('legacy').messages.at(-1).modelName, identity.modelName);
    const branch = sessions.branchChat('legacy', saved.id);
    assert.equal(sessions.loadSession(branch.sessionId).messages.at(-1).agentName, identity.agentName);
    assert.equal(sessions.loadSession(branch.sessionId).messages.at(-1).modelName, identity.modelName);
    assert.deepEqual(saved.toolCalls, toolCalls);
    assert.equal(saved.thinkingText, thinking.text);
    assert.equal(saved.thinkingDuration, 0);
    assert.equal(saved.role, 'assistant');
    assert.equal(saved.content, 'First');
    assert.equal(saved.session_id, 'legacy');
    assert.deepEqual(saved.stats, first);
    assert.deepEqual(saved.attachments, []);
    assert.equal(typeof saved.created_at, 'string');
    const { estimatedTokens, ...savedRow } = saved;
    assert.deepEqual(savedRow, (await api.loadSession('legacy')).messages.at(-1));
    assert.equal(estimatedTokens, saved.estimated_tokens);
    await api.saveMessage('legacy', 'user', 'Follow up');
    await api.saveMessage('legacy', 'assistant', 'Second', [], second);
    sessions.getOrCreateSession('no-persona', 'model');
    const noPersona = await api.saveMessage('no-persona', 'assistant', 'Plain reply', [], null, null, null, null,
      { modelName: 'Original Model', modelId: 'original', agentName: null });
    const updatedOrigin = await api.saveMessage('no-persona', 'assistant', 'Plain reply', [], null, null, null, noPersona.id,
      { modelName: 'New Model', modelId: 'new', agentName: 'New Agent' });
    assert.equal(updatedOrigin.model_name, 'Original Model');
    assert.equal(updatedOrigin.model_id, 'original');
    assert.equal(updatedOrigin.agent_name, null);
    assert.equal(typeof db.prepare('SELECT stats FROM messages WHERE id = ?').get(saved.id).stats, 'string');
    const stored = db.prepare('SELECT tool_calls, thinking_text, thinking_duration FROM messages WHERE id = ?').get(saved.id);
    assert.deepEqual(JSON.parse(stored.tool_calls), toolCalls);
    assert.equal(stored.thinking_text, thinking.text);
    assert.equal(stored.thinking_duration, 0);
    closeDatabase(); initDatabase(); // Verify persistence and idempotent migration.
    const messages = (await api.loadSession('legacy')).messages;
    assert.equal(messages[1].displayName, 'qwey');
    assert.equal(messages[1].variants[0].displayName, 'qwey');
    assert.equal(messages[1].modelName, identity.modelName);
    assert.equal(messages[1].modelId, identity.modelId);
    assert.equal(messages[1].agentName, identity.agentName);
    assert.deepEqual(messages.map(m => m.stats), [null, first, null, second]);
    assert.deepEqual(messages[1].toolCalls, toolCalls);
    assert.equal(messages[1].thinkingText, thinking.text);
    assert.equal(messages[1].thinkingDuration, 0);
    const active = await api.getActiveMessages('legacy');
    assert.deepEqual(active[1].toolCalls, toolCalls);
    assert.equal(active[1].thinkingText, thinking.text);
    const { messageForModel } = require('../src/main/promptBuilder');
    assert.deepEqual(messageForModel(active[1]), { role: 'assistant', content: 'First' });
    sessions.getOrCreateSession('metadata-only', 'model');
    const only = await api.saveMessage('metadata-only', 'assistant', '', [], null, toolCalls, { text: 'Interrupted thinking', duration: 1.5 });
    assert.equal(only.content, '');
    assert.equal((await api.loadSession('metadata-only')).messages[0].thinkingDuration, 1.5);
    await assert.rejects(api.saveMessage('metadata-only', 'assistant', '', [], null, {}), /Tool calls must be an array/);
    await assert.rejects(api.saveMessage('metadata-only', 'assistant', '', [], null, [], { text: 'text', duration: -1 }), /Invalid thinking duration/);
    await assert.rejects(api.saveMessage('metadata-only', 'user', '', [], null, toolCalls), /Only assistant messages/);
    db.prepare('UPDATE messages SET tool_calls = ?, thinking_duration = ? WHERE id = ?').run('{broken', -2, only.id);
    const corrupt = (await api.loadSession('metadata-only')).messages[0];
    assert.equal(corrupt.toolCalls, null);
    assert.equal(corrupt.thinkingDuration, null);
    assert.equal(corrupt.thinkingText, 'Interrupted thinking');
    assert.deepEqual((await api.getActiveMessages('legacy')).map(m => m.stats), [null, first, null, second]);
    sessions.getOrCreateSession('empty-stats', 'model');
    const noStats = await api.saveMessage('empty-stats', 'assistant', 'No metrics', [], {});
    assert.equal(noStats.stats, null);
    assert.equal(db.prepare('SELECT stats FROM messages WHERE id = ?').get(noStats.id).stats, null);
    const unavailable = { ...first, promptTokens: null, completionTokens: null, totalTokens: null, tokensPerSecond: null };
    const empty = await api.saveMessage('legacy', 'assistant', '', [], unavailable);
    assert.deepEqual(sessions.loadSession('legacy').messages.at(-1).stats, unavailable);
    await assert.rejects(api.saveMessage('legacy', 'assistant', 'Invalid', [], { time: Infinity }), /Invalid generation stat/);
    db.prepare('UPDATE messages SET stats = ? WHERE id = ?').run('{broken', empty.id);
    assert.equal(sessions.loadSession('legacy').messages.at(-1).stats, null);
    const retained = sessions.editMessage(messages[2].id, 'Edited follow up');
    assert.deepEqual(retained.at(-2).stats, first);
    assert.deepEqual(retained.at(-2).toolCalls, toolCalls);
    assert.equal(retained.at(-2).thinkingText, thinking.text);
    assert.equal(retained.length, 3);
    sessions.getOrCreateSession('updates', 'model');
    const draft = await api.saveMessage('updates', 'assistant', 'Draft', [], first, toolCalls, thinking);
    const updated = await api.saveMessage('updates', 'assistant', 'Final', [], { completionTokens: 40, totalTokens: 50, time: 4, tokensPerSecond: 10, generationTime: 4, scope: 'final' }, null, null, draft.id);
    assert.equal(updated.id, draft.id);
    assert.equal(updated.stats.promptTokens, first.promptTokens);
    assert.equal(updated.stats.totalTokens, 50);
    assert.equal(updated.stats.scope, 'final');
    assert.deepEqual(updated.toolCalls, toolCalls);
    assert.equal(updated.thinkingText, thinking.text);
    const late = await api.saveMessage('updates', 'assistant', 'Final', [], { totalTokens: null, time: 0 }, null, null, draft.id);
    assert.equal(late.stats.totalTokens, 50);
    assert.equal(late.stats.time, 0);
    const omitted = await api.saveMessage('updates', 'assistant', 'Final', [], null, null, null, draft.id);
    assert.deepEqual(omitted.stats, late.stats);
    assert.equal((await api.loadSession('updates')).messages.length, 1);
    await assert.rejects(api.saveMessage('legacy', 'assistant', 'Wrong session', [], first, null, null, draft.id), /not found/);
    closeDatabase(); initDatabase();
    assert.deepEqual((await api.loadSession('updates')).messages[0].stats, late.stats);
    console.log('Metadata migration, preload/IPC round trip, multiple turns, restart, zero duration, metadata-only replies, corrupt JSON, prompt isolation, and edit retention passed.');
  } finally {
    dispose?.(); closeDatabase(); Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
