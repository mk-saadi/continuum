'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-compaction-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
const builder = require('../src/main/promptBuilder');
const service = require('../src/main/mainChatCompaction');
const budget = require('../src/main/contextBudget');
const cloud = require('../src/main/cloudProviders');
const core = require('../src/main/conversationCompaction');
const project = require('../src/main/projectManager').createProject({ name: 'Compaction fixture' });
let serial = 0;
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 80, completion_tokens: 30 } });
function fixture(workspace = false) {
  const id = `main-compaction-${++serial}`;
  sessions.getOrCreateSession(id, 'model', workspace ? project.id : null);
  for (let i = 0; i < 24; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `message ${i}: ${'source '.repeat(400)}`);
  const payload = { model: 'model', messages: builder.rebuildChatMessages({ sessionId: id, modelId: 'model' }), max_tokens: 512, tools: [], stream: false };
  const requests = [];
  const measure = async p => { const tokens = budget.approximateTokens(p); const budgetContract = budget.createRuntimeBudget({ runtimeContextTokens: 24000, payload: p, currentInputTokens: tokens });
    return { tokens, limit: 24000, budget: budgetContract.usableInputTokens, method: 'fixture-estimate', budgetContract }; };
  const options = { sessionId: id, modelId: 'model', owner: new AbortController(), payload, force: true, measure,
    generate: async p => { requests.push(p); return reply('Current objective: finish the task. EARLY_VALUE=17. User correction takes precedence. Next: verify.'); } };
  return { id, payload, options, requests };
}
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
for (const workspace of [false, true]) for (const provider of ['local', 'cloud']) {
  test(`${provider} ${workspace ? 'workspace' : 'casual'} uses production loop, adapter, request builder and transport`, async () => {
    const f = fixture(workspace), raw = sessions.loadSession(f.id).messages;
    const { runMemoryChat, sanitizeChatMessages } = await import('../src/lib/memoryChat.mjs');
    let sent = 0, generations = 0;
    const target = { type: 'cloud', provider: 'compaction-fixture', model: 'chosen-model' };
    const metadata = async () => [{ providerId: target.provider, modelId: target.model, contextLength: 24000 }];
    cloud.saveCloudProvider({ id: target.provider, name: 'Fixture', modelId: target.model, baseUrl: 'http://localhost:8787/v1', apiKey: '' });
    const wire = async (_url, options) => {
      const p = JSON.parse(options.body);
      if (p.messages[0].content.startsWith(core.PROMPT)) { generations++; return Response.json(reply('EARLY_VALUE=17; continue verification.')); }
      sent++; assert.match(JSON.stringify(p), /EARLY_VALUE=17/);
      assert.equal((JSON.stringify(p).match(/\[COMPACTION SUMMARY\]/g) ?? []).length, 1);
      return Response.json(reply('The task is complete.'));
    };
    const fetchImpl = provider === 'cloud' ? cloud.createCloudFetch(target, { stream: false, fetchImpl: wire, getMetadata: metadata }) : wire;
    const result = await runMemoryChat({ baseUrl: 'http://localhost:9', modelId: 'model', messages: f.payload.messages,
      casualMode: !workspace, cloud: provider === 'cloud', samplingParams: { max_tokens: 512 }, chatTools: [], fetchImpl,
      compactContext: boundary => service.compactAtBoundary({ ...f.options, ...boundary,
        measure: provider === 'cloud' ? require('../src/main/promptMeasurement').createCloudWorkspaceMeasurer(target, { getMetadata: metadata }) : f.options.measure,
        generate: provider === 'cloud' ? async request => (await cloud.createCloudFetch(target, { stream: false, fetchImpl: wire, getMetadata: metadata })('cloud:summary', { body: JSON.stringify(request) })).json()
          : async request => (await wire('http://localhost:9/v1/chat/completions', { body: JSON.stringify(request) })).json() }) });
    assert.equal(result, 'The task is complete.'); assert.equal(sent, 1); assert.ok(generations >= 1);
    assert.deepEqual(sessions.loadSession(f.id).messages, raw);
    const rebuilt = sanitizeChatMessages(builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' }));
    assert.match(JSON.stringify(rebuilt), /EARLY_VALUE=17/);
    assert.ok(!JSON.stringify(rebuilt).includes('[ORIGINAL TASK BRIEF]'));
    assert.equal(service.read(f.id).version, 1);
    const activity = require('../src/main/workspaceCompactionActivity').list(f.id).at(-1);
    assert.equal(activity.metadata.compactionSummary, service.read(f.id).summary);
    assert.ok(activity.metadata.conversationTokens < 5000);
    assert.ok(activity.metadata.compactionUsage.inputTokens > 0);
    assert.ok(activity.metadata.compactionUsage.outputTokens > 0);
    assert.equal(activity.metadata.compactionUsage.outputMethod, 'provider-usage');
    assert.equal(activity.metadata.compactionUsage.outputTokens, generations * 30);
  });
}
test('restart restores summary, retained tail and later user input exactly once', async () => {
  const f = fixture(); await service.compactAtBoundary(f.options);
  const stored = JSON.stringify(service.read(f.id));
  sessions.saveMessage(f.id, 'user', 'LATEST_UNIQUE_CORRECTION');
  storage.closeDatabase(); storage.initDatabase(directory);
  const rebuilt = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' });
  assert.equal(JSON.stringify(service.read(f.id)), stored);
  assert.equal((JSON.stringify(rebuilt).match(/LATEST_UNIQUE_CORRECTION/g) ?? []).length, 1);
  assert.equal((JSON.stringify(rebuilt).match(/COMPACTION SUMMARY/g) ?? []).length, 1);
});
test('branching before summarized content never introduces unrelated branch context', async () => {
  const f = fixture(); await service.compactAtBoundary(f.options);
  const first = sessions.loadSession(f.id).messages[0];
  const branch = sessions.branchChat(f.id, first.id);
  const branchId = typeof branch === 'string' ? branch : branch.id ?? branch.sessionId;
  const context = builder.rebuildChatMessages({ sessionId: branchId, modelId: 'model' });
  assert.ok(!JSON.stringify(context).includes('EARLY_VALUE=17')); assert.equal(service.read(branchId), null);
});
test('branch selection and variants invalidate incompatible summary without deleting any originals', async () => {
  const f = fixture(); await service.compactAtBoundary(f.options);
  const first = sessions.loadSession(f.id).messages[0];
  sessions.editMessage(first.id, 'New branch correction');
  assert.equal(service.stateFor(f.id), null);
  assert.ok(!JSON.stringify(builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' })).includes('EARLY_VALUE=17'));
});
test('legacy summary/checkpoint/archive migration is repeatable, no inference and retains originals', () => {
  const f = fixture(true); const rows = sessions.loadSession(f.id).messages;
  db.prepare('INSERT INTO session_summaries(session_id,summary_text) VALUES (?,?)').run(f.id, 'Legacy summary important finding');
  db.prepare('UPDATE messages SET archived=1,is_summarized=1 WHERE session_id=? AND id<=?').run(f.id, rows[5].id);
  db.prepare(`INSERT INTO workspace_checkpoints(session_id,checkpoint_json,summary_text) VALUES (?,?,?)`).run(f.id, JSON.stringify({ objective: 'Legacy checkpoint goal' }), '');
  const before = sessions.loadSession(f.id).messages;
  const a = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' });
  const b = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' });
  assert.deepEqual(a, b); assert.deepEqual(sessions.loadSession(f.id).messages, before);
  assert.match(JSON.stringify(a), /Legacy summary important finding/); assert.match(JSON.stringify(a), /Legacy checkpoint goal/);
  assert.equal(db.prepare('SELECT count(*) n FROM conversation_compactions WHERE session_id=?').get(f.id).n, 1);
});
test('persistence failure and cancellation never report durable success', async () => {
  const f = fixture(), raw = sessions.loadSession(f.id).messages;
  db.prepare(`CREATE TRIGGER fail_compaction BEFORE INSERT ON conversation_compactions BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`).run();
  try { await assert.rejects(service.compactAtBoundary(f.options), e => e.code === 'persistence-failed'); }
  finally { db.prepare('DROP TRIGGER fail_compaction').run(); }
  assert.deepEqual(sessions.loadSession(f.id).messages, raw); assert.equal(service.read(f.id), null);
  const controller = new AbortController();
  await assert.rejects(service.compactAtBoundary({ ...f.options, signal: controller.signal, generate: async () => { controller.abort(); return reply('x'); } }), { name: 'AbortError' });
  assert.equal(service.read(f.id), null);
});
test('disabled compaction performs no summary request', async () => {
  const f = fixture(); const profiles = require('../src/main/profileSettings');
  profiles.saveProfileSettings('model', { compactionEnabled: false });
  try { assert.equal((await service.compactAtBoundary(f.options)).reason, 'disabled'); assert.equal(f.requests.length, 0); }
  finally { profiles.saveProfileSettings('model', null); }
});
for (const workspace of [false, true]) test(`long ${workspace ? 'workspace' : 'casual'} run compacts completed rounds and restarts without repeating effects`, async () => {
  const f = fixture(workspace), engine = require('../src/main/engineManager');
  const owner = new AbortController(); owner.runId = 'long-run';
  const persistence = engine.createMessagePersistence({ sessionId: f.id, modelId: 'model', runId: owner.runId });
  let steps = [], text = '', ordinary = 0, effects = 0, generations = 0;
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const tool = { type: 'function', function: { name: 'read_project_file', parameters: { type: 'object', properties: { relative_path: { type: 'string' } }, required: ['relative_path'] } } };
  await runMemoryChat({ baseUrl: 'http://localhost:9', modelId: 'model', messages: f.payload.messages,
    samplingParams: { max_tokens: 512 }, chatTools: [tool], maxToolRounds: 25, casualMode: !workspace, onToolLimit: async () => true,
    onExecutionSteps: value => { steps = value; }, onText: chunk => { text += chunk; },
    executeTool: async () => { effects++; return 'TOOL_VALUE=42\n' + 'e'.repeat(10000); },
    compactContext: boundary => {
      persistence.update({ content: text, executionSteps: steps, status: 'in_progress' });
      return service.compactAtBoundary({ ...f.options, ...boundary, owner, messageId: persistence.messageId,
        generate: async () => { generations++; return reply('Objective: finish. TOOL_VALUE=42. Completed reads must not be repeated.'); } });
    },
    fetchImpl: async (_url, options) => {
      const p = JSON.parse(options.body); ordinary++;
      if (ordinary <= 23) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
        tool_calls: [{ id: `read-${ordinary}`, type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path: `f${ordinary}` }) } }] } }] });
      assert.match(JSON.stringify(p), /TOOL_VALUE=42/); return Response.json(reply('Task complete.'));
    } });
  persistence.update({ content: text, executionSteps: steps, status: 'completed' });
  assert.equal(effects, 23); assert.equal(ordinary, 24); assert.ok(service.read(f.id).version >= 2);
  assert.ok(generations >= service.read(f.id).version);
  const stored = sessions.loadSession(f.id).messages.find(m => m.id === persistence.messageId);
  assert.equal(stored.executionSteps.filter(s => s.type === 'tool_call').length, 23);
  const rebuilt = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model' });
  assert.match(JSON.stringify(rebuilt), /TOOL_VALUE=42/);
  assert.equal((JSON.stringify(rebuilt).match(/COMPACTION SUMMARY/g) ?? []).length, 1);
});
test('cloud effective user capacity is reread for each measurement', async () => {
  const target = { type: 'cloud', provider: 'compaction-fixture', model: 'chosen-model' };
  let capacity = 9000;
  const measure = require('../src/main/promptMeasurement').createCloudWorkspaceMeasurer(target, {
    getMetadata: async () => [{ providerId: target.provider, modelId: target.model, contextLength: capacity }] });
  const payload = { model: 'm', messages: [{ role: 'user', content: 'small input' }], tools: [], max_tokens: 1000 };
  const first = await measure(payload); capacity = 5000; const second = await measure(payload);
  assert.equal(first.limit, 9000); assert.equal(second.limit, 5000);
  assert.match(first.method, /estimate/); assert.equal(first.tokens, second.tokens);
});
for (const secondOverflow of [false, true]) test(`cloud provider overflow gets one recovery retry; repeated overflow=${secondOverflow}`, async () => {
  const target = { type: 'cloud', provider: 'compaction-fixture', model: 'chosen-model' };
  let requests = 0, recoveries = 0;
  const transport = cloud.createCloudFetch(target, { stream: false,
    getMetadata: async () => [{ providerId: target.provider, modelId: target.model, contextLength: 8192 }],
    fetchImpl: async () => ++requests === 1 || secondOverflow
      ? Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 }) : Response.json(reply('resumed')) });
  const work = () => transport('cloud:main', { body: JSON.stringify({ messages: [{ role: 'user', content: 'older history' }], max_tokens: 256 }),
    contextRecovery: async ({ contextWindowLimit }) => { recoveries++; assert.equal(contextWindowLimit, 8192); return { messages: [{ role: 'user', content: 'summary' }], max_tokens: 256 }; } });
  if (secondOverflow) await assert.rejects(work()); else assert.equal((await (await work()).json()).choices[0].message.content, 'resumed');
  assert.equal(requests, 2); assert.equal(recoveries, 1);
});
test('regeneration excludes a summary that covered the replaced reply variant', async () => {
  const f = fixture();
  await service.compactAtBoundary({ ...f.options, generate: async () => reply('PRIVATE_OLD_VARIANT_CONTEXT') });
  const rows = sessions.loadSession(f.id).messages;
  const prompt = builder.prepareChatMessages({ sessionId: f.id, modelId: 'model', userText: '', regenerate: true, regenerateLast: true });
  assert.ok(!JSON.stringify(prompt).includes('PRIVATE_OLD_VARIANT_CONTEXT'));
  assert.ok(!JSON.stringify(prompt).includes(core.MARKER));
  assert.equal(sessions.loadSession(f.id).messages.length, rows.length);
});
test('a new raw user turn during generation rejects stale main context and keeps the correction', async () => {
  const f = fixture();
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async () => {
    sessions.saveMessage(f.id, 'user', 'NEW_CORRECTION_DURING_GENERATION'); return reply('obsolete summary');
  } }), e => e.code === 'source-changed');
  assert.equal(service.read(f.id), null);
  assert.equal(sessions.getActiveMessages(f.id).at(-1).content, 'NEW_CORRECTION_DURING_GENERATION');
  assert.equal(storage.db.prepare('SELECT count(*) n FROM compaction_generations WHERE session_id=?').get(f.id).n, 1);
});
test('post-compaction background result updates survive restart without duplicating a tool call', async () => {
  const f = fixture(true), engine = require('../src/main/engineManager');
  const persistence = engine.createMessagePersistence({ sessionId:f.id, modelId:'model', runId:'background-update' });
  const call = { id:'background-handle', type:'function', function:{name:'execute_command',arguments:'{"command":"fixture"}'} };
  const step = {id:call.id,type:'tool_call',toolName:'execute_command',args:{command:'fixture'},status:'complete',result:{status:'running',command_id:'command-fixture'}};
  persistence.update({content:'Background work started',executionSteps:[step],status:'in_progress'});
  const messages = [...f.payload.messages,{role:'assistant',content:null,tool_calls:[call]}, {role:'tool',tool_call_id:call.id,content:JSON.stringify(step.result)}];
  await service.compactAtBoundary({...f.options,payload:{...f.payload,messages},messageId:persistence.messageId});
  persistence.update({content:'Background work completed',executionSteps:[{...step,result:{status:'completed',stdout:'LATEST_BACKGROUND_RESULT'}}],status:'completed'});
  const rebuilt = builder.rebuildChatMessages({sessionId:f.id,modelId:'model'});
  assert.match(JSON.stringify(rebuilt),/LATEST_BACKGROUND_RESULT/);
  assert.equal(rebuilt.filter(m=>m.role==='assistant'&&m.tool_calls?.some(c=>c.id===call.id)).length,1);
  assert.doesNotThrow(()=>core.units(rebuilt.filter(m=>m.role!=='system')));
});

test('telemetry-only updates during generation do not invalidate a conversation snapshot', async () => {
  const f = fixture();
  const last = sessions.loadSession(f.id).messages.at(-1);
  const result = await service.compactAtBoundary({ ...f.options, generate: async () => {
    storage.db.prepare('UPDATE messages SET stats=? WHERE id=?').run(JSON.stringify({ durationMs: 1200, promptTokens: 10656 }), last.id);
    return reply('Current task and correction preserved.');
  } });
  assert.equal(result.compressed, true);
  assert.equal(service.read(f.id).version, 1);
});
