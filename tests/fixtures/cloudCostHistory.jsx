import React from 'react';
import { createRoot } from 'react-dom/client';
import TokenHistory from '../../src/components/settings/TokenHistory';

// One priced cloud period, one local-only period (not applicable), and a very
// small non-zero model cost that must never render as $0.00.
const priced = {
  period: '2026-09-01', promptTokens: 7000, completionTokens: 500, turns: 2,
  uncachedInputTokens: 4000, cacheReadTokens: 2500, cacheCreationTokens: 500,
  reasoningTokens: 200, visibleOutputTokens: 300,
  uncachedMeasuredTurns: 2, cacheReadMeasuredTurns: 2, cacheCreationMeasuredTurns: 2, reasoningMeasuredTurns: 2,
  cacheReadCoverage: 'measured', cacheCreationCoverage: 'measured',
  uncachedInputCoverage: 'measured', reasoningCoverage: 'measured',
  costTotal: 0.0121, costMeasuredTurns: 2, costCacheSavings: 0.006, costSavingsMeasuredTurns: 2,
  costProviderReported: null, costNotApplicableTurns: 0, billableTurns: 2, costCoverage: 'measured',
  costUncachedInput: 0.008, costCacheRead: 0.0005, costCacheWrite: 0.00125, costOutput: 0.005,
};
const localOnly = {
  period: '2026-10-01', promptTokens: 1000, completionTokens: 50, turns: 1,
  uncachedInputTokens: 1000, cacheReadTokens: null, cacheCreationTokens: null,
  reasoningTokens: null, visibleOutputTokens: null,
  uncachedMeasuredTurns: 1, cacheReadMeasuredTurns: 0, cacheCreationMeasuredTurns: 0, reasoningMeasuredTurns: 0,
  cacheReadCoverage: 'unavailable', cacheCreationCoverage: 'unavailable',
  uncachedInputCoverage: 'measured', reasoningCoverage: 'unavailable',
  costTotal: null, costMeasuredTurns: 0, costCacheSavings: null, costSavingsMeasuredTurns: 0,
  costProviderReported: null, costNotApplicableTurns: 1, billableTurns: 0, costCoverage: 'not_applicable',
  costUncachedInput: null, costCacheRead: null, costCacheWrite: null, costOutput: null,
};
window.queries = [];
window.api = {
  listProjects: async () => [{ id: 'p1', name: 'Example project' }],
  getTokenHistory: async options => {
    window.queries.push(options);
    return { ...options, retentionMonths: 12, data: [priced, localOnly],
      costs: { total: 0.0121, savings: 0.006, providerReported: null, measuredTurns: 2,
        savingsMeasuredTurns: 2, billableTurns: 2, notApplicableTurns: 1, turns: 3,
        currency: 'USD', coverage: 'measured', savingsCoverage: 'measured' },
      models: [
        { modelId: 'claude-sonnet-5', provider: 'anthropic-p', turns: 2, costTotal: 0.0121, costMeasuredTurns: 2 },
        { modelId: 'tiny-model', provider: 'or-p', turns: 1, costTotal: 0.00002, costMeasuredTurns: 1 },
        { modelId: 'llama-3', provider: 'local', turns: 1, costTotal: null, costMeasuredTurns: 0 },
      ] };
  },
  setTokenRetention: async months => { window.retained = months; },
};
createRoot(document.getElementById('root')).render(<TokenHistory />);
