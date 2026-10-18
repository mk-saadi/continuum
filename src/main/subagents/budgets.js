'use strict';

// Cumulative per-task token budgets for sub-agent runs.
//
// Two quantities, kept strictly separate:
//   - per-request generation ceiling (max_tokens on one request): how much a
//     single generation may produce. Raised once, boundedly, on truncation.
//   - cumulative task budgets (input/output across the whole child task):
//     dispatch limits; missing usage retains conservative reservations.
//   - the model context window: a per-request occupancy limit, never a
//     cumulative one. Cumulative input tokens are allowed to exceed the window
//     many times over; that is what long-horizon work with compaction is.
//
// Automatic policy (default): derived per task kind from the existing runtime
// knobs, so budgets scale with what the run is already allowed to do:
//   outputBudget  = effectiveTurns(kind) x perRequestCeiling(kind)
//   inputBudget   = max(MIN_INPUT_REPLAYS, turns(kind)) x engine.contextLength
// The input rule is the turn envelope — the theoretical maximum if every
// request re-sent a full context window — so the cumulative input budget can
// never be mistaken for the per-request window and, for long-horizon kinds,
// never becomes the binding constraint. The real limiters stay the request
// count (maxTurns) and the per-request window. Automatic is bounded, never
// unlimited; Custom values replace the corresponding field, and a Custom field
// may be the explicit UNBOUNDED sentinel.
//
// Accounting: provider-reported usage tokens are measured; when a turn omits
// usage, the prompt is estimated with the documented byte-based fallback
// (approximateTokens, explicitly an estimate) and output is marked unknown.
// Ledger coverage reports measured | estimated | unavailable per side.
const { approximateTokens } = require('../contextBudget');
const { UNBOUNDED, LIMITS } = require('./budgetSettings');

// Generation ceilings for one child request (max_tokens). Raised from the
// previous values so reasoning-heavy models fit thinking plus an answer.
const PER_REQUEST_CEILING = Object.freeze({
  investigation: 2048,
  'file-analysis': 3072,
  'web-extraction': 1024,
});

// Automatic request limits, including retries, existing recovery requests and
// final reporting. Custom overrides are resolved only for new children.
//
// Phase 1.3A: the previous investigation defaults (12 requests / 25 tool calls)
// died on real long-horizon audits. The envelope below is a documented,
// conservative long-horizon policy — it covers the verified target (150+
// requests and 150+ tool calls) with headroom for compaction, retries and
// finalization, while remaining a finite safety rail. It is NOT the previous
// constants multiplied by a factor; it is re-anchored to the long-horizon
// target, and the token rule above is re-derived from it. Users who need more
// (or no numeric ceiling) select Custom, where each field may be UNBOUNDED.
const MAX_TURNS = Object.freeze({
  investigation: 200,
  'file-analysis': 2,
  'web-extraction': 2,
});

const MAX_TOOL_CALLS = Object.freeze({ investigation: 400, 'file-analysis': 32, 'web-extraction': 1 });
// Shared across the children of one parent invocation. Sized so a batch of
// ~5 long-horizon children each reaching their own tool envelope still fits.
const DEFAULT_AGGREGATE_TOOL_CALLS = 2000;
// Floor for the cumulative input envelope of short (one-shot) kinds: a
// full-prompt re-send per attempt is the normal shape, and a 2-attempt
// one-shot must not be capped below the window it legitimately re-sends.
const MIN_INPUT_REPLAYS = 4;
const FALLBACK_CONTEXT_LENGTH = 32768;
// Minimum completion allowance a next step must fit, or the turn stops
// instead of issuing a request that cannot produce anything useful.
const MIN_COMPLETION_RESERVE = 256;
// Single bounded escalation step for truncated generations.
const ESCALATION_FACTOR = 2;

// Phase 1.3B time limits. Automatic mode resolves every one to null — there is
// no execution deadline and no model-request timeout — so long-horizon work is
// never silently cut off, and the default behavior is byte-for-byte unchanged.
// A Custom field is either a finite integer (limit armed) or blank/unbounded
// (null). The limits are independent of the token/request budgets: a child can
// exhaust its deadline while well inside its token budget, or vice versa.
const RUNTIME_DEFAULTS = Object.freeze({
  maxRuntimeMs: null,
  requestTimeoutMs: null,
  requestInactivityMs: null,
});
const RUNTIME_FIELDS = Object.freeze(Object.keys(RUNTIME_DEFAULTS));

function ceilingFor(kind) {
  return PER_REQUEST_CEILING[kind] ?? PER_REQUEST_CEILING.investigation;
}

function turnsFor(kind) {
  return MAX_TURNS[kind] ?? MAX_TURNS.investigation;
}

function contextLengthOf(engine) {
  const limit = engine?.contextLength;
  return Number.isSafeInteger(limit) && limit >= 2048 ? limit : FALLBACK_CONTEXT_LENGTH;
}

// A resolved budget limit is either a finite positive integer or null, where
// null is the explicit "no numeric ceiling" (unbounded) value. These helpers
// keep the unbounded case out of arithmetic that would otherwise produce NaN
// or a wrong comparison (e.g. `used >= null`).
function limitReached(limit, used) {
  return limit !== null && used >= limit;
}

function remaining(limit, used) {
  return limit === null ? Infinity : limit - used;
}

// Resolve the real context window for a child engine. Local engines carry
// it on the descriptor; cloud engines resolve it from cached provider model
// metadata (no extra fetch on cache hit). Anything unresolvable falls back
// to FALLBACK_CONTEXT_LENGTH and says so — callers treat that as
// lower-confidence, and Custom user budgets still win regardless.
async function resolveEngineContextLength(engine, deps = {}) {
  const direct = engine?.contextLength;
  if (Number.isSafeInteger(direct) && direct >= 2048) return { contextLength: direct, source: 'engine' };
  const target = engine?.chatTarget;
  if (target?.type === 'cloud' && typeof target.provider === 'string' && typeof target.model === 'string') {
    try {
      const getMetadata = deps.getCloudModelMetadata
        ?? require('../cloudProviders').getCloudModelMetadata;
      const rows = await getMetadata();
      const row = Array.isArray(rows)
        ? rows.find(entry => entry?.providerId === target.provider && entry?.modelId === target.model)
        : null;
      const length = row?.contextLength;
      if (Number.isSafeInteger(length) && length >= 2048) return { contextLength: length, source: 'provider-metadata' };
    } catch {
      /* Fall through to the documented fallback below. */
    }
  }
  return { contextLength: FALLBACK_CONTEXT_LENGTH, source: 'fallback' };
}

function autoBudgets(kind, engine) {
  const contextLength = contextLengthOf(engine);
  const maxTurns = turnsFor(kind);
  return {
    maxTurns,
    maxToolCalls: MAX_TOOL_CALLS[kind] ?? MAX_TOOL_CALLS.investigation,
    maxAggregateToolCalls: DEFAULT_AGGREGATE_TOOL_CALLS,
    outputBudget: maxTurns * ceilingFor(kind),
    // Turn envelope, not a fixed multiple of the window: cumulative input may
    // legitimately be many windows' worth over a long task.
    inputBudget: Math.max(MIN_INPUT_REPLAYS, maxTurns) * contextLength,
    contextLength,
  };
}

function resolveTaskBudgets({ kind, engine, settings, contextLength = null } = {}) {
  const effectiveEngine = Number.isSafeInteger(contextLength) && contextLength >= 2048
    ? { ...engine, contextLength }
    : engine;
  const auto = autoBudgets(kind, effectiveEngine);
  const mode = settings?.mode === 'custom' ? 'custom' : 'auto';
  const custom = field => mode === 'custom' && settings?.[field] != null;
  // A Custom field is an explicit finite integer or the UNBOUNDED sentinel;
  // the latter resolves to null (no numeric ceiling) at runtime.
  const resolve = (field, autoValue) => {
    if (!custom(field)) return autoValue;
    return settings[field] === UNBOUNDED ? null : settings[field];
  };
  const maxTurns = resolve('maxTurns', auto.maxTurns);
  const maxToolCalls = resolve('maxToolCalls', auto.maxToolCalls);
  const maxAggregateToolCalls = resolve('maxAggregateToolCalls', auto.maxAggregateToolCalls);
  const inputBudget = resolve('maxInputTokens', auto.inputBudget);
  // The output envelope follows the effective (possibly Custom) turn ceiling;
  // an unbounded turn limit cannot define a finite output envelope, so the
  // Automatic turns keep it finite unless output is itself explicit.
  const outputTurns = maxTurns === null ? auto.maxTurns : maxTurns;
  const outputBudget = custom('maxOutputTokens')
    ? (settings.maxOutputTokens === UNBOUNDED ? null : settings.maxOutputTokens)
    : outputTurns * ceilingFor(kind);
  return {
    mode, maxTurns, maxToolCalls, maxAggregateToolCalls,
    kind: kind ?? 'investigation',
    inputBudget,
    outputBudget,
    perRequestCeiling: ceilingFor(kind),
    contextLength: auto.contextLength,
    // Where each number came from, for settings UI and diagnostics.
    sources: {
      input: custom('maxInputTokens')
        ? (settings.maxInputTokens === UNBOUNDED ? 'custom:unbounded' : 'custom')
        : `auto:${turnsFor(kind)}-turn-window`,
      output: custom('maxOutputTokens')
        ? (settings.maxOutputTokens === UNBOUNDED ? 'custom:unbounded' : 'custom')
        : `auto:${outputTurns}-turns`,
    },
  };
}

// Resolve the three opt-in time limits for a new child (Phase 1.3B). Automatic
// mode adds no deadline and no request timeout (all null); Custom arms each
// field that is a finite integer and leaves a blank/'unbounded' field unset.
// The settings parser already bounds the values, so a resolved value is always
// a positive safe integer or null.
function resolveRuntimeLimits(settings) {
  const mode = settings?.mode === 'custom' ? 'custom' : 'auto';
  const resolve = field => {
    if (mode !== 'custom') return null;
    const value = settings?.[field];
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  return {
    maxRuntimeMs: resolve('maxRuntimeMs'),
    requestTimeoutMs: resolve('requestTimeoutMs'),
    requestInactivityMs: resolve('requestInactivityMs'),
  };
}

function createLedger() {
  return { inputMeasured: 0, inputEstimated: 0, outputMeasured: 0, outputUnknownTurns: 0, outputReserved: 0, turns: 0 };
}

function estimatePromptTokens(messages, tools = []) {
  return approximateTokens({ messages, tools });
}

// Normalize one provider's usage report to the runtime's two counters, across
// the shapes children actually see:
//   - local (llama.cpp, OpenAI-compatible): prompt_tokens / completion_tokens
//   - cloud OpenAI-compatible (streamed or JSON):  prompt_tokens / completion_tokens
//   - cloud Anthropic: normalized by createCloudFetch to prompt_tokens /
//     completion_tokens, with cache_read/creation folded into prompt_tokens
// Aliases input_tokens / output_tokens are accepted for any provider that only
// emits those. Missing or non-integer values stay null so accounting labels the
// turn estimated/reserved instead of inventing a measured zero; cached input is
// surfaced for diagnostics only and is never added twice (it is already part of
// prompt_tokens in every supported shape).
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { input: null, output: null, cachedInput: null };
  const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    input: int(usage.prompt_tokens) ?? int(usage.input_tokens),
    output: int(usage.completion_tokens) ?? int(usage.output_tokens),
    cachedInput: int(usage.cached_tokens) ?? int(usage.cache_read_input_tokens) ?? int(usage.prompt_tokens_details?.cached_tokens),
  };
}

function recordTurn(ledger, { messages, tools = [], usage = null } = {}) {
  ledger.turns += 1;
  const { input, output } = normalizeUsage(usage);
  if (input !== null) ledger.inputMeasured += input;
  else ledger.inputEstimated += estimatePromptTokens(messages, tools);
  if (output !== null) ledger.outputMeasured += output;
  else ledger.outputUnknownTurns += 1;
  return ledger;
}

function ledgerTotals(ledger) {
  return {
    inputTokens: ledger.inputMeasured + ledger.inputEstimated,
    inputCoverage: ledger.turns === 0 ? 'unavailable'
      : ledger.inputEstimated === 0 ? 'measured' : ledger.inputMeasured === 0 ? 'estimated' : 'mixed',
    outputTokens: ledger.outputMeasured + (ledger.outputReserved ?? 0),
    outputMeasured: ledger.outputMeasured, outputReserved: ledger.outputReserved ?? 0,
    outputCoverage: ledger.turns === 0 ? 'unavailable'
      : ledger.outputUnknownTurns === 0 ? 'measured' : ledger.outputReserved > 0 ? 'reserved' : 'partial',
    turns: ledger.turns,
  };
}

// Whether another generation may start: the estimated prompt must fit the
// remaining input envelope and a minimum completion allowance must fit the
// remaining output envelope independently. A null (unbounded) envelope never
// blocks. Custom budgets are hard limits — a false here stops the turn, it
// never borrows.
function canAffordNext(ledger, budgets, estimatedPromptTokens, minCompletion = MIN_COMPLETION_RESERVE) {
  const totals = ledgerTotals(ledger);
  if (remaining(budgets.inputBudget, totals.inputTokens) < estimatedPromptTokens) {
    return { ok: false, reason: 'input' };
  }
  if (remaining(budgets.outputBudget, totals.outputTokens) < minCompletion) {
    return { ok: false, reason: 'output' };
  }
  return { ok: true, reason: null };
}

// Clamp an escalated ceiling to the provider window and the remaining output
// budget. Returns null when no escalation fits (caller must stop or fail).
function escalatedCeiling(current, budgets, ledger, estimatedPromptTokens) {
  const totals = ledgerTotals(ledger);
  const outputLeft = remaining(budgets.outputBudget, totals.outputTokens);
  const windowLeft = Math.max(0, budgets.contextLength - estimatedPromptTokens);
  const candidate = Math.min(current * ESCALATION_FACTOR, outputLeft, windowLeft);
  return candidate > current ? candidate : null;
}

// Machine-readable Automatic policy summary for the settings UI
// ("effective values" discoverability): ceilings and turn counts per task
// kind, plus the rules input/output budgets derive from, and the per-field
// finite bounds and the UNBOUNDED sentinel so backend, parser and UI agree.
function describeAutoPolicy() {
  return {
    perRequestCeiling: { ...PER_REQUEST_CEILING },
    maxTurns: { ...MAX_TURNS },
    maxToolCalls: { ...MAX_TOOL_CALLS },
    maxAggregateToolCalls: DEFAULT_AGGREGATE_TOOL_CALLS,
    minInputReplays: MIN_INPUT_REPLAYS,
    inputRule: `max(${MIN_INPUT_REPLAYS}, turns(kind)) x child context window (provider-reported, ${FALLBACK_CONTEXT_LENGTH} fallback)`,
    outputRule: 'turns(kind) x per-request ceiling',
    unbounded: UNBOUNDED,
    limits: Object.fromEntries(Object.entries(LIMITS).map(([field, bounds]) => [field, { ...bounds, unbounded: UNBOUNDED }])),
    // Phase 1.3B time limits. Automatic resolves every one to null (no deadline,
    // no request timeout); the UI reads this to render the effective policy.
    runtime: {
      ...RUNTIME_DEFAULTS,
      rule: 'Automatic has no execution deadline and no model-request timeout, so long-horizon work is never cut off. A Custom finite millisecond value arms the limit; blank or "No limit" clears it. Time limits are independent of the token/request budgets.',
    },
  };
}

module.exports = {
  PER_REQUEST_CEILING, MAX_TURNS, MAX_TOOL_CALLS, DEFAULT_AGGREGATE_TOOL_CALLS, MIN_INPUT_REPLAYS, FALLBACK_CONTEXT_LENGTH,
  MIN_COMPLETION_RESERVE, ESCALATION_FACTOR, UNBOUNDED, LIMITS, RUNTIME_DEFAULTS, RUNTIME_FIELDS,
  ceilingFor, turnsFor, contextLengthOf, resolveEngineContextLength, autoBudgets, resolveTaskBudgets, resolveRuntimeLimits,
  describeAutoPolicy,
  createLedger, estimatePromptTokens, normalizeUsage, recordTurn, ledgerTotals, canAffordNext, escalatedCeiling, limitReached, remaining,
};
