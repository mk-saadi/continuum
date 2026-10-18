'use strict';
// Phase 1.3A — long-horizon subagent budget policy.
//
// Deterministic coverage for the de-capped / unbounded budget contract:
// legacy settings migration, the 100 boundary, >150 tool calls and model
// requests under explicit authorization, finite exhaustion, explicit
// unbounded behaviour, >2M cumulative tokens, multi-compaction accounting,
// parent aggregate enforcement, permission/cancellation compatibility, and
// UI/backend validation agreement. Mock model backends only; no live calls.
//
// Run with: node --test tests/subagentLongHorizonBudgets.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-longhorizon-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle: () => {}, removeHandler: () => {} } };
  return originalLoad.call(this, name, ...args);
};

const database = require('../src/main/db');
database.initDatabase(directory);
const { db } = database;
const settings = require('../src/main/subagents/budgetSettings');
const budgets = require('../src/main/subagents/budgets');
const executionBudget = require('../src/main/subagents/executionBudget');
const runtime = require('../src/main/subagents');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');

// A wide window keeps the local per-request measurement probes out of these
// tests: they exercise cumulative accounting and dispatch limits, not context.
const engine = { provider: 'local', port: 9, modelId: 'longhorizon-fixture', contextLength: 1000000 };
const call = (id, name = 'list_directory', args = { relative_path: id }) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls = [], finish_reason = 'stop', usage = { prompt_tokens: 100, completion_tokens: 30 }) =>
  Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage });
function script(responses) {
  const requests = [];
  return { requests, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length, 'unexpected extra generation');
    return responses.shift();
  } };
}
function configure(patch = {}) {
  settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null,
    maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null, ...patch });
}

test.beforeEach(() => configure());
test.after(() => { database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

// --- 1. Existing configurations and settings migration ----------------------

test('1. legacy settings (pre-1.3A finite caps) still normalize, persist and round-trip', () => {
  // A record saved by the previous build: 100/100/10000, 1e6/5e5, mode custom,
  // and no Phase 1.3B time-limit keys (they normalize to null = no limit).
  const legacy = { mode: 'custom', maxInputTokens: 1000000, maxOutputTokens: 500000,
    maxToolCalls: 100, maxTurns: 100, maxAggregateToolCalls: 10000,
    maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null };
  assert.deepEqual(settings.normalizeBudgetSettings(legacy), legacy);
  const saved = settings.saveBudgetSettings(legacy);
  assert.deepEqual(saved, legacy);
  assert.deepEqual(settings.getBudgetSettings(), legacy);
  // The old Automatic shape (only tokens set) still resolves without tool/limit fields.
  const auto = settings.normalizeBudgetSettings({ mode: 'auto', maxInputTokens: 200000, maxOutputTokens: 16000 });
  assert.equal(auto.maxToolCalls, null); assert.equal(auto.maxTurns, null); assert.equal(auto.maxAggregateToolCalls, null);
  assert.equal(auto.maxRuntimeMs, null); assert.equal(auto.requestTimeoutMs, null); assert.equal(auto.requestInactivityMs, null);
  // Missing/invalid still behave exactly as before.
  assert.deepEqual(settings.normalizeBudgetSettings(null),
    { mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null,
      maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null });
  assert.throws(() => settings.normalizeBudgetSettings({ mode: 'turbo' }), /mode/);
  assert.throws(() => settings.normalizeBudgetSettings({ maxToolCalls: 0 }), /Tool-call limit/);
  assert.throws(() => settings.normalizeBudgetSettings({ maxToolCalls: 10000001 }), /Tool-call limit/);
  configure();
});

// --- 2. Exactly 100 permitted tool calls -------------------------------------

test('2. exactly 100 tool calls are permitted; the 101st is denied truthfully', async () => {
  const state = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine });
  assert.equal(state.budgets.maxToolCalls, 400); // Automatic default, above 100
  state.budgets.maxToolCalls = 100;             // a pre-1.3A finite value
  for (let i = 0; i < 100; i++) assert.equal(executionBudget.dispatchTool(state, {}, `t${i}`), null);
  assert.equal(state.toolCalls, 100);
  assert.equal(executionBudget.dispatchTool(state, {}, 'one-more'), 'tool_limit');
  assert.equal(state.toolCalls, 100, 'denied calls do not consume the counter');
  assert.equal(state.blockedCalls, 1);
});

// --- 3 & 4. >150 tool calls and >150 model requests, explicitly authorized ---

test('3/4. more than 150 tool calls and 150 model requests run to completion when authorized', async () => {
  configure({ maxToolCalls: 300, maxTurns: 300 });
  const session = {};
  const CALLS = 155;
  const responses = Array.from({ length: CALLS }, (_, i) => reply(null, [call(`c${i}`, 'list_directory', { relative_path: `f${i}` })], 'tool_calls'));
  responses.push(reply('Authorized long-horizon report.'));
  const s = script(responses);
  const result = await runInvestigationExecution({ session, task: 'Long horizon.', rootPath: directory, engine, ...s });
  assert.equal(result.outcome, 'completed');
  assert.equal(session.budgetState.toolCalls, CALLS);
  assert.equal(result.accounting.turns, CALLS + 1);
  assert.equal(s.requests.length, CALLS + 1);
});

// --- 5. Correct finite-budget exhaustion -------------------------------------

test('5. finite custom limits are hard: tool and turn ceilings stop truthfully', async () => {
  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  tools.executeAgentTool = async () => 'Read evidence.';
  try {
  configure({ maxToolCalls: 3, maxTurns: 6 });
  const session = {};
  const responses = Array.from({ length: 6 }, (_, i) => reply(null, [call(`d${i}`, 'list_directory', { relative_path: `${i}` })], 'tool_calls'));
  responses.push(reply('Report.'));
  const result = await runInvestigationExecution({ session, task: 'Bounded.', rootPath: directory, engine, fetchImpl: script(responses).fetchImpl });
  assert.equal(result.stopReason, 'tool_limit'); assert.equal(result.outcome, 'partial');
  assert.equal(session.budgetState.toolCalls, 3);
  assert.equal(session.budgetState.ledger.turns <= 6, true);
  // A finite turn ceiling is independent of the tool ceiling.
  configure({ maxToolCalls: 400, maxTurns: 3 });
  const s = script(Array.from({ length: 6 }, (_, i) => reply(null, [call(`e${i}`, 'list_directory', { relative_path: `${i}` })], 'tool_calls')));
  const stopped = await runInvestigationExecution({ session: {}, task: 'Turns.', rootPath: directory, engine, ...s });
  assert.equal(stopped.stopReason, 'turn_limit');
  } finally { tools.executeAgentTool = execute; }
});

// --- 6. Explicitly unbounded budget behaviour --------------------------------

test('6. unbounded removes the numeric ceiling but keeps context/permission enforcement', async () => {
  configure({ maxToolCalls: 'unbounded', maxTurns: 'unbounded', maxInputTokens: 'unbounded', maxOutputTokens: 'unbounded', maxAggregateToolCalls: 'unbounded' });
  const state = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine });
  assert.equal(state.budgets.maxToolCalls, null);
  assert.equal(state.budgets.maxTurns, null);
  assert.equal(state.budgets.inputBudget, null);
  assert.equal(state.budgets.outputBudget, null);
  assert.equal(state.scope.maxToolCalls, null);
  // Dispatch is unlimited…
  for (let i = 0; i < 5000; i++) assert.equal(executionBudget.dispatchTool(state, {}, `u${i}`), null);
  assert.equal(state.toolCalls, 5000); assert.equal(state.scope.toolCalls, 5000);
  assert.equal(executionBudget.exhaustion(state), null);
  // …but the per-request context window is still enforced, with no numeric budget.
  const small = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 2048 };
  assert.ok(executionBudget.stopBeforeRequest(state, small));
  state.ledger.inputMeasured = 5_000_000_000; // cumulative far beyond any window
  assert.ok(executionBudget.stopBeforeRequest(state, small), 'unbounded cumulative input never trips input_budget');
  state.budgets.contextLength = 8192; // per-request window still enforced
  const overflowing = { messages: [{ role: 'user', content: 'x'.repeat(60000) }], max_tokens: 2048 };
  assert.throws(() => executionBudget.stopBeforeRequest(state, overflowing), error => error.stopReason === 'context_exhausted',
    'the context window is a per-request limit and is never disabled by unbounded budgets');
  // A finite envelope still stops exactly as before.
  state.budgets.inputBudget = 1000;
  assert.throws(() => executionBudget.stopBeforeRequest(state, small), error => error.stopReason === 'input_budget');
});

// --- 7. More than 2M cumulative tokens ---------------------------------------

test('7. more than 2M cumulative tokens are supported and never reported as a context overflow', async () => {
  configure({ maxTurns: 300, maxToolCalls: 300 });
  const session = {};
  const TURNS = 12;
  const perTurn = { prompt_tokens: 200000, completion_tokens: 1000, total_tokens: 201000 };
  const responses = Array.from({ length: TURNS }, (_, i) => reply(null, [call(`p${i}`, 'list_directory', { relative_path: `${i}` })], 'tool_calls', perTurn));
  responses.push(reply('Two-million-token report.', [], 'stop', perTurn));
  const result = await runInvestigationExecution({ session, task: 'Cumulative tokens.', rootPath: directory, engine,
    fetchImpl: script(responses).fetchImpl });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.usage.prompt_tokens, (TURNS + 1) * 200000);
  assert.ok(result.usage.prompt_tokens > 2000000, 'cumulative input exceeds 2M tokens');
  assert.ok(result.accounting.inputTokens > 2000000);
  assert.equal(session.budgetState.budgets.contextLength, 1000000, 'the model context window itself is unchanged');
  assert.notEqual(result.stopReason, 'context_exhausted');
});

// --- 8. Multiple compactions without usage-counter resets --------------------

test('8. repeated child compactions charge the ledger and never reset cumulative usage', async () => {
  configure(); // Automatic policy
  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  let effects = 0, ordinary = 0;
  tools.executeAgentTool = async ({ arguments: args }) => {
    effects++;
    return JSON.stringify({ file_path: JSON.parse(args).relative_path, content: `EARLY_VALUE=17\n${'large evidence\n'.repeat(500)}\nEND` });
  };
  const response = (content, calls = [], finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
  const fetchImpl = async (url, options) => {
    const p = JSON.parse(options.body);
    if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
    if (p.messages[0].content.startsWith('Summarize')) return response('Prior summary EARLY_VALUE=17.');
    if (p.messages[0].content.startsWith('You are compressing a Workspace')) {
      const input = JSON.parse(p.messages[1].content);
      const evidence = input.evidence.find(e => e.outcome === 'success');
      return response(JSON.stringify({ objective: 'Investigate', decisions: [], completedWork: evidence ? [{ text: `Read ${evidence.paths[0]}`, sources: [{ messageId: evidence.messageId, stepId: evidence.stepId }] }] : [], nextActions: [], unknowns: [], blockers: [], risks: [] }));
    }
    ordinary++;
    if (ordinary <= 9) return response(null, [call(`live-${ordinary}`, 'read_project_file', { relative_path: `src/${ordinary}.js` })], 'tool_calls');
    return response('Found EARLY_VALUE=17.');
  };
  try {
    const session = { id: 'lh-multi-compaction' };
    const result = await runInvestigationExecution({ session, task: 'Read paths and find EARLY_VALUE. Constraint: read-only.', engine: { ...engine, contextLength: 8192 }, rootPath: directory, fetchImpl });
    assert.equal(result.outcome, 'completed'); assert.equal(effects, 9);
    assert.ok(session.compactionState.version >= 2, 'the run crosses pressure repeatedly');
    const version = session.compactionState.version;
    // Each compaction is a summary + checkpoint request charged to the same ledger.
    assert.equal(session.budgetState.ledger.turns, ordinary + version * 2);
    assert.equal(session.budgetState.toolCalls, 9, 'compaction never refills the tool counter');
    // Cumulative measured usage equals every request, monotonic, never reset.
    assert.equal(session.budgetState.usage.prompt_tokens, (ordinary + version * 2) * 100);
    assert.ok(session.budgetState.ledger.inputMeasured >= version * 2 * 100);
  } finally {
    tools.executeAgentTool = execute;
  }
});

// --- 9. Parent aggregate-budget enforcement ----------------------------------

test('9. the parent aggregate budget stays shared and finite, and unbounded when chosen', async () => {
  const finite = runtime.createParentRunBudget(); // Automatic (2000)
  assert.equal(finite.maxToolCalls, 2000);
  const a = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine, budgetScope: finite });
  const b = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine, budgetScope: finite });
  let firstLimitAt = null;
  for (let i = 0; i < 2100 && firstLimitAt === null; i++) {
    const state = i % 2 ? a : b;
    state.budgets.maxToolCalls = null; // isolate the shared scope
    if (executionBudget.dispatchTool(state, {}, `s${i}`) === 'aggregate_tool_limit') firstLimitAt = i;
  }
  assert.equal(finite.toolCalls, 2000);
  assert.equal(firstLimitAt, 2000);
  configure({ maxToolCalls: 'unbounded', maxAggregateToolCalls: 'unbounded' });
  const unbounded = runtime.createParentRunBudget();
  assert.equal(unbounded.maxToolCalls, null);
  const state = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine, budgetScope: unbounded });
  for (let i = 0; i < 3000; i++) assert.equal(executionBudget.dispatchTool(state, {}, `n${i}`), null);
  assert.equal(unbounded.toolCalls, 3000);
  configure();
});

// --- 10. Permission and cancellation compatibility ---------------------------

test('10. unbounded budgets do not relax the read-only allowlist or cancellation', async () => {
  configure({ maxToolCalls: 'unbounded', maxTurns: 'unbounded', maxInputTokens: 'unbounded', maxOutputTokens: 'unbounded' });
  // Forbidden tool: rejected as a tool error, never executed.
  const session = {};
  const s = script([reply(null, [call('x', 'run_command', { cmd: 'rm -rf /' })], 'tool_calls'), reply('No writes performed.')]);
  const result = await runInvestigationExecution({ session, task: 'Try a forbidden tool.', rootPath: directory, engine, ...s });
  const toolMsg = session.context.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /not available to this agent/);
  assert.equal(result.outcome, 'completed');
  // Cancellation still aborts even with unbounded budgets.
  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  const controller = new AbortController();
  tools.executeAgentTool = async () => { controller.abort(new DOMException('Cancelled', 'AbortError')); return 'done'; };
  try {
    const c = script([reply(null, [call('y')], 'tool_calls')]);
    await assert.rejects(runInvestigationExecution({ session: {}, task: 'Cancel.', rootPath: directory, engine, signal: controller.signal, ...c }),
      { name: 'AbortError' });
  } finally { tools.executeAgentTool = execute; configure(); }
});

// --- 11. UI persistence and backend validation agreement ---------------------

test('11. backend bounds and the describeAutoPolicy payload the UI reads agree; unbounded persists', () => {
  const policy = budgets.describeAutoPolicy();
  for (const field of ['maxInputTokens', 'maxOutputTokens', 'maxToolCalls', 'maxTurns', 'maxAggregateToolCalls']) {
    assert.deepEqual(policy.limits[field], { ...settings.LIMITS[field], unbounded: 'unbounded' });
    assert.equal(policy.limits[field].unbounded, settings.UNBOUNDED);
  }
  assert.ok(policy.limits.maxToolCalls.max > 100 && policy.limits.maxTurns.max > 100,
    'the finite ceiling is far above the old 100/100 so the UI input max matches the backend');
  // The UI sends the sentinel as a string; it persists verbatim, never as a big int.
  const saved = settings.saveBudgetSettings({ mode: 'custom', maxToolCalls: 'unbounded', maxInputTokens: 'unbounded' });
  assert.equal(saved.maxToolCalls, 'unbounded'); assert.equal(saved.maxInputTokens, 'unbounded');
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('subagentBudgets');
  assert.match(row.value_json, /"maxToolCalls":"unbounded"/);
  assert.deepEqual(settings.getBudgetSettings(), saved);
  // Backend validation still rejects out-of-range / mistyped finite values the UI could send.
  assert.throws(() => settings.saveBudgetSettings({ maxToolCalls: 10000001 }), /Tool-call limit/);
  assert.throws(() => settings.saveBudgetSettings({ maxTurns: 1.5 }), /Turn limit/);
  configure();
});

// --- 12. Phase 1.1/1.2 regression coverage -----------------------------------

test('12. Phase 1.1/1.2 invariants hold: accounting separation and finite enforcement', () => {
  // Ledger semantics (Phase 1.1) are unchanged: measured or estimated input,
  // reserved or measured output, coverage labelled.
  const ledger = budgets.createLedger();
  budgets.recordTurn(ledger, { messages: [{ role: 'user', content: 'hi' }], usage: { prompt_tokens: 1000, completion_tokens: 50 } });
  budgets.recordTurn(ledger, { messages: [{ role: 'user', content: 'hi' }] });
  const totals = budgets.ledgerTotals(ledger);
  assert.equal(totals.inputCoverage, 'mixed'); assert.equal(totals.outputCoverage, 'partial');
  // Custom finite budgets (Phase 1.2) remain strict independent gates.
  const resolved = budgets.resolveTaskBudgets({ kind: 'investigation', engine, settings: { mode: 'custom', maxInputTokens: 600, maxOutputTokens: 100000 } });
  assert.deepEqual(budgets.canAffordNext(budgets.createLedger(), resolved, 601), { ok: false, reason: 'input' });
  const tinyOut = budgets.resolveTaskBudgets({ kind: 'investigation', engine, settings: { mode: 'custom', maxInputTokens: 100000, maxOutputTokens: 100 } });
  assert.deepEqual(budgets.canAffordNext(budgets.createLedger(), tinyOut, 100), { ok: false, reason: 'output' });
  // Display layer renders an unbounded limit as "unbounded", not "unavailable".
  return import('../src/lib/subagentDisplay.mjs').then(({ subagentUsageLines }) => {
    const lines = subagentUsageLines({ accounting: { toolCalls: 1, turns: 2, aggregateToolCalls: 1, aggregateLimit: null,
      inputTokens: 10, outputTokens: 5, outputMeasured: 5, outputReserved: 0, inputCoverage: 'measured', outputCoverage: 'measured',
      effective: { maxToolCalls: null, maxTurns: 200, inputBudget: null, outputBudget: 409600 } } }).join('\n');
    assert.match(lines, /Child tool calls: 1 \/ unbounded/);
    assert.match(lines, /Child input tokens: 10 \/ unbounded/);
  });
});
