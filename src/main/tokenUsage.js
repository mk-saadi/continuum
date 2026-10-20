'use strict';
const { db } = require('./db');
const MONTHS = [1, 3, 6, 12];
const KEY = 'token_history_retention_months';
const COVERAGE = new Set(['measured', 'estimated', 'partially_measured', 'unavailable']);
const SOURCE = new Set(['provider', 'server-timings', 'derived', 'unavailable']);
const COVERAGE_ALIASES = { partial: 'partially_measured', mixed: 'partially_measured', complete: 'measured', unreported: 'unavailable' };
const COST_COMPLETENESS = new Set(['complete', 'partial', 'unavailable', 'not_applicable']);

function validateMonths(months) {
  if (!MONTHS.includes(months)) throw new TypeError('Retention must be 1, 3, 6, or 12 months.');
  return months;
}
function getRetention() {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(KEY);
  return row ? validateMonths(JSON.parse(row.value_json)) : 12;
}
function cutoff(months, now) {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
function prune(now = new Date()) {
  db.prepare('DELETE FROM token_usage WHERE timestamp < ?').run(cutoff(getRetention(), now));
}
function setRetention(months, now = new Date()) {
  validateMonths(months);
  db.transaction(() => {
    db.prepare('INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(KEY, JSON.stringify(months));
    prune(now);
  })();
  return months;
}
function optionalCount(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalIdentifier(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalCoverage(value, label, implied) {
  if (value == null) return implied;
  value = COVERAGE_ALIASES[value] ?? value;
  if (!COVERAGE.has(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalSource(value, label) {
  if (value == null) return null;
  if (!SOURCE.has(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
// Cost columns accept any finite real (cache savings may be negative). A
// non-finite or non-numeric value is a programming error, not unknown data.
function optionalReal(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalText(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalCompleteness(value, label) {
  if (value == null) return null;
  if (!COST_COMPLETENESS.has(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function normalizeCost(cost) {
  if (cost == null) return null;
  if (typeof cost !== 'object' || Array.isArray(cost)) throw new TypeError('Invalid cost evidence.');
  return {
    total: optionalReal(cost.total, 'cost total'),
    currency: optionalText(cost.currency, 'cost currency'),
    status: optionalText(cost.status, 'cost status'),
    completeness: optionalCompleteness(cost.completeness, 'cost completeness'),
    source: optionalText(cost.source, 'cost source'),
    version: optionalText(cost.version, 'cost version'),
    timestamp: cost.timestamp == null ? null : new Date(cost.timestamp).toISOString(),
    uncachedInput: optionalReal(cost.uncachedInput, 'uncached input cost'),
    cacheRead: optionalReal(cost.cacheRead, 'cache read cost'),
    cacheWrite: optionalReal(cost.cacheWrite, 'cache write cost'),
    cacheWrite1h: optionalReal(cost.cacheWrite1h, 'cache write 1h cost'),
    output: optionalReal(cost.output, 'output cost'),
    reasoning: optionalReal(cost.reasoning, 'reasoning cost'),
    cacheSavings: optionalReal(cost.cacheSavings, 'cache savings'),
    providerReported: optionalReal(cost.providerReported, 'provider-reported cost'),
    breakdown: cost.breakdown == null ? null : typeof cost.breakdown === 'string' ? cost.breakdown : JSON.stringify(cost.breakdown),
  };
}
// One row per generated turn. Repeated cumulative snapshots (pause/resume) replace
// the same row; regeneration uses a fresh turn ID. Chat deletion keeps usage totals.
//
// Cache and cost fields are nullable by contract: NULL means "not reported",
// while 0 is a measured zero. Coverage/completeness columns preserve that
// distinction through aggregation and make mixed-provider history honest.
function logTokenUsage({
  turnId, chatId = null, projectId = null, timestamp = new Date().toISOString(),
  promptTokens, completionTokens, uncachedInputTokens = null, cacheReadTokens = null,
  cacheCreationTokens = null, reasoningTokens = null, visibleOutputTokens = null,
  modelId = null, provider = null, inputSource = null, cacheReadSource = null, cacheWriteSource = null,
  cacheReadCoverage = null, cacheWriteCoverage = null, usageCoverage = null,
  cost = null,
}, now = new Date()) {
  if (typeof turnId !== 'string' || !turnId) throw new TypeError('Missing usage turn ID.');
  for (const value of [chatId, projectId]) if (value !== null && typeof value !== 'string') throw new TypeError('Invalid usage identifier.');
  for (const count of [promptTokens, completionTokens]) if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid token count.');
  timestamp = new Date(timestamp).toISOString();
  cacheReadTokens = optionalCount(cacheReadTokens, 'cache-read token count');
  cacheCreationTokens = optionalCount(cacheCreationTokens, 'cache-write token count');
  uncachedInputTokens = optionalCount(uncachedInputTokens, 'uncached input token count');
  reasoningTokens = optionalCount(reasoningTokens, 'reasoning token count');
  visibleOutputTokens = optionalCount(visibleOutputTokens, 'visible output token count');
  modelId = optionalIdentifier(modelId, 'model ID');
  provider = optionalIdentifier(provider, 'provider');
  cacheReadCoverage = optionalCoverage(cacheReadCoverage, 'cache-read coverage',
    cacheReadTokens === null ? 'unavailable' : 'measured');
  cacheWriteCoverage = optionalCoverage(cacheWriteCoverage, 'cache-write coverage',
    cacheCreationTokens === null ? 'unavailable' : 'measured');
  usageCoverage = optionalCoverage(usageCoverage, 'usage coverage', 'measured');
  const evidence = normalizeCost(cost);
  db.transaction(() => {
    db.prepare(`INSERT INTO token_usage (
        turn_id, chat_id, project_id, timestamp, prompt_tokens, completion_tokens,
        uncached_input_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
        visible_output_tokens, input_source, cache_read_source, cache_write_source,
        cache_read_coverage, cache_write_coverage, usage_coverage, model_id, provider,
        cost_total, cost_currency, cost_status, cost_completeness, cost_source, cost_version,
        cost_timestamp, cost_uncached_input, cost_cache_read, cost_cache_write, cost_cache_write_1h,
        cost_output, cost_reasoning, cost_cache_savings, cost_provider_reported, cost_breakdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        -- A later snapshot may omit a counter the earlier snapshot measured;
        -- never erase a known value with NULL. A measured zero still updates.
        uncached_input_tokens = COALESCE(excluded.uncached_input_tokens, token_usage.uncached_input_tokens),
        cache_read_tokens = COALESCE(excluded.cache_read_tokens, token_usage.cache_read_tokens),
        cache_creation_tokens = COALESCE(excluded.cache_creation_tokens, token_usage.cache_creation_tokens),
        reasoning_tokens = COALESCE(excluded.reasoning_tokens, token_usage.reasoning_tokens),
        visible_output_tokens = COALESCE(excluded.visible_output_tokens, token_usage.visible_output_tokens),
        input_source = COALESCE(excluded.input_source, token_usage.input_source),
        cache_read_source = COALESCE(excluded.cache_read_source, token_usage.cache_read_source),
        cache_write_source = COALESCE(excluded.cache_write_source, token_usage.cache_write_source),
        -- Coverage follows the preserved counter: an incomplete later snapshot
        -- must not relabel a previously measured value as unavailable.
        cache_read_coverage = CASE WHEN excluded.cache_read_tokens IS NULL AND token_usage.cache_read_tokens IS NOT NULL
          THEN token_usage.cache_read_coverage ELSE COALESCE(excluded.cache_read_coverage, token_usage.cache_read_coverage) END,
        cache_write_coverage = CASE WHEN excluded.cache_creation_tokens IS NULL AND token_usage.cache_creation_tokens IS NOT NULL
          THEN token_usage.cache_write_coverage ELSE COALESCE(excluded.cache_write_coverage, token_usage.cache_write_coverage) END,
        usage_coverage = COALESCE(excluded.usage_coverage, token_usage.usage_coverage),
        model_id = COALESCE(excluded.model_id, token_usage.model_id),
        provider = COALESCE(excluded.provider, token_usage.provider),
        -- Cost evidence follows the same rule: a later snapshot without cost
        -- never erases an earlier estimate.
        cost_total = COALESCE(excluded.cost_total, token_usage.cost_total),
        cost_currency = COALESCE(excluded.cost_currency, token_usage.cost_currency),
        cost_status = COALESCE(excluded.cost_status, token_usage.cost_status),
        cost_completeness = COALESCE(excluded.cost_completeness, token_usage.cost_completeness),
        cost_source = COALESCE(excluded.cost_source, token_usage.cost_source),
        cost_version = COALESCE(excluded.cost_version, token_usage.cost_version),
        cost_timestamp = COALESCE(excluded.cost_timestamp, token_usage.cost_timestamp),
        cost_uncached_input = COALESCE(excluded.cost_uncached_input, token_usage.cost_uncached_input),
        cost_cache_read = COALESCE(excluded.cost_cache_read, token_usage.cost_cache_read),
        cost_cache_write = COALESCE(excluded.cost_cache_write, token_usage.cost_cache_write),
        cost_cache_write_1h = COALESCE(excluded.cost_cache_write_1h, token_usage.cost_cache_write_1h),
        cost_output = COALESCE(excluded.cost_output, token_usage.cost_output),
        cost_reasoning = COALESCE(excluded.cost_reasoning, token_usage.cost_reasoning),
        cost_cache_savings = COALESCE(excluded.cost_cache_savings, token_usage.cost_cache_savings),
        cost_provider_reported = COALESCE(excluded.cost_provider_reported, token_usage.cost_provider_reported),
        cost_breakdown = COALESCE(excluded.cost_breakdown, token_usage.cost_breakdown)`)
      .run(turnId, chatId, projectId, timestamp, promptTokens, completionTokens,
        uncachedInputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens,
        visibleOutputTokens, optionalSource(inputSource, 'input source'),
        optionalSource(cacheReadSource, 'cache-read source'), optionalSource(cacheWriteSource, 'cache-write source'),
        cacheReadCoverage, cacheWriteCoverage, usageCoverage, modelId, provider,
        evidence?.total ?? null, evidence?.currency ?? null, evidence?.status ?? null,
        evidence?.completeness ?? null, evidence?.source ?? null, evidence?.version ?? null,
        evidence?.timestamp ?? null, evidence?.uncachedInput ?? null, evidence?.cacheRead ?? null,
        evidence?.cacheWrite ?? null, evidence?.cacheWrite1h ?? null, evidence?.output ?? null,
        evidence?.reasoning ?? null, evidence?.cacheSavings ?? null, evidence?.providerReported ?? null,
        evidence?.breakdown ?? null);
    prune(now);
  })();
}
function coverageOf(measured, turns) {
  if (!turns) return 'unavailable';
  return measured === turns ? 'measured' : measured > 0 ? 'partially_measured' : 'unavailable';
}
// Cost coverage counts only billable (cloud) turns: a local model has no cloud
// charge at all, so its "not applicable" rows must not drag a real total down
// to "partial".
function costCoverageOf(measured, billable, turns) {
  if (!turns) return 'unavailable';
  if (billable <= 0) return 'not_applicable';
  return measured >= billable ? 'measured' : measured > 0 ? 'partially_measured' : 'unavailable';
}
function sumKnown(...values) {
  const known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}
function getTokenHistory({ groupBy = 'month', projectId = null, modelId = null, chatId = null, months = getRetention() } = {}, now = new Date()) {
  validateMonths(months);
  if (!['week', 'month'].includes(groupBy)) throw new TypeError('Invalid grouping.');
  for (const [label, value] of [['project ID', projectId], ['model ID', modelId], ['chat ID', chatId]]) {
    if (value !== null && typeof value !== 'string') throw new TypeError(`Invalid ${label}.`);
  }
  const retentionMonths = getRetention();
  months = Math.min(months, retentionMonths);
  prune(now);
  const from = cutoff(months, now), to = new Date(now).toISOString();
  const bucket = groupBy === 'month' ? "strftime('%Y-%m-01', timestamp)" : "date(timestamp, '-' || ((CAST(strftime('%w', timestamp) AS INTEGER) + 6) % 7) || ' days')";
  const filters = ['timestamp >= ?', 'timestamp <= ?'];
  const filterValues = [from, to];
  for (const [column, value] of [['project_id', projectId], ['model_id', modelId], ['chat_id', chatId]]) {
    if (value !== null) { filters.push(`${column} = ?`); filterValues.push(value); }
  }
  const where = filters.join(' AND ');
  const rows = db.prepare(`SELECT ${bucket} AS period,
      SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens, COUNT(*) AS turns,
      SUM(uncached_input_tokens) AS uncachedInputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_creation_tokens) AS cacheCreationTokens,
      SUM(reasoning_tokens) AS reasoningTokens,
      SUM(visible_output_tokens) AS visibleOutputTokens,
      COUNT(uncached_input_tokens) AS uncachedMeasuredTurns,
      COUNT(cache_read_tokens) AS cacheReadMeasuredTurns,
      COUNT(cache_creation_tokens) AS cacheCreationMeasuredTurns,
      COUNT(reasoning_tokens) AS reasoningMeasuredTurns,
      SUM(cost_total) AS costTotal, COUNT(cost_total) AS costMeasuredTurns,
      SUM(cost_cache_savings) AS costCacheSavings, COUNT(cost_cache_savings) AS costSavingsMeasuredTurns,
      SUM(cost_provider_reported) AS costProviderReported, COUNT(cost_provider_reported) AS costProviderReportedTurns,
      SUM(CASE WHEN cost_completeness = 'not_applicable' THEN 1 ELSE 0 END) AS costNotApplicableTurns,
      SUM(cost_uncached_input) AS costUncachedInput, SUM(cost_cache_read) AS costCacheRead,
      SUM(cost_cache_write) AS costCacheWrite, SUM(cost_output) AS costOutput
    FROM token_usage WHERE ${where} GROUP BY period ORDER BY period`)
    .all(...filterValues);
  const byPeriod = new Map(rows.map(row => [row.period, {
    ...row,
    subagentRuns: 0, subagentCostTotal: null, subagentCostMeasuredTurns: 0,
    subagentCostSavings: null, subagentSavingsMeasuredTurns: 0, subagentNotApplicableTurns: 0,
    cacheReadCoverage: coverageOf(row.cacheReadMeasuredTurns, row.turns),
    cacheCreationCoverage: coverageOf(row.cacheCreationMeasuredTurns, row.turns),
    uncachedInputCoverage: coverageOf(row.uncachedMeasuredTurns, row.turns),
    reasoningCoverage: coverageOf(row.reasoningMeasuredTurns, row.turns),
  }]));
  // Sub-agent child runs are attributed to their parent session, so a parent's
  // history includes its children's cost exactly once. Rows are upserted per
  // child (resumed/recovered runs update the same row), so continuation can
  // never double-count. Child tokens are intentionally not folded into the
  // parent's token columns; only cost is merged.
  const childBucket = bucket.replace(/timestamp/g, 'r.completed_at');
  const childFilters = ['r.completed_at IS NOT NULL', 'r.completed_at >= ?', 'r.completed_at <= ?'];
  const childValues = [from, to];
  if (projectId !== null) { childFilters.push('s.project_id = ?'); childValues.push(projectId); }
  if (chatId !== null) { childFilters.push('r.parent_session_id = ?'); childValues.push(chatId); }
  if (modelId !== null) { childFilters.push('r.model = ?'); childValues.push(modelId); }
  const childRows = db.prepare(`SELECT ${childBucket} AS period, COUNT(*) AS subagentRuns,
      SUM(r.cost_total) AS subagentCostTotal, COUNT(r.cost_total) AS subagentCostMeasuredTurns,
      SUM(r.cost_cache_savings) AS subagentCostSavings, COUNT(r.cost_cache_savings) AS subagentSavingsMeasuredTurns,
      SUM(CASE WHEN r.cost_completeness = 'not_applicable' THEN 1 ELSE 0 END) AS subagentNotApplicableTurns
    FROM subagent_runs r JOIN sessions s ON s.id = r.parent_session_id
    WHERE ${childFilters.join(' AND ')} GROUP BY period ORDER BY period`).all(...childValues);
  for (const child of childRows) {
    const existing = byPeriod.get(child.period);
    if (existing) { mergeChildCost(existing, child); continue; }
    // A period with only child runs still reports a real cost total; token
    // columns stay zero because they describe parent turns only.
    const row = emptyBucket(child.period);
    row.subagentRuns = child.subagentRuns ?? 0;
    row.subagentCostTotal = child.subagentCostTotal ?? null;
    row.subagentCostMeasuredTurns = child.subagentCostMeasuredTurns ?? 0;
    row.subagentCostSavings = child.subagentCostSavings ?? null;
    row.subagentSavingsMeasuredTurns = child.subagentSavingsMeasuredTurns ?? 0;
    row.subagentNotApplicableTurns = child.subagentNotApplicableTurns ?? 0;
    byPeriod.set(child.period, row);
  }
  for (const row of byPeriod.values()) finalizeCost(row);
  const cursor = new Date(from); cursor.setUTCHours(0, 0, 0, 0);
  if (groupBy === 'month') cursor.setUTCDate(1);
  else cursor.setUTCDate(cursor.getUTCDate() - (cursor.getUTCDay() + 6) % 7);
  const data = [];
  while (cursor <= new Date(now)) {
    const period = cursor.toISOString().slice(0, 10);
    data.push(byPeriod.get(period) || emptyBucket(period));
    if (groupBy === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  // Model identifiers already stored on the rows; legacy rows stay NULL and
  // are deliberately not guessed from the current session/model. Sub-agent
  // models are added so a child-only model remains filterable.
  const models = db.prepare(`SELECT model_id AS modelId, MIN(provider) AS provider, COUNT(*) AS turns,
      SUM(cost_total) AS costTotal, COUNT(cost_total) AS costMeasuredTurns
    FROM token_usage WHERE ${where} AND model_id IS NOT NULL
    GROUP BY model_id ORDER BY model_id`).all(...filterValues);
  const childModels = db.prepare(`SELECT r.model AS modelId, MIN(COALESCE(r.provider_id, r.provider)) AS provider, COUNT(*) AS turns,
      SUM(r.cost_total) AS costTotal, COUNT(r.cost_total) AS costMeasuredTurns
    FROM subagent_runs r JOIN sessions s ON s.id = r.parent_session_id
    WHERE ${childFilters.join(' AND ')} AND r.model IS NOT NULL GROUP BY r.model ORDER BY r.model`).all(...childValues);
  const mergedModels = new Map(models.map(row => [row.modelId, row]));
  for (const row of childModels) {
    const existing = mergedModels.get(row.modelId);
    if (existing) {
      existing.turns += row.turns;
      existing.costTotal = sumKnown(existing.costTotal, row.costTotal);
      existing.costMeasuredTurns += row.costMeasuredTurns ?? 0;
    } else mergedModels.set(row.modelId, row);
  }
  const modelList = [...mergedModels.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
  const costs = summarizeCosts(data);
  return { data, models: modelList, modelIds: modelList.map(row => row.modelId), costs, retentionMonths, months, groupBy, from, to };
}

function emptyBucket(period) {
  return { period, promptTokens: 0, completionTokens: 0, turns: 0,
    uncachedInputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    reasoningTokens: null, visibleOutputTokens: null,
    uncachedMeasuredTurns: 0, cacheReadMeasuredTurns: 0, cacheCreationMeasuredTurns: 0, reasoningMeasuredTurns: 0,
    cacheReadCoverage: 'unavailable', cacheCreationCoverage: 'unavailable',
    uncachedInputCoverage: 'unavailable', reasoningCoverage: 'unavailable',
    costTotal: null, costMeasuredTurns: 0, costCacheSavings: null, costSavingsMeasuredTurns: 0,
    costProviderReported: null, costProviderReportedTurns: 0, costNotApplicableTurns: 0,
    costUncachedInput: null, costCacheRead: null, costCacheWrite: null, costOutput: null,
    subagentRuns: 0, subagentCostTotal: null, subagentCostMeasuredTurns: 0,
    subagentCostSavings: null, subagentSavingsMeasuredTurns: 0, subagentNotApplicableTurns: 0 };
}
function mergeChildCost(row, child) {
  row.subagentRuns = child.subagentRuns ?? 0;
  row.subagentCostTotal = child.subagentCostTotal ?? null;
  row.subagentCostMeasuredTurns = child.subagentCostMeasuredTurns ?? 0;
  row.subagentCostSavings = child.subagentCostSavings ?? null;
  row.subagentSavingsMeasuredTurns = child.subagentSavingsMeasuredTurns ?? 0;
  row.subagentNotApplicableTurns = child.subagentNotApplicableTurns ?? 0;
}
function finalizeCost(row) {
  const parentBillable = Math.max(0, (row.turns ?? 0) - (row.costNotApplicableTurns ?? 0));
  const childBillable = Math.max(0, (row.subagentRuns ?? 0) - (row.subagentNotApplicableTurns ?? 0));
  row.costTotal = sumKnown(row.costTotal, row.subagentCostTotal);
  row.costMeasuredTurns = (row.costMeasuredTurns ?? 0) + (row.subagentCostMeasuredTurns ?? 0);
  row.costCacheSavings = sumKnown(row.costCacheSavings, row.subagentCostSavings);
  row.costSavingsMeasuredTurns = (row.costSavingsMeasuredTurns ?? 0) + (row.subagentSavingsMeasuredTurns ?? 0);
  row.costNotApplicableTurns = (row.costNotApplicableTurns ?? 0) + (row.subagentNotApplicableTurns ?? 0);
  row.billableTurns = parentBillable + childBillable;
  row.costCoverage = costCoverageOf(row.costMeasuredTurns, row.billableTurns, (row.turns ?? 0) + (row.subagentRuns ?? 0));
  row.costSavingsCoverage = costCoverageOf(row.costSavingsMeasuredTurns, row.billableTurns, (row.turns ?? 0) + (row.subagentRuns ?? 0));
  return row;
}
function summarizeCosts(data) {
  let total = null, savings = null, providerReported = null;
  let measured = 0, savingsMeasured = 0, billable = 0, notApplicable = 0, turns = 0;
  for (const row of data) {
    total = sumKnown(total, row.costTotal);
    savings = sumKnown(savings, row.costCacheSavings);
    providerReported = sumKnown(providerReported, row.costProviderReported);
    measured += row.costMeasuredTurns ?? 0;
    savingsMeasured += row.costSavingsMeasuredTurns ?? 0;
    billable += row.billableTurns ?? 0;
    notApplicable += row.costNotApplicableTurns ?? 0;
    turns += (row.turns ?? 0) + (row.subagentRuns ?? 0);
  }
  return { total, savings, providerReported, measuredTurns: measured, savingsMeasuredTurns: savingsMeasured,
    billableTurns: billable, notApplicableTurns: notApplicable, turns,
    currency: 'USD',
    coverage: costCoverageOf(measured, billable, turns),
    savingsCoverage: costCoverageOf(savingsMeasured, billable, turns) };
}
module.exports = { logTokenUsage, getTokenHistory, getRetention, setRetention };
