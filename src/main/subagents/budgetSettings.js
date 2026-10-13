'use strict';

// Sub-agent task token budgets: a standalone app-settings key (same pattern
// as the sub-agent model selection in ./modelSelection.js), not part of the
// fixed configManager key list. Global to the app: it bounds every child's
// cumulative lifetime usage. Effective settings are frozen when a child starts.
//
// Token fields remain separate from nullable tool/turn/aggregate overrides.
// Shape: { mode: 'auto' | 'custom', maxInputTokens: int|null, maxOutputTokens: int|null }
// A null custom value means "unset" and falls back to the Automatic policy
// for that field (see ./budgets.js resolveTaskBudgets).
const SETTINGS_KEY = 'subagentBudgets';

const MODES = ['auto', 'custom'];
// Hard bounds for user-entered values: wide enough for large-context models,
// tight enough to catch unit mistakes (e.g. typing a per-request ceiling).
const INPUT_MIN = 512;
const INPUT_MAX = 1000000;
const OUTPUT_MIN = 256;
const OUTPUT_MAX = 500000;

function normalizeBudgetSettings(input) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Sub-agent budgets must be an object.');
  }
  const mode = input.mode === undefined ? 'auto' : input.mode;
  if (!MODES.includes(mode)) throw new Error('Sub-agent budget mode must be "auto" or "custom".');
  const check = (value, name, min, max) => {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
  return {
    mode,
    maxInputTokens: check(input.maxInputTokens, 'Input budget', INPUT_MIN, INPUT_MAX),
    maxOutputTokens: check(input.maxOutputTokens, 'Output budget', OUTPUT_MIN, OUTPUT_MAX),
    maxToolCalls: check(input.maxToolCalls, 'Tool-call limit', 1, 100),
    maxTurns: check(input.maxTurns, 'Turn limit', 1, 100),
    maxAggregateToolCalls: check(input.maxAggregateToolCalls, 'Aggregate tool-call limit', 1, 10000),
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

module.exports = { getBudgetSettings, saveBudgetSettings, normalizeBudgetSettings, SETTINGS_KEY };
