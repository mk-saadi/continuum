'use strict';

// One ledger per child lifetime; one shared counter per parent invocation.
// No global map keyed by chat id: independent parent invocations cannot reset
// or accidentally share a live child's allowance. Nested runtime callers must
// pass the same scope; investigation tools deliberately cannot spawn children.
const { randomUUID } = require('node:crypto');
const policy = require('./budgets');
const settings = require('./budgetSettings');
const { reserveTokens, approximateTokens } = require('../contextBudget');
const { pushActivity } = require('./sessionManager');
const { timeoutReasonOf } = require('./executionDeadline');

class ExecutionBudgetError extends Error {
  constructor(reason) {
    super(`Sub-agent stopped: ${reason}`);
    this.code = 'SUBAGENT_BUDGET_EXCEEDED';
    this.stopReason = reason;
  }
}
function createParentRunBudget(saved = settings.getBudgetSettings()) {
  const custom = saved.mode === 'custom' && saved.maxAggregateToolCalls != null;
  return { id: randomUUID(), toolCalls: 0,
    // null is the explicit unbounded aggregate (no numeric ceiling).
    maxToolCalls: custom
      ? (saved.maxAggregateToolCalls === settings.UNBOUNDED ? null : saved.maxAggregateToolCalls)
      : policy.DEFAULT_AGGREGATE_TOOL_CALLS };
}
async function getExecutionBudget(session, { kind, engine, budgetScope, maxTurns, maxToolCalls } = {}) {
  if (session.budgetState) return session.budgetState;
  for (const [key, value] of Object.entries({ maxTurns, maxToolCalls })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < settings.LIMITS[key].min || value > settings.LIMITS[key].max)) {
      throw new Error(`${key} must be an integer from ${settings.LIMITS[key].min} to ${settings.LIMITS[key].max}.`);
    }
  }
  const saved = settings.getBudgetSettings();
  const context = await policy.resolveEngineContextLength(engine);
  const budgets = policy.resolveTaskBudgets({ kind, engine, settings: saved, contextLength: context.contextLength });
  // Internal options are initial child overrides, never a continuation refill.
  if (maxTurns !== undefined) budgets.maxTurns = maxTurns;
  if (maxToolCalls !== undefined) budgets.maxToolCalls = maxToolCalls;
  const scope = budgetScope ?? session.budgetScope ?? createParentRunBudget(saved);
  // scope.maxToolCalls is a finite ceiling or null (explicit unbounded).
  if (!scope || (scope.maxToolCalls !== null
        && (!Number.isSafeInteger(scope.maxToolCalls) || scope.maxToolCalls < 1 || scope.maxToolCalls > settings.LIMITS.maxAggregateToolCalls.max))
      || !Number.isSafeInteger(scope.toolCalls) || scope.toolCalls < 0) throw new Error('Invalid parent-run budget scope.');
  const state = {
    budgets, contextSource: context.source, ledger: policy.createLedger(),
    toolCalls: 0, blockedCalls: 0, scope,
    // Phase 1.3B time limits, resolved once per child like every other budget:
    // all null under Automatic, finite integers under a Custom selection.
    runtime: policy.resolveRuntimeLimits(saved),
    finalizationAttempted: false, finalizationStopReason: null, overrun: null, seenCalls: new Map(), toolsUsed: new Map(), usage: null,
  };
  session.budgetState = state;
  return state;
}
function totals(state) { return policy.ledgerTotals(state.ledger); }
function stopBeforeRequest(state, payload, measuredInput, measuredWindow) {
  const t = totals(state);
  if (state.overrun) throw new ExecutionBudgetError(state.overrun);
  if (policy.limitReached(state.budgets.maxTurns, t.turns)) throw new ExecutionBudgetError('turn_limit');
  const input = measuredInput ?? policy.estimatePromptTokens(payload.messages, payload.tools);
  // The cumulative input envelope (null = unbounded). A null envelope never
  // blocks; the per-request context window is enforced separately below.
  if (policy.remaining(state.budgets.inputBudget, t.inputTokens) < input) throw new ExecutionBudgetError('input_budget');
  const outputLeft = policy.remaining(state.budgets.outputBudget, t.outputTokens);
  if (outputLeft < policy.MIN_COMPLETION_RESERVE) throw new ExecutionBudgetError('output_budget');
  // Approximation plus uncertainty/output margin is a conservative admission
  // gate, not a provider-reported token measurement.
  const contextInput = measuredInput ?? approximateTokens(payload);
  const window = Math.min(state.budgets.contextLength, measuredWindow ?? state.budgets.contextLength);
  const margin = reserveTokens({ max_tokens: 1 }, window) - 1;
  const ceiling = Math.min(payload.max_tokens, outputLeft, window - contextInput - margin);
  if (ceiling < policy.MIN_COMPLETION_RESERVE) throw new ExecutionBudgetError('context_exhausted');
  return { ...payload, max_tokens: Math.floor(ceiling) };
}
function reserveRequest(state, payload, measured) {
  const input = measured?.method === 'server-template-tokenizer' ? measured.tokens : undefined;
  const bounded = stopBeforeRequest(state, payload, input, measured?.limit);
  const reservedInput = input ?? policy.estimatePromptTokens(bounded.messages, bounded.tools);
  state.ledger.turns++;
  state.ledger.inputEstimated += reservedInput;
  state.ledger.outputReserved += bounded.max_tokens;
  state.ledger.outputUnknownTurns++;
  return { payload: bounded, input: reservedInput, output: bounded.max_tokens, settled: false };
}
function settleRequest(state, reservation, usage) {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;
  // One normalization for every backend: local llama.cpp and OpenAI-compatible
  // cloud both report prompt_tokens/completion_tokens; Anthropic is normalized
  // to that shape by the cloud transport. Absent usage stays null and the
  // reservation remains counted as estimated/reserved rather than a fake zero.
  const { input, output } = policy.normalizeUsage(usage);
  if (input !== null) {
    state.ledger.inputEstimated -= reservation.input;
    state.ledger.inputMeasured += input;
  }
  if (output !== null) {
    state.ledger.outputReserved -= reservation.output;
    state.ledger.outputUnknownTurns--;
    state.ledger.outputMeasured += output;
  }
  if (input !== null || output !== null) {
    state.usage ??= {};
    if (input !== null) state.usage.prompt_tokens = (state.usage.prompt_tokens ?? 0) + input;
    if (output !== null) state.usage.completion_tokens = (state.usage.completion_tokens ?? 0) + output;
    if (state.ledger.inputEstimated === 0 && state.ledger.outputUnknownTurns === 0) {
      state.usage.total_tokens = (state.usage.prompt_tokens ?? 0) + (state.usage.completion_tokens ?? 0);
    } else delete state.usage.total_tokens;
  }
  if (output !== null && output > reservation.output) state.overrun = 'provider_budget_violation';
  else if (policy.remaining(state.budgets.inputBudget, totals(state).inputTokens) < 0) state.overrun = 'input_budget';
}
const responseReservations = new WeakMap();
function requestTracker(state) {
  return {
    prepare: payload => {
      // The guarded transport measures before dispatch. Defer input/context
      // admission until its exact/fallback measurement rather than rejecting
      // an exactly fitting prompt on a larger preliminary estimate.
      if (state.overrun) throw new ExecutionBudgetError(state.overrun);
      if (policy.limitReached(state.budgets.maxTurns, totals(state).turns)) throw new ExecutionBudgetError('turn_limit');
      const left = policy.remaining(state.budgets.outputBudget, totals(state).outputTokens);
      if (left < policy.MIN_COMPLETION_RESERVE) throw new ExecutionBudgetError('output_budget');
      return { ...payload, max_tokens: Math.min(payload.max_tokens, left) };
    },
    beforeRequest: (payload, measured) => reserveRequest(state, payload, measured),
    trackResponse: (response, reservation) => {
      responseReservations.set(response, { state, reservation });
      // JSON is also used by existing context recovery. Count its summary as
      // a real request, without changing its algorithm or transcript adapter.
      const json = response.json.bind(response);
      response.json = async () => { const result = await json(); settleRequest(state, reservation, result?.usage); return result; };
    },
  };
}
function settleResponse(response, usage) {
  const entry = responseReservations.get(response);
  if (entry) settleRequest(entry.state, entry.reservation, usage);
}
function budgetedFetch(fetchImpl, state) {
  if (fetchImpl.subagentBudgetState === state) return fetchImpl;
  const tracker = requestTracker(state);
  const tracked = async (url, options = {}) => {
    if ((options.method ?? 'GET').toUpperCase() !== 'POST' || new URL(url).pathname !== '/v1/chat/completions') return fetchImpl(url, options);
    if (fetchImpl.contextGuarded === true) return fetchImpl(url, { ...options, modelRequestBudget: tracker });
    const reservation = tracker.beforeRequest(JSON.parse(options.body));
    const response = await fetchImpl(url, { ...options, body: JSON.stringify(reservation.payload) });
    tracker.trackResponse(response, reservation);
    return response;
  };
  tracked.subagentBudgetState = state;
  return tracked;
}
function dispatchTool(state, session, name = 'tool') {
  let reason = null;
  if (policy.limitReached(state.budgets.maxToolCalls, state.toolCalls)) reason = 'tool_limit';
  else if (policy.limitReached(state.scope.maxToolCalls, state.scope.toolCalls)) reason = 'aggregate_tool_limit';
  if (reason) { state.blockedCalls++; return reason; }
  // Synchronous compare/increment immediately before dispatch: atomic in the
  // main-process event loop even when multiple child promises are interleaved.
  state.toolCalls++; state.scope.toolCalls++;
  state.toolsUsed.set(name, (state.toolsUsed.get(name) ?? 0) + 1);
  if (state.budgets.maxToolCalls !== null && state.toolCalls === Math.ceil(state.budgets.maxToolCalls * .8)) {
    pushActivity(session, { type: 'note', text: `Approaching tool budget: ${state.toolCalls}/${state.budgets.maxToolCalls}.` });
  }
  return null;
}
function exhaustion(state) {
  if (state.overrun) return state.overrun;
  if (policy.limitReached(state.budgets.maxToolCalls, state.toolCalls)) return 'tool_limit';
  if (policy.limitReached(state.scope.maxToolCalls, state.scope.toolCalls)) return 'aggregate_tool_limit';
  if (policy.limitReached(state.budgets.maxTurns, totals(state).turns)) return 'turn_limit';
  return null;
}
// A timeout is its own terminal status: the child stopped because a wall-clock
// limit elapsed — never a success and never a plain failure — while any
// findings produced before the limit are still reported. `request_timeout` is
// the single-request timeout; both map to the `timed_out` status.
const TIMEOUT_STATUS_REASONS = new Set(['timed_out', 'request_timeout']);
function outcome(state, { output = '', stopReason = 'completed', findings = false, detail = null } = {}) {
  const complete = stopReason === 'completed';
  const status = complete ? 'completed'
    : TIMEOUT_STATUS_REASONS.has(stopReason) ? 'timed_out'
    : findings ? 'partial' : 'failed';
  const header = status === 'timed_out' ? `[Sub-agent timed out: ${stopReason}]` : `[Sub-agent ${status}: ${stopReason}]`;
  return { output: complete ? output : `${header}\n${output || 'No usable findings were produced.'}${detail ? `\n${detail}` : ''}`,
    outcome: status, stopReason, usage: state.usage, accounting: { ...totals(state),
      toolCalls: state.toolCalls, blockedCalls: state.blockedCalls,
      aggregateToolCalls: state.scope.toolCalls, aggregateLimit: state.scope.maxToolCalls,
      parentRunId: state.scope.id, finalizationAttempted: state.finalizationAttempted,
      finalizationStopReason: state.finalizationStopReason, effective: { ...state.budgets }, runtime: { ...state.runtime }, contextSource: state.contextSource } };
}
function resultError(result) {
  const error = new Error(result.output);
  error.stopReason = result.stopReason; error.subagentResult = result;
  return error;
}
function reasonOf(error) {
  if (error?.stopReason) return error.stopReason;
  const timeout = timeoutReasonOf(error);
  if (timeout) return timeout;
  if (error?.code === 'CONTEXT_BUDGET_EXCEEDED') return 'context_exhausted';
  return 'runtime_error';
}
module.exports = { ExecutionBudgetError, createParentRunBudget, getExecutionBudget, totals,
  stopBeforeRequest, budgetedFetch, settleResponse, dispatchTool, exhaustion, outcome, reasonOf, resultError,
  // Unbounded-aware limit helpers, re-exported so the agent loop and child
  // context recovery share one definition of "limit reached"/"remaining".
  limitReached: policy.limitReached, remaining: policy.remaining };
