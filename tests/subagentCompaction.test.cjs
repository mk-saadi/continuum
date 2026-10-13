'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-compaction-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase(directory);
const { db } = database;
const saved = require('../src/main/subagents/budgetSettings');
const budget = require('../src/main/subagents/executionBudget');
const compression = require('../src/main/compressionEngine');
const { createChildContextAdapter, validatePairs, trimToolResult } = require('../src/main/subagents/contextRecovery');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
const runtime = require('../src/main/subagents');
const engine = { provider: 'local', port: 9, modelId: 'selected-child', contextLength: 8192 };
const call = id => ({ id, type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path: `src/${id}.js` }) } });
const response = (content, calls = [], finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
function transport({ malformed = false, summaryError = false, onRequest, main } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
    const p = JSON.parse(options.body); requests.push(p); onRequest?.(p);
    if (p.messages[0].content.startsWith('Summarize')) {
      if (summaryError) return new Response('', { status: 500 });
      const data = JSON.parse(p.messages[1].content);
      return response(`${data.oldSummary ?? ''} EARLY_VALUE=17; src/c0.js was read. Pending: compare remaining paths.`);
    }
    if (p.messages[0].content.startsWith('You are compressing a Workspace')) {
      const input = JSON.parse(p.messages[1].content), evidence = input.evidence.find(e => e.outcome === 'success');
      return response(malformed ? 'not JSON' : JSON.stringify({ objective: 'Investigate read-only; preserve constraints',
        decisions: [{ text: `EARLY_VALUE=17 from ${evidence?.paths[0] ?? 'source'}`, verified: false, sources: evidence ? [{ messageId: evidence.messageId, stepId: evidence.stepId }] : [] }],
        completedWork: evidence ? [{ text: `Read ${evidence.paths[0]}`, sources: [{ messageId: evidence.messageId, stepId: evidence.stepId }] }] : [],
        nextActions: ['Compare remaining paths'], unknowns: ['No edits performed'], blockers: [], risks: [],
      }));
    }
    return main ? main(p, requests) : response('Final answer EARLY_VALUE=17.');
  };
  return { fetchImpl, requests };
}
async function fixture({ count = 8, size = 2200, transportOptions, signal, childId = 'child-fixture' } = {}) {
  const messages = [{ role: 'system', content: 'Permanent instructions: read only; never edit.' },
    { role: 'user', content: 'Investigate EARLY_VALUE and compare paths. Constraint: read-only.' }];
  for (let i = 0; i < count; i++) messages.push({ role: 'assistant', content: null, tool_calls: [call(`c${i}`)] },
    { role: 'tool', tool_call_id: `c${i}`, content: `EARLY_VALUE=17; src/c${i}.js\n${'e'.repeat(size)}` });
  const session = { id: childId, context: messages, inputSummary: { task: messages[1].content }, activity: [] };
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine });
  const t = transport(transportOptions);
  const adapter = createChildContextAdapter({ session, messages, engine, state, signal, fetchImpl: t.fetchImpl,
    commit: () => { session.context = messages.slice(); } });
  const payload = { model: engine.modelId, messages, tools: [], tool_choice: 'auto', max_tokens: 512 };
  return { session, state, messages, adapter, payload, ...t };
}
test.beforeEach(() => saved.saveBudgetSettings({ mode: 'custom', maxTurns: 100, maxToolCalls: 100,
  maxAggregateToolCalls: 1000, maxInputTokens: 1000000, maxOutputTokens: 500000 }));
test.after(() => { database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('child adapter enters shared Workspace summary/checkpoint pipeline before overflow', async () => {
  const f = await fixture(); const before = await f.adapter.measure(f.payload);
  assert.ok((before.tokens + before.reserve) / before.limit >= .75);
  assert.ok(before.tokens + before.reserve < before.limit);
  const original = compression.checkAndCompressContext; let invoked = 0;
  compression.checkAndCompressContext = options => { assert.equal(options.transcriptAdapter, f.adapter); invoked++; return original(options); };
  try { await f.adapter.prepare(f.payload); } finally { compression.checkAndCompressContext = original; }
  assert.equal(invoked, 1); assert.equal(f.requests.length, 2); assert.equal(f.session.compactionState.version, 1);
  assert.ok(f.session.compactionState.events[0].after.tokens < before.tokens);
});

test('raw transcript survives; compacted request retains objective, restrictions, discovery and pending work', async () => {
  const f = await fixture(); const raw = structuredClone(f.session.rawContext);
  const result = await f.adapter.prepare(f.payload);
  assert.deepEqual(f.session.rawContext, raw); assert.ok(result.messages.length < raw.length);
  const text = JSON.stringify(result.messages);
  for (const needle of ['Permanent instructions', 'Constraint: read-only', 'EARLY_VALUE=17', 'Compare remaining paths', 'Read src/c0.js']) assert.match(text, new RegExp(needle));
  validatePairs(result.messages);
  const row = db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(f.session.id);
  assert.deepEqual(JSON.parse(row.raw_turns_json), raw);
  assert.deepEqual(JSON.parse(row.context_json), f.session.context);
  assert.equal(JSON.parse(row.compaction_json).version, 1);
});

test('repeat compaction retains earlier decisions/actions/requirements rather than trusting omitted fields', async () => {
  const f = await fixture(); await f.adapter.prepare(f.payload);
  const prior = structuredClone(f.session.compactionState.checkpoint);
  for (let i = 8; i < 16; i++) {
    f.adapter.append({ role: 'assistant', content: null, tool_calls: [call(`c${i}`)] });
    f.adapter.append({ role: 'tool', tool_call_id: `c${i}`, content: `NEW_VALUE=23\n${'n'.repeat(2200)}` });
  }
  const result = await f.adapter.prepare({ ...f.payload, messages: f.messages });
  assert.equal(f.session.compactionState.version, 2); validatePairs(result.messages);
  for (const item of prior.completedWork) assert.ok(f.session.compactionState.checkpoint.completedWork.some(x => x.text === item.text));
  for (const item of prior.decisions) assert.ok(f.session.compactionState.checkpoint.decisions.some(x => x.text === item.text));
  assert.match(JSON.stringify(result.messages), /EARLY_VALUE=17/); assert.match(JSON.stringify(result.messages), /Constraint: read-only/);
});

test('parent DB rows and another child remain unchanged during compaction', async () => {
  const parent = require('../src/main/sessionManager'); parent.getOrCreateSession('parent-proof', 'parent-model');
  parent.saveMessage('parent-proof', 'user', 'PRIVATE_PARENT_CONTENT');
  const snapshot = JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all('parent-proof'));
  const a = await fixture({ childId: 'child-a' }), b = await fixture({ childId: 'child-b' });
  const bBefore = structuredClone(b.session.context); await a.adapter.prepare(a.payload);
  assert.deepEqual(b.session.context, bBefore);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all('parent-proof')), snapshot);
  assert.ok(!JSON.stringify(a.requests).includes('PRIVATE_PARENT_CONTENT'));
  await b.adapter.prepare(b.payload); assert.equal(a.session.compactionState.version, 1); assert.equal(b.session.compactionState.version, 1);
});

test('two concurrent adapters have independent versions, raw arrays and provider requests', async () => {
  const a = await fixture({ childId: 'parallel-a' }), b = await fixture({ childId: 'parallel-b' });
  await Promise.all([a.adapter.prepare(a.payload), b.adapter.prepare(b.payload)]);
  assert.notEqual(a.session.rawContext, b.session.rawContext); assert.notEqual(a.session.compactionState, b.session.compactionState);
  assert.equal(a.session.compactionState.version, 1); assert.equal(b.session.compactionState.version, 1);
});

test('selected model/provider and permissions remain unchanged and every generation is tools-disabled', async () => {
  const f = await fixture(); const identity = structuredClone(engine); await f.adapter.prepare(f.payload);
  assert.deepEqual(engine, identity); assert.equal(f.session.id, 'child-fixture');
  assert.ok(f.requests.every(p => p.model === engine.modelId && p.tool_choice === 'none' && !p.tools.length));
  assert.match(f.session.context[0].content, /never edit/);
});

test('compaction charges summary and checkpoint without refilling any lifetime or aggregate counter', async () => {
  const f = await fixture(); f.state.toolCalls = 7; f.state.scope.toolCalls = 11;
  f.state.ledger.inputMeasured = 200; f.state.ledger.outputMeasured = 100;
  await f.adapter.prepare(f.payload);
  assert.equal(f.state.toolCalls, 7); assert.equal(f.state.scope.toolCalls, 11);
  assert.equal(f.state.ledger.turns, 2); assert.equal(f.state.ledger.inputMeasured, 400); assert.equal(f.state.ledger.outputMeasured, 160);
});

test('large structured tool results keep metadata/errors/task values and explicit omission notice', () => {
  const raw = JSON.stringify({ file_path: 'src/config.js', total_lines: 5000,
    content: `START\n${'padding\n'.repeat(2000)}\nEARLY_VALUE=17\nError: permission denied\n${'tail\n'.repeat(500)}` });
  const projected = trimToolResult(raw, { task: 'Find EARLY_VALUE', contextLength: 8192 });
  const obj = JSON.parse(projected);
  assert.equal(obj.file_path, 'src/config.js'); assert.equal(obj.total_lines, 5000); assert.equal(obj.context_trimmed, true);
  assert.match(obj.content, /EARLY_VALUE=17/); assert.match(obj.content, /permission denied/); assert.match(obj.content, /omitted text retained/);
  assert.ok(projected.length < raw.length); assert.equal(trimToolResult('small result'), 'small result');
});

test('in-flight/unmatched tool pairs refuse compaction without requests or transcript mutation', async () => {
  const f = await fixture(); f.messages.push({ role: 'assistant', content: null, tool_calls: [call('pending')] });
  const original = JSON.stringify(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), error => error.compactionReason === 'in-flight-tool-round');
  assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(f.messages), original);
});

test('failed summary does not archive or retry indefinitely', async () => {
  const f = await fixture({ transportOptions: { summaryError: true } }); const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), error => error.stopReason === 'provider_error');
  assert.equal(f.requests.length, 1); assert.equal(f.session.compactionState.version, 0); assert.deepEqual(f.messages, original);
});

test('malformed checkpoint stops without committing; malformed wire input is never sent', async () => {
  const f = await fixture({ transportOptions: { malformed: true } }); const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), error => error.compactionReason === 'malformed-checkpoint');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.messages, original); assert.equal(f.session.compactionState.version, 0);
});

test('cancellation during summary retains raw/active history and counts the dispatched request', async () => {
  const controller = new AbortController();
  const f = await fixture({ signal: controller.signal, transportOptions: { onRequest: () => controller.abort(new DOMException('cancel', 'AbortError')) } });
  const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), { name: 'AbortError' });
  assert.equal(f.state.ledger.turns, 1); assert.deepEqual(f.messages, original); assert.equal(f.session.compactionState.version, 0);
});

test('token exhaustion prevents summary dispatch and keeps distinct Phase 1 reason', async () => {
  const f = await fixture(); f.state.ledger.outputMeasured = f.state.budgets.outputBudget;
  await assert.rejects(f.adapter.prepare(f.payload), error => error.stopReason === 'output_budget');
  assert.equal(f.requests.length, 0); assert.equal(f.session.compactionState.version, 0);
});

test('short tasks incur neither summary/checkpoint requests nor context mutation', async () => {
  const f = await fixture({ count: 0 }); const before = structuredClone(f.messages);
  await f.adapter.prepare(f.payload); assert.equal(f.requests.length, 0); assert.deepEqual(f.messages, before);
  const t = transport(); const session = {};
  const result = await runInvestigationExecution({ session, task: 'A short read-only question.', rootPath: directory, engine: { ...engine, contextLength: 32768 }, fetchImpl: t.fetchImpl });
  assert.equal(result.outcome, 'completed'); assert.equal(t.requests.length, 1);
});

test('stale snapshot/concurrent transcript change refuses candidate commit', async () => {
  let f;
  f = await fixture({ transportOptions: { onRequest: p => {
    if (p.messages[0].content.startsWith('You are compressing')) f.adapter.append({ role: 'user', content: 'New constraint' });
  } } });
  await assert.rejects(f.adapter.prepare(f.payload), error => error.compactionReason === 'context-changed');
  assert.equal(f.session.compactionState.version, 0); assert.equal(f.messages.at(-1).content, 'New constraint');
});

// The unguarded local fixture reports a positively classified backend overflow.
// Recovery executes outside the scheduler's capacity-one lane; no timeout is
// needed and no tool executor runs while context is reconstructed.
test('confirmed overflow compacts once and retries same task without replaying tool effects', async () => {
  const f = await fixture({ count: 8, size: 100 }); let mainCalls = 0;
  const t = transport({ main: () => ++mainCalls === 1 ? Response.json({ error: { type: 'exceed_context_size_error' } }, { status: 400 }) : response('EARLY_VALUE=17 retained.') });
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool; let effects = 0;
  tools.executeAgentTool = async () => { effects++; return 'must not replay'; };
  try {
    const result = await runInvestigationExecution({ session: f.session, engine, rootPath: directory, fetchImpl: t.fetchImpl });
    assert.equal(result.outcome, 'completed'); assert.equal(mainCalls, 2); assert.equal(effects, 0);
    assert.equal(f.session.compactionState.version, 1); assert.equal(f.state.ledger.turns, 4);
  } finally { tools.executeAgentTool = execute; }
});

test('second confirmed overflow returns truthful partial context stop, with no third retry', async () => {
  const f = await fixture({ count: 8, size: 100 }); let mainCalls = 0;
  const t = transport({ main: () => { mainCalls++; return Response.json({ error: { type: 'exceed_context_size_error' } }, { status: 400 }); } });
  const result = await runInvestigationExecution({ session: f.session, engine, rootPath: directory, fetchImpl: t.fetchImpl });
  assert.equal(result.outcome, 'partial'); assert.equal(result.stopReason, 'context_exhausted');
  assert.equal(mainCalls, 2); assert.equal(f.session.compactionState.version, 1);
});

test('running child crosses pressure repeatedly and resumes with early findings without tool replay', async () => {
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool;
  let effects = 0, ordinary = 0;
  tools.executeAgentTool = async ({ arguments: args }) => {
    effects++; const name = JSON.parse(args).relative_path;
    return JSON.stringify({ file_path: name, content: `EARLY_VALUE=17\n${'large evidence\n'.repeat(500)}\nError: preserve this diagnostic\nEND` });
  };
  const session = { id: 'long-live-fixture' };
  const t = transport({ main: p => {
    ordinary++;
    if (ordinary <= 9) return response(null, [call(`live-${ordinary}`)], 'tool_calls');
    assert.match(JSON.stringify(p.messages), /EARLY_VALUE=17/);
    assert.match(JSON.stringify(p.messages), /never edit|read-only/);
    return response('Found EARLY_VALUE=17; no files edited.');
  } });
  try {
    const result = await runInvestigationExecution({ session, task: 'Read paths and find EARLY_VALUE. Constraint: read-only.', engine,
      rootPath: directory, fetchImpl: t.fetchImpl });
    assert.equal(result.outcome, 'completed'); assert.equal(effects, 9);
    assert.ok(session.compactionState.version >= 2);
    assert.equal(session.rawContext.filter(m => m.role === 'tool').length, 9);
    assert.ok(session.rawContext.some(m => m.role === 'tool' && m.content.length > 6000));
    assert.ok(session.context.filter(m => m.role === 'tool').every(m => m.content.length < 4000));
    assert.equal(session.budgetState.toolCalls, 9); assert.equal(session.budgetState.scope.toolCalls, 9);
    assert.equal(session.budgetState.ledger.turns, ordinary + session.compactionState.version * 2);
    const firstRequests = result.accounting.turns;
    const scope = session.budgetState.scope;
    const continued = await runInvestigationExecution({ session, task: 'Report only the already found value.', engine,
      rootPath: directory, fetchImpl: t.fetchImpl });
    assert.equal(continued.outcome, 'completed');
    assert.equal(effects, 9, 'continuation does not repeat completed reads');
    assert.equal(session.budgetState.scope, scope);
    assert.equal(continued.accounting.aggregateToolCalls, 9);
    assert.ok(continued.accounting.turns > firstRequests);
    assert.equal(continued.accounting.turns, ordinary + session.compactionState.version * 2);
    const { subagentUsageLines, subagentResultTitle } = await import('../src/lib/subagentDisplay.mjs');
    assert.equal(subagentResultTitle(continued.outcome), 'Final answer');
    const lines = subagentUsageLines(continued).join('\n');
    assert.match(lines, new RegExp(`Child model requests: ${continued.accounting.turns} / 100`));
    assert.match(lines, /shared snapshot\): 9 \/ 1,000/);
    assert.match(lines, /\(measured\)/);
    validatePairs(session.context);
  } finally { tools.executeAgentTool = execute; }
});

test('cloud metadata/window and saved provider selection survive independent checkpoint generation', async () => {
  const cloud = require('../src/main/cloudProviders'); const getMetadata = cloud.getCloudModelMetadata, createFetch = cloud.createCloudFetch;
  const selected = { provider: 'cloud', modelId: 'cloud-child', chatTarget: { type: 'cloud', provider: 'saved-fixture', model: 'cloud-child' } };
  const f = await fixture({ childId: 'cloud-proof' }); delete f.session.budgetState;
  const t = transport(); let selectedTargets = [];
  cloud.getCloudModelMetadata = async () => [{ providerId: 'saved-fixture', modelId: 'cloud-child', contextLength: 8192 }];
  cloud.createCloudFetch = target => { selectedTargets.push(structuredClone(target)); return t.fetchImpl; };
  try {
    const state = await budget.getExecutionBudget(f.session, { kind: 'investigation', engine: selected });
    const adapter = createChildContextAdapter({ session: f.session, messages: f.messages, engine: selected, state,
      fetchImpl: () => assert.fail('local transport must not serve selected cloud child'), commit: () => { f.session.context = f.messages.slice(); } });
    await adapter.prepare({ ...f.payload, model: 'cloud-child' });
    assert.equal(state.contextSource, 'provider-metadata'); assert.equal(state.budgets.contextLength, 8192);
    assert.equal(selectedTargets.length, 2); assert.ok(selectedTargets.every(target => target.provider === 'saved-fixture'));
    assert.ok(t.requests.every(p => p.model === 'cloud-child')); assert.equal(state.ledger.turns, 2);
    assert.equal(selected.chatTarget.model, 'cloud-child');
  } finally { cloud.getCloudModelMetadata = getMetadata; cloud.createCloudFetch = createFetch; }
});

test('cloud confirmed overflow is classified without exposing body and uses one adapter retry', async () => {
  const cloud = require('../src/main/cloudProviders'); const createFetch = cloud.createCloudFetch;
  const f = await fixture({ count: 8, size: 100, childId: 'cloud-overflow' }); delete f.session.budgetState;
  const selected = { provider: 'cloud', contextLength: 8192, modelId: 'cloud-child', chatTarget: { type: 'cloud', provider: 'saved-fixture', model: 'cloud-child' } };
  let primary = 0;
  const t = transport({ main: () => ++primary === 1 ? Response.json({ error: { code: 'context_length_exceeded', message: 'PRIVATE_BODY' } }, { status: 400 }) : response('Cloud finding EARLY_VALUE=17.') });
  cloud.createCloudFetch = (_target, options) => async (url, config) => {
    const r = await t.fetchImpl(url, config);
    if (!r.ok) await options.onErrorResponse(r);
    return r;
  };
  try {
    const result = await runInvestigationExecution({ session: f.session, engine: selected, rootPath: directory });
    assert.equal(result.outcome, 'completed'); assert.equal(primary, 2);
    assert.equal(f.session.compactionState.version, 1); assert.ok(!JSON.stringify(f.session.compactionState).includes('PRIVATE_BODY'));
  } finally { cloud.createCloudFetch = createFetch; }
});

test('failed runtime compaction returns partial evidence once instead of re-finalizing through another summary', async () => {
  const f = await fixture({ childId: 'summary-failure-runtime' });
  const t = transport({ summaryError: true });
  const result = await runInvestigationExecution({ session: f.session, engine, rootPath: directory, fetchImpl: t.fetchImpl });
  assert.equal(result.outcome, 'partial'); assert.equal(result.stopReason, 'provider_error');
  assert.equal(t.requests.length, 1); assert.match(result.output, /Tool evidence/);
});

test('large checkpoint that would drop essential prior entries refuses archival', async () => {
  const f = await fixture(); f.session.compactionState.checkpoint = { objective: 'Original task',
    decisions: Array.from({ length: 13 }, (_, i) => ({ text: `ESSENTIAL_${i}`, sources: [], verified: false })),
    completedWork: [], outstandingRequirements: [], inProgress: [], filesChanged: [], commands: [], tests: [], blockers: [], risks: [], unknowns: [], nextActions: [] };
  const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), error => error.compactionReason === 'checkpoint-preservation-too-large');
  assert.deepEqual(f.messages, original); assert.equal(f.session.compactionState.version, 0);
});

test('existing selected-model compaction setting disables proactive and overflow summaries', async () => {
  const profiles = require('../src/main/profileSettings');
  profiles.saveProfileSettings(engine.modelId, { compactionEnabled: false });
  try {
    const f = await fixture(); const original = structuredClone(f.messages);
    const returned = await f.adapter.prepare(f.payload);
    assert.equal(returned, f.payload); assert.equal(f.requests.length, 0); assert.deepEqual(f.messages, original);
    await assert.rejects(f.adapter.prepare(f.payload, true), error => error.code === 'CONTEXT_BUDGET_EXCEEDED');
    assert.equal(f.requests.length, 0);
  } finally { profiles.saveProfileSettings(engine.modelId, null); }
});

test('checkpoint evidence requests stay bounded while the validator retains full raw evidence index', async () => {
  const f = await fixture({ count: 45, size: 100 });
  const snapshot = f.adapter.snapshot(f.payload); const input = f.adapter.checkpointInput(snapshot, 'rolling summary');
  assert.ok(input.evidenceOmitted > 0); assert.match(input.omissionNotice, /raw history/);
  assert.ok(JSON.stringify(input.evidence).length <= 12000);
  assert.equal(f.adapter.validationContext(snapshot).index.size, 45);
  assert.equal(f.session.rawContext.filter(m => m.role === 'tool').length, 45);
});

test('compaction does not spend the final reporting request on an unusable checkpoint', async () => {
  const f = await fixture(); f.state.budgets.maxTurns = 2;
  await assert.rejects(f.adapter.prepare(f.payload), error => error.stopReason === 'turn_limit');
  assert.equal(f.requests.length, 0); assert.equal(f.state.ledger.turns, 0);
});

test('oversized Unicode excerpts preserve valid code points and explicit omission metadata', () => {
  const raw = '😀'.repeat(10000) + '\nEARLY_VALUE=17\n' + '😀'.repeat(10000);
  const excerpt = trimToolResult(raw, { task: 'EARLY_VALUE', contextLength: 8192 });
  assert.match(excerpt, /EARLY_VALUE=17/); assert.match(excerpt, /omitted text retained/);
  for (let i = 0; i < excerpt.length; i++) {
    const code = excerpt.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) { assert.ok(excerpt.charCodeAt(++i) >= 0xDC00 && excerpt.charCodeAt(i) <= 0xDFFF); }
    else assert.ok(code < 0xDC00 || code > 0xDFFF);
  }
});
