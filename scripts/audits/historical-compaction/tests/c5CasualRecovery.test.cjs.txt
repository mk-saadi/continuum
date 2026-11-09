'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { backend } = require('./fixtures/contextBackend.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-casual-'));
const load = Module._load, home = os.homedir; os.homedir = () => directory;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), forgetSession: () => {} });
let transport, generation = 'c5-runtime', summaryOverride = null;
const records = [], measuredRequests = [], evidence = [];
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn), removeHandler: channel => registered.delete(channel) },
    Notification: { isSupported: () => false }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } };
  if (name === './mcpManager') return mcp;
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => transport.fetch(...args) };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), profiles = require('../src/main/profileSettings');
const compression = require('../src/main/compressionEngine');
const { summarizeCasual, PROMPT, KEYS } = require('../src/main/casualSummary');
const { createPromptMeasurer } = require('../src/main/contextBudget');
const { prepareChatMessages } = require('../src/main/promptBuilder');
const url = 'http://127.0.0.1:9999/v1/chat/completions';
const summaryValue = () => ({ instructions: ['Keep the acceptance constraints.'], facts: ['Test status is unknown.'], preferences: ['Use blue.'], decisions: ['Keep the API stable.'], openQuestions: ['Confirm the deadline.'], references: ['docs/a.md'] });
const envelope = (finish = 'stop') => ({ choices: [{ message: { content: JSON.stringify(summaryValue()) }, finish_reason: finish }], usage: { completion_tokens: 80 } });
const sse = (finish = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(summaryValue()) }, finish_reason: finish }] })}\n\ndata: ${JSON.stringify({ usage: { completion_tokens: 80 }, choices: [] })}\n\ndata: [DONE]\n\n`);
const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
  getEngineConfig: () => ({ modelPath: 'model', port: 9999, runtimeIdentity: generation, activeModelConfig: { contextLength: 70000 } }),
  llmSummarizeCallback: async (oldSummary, messageBatch, modelId, options = {}) => {
    if (summaryOverride) return summaryOverride(oldSummary, messageBatch, options);
    const identity = generation;
    return summarizeCasual({ oldSummary, messageBatch, modelId, url, fetchImpl: transport.fetch, signal: options.signal,
      isCurrent: () => identity === generation, onDiagnostics: r => records.push(r) });
  } });
const sender = Object.assign(new EventEmitter(), { send: () => {}, isDestroyed: () => false });
let serial = 0;
function seed({ oldCount = 20, oldChars = 20000, tailChars = 100, total = oldCount + 10 } = {}) {
  const id = `c5-${++serial}`; sessions.getOrCreateSession(id, 'model');
  profiles.saveSessionMemorySettings(id, 'model', { compactionEnabled: true });
  for (let i = 0; i < total; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `source-${i}: Keep the acceptance constraints. Test status is unknown. Preference: use blue. Decision: keep the API stable. Open question: confirm the deadline. Reference: docs/a.md. ` + 'x'.repeat(i < oldCount ? oldChars : tailChars));
  return id;
}
const snapshot = id => JSON.stringify({ messages: storage.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id), summary: sessions.getSessionSummary(id) });
function setup({ summaryFinish = 'stop' } = {}) {
  const b = backend({ context: 35072, tokens: text => Math.ceil(text.length / 4), infer: request => request.messages[0].content === PROMPT ? sse(summaryFinish)
    : Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  transport = { ...b, fetch: async (endpoint, options = {}) => {
    if (new URL(endpoint).pathname === '/apply-template') measuredRequests.push(JSON.parse(options.body));
    return b.fetch(endpoint, options);
  } };
  return b;
}
function run(id) { return registered.get('engine:chat')({ sender }, { requestId: `request-${id}-${serial}`, sessionId: id, modelId: 'model', activeChatProvider: { type: 'local' },
  messages: prepareChatMessages({ sessionId: id, modelId: 'model', userText: 'short new question' }) }); }
function isSummary(r) { return r.messages[0].content === PROMPT; }
test.beforeEach(() => { generation = 'c5-runtime'; summaryOverride = null; records.length = 0; measuredRequests.length = 0; setup(); });
test.after(() => { if (process.env.C5_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.C5_EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2)); dispose(); storage.closeDatabase(); Module._load = load; os.homedir = home; fs.rmSync(directory, { recursive: true, force: true }); });

test('C5 below budget dispatches once without summarization', async () => {
  const id = seed({ oldCount: 0, total: 4 }); const result = await run(id);
  assert.equal(result.text, 'Done [TASK COMPLETE]'); assert.equal(transport.calls.length, 1); assert.equal(records.length, 0);
});

test('C5 first send from restored >runtime backlog stages summaries, activates atomically and sends the new question once', async () => {
  const id = seed(), raw = JSON.parse(snapshot(id)).messages;
  const result = await run(id);
  assert.equal(result.text, 'Done [TASK COMPLETE]');
  const summaries = transport.calls.filter(isSummary), chats = transport.calls.filter(r => !isSummary(r));
  assert.ok(summaries.length >= 3); assert.equal(chats.length, 1);
  assert.ok(summaries.every(r => r.chat_template_kwargs.enable_thinking === false && r.max_tokens === 1024 && r.stream === true));
  assert.ok(records.every(r => r.inputTokens <= r.usableInputTokens && r.capacityTokens === 35072));
  const chat = chats[0]; assert.ok(Math.ceil(JSON.stringify(chat).length / 4) <= 33920);
  // Exact pre-commit serialized chat shape was measured, not only a DB estimate.
  assert.ok(measuredRequests.some(r => JSON.stringify(r.messages) === JSON.stringify(chat.messages) && JSON.stringify(r.tools) === JSON.stringify(chat.tools)));
  const rows = storage.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id);
  assert.deepEqual(rows.slice(0, raw.length).map(r => r.content), raw.map(r => r.content));
  assert.equal(rows.filter(r => r.role === 'user' && r.content === 'short new question').length, 1);
  assert.equal(rows.filter(r => r.archived).length, 21);
  assert.ok(rows.slice(-10).every(r => !r.archived));
  assert.deepEqual(JSON.parse(sessions.getSessionSummary(id)), summaryValue());
  assert.equal(chat.messages.filter(m => m.content === 'short new question').length, 1);
  const legacy = await createPromptMeasurer(transport.fetch)(url, { model: 'model', max_tokens: 512, stream: false,
    messages: [{ role: 'system', content: require('../src/main/compactionCore').WORKSPACE_SUMMARY_PROMPT },
      { role: 'user', content: require('../src/main/compactionCore').summaryUserContent(null, raw.slice(0, 21)) }] });
  assert.ok(legacy.tokens > legacy.budget); assert.equal(legacy.budget, 34432);
  evidence.push({ scenario: 'first-send-restored-over-budget', configuredTotal: 70000, runtimeCapacity: 35072,
    legacySingleSummaryInputTokens: legacy.tokens, legacySingleSummaryUsableBudget: legacy.budget,
    summaryStages: summaries.length, summaryAttempts: records.map(r => ({ ...r })),
    chatDispatches: chats.length, finalSerializedChatInputTokens: Math.ceil(JSON.stringify(chat).length / 4),
    usableChatInputBudget: 33920, archivedRows: 21, rawSourceRowsPreserved: raw.length, duplicateQuestionRows: 0 });
});

for (const mode of ['truncated', 'cancelled', 'source-change', 'runtime-change', 'unavailable']) test(`C5 ${mode} recovery never archives or activates incomplete memory`, async () => {
  const id = seed();
  // Save the new user message before capturing: the failed request itself is durable.
  const messages = prepareChatMessages({ sessionId: id, modelId: 'model', userText: 'new question' });
  const before = snapshot(id); let calls = 0;
  summaryOverride = async (_old, batch, options) => {
    calls++;
    if (mode === 'source-change') { sessions.saveMessage(id, 'user', 'Concurrent update'); return JSON.stringify(summaryValue()); }
    if (mode === 'runtime-change') { generation = 'replacement'; throw Object.assign(new Error('Runtime changed.'), { code: 'casual-runtime-changed' }); }
    if (mode === 'unavailable') throw Object.assign(new Error('Model unavailable.'), { code: 'casual-model-unavailable' });
    if (mode === 'cancelled') {
      const controller = new AbortController(); controller.abort();
      return summarizeCasual({ oldSummary: '', messageBatch: batch, modelId: 'model', url, fetchImpl: transport.fetch, signal: controller.signal });
    }
    return summarizeCasual({ oldSummary: '', messageBatch: batch, modelId: 'model', url, fetchImpl: transport.fetch,
      signal: options.signal, generate: async () => envelope('length'), onDiagnostics: () => {} });
  };
  await assert.rejects(registered.get('engine:chat')({ sender }, { requestId: id, sessionId: id, modelId: 'model', activeChatProvider: { type: 'local' }, messages }));
  assert.equal(calls, 1); assert.equal(transport.calls.filter(r => !isSummary(r)).length, 0);
  assert.equal(sessions.getSessionSummary(id), null);
  assert.equal(storage.db.prepare('SELECT count(*) n FROM messages WHERE session_id=? AND archived=1').get(id).n, 0);
  if (mode !== 'source-change') assert.equal(snapshot(id), before);
  evidence.push({ scenario: mode, summaryInvocations: calls, chatDispatches: 0, archivesWritten: 0, summaryActivated: false });
});

test('C5 protected recent content refuses recovery before summary generation', async () => {
  const id = seed({ oldCount: 2, tailChars: 30000 }); let calls = 0;
  summaryOverride = async () => { calls++; return JSON.stringify(summaryValue()); };
  await assert.rejects(run(id), /protected recent messages/);
  assert.equal(calls, 0); assert.equal(sessions.getSessionSummary(id), null); assert.equal(transport.calls.length, 0);
});

test('C5 oversized single text and old summary partition losslessly with bounded stages', async () => {
  const source = 'long source '.repeat(18000), seen = [];
  const result = await summarizeCasual({ oldSummary: source, messageBatch: [], modelId: 'model', url, fetchImpl: transport.fetch,
    generate: async request => { seen.push(...JSON.parse(request.messages[1].content).sources.map(s => s.content)); return envelope(); }, onDiagnostics: () => {} });
  assert.ok(seen.length > 1); assert.equal(seen.join(''), source); assert.match(result, /acceptance constraints/);
});

test('C5 source changed during final measurement rolls back every derived change', async () => {
  const id = seed(), before = snapshot(id);
  await assert.rejects(compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
    llmSummarizeCallback: async () => JSON.stringify(summaryValue()),
    measurePrompt: async () => { storage.db.prepare('UPDATE messages SET content=? WHERE id=(SELECT min(id) FROM messages WHERE session_id=?)').run('Externally updated source', id);
      return { tokens: 12000, budget: 33920, method: 'server-template-tokenizer' }; } }), { code: 'casual-source-changed' });
  assert.equal(sessions.getSessionSummary(id), null); assert.equal(storage.db.prepare('SELECT count(*) n FROM messages WHERE session_id=? AND archived=1').get(id).n, 0);
  assert.equal(JSON.parse(snapshot(id)).messages.length, JSON.parse(before).messages.length);
});

test('C5 deleted session aborts its owned forced summarization before deletion settles', async () => {
  const id = seed(); let entered;
  const started = new Promise(resolve => entered = resolve);
  const running = compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
    llmSummarizeCallback: async (_old, _batch, _model, options) => { entered(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); } });
  await started;
  const rejected = assert.rejects(running);
  await require('../src/main/sessionDeletion').deleteConversation(id, null, () => true); await rejected;
  assert.equal(storage.db.prepare('SELECT id FROM sessions WHERE id=?').get(id), undefined);
  assert.equal(storage.db.prepare('SELECT count(*) n FROM session_summaries WHERE session_id=?').get(id).n, 0);
});

test('C5 stages are bounded; incomplete, malformed and mandatory-overflow outputs fail closed', async () => {
  for (const result of [envelope('length'), envelope('tool_calls'), { choices: [{ finish_reason: 'stop', message: { content: '{' } }] }, { choices: [{ finish_reason: 'stop', message: { content: '{"overflow":true}' } }] }]) {
    await assert.rejects(summarizeCasual({ messageBatch: [{ role: 'user', content: 'facts' }], modelId: 'model', url, fetchImpl: transport.fetch,
      generate: async () => result, onDiagnostics: () => {} }));
  }
  await assert.rejects(summarizeCasual({ messageBatch: [{ role: 'user', content: 'x'.repeat(250000) }], modelId: 'model', url, fetchImpl: transport.fetch,
    generate: async () => envelope(), maxStages: 1, onDiagnostics: () => {} }), { code: 'casual-summary-stage-budget' });
});

test('C5 successive compactions preserve the new question, old memory and raw history without duplicate dispatch', async () => {
  const id = seed(); await run(id); const first = sessions.getSessionSummary(id), count = transport.calls.filter(r => !isSummary(r)).length;
  for (let i = 0; i < 24; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', 'round-two '.repeat(i < 14 ? 2500 : 10));
  const raw = storage.db.prepare('SELECT content FROM messages WHERE session_id=? ORDER BY id').all(id);
  await run(id);
  assert.equal(transport.calls.filter(r => !isSummary(r)).length, count + 1);
  assert.ok(transport.calls.filter(isSummary).some(r => JSON.parse(r.messages[1].content).sources.some(s => s.sourceId === 'prior-summary' && s.content === first)));
  const rows = storage.db.prepare('SELECT content FROM messages WHERE session_id=? ORDER BY id').all(id);
  assert.deepEqual(rows.slice(0, raw.length), raw);
  assert.equal(transport.calls.filter(r => !isSummary(r)).at(-1).messages.filter(m => m.content === 'short new question').length, 1);
});

test('C5 idle threshold gate performs recovery at pressure and never below it', async () => {
  for (const pressure of [false, true]) {
    const id = seed({ oldChars: 1000 }); let calls = 0;
    const result = await compression.checkAndCompressContext({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
      pressureMeasurement: { budgetContract: { currentInputTokens: pressure ? 31000 : 1000, autoCompactionTriggerTokens: 30528 } },
      llmSummarizeCallback: async () => { calls++; return JSON.stringify(summaryValue()); } });
    assert.equal(calls > 0, pressure); assert.equal(result.compressed, pressure);
  }
});

test('C5 failed exact pre-commit measurement never activates summary state', async () => {
  const id = seed(), before = snapshot(id);
  await assert.rejects(compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
    strictMeasurement: true, llmSummarizeCallback: async () => JSON.stringify(summaryValue()),
    measurePrompt: async () => { throw Object.assign(new Error('Server unavailable during measurement'), { code: 'ECONNREFUSED' }); } }), /Server unavailable/);
  assert.equal(snapshot(id), before);
});

test('C5 cancellation during an active staged summary rejects even a non-cooperative late completion', async () => {
  const id = seed(), before = snapshot(id), controller = new AbortController(); let enter;
  const started = new Promise(resolve => enter = resolve);
  const running = compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072, signal: controller.signal,
    llmSummarizeCallback: async (oldSummary, messageBatch, modelId, options) => summarizeCasual({ oldSummary, messageBatch, modelId,
      url, fetchImpl: transport.fetch, signal: options.signal, onDiagnostics: () => {}, generate: async (_request, meta) => {
        enter(); await new Promise(resolve => meta.signal.addEventListener('abort', resolve, { once: true })); return envelope();
      } }) });
  await started; controller.abort(); await assert.rejects(running);
  assert.equal(snapshot(id), before); assert.equal(storage.db.prepare('SELECT is_compressing FROM sessions WHERE id=?').get(id).is_compressing, 0);
});

test('C5 prospective serialized payload above budget is refused without archival', async () => {
  const id = seed(), before = snapshot(id);
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
    strictMeasurement: true, llmSummarizeCallback: async () => JSON.stringify(summaryValue()),
    measurePrompt: async () => ({ tokens: 33921, budget: 33920, method: 'server-template-tokenizer', budgetContract: { capacityMethod: 'runtime-reported' } }) });
  assert.equal(result.reason, 'prospective-prompt-exceeds-budget'); assert.equal(result.compressed, false); assert.equal(snapshot(id), before);
});

test('C5 lossless splitting fails explicitly when exact source measurement is unavailable', async () => {
  const measure = async () => ({ tokens: 1000, budget: 33920, limit: 35072, method: 'approximate-full-request', budgetContract: { capacityMethod: 'runtime-reported' } });
  await assert.rejects(summarizeCasual({ messageBatch: [{ role: 'user', content: 'Source with uncounted image' }], modelId: 'model', url, fetchImpl: transport.fetch,
    measure, generate: () => assert.fail('Never infer an unverified source request'), onDiagnostics: () => {} }), { code: 'casual-source-measurement-unavailable' });
});
