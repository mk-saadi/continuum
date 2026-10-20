import React from 'react';
import { createRoot } from 'react-dom/client';
import TokenHistory from '../../src/components/settings/TokenHistory';

const measured = {
  period: '2026-09-01', promptTokens: 1000, completionTokens: 100, turns: 2,
  uncachedInputTokens: 500, cacheReadTokens: 500, cacheCreationTokens: 100,
  reasoningTokens: 20, visibleOutputTokens: 80,
  uncachedMeasuredTurns: 2, cacheReadMeasuredTurns: 2, cacheCreationMeasuredTurns: 2, reasoningMeasuredTurns: 2,
  cacheReadCoverage: 'measured', cacheCreationCoverage: 'measured',
  uncachedInputCoverage: 'measured', reasoningCoverage: 'measured',
};
const unknown = {
  period: '2026-10-01', promptTokens: 200, completionTokens: 20, turns: 1,
  uncachedInputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  reasoningTokens: null, visibleOutputTokens: null,
  uncachedMeasuredTurns: 0, cacheReadMeasuredTurns: 0, cacheCreationMeasuredTurns: 0, reasoningMeasuredTurns: 0,
  cacheReadCoverage: 'unavailable', cacheCreationCoverage: 'unavailable',
  uncachedInputCoverage: 'unavailable', reasoningCoverage: 'unavailable',
};
window.queries = [];
window.api = {
  listProjects: async () => [{ id: 'p1', name: 'Example project' }],
  getTokenHistory: async options => {
    window.queries.push(options);
    const measuredOnly = options.modelId === 'model-a';
    return { ...options, retentionMonths: 12,
      data: measuredOnly ? [measured] : [measured, unknown],
      models: [{ modelId: 'model-a', provider: 'openai', turns: 2 }, { modelId: 'model-b', provider: 'local', turns: 1 }] };
  },
  setTokenRetention: async months => { window.retained = months; },
};
createRoot(document.getElementById('root')).render(<TokenHistory />);
