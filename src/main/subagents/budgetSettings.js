'use strict';

// Sub-agent task token budgets: a standalone app-settings key (same pattern
// as the sub-agent model selection in ./modelSelection.js), not part of the
// fixed configManager key list. Global to the app: it bounds every child's
// cumulative lifetime usage. Effective settings are frozen when a child starts.
//
// Shape: { mode: 'auto' | 'custom',
//          maxInputTokens / maxOutputTokens / maxToolCalls / maxTurns /
//          maxAggregateToolCalls: int | null | 'unbounded',
//          maxRuntimeMs / requestTimeoutMs / requestInactivityMs:
//          int | null | 'unbounded' }
//   - null (or unset) means "Automatic for this field" (see ./budgets.js).
//   - a positive integer is a finite, explicitly enforced limit.
//   - the string 'unbounded' is an explicit "no numeric ceiling / no time
//     limit" selection: it is a distinct sentinel, never a giant integer.
//     Unbounded relaxes only the numeric budget or the wall-clock limit; it
//     never disables permissions, the model context window, cancellation,
//     concurrency limits or provider limits.
//
// Phase 1.3B adds three time limits (all integers in milliseconds):
//   maxRuntimeMs        the whole child execution's deadline
//   requestTimeoutMs    one model request's total-duration limit
//   requestInactivityMs one streamed request's inter-chunk inactivity limit
// Automatic mode leaves all three null: there is no deadline and no request
// timeout, so long-horizon work is never silently cut off. A finite Custom
// value arms the limit; the string 'unbounded' (or blank) clears it. Timeouts
// are enforced by the backend regardless of what the UI sends.
//
// Phase 1.3A: the finite maximums below are sanity bounds that catch unit
// mistakes (e.g. typing a per-request ceiling into a cumulative field), not
// workload ceilings. They are deliberately far above the previous 100/100/10000
// so that long-horizon children can be authorized; a genuinely unbounded
// selection is expressed with UNBOUNDED instead of a large integer.
const SETTINGS_KEY = 'subagentBudgets';

const MODES = ['auto', 'custom'];
// The explicit "no numeric ceiling" sentinel. Shared with the UI through
// budgets.describeAutoPolicy().limits so the backend, parser, saved prefs and
// UI all use one value.
const UNBOUNDED = 'unbounded';

// Hard bounds for user-entered finite values.
const INPUT_MIN = 512;
const INPUT_MAX = 1000000000;
const OUTPUT_MIN = 256;
const OUTPUT_MAX = 1000000000;
const TOOL_CALLS_MIN = 1;
const TOOL_CALLS_MAX = 10000000;
const TURNS_MIN = 1;
const TURNS_MAX = 10000000;
const AGGREGATE_MIN = 1;
const AGGREGATE_MAX = 100000000;
// Phase 1.3B time limits, in milliseconds. The ceilings are deliberately
// generous (the deadline may authorize a task lasting up to a week) so a
// long-horizon task is never given an undocumented short wall-clock timeout;
// a genuinely unlimited selection is expressed with UNBOUNDED instead.
const RUNTIME_MIN = 1000;
const RUNTIME_MAX = 604800000;          // 7 days
const REQUEST_TIMEOUT_MIN = 1000;
const REQUEST_TIMEOUT_MAX = 86400000;   // 1 day
const REQUEST_INACTIVITY_MIN = 1000;
const REQUEST_INACTIVITY_MAX = 3600000; // 1 hour

// Per-field finite bounds, shared with the settings UI through the
// describeAutoPolicy() payload. Each field may also be UNBOUNDED.
const LIMITS = Object.freeze({
  maxInputTokens: Object.freeze({ min: INPUT_MIN, max: INPUT_MAX }),
  maxOutputTokens: Object.freeze({ min: OUTPUT_MIN, max: OUTPUT_MAX }),
  maxToolCalls: Object.freeze({ min: TOOL_CALLS_MIN, max: TOOL_CALLS_MAX }),
  maxTurns: Object.freeze({ min: TURNS_MIN, max: TURNS_MAX }),
  maxAggregateToolCalls: Object.freeze({ min: AGGREGATE_MIN, max: AGGREGATE_MAX }),
  maxRuntimeMs: Object.freeze({ min: RUNTIME_MIN, max: RUNTIME_MAX }),
  requestTimeoutMs: Object.freeze({ min: REQUEST_TIMEOUT_MIN, max: REQUEST_TIMEOUT_MAX }),
  requestInactivityMs: Object.freeze({ min: REQUEST_INACTIVITY_MIN, max: REQUEST_INACTIVITY_MAX }),
});

function normalizeBudgetSettings(input) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Sub-agent budgets must be an object.');
  }
  const mode = input.mode === undefined ? 'auto' : input.mode;
  if (!MODES.includes(mode)) throw new Error('Sub-agent budget mode must be "auto" or "custom".');
  const check = (value, name, min, max) => {
    if (value === undefined || value === null) return null;
    if (value === UNBOUNDED) return UNBOUNDED;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}, or "${UNBOUNDED}".`);
    }
    return value;
  };
  return {
    mode,
    maxInputTokens: check(input.maxInputTokens, 'Input budget', INPUT_MIN, INPUT_MAX),
    maxOutputTokens: check(input.maxOutputTokens, 'Output budget', OUTPUT_MIN, OUTPUT_MAX),
    maxToolCalls: check(input.maxToolCalls, 'Tool-call limit', TOOL_CALLS_MIN, TOOL_CALLS_MAX),
    maxTurns: check(input.maxTurns, 'Turn limit', TURNS_MIN, TURNS_MAX),
    maxAggregateToolCalls: check(input.maxAggregateToolCalls, 'Aggregate tool-call limit', AGGREGATE_MIN, AGGREGATE_MAX),
    maxRuntimeMs: check(input.maxRuntimeMs, 'Execution deadline', RUNTIME_MIN, RUNTIME_MAX),
    requestTimeoutMs: check(input.requestTimeoutMs, 'Model request timeout', REQUEST_TIMEOUT_MIN, REQUEST_TIMEOUT_MAX),
    requestInactivityMs: check(input.requestInactivityMs, 'Stream inactivity timeout', REQUEST_INACTIVITY_MIN, REQUEST_INACTIVITY_MAX),
  };
}

function getBudgetSettings() {
  let raw = null;
  try {
    raw = require('../db').db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEY)?.value_json ?? null;
  } catch {
    return normalizeBudgetSettings(null);
  }
  if (raw == null) return normalizeBudgetSettings(null);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The saved sub-agent budget settings are not readable. Re-save them in Settings.');
  }
  return normalizeBudgetSettings(parsed);
}

function saveBudgetSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Sub-agent budget settings must be an object.');
  }
  const merged = normalizeBudgetSettings({ ...getBudgetSettings(), ...patch });
  require('../db').db.prepare(
    'INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

module.exports = {
  getBudgetSettings, saveBudgetSettings, normalizeBudgetSettings, SETTINGS_KEY,
  UNBOUNDED, LIMITS,
};
