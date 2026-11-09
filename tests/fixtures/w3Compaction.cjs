'use strict';
// Owning-boundary fixture over the current production service. Counts are
// explicit deterministic estimates, never real tokenizer measurements.
async function compact({ sessionId, modelId = 'model', draft = {}, tools = [], measureOverride, overrides = {} }) {
  const builder = require('../../src/main/promptBuilder');
  const budget = require('../../src/main/contextBudget');
  const payload = { model: modelId, messages: builder.rebuildChatMessages({ sessionId, modelId }), tools, max_tokens: 1024 };
  return require('../../src/main/mainChatCompaction').compactAtBoundary({ sessionId, modelId, payload, owner: new AbortController(), force: true,
    measure: measureOverride ?? (async request => ({ tokens: budget.approximateTokens(request), limit: 524288, reserve: request.max_tokens, method: 'fixture-estimate' })),
    generate: async () => ({ choices: [{ finish_reason: 'stop', message: { content: `# Compaction summary\n${draft.objective ?? 'Preserve fixture task'}\nNext: finish verification.` } }] }),
    ...overrides });
}
module.exports = { compact };
