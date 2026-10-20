'use strict';
// Phase 2.0D: deterministic tests for the read-only cloud spending dashboard's
// SQL aggregation, filters, attribution, pagination, pricing evidence, and
// honest unknown/local states. No network and no inference are involved.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spending-dashboard-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return { app: { isReady: () => true, getPath: () => directory, getName: () => 'continuum-test' } };
  }
  return originalLoad.call(this, name, ...args);
};

const { db, initDatabase, closeDatabase } = require('../src/main/db');
const { logTokenUsage } = require('../src/main/tokenUsage');
const dashboard = require('../src/main/spendingDashboard');
const now = new Date('2026-06-30T12:00:00Z');

function approx(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: value is numeric`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

function providers(rows) {
  db.prepare(`INSERT INTO app_settings(key, value_json) VALUES ('cloud-providers', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify(rows));
}

function addChildRun({
  id, parent, agent = 'Researcher', model = 'gpt-5', provider = 'cloud', providerId = 'openai-p',
  completedAt = '2026-06-20T10:01:00Z', input = 2000, output = 100, cacheRead = 500, reasoning = 20,
  total = 2100, costTotal = null, costSource = null, costCompleteness = null, costProviderReported = null,
  costBreakdown = null,
}) {
  db.prepare(`INSERT INTO subagent_runs (
      child_session_id, parent_session_id, agent_name, model, provider, provider_id, status,
      cost_total, cost_currency, cost_status, cost_completeness, cost_source, cost_version,
      cost_timestamp, cost_provider_reported, cost_breakdown, accounting_json, total_tokens,
      created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, parent, agent, model, provider, providerId,
      costTotal, costTotal == null ? null : 'USD', costTotal == null ? null : 'available',
      costCompleteness, costSource, costSource == null ? null : `${costSource}:test-1`,
      costTotal == null ? null : completedAt, costProviderReported,
      costBreakdown == null ? null : JSON.stringify(costBreakdown),
      JSON.stringify({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, reasoningTokens: reasoning }),
      total, completedAt, completedAt, completedAt, completedAt ?? '2026-06-25T00:00:00Z');
}

try {
  initDatabase(directory);

  // 1. Empty database: coverage is unavailable and spend is unknown, not zero.
  const empty = dashboard.getDashboard({ range: '30d' }, now);
  assert.equal(empty.summary.turns, 0);
  assert.equal(empty.summary.combinedSpend, null);
  assert.equal(empty.summary.costCoverage, 'unavailable');
  assert.equal(empty.summary.dataCompleteness, 'unavailable');
  assert.equal(empty.models.length, 0);
  assert.equal(empty.providers.length, 0);
  assert.equal(empty.timeline.length, 30);
  assert.ok(empty.timeline.every(row => row.turns === 0 && row.combinedSpend === null));
  assert.deepEqual(dashboard.getAttribution({ range: '30d', groupBy: 'chat' }, now).rows, []);
  assert.deepEqual(dashboard.getPricingHistory({ range: '30d' }, now).rows, []);

  // 2. Filter normalization is strict and defaults are stable.
  assert.deepEqual(dashboard.normalizeFilters({}, now), {
    range: '30d', groupBy: 'day', providerId: null, modelId: null, projectId: null, chatId: null,
    from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T12:00:00.000Z',
  });
  assert.equal(dashboard.normalizeFilters({ range: '90d' }, now).groupBy, 'week');
  assert.equal(dashboard.normalizeFilters({ range: 'all' }, now).groupBy, 'month');
  assert.equal(dashboard.normalizeFilters({ range: 'all' }, now).from, null);
  assert.throws(() => dashboard.normalizeFilters({ range: '1y' }, now), /Invalid date range/);
  assert.throws(() => dashboard.normalizeFilters({ groupBy: 'hour' }, now), /Invalid grouping/);
  assert.throws(() => dashboard.normalizeFilters({ providerId: 'x\0y' }, now), /Invalid provider/);
  assert.throws(() => dashboard.normalizeFilters({ projectId: 5 }, now), /Invalid workspace/);
  assert.throws(() => dashboard.normalizeFilters({ range: 'custom', from: 'not-a-date', to: '2026-06-10' }, now), /Invalid start date|Enter the start date/);
  assert.throws(() => dashboard.normalizeFilters({ range: 'custom', from: '2026-06-10' }, now), /Enter the end date/);
  assert.throws(() => dashboard.normalizeFilters({ range: 'custom', from: '2026-06-10', to: '2026-06-01' }, now), /start date must be before/);
  assert.throws(() => dashboard.getRecords({ limit: 0 }, now), /Limit must be an integer/);
  assert.throws(() => dashboard.getRecords({ limit: 101 }, now), /Limit must be an integer/);
  assert.throws(() => dashboard.getRecords({ offset: -1 }, now), /Invalid pagination offset/);

  // 3. A custom date-only range is interpreted as inclusive UTC days.
  const custom = dashboard.normalizeFilters({ range: 'custom', from: '2026-06-01', to: '2026-06-02' }, now);
  assert.equal(custom.from, '2026-06-01T00:00:00.000Z');
  assert.equal(custom.to, '2026-06-02T23:59:59.999Z');

  providers([
    { id: 'anthropic-p', category: 'text', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-5', apiType: 'anthropic', apiKey: 'x' },
    { id: 'or-p', category: 'text', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'vendor/model', apiType: 'openai', apiKey: 'x' },
    { id: 'openai-p', category: 'text', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5', apiType: 'openai', apiKey: 'x' },
  ]);
  db.prepare('INSERT INTO projects(id, name) VALUES (?, ?)').run('p1', 'Workspace one');
  db.prepare('INSERT INTO sessions(id, title, project_id) VALUES (?, ?, ?)').run('chat-1', 'Chat one', 'p1');
  db.prepare('INSERT INTO sessions(id, title) VALUES (?, ?)').run('chat-2', 'Chat two');

  const breakdown = rates => ({
    version: 'test-rate-v1', source: 'anthropic-catalog', completeness: 'complete',
    missing: [], rates: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite, cacheWrite1h: rates.cacheWrite1h ?? null },
  });

  // Parent turns. A local parent is "not applicable"; a legacy row with no cost
  // evidence is unknown and must never be counted as a measured zero.
  logTokenUsage({ turnId: 'a1', chatId: 'chat-1', projectId: 'p1', timestamp: '2026-06-02T00:00:00Z',
    promptTokens: 7000, completionTokens: 500, uncachedInputTokens: 4000, cacheReadTokens: 2500,
    cacheCreationTokens: 500, modelId: 'claude-sonnet-5', provider: 'anthropic-p',
    cacheReadCoverage: 'measured', cacheWriteCoverage: 'measured',
    cost: { total: 0.0101, currency: 'USD', completeness: 'complete', source: 'anthropic-catalog',
      version: 'anthropic-catalog:2026-04-01', timestamp: '2026-06-02T00:00:00Z', uncachedInput: 0.008,
      cacheRead: 0.0005, cacheWrite: 0.00125, output: 0.005, cacheSavings: 0.006,
      breakdown: breakdown({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 }) } }, now);
  logTokenUsage({ turnId: 'b1', chatId: 'chat-1', projectId: 'p1', timestamp: '2026-06-03T00:00:00Z',
    promptTokens: 1000, completionTokens: 50, modelId: 'llama-3', provider: 'local',
    cost: { total: null, completeness: 'not_applicable', source: 'not-applicable', status: 'not_applicable' } }, now);
  logTokenUsage({ turnId: 'c1', chatId: 'chat-1', projectId: 'p1', timestamp: '2026-06-04T00:00:00Z',
    promptTokens: 2000, completionTokens: 100, modelId: 'vendor/model', provider: 'or-p',
    cost: { total: 0.002, currency: 'USD', completeness: 'complete', source: 'provider-reported',
      version: 'provider-charge', timestamp: '2026-06-04T00:00:00Z', providerReported: 0.002,
      breakdown: { version: 'provider-charge', source: 'provider-reported', completeness: 'complete', missing: [], rates: null } } }, now);
  logTokenUsage({ turnId: 'd1', chatId: 'chat-2', timestamp: '2026-06-10T00:00:00Z',
    promptTokens: 3000, completionTokens: 300, modelId: 'gpt-5', provider: 'openai-p',
    cost: { total: 0.003, currency: 'USD', completeness: 'complete', source: 'user-configured',
      version: 'user-rates:1', timestamp: '2026-06-10T00:00:00Z',
      breakdown: breakdown({ input: 1, output: 10, cacheRead: null, cacheWrite: null }) } }, now);
  logTokenUsage({ turnId: 'e1', chatId: 'chat-2', timestamp: '2026-06-11T00:00:00Z',
    promptTokens: 400, completionTokens: 40, modelId: 'mystery-model', provider: 'unknown-p' }, now);
  logTokenUsage({ turnId: 'f1', chatId: 'chat-2', timestamp: '2026-06-12T00:00:00Z',
    promptTokens: 500, completionTokens: 50, modelId: 'claude-sonnet-5', provider: 'or-p',
    cost: { total: 0.001, currency: 'USD', completeness: 'complete', source: 'openrouter-metadata',
      version: 'openrouter-metadata:1', timestamp: '2026-06-12T00:00:00Z',
      breakdown: breakdown({ input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 }) } }, now);

  // Completed sub-agent runs are separate billed executions. The run with no
  // completed_at is unfinished and must be excluded.
  addChildRun({ id: 'child-1', parent: 'chat-1', agent: 'Researcher', model: 'gpt-5', providerId: 'openai-p',
    costTotal: 0.0025, costSource: 'provider-reported', costCompleteness: 'complete', costProviderReported: 0.0025 });
  addChildRun({ id: 'child-local', parent: 'chat-1', agent: 'Local Helper', model: 'llama-3', provider: 'local', providerId: null,
    input: 100, output: 10, cacheRead: null, reasoning: null, total: 110,
    costTotal: null, costSource: 'not-applicable', costCompleteness: 'not_applicable' });
  addChildRun({ id: 'child-2', parent: 'chat-2', agent: 'Writer', model: 'o4-mini', providerId: 'openai-p', completedAt: '2026-06-21T10:01:00Z',
    input: 800, output: 80, cacheRead: null, reasoning: null, total: 880,
    costTotal: 0.0015, costSource: 'openai-catalog', costCompleteness: 'complete',
    costBreakdown: breakdown({ input: 1, output: 10, cacheRead: null, cacheWrite: null }) });
  addChildRun({ id: 'child-unfinished', parent: 'chat-1', agent: 'Unfinished', completedAt: null, costTotal: 9 });

  const june = { range: 'custom', from: '2026-06-01', to: '2026-06-30' };
  const result = dashboard.getDashboard({ ...june, groupBy: 'day' }, now);
  const summary = result.summary;

  // 4. Parent turns and child runs each count exactly once.
  assert.equal(summary.turns, 9, 'six parent turns plus three completed child runs');
  assert.equal(summary.localTurns, 2, 'local parent and local child are usage-only');
  assert.equal(summary.billableTurns, 7);
  assert.equal(summary.costMeasuredTurns, 6, 'unfinished child and unpriced legacy turn are excluded');
  assert.equal(summary.unknownCostTurns, 1, 'a missing estimate is unknown, not zero');
  assert.equal(summary.authoritativeTurns, 2, 'two provider-reported rows');
  assert.equal(summary.estimatedTurns, 4);

  // 5. Estimated and authoritative spend stay separate; total is their sum.
  approx(summary.estimatedSpend, 0.0156, 'estimated spend');
  approx(summary.providerReportedSpend, 0.0045, 'provider-reported spend');
  approx(summary.combinedSpend, 0.0201, 'combined spend');
  assert.equal(summary.costCoverage, 'partially_measured');
  assert.equal(summary.providerReportedCoverage, 'partially_measured');
  assert.equal(summary.estimatedCoverage, 'partially_measured');
  assert.equal(summary.dataCompleteness, 'partially_estimated');
  assert.equal(summary.currency, 'USD');

  // 6. Token/cache analytics preserve measured zeros and unknown fields.
  assert.equal(summary.inputTokens, 15700);
  assert.equal(summary.outputTokens, 1170);
  assert.equal(summary.totalTokens, 16870);
  assert.equal(summary.cachedInputTokens, 3000);
  assert.equal(summary.cacheWriteTokens, 500);
  approx(summary.cacheSavings, 0.006, 'cache savings');
  assert.equal(summary.cacheReadCoverage, 'partially_measured');
  assert.equal(summary.reasoningCoverage, 'partially_measured');
  assert.equal(summary.cacheHitRatio, null, 'a mixed-coverage ratio is not shown as complete');

  // 7. Timeline buckets are UTC and zero-filled, including no-activity days.
  const daily = result.timeline;
  assert.equal(daily.length, 30);
  assert.equal(daily[0].period, '2026-06-01');
  assert.equal(daily[0].turns, 0);
  const day2 = daily.find(row => row.period === '2026-06-02');
  approx(day2.estimatedCost, 0.0101, 'day-two estimate');
  assert.equal(daily.find(row => row.period === '2026-06-03').localTurns, 1);
  assert.equal(daily.find(row => row.period === '2026-06-03').billableTurns, 0);
  approx(daily.find(row => row.period === '2026-06-10').totalCost, 0.003, 'day-ten total');
  const weekly = dashboard.getDashboard({ ...june, groupBy: 'week' }, now).timeline;
  assert.equal(weekly[0].period, '2026-06-01', 'weeks start Monday in UTC');
  const monthly = dashboard.getDashboard({ range: 'custom', from: '2026-05-15', to: '2026-07-02', groupBy: 'month' }, now).timeline;
  assert.deepEqual(monthly.map(row => row.period), ['2026-05-01', '2026-06-01', '2026-07-01']);

  // 8. Provider and model identities remain distinct.
  const modelKeys = result.models.map(row => `${row.providerId}:${row.modelId}`).sort();
  assert.deepEqual(modelKeys, [
    'anthropic-p:claude-sonnet-5', 'local:llama-3', 'openai-p:gpt-5', 'openai-p:o4-mini',
    'or-p:claude-sonnet-5', 'or-p:vendor/model', 'unknown-p:mystery-model',
  ]);
  const claudeRows = result.models.filter(row => row.modelId === 'claude-sonnet-5');
  assert.equal(claudeRows.length, 2, 'the same model routed through two providers is two identities');
  approx(claudeRows.find(row => row.providerId === 'anthropic-p').combinedSpend, 0.0101, 'anthropic claude spend');
  approx(claudeRows.find(row => row.providerId === 'or-p').combinedSpend, 0.001, 'openrouter claude spend');
  const localModel = result.models.find(row => row.providerId === 'local');
  assert.equal(localModel.costCoverage, 'not_applicable');
  assert.equal(localModel.combinedSpend, null, 'local has no cloud spend, not $0.00');
  assert.equal(localModel.turns, 2);
  const unpriced = result.models.find(row => row.modelId === 'mystery-model');
  assert.equal(unpriced.combinedSpend, null);
  assert.equal(unpriced.costCoverage, 'unavailable');
  assert.match(unpriced.providerLabel, /^Unrecognized provider \(unknown-/);

  // 9. Provider aggregation is cost-sorted and keeps local usage-only.
  assert.deepEqual(result.providers.map(row => row.providerId), ['anthropic-p', 'openai-p', 'or-p', 'local', 'unknown-p']);
  const localProvider = result.providers.find(row => row.providerId === 'local');
  assert.equal(localProvider.combinedSpend, null);
  assert.equal(localProvider.costCoverage, 'not_applicable');
  assert.equal(localProvider.turns, 2);

  // 10. Each filter narrows the same unified row set.
  assert.equal(dashboard.getDashboard({ ...june, providerId: 'anthropic-p' }, now).summary.turns, 1);
  assert.equal(dashboard.getDashboard({ ...june, modelId: 'gpt-5' }, now).summary.turns, 2);
  assert.equal(dashboard.getDashboard({ ...june, projectId: 'p1' }, now).summary.turns, 5);
  assert.equal(dashboard.getDashboard({ ...june, chatId: 'chat-2' }, now).summary.turns, 4);
  assert.equal(dashboard.getDashboard({ ...june, providerId: 'local' }, now).summary.costCoverage, 'not_applicable');
  assert.equal(dashboard.getDashboard({ ...june, providerId: 'local' }, now).summary.combinedSpend, null);

  // 11. Filter options stay stable while one of them is selected.
  const filtered = dashboard.getDashboard({ ...june, providerId: 'anthropic-p' }, now);
  assert.equal(filtered.filterOptions.providers.length, 5);
  assert.ok(filtered.filterOptions.providers.some(row => row.providerId === 'openai-p'));
  assert.ok(filtered.filterOptions.models.some(row => row.modelId === 'gpt-5'));
  assert.ok(filtered.filterOptions.projects.some(row => row.projectId === 'p1'));

  // 12. Attribution never folds a child into the parent's token row.
  const byChat = dashboard.getAttribution({ ...june, groupBy: 'chat' }, now);
  assert.equal(byChat.rows.find(row => row.key === 'chat-1').turns, 5);
  approx(byChat.rows.find(row => row.key === 'chat-1').combinedSpend, 0.0146, 'chat-one attribution');
  assert.equal(byChat.rows.find(row => row.key === 'chat-2').turns, 4);
  assert.equal(byChat.rows.reduce((total, row) => total + row.turns, 0), 9);
  const byWorkspace = dashboard.getAttribution({ ...june, groupBy: 'workspace' }, now);
  assert.equal(byWorkspace.rows.find(row => row.key === 'p1').turns, 5);
  assert.equal(byWorkspace.rows.find(row => row.key === 'unattributed').turns, 4);
  const byAgent = dashboard.getAttribution({ ...june, groupBy: 'agent' }, now);
  assert.equal(byAgent.rows.find(row => row.key === 'main').turns, 6);
  assert.equal(byAgent.rows.find(row => row.key === 'subagent:Researcher').turns, 1);
  assert.equal(byAgent.rows.find(row => row.key === 'subagent:Local Helper').combinedSpend, null);
  assert.equal(byAgent.rows.reduce((total, row) => total + row.turns, 0), 9);
  const byProvider = dashboard.getAttribution({ ...june, groupBy: 'provider' }, now);
  approx(byProvider.rows.find(row => row.providerId === 'openai-p').combinedSpend, 0.007, 'openai provider attribution');
  const byModel = dashboard.getAttribution({ ...june, groupBy: 'model' }, now);
  assert.equal(byModel.rows.filter(row => row.modelId === 'claude-sonnet-5').length, 2);
  assert.throws(() => dashboard.getAttribution({ ...june, groupBy: 'message' }, now), /Invalid attribution grouping/);

  // 13. Records are paginated in SQLite and include both execution kinds.
  const page1 = dashboard.getRecords({ ...june, limit: 2, offset: 0 }, now);
  const page2 = dashboard.getRecords({ ...june, limit: 2, offset: 2 }, now);
  assert.equal(page1.total, 9);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.offset, 0);
  assert.notDeepEqual(page1.rows.map(row => row.occurred_at), page2.rows.map(row => row.occurred_at));
  const allRecords = dashboard.getRecords({ ...june, limit: 100 }, now);
  assert.deepEqual(allRecords.rows.map(row => row.kind).sort(), ['subagent', 'subagent', 'subagent', 'turn', 'turn', 'turn', 'turn', 'turn', 'turn']);
  assert.equal(allRecords.rows.find(row => row.kind === 'subagent' && row.chat_id === 'chat-1').chatLabel, 'Chat one');
  assert.equal(allRecords.rows.find(row => row.kind === 'subagent' && row.chat_id === 'chat-1').workspaceLabel, 'Workspace one');

  // 14. Pricing history groups the persisted snapshots and never invents an
  // effective date. Rates are returned as recorded, not recomputed.
  const pricing = dashboard.getPricingHistory({ ...june, limit: 2, offset: 0 }, now);
  assert.equal(pricing.total, 5);
  assert.equal(pricing.hasMore, true);
  const pricingAll = dashboard.getPricingHistory({ ...june, limit: 100 }, now);
  assert.equal(pricingAll.rows.length, 5);
  const catalogSnapshot = pricingAll.rows.find(row => row.modelId === 'claude-sonnet-5' && row.providerId === 'anthropic-p');
  assert.equal(catalogSnapshot.rates.input, 3);
  assert.equal(catalogSnapshot.rates.cacheWrite1h, 6);
  assert.equal(catalogSnapshot.source, 'anthropic-catalog');
  assert.equal(catalogSnapshot.effectiveAt, null);
  approx(catalogSnapshot.recordedCost, 0.0101, 'historical snapshot cost');
  const providerSnapshot = pricingAll.rows.find(row => row.source === 'provider-reported');
  assert.equal(providerSnapshot.modelId, 'vendor/model');
  assert.equal(providerSnapshot.rates, null);
  assert.equal(pricingAll.rows.some(row => row.modelId === 'mystery-model'), false, 'unpriced rows have no rate snapshot');

  // 15. Model detail reuses the persisted evidence and returns no fresh price.
  const detail = dashboard.getModelDetail({ ...june, modelId: 'claude-sonnet-5', providerId: 'anthropic-p' }, now);
  approx(detail.model.combinedSpend, 0.0101, 'model detail spend');
  approx(detail.model.estimatedSpend, 0.0101, 'model detail estimate');
  assert.equal(detail.model.providerReportedSpend, null);
  assert.equal(detail.pricing.length, 1);
  approx(detail.summary.combinedSpend, 0.0101, 'detail summary spend');
  assert.equal(detail.timeline.length, 30);
  assert.throws(() => dashboard.getModelDetail({ ...june }, now), /Select a model/);

  // 16. Read-only: no dashboard call commits a database change.
  const versionBefore = db.prepare('PRAGMA data_version').get().data_version;
  dashboard.getDashboard(june, now);
  dashboard.getAttribution({ ...june, groupBy: 'chat' }, now);
  dashboard.getRecords(june, now);
  dashboard.getPricingHistory(june, now);
  dashboard.getModelDetail({ ...june, modelId: 'gpt-5' }, now);
  assert.equal(db.prepare('PRAGMA data_version').get().data_version, versionBefore);

  // 17. Historical evidence is not repriced when provider configuration changes.
  const beforeReprice = dashboard.getDashboard(june, now).summary.combinedSpend;
  providers([
    { id: 'anthropic-p', category: 'text', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-5', apiType: 'anthropic', apiKey: 'x', pricing: { input: 999, output: 999 } },
    { id: 'or-p', category: 'text', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'vendor/model', apiType: 'openai', apiKey: 'x' },
    { id: 'openai-p', category: 'text', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5', apiType: 'openai', apiKey: 'x' },
  ]);
  assert.equal(dashboard.getDashboard(june, now).summary.combinedSpend, beforeReprice);
  assert.equal(dashboard.getPricingHistory(june, now).rows.find(row => row.modelId === 'claude-sonnet-5' && row.providerId === 'anthropic-p').rates.input, 3);

  // 18. Provider labels distinguish configured, local, unattributed, and unknown.
  const descriptors = (id, list) => dashboard.providerDescriptor(id, list);
  assert.equal(descriptors('local').providerFamily, 'local');
  assert.equal(descriptors('local').providerLabel, 'Local models');
  assert.equal(descriptors(null).providerLabel, 'Unattributed');
  assert.equal(descriptors('deleted-provider').configured, false);
  assert.match(descriptors('deleted-provider').providerLabel, /Unrecognized provider/);
  assert.equal(descriptors('anthropic-p', [{ id: 'anthropic-p', name: 'Claude', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }]).providerFamily, 'anthropic');

  // 19. No inference or network path is reachable from these reads.
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network access is forbidden in the dashboard'); };
  try {
    assert.equal(dashboard.getDashboard(june, now).summary.turns, 9);
    assert.equal(dashboard.getModelDetail({ ...june, modelId: 'gpt-5' }, now).model.turns, 2);
  } finally {
    global.fetch = originalFetch;
  }

  // 20. Large fixture: aggregates stay in SQLite and records paginate without
  // returning the whole history to a renderer.
  const insert = db.prepare(`INSERT INTO token_usage (
      turn_id, chat_id, timestamp, prompt_tokens, completion_tokens, model_id, provider,
      cost_total, cost_currency, cost_completeness, cost_source
    ) VALUES (?, 'chat-bulk', ?, 100, 10, 'bulk-model', 'bulk-p', 0.000001, 'USD', 'complete', 'user-configured')`);
  db.transaction(() => {
    for (let index = 0; index < 1500; index += 1) {
      const day = String(1 + (index % 30)).padStart(2, '0');
      insert.run(`bulk-${index}`, `2026-05-${day}T00:00:00Z`);
    }
  })();
  const large = dashboard.getRecords({ range: 'all', limit: 100 }, now);
  assert.equal(large.total, 1509);
  assert.equal(large.rows.length, 100);
  assert.equal(large.hasMore, true);
  const bulkDashboard = dashboard.getDashboard({ range: 'all', groupBy: 'month' }, now);
  assert.equal(bulkDashboard.summary.turns, 1509);
  assert.ok(bulkDashboard.models.length < 1509, 'models are aggregated, not one object per usage row');
  assert.ok(bulkDashboard.timeline.length <= 3);

  // 21. The renderer bridge and main-process handlers are registered together.
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipcHandlers.js'), 'utf8');
  for (const name of ['usage:dashboard', 'usage:attribution', 'usage:records', 'usage:pricing-history', 'usage:model-detail']) {
    assert.ok(handlers.includes(`"${name}"`), `main registers ${name}`);
  }
  for (const name of ['getSpendingDashboard', 'getSpendingAttribution', 'getSpendingRecords', 'getPricingHistory', 'getUsageModelDetail']) {
    assert.ok(preload.includes(`${name}:`), `preload exposes ${name}`);
  }
  assert.ok(!handlers.includes('usage:sql') && !preload.includes('runSql'), 'no arbitrary SQL bridge exists');

  console.log('Cloud spending dashboard backend: aggregation, filters, attribution, pricing evidence, read-only and large-fixture checks passed.');
} finally {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}
