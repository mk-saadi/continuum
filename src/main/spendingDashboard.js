'use strict';

// Phase 2.0D: read-only cloud spending and usage dashboard data access.
//
// This module deliberately does NOT estimate costs. Every monetary value it
// returns is an aggregation of the cost evidence Phase 2.0C-3 already persisted
// on `token_usage` and `subagent_runs`. Historical rows keep the rates and
// source they were priced with; the newest catalog is never applied backwards.
//
// All queries are parameterized SELECTs. Nothing here performs inference,
// network access, or writes. Filtering, grouping, and pagination happen in
// SQLite so the renderer never receives the full usage history.

const pricing = require('../lib/cloudPricing.cjs');

const RANGES = new Set(['7d', '30d', '90d', 'all', 'custom']);
const GROUPS = new Set(['day', 'week', 'month']);
const ATTRIBUTION_GROUPS = new Set(['chat', 'workspace', 'agent', 'provider', 'model']);
const MAX_PERIODS = 1200;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;
const PROVIDER_SEPARATOR = '\u001f';

const FAMILY_LABELS = Object.freeze({
  anthropic: 'Direct Anthropic',
  openai: 'Direct OpenAI',
  openrouter: 'OpenRouter',
  custom: 'Custom provider',
  unknown: 'Unknown route',
  local: 'Local inference',
});

const PRICING_KIND = Object.freeze({
  'provider-reported': 'Authoritative provider charge',
  'anthropic-catalog': 'Verified catalog rate',
  'openai-catalog': 'Verified catalog rate',
  'openrouter-metadata': 'Provider metadata rate',
  'user-configured': 'User-configured rate',
  unavailable: 'Unavailable',
  'not-applicable': 'Not applicable',
});

function typeError(message) {
  throw new TypeError(message);
}

function optionalId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) {
    typeError(`Invalid ${label}.`);
  }
  return value;
}

function parseBoundary(value, label, endOfDay = false) {
  if (typeof value !== 'string' || !value.trim()) typeError(`Enter the ${label}.`);
  const text = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  if (Number.isNaN(date.getTime())) typeError(`Invalid ${label}.`);
  return date.toISOString();
}

function defaultGroup(range) {
  if (range === '90d') return 'week';
  if (range === 'all') return 'month';
  return 'day';
}

function normalizeFilters(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    typeError('Invalid dashboard filters.');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) typeError('Invalid dashboard clock.');
  const range = input.range ?? '30d';
  if (!RANGES.has(range)) typeError('Invalid date range.');
  const groupBy = input.groupBy ?? defaultGroup(range);
  if (!GROUPS.has(groupBy)) typeError('Invalid grouping.');
  const providerId = optionalId(input.providerId, 'provider');
  const modelId = optionalId(input.modelId, 'model');
  const projectId = optionalId(input.projectId, 'workspace');
  const chatId = optionalId(input.chatId, 'chat');
  let from = null;
  let to = new Date(now).toISOString();
  if (range === 'custom') {
    from = parseBoundary(input.from, 'start date');
    to = parseBoundary(input.to, 'end date', true);
    if (from > to) typeError('The start date must be before the end date.');
  } else if (range !== 'all') {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - (days - 1));
    from = start.toISOString();
  }
  return { range, groupBy, providerId, modelId, projectId, chatId, from, to };
}

function validatePaging(input = {}) {
  const limit = input.limit === undefined ? DEFAULT_PAGE : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    typeError(`Limit must be an integer from 1 to ${MAX_PAGE}.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) typeError('Invalid pagination offset.');
  return { limit, offset };
}

function coverageOf(measured, total) {
  if (!total) return 'unavailable';
  return measured >= total ? 'measured' : measured > 0 ? 'partially_measured' : 'unavailable';
}

function costCoverageOf(measured, billable, turns) {
  if (!turns) return 'unavailable';
  if (billable <= 0) return 'not_applicable';
  return measured >= billable ? 'measured' : measured > 0 ? 'partially_measured' : 'unavailable';
}

function providerReportedCoverageOf(measured, billable, turns) {
  if (!turns) return 'unavailable';
  if (billable <= 0) return 'not_applicable';
  return coverageOf(measured, billable);
}

function estimatedCoverageOf(estimatedTurns, billableTurns, turns) {
  if (!turns) return 'unavailable';
  if (!billableTurns) return 'not_applicable';
  // Every billable turn has an authoritative provider charge, so no rate-based
  // estimate was needed. That is not the same statement as a measured $0.00.
  if (estimatedTurns <= 0) return 'not_applicable';
  return estimatedTurns >= billableTurns ? 'measured' : 'partially_measured';
}

function dataCompletenessOf({ turns, billableTurns, costMeasuredTurns, authoritativeTurns }) {
  if (!turns) return 'unavailable';
  if (!billableTurns) return 'not_applicable';
  if (!costMeasuredTurns) return 'unavailable';
  if (costMeasuredTurns < billableTurns) return 'partially_estimated';
  if (authoritativeTurns >= costMeasuredTurns) return 'fully_measured';
  return 'estimated';
}

function catalog() {
  try {
    return require('./cloudProviders').getCloudProviders('text');
  } catch {
    return [];
  }
}

function providerDescriptor(providerId, providers = []) {
  if (providerId === 'local') {
    return { providerId: 'local', providerLabel: 'Local models', providerFamily: 'local', providerFamilyLabel: FAMILY_LABELS.local, configured: false };
  }
  if (!providerId || providerId === 'unattributed') {
    return { providerId: 'unattributed', providerLabel: 'Unattributed', providerFamily: 'unknown', providerFamilyLabel: FAMILY_LABELS.unknown, configured: false };
  }
  const row = providers.find(provider => provider.id === providerId);
  if (!row) {
    return {
      providerId,
      providerLabel: `Unrecognized provider (${providerId.slice(0, 8)}${providerId.length > 8 ? '…' : ''})`,
      providerFamily: 'unknown',
      providerFamilyLabel: FAMILY_LABELS.unknown,
      configured: false,
    };
  }
  const family = pricing.detectRoute({ apiType: row.apiType, baseUrl: row.baseUrl });
  return {
    providerId,
    providerLabel: row.name || providerId,
    providerFamily: family,
    providerFamilyLabel: FAMILY_LABELS[family] ?? FAMILY_LABELS.unknown,
    configured: row.configured !== false,
  };
}

const parentProvider = "COALESCE(t.provider, 'unattributed')";
const childProvider = "CASE WHEN r.provider = 'local' THEN 'local' WHEN r.provider_id IS NOT NULL AND r.provider_id <> '' THEN r.provider_id ELSE 'unattributed' END";

function buildUsageCte(filters) {
  const parentWhere = [];
  const parentValues = [];
  const childWhere = ['r.completed_at IS NOT NULL'];
  const childValues = [];

  if (filters.from) {
    parentWhere.push('t.timestamp >= ?');
    parentValues.push(filters.from);
    childWhere.push('r.completed_at >= ?');
    childValues.push(filters.from);
  }
  parentWhere.push('t.timestamp <= ?');
  parentValues.push(filters.to);
  childWhere.push('r.completed_at <= ?');
  childValues.push(filters.to);

  if (filters.providerId) {
    parentWhere.push(`${parentProvider} = ?`);
    parentValues.push(filters.providerId);
    childWhere.push(`${childProvider} = ?`);
    childValues.push(filters.providerId);
  }
  if (filters.modelId) {
    parentWhere.push('t.model_id = ?');
    parentValues.push(filters.modelId);
    childWhere.push('r.model = ?');
    childValues.push(filters.modelId);
  }
  if (filters.projectId) {
    parentWhere.push('COALESCE(t.project_id, s.project_id) = ?');
    parentValues.push(filters.projectId);
    childWhere.push('s.project_id = ?');
    childValues.push(filters.projectId);
  }
  if (filters.chatId) {
    parentWhere.push('t.chat_id = ?');
    parentValues.push(filters.chatId);
    childWhere.push('r.parent_session_id = ?');
    childValues.push(filters.chatId);
  }

  const childJson = path => `CASE WHEN json_valid(r.accounting_json) THEN json_extract(r.accounting_json, '${path}') END`;

  const sql = `WITH usage AS (
    SELECT
      t.timestamp AS occurred_at,
      ${parentProvider} AS provider_id,
      t.model_id AS model_id,
      COALESCE(t.project_id, s.project_id) AS project_id,
      p.name AS project_name,
      t.chat_id AS chat_id,
      s.title AS chat_title,
      s.agent_profile AS agent_profile,
      NULL AS agent_name,
      'turn' AS kind,
      t.prompt_tokens AS prompt_tokens,
      t.completion_tokens AS completion_tokens,
      t.cache_read_tokens AS cache_read_tokens,
      t.cache_creation_tokens AS cache_creation_tokens,
      t.uncached_input_tokens AS uncached_input_tokens,
      t.reasoning_tokens AS reasoning_tokens,
      NULL AS recorded_total_tokens,
      t.cost_total AS cost_total,
      t.cost_provider_reported AS cost_provider_reported,
      t.cost_currency AS cost_currency,
      t.cost_status AS cost_status,
      t.cost_completeness AS cost_completeness,
      t.cost_source AS cost_source,
      t.cost_version AS cost_version,
      t.cost_timestamp AS cost_timestamp,
      t.cost_uncached_input AS cost_uncached_input,
      t.cost_cache_read AS cost_cache_read,
      t.cost_cache_write AS cost_cache_write,
      t.cost_cache_write_1h AS cost_cache_write_1h,
      t.cost_output AS cost_output,
      t.cost_reasoning AS cost_reasoning,
      t.cost_cache_savings AS cost_cache_savings,
      t.cost_breakdown AS cost_breakdown
    FROM token_usage t
    LEFT JOIN sessions s ON s.id = t.chat_id
    LEFT JOIN projects p ON p.id = COALESCE(t.project_id, s.project_id)
    WHERE ${parentWhere.join(' AND ')}
    UNION ALL
    SELECT
      r.completed_at AS occurred_at,
      ${childProvider} AS provider_id,
      r.model AS model_id,
      s.project_id AS project_id,
      p.name AS project_name,
      r.parent_session_id AS chat_id,
      s.title AS chat_title,
      s.agent_profile AS agent_profile,
      r.agent_name AS agent_name,
      'subagent' AS kind,
      ${childJson('$.inputTokens')} AS prompt_tokens,
      ${childJson('$.outputTokens')} AS completion_tokens,
      ${childJson('$.cacheReadTokens')} AS cache_read_tokens,
      NULL AS cache_creation_tokens,
      NULL AS uncached_input_tokens,
      ${childJson('$.reasoningTokens')} AS reasoning_tokens,
      r.total_tokens AS recorded_total_tokens,
      r.cost_total AS cost_total,
      r.cost_provider_reported AS cost_provider_reported,
      r.cost_currency AS cost_currency,
      r.cost_status AS cost_status,
      r.cost_completeness AS cost_completeness,
      r.cost_source AS cost_source,
      r.cost_version AS cost_version,
      r.cost_timestamp AS cost_timestamp,
      r.cost_uncached_input AS cost_uncached_input,
      r.cost_cache_read AS cost_cache_read,
      r.cost_cache_write AS cost_cache_write,
      r.cost_cache_write_1h AS cost_cache_write_1h,
      r.cost_output AS cost_output,
      r.cost_reasoning AS cost_reasoning,
      r.cost_cache_savings AS cost_cache_savings,
      r.cost_breakdown AS cost_breakdown
    FROM subagent_runs r
    LEFT JOIN sessions s ON s.id = r.parent_session_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE ${childWhere.join(' AND ')}
  )`;

  return { sql, values: [...parentValues, ...childValues] };
}

// Every aggregate below is over the same unified row set: one row per parent
// turn plus one row per completed sub-agent run. A child is never folded into a
// parent token_usage row, so there is exactly one row per billed execution.
function aggregateSelect() {
  return `COUNT(*) AS turns,
    SUM(CASE WHEN provider_id = 'local' THEN 1 ELSE 0 END) AS localTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN 1 ELSE 0 END) AS billableTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN prompt_tokens END) AS inputTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN prompt_tokens END) AS inputMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN completion_tokens END) AS outputTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN completion_tokens END) AS outputMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN cache_read_tokens END) AS cachedInputTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN cache_read_tokens END) AS cacheReadMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN cache_creation_tokens END) AS cacheWriteTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN cache_creation_tokens END) AS cacheWriteMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN uncached_input_tokens END) AS uncachedInputTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN uncached_input_tokens END) AS uncachedMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN reasoning_tokens END) AS reasoningTokens,
    COUNT(CASE WHEN provider_id <> 'local' THEN reasoning_tokens END) AS reasoningMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN COALESCE(prompt_tokens + completion_tokens, recorded_total_tokens) END) AS totalTokens,
    COUNT(CASE WHEN provider_id <> 'local' AND COALESCE(prompt_tokens + completion_tokens, recorded_total_tokens) IS NOT NULL THEN 1 END) AS totalTokensMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_total END) AS totalCost,
    SUM(CASE WHEN provider_id <> 'local' AND (cost_source IS NULL OR cost_source <> 'provider-reported') THEN cost_total END) AS estimatedCost,
    SUM(CASE WHEN provider_id <> 'local' AND cost_source = 'provider-reported' THEN cost_total END) AS authoritativeCost,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_provider_reported END) AS providerReported,
    COUNT(CASE WHEN provider_id <> 'local' THEN cost_total END) AS costMeasuredTurns,
    COUNT(CASE WHEN provider_id <> 'local' AND cost_source = 'provider-reported' AND cost_total IS NOT NULL THEN 1 END) AS authoritativeTurns,
    COUNT(CASE WHEN provider_id <> 'local' THEN cost_provider_reported END) AS providerReportedTurns,
    COUNT(CASE WHEN provider_id <> 'local' AND cost_completeness = 'partial' THEN 1 END) AS costPartialTurns,
    COUNT(CASE WHEN cost_completeness = 'not_applicable' THEN 1 END) AS notApplicableTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_cache_savings END) AS cacheSavings,
    COUNT(CASE WHEN provider_id <> 'local' THEN cost_cache_savings END) AS savingsMeasuredTurns,
    SUM(CASE WHEN provider_id <> 'local' THEN COALESCE(cost_cache_write, 0) + COALESCE(cost_cache_write_1h, 0) END) AS cacheWriteCost,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_uncached_input END) AS costUncachedInput,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_cache_read END) AS costCacheRead,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_cache_write END) AS costCacheWriteComponent,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_cache_write_1h END) AS costCacheWrite1hComponent,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_output END) AS costOutput,
    SUM(CASE WHEN provider_id <> 'local' THEN cost_reasoning END) AS costReasoning,
    COUNT(DISTINCT CASE WHEN provider_id <> 'local' AND model_id IS NOT NULL THEN provider_id || char(31) || model_id END) AS modelsUsed`;
}

function finalizeAggregate(row = {}) {
  const turns = row.turns ?? 0;
  const billableTurns = row.billableTurns ?? 0;
  const costMeasuredTurns = row.costMeasuredTurns ?? 0;
  const authoritativeTurns = row.authoritativeTurns ?? 0;
  const estimatedTurns = Math.max(0, costMeasuredTurns - authoritativeTurns);
  const savingsMeasuredTurns = row.savingsMeasuredTurns ?? 0;
  const cacheReadCoverage = coverageOf(row.cacheReadMeasuredTurns ?? 0, billableTurns);
  const cacheWriteCoverage = coverageOf(row.cacheWriteMeasuredTurns ?? 0, billableTurns);
  const cacheHitRatio = cacheReadCoverage === 'measured' && typeof row.cachedInputTokens === 'number'
    && typeof row.inputTokens === 'number' && row.inputTokens > 0
    ? row.cachedInputTokens / row.inputTokens * 100 : null;
  return {
    ...row,
    turns,
    billableTurns,
    localTurns: row.localTurns ?? 0,
    costMeasuredTurns,
    authoritativeTurns,
    estimatedTurns,
    costPartialTurns: row.costPartialTurns ?? 0,
    notApplicableTurns: row.notApplicableTurns ?? 0,
    unknownCostTurns: Math.max(0, billableTurns - costMeasuredTurns),
    currency: row.costCurrency ?? 'USD',
    costCoverage: costCoverageOf(costMeasuredTurns, billableTurns, turns),
    providerReportedCoverage: providerReportedCoverageOf(authoritativeTurns, billableTurns, turns),
    estimatedCoverage: estimatedCoverageOf(estimatedTurns, billableTurns, turns),
    dataCompleteness: dataCompletenessOf({ turns, billableTurns, costMeasuredTurns, authoritativeTurns }),
    savingsCoverage: costCoverageOf(savingsMeasuredTurns, billableTurns, turns),
    cacheReadCoverage,
    cacheWriteCoverage,
    uncachedInputCoverage: coverageOf(row.uncachedMeasuredTurns ?? 0, billableTurns),
    reasoningCoverage: coverageOf(row.reasoningMeasuredTurns ?? 0, billableTurns),
    inputCoverage: coverageOf(row.inputMeasuredTurns ?? 0, billableTurns),
    outputCoverage: coverageOf(row.outputMeasuredTurns ?? 0, billableTurns),
    totalTokensCoverage: coverageOf(row.totalTokensMeasuredTurns ?? 0, billableTurns),
    cacheHitRatio,
    combinedSpend: row.totalCost ?? null,
    estimatedSpend: row.estimatedCost ?? null,
    // An authoritative source's amount is the total persisted with that row.
    // Fall back to the separate provider-reported field for legacy evidence.
    providerReportedSpend: typeof row.authoritativeCost === 'number'
      ? row.authoritativeCost
      : row.providerReported ?? null,
  };
}

function bucketExpression(groupBy) {
  if (groupBy === 'day') return "strftime('%Y-%m-%d', occurred_at)";
  if (groupBy === 'week') return "date(occurred_at, '-' || ((CAST(strftime('%w', occurred_at) AS INTEGER) + 6) % 7) || ' days')";
  return "strftime('%Y-%m-01', occurred_at)";
}

function alignStart(iso, groupBy) {
  const date = new Date(iso);
  date.setUTCHours(0, 0, 0, 0);
  if (groupBy === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (groupBy === 'month') date.setUTCDate(1);
  return date;
}

function advance(date, groupBy) {
  if (groupBy === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else if (groupBy === 'week') date.setUTCDate(date.getUTCDate() + 7);
  else date.setUTCDate(date.getUTCDate() + 1);
}

function emptyPeriod(period) {
  return {
    period,
    turns: 0,
    billableTurns: 0,
    localTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    reasoningTokens: 0,
    totalCost: null,
    estimatedCost: null,
    providerReported: null,
    authoritativeCost: null,
    cacheSavings: null,
    combinedSpend: null,
    estimatedSpend: null,
    providerReportedSpend: null,
    costMeasuredTurns: 0,
    providerReportedTurns: 0,
    notApplicableTurns: 0,
    costCoverage: 'unavailable',
    providerReportedCoverage: 'unavailable',
    estimatedTurns: 0,
    estimatedCoverage: 'unavailable',
    dataCompleteness: 'unavailable',
    cacheReadCoverage: 'unavailable',
    currency: 'USD',
  };
}

function timelineRows(sql, values, filters) {
  const buckets = db().prepare(`${sql} SELECT ${bucketExpression(filters.groupBy)} AS period, ${aggregateSelect()}
    FROM usage GROUP BY period ORDER BY period`).all(...values);
  const byPeriod = new Map(buckets.map(row => [row.period, finalizeAggregate(row)]));
  let first = filters.from;
  if (!first) {
    const row = db().prepare(`${sql} SELECT MIN(occurred_at) AS first FROM usage`).get(...values);
    first = row?.first ?? null;
  }
  if (!first) return [];
  const cursor = alignStart(first, filters.groupBy);
  const end = new Date(filters.to);
  const data = [];
  while (cursor <= end) {
    const period = cursor.toISOString().slice(0, 10);
    data.push(byPeriod.get(period) ?? emptyPeriod(period));
    if (data.length > MAX_PERIODS) {
      typeError('Date range and grouping produce too many periods; choose a coarser grouping.');
    }
    advance(cursor, filters.groupBy);
  }
  return data;
}

function modelRows(sql, values, providers) {
  const rows = db().prepare(`${sql} SELECT provider_id, model_id, ${aggregateSelect()}
    FROM usage GROUP BY provider_id, model_id`).all(...values);
  return rows.map(row => {
    const provider = providerDescriptor(row.provider_id, providers);
    return {
      ...finalizeAggregate(row),
      key: `${row.provider_id}${PROVIDER_SEPARATOR}${row.model_id ?? ''}`,
      modelId: row.model_id ?? null,
      providerId: row.provider_id,
      providerLabel: provider.providerLabel,
      providerFamily: provider.providerFamily,
      providerFamilyLabel: provider.providerFamilyLabel,
      modelLabel: row.model_id ?? 'Unknown model',
    };
  }).sort((left, right) => {
    const leftCost = typeof left.combinedSpend === 'number' ? left.combinedSpend : -1;
    const rightCost = typeof right.combinedSpend === 'number' ? right.combinedSpend : -1;
    return rightCost - leftCost || (left.modelId ?? '').localeCompare(right.modelId ?? '') || left.providerId.localeCompare(right.providerId);
  });
}

function providerRows(sql, values, providers) {
  const rows = db().prepare(`${sql} SELECT provider_id, ${aggregateSelect()}
    FROM usage GROUP BY provider_id`).all(...values);
  return rows.map(row => {
    const provider = providerDescriptor(row.provider_id, providers);
    return {
      ...finalizeAggregate(row),
      providerId: row.provider_id,
      providerLabel: provider.providerLabel,
      providerFamily: provider.providerFamily,
      providerFamilyLabel: provider.providerFamilyLabel,
    };
  }).sort((left, right) => {
    const leftCost = typeof left.combinedSpend === 'number' ? left.combinedSpend : -1;
    const rightCost = typeof right.combinedSpend === 'number' ? right.combinedSpend : -1;
    return rightCost - leftCost || left.providerLabel.localeCompare(right.providerLabel);
  });
}

function filterOptions(sql, values, providers) {
  const usageFilters = db().prepare(`${sql} SELECT provider_id, COUNT(*) AS turns FROM usage
    GROUP BY provider_id ORDER BY provider_id`).all(...values);
  const modelFilters = db().prepare(`${sql} SELECT provider_id, model_id, COUNT(*) AS turns FROM usage
    WHERE model_id IS NOT NULL GROUP BY provider_id, model_id ORDER BY model_id`).all(...values);
  const projectFilters = db().prepare(`${sql} SELECT project_id, MAX(project_name) AS name, COUNT(*) AS turns
    FROM usage WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY name`).all(...values);
  return {
    providers: usageFilters.map(row => {
      const provider = providerDescriptor(row.provider_id, providers);
      return { providerId: row.provider_id, label: provider.providerLabel, family: provider.providerFamily, familyLabel: provider.providerFamilyLabel, turns: row.turns };
    }),
    models: modelFilters.map(row => {
      const provider = providerDescriptor(row.provider_id, providers);
      return {
        modelId: row.model_id,
        providerId: row.provider_id,
        providerLabel: provider.providerLabel,
        label: row.model_id,
        turns: row.turns,
      };
    }),
    projects: projectFilters.map(row => ({ projectId: row.project_id, name: row.name || `Workspace ${row.project_id.slice(0, 8)}`, turns: row.turns })),
  };
}

function buildDashboard(filters, now, { includeOptions = true } = {}) {
  const { sql, values } = buildUsageCte(filters);
  const providers = catalog();
  const summary = finalizeAggregate(db().prepare(`${sql} SELECT ${aggregateSelect()} FROM usage`).get(...values));
  const timeline = timelineRows(sql, values, filters);
  const models = modelRows(sql, values, providers);
  const providerBreakdown = providerRows(sql, values, providers);
  // Filter choices stay stable while a provider/model/workspace filter is
  // active. Otherwise selecting one value would remove every alternative from
  // the same dropdown. Date bounds still apply.
  const optionFilters = { ...filters, providerId: null, modelId: null, projectId: null, chatId: null };
  const optionCte = includeOptions ? buildUsageCte(optionFilters) : null;
  const options = includeOptions
    ? filterOptions(optionCte.sql, optionCte.values, providers)
    : { providers: [], models: [], projects: [] };
  return {
    filters: {
      range: filters.range,
      groupBy: filters.groupBy,
      providerId: filters.providerId,
      modelId: filters.modelId,
      projectId: filters.projectId,
      chatId: filters.chatId,
      from: filters.from,
      to: filters.to,
    },
    range: { from: filters.from, to: filters.to, groupBy: filters.groupBy, timezone: 'UTC' },
    summary,
    timeline,
    models,
    providers: providerBreakdown,
    filterOptions: options,
  };
}

function getDashboard(input = {}, now = new Date()) {
  const filters = normalizeFilters(input, now);
  return buildDashboard(filters, now);
}

function getAttribution(input = {}, now = new Date()) {
  const groupBy = input.groupBy ?? 'chat';
  if (!ATTRIBUTION_GROUPS.has(groupBy)) typeError('Invalid attribution grouping.');
  const filters = normalizeFilters({ ...input, groupBy: filtersGroup(input) }, now);
  const { sql, values } = buildUsageCte(filters);
  const providers = catalog();
  let keyExpression;
  let labelExpression;
  let dimensionExpression;
  if (groupBy === 'chat') {
    keyExpression = "COALESCE(chat_id, 'unattributed')";
    labelExpression = "MAX(chat_title) AS group_label";
    dimensionExpression = 'NULL AS provider_id, NULL AS model_id';
  } else if (groupBy === 'workspace') {
    keyExpression = "COALESCE(project_id, 'unattributed')";
    labelExpression = "MAX(project_name) AS group_label";
    dimensionExpression = 'NULL AS provider_id, NULL AS model_id';
  } else if (groupBy === 'agent') {
    keyExpression = "CASE WHEN kind = 'subagent' THEN 'subagent:' || COALESCE(agent_name, 'Subagent') ELSE 'main' END";
    labelExpression = "MAX(CASE WHEN kind = 'subagent' THEN agent_name ELSE NULL END) AS group_label";
    dimensionExpression = 'NULL AS provider_id, NULL AS model_id';
  } else if (groupBy === 'provider') {
    keyExpression = 'provider_id';
    labelExpression = 'NULL AS group_label';
    dimensionExpression = 'provider_id AS provider_id, NULL AS model_id';
  } else {
    keyExpression = `provider_id || char(31) || COALESCE(model_id, 'unknown')`;
    labelExpression = 'MAX(model_id) AS group_label';
    dimensionExpression = 'MIN(provider_id) AS provider_id, MAX(model_id) AS model_id';
  }
  const rows = db().prepare(`${sql} SELECT ${keyExpression} AS group_key, ${labelExpression},
      ${dimensionExpression}, ${aggregateSelect()}
    FROM usage GROUP BY group_key`).all(...values);
  const decorated = rows.map(row => {
    const aggregate = finalizeAggregate(row);
    const provider = providerDescriptor(row.provider_id, providers);
    let label;
    if (groupBy === 'chat') {
      label = row.group_key === 'unattributed' ? 'Unattributed'
        : row.group_label || `Deleted or unnamed chat (${row.group_key.slice(0, 8)}…)`;
    } else if (groupBy === 'workspace') {
      label = row.group_key === 'unattributed' ? 'Unattributed'
        : row.group_label || `Deleted workspace (${row.group_key.slice(0, 8)}…)`;
    } else if (groupBy === 'agent') {
      label = row.group_key === 'main' ? 'Main agent' : `Subagent · ${row.group_label || 'Unnamed subagent'}`;
    } else if (groupBy === 'provider') {
      label = provider.providerLabel;
    } else {
      label = row.group_label || 'Unknown model';
    }
    return {
      ...aggregate,
      key: row.group_key,
      label,
      group: groupBy,
      providerId: row.provider_id,
      providerLabel: provider.providerLabel,
      providerFamily: provider.providerFamily,
      providerFamilyLabel: provider.providerFamilyLabel,
      modelId: row.model_id ?? null,
      modelLabel: row.model_id ?? 'Unknown model',
    };
  }).sort((left, right) => {
    const leftCost = typeof left.combinedSpend === 'number' ? left.combinedSpend : -1;
    const rightCost = typeof right.combinedSpend === 'number' ? right.combinedSpend : -1;
    return rightCost - leftCost || left.label.localeCompare(right.label);
  });
  return { groupBy, rows: decorated };
}

function filtersGroup(input) {
  // The dashboard filter normalizer validates groupBy against day/week/month.
  // Attribution has its own grouping vocabulary, so keep the time grouping
  // stable and independent of the selected attribution dimension.
  return input.groupBy && GROUPS.has(input.groupBy) ? input.groupBy : 'day';
}

function getRecords(input = {}, now = new Date()) {
  const filters = normalizeFilters(input, now);
  const { limit, offset } = validatePaging(input);
  const { sql, values } = buildUsageCte(filters);
  const providers = catalog();
  const totalRow = db().prepare(`${sql} SELECT COUNT(*) AS total FROM usage`).get(...values);
  const rows = db().prepare(`${sql} SELECT occurred_at, kind, chat_id, chat_title, project_id, project_name,
      provider_id, model_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens,
      uncached_input_tokens, reasoning_tokens,
      COALESCE(prompt_tokens + completion_tokens, recorded_total_tokens) AS total_tokens,
      cost_total, cost_provider_reported, cost_completeness, cost_source, cost_currency
    FROM usage ORDER BY occurred_at DESC, kind ASC LIMIT ? OFFSET ?`).all(...values, limit, offset);
  return {
    rows: rows.map(row => {
      const provider = providerDescriptor(row.provider_id, providers);
      return {
        ...row,
        providerLabel: provider.providerLabel,
        providerFamily: provider.providerFamily,
        providerFamilyLabel: provider.providerFamilyLabel,
        modelLabel: row.model_id ?? 'Unknown model',
        chatLabel: row.chat_title || (row.chat_id ? `Deleted or unnamed chat (${row.chat_id.slice(0, 8)}…)` : 'Unattributed'),
        workspaceLabel: row.project_name || (row.project_id ? `Deleted workspace (${row.project_id.slice(0, 8)}…)` : 'Unattributed'),
      };
    }),
    total: totalRow?.total ?? 0,
    limit,
    offset,
    hasMore: offset + rows.length < (totalRow?.total ?? 0),
  };
}

function getPricingHistory(input = {}, now = new Date()) {
  const filters = normalizeFilters(input, now);
  const { limit, offset } = validatePaging(input);
  const { sql, values } = buildUsageCte(filters);
  const providers = catalog();
  const totalRow = db().prepare(`${sql} SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM usage WHERE cost_breakdown IS NOT NULL
      GROUP BY provider_id, model_id, cost_source, cost_version, cost_currency, cost_breakdown
    )`).get(...values);
  const rows = db().prepare(`${sql} SELECT provider_id, model_id, cost_source, cost_version, cost_currency,
      cost_breakdown, MIN(cost_timestamp) AS first_seen, MAX(cost_timestamp) AS last_seen,
      COUNT(*) AS turns, SUM(CASE WHEN provider_id <> 'local' THEN cost_total END) AS recorded_cost
    FROM usage WHERE cost_breakdown IS NOT NULL
    GROUP BY provider_id, model_id, cost_source, cost_version, cost_currency, cost_breakdown
    ORDER BY last_seen DESC, model_id ASC LIMIT ? OFFSET ?`).all(...values, limit, offset);
  const total = totalRow?.total ?? 0;
  return {
    rows: rows.map((row, index) => {
      const provider = providerDescriptor(row.provider_id, providers);
      let breakdown = null;
      try { breakdown = row.cost_breakdown ? JSON.parse(row.cost_breakdown) : null; } catch { /* legacy or truncated */ }
      const rates = breakdown?.rates && typeof breakdown.rates === 'object' ? breakdown.rates : null;
      const source = row.cost_source || breakdown?.source || 'unavailable';
      return {
        key: `${row.provider_id}${PROVIDER_SEPARATOR}${row.model_id ?? ''}${PROVIDER_SEPARATOR}${source}${PROVIDER_SEPARATOR}${row.cost_version ?? ''}${PROVIDER_SEPARATOR}${offset + index}`,
        providerId: row.provider_id,
        providerLabel: provider.providerLabel,
        providerFamily: provider.providerFamily,
        providerFamilyLabel: provider.providerFamilyLabel,
        modelId: row.model_id ?? null,
        modelLabel: row.model_id ?? 'Unknown model',
        source,
        pricingKind: PRICING_KIND[source] ?? 'Pricing evidence',
        version: row.cost_version || breakdown?.version || null,
        currency: row.cost_currency || pricing.CURRENCY,
        rates: rates ? {
          input: finiteOrNull(rates.input),
          output: finiteOrNull(rates.output),
          cacheRead: finiteOrNull(rates.cacheRead),
          cacheWrite: finiteOrNull(rates.cacheWrite),
          cacheWrite1h: finiteOrNull(rates.cacheWrite1h),
        } : null,
        missing: Array.isArray(breakdown?.missing) ? breakdown.missing : [],
        firstSeen: row.first_seen ?? null,
        lastSeen: row.last_seen ?? null,
        // The schema records when an estimate was written, not a provider's
        // published effective date. Do not invent one.
        effectiveAt: null,
        turns: row.turns ?? 0,
        recordedCost: row.recorded_cost ?? null,
      };
    }),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getModelDetail(input = {}, now = new Date()) {
  const filters = normalizeFilters(input, now);
  if (!filters.modelId) typeError('Select a model to inspect.');
  const dashboard = buildDashboard(filters, now, { includeOptions: false });
  const model = dashboard.models.find(row => row.modelId === filters.modelId
    && (!filters.providerId || row.providerId === filters.providerId)) ?? null;
  const pricingHistory = getPricingHistory({ ...input, limit: Math.min(input.limit ?? 50, MAX_PAGE) }, now);
  return {
    filters: dashboard.filters,
    summary: dashboard.summary,
    timeline: dashboard.timeline,
    model,
    pricing: pricingHistory.rows,
  };
}

function db() {
  // Required lazily so importing this module in a test never opens a database.
  return require('./db').db;
}

module.exports = {
  normalizeFilters,
  getDashboard,
  getAttribution,
  getRecords,
  getPricingHistory,
  getModelDetail,
  providerDescriptor,
};
