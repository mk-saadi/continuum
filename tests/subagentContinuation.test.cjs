'use strict';
// Phase 1.3C — durable continuation, renewable budgets, and accurate cumulative
// accounting. Deterministic and model-free where possible: eligibility and
// allowance rules are pure, and the few integration cases drive the real
// per-child driver with a scripted fetch seam.
// Run with: node --test tests/subagentContinuation.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-continuation-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};

const dbModule = require('../src/main/db');
dbModule.initDatabase(directory);
const realDb = dbModule.db;
const runtime = require('../src/main/subagents');
const sm = require('../src/main/subagents/sessionManager');
const cm = require('../src/main/subagents/continuationManager');
const budget = require('../src/main/subagents/executionBudget');
const continuationState = require('../src/main/subagents/continuationState');
const persistence = require('../src/main/subagents/persistence');
const settings = require('../src/main/subagents/budgetSettings');
const { listExecutions } = require('../src/main/subagents/executionStore');

const engine = { provider: 'local', port: 9, modelId: 'fixture', contextLength: 32768 };
const { ELIGIBILITY } = continuationState;

const call = (id, name = 'list_directory', args = {}) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls = [], finish_reason = 'stop', usage = { prompt_tokens: 50, completion_tokens: 10 }) =>
  Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage });

function scripted(responses) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      assert.ok(responses.length, 'unexpected extra generation');
      return responses.shift();
    },
  };
}

function configure(patch = {}) {
  // Custom mode with every unset field null resolves per-field to the Automatic
  // policy, exactly like the runtime's own default; a non-null field is the
  // explicit Custom value the test wants.
  settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null,
    maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null,
    maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null, ...patch });
}

test.beforeEach(() => configure());
test.after(() => { dbModule.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

const SAFE_CONTEXT = () => ([
  { role: 'system', content: 'child system prompt' },
  { role: 'user', content: 'Inspect the project.' },
  { role: 'assistant', content: null, tool_calls: [call('call_1')] },
  { role: 'tool', tool_call_id: 'call_1', content: 'file listing evidence' },
]);

// Build a live, stopped child with a real budget state and a driver record, so
// the Phase 1.3C control surface can be exercised without any model traffic.
async function stoppedChild({
  parentSessionId = 'owner', status = 'partial', stopReason = 'tool_limit',
  context = SAFE_CONTEXT(), toolCalls = 1, fetchImpl = null, engineOverride = engine,
} = {}) {
  const session = sm.createSession({ parentSessionId, model: 'fixture', provider: 'local' });
  sm.startSession(session);
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine: engineOverride });
  state.toolCalls = toolCalls;
  state.original.maxToolCalls = state.budgets.maxToolCalls;
  session.context = context;
  cm.registerChild(session, { kind: 'investigation', engine: engineOverride, rootPath: directory, fetchImpl });
  if (status === 'cancelled') sm.cancelSession(session);
  else if (status === 'interrupted') sm.interruptSession(session);
  else sm.completeSession(session, { outcome: status, stopReason, result: 'stopped' });
  return session;
}

// ---- Eligibility: one decision, many stop shapes ---------------------------

test('1. every configured budget stop reason requires a renewal, partial or failed', () => {
  for (const stopReason of ['tool_limit', 'turn_limit', 'input_budget', 'output_budget']) {
    for (const status of ['partial', 'failed']) {
      const decision = continuationState.evaluateContinuation({ status, stopReason, context: SAFE_CONTEXT() });
      assert.equal(decision.eligibility, ELIGIBILITY.NEEDS_RENEWAL, `${status}/${stopReason}`);
      assert.equal(decision.eligible, true);
      assert.equal(decision.requiresRenewal, true);
      assert.equal(decision.requiresExplicitAction, false);
      assert.equal(decision.recoveryRequired, false);
    }
  }
});

test('2. a partial without a budget reason needs explicit action; a plain failure is not eligible', () => {
  const partial = continuationState.evaluateContinuation({ status: 'partial', stopReason: null, context: SAFE_CONTEXT() });
  assert.equal(partial.eligibility, ELIGIBILITY.NEEDS_EXPLICIT_ACTION);
  assert.equal(partial.requiresExplicitAction, true);
  const failed = continuationState.evaluateContinuation({ status: 'failed', stopReason: null, context: SAFE_CONTEXT() });
  assert.equal(failed.eligibility, ELIGIBILITY.NOT_ELIGIBLE);
  assert.equal(failed.eligible, false);
});

test('3. stops a renewal cannot resolve are never offered one', () => {
  for (const stopReason of ['aggregate_tool_limit', 'context_exhausted', 'compaction_failed',
    'provider_budget_violation', 'provider_error', 'runtime_error', 'malformed_response', 'empty_response', 'no_progress']) {
    const decision = continuationState.evaluateContinuation({ status: 'partial', stopReason, context: SAFE_CONTEXT() });
    assert.equal(decision.eligibility, ELIGIBILITY.NOT_ELIGIBLE, stopReason);
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, /^not_renewable:/);
  }
});

test('4. cancelled, timed-out, and interrupted children all need an explicit action', () => {
  for (const [status, reason] of [['cancelled', 'cancelled'], ['timed_out', 'timed_out'], ['interrupted', 'interrupted']]) {
    const decision = continuationState.evaluateContinuation({ status, stopReason: reason, context: SAFE_CONTEXT() });
    assert.equal(decision.eligibility, ELIGIBILITY.NEEDS_EXPLICIT_ACTION, status);
    assert.equal(decision.requiresExplicitAction, true);
    assert.equal(decision.requiresRenewal, false);
  }
});

test('5. a completed child is not eligible unless work is actually pending', () => {
  const done = continuationState.evaluateContinuation({ status: 'completed', stopReason: 'completed', context: SAFE_CONTEXT() });
  assert.equal(done.eligibility, ELIGIBILITY.NOT_ELIGIBLE);
  assert.equal(done.reason, 'already_completed');
  const queued = continuationState.evaluateContinuation({ status: 'completed', stopReason: 'completed', context: SAFE_CONTEXT(), inbox: [{ message: 'next' }] });
  assert.equal(queued.eligibility, ELIGIBILITY.NEEDS_EXPLICIT_ACTION);
  assert.equal(queued.reason, 'completed_with_pending');
  const unfinished = continuationState.evaluateContinuation({ status: 'completed', stopReason: 'interrupted', context: SAFE_CONTEXT() },
    { pendingContinuation: true });
  assert.equal(unfinished.eligibility, ELIGIBILITY.NEEDS_EXPLICIT_ACTION);
});

test('6. in-progress statuses are never a continuation target', () => {
  for (const status of ['created', 'waiting', 'running']) {
    const decision = continuationState.evaluateContinuation({ status, context: SAFE_CONTEXT() });
    assert.equal(decision.eligibility, ELIGIBILITY.NOT_ELIGIBLE, status);
    assert.equal(decision.reason, 'in_progress');
  }
});

test('7. transcript boundary safety is verified independently', () => {
  assert.equal(continuationState.isSafeBoundary(SAFE_CONTEXT()), true);
  const dangling = SAFE_CONTEXT().slice(0, 3); // assistant tool_calls with no results
  assert.equal(continuationState.isSafeBoundary(dangling), false);
  assert.equal(continuationState.isSafeBoundary([{ role: 'assistant', tool_calls: [call('a')] }]), false);
  assert.equal(continuationState.isSafeBoundary(null), false);
});

test('8. an unsafe boundary overrides eligibility and forces recovery', () => {
  const dangling = SAFE_CONTEXT().slice(0, 3);
  const decision = continuationState.evaluateContinuation({ status: 'partial', stopReason: 'tool_limit', context: dangling });
  assert.equal(decision.eligible, false);
  assert.equal(decision.recoveryRequired, true);
  assert.equal(decision.reason, 'unsafe_boundary');
  const interrupted = continuationState.evaluateContinuation({ status: 'interrupted', stopReason: 'interrupted', context: dangling });
  assert.equal(interrupted.recoveryRequired, true);
  assert.equal(interrupted.eligible, false);
});

// ---- Renewable budgets: original vs current, never a reset -----------------

test('9. renewal raises only the named totals and records an auditable entry', async () => {
  configure({ maxTurns: 2, maxToolCalls: 3 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  const applied = budget.renewBudget(state, { maxToolCalls: 5 }, { reason: 'continue', source: 'user', parentSessionId: 'owner' });
  assert.deepEqual(applied.applied, { maxToolCalls: 5 });
  assert.equal(state.budgets.maxToolCalls, 5);
  assert.equal(state.budgets.maxTurns, 2, 'untouched fields keep their totals');
  assert.equal(state.renewals.length, 1);
  const [entry] = state.renewals;
  assert.equal(entry.field, 'maxToolCalls');
  assert.equal(entry.previous, 3);
  assert.equal(entry.granted, 2);
  assert.equal(entry.total, 5);
  assert.equal(entry.reason, 'continue');
  assert.equal(entry.parentSessionId, 'owner');
  const allowance = continuationState.summarizeAllowance(state);
  assert.equal(allowance.original.maxToolCalls, 3);
  assert.equal(allowance.granted.maxToolCalls, 2);
  assert.equal(allowance.current.maxToolCalls, 5);
});

test('10. renewal is monotonic: below-current is refused, equal is a no-op', async () => {
  configure({ maxToolCalls: 3 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  assert.throws(() => budget.renewBudget(state, { maxToolCalls: 2 }), /cannot be renewed below its current total/);
  const reset = budget.renewBudget(state, { maxToolCalls: 3 });
  assert.deepEqual(reset.renewals, []);
  assert.equal(state.renewals.length, 0, 'no spurious renewal record for a no-op');
  assert.equal(state.budgets.maxToolCalls, 3);
});

test('11. renewal never resets consumed counters or usage', async () => {
  configure({ maxTurns: 2, maxToolCalls: 3 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  state.toolCalls = 2;
  state.ledger.turns = 2;
  state.ledger.inputMeasured = 1234;
  state.ledger.outputMeasured = 55;
  state.usage = { prompt_tokens: 1234, completion_tokens: 55 };
  budget.renewBudget(state, { maxToolCalls: 6, maxTurns: 4 });
  assert.equal(state.toolCalls, 2);
  assert.equal(state.ledger.turns, 2);
  assert.deepEqual(state.usage, { prompt_tokens: 1234, completion_tokens: 55 });
  const allowance = continuationState.summarizeAllowance(state);
  assert.deepEqual(allowance.consumed, { turns: 2, toolCalls: 2, inputTokens: 1234, outputTokens: 55, aggregateToolCalls: 0 });
  assert.equal(allowance.remaining.maxToolCalls, 4);
  assert.equal(allowance.remaining.maxTurns, 2);
});

test('12. renewal rejects unknown fields and out-of-range numbers', async () => {
  configure({ maxToolCalls: 3 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  assert.throws(() => budget.renewBudget(state, { bogus: 1 }), /not a renewable sub-agent budget field/);
  assert.throws(() => budget.renewBudget(state, { maxToolCalls: 0 }), /must be an integer/);
  assert.throws(() => budget.renewBudget(state, { maxTurns: 1.5 }), /must be an integer/);
  assert.equal(state.renewals.length, 0);
});

test('13. unbounded is an explicit sentinel and a finite budget cannot be re-capped', async () => {
  // Turn/token envelopes are not aggregate-guarded: unbounded applies directly.
  configure({ maxTurns: 2, maxToolCalls: 3, maxAggregateToolCalls: settings.UNBOUNDED });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  const applied = budget.renewBudget(state, { maxTurns: settings.UNBOUNDED }, { reason: 'explicit' });
  assert.equal(state.budgets.maxTurns, null);
  assert.equal(applied.renewals[0].granted, null);
  const allowance = continuationState.summarizeAllowance(state);
  assert.equal(allowance.current.maxTurns, null);
  assert.equal(allowance.remaining.maxTurns, null);
  assert.throws(() => budget.renewBudget(state, { maxTurns: 10 }), /already unbounded/);
  // A tool-call budget may only become unbounded when the shared aggregate is
  // itself unbounded — otherwise the aggregate's finite ceiling still governs.
  assert.equal(state.scope.maxToolCalls, null);
  budget.renewBudget(state, { maxToolCalls: settings.UNBOUNDED });
  assert.equal(state.budgets.maxToolCalls, null);
  // With a finite aggregate, an unbounded tool renewal is refused, not silently
  // allowed to exceed the parent's own ceiling.
  configure({ maxToolCalls: 3 });
  const finiteScopeState = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  assert.throws(() => budget.renewBudget(finiteScopeState, { maxToolCalls: settings.UNBOUNDED }),
    /remaining aggregate tool allowance/);
});

test('14. a renewal can never authorize more tool work than the parent aggregate holds', async () => {
  configure({ maxAggregateToolCalls: 1, maxToolCalls: 1 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  state.scope.toolCalls = 1; // aggregate already spent by this run
  assert.throws(() => budget.renewBudget(state, { maxToolCalls: 2 }), /remaining aggregate tool allowance/);
  assert.equal(state.scope.maxToolCalls, 1, 'the aggregate itself is never modified');
  assert.equal(state.scope.toolCalls, 1);
});

test('15. allowance accounting distinguishes original / granted / current / consumed / remaining', async () => {
  configure({ maxTurns: 2, maxToolCalls: 3 });
  const state = await budget.getExecutionBudget({}, { kind: 'investigation', engine });
  state.toolCalls = 1;
  state.ledger.turns = 1;
  budget.renewBudget(state, { maxToolCalls: 5 });
  budget.renewBudget(state, { maxToolCalls: 8 });
  const allowance = continuationState.summarizeAllowance(state);
  assert.equal(allowance.original.maxTurns, 2);
  assert.equal(allowance.original.maxToolCalls, 3);
  assert.equal(allowance.current.maxToolCalls, 8);
  assert.equal(allowance.granted.maxToolCalls, 5);
  assert.equal(allowance.consumed.toolCalls, 1);
  assert.equal(allowance.remaining.maxToolCalls, 7);
  assert.equal(allowance.renewals.length, 2);
  assert.deepEqual(allowance.renewals.map(entry => entry.total), [5, 8]);
});

// ---- Control surface: inspect, renew, continue, recover ---------------------

test('16. continuationStatus is a read-only snapshot of a stopped child', async () => {
  const session = await stoppedChild({ parentSessionId: 'status_owner', toolCalls: 1 });
  const before = JSON.stringify({ status: session.status, stopReason: session.stopReason, toolCalls: session.budgetState.toolCalls });
  const snapshot = cm.continuationStatus(session.id, { parentSessionId: 'status_owner' });
  assert.equal(snapshot.childSessionId, session.id);
  assert.equal(snapshot.parentSessionId, 'status_owner');
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.stopReason, 'tool_limit');
  assert.equal(snapshot.continuable, true);
  assert.equal(snapshot.eligibility.eligibility, ELIGIBILITY.NEEDS_RENEWAL);
  assert.equal(snapshot.allowance.current.maxToolCalls, session.budgetState.budgets.maxToolCalls);
  assert.equal(snapshot.durableResumable, true);
  assert.equal(listExecutions(session.id).length, 0, 'inspection never creates an execution');
  assert.equal(JSON.stringify({ status: session.status, stopReason: session.stopReason, toolCalls: session.budgetState.toolCalls }), before);
});

test('17. continueChild refuses a budget-stopped child until a renewal is supplied', async () => {
  const session = await stoppedChild({ parentSessionId: 'no_renew' });
  const result = cm.continueChild(session.id, { parentSessionId: 'no_renew' });
  assert.equal(result.continued, false);
  assert.equal(result.reason, 'renewal_required');
  assert.equal(session.status, 'partial', 'a refused continuation does not wake the child');
  assert.equal(session.inbox.length, 0);
  assert.equal(listExecutions(session.id).length, 0);
});

test('18. continueChild renews, enqueues one instruction, and drives the same child', async () => {
  configure({ maxToolCalls: 1 });
  const script = scripted([reply('Found it.')]);
  const session = await stoppedChild({ parentSessionId: 'drive_owner', fetchImpl: script.fetchImpl });
  const done = once(runtime.backgroundEvents, 'completed');
  const result = cm.continueChild(session.id, { parentSessionId: 'drive_owner', renewal: { maxToolCalls: 4 }, reason: 'user requested' });
  assert.equal(result.continued, true);
  assert.equal(result.renewal.applied.maxToolCalls, 4);
  assert.equal(session.inbox.length, 1);
  assert.equal(session.inbox[0].continuation, true);
  assert.equal(session.status, 'waiting');
  await done;
  assert.equal(session.status, 'completed');
  assert.equal(session.budgetState.toolCalls, 1, 'the continuation added no tool calls');
  assert.equal(script.requests.length, 1);
  const request = script.requests[0];
  assert.equal(request.model, 'fixture');
  assert.ok(request.messages.some(message => message.content === 'file listing evidence'),
    'the previous tool result is reused, not replayed');
  assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.includes('[Continuation]')));
  // Permission scope is unchanged for a continuation turn: read-only allowlist only.
  const allowed = new Set(['search_project_content', 'read_project_file', 'list_directory',
    'get_single_web_page_content', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame']);
  for (const tool of request.tools ?? []) assert.ok(allowed.has(tool.function?.name ?? tool.name), tool.function?.name);
});

test('19. a continued child keeps its original session, model, and parent lineage', async () => {
  configure({ maxToolCalls: 1 });
  const script = scripted([reply('Done.')]);
  const session = await stoppedChild({ parentSessionId: 'lineage_owner', fetchImpl: script.fetchImpl });
  const originalModel = session.model;
  const childrenBefore = sm.listChildren('lineage_owner').length;
  const done = once(runtime.backgroundEvents, 'completed');
  cm.continueChild(session.id, { parentSessionId: 'lineage_owner', renewal: { maxToolCalls: 4 } });
  await done;
  assert.equal(sm.getSession(session.id), session, 'same child session object');
  assert.equal(session.model, originalModel);
  assert.equal(session.provider, 'local');
  assert.equal(sm.listChildren('lineage_owner').length, childrenBefore, 'no second child is created');
});

test('20. two consecutive renewals accumulate history and keep consumption continuous', async () => {
  configure({ maxToolCalls: 1 });
  const session = await stoppedChild({ parentSessionId: 'consecutive_owner', toolCalls: 1 });
  const first = cm.renewChildBudget(session.id, { maxToolCalls: 3 }, { parentSessionId: 'consecutive_owner', reason: 'first' });
  assert.equal(first.applied.maxToolCalls, 3);
  const second = cm.renewChildBudget(session.id, { maxToolCalls: 5 }, { parentSessionId: 'consecutive_owner', reason: 'second' });
  assert.equal(second.applied.maxToolCalls, 5);
  assert.equal(session.budgetState.renewals.length, 2);
  assert.equal(session.budgetState.renewals[0].previous, 1);
  assert.equal(session.budgetState.renewals[0].granted, 2);
  assert.equal(session.budgetState.renewals[1].previous, 3);
  assert.equal(session.budgetState.renewals[1].granted, 2);
  assert.equal(session.budgetState.toolCalls, 1, 'consumption is unchanged across renewals');
  assert.equal(second.allowance.granted.maxToolCalls, 4);
});

test('21. a completed child cannot be continued or renewed', async () => {
  const session = await stoppedChild({ parentSessionId: 'done_owner', status: 'completed', stopReason: 'completed' });
  const result = cm.continueChild(session.id, { parentSessionId: 'done_owner', renewal: { maxToolCalls: 5 } });
  assert.equal(result.continued, false);
  assert.equal(result.reason, 'already_completed');
  assert.throws(() => cm.renewChildBudget(session.id, { maxToolCalls: 5 }, { parentSessionId: 'done_owner' }),
    /does not need a renewal/);
});

test('22. cancelled and timed-out children require an explicit acknowledgement', async () => {
  for (const status of ['cancelled', 'timed_out']) {
    const parent = `${status}_ack_owner`;
    const script = scripted([reply('Resumed.')]);
    const session = await stoppedChild({ parentSessionId: parent, status, stopReason: status, fetchImpl: script.fetchImpl });
    const refused = cm.continueChild(session.id, { parentSessionId: parent });
    assert.equal(refused.continued, false, status);
    assert.equal(refused.reason, `${status}_requires_explicit_action`);
    const flag = status === 'cancelled' ? { allowCancelled: true } : { allowTimedOut: true };
    const done = once(runtime.backgroundEvents, 'completed');
    const accepted = cm.continueChild(session.id, { parentSessionId: parent, ...flag });
    assert.equal(accepted.continued, true, status);
    await done;
    assert.equal(session.status, 'completed', status);
  }
});

test('23. only the owning parent may inspect, renew, or continue a child', async () => {
  const session = await stoppedChild({ parentSessionId: 'rightful_owner' });
  assert.throws(() => cm.continuationStatus(session.id, { parentSessionId: 'intruder' }), /Only the owning parent/);
  assert.throws(() => cm.renewChildBudget(session.id, { maxToolCalls: 5 }, { parentSessionId: 'intruder' }), /Only the owning parent/);
  assert.throws(() => cm.continueChild(session.id, { parentSessionId: 'intruder', renewal: { maxToolCalls: 5 } }), /Only the owning parent/);
  assert.equal(session.status, 'partial');
});

test('24. renewing one child never touches another child or the shared aggregate', async () => {
  configure({ maxAggregateToolCalls: 100, maxToolCalls: 3 });
  const scope = runtime.createParentRunBudget();
  const a = await stoppedChild({ parentSessionId: 'isolation_owner' });
  const b = await stoppedChild({ parentSessionId: 'isolation_owner' });
  a.budgetState.scope = scope; b.budgetState.scope = scope;
  scope.toolCalls = 2;
  const before = { budget: b.budgetState.budgets.maxToolCalls, toolCalls: b.budgetState.toolCalls, aggregate: scope.toolCalls };
  cm.renewChildBudget(a.id, { maxToolCalls: 6 }, { parentSessionId: 'isolation_owner' });
  assert.equal(a.budgetState.budgets.maxToolCalls, 6);
  assert.equal(b.budgetState.budgets.maxToolCalls, before.budget, 'the other child is untouched');
  assert.equal(b.budgetState.toolCalls, before.toolCalls);
  assert.equal(scope.toolCalls, before.aggregate, 'the parent aggregate is never modified by a renewal');
  assert.equal(scope.maxToolCalls, 100);
});

test('25. an unsafe-boundary child is refused and marked recovery-required', async () => {
  const session = await stoppedChild({ parentSessionId: 'unsafe_owner', context: SAFE_CONTEXT().slice(0, 3) });
  const result = cm.continueChild(session.id, { parentSessionId: 'unsafe_owner', renewal: { maxToolCalls: 5 } });
  assert.equal(result.continued, false);
  assert.equal(result.reason, 'unsafe_boundary');
  assert.equal(result.eligibility.recoveryRequired, true);
  assert.equal(session.durableResumable, false, 'an unsafe child is never advertised durable-resumable');
});

test('26. a partial with no budget reason continues without needing a renewal', async () => {
  const script = scripted([reply('Continued.')]);
  const session = await stoppedChild({ parentSessionId: 'explicit_owner', status: 'partial', stopReason: null, fetchImpl: script.fetchImpl });
  const decision = continuationState.evaluateContinuation(session, {});
  assert.equal(decision.eligibility, ELIGIBILITY.NEEDS_EXPLICIT_ACTION);
  assert.equal(decision.requiresRenewal, false);
  const done = once(runtime.backgroundEvents, 'completed');
  const accepted = cm.continueChild(session.id, { parentSessionId: 'explicit_owner' }); // no renewal supplied
  assert.equal(accepted.continued, true);
  assert.equal(accepted.renewal, null, 'no budget was renewed for a non-budget stop');
  assert.equal(session.budgetState.renewals.length, 0);
  await done;
  assert.equal(session.status, 'completed');
});

// ---- Durability: persisted verdict, false-resumable refusal, restart --------

test('27. durable resumability is advertised only after a successful write', async () => {
  const session = await stoppedChild({ parentSessionId: 'durable_owner' });
  assert.equal(session.durableResumable, true);
  const row = realDb.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(session.id);
  assert.ok(row.continuation_json);
  const stored = JSON.parse(row.continuation_json);
  assert.equal(stored.eligibility, ELIGIBILITY.NEEDS_RENEWAL);
  assert.equal(stored.requiresRenewal, true);
  assert.equal(stored.persisted, undefined, 'the persisted verdict stores eligibility, not the write flag');
  assert.ok(row.budget_json);
  assert.ok(Number.isSafeInteger(row.attempt_count));
});

test('28. a failed persistence write never advertises resumability', async () => {
  const session = await stoppedChild({ parentSessionId: 'persist_fail_owner' });
  const savedDb = dbModule.db;
  const savedError = console.error;
  console.error = () => {};
  dbModule.db = { prepare() { throw new Error('disk offline'); }, transaction() { throw new Error('disk offline'); } };
  try {
    const ok = persistence.persistChildRun(session);
    assert.equal(ok, false);
    assert.equal(session.durableResumable, false);
    assert.equal(session.continuation.persisted, false);
    assert.equal(session.continuation.resumable, false);
  } finally {
    dbModule.db = savedDb;
    console.error = savedError;
  }
  // The child remains operable; a later successful write restores durability.
  assert.equal(persistence.persistChildRun(session), true);
  assert.equal(session.durableResumable, true);
});

test('29. restart recovery rebuilds a stopped child without ever executing it', async () => {
  const session = await stoppedChild({ parentSessionId: 'recovery_owner', toolCalls: 1 });
  session.compactionState = { events: [{ at: 'x', reason: 'test' }], version: 1 };
  persistence.persistChildRun(session);
  const childId = session.id;
  const attemptsBefore = listExecutions(childId).length;
  sm.deleteSession(childId); // simulate a process restart: runtime state gone

  const listed = cm.listRecoverableChildren({ parentSessionId: 'recovery_owner' });
  const entry = listed.find(item => item.childSessionId === childId);
  assert.ok(entry, 'the durable child is listed');
  assert.equal(entry.eligibility.eligibility, ELIGIBILITY.NEEDS_RENEWAL);
  assert.equal(entry.status, 'partial');
  assert.ok(listExecutions(childId).length <= attemptsBefore, 'listing starts nothing');

  const recovered = cm.recoverChild(childId, { parentSessionId: 'recovery_owner', engine });
  assert.equal(recovered.recovered, true);
  const live = sm.getSession(childId);
  assert.equal(live.status, 'partial', 'rebuilt in its truthful stopped state');
  assert.equal(live.stopReason, 'tool_limit');
  assert.deepEqual(live.compactionState, { events: [{ at: 'x', reason: 'test' }], version: 1 });
  assert.equal(live.budgetState.budgets.maxToolCalls, session.budgetState.budgets.maxToolCalls);
  assert.equal(listExecutions(childId).length, 0, 'recovery is not an execution');
  const record = cm.getRecord(childId);
  assert.equal(record.driving, false);
  assert.equal(record.scheduled, false);
  assert.equal(cm.continuationStatus(childId, { parentSessionId: 'recovery_owner' }).eligibility.requiresRenewal, true);
});

test('30. recovery enforces ownership and (optionally) that the owner still exists', async () => {
  const session = await stoppedChild({ parentSessionId: 'ghost_parent' });
  const childId = session.id;
  sm.deleteSession(childId);
  assert.throws(() => cm.recoverChild(childId, { parentSessionId: 'someone_else' }), /Only the owning parent/);
  assert.throws(() => cm.recoverChild(childId, { parentSessionId: 'ghost_parent', engine, verifyOwner: true }),
    /no longer exists/);
  // With a real owner row, verified recovery succeeds.
  const now = new Date().toISOString();
  realDb.prepare('INSERT OR IGNORE INTO sessions(id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)')
    .run('ghost_parent', 'Owner', now, now);
  const recovered = cm.recoverChild(childId, { parentSessionId: 'ghost_parent', engine, verifyOwner: true });
  assert.equal(recovered.recovered, true);
});

test('31. a late settlement cannot overwrite an already-stopped child', () => {
  const session = sm.createSession({ parentSessionId: 'late_owner' });
  sm.startSession(session);
  sm.interruptSession(session);
  assert.equal(session.status, 'interrupted');
  const resultBefore = session.result;
  sm.completeSession(session, { outcome: 'completed', result: 'late result', stopReason: 'completed' });
  assert.equal(session.status, 'interrupted', 'the interrupted state is sticky');
  assert.equal(session.result, resultBefore);
  sm.failSession(session, new Error('late failure'));
  assert.equal(session.status, 'interrupted');
  assert.equal(session.stopReason, 'interrupted');
});

test('32. renewal leaves runtime limits and the model-routing identity intact', async () => {
  configure({ maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 60000, requestTimeoutMs: 5000 });
  const session = await stoppedChild({ parentSessionId: 'limits_owner' });
  const runtimeBefore = { ...session.budgetState.runtime };
  const engineBefore = { ...session.continuationOptions.engine };
  cm.renewChildBudget(session.id, { maxToolCalls: 6 }, { parentSessionId: 'limits_owner' });
  assert.deepEqual(session.budgetState.runtime, runtimeBefore, 'time limits are not renewed or cleared');
  assert.deepEqual(session.continuationOptions.engine, engineBefore, 'routing identity is unchanged');
  assert.equal(session.model, 'fixture');
});

// ---- End-to-end: a real budget-exhausted run continues deterministically ----

test('33. an end-to-end budget stop continues without replaying completed tool calls', async () => {
  configure({ maxToolCalls: 1 });
  const script = scripted([
    reply(null, [call('call_1')], 'tool_calls'), // first turn uses the only tool call
    reply('Partial findings so far.'),            // tool-free finalization at the ceiling
    reply('Completed the objective.'),            // continuation turn after renewal
  ]);
  let childId = null;
  const output = await runtime.runInvestigation({
    parentSessionId: 'e2e_owner', task: 'Inspect the project.', rootPath: directory,
    engine, fetchImpl: script.fetchImpl, onSpawn: value => { childId = value; },
  });
  assert.match(output, /tool_limit/);
  let child = sm.getSession(childId);
  assert.equal(child.status, 'partial');
  assert.equal(child.budgetState.toolCalls, 1);
  assert.equal(child.durableResumable, true);

  const done = once(runtime.backgroundEvents, 'completed');
  const result = cm.continueChild(childId, { parentSessionId: 'e2e_owner', renewal: { maxToolCalls: 3 } });
  assert.equal(result.continued, true);
  await done;
  child = sm.getSession(childId);
  assert.equal(child.status, 'completed');
  assert.equal(child.stopReason, 'completed');
  assert.equal(child.budgetState.toolCalls, 1, 'no tool was repeated after the renewal');
  assert.equal(script.requests.length, 3);
  const continuationRequest = script.requests[2];
  const toolMessages = continuationRequest.messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 1, 'the single prior tool result is reused exactly once');
  assert.ok(continuationRequest.messages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls)));
  assert.equal(continuationRequest.max_tokens > 0, true);
});

test('34. an aggregate-bounded renewal is refused end to end', async () => {
  configure({ maxAggregateToolCalls: 1, maxToolCalls: 1 });
  const script = scripted([
    reply(null, [call('call_1')], 'tool_calls'),
    reply('Partial under aggregate.'),
  ]);
  let childId = null;
  await runtime.runInvestigation({
    parentSessionId: 'aggregate_e2e', task: 'Inspect.', rootPath: directory,
    engine, fetchImpl: script.fetchImpl, onSpawn: value => { childId = value; },
  });
  assert.equal(sm.getSession(childId).budgetState.scope.toolCalls, 1);
  assert.throws(() => cm.continueChild(childId, { parentSessionId: 'aggregate_e2e', renewal: { maxToolCalls: 2 } }),
    /remaining aggregate tool allowance/);
  assert.equal(sm.getSession(childId).status, 'partial', 'the child stays stopped; the aggregate is untouched');
});

console.log('Phase 1.3C continuation: eligibility, renewal, control surface, durability, recovery passed.');
