'use strict';
// Phase 2.0C-3: cost persistence, additive migration, parent/sub-agent
// attribution, mixed local/cloud coverage, and continuation without duplicate
// aggregation. All deterministic; no network and no inference.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cost-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const { db, initDatabase, closeDatabase } = require('../src/main/db');
const { logTokenUsage, getTokenHistory } = require('../src/main/tokenUsage');
const persistence = require('../src/main/subagents/persistence');
const budgets = require('../src/main/subagents/budgets');
const { mergePhaseStats } = require('../src/lib/completionStats.mjs');
const now = new Date('2026-06-30T12:00:00Z');

try {
  initDatabase(directory);
  const columns = new Set(db.prepare('PRAGMA table_info(token_usage)').all().map(row => row.name));
  for (const column of ['cost_total', 'cost_completeness', 'cost_source', 'cost_cache_savings', 'cost_provider_reported']) {
    assert.ok(columns.has(column), `additive migration adds ${column}`);
  }
  const subagentColumns = new Set(db.prepare('PRAGMA table_info(subagent_runs)').all().map(row => row.name));
  for (const column of ['provider_id', 'cost_total', 'cost_completeness']) {
    assert.ok(subagentColumns.has(column), `subagent migration adds ${column}`);
  }

  // 24. Historical per-turn cost evidence is stored and survives an upsert that
  // omits cost (a cumulative snapshot must not erase the estimate).
  logTokenUsage({ turnId: 'anthropic-1', chatId: 'chat-parent', projectId: 'p1', timestamp: '2026-06-02T00:00:00Z',
    promptTokens: 7000, completionTokens: 500, uncachedInputTokens: 4000, cacheReadTokens: 2500,
    cacheCreationTokens: 500, modelId: 'claude-sonnet-5', provider: 'anthropic-p',
    cacheReadCoverage: 'measured', cacheWriteCoverage: 'measured',
    cost: { total: 0.0101, currency: 'USD', status: 'available', completeness: 'complete',
      source: 'anthropic-catalog', version: 'anthropic-catalog:2026-04-01', timestamp: '2026-06-02T00:00:00Z',
      uncachedInput: 0.008, cacheRead: 0.0005, cacheWrite: 0.00125, output: 0.005, cacheSavings: 0.006 } }, now);
  logTokenUsage({ turnId: 'anthropic-1', chatId: 'chat-parent', projectId: 'p1', timestamp: '2026-06-02T00:00:00Z',
    promptTokens: 7000, completionTokens: 500, modelId: 'claude-sonnet-5', provider: 'anthropic-p' }, now);
  // A local turn is not applicable, never a $0.00 cloud charge.
  logTokenUsage({ turnId: 'local-1', chatId: 'chat-parent', projectId: 'p1', timestamp: '2026-06-03T00:00:00Z',
    promptTokens: 1000, completionTokens: 50, modelId: 'llama-3', provider: 'local',
    cost: { total: null, completeness: 'not_applicable', source: 'not-applicable', status: 'not_applicable' } }, now);
  // An OpenRouter turn with an authoritative provider-reported charge.
  logTokenUsage({ turnId: 'or-1', chatId: 'chat-parent', projectId: 'p1', timestamp: '2026-06-04T00:00:00Z',
    promptTokens: 2000, completionTokens: 100, modelId: 'vendor/model', provider: 'or-p',
    cost: { total: 0.002, completeness: 'complete', source: 'provider-reported', status: 'available',
      providerReported: 0.002 } }, now);

  const history = getTokenHistory({ months: 3 }, now);
  const june = history.data.find(row => row.period === '2026-06-01');
  assert.equal(june.costTotal, 0.0121, 'measured parent totals sum once');
  assert.equal(june.costMeasuredTurns, 2);
  assert.equal(june.costNotApplicableTurns, 1);
  assert.equal(june.billableTurns, 2, 'the local turn is excluded from billable coverage');
  assert.equal(june.costCoverage, 'measured');
  assert.equal(history.costs.total, 0.0121);
  assert.equal(history.costs.notApplicableTurns, 1);
  assert.equal(history.costs.coverage, 'measured');
  const modelIds = history.models.map(row => row.modelId).sort();
  assert.deepEqual(modelIds, ['claude-sonnet-5', 'llama-3', 'vendor/model']);
  assert.equal(history.models.find(row => row.modelId === 'vendor/model').costTotal, 0.002);

  // 25a. A child run is attributed to its parent session exactly once.
  db.prepare('INSERT INTO sessions(id, title) VALUES (?, ?)').run('chat-parent', 'Parent chat');
  const child = { id: 'child-1', parentSessionId: 'chat-parent', model: 'gpt-5', provider: 'cloud',
    providerId: 'openai-p', status: 'completed', createdAt: '2026-06-10T10:00:00Z', startedAt: '2026-06-10T10:00:00Z',
    completedAt: '2026-06-10T10:01:00Z', durationMs: 60000, result: 'done', context: [],
    usage: { prompt_tokens: 2000, completion_tokens: 100, cache_read_input_tokens: 500, uncached_input_tokens: 1500, cache_write_input_tokens: 0 } };
  db.prepare(`INSERT INTO app_settings(key, value_json) VALUES ('cloud-providers', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify([
      { id: 'openai-p', category: 'text', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5', apiType: 'openai', apiKey: 'sk-test' },
    ]));
  assert.equal(persistence.persistChildRun(child), true);
  const withChild = getTokenHistory({ months: 3, chatId: 'chat-parent' }, now);
  const childBucket = withChild.data.find(row => row.period === '2026-06-01');
  // 1500*1.25 + 500*0.125 + 100*10 per million = 0.0029375
  assert.equal(childBucket.subagentCostTotal, 0.002938, 'rate estimate rounded to micro-dollars');
  assert.equal(childBucket.subagentRuns, 1);
  assert.equal(childBucket.costTotal, 0.0121 + 0.002938, 'child cost merges into the parent total once');

  // 25b. A resumed/recovered settlement updates the same row; it never adds a
  // second child entry or doubles the parent's total.
  const resumed = { ...child, completedAt: '2026-06-10T10:05:00Z',
    usage: { prompt_tokens: 3000, completion_tokens: 200, uncached_input_tokens: 3000, cache_read_input_tokens: 0, cache_write_input_tokens: 0 } };
  assert.equal(persistence.persistChildRun(resumed), true);
  const afterResume = getTokenHistory({ months: 3, chatId: 'chat-parent' }, now);
  const resumedBucket = afterResume.data.find(row => row.period === '2026-06-01');
  assert.equal(resumedBucket.subagentRuns, 1, 'one row per child after resume');
  assert.equal(resumedBucket.subagentCostTotal, (3000 * 1.25 + 200 * 10) / 1e6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subagent_runs WHERE child_session_id = ?').get('child-1').n, 1);

  // 25c. A local child is not applicable and does not enter billable coverage.
  const localChild = { id: 'child-local', parentSessionId: 'chat-parent', model: 'llama-3', provider: 'local',
    providerId: null, status: 'completed', createdAt: '2026-06-11T10:00:00Z', completedAt: '2026-06-11T10:01:00Z',
    result: 'ok', context: [], usage: { prompt_tokens: 100, completion_tokens: 10, uncached_input_tokens: 100 } };
  persistence.persistChildRun(localChild);
  const withLocal = getTokenHistory({ months: 3, chatId: 'chat-parent' }, now);
  assert.equal(withLocal.costs.notApplicableTurns, 2, 'parent local turn + local child are both not applicable');
  assert.equal(withLocal.costs.coverage, 'measured');

  // 25d. A different parent's child never leaks into this parent's history.
  db.prepare('INSERT INTO sessions(id, title) VALUES (?, ?)').run('other-parent', 'Other');
  const otherChild = { ...child, id: 'child-other', parentSessionId: 'other-parent', completedAt: '2026-06-12T10:00:00Z',
    usage: { prompt_tokens: 1000, completion_tokens: 50, uncached_input_tokens: 1000 } };
  persistence.persistChildRun(otherChild);
  const isolated = getTokenHistory({ months: 3, chatId: 'chat-parent' }, now);
  assert.equal(isolated.data.find(row => row.period === '2026-06-01').subagentRuns, 2, 'only this parent\'s children (cloud + local)');
  assert.equal(getTokenHistory({ months: 3, chatId: 'other-parent' }, now).data.find(row => row.period === '2026-06-01').subagentRuns, 1);

  // 25e. Provider-reported cost extraction survives phase aggregation.
  const phases = [
    { promptTokens: 100, completionTokens: 10, providerCost: 0.01, scope: 'final' },
    { promptTokens: 50, completionTokens: 5, providerCost: 0.02, scope: 'final' },
  ];
  const merged = mergePhaseStats(phases, now.getTime() - 1000);
  assert.equal(merged.providerCost, 0.03, 'multi-request charge is summed');
  assert.equal(merged.providerCostCoverage, 'measured');

  // 25f. Billing evidence extraction is separate from the budget counters.
  assert.deepEqual(budgets.extractBillingUsage({ cache_creation_input_tokens: 12, cost: 0.5 }),
    { cacheWritten: 12, providerCost: 0.5 });
  assert.deepEqual(budgets.extractBillingUsage(null), { cacheWritten: null, providerCost: null });

  // Restart/readback keeps the cost columns intact.
  closeDatabase(); initDatabase(directory);
  const reopened = getTokenHistory({ months: 3, chatId: 'chat-parent' }, now);
  assert.equal(reopened.costs.notApplicableTurns, 2);
  assert.ok(reopened.costs.total > 0);
  console.log('Cloud cost persistence, migration, attribution, mixed local/cloud coverage and no-duplicate continuation passed.');
} finally {
  Module._load = originalLoad;
  try { closeDatabase(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
