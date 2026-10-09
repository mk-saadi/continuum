const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { backend, overflow } = require('./fixtures/contextBackend.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-recovery-'));
const load = Module._load, home = os.homedir;
os.homedir = () => directory;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), configPath: path.join(directory, 'mcp.json') });
let transport;
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
const compression = require('../src/main/compressionEngine');
const { prepareChatMessages } = require('../src/main/promptBuilder');
let summaries = 0;
const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
  isTrustedSender: () => true,
  getEngineConfig: () => ({ modelPath: 'model', port: 9999, activeModelConfig: { contextLength: 8192 } }),
  llmSummarizeCallback: async (_old, batch) => { summaries++; assert.ok(batch.length); return 'Earlier conversation retained in this summary.'; },
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
test.after(() => { dispose(); closeDatabase(); Module._load = load; os.homedir = home; fs.rmSync(directory, { recursive: true, force: true }); });

test('real main IPC forces compaction below normal threshold, applies archives, rebuilds and succeeds', async () => {
  seed('success'); assert.equal(sessions.getContextUsage('success', 'model').totalTokens, 500);
  summaries = 0;
  transport = backend({ tokens: text => Math.ceil(text.length / 4), infer: (_payload, count) => count === 1 ? overflow() : Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const result = await run('success');
  assert.equal(result.text, 'Done [TASK COMPLETE]'); assert.equal(transport.calls.length, 2); assert.equal(summaries, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE session_id='success' AND archived=1").get().n, 10);
  assert.equal(sessions.loadSession('success').messages.length, 21);
  assert.ok(transport.calls[1].messages[0].content.includes('[EARLIER CONVERSATION SUMMARY]'));
  assert.ok(!transport.calls[1].messages.some(m => m.content === '0'.padEnd(100, 'x')));
});
test('mandatory overflow fails without dispatch or accumulation of blank interrupted replies', async () => {
  seed('mandatory'); profiles.saveProfileSettings(null, { systemPrompt: 'x'.repeat(32000) });
  transport = backend({ tokens: text => Math.ceil(text.length / 4) });
  await assert.rejects(run('mandatory'), /cannot fit/);
  sessions.saveMessage('mandatory', 'user', 'smaller question');
  await assert.rejects(run('mandatory'), /cannot fit/);
  assert.equal(transport.calls.length, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE session_id='mandatory' AND role='assistant' AND content='' ").get().n, 0);
  assert.equal(sessions.loadSession('mandatory').messages.length, 21);
  profiles.saveProfileSettings(null, { systemPrompt: '' });
});
test('scheduled compression is explicitly run; pending background compaction is awaited before forced work', async () => {
  seed('scheduled');
  compression.scheduleIdleCompression('scheduled', 'model', 8192, async () => assert.fail('Idle timer should be cancelled by recovery'));
  const forced = await compression.recoverContextOverflow({ sessionId: 'scheduled', modelId: 'model', contextWindowLimit: 8192, llmSummarizeCallback: async () => 'summary' });
  assert.equal(forced.compressed, true);
  seed('pending', 1600);
  let enter, release;
  const began = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const background = compression.checkAndCompressContext({ sessionId: 'pending', modelId: 'model', contextWindowLimit: 8192, llmSummarizeCallback: async () => { enter(); return gate; } });
  await began;
  let forcedCalls = 0;
  const pending = compression.recoverContextOverflow({ sessionId: 'pending', modelId: 'model', contextWindowLimit: 8192, llmSummarizeCallback: async () => { forcedCalls++; return 'forced summary'; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(forcedCalls, 0);
  release('background summary'); await background; const result = await pending;
  assert.equal(result.compressed, true); assert.equal(forcedCalls, 1); assert.equal(sessions.getSessionSummary('pending'), 'forced summary');
});
test('cancelling while waiting for background compression never invokes forced summarization', async () => {
  seed('cancel', 1600); let enter, release;
  const began = new Promise(resolve => enter = resolve), gate = new Promise(resolve => release = resolve);
  const background = compression.checkAndCompressContext({ sessionId: 'cancel', modelId: 'model', contextWindowLimit: 8192, llmSummarizeCallback: async () => { enter(); return gate; } });
  await began; const controller = new AbortController();
  const waiting = compression.recoverContextOverflow({ sessionId: 'cancel', modelId: 'model', contextWindowLimit: 8192, signal: controller.signal, llmSummarizeCallback: () => assert.fail('Must not start recovery') });
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' }); release('summary'); await background;
});
test('short protected-only sessions preserve every original even with forced recovery', async () => {
  seed('protected', 16000, 2);
  const before = sessions.loadSession('protected').messages;
  const result = await compression.recoverContextOverflow({ sessionId: 'protected', modelId: 'model', contextWindowLimit: 8192, llmSummarizeCallback: () => assert.fail('No eligible history') });
  assert.equal(result.compressed, false); assert.deepEqual(sessions.loadSession('protected').messages, before);
});

test('regeneration recovery excludes the replaced assistant and preserves its original variant', async () => {
  seed('regenerate', 100, 19);
  const target = sessions.getActiveMessages('regenerate').at(-1);
  transport = backend({ infer: (_payload, count) => count === 1 ? overflow() : Response.json({ choices: [{ message: { content: 'Regenerated [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const result = await registered.get('session:regenerate-last')(event, { requestId: 'regenerate', sessionId: 'regenerate', modelId: 'model', activeChatProvider: { type: 'local' } });
  assert.equal(result.message.id, target.id);
  assert.ok(!transport.calls[1].messages.some(message => message.content === target.content));
  const saved = sessions.loadSession('regenerate').messages;
  assert.equal(saved.length, 19);
  assert.ok(saved.at(-1).variants.some(variant => variant.content === target.content));
});

test('forced compaction includes expanded older attachment text and preserves its managed file', async () => {
  const file = path.join(directory, 'SKILL (1).md');
  fs.writeFileSync(file, 'ATTACHED_REVIEW_RULES\n' + 'x'.repeat(12000));
  const files = await require('../src/main/fileUploads').processUploads([file]);
  sessions.getOrCreateSession('attachment-source', 'model');
  const original = sessions.saveMessage('attachment-source', 'user', 'review', files);
  for (let i = 0; i < 11; i++) sessions.saveMessage('attachment-source', i % 2 ? 'user' : 'assistant', 'short turn');
  assert.ok(sessions.getContextUsage('attachment-source', 'model').totalTokens < 6144);
  const result = await compression.recoverContextOverflow({ sessionId: 'attachment-source', modelId: 'model', contextWindowLimit: 8192,
    llmSummarizeCallback: async (_prior, batch) => { assert.match(batch[0].content, /ATTACHED_REVIEW_RULES/); return 'Earlier attached review rules retained in summary.'; } });
  assert.equal(result.compressed, true);
  assert.equal(sessions.loadSession('attachment-source').messages.find(m => m.id === original.id).content, 'review');
  assert.ok(fs.existsSync(files[0].file_path));
  assert.equal(fs.readFileSync(files[0].file_path, 'utf8'), fs.readFileSync(file, 'utf8'));
});
