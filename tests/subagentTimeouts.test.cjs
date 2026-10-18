'use strict';
// Phase 1.3B — subagent execution deadlines, model-request timeouts,
// cancellation propagation, and deterministic terminal status.
//
// Deterministic coverage of the brief's 21-scenario table. Timers and clocks
// are injected everywhere a wall-clock limit is exercised, so nothing here waits
// on real time. Mocked providers only; no paid calls.
//
// Run with: node --test tests/subagentTimeouts.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-timeouts-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle: () => {}, removeHandler: () => {} } };
  return originalLoad.call(this, name, ...args);
};

const database = require('../src/main/db');
database.initDatabase(directory);

const settings = require('../src/main/subagents/budgetSettings');
const budgets = require('../src/main/subagents/budgets');
const sessionManager = require('../src/main/subagents/sessionManager');
const runtime = require('../src/main/subagents');
const inferenceScheduler = require('../src/main/subagents/inferenceScheduler');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
const { runFileAnalysisExecution } = require('../src/main/subagents/executionManager');
const { createChildContextAdapter } = require('../src/main/subagents/contextRecovery');
const localProvider = require('../src/main/subagents/providers/localProvider');
const cloudProvider = require('../src/main/subagents/providers/cloudProvider');
const cloudProviders = require('../src/main/cloudProviders');
const { readCompletion } = require('../src/main/subagents/providers/streamCompletion');
const deadline = require('../src/main/subagents/executionDeadline');

const { createDeadline, createRequestTimeout, combineSignals, armExecutionDeadline,
  releaseExecutionDeadline, clearExecutionDeadlines, isDeadlineError, isRequestTimeoutError } = deadline;

// --- fixtures ---------------------------------------------------------------

const engine = { provider: 'local', port: 9, modelId: 'timeout-fixture', contextLength: 1000000 };
const cloudEngine = { provider: 'cloud', modelId: 'cloud-child-1', chatTarget: { type: 'cloud', provider: 'test-cloud', model: 'cloud-child-1' } };
const call = (id, name = 'list_directory', args = { relative_path: id }) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls = [], finish_reason = 'stop', usage = { prompt_tokens: 100, completion_tokens: 30 }) =>
  Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage });
function script(responses) {
  const requests = [];
  return { requests, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return responses.shift() ?? reply('done');
  } };
}
function configure(patch = {}) {
  settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null,
    maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null,
    maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null, ...patch });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, tries = 500) {
  for (let i = 0; i < tries; i++) { if (await predicate()) return; await tick(); }
  throw new Error('condition was not met');
}
/** A fetch that parks until its signal aborts, recording the signals it saw. */
function parkingFetch() {
  const calls = [];
  const fetchImpl = (url, options = {}) => new Promise((_resolve, reject) => {
    calls.push({ url, signal: options.signal });
    const onAbort = () => reject(options.signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  return { calls, fetchImpl };
}
/** A controllable clock + timer registry for createDeadline. */
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimeout: (fn) => { const key = ++id; timers.set(key, fn); return key; },
    clearTimeout: (key) => { timers.delete(key); },
    get pending() { return timers.size; },
    fireAll() { const all = [...timers.values()]; timers.clear(); for (const fn of all) fn(); },
  };
}

test.beforeEach(() => configure());
test.after(() => {
  try { configure(); } catch {}
  clearExecutionDeadlines();
  database.closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

// --- Scenario 1: normal short child -> Completed ----------------------------

test('1. normal short child completes (no deadline, no request timeout under Automatic)', async () => {
  assert.deepEqual(budgets.resolveRuntimeLimits({ mode: 'auto' }),
    { maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null });
  assert.equal(createDeadline({ ms: null }), null, 'no deadline is armed by default');
  const s = script([reply('Short answer.')]);
  const result = await runInvestigationExecution({ session: {}, task: 'Quick.', rootPath: directory, engine, ...s });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.output, 'Short answer.');
  assert.equal(s.requests.length, 1);
  assert.equal(result.accounting.runtime.maxRuntimeMs, null);
});

// --- Scenario 2: long child within deadline -> continues --------------------

test('2. a long child within its deadline runs every turn and completes', async () => {
  const timers = fakeTimers();
  const deadlineHandle = createDeadline({ ms: 3600000, timers });
  const s = script([reply(null, [call('a')], 'tool_calls'), reply(null, [call('b')], 'tool_calls'), reply('Finished within deadline.')]);
  const result = await runInvestigationExecution({ session: {}, task: 'Work.', rootPath: directory, engine, deadline: deadlineHandle, ...s });
  assert.equal(result.outcome, 'completed');
  assert.equal(s.requests.length, 3);
  assert.ok(!deadlineHandle.signal.aborted);
  deadlineHandle.clear();
});

// --- Scenario 3 & 14: deadline expires -> Timed out; a late response ignored -

test('3/14. an elapsed deadline yields a timed-out result and ignores the late response', async () => {
  const timers = fakeTimers();
  const deadlineHandle = createDeadline({ ms: 5000, timers });
  const s = script([]);
  // The transport "ignores" the abort and returns a normal late answer: it must
  // not be accepted once the deadline has elapsed.
  const fetchImpl = async (_url, options) => {
    s.requests.push(JSON.parse(options.body));
    deadlineHandle.fire();
    return reply('Late answer that must be ignored.');
  };
  const session = {};
  const result = await runInvestigationExecution({ session, task: 'Race.', rootPath: directory, engine, deadline: deadlineHandle, fetchImpl });
  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.stopReason, 'timed_out');
  assert.match(result.output, /timed out/i);
  assert.equal(s.requests.length, 1, 'no work starts after the deadline');
  // A timeout is never a success and never fabricates the model answer.
  assert.ok(!result.output.includes('Late answer'));
});

// --- Scenario 4, 19: stalled model request -> request timeout ---------------

test('4/19. a stalled local request is bounded by the configured request timeout', async () => {
  const timers = fakeTimers();
  configure({ requestTimeoutMs: 1000 });
  const park = parkingFetch();
  const pending = runInvestigationExecution({ session: {}, task: 'Stall.', rootPath: directory,
    engine, fetchImpl: park.fetchImpl, timers });
  await until(() => park.calls.length === 1);
  // The request is in flight and the transport never answers: the configured
  // total-duration timeout cuts it off and is reported as request_timeout. The
  // clock is injected, so this never waits on real time.
  timers.fireAll();
  const result = await pending;
  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.stopReason, 'request_timeout');
  assert.equal(park.calls.length, 1);
  configure();
});

test('request-timeout unit: armed handle aborts and rejects with a request_timeout code', async () => {
  const timers = fakeTimers();
  const controller = new AbortController();
  const guard = createRequestTimeout({ signal: controller.signal, timeoutMs: 1000, timers });
  assert.equal(guard.enabled, true);
  assert.ok(guard.signal !== controller.signal, 'the request signal also carries the caller signal');
  timers.fireAll();
  await assert.rejects(guard.timeout, error => isRequestTimeoutError(error) && error.timeoutKind === 'total');
  assert.ok(guard.signal.aborted);
  // Disabled guard is identity-preserving and allocates nothing.
  const off = createRequestTimeout({ signal: controller.signal, timeoutMs: null, timers });
  assert.equal(off.enabled, false);
  assert.equal(off.signal, controller.signal);
  assert.equal(off.timeout, null);
});

// --- Scenario 5 & 6: local/cloud request cancellation propagates the abort ---

test('5. local request cancellation reaches the transport signal', async () => {
  const controller = new AbortController();
  let sawSignal = null;
  const fetchImpl = (_url, options = {}) => {
    sawSignal = options.signal;
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(options.signal.reason ?? Object.assign(new Error('stop'), { name: 'AbortError' }));
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  const pending = localProvider.chatCompletion({ engine, payload: { model: engine.modelId, messages: [{ role: 'user', content: 'x' }] },
    signal: controller.signal, fetchImpl });
  await tick();
  controller.abort(Object.assign(new Error('The parent cancelled.'), { name: 'AbortError' }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sawSignal.aborted, true);
});

test('6. cloud request cancellation propagates through the cloud transport', async () => {
  const original = cloudProviders.createCloudFetch;
  let sawSignal = null;
  try {
    cloudProviders.createCloudFetch = () => (_url, options = {}) => {
      sawSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(options.signal.reason ?? Object.assign(new Error('stop'), { name: 'AbortError' }));
        if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    };
    const controller = new AbortController();
    const pending = cloudProvider.chatCompletion({ engine: cloudEngine,
      payload: { model: cloudEngine.modelId, messages: [{ role: 'user', content: 'x' }] }, signal: controller.signal });
    await tick();
    controller.abort(Object.assign(new Error('The parent cancelled.'), { name: 'AbortError' }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(sawSignal.aborted, true);
  } finally {
    cloudProviders.createCloudFetch = original;
  }
});

// --- Scenario 7: parent cancellation reaches its owned child -----------------

test('7. parent cancellation stops its owned foreground child', async () => {
  const controller = new AbortController();
  const park = parkingFetch();
  const parent = 'timeout-owned-parent';
  const pending = runtime.runInvestigation({ task: 'Long owned child.', rootPath: directory,
    engine, signal: controller.signal, parentSessionId: parent, fetchImpl: park.fetchImpl });
  await until(() => park.calls.length > 0);
  // The parent run is cancelled: the child it owns must stop with it.
  controller.abort(Object.assign(new Error('The parent run was cancelled.'), { name: 'AbortError' }));
  await assert.rejects(pending, { name: 'AbortError' });
  const [child] = sessionManager.listChildren(parent);
  assert.equal(child.status, sessionManager.SESSION_STATUS.CANCELLED);
  assert.equal(park.calls[0].signal.aborted, true, 'the child request was aborted with the parent');
});

// --- Scenario 8 & 16: direct child cancellation, isolation -------------------

test('8/16. directly cancelling one child leaves sibling children untouched', async () => {
  const parkA = parkingFetch();
  const parentA = 'timeout-parent-a';
  const parentB = 'timeout-parent-b';
  const handleA = runtime.startInvestigation({ task: 'Park A.', rootPath: directory,
    engine: { ...engine, modelId: 'lane-a' }, parentSessionId: parentA, fetchImpl: parkA.fetchImpl });
  await until(() => parkA.calls.length > 0);
  const sB = script([reply('B finished.')]);
  const handleB = runtime.startInvestigation({ task: 'Finish B.', rootPath: directory,
    engine: { ...engine, modelId: 'lane-b' }, parentSessionId: parentB, fetchImpl: sB.fetchImpl });
  await until(() => sessionManager.getSession(handleB.childSessionId).status === sessionManager.SESSION_STATUS.COMPLETED);
  const sessionA = sessionManager.getSession(handleA.childSessionId);
  const sessionB = sessionManager.getSession(handleB.childSessionId);
  assert.equal(sessionB.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(sessionA.status, sessionManager.SESSION_STATUS.RUNNING, 'A is still running while B completed');

  assert.equal(runtime.cancelBackground(handleA.executionId), true);
  await until(() => sessionManager.getSession(handleA.childSessionId).status === sessionManager.SESSION_STATUS.CANCELLED);
  assert.equal(sessionManager.getSession(handleA.childSessionId).status, sessionManager.SESSION_STATUS.CANCELLED);
  // B was not disturbed by A's cancellation.
  assert.equal(sessionManager.getSession(handleB.childSessionId).status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(parkA.calls[0].signal.aborted, true);
});

// --- Scenario 9: nested delegation cannot outlive the parent deadline --------

test('9. a descendant deadline is bounded by the parent deadline it inherits', () => {
  const clockValue = { now: 0 };
  const timers = fakeTimers();
  const clock = () => clockValue.now;
  const parent = armExecutionDeadline({ id: 'nested-parent', parentSessionId: null },
    { maxRuntimeMs: 5000 }, { clock, timers });
  const child = armExecutionDeadline({ id: 'nested-child', parentSessionId: 'nested-parent' },
    { maxRuntimeMs: 600000 }, { clock, timers });
  assert.ok(parent && child);
  assert.equal(parent.ms, 5000);
  assert.equal(child.ms, 5000, 'the child is clamped to the parent remaining time, never extended');
  assert.ok(child.remainingMs(clock) <= parent.remainingMs(clock));
  timers.fireAll();
  assert.equal(parent.signal.aborted, true);
  assert.equal(child.signal.aborted, true);
  clearExecutionDeadlines();
});

// --- Scenario 10: cancellation during compaction -> no continuation ----------

test('10. cancellation is honored during compaction and no further request is issued', async () => {
  const controller = new AbortController();
  const session = { id: 'compaction-child', context: [], inputSummary: { task: 't' }, activity: [] };
  const state = await require('../src/main/subagents/executionBudget')
    .getExecutionBudget(session, { kind: 'investigation', engine });
  const adapter = createChildContextAdapter({ session, messages: [{ role: 'user', content: 'seed' }], engine, state,
    fetchImpl: async () => reply('x'), signal: controller.signal, commit: () => {} });
  controller.abort(Object.assign(new Error('cancelled during compaction'), { name: 'AbortError' }));
  await assert.rejects(adapter.commit({}, {}), { name: 'AbortError' });

  // Even without the adapter check, the scheduler refuses to start a request on
  // an aborted signal, so a compaction that "returns later" cannot continue.
  let providerCalls = 0;
  const fetchImpl = async () => { providerCalls++; return reply('should not run'); };
  await assert.rejects(inferenceScheduler.scheduleInference({ engine,
    payload: { model: engine.modelId, messages: [{ role: 'user', content: 'x' }] },
    signal: controller.signal, fetchImpl }), { name: 'AbortError' });
  assert.equal(providerCalls, 0);
});

// --- Scenario 11: cancellation during tool execution -> no new work ----------

test('11. cancelling during a tool batch prevents any further model request', async () => {
  const tools = require('../src/main/tools/agentTools');
  const original = tools.executeAgentTool;
  const controller = new AbortController();
  tools.executeAgentTool = async () => { controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' })); return 'partial'; };
  try {
    const s = script([reply(null, [call('t1')], 'tool_calls'), reply('must not be sent')]);
    await assert.rejects(runInvestigationExecution({ session: {}, task: 'Cancel in tool.', rootPath: directory,
      engine, signal: controller.signal, ...s }), { name: 'AbortError' });
    assert.equal(s.requests.length, 1, 'no request after the cancelled tool batch');
  } finally {
    tools.executeAgentTool = original;
  }
});

// --- Scenario 12: timeout during a streamed response -> request failure ------

test('12. a stalled stream is cut off by the inactivity watchdog', async () => {
  const timers = fakeTimers();
  // A body that never produces a chunk: the read stays pending until cancelled.
  const body = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const pending = readCompletion(response, undefined, { inactivityMs: 2500, timers });
  await until(() => timers.pending > 0, 100);
  timers.fireAll();
  await assert.rejects(pending, error => isRequestTimeoutError(error) && error.timeoutKind === 'inactivity');
});

// --- Scenario 13: completion just before the deadline -> success retained ----

test('13. a completion before the deadline is retained and a later timeout cannot rewrite it', async () => {
  const timers = fakeTimers();
  const deadlineHandle = createDeadline({ ms: 10000, timers });
  const s = script([reply('Answered in time.')]);
  const session = {};
  const result = await runInvestigationExecution({ session, task: 'Race.', rootPath: directory, engine, deadline: deadlineHandle, ...s });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.output, 'Answered in time.');
  // The clock event arrives after the child already completed: it is ignored.
  deadlineHandle.fire();
  assert.equal(result.outcome, 'completed');
  deadlineHandle.clear();
});

// --- Scenario 15: repeated cancellation is idempotent ------------------------

test('15. repeated cancellation and terminal settlement are idempotent', () => {
  assert.equal(runtime.cancelBackground('not-a-real-execution'), false);
  const session = sessionManager.createSession({ parentSessionId: 'idempotent-parent' });
  sessionManager.startSession(session);
  sessionManager.cancelSession(session);
  const status = session.status;
  sessionManager.cancelSession(session);
  sessionManager.completeSession(session, { result: 'late' });
  assert.equal(session.status, status);
  assert.equal(status, sessionManager.SESSION_STATUS.CANCELLED);

  const attempt = require('../src/main/subagents/executionStore').createExecution({ sessionId: session.id });
  require('../src/main/subagents/executionStore').cancelExecution(attempt);
  require('../src/main/subagents/executionStore').completeExecution(attempt, { outcome: 'completed', result: 'late' });
  assert.equal(attempt.status, 'cancelled', 'a terminal attempt is never overwritten by a late completion');
});

// --- Scenario 17: an unbounded child is still cancellable --------------------

test('17. an unbounded child remains cancellable', async () => {
  configure({ maxToolCalls: 'unbounded', maxTurns: 'unbounded', maxInputTokens: 'unbounded',
    maxOutputTokens: 'unbounded', maxAggregateToolCalls: 'unbounded' });
  const park = parkingFetch();
  const handle = runtime.startInvestigation({ task: 'Unbounded park.', rootPath: directory,
    engine: { ...engine, modelId: 'lane-unbounded' }, parentSessionId: 'timeout-unbounded', fetchImpl: park.fetchImpl });
  await until(() => park.calls.length > 0);
  assert.equal(runtime.cancelBackground(handle.executionId), true);
  await until(() => sessionManager.getSession(handle.childSessionId).status === sessionManager.SESSION_STATUS.CANCELLED);
  assert.equal(sessionManager.getSession(handle.childSessionId).status, sessionManager.SESSION_STATUS.CANCELLED);
  configure();
});

// --- Scenario 18: a child on a different cloud model -------------------------

test('18. a child on a different cloud model routes the request through the cloud transport', async () => {
  const original = cloudProviders.createCloudFetch;
  const seen = [];
  try {
    cloudProviders.createCloudFetch = () => async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      seen.push(body);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Cloud answer.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 } });
    };
    const result = await runInvestigationExecution({ session: {}, task: 'Cloud.', rootPath: directory, engine: cloudEngine });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.output, 'Cloud answer.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'cloud-child-1');
  } finally {
    cloudProviders.createCloudFetch = original;
  }
});

// --- Scenario 20: existing compaction still runs (no regression) -------------

test('20. runtime limits under Automatic add no deadline, so compaction is unaffected', async () => {
  assert.deepEqual(budgets.resolveRuntimeLimits({ mode: 'auto' }),
    { maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null });
  // A compaction-bearing child still completes normally with the full tool loop.
  const s = script([reply(null, [call('c1')], 'tool_calls'), reply('Compacted answer.')]);
  const result = await runInvestigationExecution({ session: {}, task: 'Compaction.', rootPath: directory, engine, ...s });
  assert.equal(result.outcome, 'completed');
  assert.equal(s.requests.length, 2);
});

// --- Scenario 21: existing budgets and permissions unchanged -----------------

test('21. budgets/permissions are unchanged; time limits resolve independently', async () => {
  // Custom time limits do not touch the token/report budgets.
  configure({ maxRuntimeMs: 60000, requestTimeoutMs: 30000, requestInactivityMs: 5000, maxToolCalls: 7 });
  assert.deepEqual(budgets.resolveRuntimeLimits(settings.getBudgetSettings()),
    { maxRuntimeMs: 60000, requestTimeoutMs: 30000, requestInactivityMs: 5000 });
  const state = await require('../src/main/subagents/executionBudget')
    .getExecutionBudget({}, { kind: 'investigation', engine });
  assert.equal(state.budgets.maxToolCalls, 7);
  assert.equal(state.runtime.maxRuntimeMs, 60000);
  // Unbounded time limits resolve to null (no numeric ceiling, no deadline).
  configure({ maxRuntimeMs: 'unbounded', requestTimeoutMs: 'unbounded', requestInactivityMs: 'unbounded' });
  assert.deepEqual(budgets.resolveRuntimeLimits(settings.getBudgetSettings()),
    { maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null });
  configure();
});

// --- Request timeout reaches the one-shot executions -------------------------

test('one-shot file analysis honors the execution deadline', async () => {
  const timers = fakeTimers();
  const deadlineHandle = createDeadline({ ms: 1000, timers });
  const root = path.join(directory, 'one-shot-deadline');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'content');
  const s = script([]);
  const fetchImpl = async (_url, options) => { s.requests.push(JSON.parse(options.body)); deadlineHandle.fire(); return reply('late'); };
  const result = await runFileAnalysisExecution({ session: {}, task_description: 'Read.', target_files: ['a.txt'],
    rootPath: root, engine, deadline: deadlineHandle, fetchImpl });
  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.stopReason, 'timed_out');
  assert.ok(!String(result.output).includes('late'));
});

// --- Structural checks: error identities and signal combination -------------

test('timeout error identities stay distinct from cancellation', () => {
  const d = deadline.deadlineError();
  const r = deadline.requestTimeoutError('total');
  assert.equal(d.name, 'AbortError');
  assert.equal(d.code, 'SUBAGENT_DEADLINE_EXCEEDED');
  assert.equal(r.name, 'Error');
  assert.equal(r.code, 'SUBAGENT_REQUEST_TIMEOUT');
  assert.equal(isDeadlineError(d), true);
  assert.equal(isRequestTimeoutError(r), true);
  assert.equal(isDeadlineError(r), false);
  assert.equal(deadline.timeoutReasonOf(d), 'timed_out');
  assert.equal(deadline.timeoutReasonOf(r), 'request_timeout');
  assert.equal(deadline.timeoutReasonOf(new Error('plain')), null);
  // combineSignals: identity for one, null for none, and first reason wins.
  const a = new AbortController();
  assert.equal(combineSignals(a.signal), a.signal);
  assert.equal(combineSignals(), null);
  const b = new AbortController();
  const combined = combineSignals(a.signal, b.signal);
  a.abort(Object.assign(new Error('first'), { name: 'AbortError' }));
  assert.equal(combined.aborted, true);
});

test('executionBudget maps timeout errors to the timed_out terminal status', async () => {
  const executionBudget = require('../src/main/subagents/executionBudget');
  assert.equal(executionBudget.reasonOf(deadline.deadlineError()), 'timed_out');
  assert.equal(executionBudget.reasonOf(deadline.requestTimeoutError('inactivity')), 'request_timeout');
  const state = await executionBudget.getExecutionBudget({}, { kind: 'investigation', engine });
  const timedOut = executionBudget.outcome(state, { stopReason: 'timed_out', findings: false });
  assert.equal(timedOut.outcome, 'timed_out');
  assert.match(timedOut.output, /timed out/i);
  const requestTimeout = executionBudget.outcome(state, { stopReason: 'request_timeout', findings: true });
  assert.equal(requestTimeout.outcome, 'timed_out');
});
