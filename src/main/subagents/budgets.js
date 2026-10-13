'use strict';

// Cumulative per-task token budgets for sub-agent runs.
//
// Two quantities, kept strictly separate:
//   - per-request generation ceiling (max_tokens on one request): how much a
//     single generation may produce. Raised once, boundedly, on truncation.
//   - cumulative task budgets (input/output across the whole child task):
//     dispatch limits; missing usage retains conservative reservations.
//
// Automatic policy (default): derived per task kind from the existing runtime
// knobs, so budgets scale with what the run is already allowed to do:
//   outputBudget = maxTurns(kind) x perRequestCeiling(kind)
//   inputBudget  = INPUT_REPLAYS x engine.contextLength (a full-prompt
//                  re-send per turn is the normal shape; replays bound it)
// The reference context length is the child engine's, falling back to
// FALLBACK_CONTEXT_LENGTH for providers that report none. Automatic is
// bounded, never unlimited; Custom values replace the corresponding field.
//
// Accounting: provider-reported usage tokens are measured; when a turn omits
// usage, the prompt is estimated with the documented byte-based fallback
// (approximateTokens, explicitly an estimate) and output is marked unknown.
// Ledger coverage reports measured | estimated | unavailable per side.
const { approximateTokens } = require('../contextBudget');

// Generation ceilings for one child request (max_tokens). Raised from the
// previous values so reasoning-heavy models fit thinking plus an answer.
const PER_REQUEST_CEILING = Object.freeze({
  investigation: 2048,
  'file-analysis': 3072,
  'web-extraction': 1024,
});

// Automatic request limits, including retries, existing recovery requests and
// final reporting. Custom overrides are resolved only for new children.
const MAX_TURNS = Object.freeze({
  investigation: 8,
  'file-analysis': 2,
  'web-extraction': 2,
});

const MAX_TOOL_CALLS = Object.freeze({ investigation: 10, 'file-analysis': 32, 'web-extraction': 1 });
const DEFAULT_AGGREGATE_TOOL_CALLS = 40;
const INPUT_REPLAYS = 4;
const FALLBACK_CONTEXT_LENGTH = 32768;
// Minimum completion allowance a next step must fit, or the turn stops
// instead of issuing a request that cannot produce anything useful.
const MIN_COMPLETION_RESERVE = 256;
// Single bounded escalation step for truncated generations.
const ESCALATION_FACTOR = 2;

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
  const outputBudget = turnsFor(kind) * ceilingFor(kind);
  return { outputBudget, inputBudget: INPUT_REPLAYS * contextLength, contextLength };
}

function resolveTaskBudgets({ kind, engine, settings, contextLength = null } = {}) {
  const effectiveEngine = Number.isSafeInteger(contextLength) && contextLength >= 2048
    ? { ...engine, contextLength }
    : engine;
  const auto = autoBudgets(kind, effectiveEngine);
  const mode = settings?.mode === 'custom' ? 'custom' : 'auto';
  const inputBudget = mode === 'custom' && settings?.maxInputTokens != null
    ? settings.maxInputTokens : auto.inputBudget;
  const outputBudget = mode === 'custom' && settings?.maxOutputTokens != null
    ? settings.maxOutputTokens : auto.outputBudget;
  const maxTurns = mode === 'custom' && settings?.maxTurns != null ? settings.maxTurns : turnsFor(kind);
  const maxToolCalls = mode === 'custom' && settings?.maxToolCalls != null ? settings.maxToolCalls : (MAX_TOOL_CALLS[kind] ?? 10);
  return {
    mode, maxTurns, maxToolCalls,
    maxAggregateToolCalls: mode === 'custom' && settings?.maxAggregateToolCalls != null ? settings.maxAggregateToolCalls : DEFAULT_AGGREGATE_TOOL_CALLS,
    kind: kind ?? 'investigation',
    inputBudget,
    outputBudget: mode === 'custom' && settings?.maxOutputTokens != null ? outputBudget : maxTurns * ceilingFor(kind),
    perRequestCeiling: ceilingFor(kind),
    contextLength: auto.contextLength,
    // Where each number came from, for settings UI and diagnostics.
    sources: {
      input: mode === 'custom' && settings?.maxInputTokens != null ? 'custom' : `auto:${INPUT_REPLAYS}x-context`,
      output: mode === 'custom' && settings?.maxOutputTokens != null ? 'custom' : `auto:${maxTurns}-turns`,
    },
  };
}

function createLedger() {
  return { inputMeasured: 0, inputEstimated: 0, outputMeasured: 0, outputUnknownTurns: 0, outputReserved: 0, turns: 0 };
}

function estimatePromptTokens(messages, tools = []) {
  return approximateTokens({ messages, tools });
}

function recordTurn(ledger, { messages, tools = [], usage = null } = {}) {
  ledger.turns += 1;
  const promptTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens
    : Number.isFinite(usage?.input_tokens) ? usage.input_tokens : null;
  if (promptTokens !== null) ledger.inputMeasured += promptTokens;
  else ledger.inputEstimated += estimatePromptTokens(messages, tools);
  const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens
    : Number.isFinite(usage?.output_tokens) ? usage.output_tokens : null;
  if (completionTokens !== null) ledger.outputMeasured += completionTokens;
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

// Whether another generation may start: the estimated prompt must fit remaining input and a minimum
// completion allowance must fit remaining output independently. Custom budgets are hard
// limits — a false here stops the turn, it never borrows.
function canAffordNext(ledger, budgets, estimatedPromptTokens, minCompletion = MIN_COMPLETION_RESERVE) {
  const totals = ledgerTotals(ledger);
  if (estimatedPromptTokens > budgets.inputBudget - totals.inputTokens) {
    return { ok: false, reason: 'input' };
  }
  if (minCompletion > budgets.outputBudget - totals.outputTokens) {
    return { ok: false, reason: 'output' };
  }
  return { ok: true, reason: null };
}

// Clamp an escalated ceiling to the provider window and the remaining output
// budget. Returns null when no escalation fits (caller must stop or fail).
function escalatedCeiling(current, budgets, ledger, estimatedPromptTokens) {
  const totals = ledgerTotals(ledger);
  const outputLeft = budgets.outputBudget - totals.outputTokens;
  const windowLeft = Math.max(0, budgets.contextLength - estimatedPromptTokens);
  const candidate = Math.min(current * ESCALATION_FACTOR, outputLeft, windowLeft);
  return candidate > current ? candidate : null;
}

// Machine-readable Automatic policy summary for the settings UI
// ("effective values" discoverability): ceilings and turn counts per task
// kind, plus the rules input/output budgets derive from.
function describeAutoPolicy() {
  return {
    perRequestCeiling: { ...PER_REQUEST_CEILING },
    maxTurns: { ...MAX_TURNS },
    maxToolCalls: { ...MAX_TOOL_CALLS },
    maxAggregateToolCalls: DEFAULT_AGGREGATE_TOOL_CALLS,
    inputRule: `${INPUT_REPLAYS} x child context window (provider-reported, ${FALLBACK_CONTEXT_LENGTH} fallback)`,
    outputRule: 'turns(kind) x per-request ceiling',
  };
}

module.exports = {
  PER_REQUEST_CEILING, MAX_TURNS, MAX_TOOL_CALLS, DEFAULT_AGGREGATE_TOOL_CALLS, INPUT_REPLAYS, FALLBACK_CONTEXT_LENGTH,
  MIN_COMPLETION_RESERVE, ESCALATION_FACTOR,
  ceilingFor, turnsFor, contextLengthOf, resolveEngineContextLength, autoBudgets, resolveTaskBudgets, describeAutoPolicy,
  createLedger, estimatePromptTokens, recordTurn, ledgerTotals, canAffordNext, escalatedCeiling,
};
