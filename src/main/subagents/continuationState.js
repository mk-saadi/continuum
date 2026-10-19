'use strict';

// Phase 1.3C — continuation eligibility, allowance accounting, and durable
// continuation state.
//
// Pure functions only: no runtime maps, no I/O. The in-memory control surface
// (./continuationManager.js) and the persistence layer (./persistence.js) share
// this one definition of "may this child continue, and under what conditions".
// Keeping the rules here — rather than sprinkled across the settlement paths —
// is what makes them testable and impossible to bypass.
//
// The central rule the audit identified as missing: a child that stopped
// because a *configured allowance* ran out (tool calls / requests / tokens) is
// NOT finished. It is `partial`/`failed` in the lifecycle vocabulary, but it is
// the single most important continuation case, and it must not be treated like
// a cancellation or a failure with uncertain side effects.

// Budget-derived stop reasons: the legitimate, renewable case.
const BUDGET_STOP_REASONS = Object.freeze(new Set([
  'tool_limit', 'turn_limit', 'input_budget', 'output_budget',
]));

// Stops a renewal cannot fix. The shared aggregate belongs to the parent
// invocation (a child cannot renew it), the context is irreducible, or the
// provider/runtime rendered a verdict. These are never offered a renewal.
const NON_RENEWABLE_STOP_REASONS = Object.freeze(new Set([
  'aggregate_tool_limit', 'context_exhausted', 'compaction_failed',
  'provider_budget_violation', 'provider_error', 'runtime_error',
  'malformed_response', 'empty_response', 'no_progress',
]));

// Machine-readable eligibility classes. A caller switches on this; human
// detail lives in `detail` for the UI.
const ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',
  NEEDS_RENEWAL: 'needs_renewal',
  NEEDS_EXPLICIT_ACTION: 'needs_explicit_action',
  NOT_ELIGIBLE: 'not_eligible',
});

function result(partial) {
  return {
    eligibility: partial.eligibility,
    eligible: partial.eligibility === ELIGIBILITY.ELIGIBLE || partial.eligibility === ELIGIBILITY.NEEDS_RENEWAL
      || partial.eligibility === ELIGIBILITY.NEEDS_EXPLICIT_ACTION,
    requiresRenewal: partial.eligibility === ELIGIBILITY.NEEDS_RENEWAL,
    requiresExplicitAction: partial.eligibility === ELIGIBILITY.NEEDS_EXPLICIT_ACTION,
    recoveryRequired: partial.recoveryRequired === true,
    reason: partial.reason,
    detail: partial.detail ?? null,
  };
}

function isBudgetStopReason(reason) {
  return BUDGET_STOP_REASONS.has(reason);
}

// A transcript is at a protocol-safe boundary when every assistant tool_calls
// batch has its matching tool results and the history never ends on an
// unanswered assistant tool call. The agent loop already commits only here;
// this is the independent verification that durable state needs before it may
// advertise resumability. An unsafe prefix means an external side effect may
// have been left in flight, so the child is marked recovery-required instead of
// silently replayed.
function isSafeBoundary(messages) {
  if (!Array.isArray(messages)) return false;
  const pending = new Set();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (pending.size) return false; // a previous batch was never answered
      for (const call of message.tool_calls) pending.add(call?.id ?? null);
    } else if (message.role === 'tool') {
      pending.delete(message.tool_call_id ?? null);
    }
  }
  return pending.size === 0;
}

/**
 * The single continuation-eligibility decision. `session` is the child
 * session record; `pendingContinuation` is the driver's "unfinished turn" flag
 * (an interrupted turn whose instruction is already in the context).
 *
 * Rules (Phase 1.3C Step 1):
 *   completed   -> not eligible unless there is queued/outstanding work
 *   interrupted -> eligible; explicit resume required (existing behavior)
 *   partial     -> budget stop: needs renewal; other valid reason: explicit
 *   failed      -> budget stop: needs renewal; timed-out-ish: explicit; else no
 *   timed_out   -> explicit action required AND a new/valid deadline
 *   cancelled   -> explicit user action + safety review required
 *   running/created -> in progress (not a stop)
 * An unsafe transcript boundary overrides every "eligible" verdict: the child
 * is marked recovery-required and refused automatic continuation.
 */
function evaluateContinuation(session, { pendingContinuation = false } = {}) {
  const status = session?.status ?? null;
  const stopReason = session?.stopReason ?? null;
  const messages = session?.rawContext ?? session?.context;
  const safeBoundary = Array.isArray(messages) ? isSafeBoundary(messages) : true;
  const inbox = Array.isArray(session?.inbox) ? session.inbox.length : 0;
  const recovery = (reason, detail) => result({
    eligibility: ELIGIBILITY.NOT_ELIGIBLE, reason, detail, recoveryRequired: true,
  });
  const notEligible = (reason, detail) => result({ eligibility: ELIGIBILITY.NOT_ELIGIBLE, reason, detail });

  if (status === 'running' || status === 'created' || status === 'waiting') {
    return notEligible('in_progress', 'The child still has active or queued work.');
  }
  if (status === 'completed') {
    if (!pendingContinuation && inbox === 0) {
      return notEligible('already_completed', 'The child already reported a final answer.');
    }
    return safeBoundary
      ? result({ eligibility: ELIGIBILITY.NEEDS_EXPLICIT_ACTION, reason: 'completed_with_pending',
        detail: 'A completed child with queued work continues by draining its inbox.' })
      : recovery('unsafe_boundary', 'The transcript is not at a committed-safe boundary.');
  }
  if (status === 'interrupted') {
    return safeBoundary
      ? result({ eligibility: ELIGIBILITY.NEEDS_EXPLICIT_ACTION, reason: 'interrupted',
        detail: 'The turn was stopped on purpose; an explicit resume re-drives it.' })
      : recovery('unsafe_boundary', 'The interrupted transcript is not at a safe boundary.');
  }
  if (status === 'timed_out') {
    return safeBoundary
      ? result({ eligibility: ELIGIBILITY.NEEDS_EXPLICIT_ACTION, reason: 'timed_out',
        detail: 'Timed-out children resume only on explicit action and with a valid deadline.' })
      : recovery('unsafe_boundary', 'The timed-out transcript is not at a safe boundary.');
  }
  if (status === 'cancelled') {
    return safeBoundary
      ? result({ eligibility: ELIGIBILITY.NEEDS_EXPLICIT_ACTION, reason: 'cancelled',
        detail: 'Cancelled children resume only after explicit user action and a safety review.' })
      : recovery('unsafe_boundary', 'The cancelled transcript is not at a safe boundary.');
  }
  if (status === 'partial' || status === 'failed') {
    if (!safeBoundary) {
      return recovery('unsafe_boundary',
        'A tool operation may have been left in flight; the transcript is not safe to replay.');
    }
    if (isBudgetStopReason(stopReason)) {
      return result({ eligibility: ELIGIBILITY.NEEDS_RENEWAL, reason: 'budget_exhausted',
        detail: `Stopped at the configured ${stopReason}; an explicit renewal is required to continue.` });
    }
    if (NON_RENEWABLE_STOP_REASONS.has(stopReason)) {
      return notEligible(`not_renewable:${stopReason}`,
        'This stop reason is not resolvable by additional budget.');
    }
    if (status === 'failed') {
      return notEligible('uncertain_failure',
        'The child failed with uncertain side effects and must not be replayed automatically.');
    }
    return result({ eligibility: ELIGIBILITY.NEEDS_EXPLICIT_ACTION, reason: 'partial_incomplete',
      detail: 'The child stopped with findings but without a budget stop reason.' });
  }
  return notEligible('unknown_status', `Status "${String(status)}" is not continuable.`);
}

function ledgerTotals(ledger) {
  const l = ledger ?? {};
  const outputReserved = l.outputReserved ?? 0;
  return {
    turns: l.turns ?? 0,
    inputTokens: (l.inputMeasured ?? 0) + (l.inputEstimated ?? 0),
    outputTokens: (l.outputMeasured ?? 0) + outputReserved,
    outputMeasured: l.outputMeasured ?? 0,
    outputReserved,
    reasoningTokens: l.reasoningMeasured ?? 0,
    reasoningMeasured: l.reasoningMeasured ?? 0,
    visibleOutputTokens: Math.max(0, (l.outputMeasured ?? 0) - (l.reasoningMeasured ?? 0)),
  };
}

function delta(original, current) {
  if (original === undefined || original === null) return null;
  if (current === null) return null; // unbounded is not a numeric addition
  if (!Number.isFinite(original) || !Number.isFinite(current)) return null;
  return current - original;
}

function remainingOf(limit, used) {
  return limit === null || limit === undefined ? null : limit - used;
}

/**
 * Distinguish original allowance / consumed / granted / current total /
 * remaining / aggregate, so `maxToolCalls` never ambiguously means both an
 * original ceiling and a reset per-attempt counter (Phase 1.3C Step 3).
 */
function summarizeAllowance(budgetState) {
  if (!budgetState) return null;
  const budgets = budgetState.budgets ?? {};
  const totals = ledgerTotals(budgetState.ledger);
  const scope = budgetState.scope ?? {};
  const original = budgetState.original ?? {
    maxTurns: budgets.maxTurns ?? null, maxToolCalls: budgets.maxToolCalls ?? null,
    inputBudget: budgets.inputBudget ?? null, outputBudget: budgets.outputBudget ?? null,
  };
  const current = {
    maxTurns: budgets.maxTurns ?? null, maxToolCalls: budgets.maxToolCalls ?? null,
    inputBudget: budgets.inputBudget ?? null, outputBudget: budgets.outputBudget ?? null,
  };
  return {
    original: { ...original },
    granted: {
      maxTurns: delta(original.maxTurns, current.maxTurns),
      maxToolCalls: delta(original.maxToolCalls, current.maxToolCalls),
      inputBudget: delta(original.inputBudget, current.inputBudget),
      outputBudget: delta(original.outputBudget, current.outputBudget),
    },
    current,
    consumed: {
      turns: totals.turns, toolCalls: budgetState.toolCalls ?? 0,
      inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
      aggregateToolCalls: scope.toolCalls ?? 0,
    },
    remaining: {
      maxTurns: remainingOf(current.maxTurns, totals.turns),
      maxToolCalls: remainingOf(current.maxToolCalls, budgetState.toolCalls ?? 0),
      inputBudget: remainingOf(current.inputBudget, totals.inputTokens),
      outputBudget: remainingOf(current.outputBudget, totals.outputTokens),
    },
    aggregate: { limit: scope.maxToolCalls ?? null, consumed: scope.toolCalls ?? 0 },
    renewals: Array.isArray(budgetState.renewals)
      ? budgetState.renewals.map(entry => ({ ...entry }))
      : [],
  };
}

// --- Durable serialization --------------------------------------------------

function serializeBudgetState(state) {
  if (!state || typeof state !== 'object') return null;
  const budgets = state.budgets ?? {};
  const original = state.original ?? {
    maxTurns: budgets.maxTurns ?? null, maxToolCalls: budgets.maxToolCalls ?? null,
    inputBudget: budgets.inputBudget ?? null, outputBudget: budgets.outputBudget ?? null,
  };
  return {
    version: 1,
    budgets: { ...budgets },
    original: { ...original },
    renewals: Array.isArray(state.renewals) ? state.renewals.map(entry => ({ ...entry })) : [],
    ledger: { ...(state.ledger ?? {}) },
    toolCalls: state.toolCalls ?? 0,
    blockedCalls: state.blockedCalls ?? 0,
    usage: state.usage ?? null,
    runtime: state.runtime ? { ...state.runtime } : null,
    contextSource: state.contextSource ?? null,
    scopeId: state.scope?.id ?? null,
    // Phase 1.4: the shared per-invocation aggregate is not itself durable, but
    // its ceiling and the consumption reached at the last safe boundary are
    // persisted so recovery enforces the *original* finite aggregate instead of
    // silently granting a fresh one.
    scope: state.scope ? {
      id: state.scope.id ?? null,
      toolCalls: Number.isSafeInteger(state.scope.toolCalls) && state.scope.toolCalls >= 0 ? state.scope.toolCalls : 0,
      maxToolCalls: state.scope.maxToolCalls === null || state.scope.maxToolCalls === undefined
        ? null : state.scope.maxToolCalls,
    } : null,
  };
}

function restoreScope(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { id: null, toolCalls: 0, maxToolCalls: null };
  return {
    id: typeof snapshot.id === 'string' ? snapshot.id : null,
    toolCalls: Number.isSafeInteger(snapshot.toolCalls) && snapshot.toolCalls >= 0 ? snapshot.toolCalls : 0,
    maxToolCalls: snapshot.maxToolCalls === null || snapshot.maxToolCalls === undefined ? null : snapshot.maxToolCalls,
  };
}

// Rebuild the live ledger from persisted state. Per-child consumption, allowance
// and renewal history are preserved verbatim. The shared aggregate is rebuilt
// from the persisted snapshot when the caller does not supply a live scope, so a
// recovered child keeps its original finite aggregate ceiling (Phase 1.4) rather
// than restarting the parent-run counter at zero.
function deserializeBudgetState(data, { scope = null } = {}) {
  if (!data || typeof data !== 'object') return null;
  const budgets = { ...(data.budgets ?? {}) };
  return {
    budgets,
    contextSource: data.contextSource ?? 'fallback',
    ledger: {
      inputMeasured: 0, inputEstimated: 0, outputMeasured: 0, outputUnknownTurns: 0, outputReserved: 0,
      reasoningMeasured: 0, reasoningUnknownTurns: 0, turns: 0,
      ...(data.ledger ?? {}),
    },
    toolCalls: data.toolCalls ?? 0,
    blockedCalls: data.blockedCalls ?? 0,
    scope: scope ?? restoreScope(data.scope),
    runtime: { maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null, ...(data.runtime ?? {}) },
    finalizationAttempted: false,
    finalizationStopReason: null,
    overrun: null,
    seenCalls: new Map(),
    toolsUsed: new Map(),
    usage: data.usage ?? null,
    original: data.original
      ? { ...data.original }
      : { maxTurns: budgets.maxTurns ?? null, maxToolCalls: budgets.maxToolCalls ?? null,
        inputBudget: budgets.inputBudget ?? null, outputBudget: budgets.outputBudget ?? null },
    renewals: Array.isArray(data.renewals) ? data.renewals.map(entry => ({ ...entry })) : [],
  };
}

/**
 * The durable continuation record: everything a later process needs to decide
 * whether the child may continue, and to rebuild it, without claiming
 * resumability it cannot prove.
 */
function buildContinuation(session, { pendingContinuation = false, attemptCount = 0 } = {}) {
  const eligibility = evaluateContinuation(session, { pendingContinuation });
  return {
    version: 1,
    ...eligibility,
    status: session?.status ?? null,
    stopReason: session?.stopReason ?? null,
    pendingContinuation: pendingContinuation === true,
    attemptCount: Number.isSafeInteger(attemptCount) && attemptCount >= 0 ? attemptCount : 0,
    renewalCount: session?.budgetState?.renewals?.length ?? 0,
    options: session?.continuationOptions ? { ...session.continuationOptions } : null,
  };
}

module.exports = {
  ELIGIBILITY, BUDGET_STOP_REASONS, NON_RENEWABLE_STOP_REASONS,
  isBudgetStopReason, isSafeBoundary, evaluateContinuation,
  ledgerTotals, summarizeAllowance,
  serializeBudgetState, deserializeBudgetState, buildContinuation,
};
