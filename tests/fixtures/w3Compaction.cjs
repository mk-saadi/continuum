'use strict';
// Test-only owning-loop adapter, using the production W2/W3 path and the
// caller's disposable database. Counts remain explicit estimates.
async function compact({ sessionId, modelId = 'model', draft = {}, tools = [], inject, measureOverride, overrides = {} }) {
  const engine = require('../../src/main/engineManager');
  const owner = new AbortController(); owner.runId = `fixture-${sessionId}`;
  engine.activeStreams.set(sessionId, owner);
  const builder = require('../../src/main/promptBuilder');
  const budget = require('../../src/main/contextBudget');
  const prefix = projection => builder.rebuildChatMessages({ sessionId, modelId, compactionProjection: projection });
  const payload = { model: modelId, messages: prefix(), tools, max_tokens: 1024 };
  try {
    return await require('../../src/main/workspaceCompaction').compactAtBoundary({
      sessionId, modelId, owner, tail: [], payload, force: true, isCurrent: () => true, inject,
      buildRequest: async projection => ({ ...payload, messages: prefix(projection) }),
      measure: require('./c9SummaryTokenizer.cjs').withSummaryTokenizer(measureOverride ?? (async request => {
        const tokens = budget.approximateTokens(request);
        const budgetContract = budget.createRuntimeBudget({ runtimeContextTokens: 524288, payload: request, currentInputTokens: tokens, measurementMethod: 'server-template-tokenizer' });
        return { tokens, method: 'server-template-tokenizer', budgetContract, limit: 524288, budget: budgetContract.usableInputTokens };
      })),
      generate: async request => {
        const input = JSON.parse(request.messages[1].content);
        const result = { objective: draft.objective ?? 'Preserve fixture task', briefIds: input.briefs.map(b => b.id) };
        for (const key of require('../../src/main/workspaceCompactCandidate').ARRAY_KEYS) result[key] = draft[key] ?? [];
        result.filesChanged = result.filesChanged.map(({ path, nature, stepRef }) => ({ path, nature, stepRef }));
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
      },
      ...overrides,
    });
  } finally { engine.activeStreams.delete(sessionId); }
}
module.exports = { compact };
