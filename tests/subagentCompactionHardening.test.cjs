'use strict';
// Phase 1.4 — context-compaction and recovery hardening.
//
// Focused regression coverage for the behavior Phase 1.4 changes or newly
// verifies on top of the existing compaction suite (tests/subagentCompaction),
// the 1.3C continuation suite (tests/subagentContinuation) and the long-horizon
// benchmark (tests/subagentLongHorizonCompaction):
//
//   * restart recovery re-attaches raw identity instead of duplicating the raw
//     history and the evidence index (the Phase 1.4 recovery defect);
//   * the shared per-invocation aggregate is persisted and rebuilt on recovery,
//     so a recovered child cannot exceed its original finite aggregate;
//   * compaction failure modes (cancellation/timeout/empty/malformed/persistence)
//     leave the last valid transcript intact and never advertise false success;
//   * repeated compaction preserves objective, decisions and requirements;
//   * unverified claims are demoted rather than preserved as facts;
//   * the child's own window and read-only permission surface govern compaction.
// Deterministic and model-free: a scripted transport stands in for the backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-compaction-1-4-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const database = require('../src/main/db');
database.initDatabase(directory);
const { db } = database;
const settings = require('../src/main/subagents/budgetSettings');
const budget = require('../src/main/subagents/executionBudget');
const continuationState = require('../src/main/subagents/continuationState');
const persistence = require('../src/main/subagents/persistence');
const sm = require('../src/main/subagents/sessionManager');
const cm = require('../src/main/subagents/continuationManager');
const { createChildContextAdapter, validatePairs } = require('../src/main/subagents/contextRecovery');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');

const engine = { provider: 'local', port: 9, modelId: 'selected-child', contextLength: 8192 };
const call = (id, name = 'read_project_file') => ({ id, type: 'function',
  function: { name, arguments: JSON.stringify({ relative_path: `src/${id}.js` }) } });
const response = (content, calls = [], finish_reason = 'stop') => Response.json({
  choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }],
  usage: { prompt_tokens: 100, completion_tokens: 30 } });

// The scripted backend. Recognizes the shared summary/checkpoint prompts and
// otherwise defers to `main` (or a plain final answer).
function transport({ malformed = false, summaryError = false, checkpointError = false, emptySummary = false,
  unverifiedCheckpoint = false, onRequest, main } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
    const p = JSON.parse(options.body); requests.push(p); onRequest?.(p);
    if (p.messages[0].content.startsWith(require('../src/main/conversationCompaction').PROMPT)) {
      if (summaryError) return new Response('', { status: 500 });
      if (emptySummary || malformed) return response('   ');
      if (checkpointError && requests.length > 1) return new Response('', { status: 500 });
      const data = JSON.parse(p.messages[1].content);
      return response(`${data.previousSummary ?? ''} EARLY_VALUE=17; src/c0.js was read. Constraint: read-only. Pending: compare remaining paths.`);
    }
    return main ? main(p, requests) : response('Final answer EARLY_VALUE=17.');
  };
  return { fetchImpl, requests };
}

function seedMessages({ count = 8, size = 2200 } = {}) {
  const messages = [{ role: 'system', content: 'Permanent instructions: read only; never edit.' },
    { role: 'user', content: 'Investigate EARLY_VALUE and compare paths. Constraint: read-only.' }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [call(`c${i}`)] },
      { role: 'tool', tool_call_id: `c${i}`, content: `EARLY_VALUE=17; src/c${i}.js\n${'e'.repeat(size)}` });
  }
  return messages;
}

// A bare adapter over a detached session object (no runtime registration).
async function fixture({ count = 8, size = 2200, transportOptions, signal, childEngine = engine, configurationIdentity } = {}) {
  const messages = seedMessages({ count, size });
  const session = { id: `child-${randomUUID()}`, context: messages,
    inputSummary: { task: messages[1].content }, activity: [] };
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine: childEngine });
  const t = transport(transportOptions);
  const adapter = createChildContextAdapter({ session, messages, engine: childEngine, state, signal, configurationIdentity,
    fetchImpl: t.fetchImpl, commit: () => { session.context = messages.slice(); } });
  const payload = { model: childEngine.modelId, messages, tools: [], tool_choice: 'auto', max_tokens: 512 };
  return { session, state, messages, adapter, payload, ...t };
}

// A real, runtime-registered child (needed for persistence + recovery).
async function registeredChild({ count = 8, size = 2200, childEngine = engine,
  parentSessionId = 'owner', budgetScope = undefined, transportOptions } = {}) {
  const messages = seedMessages({ count, size });
  const session = sm.createSession({ parentSessionId, model: childEngine.modelId, provider: childEngine.provider });
  sm.startSession(session);
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine: childEngine, budgetScope });
  session.context = messages; session.rawContext = []; session.inputSummary = { task: messages[1].content };
  cm.registerChild(session, { kind: 'investigation', engine: childEngine, rootPath: directory });
  const t = transport(transportOptions);
  const adapter = createChildContextAdapter({ session, messages, engine: childEngine, state, fetchImpl: t.fetchImpl,
    commit: () => { session.context = messages.slice(); } });
  const payload = { model: childEngine.modelId, messages, tools: [], tool_choice: 'auto', max_tokens: 512 };
  return { session, state, messages, adapter, payload, ...t };
}

function persistAndRestart(child, parentSessionId = 'owner', { stopReason = 'tool_limit', outcome = 'partial' } = {}) {
  sm.completeSession(child.session, { outcome, stopReason, result: 'stopped' });
  persistence.persistChildRun(child.session);
  const childId = child.session.id;
  sm.deleteSession(childId);
  return childId;
}

test.beforeEach(() => settings.saveBudgetSettings({ mode: 'custom', maxTurns: 100, maxToolCalls: 100,
  maxAggregateToolCalls: 1000, maxInputTokens: 1000000, maxOutputTokens: 500000 }));
test.after(() => { database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

// ---- Restart recovery: raw identity (Phase 1.4 fix) -------------------------

test('restart recovery re-attaches raw identity: no duplicated raw history, evidence or tool results', async () => {
  const f = await registeredChild({ count: 8 });
  await f.adapter.prepare(f.payload);                       // one compaction
  assert.equal(f.session.compactionState.version, 1);
  const rawBefore = f.session.rawContext.length;
  const toolBefore = f.session.rawContext.filter(m => m.role === 'tool').length;
  const callBefore = f.session.rawContext.filter(m => m.role === 'assistant' && m.tool_calls?.length).length;
  const childId = persistAndRestart(f);

  const recovered = cm.recoverChild(childId, { parentSessionId: 'owner', engine });
  assert.equal(recovered.recovered, true);
  const live = sm.getSession(childId);
  assert.equal(live.rawContext.length, rawBefore, 'restored raw history is recorded exactly once');
  assert.equal(live.rawContext.filter(m => m.role === 'tool').length, toolBefore);
  assert.equal(live.compactionState.version, 1, 'recovery neither compacts nor resets the version');

  // A post-recovery turn must not re-record the restored projection.
  const t = transport();
  const result = await runInvestigationExecution({ session: live, task: 'Report.', engine, rootPath: directory, fetchImpl: t.fetchImpl });
  assert.equal(result.outcome, 'completed');
  assert.equal(t.requests.length, 1);
  assert.equal(live.rawContext.filter(m => m.role === 'tool').length, toolBefore, 'restored tool results are not duplicated');
  assert.equal(live.rawContext.filter(m => m.role === 'assistant' && m.tool_calls?.length).length, callBefore);
  assert.equal(live.rawContext.length, rawBefore + 1, 'only the genuine new final answer is appended');
  validatePairs(live.context);
});

test('post-recovery compaction archives the restored foundation and keeps the objective', async () => {
  const f = await registeredChild({ count: 8 });
  await f.adapter.prepare(f.payload);
  const childId = persistAndRestart(f);
  cm.recoverChild(childId, { parentSessionId: 'owner', engine });
  const live = sm.getSession(childId);

  // Grow the recovered child and compact it again through a fresh adapter.
  const messages = [...live.context];
  const t = transport();
  const adapter = createChildContextAdapter({ session: live, messages, engine, state: live.budgetState,
    fetchImpl: t.fetchImpl, commit: () => { live.context = messages.slice(); } });
  for (let i = 8; i < 16; i++) {
    adapter.append({ role: 'assistant', content: null, tool_calls: [call(`c${i}`)] });
    adapter.append({ role: 'tool', tool_call_id: `c${i}`, content: `NEW_VALUE=23; src/c${i}.js\n${'n'.repeat(2200)}` });
  }
  const payload = { model: engine.modelId, messages, tools: [], tool_choice: 'auto', max_tokens: 512 };
  await adapter.prepare(payload);
  assert.equal(live.compactionState.version, 2, 'recovery → compaction continues the same version chain');
  const text = JSON.stringify(live.context);
  assert.match(text, /Permanent instructions|read-only/, 'constraints survive the second compaction');
  assert.match(text, /EARLY_VALUE=17/, 'earlier findings survive the second compaction');
  validatePairs(live.context);
  assert.equal(live.rawContext.filter(m => m.role === 'tool').length, 16, 'raw history is never pruned by compaction');
});

// ---- Durable aggregate (Phase 1.4 safety fix) -------------------------------

test('durable budget state persists and restores the shared aggregate ceiling and consumption', () => {
  const serialized = continuationState.serializeBudgetState({
    budgets: { maxToolCalls: 3 }, toolCalls: 3, scope: { id: 'scope-x', toolCalls: 3, maxToolCalls: 5 },
    renewals: [], ledger: {} });
  assert.deepEqual(serialized.scope, { id: 'scope-x', toolCalls: 3, maxToolCalls: 5 });
  const restored = continuationState.deserializeBudgetState(serialized);
  assert.equal(restored.scope.id, 'scope-x');
  assert.equal(restored.scope.toolCalls, 3);
  assert.equal(restored.scope.maxToolCalls, 5);
  // An explicit unbounded aggregate survives as unbounded, not a fake finite cap.
  const unbounded = continuationState.deserializeBudgetState(
    continuationState.serializeBudgetState({ budgets: {}, scope: { id: 'u', toolCalls: 2, maxToolCalls: null } }));
  assert.equal(unbounded.scope.maxToolCalls, null);
});

test('restart recovery keeps the original finite aggregate: renewal cannot grant beyond it', async () => {
  settings.saveBudgetSettings({ mode: 'custom', maxAggregateToolCalls: 5, maxToolCalls: 3,
    maxTurns: null, maxInputTokens: null, maxOutputTokens: null, requestTimeoutMs: null,
    requestInactivityMs: null, maxRuntimeMs: null });
  const f = await registeredChild({ count: 3, parentSessionId: 'agg_owner' });
  f.session.budgetState.toolCalls = 3;
  f.session.budgetState.scope.toolCalls = 3;
  f.session.budgetState.original.maxToolCalls = f.session.budgetState.budgets.maxToolCalls;
  sm.completeSession(f.session, { outcome: 'partial', stopReason: 'tool_limit', result: 'stopped' });
  persistence.persistChildRun(f.session);
  const childId = f.session.id;
  sm.deleteSession(childId);

  cm.recoverChild(childId, { parentSessionId: 'agg_owner', engine });
  const live = sm.getSession(childId);
  assert.equal(live.budgetState.scope.toolCalls, 3, 'aggregate consumption is preserved across restart');
  assert.equal(live.budgetState.scope.maxToolCalls, 5, 'the original aggregate ceiling is re-attached');
  // Remaining aggregate is 2, so a renewal granting 3 must be refused...
  assert.throws(() => cm.renewChildBudget(childId, { maxToolCalls: 6 }, { parentSessionId: 'agg_owner' }),
    /remaining aggregate tool allowance/);
  // ...and a renewal within the remaining aggregate is allowed.
  const ok = cm.renewChildBudget(childId, { maxToolCalls: 5 }, { parentSessionId: 'agg_owner' });
  assert.equal(ok.applied.maxToolCalls, 5);
  assert.equal(sm.getSession(childId).budgetState.scope.maxToolCalls, 5, 'the aggregate itself is never modified');
});

test('a recovered child at its aggregate ceiling cannot dispatch tools', async () => {
  settings.saveBudgetSettings({ mode: 'custom', maxAggregateToolCalls: 3, maxToolCalls: 10,
    maxTurns: null, maxInputTokens: null, maxOutputTokens: null, requestTimeoutMs: null,
    requestInactivityMs: null, maxRuntimeMs: null });
  const f = await registeredChild({ count: 3, parentSessionId: 'ceiling_owner' });
  f.session.budgetState.toolCalls = 3;
  f.session.budgetState.scope.toolCalls = 3;              // aggregate fully consumed
  persistence.persistChildRun(f.session);
  const childId = f.session.id;
  sm.deleteSession(childId);
  cm.recoverChild(childId, { parentSessionId: 'ceiling_owner', engine });
  const live = sm.getSession(childId);

  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  let executed = 0;
  tools.executeAgentTool = async () => { executed++; return 'must not run'; };
  try {
    const t = transport({ main: () => response(null, [call('after-restart')], 'tool_calls') });
    const result = await runInvestigationExecution({ session: live, task: 'Continue.', engine,
      rootPath: directory, fetchImpl: t.fetchImpl });
    assert.equal(executed, 0, 'the original aggregate cap still fences the recovered child');
    assert.equal(result.stopReason, 'aggregate_tool_limit');
    assert.equal(live.budgetState.scope.toolCalls, 3, 'the aggregate did not silently reset');
  } finally { tools.executeAgentTool = execute; }
});

test('recovered siblings of one parent invocation share one reconstructed aggregate', async () => {
  settings.saveBudgetSettings({ mode: 'custom', maxAggregateToolCalls: 10, maxToolCalls: 4,
    maxTurns: null, maxInputTokens: null, maxOutputTokens: null, requestTimeoutMs: null,
    requestInactivityMs: null, maxRuntimeMs: null });
  const scope = budget.createParentRunBudget();
  const a = await registeredChild({ count: 4, parentSessionId: 'sib_owner', budgetScope: scope });
  const b = await registeredChild({ count: 4, parentSessionId: 'sib_owner', budgetScope: scope });
  assert.equal(a.session.budgetState.scope, scope, 'both children share the invocation aggregate');
  scope.toolCalls = 4;
  for (const child of [a, b]) { persistence.persistChildRun(child.session); sm.deleteSession(child.session.id); }
  cm.recoverChild(a.session.id, { parentSessionId: 'sib_owner', engine });
  cm.recoverChild(b.session.id, { parentSessionId: 'sib_owner', engine });
  const sa = sm.getSession(a.session.id).budgetState.scope;
  const sb = sm.getSession(b.session.id).budgetState.scope;
  assert.equal(sa, sb, 'one reconstructed aggregate per invocation, not one per recovered child');
  assert.equal(sa.toolCalls, 4);
  assert.equal(sa.maxToolCalls, 10);
});

// ---- Compaction failure safety (Step 4) -------------------------------------

test('cancellation during summary generation leaves raw/active history and version untouched', async () => {
  const controller = new AbortController();
  const f = await fixture({ signal: controller.signal, transportOptions: { onRequest: () => {
    controller.abort(new DOMException('cancel', 'AbortError'));
  } } });
  const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), { name: 'AbortError' });
  assert.deepEqual(f.messages, original, 'the last valid transcript is preserved');
  assert.equal(f.session.compactionState.version, 0);
  assert.equal(f.session.compactionState.summary ?? null, null, 'no partial summary is committed');
  assert.equal(f.session.rawContext.filter(m => m.role === 'tool').length, 8);
});

test('later staged summary error leaves original coverage intact without committing', async () => {
  const f = await fixture({ count: 30, size: 1500, transportOptions: { checkpointError: true } });
  const original = structuredClone(f.messages);
  await assert.rejects(f.adapter.prepare(f.payload), error => error.compactionReason === 'provider-error');
  assert.equal(f.requests.length, 2, 'summary dispatched, checkpoint failed, no retry');
  assert.deepEqual(f.messages, original);
  assert.equal(f.session.compactionState.version, 0);
});

test('an empty summary is rejected without archiving', async () => {
  const f = await fixture({ transportOptions: { emptySummary: true } });
  const original = structuredClone(f.messages);
  await f.adapter.prepare(f.payload);
  assert.equal(f.session.compactionState.version, 0);
  assert.deepEqual(f.messages, original);
});

test('an empty response never commits or persists a summary', async () => {
  const f = await fixture({ transportOptions: { malformed: true } });
  await f.adapter.prepare(f.payload);
  assert.equal(f.session.compactionState.version, 0);
  const row = db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(f.session.id);
  if (row) assert.equal(JSON.parse(row.compaction_json).version, 0);
});

test('accounting persistence failure prevents dispatch and leaves the projection unchanged', async () => {
  const f = await fixture();
  const savedDb = database.db;
  const savedError = console.error;
  console.error = () => {};
  database.db = { prepare() { throw new Error('disk offline'); }, transaction() { throw new Error('disk offline'); } };
  try {
    await assert.rejects(f.adapter.prepare(f.payload), error => error.code === 'persistence-failed');
  } finally {
    database.db = savedDb;
    console.error = savedError;
  }
  assert.equal(f.session.compactionState.version, 0, 'failed persistence does not advance the projection');
  assert.equal(f.session.compactionState.summary, null);
  assert.equal(f.state.ledger.turns, 0, 'no inference is sent without a durable reservation');
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.durableResumable, false, 'a failed write never advertises resumability');
  assert.equal(f.session.continuation.persisted, false);
});

test('permission identity is captured anew at each boundary and guarded during generation', async () => {
  let revision = 1;
  const f = await fixture({ configurationIdentity: () => revision,
    transportOptions: { onRequest: () => { revision++; } } });
  revision = 2; // A restriction settled before the boundary is valid current state.
  await assert.rejects(f.adapter.prepare(f.payload), error => error.code === 'source-changed');
  assert.equal(f.requests.length, 1, 'the boundary admitted the current restriction');
  assert.equal(f.session.compactionState.version, 0, 'a change during generation cannot commit');
});

test('request and tool reservations are durable before effects and settled usage is saved', async () => {
  let f;
  f = await fixture({ transportOptions: { onRequest() {
    const saved = JSON.parse(db.prepare('SELECT budget_json FROM subagent_runs WHERE child_session_id = ?').get(f.session.id).budget_json);
    assert.equal(saved.ledger.turns, 1);
    assert.ok(saved.ledger.outputReserved > 0);
  } } });
  await f.adapter.prepare(f.payload);
  let saved = JSON.parse(db.prepare('SELECT budget_json FROM subagent_runs WHERE child_session_id = ?').get(f.session.id).budget_json);
  assert.equal(saved.ledger.outputMeasured, 30);
  assert.equal(budget.dispatchTool(f.state, f.session, 'read_project_file'), null);
  saved = JSON.parse(db.prepare('SELECT budget_json FROM subagent_runs WHERE child_session_id = ?').get(f.session.id).budget_json);
  assert.equal(saved.toolCalls, 1);
  assert.equal(saved.scope.toolCalls, 1);
});

test('projection write failure preserves prior summary while keeping durable generation charges', async () => {
  const f = await fixture();
  db.prepare(`CREATE TEMP TRIGGER reject_compaction BEFORE UPDATE ON subagent_runs
    WHEN NEW.child_session_id = '${f.session.id}' AND json_extract(NEW.compaction_json, '$.version') > 0
    BEGIN SELECT RAISE(FAIL, 'simulated projection failure'); END`).run();
  const savedError = console.error; console.error = () => {};
  try { await assert.rejects(f.adapter.prepare(f.payload), error => error.code === 'persistence-failed'); }
  finally { console.error = savedError; db.prepare('DROP TRIGGER reject_compaction').run(); }
  assert.equal(f.session.compactionState.version, 0);
  assert.equal(f.session.compactionState.summary, null);
  const row = db.prepare('SELECT budget_json, compaction_json FROM subagent_runs WHERE child_session_id = ?').get(f.session.id);
  assert.equal(JSON.parse(row.budget_json).ledger.turns, 1);
  assert.equal(JSON.parse(row.compaction_json).version, 0);
});

// ---- Fidelity under repeated compaction (Steps 1, 2, 7) ---------------------

test('repeated compaction preserves decisions, requirements and never rewrites completed work', async () => {
  const f = await fixture();
  await f.adapter.prepare(f.payload);
  const prior = f.session.compactionState.summary;
  for (let round = 1; round <= 2; round++) {
    for (let i = 8 * round; i < 8 * round + 8; i++) {
      f.adapter.append({ role: 'assistant', content: null, tool_calls: [call(`c${i}`)] });
      f.adapter.append({ role: 'tool', tool_call_id: `c${i}`, content: `NEW_VALUE=23; src/c${i}.js\n${'n'.repeat(2200)}` });
    }
    await f.adapter.prepare({ ...f.payload, messages: f.messages });
  }
  assert.equal(f.session.compactionState.version, 3);
  assert.ok(f.requests.some(p => JSON.parse(p.messages[1].content).previousSummary === prior));
  assert.equal(f.session.compactionState.checkpoint, null);
  const text = JSON.stringify(f.session.context);
  assert.match(text, /EARLY_VALUE=17/);
  assert.match(text, /read-only|never edit/);
  validatePairs(f.session.context);
});

test('the model summary is ordinary Markdown with no semantic checkpoint generation', async () => {
  const f = await fixture(); await f.adapter.prepare(f.payload);
  assert.equal(f.requests.length, 1); assert.equal(f.session.compactionState.checkpoint, null);
  assert.ok(f.requests.every(p => !p.response_format && p.tools.length === 0));
});

// ---- Window, model and permission surface (Steps 3, 6) ----------------------

test('compaction triggers on the child’s own context window, not a fixed size', async () => {
  const small = await fixture({ count: 8, size: 2200, childEngine: { ...engine, contextLength: 8192 } });
  const before = await small.adapter.measure(small.payload);
  assert.ok((before.tokens + before.reserve) / before.limit >= 0.75);
  const big = await fixture({ count: 8, size: 2200, childEngine: { ...engine, modelId: 'wide-child', contextLength: 131072 } });
  const result = await big.adapter.prepare(big.payload);
  assert.equal(big.requests.length, 0, 'the same transcript is below threshold at the wider child window');
  assert.equal(result, big.payload);
});

test('compaction and execution never widen the child read-only tool allowlist', async () => {
  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  const calls = [];
  tools.executeAgentTool = async args => { calls.push(args); return 'fixture result'; };
  try {
    const t = transport({ main: (p, requests) => {
      if (requests.length === 1) return response(null, [call('bad', 'write_file')], 'tool_calls');
      if (requests.length === 2) return response(null, [call('good', 'read_project_file')], 'tool_calls');
      return response('Done; read-only respected.');
    } });
    const session = { id: `perm-${randomUUID()}` };
    const result = await runInvestigationExecution({ session, task: 'Read only.', engine, rootPath: directory, fetchImpl: t.fetchImpl });
    assert.equal(result.outcome, 'completed');
    assert.ok(calls.length >= 1 && calls.every(c => c.permissionMode === 'read_only'),
      'every executed tool ran read-only');
    assert.ok(calls.every(c => c.name !== 'write_file'), 'a disallowed tool is never executed');
    assert.match(JSON.stringify(session.context), /not available to this agent/);
  } finally { tools.executeAgentTool = execute; }
});
