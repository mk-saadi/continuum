const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { backend } = require('./fixtures/contextBackend.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-recovery-'));
const load = Module._load, home = os.homedir;
os.homedir = () => directory;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), configPath: path.join(directory, 'mcp.json') });
let transport;
// Current native tool/instruction overhead alone outgrew the historical 8K
// fixture. Use a fitting window for recovery tests; keep 8K for refusal.
let contextLimit = 32768;
const rejectedContext = () => new Response(JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: contextLimit + 1, n_ctx: contextLimit } }), { status: 400 });
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn), removeHandler: channel => registered.delete(channel) },
    Notification: { isSupported: () => false }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } };
  if (name === './mcpManager') return mcp;
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => transport.fetch(...args) };
  return load.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const profiles = require('../src/main/profileSettings');
const compaction = require('../src/main/mainChatCompaction');
const { prepareChatMessages } = require('../src/main/promptBuilder');
let summaries = 0;
const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
  isTrustedSender: () => true,
  getEngineConfig: () => ({ modelPath: 'model', port: 9999, activeModelConfig: { contextLength: contextLimit } }),
  generateCompactionSummary: async request => { summaries++; assert.ok(JSON.parse(request.messages[1].content).conversation.length); return { choices: [{ finish_reason: 'stop', message: { content: 'Earlier conversation retained in this summary.' } }] }; },
});
const sender = Object.assign(new EventEmitter(), { send: () => {}, isDestroyed: () => false });
const event = { sender };
function seed(id, chars = 100, count = 20) {
  sessions.getOrCreateSession(id, 'model');
  for (let i = 0; i < count; i++) sessions.saveMessage(id, i % 2 ? 'user' : 'assistant', String(i).padEnd(chars, 'x'));
  profiles.saveSessionMemorySettings(id, 'model', { compactionEnabled: true });
}
function run(id) {
  return registered.get('engine:chat')(event, { requestId: id, messageId: id, sessionId: id, modelId: 'model', activeChatProvider: { type: 'local' },
    messages: prepareChatMessages({ sessionId: id, modelId: 'model', userText: 'retry', regenerate: true }) });
}
test.beforeEach(() => { contextLimit = 32768; profiles.saveProfileSettings(null, { systemPrompt: '' }); });
test.after(() => { dispose(); closeDatabase(); Module._load = load; os.homedir = home; fs.rmSync(directory, { recursive: true, force: true }); });

test('real main IPC forces one compaction after overflow, keeps originals, rebuilds and succeeds', async () => {
  seed('success'); assert.equal(sessions.getContextUsage('success', 'model').totalTokens, 500);
  summaries = 0;
  transport = backend({ context: contextLimit, tokens: text => Math.ceil(text.length / 4), infer: (_payload, count) => count === 1 ? rejectedContext() : Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const result = await run('success');
  assert.equal(result.text, 'Done [TASK COMPLETE]'); assert.equal(transport.calls.length, 2); assert.equal(summaries, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE session_id='success' AND archived=1").get().n, 0);
  assert.equal(sessions.loadSession('success').messages.length, 21);
  assert.ok(transport.calls[1].messages[0].content.includes('[COMPACTION SUMMARY]'));
  assert.ok(!transport.calls[1].messages.some(m => m.content === '0'.padEnd(100, 'x')));
});
test('mandatory overflow fails without dispatch or accumulation of blank interrupted replies', async () => {
  contextLimit = 8192; seed('mandatory'); profiles.saveProfileSettings(null, { systemPrompt: 'x'.repeat(32000) });
  transport = backend({ context: contextLimit, tokens: text => Math.ceil(text.length / 4) });
  await assert.rejects(run('mandatory'), /cannot fit/);
  sessions.saveMessage('mandatory', 'user', 'smaller question');
  await assert.rejects(run('mandatory'), /cannot fit/);
  assert.equal(transport.calls.length, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE session_id='mandatory' AND role='assistant' AND content='' ").get().n, 0);
  assert.equal(sessions.loadSession('mandatory').messages.length, 21);
  profiles.saveProfileSettings(null, { systemPrompt: '' });
});
test('second confirmed overflow stops after the single recovery retry', async () => {
  seed('second-overflow'); summaries = 0;
  transport = backend({ context: contextLimit, tokens: text => Math.ceil(text.length / 4), infer: () => rejectedContext() });
  await assert.rejects(run('second-overflow'), /single recovery retry/);
  assert.equal(transport.calls.length, 2); assert.equal(summaries, 1);
});

test('regeneration recovery excludes the replaced assistant and preserves its original variant', async () => {
  seed('regenerate', 100, 19);
  const target = sessions.getActiveMessages('regenerate').at(-1);
  transport = backend({ context: contextLimit, tokens: text => Math.ceil(text.length / 4), infer: (_payload, count) => count === 1 ? rejectedContext() : Response.json({ choices: [{ message: { content: 'Regenerated [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const result = await registered.get('session:regenerate-last')(event, { requestId: 'regenerate', sessionId: 'regenerate', modelId: 'model', activeChatProvider: { type: 'local' } });
  assert.equal(result.message.id, target.id);
  assert.ok(!transport.calls[1].messages.some(message => message.content === target.content));
  const saved = sessions.loadSession('regenerate').messages;
  assert.equal(saved.length, 19);
  assert.ok(saved.at(-1).variants.some(variant => variant.content === target.content));
});

test('older attachments enter the summary request and keep their original managed file', async () => {
  const file = path.join(directory, 'SKILL (1).md');
  fs.writeFileSync(file, 'ATTACHED_REVIEW_RULES\n' + 'x'.repeat(12000));
  const files = await require('../src/main/fileUploads').processUploads([file]);
  sessions.getOrCreateSession('attachment-source', 'model');
  const original = sessions.saveMessage('attachment-source', 'user', 'review', files);
  for (let i = 0; i < 11; i++) sessions.saveMessage('attachment-source', i % 2 ? 'user' : 'assistant', 'short turn');
  const payload = { model: 'model', messages: require('../src/main/promptBuilder').rebuildChatMessages({ sessionId: 'attachment-source', modelId: 'model' }), tools: [], max_tokens: 256 };
  const result = await compaction.compactAtBoundary({ sessionId: 'attachment-source', modelId: 'model', payload, owner: {}, force: true,
    measure: async p => ({ tokens: require('../src/main/contextBudget').approximateTokens(p), limit: 32768, reserve: p.max_tokens, method: 'fixture-estimate' }),
    generate: async request => { assert.match(request.messages[1].content, /ATTACHED_REVIEW_RULES/); return { choices: [{ finish_reason: 'stop', message: { content: 'Earlier attached review rules retained.' } }] }; } });
  assert.equal(result.compressed, true);
  assert.equal(sessions.loadSession('attachment-source').messages.find(m => m.id === original.id).content, 'review');
  assert.ok(fs.existsSync(files[0].file_path));
  assert.equal(fs.readFileSync(files[0].file_path, 'utf8'), fs.readFileSync(file, 'utf8'));
});
