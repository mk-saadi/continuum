'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'response-cost-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
const estimator = require('../src/main/costEstimator');
const { logTokenUsage, getTokenHistory } = require('../src/main/tokenUsage');
const sessions = require('../src/main/sessionManager');
const now = new Date('2026-10-27T00:00:00Z');

test('response estimates survive the usage writer and workspace session reload', () => {
  try {
    initDatabase(directory);
    const stats = { promptTokens: 2000, completionTokens: 100, totalTokens: 2100, providerCost: 0.00143 };
    const estimate = estimator.estimateFromStats({ stats, modelId: 'vendor/model' });
    const cost = { total: estimate.totalCost, currency: estimate.currency,
      completeness: estimate.completeness, savings: estimate.cacheSavings ?? null,
      providerReported: estimate.providerReportedCost, source: estimate.source };
    logTokenUsage({ turnId: 'response', chatId: 'workspace', modelId: 'vendor/model', provider: 'cloud',
      timestamp: now.toISOString(), promptTokens: stats.promptTokens, completionTokens: stats.completionTokens,
      cost: estimator.costEvidence(estimate) }, now);
    const row = db.prepare('SELECT * FROM token_usage WHERE turn_id = ?').get('response');
    assert.equal(row.cost_total, 0.00143);
    assert.equal(row.cost_provider_reported, 0.00143);
    assert.equal(row.cost_source, 'provider-reported');
    assert.equal(getTokenHistory({ months: 1 }, now).models[0].costTotal, 0.00143);
    const dashboard = require('../src/main/spendingDashboard').getDashboard({ range: '30d' }, now);
    assert.equal(dashboard.summary.combinedSpend, 0.00143);

    const rateEstimate = estimator.estimateFromStats({ stats: { promptTokens: 1000,
      uncachedInputTokens: 1000, cachedTokens: 0, cacheCreationTokens: 0, completionTokens: 100 },
      resolvedPricing: { status: 'available', source: 'user-configured', currency: 'USD',
        input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } });
    logTokenUsage({ turnId: 'rate-response', provider: 'cloud', modelId: 'priced/model',
      timestamp: now.toISOString(), promptTokens: 1000, completionTokens: 100,
      cost: estimator.costEvidence(rateEstimate) }, now);
    const rateRow = db.prepare('SELECT * FROM token_usage WHERE turn_id = ?').get('rate-response');
    assert.equal(rateRow.cost_total, 0.003);
    assert.equal(rateRow.cost_uncached_input, 0.002);
    assert.equal(rateRow.cost_output, 0.001);
    assert.equal(rateRow.cost_currency, 'USD');

    sessions.getOrCreateSession('workspace', 'vendor/model');
    sessions.saveMessage('workspace', 'assistant', 'Hello', [], { ...stats, cost });
    assert.deepEqual(sessions.loadSession('workspace').messages[0].stats.cost, cost);
    // Workspace streaming persists JSON directly; reload runs the stats normalizer.
    db.prepare('UPDATE messages SET stats = ? WHERE session_id = ?').run(JSON.stringify({ ...stats, cost }), 'workspace');
    assert.deepEqual(sessions.loadSession('workspace').messages[0].stats.cost, cost);
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
