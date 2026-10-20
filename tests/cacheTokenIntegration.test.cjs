'use strict';
// End-to-end accounting path: mocked provider SSE -> per-request normalization
// -> turn aggregation -> SQLite token_usage -> history query used by analytics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-token-integration-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
const { logTokenUsage, getTokenHistory } = require('../src/main/tokenUsage');
const { runMemoryChat } = require('../src/lib/memoryChat.mjs');
const { cacheHitRatio } = require('../src/lib/completionStats.mjs');
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function stream(chunks) {
  const bytes = new TextEncoder().encode(chunks.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
}
const persist = (stats, { turnId, chatId, modelId, provider }) => logTokenUsage({
  turnId, chatId, projectId: 'p1', timestamp: '2026-03-10T00:00:00Z',
  promptTokens: stats.promptTokens, completionTokens: stats.completionTokens,
  uncachedInputTokens: stats.uncachedInputTokens, cacheReadTokens: stats.cachedTokens,
  cacheCreationTokens: stats.cacheCreationTokens, reasoningTokens: stats.reasoningTokens,
  visibleOutputTokens: stats.visibleCompletionTokens, modelId, provider,
  inputSource: stats.inputSource, cacheReadSource: stats.cacheReadSource,
  cacheWriteSource: stats.cacheWriteSource, cacheReadCoverage: stats.cacheReadCoverage,
  cacheWriteCoverage: stats.cacheWriteCoverage, usageCoverage: 'measured',
}, new Date('2026-03-31T12:00:00Z'));

(async () => {
  try {
    initDatabase(directory);
    let requests = 0;
    let stats;
    await runMemoryChat({
      baseUrl: 'http://localhost', modelId: 'model-a',
      messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Find it.' }],
      memoryTools: [{ name: 'search_memory', description: 'search', input_schema: { type: 'object' } }],
      executeTool: async () => ({ ok: true }),
      onStats: value => { stats = value; },
      fetchImpl: async () => {
        if (++requests === 1) return stream([
          chunk({ tool_calls: [{ index: 0, id: 'call1', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls'),
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } },
        ]);
        return stream([
          chunk({ content: 'Final answer [TASK COMPLETE]' }, 'stop'),
          { choices: [], usage: { prompt_tokens: 150, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } } },
        ]);
      },
    });
    assert.equal(stats.scope, 'all');
    assert.equal(stats.promptTokens, 250);
    assert.equal(stats.completionTokens, 15);
    assert.equal(stats.cachedTokens, 120);
    assert.equal(stats.uncachedInputTokens, 130);
    assert.equal(stats.cacheReadCoverage, 'measured', 'both request phases reported cache reads');
    assert.equal(stats.totalTokens, 265);
    persist(stats, { turnId: 'turn-a', chatId: 'chat-a', modelId: 'model-a', provider: 'openai' });

    // A concurrent session reports no cache at all; it must not inherit the
    // first session's cache values or turn into a measured zero.
    logTokenUsage({ turnId: 'turn-b', chatId: 'chat-b', projectId: 'p1', timestamp: '2026-03-10T00:00:00Z',
      promptTokens: 50, completionTokens: 5, modelId: 'model-b', provider: 'local', usageCoverage: 'measured' },
      new Date('2026-03-31T12:00:00Z'));

    const now = new Date('2026-03-31T12:00:00Z');
    const history = getTokenHistory({ months: 1, modelId: 'model-a' }, now);
    const row = history.data.find(entry => entry.period === '2026-03-01');
    assert.equal(row.promptTokens, 250);
    assert.equal(row.completionTokens, 15);
    assert.equal(row.cacheReadTokens, 120);
    assert.equal(row.uncachedInputTokens, 130);
    assert.equal(row.cacheReadCoverage, 'measured');
    assert.equal(cacheHitRatio({ grossInputTokens: row.promptTokens, cachedTokens: row.cacheReadTokens,
      cacheReadCoverage: row.cacheReadCoverage }), 48);
    const other = getTokenHistory({ months: 1, chatId: 'chat-b' }, now).data.find(entry => entry.period === '2026-03-01');
    assert.equal(other.cacheReadTokens, null);
    assert.equal(other.cacheReadCoverage, 'unavailable');
    assert.equal(other.promptTokens, 50, 'sessions never mix usage rows');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get().n, 2);
    console.log('Cache accounting integration: SSE -> normalization -> turn sum -> SQLite -> history/ratio passed.');
  } finally {
    Module._load = originalLoad;
    try { closeDatabase(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
})();
