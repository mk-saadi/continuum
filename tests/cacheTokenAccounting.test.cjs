'use strict';
// Phase 2.0C-1: provider cache fields normalize to one gross/uncached/read/write
// contract, turn aggregation sums known phases without using the last phase as
// a false total, and streaming usage events are merged instead of counted twice.
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  phaseStats, mergePhaseStats, extractCacheTokens, extractReasoningTokens,
  cacheHitRatio,
} = require('../src/lib/completionStats.mjs');
const { runMemoryChat } = require('../src/lib/memoryChat.mjs');
const { createLedger, normalizeUsage, recordTurn, ledgerTotals } = require('../src/main/subagents/budgets');

const stats = (usage, timings = null) => phaseStats({ usage, timings, startTime: 0, endTime: 1000 });
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function stream(chunks) {
  const bytes = new TextEncoder().encode(chunks.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
}
const base = { baseUrl: 'http://localhost', modelId: 'test', messages: [{ role: 'system', content: 'Rules' }] };

test('local llama.cpp timings expose gross, uncached and cached prompt counts', () => {
  const local = phaseStats({ timings: { prompt_n: 80, cache_n: 20, predicted_n: 5, predicted_ms: 100 }, startTime: 0, endTime: 1000 });
  assert.equal(local.promptTokens, 100, 'gross = processed + cache_n');
  assert.equal(local.grossInputTokens, 100);
  assert.equal(local.uncachedInputTokens, 80);
  assert.equal(local.cachedTokens, 20);
  assert.equal(local.cacheReadTokens, 20);
  assert.equal(local.cacheCreationTokens, null);
  assert.equal(local.completionTokens, 5);
  assert.equal(local.totalTokens, 105);
  assert.equal(local.inputSource, 'server-timings');
  assert.equal(local.cacheReadSource, 'server-timings');
  assert.equal(local.cacheReadCoverage, 'measured');
  assert.equal(local.cacheWriteCoverage, 'unavailable');
});

test('OpenAI cached input is part of gross prompt, never added twice', () => {
  const openai = stats({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 } });
  assert.equal(openai.promptTokens, 100);
  assert.equal(openai.cachedTokens, 40);
  assert.equal(openai.uncachedInputTokens, 60);
  assert.equal(openai.totalTokens, 120);
  assert.equal(openai.cacheReadSource, 'provider');
});

test('DeepSeek cache-hit usage normalizes without changing the gross prompt', () => {
  const deepseek = stats({ prompt_tokens: 100, completion_tokens: 10,
    prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 });
  assert.equal(deepseek.promptTokens, 100);
  assert.equal(deepseek.cachedTokens, 30);
  assert.equal(deepseek.uncachedInputTokens, 70);
});

test('Anthropic normalized and raw cache reads/writes subtract exactly once', () => {
  const normalized = stats({ prompt_tokens: 1000, completion_tokens: 20,
    cache_read_input_tokens: 400, cache_creation_input_tokens: 100 });
  assert.equal(normalized.promptTokens, 1000);
  assert.equal(normalized.cachedTokens, 400);
  assert.equal(normalized.cacheCreationTokens, 100);
  assert.equal(normalized.cacheWriteTokens, 100);
  assert.equal(normalized.uncachedInputTokens, 500);
  const raw = stats({ input_tokens: 500, output_tokens: 20,
    cache_read_input_tokens: 400, cache_creation_input_tokens: 100 });
  assert.equal(raw.promptTokens, 1000, 'raw input_tokens is uncached and must be completed');
  assert.equal(raw.uncachedInputTokens, 500);
  assert.equal(raw.cachedTokens, 400);
  assert.equal(raw.cacheCreationTokens, 100);
});

test('Gemini cached content and native count fields are recognized', () => {
  const gemini = stats({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110,
    usageMetadata: { cachedContentTokenCount: 40 } });
  assert.equal(gemini.promptTokens, 100);
  assert.equal(gemini.completionTokens, 10);
  assert.equal(gemini.totalTokens, 110);
  assert.equal(gemini.cachedTokens, 40);
  assert.equal(gemini.uncachedInputTokens, 60);
  assert.equal(gemini.cacheReadCoverage, 'measured');
});

test('providers with no cache fields keep cache unknown, never zero', () => {
  const plain = stats({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
  assert.equal(plain.cachedTokens, null);
  assert.equal(plain.cacheReadCoverage, 'unavailable');
  assert.equal(plain.cacheCreationTokens, null);
  assert.equal(plain.cacheWriteCoverage, 'unavailable');
  assert.equal(plain.uncachedInputTokens, null, 'uncached is unknown while cache may be unreported');
  assert.equal(cacheHitRatio(plain), null);
  // A measured zero is different from a missing value.
  const zero = stats({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(zero.cachedTokens, 0);
  assert.equal(zero.cacheReadCoverage, 'measured');
  assert.equal(zero.uncachedInputTokens, 50);
  assert.equal(cacheHitRatio(zero), 0);
  assert.deepEqual(extractCacheTokens({ prompt_tokens: 1 }), { cached: null, created: null });
});

test('mixed reported and unreported phases sum known cache values and label the rest partial', () => {
  const known = stats({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } });
  const unknown = stats({ prompt_tokens: 50, completion_tokens: 5 });
  const merged = mergePhaseStats([known, unknown], 0);
  assert.equal(merged.scope, 'all');
  assert.equal(merged.promptTokens, 150, 'gross totals preserved');
  assert.equal(merged.completionTokens, 15);
  assert.equal(merged.cachedTokens, 40, 'known phase value summed; never the last phase fallback');
  assert.equal(merged.cacheReadCoverage, 'partially_measured');
  assert.equal(merged.uncachedInputTokens, null, 'unknown portions remain unknown');
  assert.equal(merged.uncachedInputCoverage, 'partially_measured');
  assert.equal(cacheHitRatio(merged), null, 'no ratio from incomplete cache data');
  // The last phase being unknown must not erase the first phase's measurement.
  const lastUnknown = mergePhaseStats([known, unknown], 0);
  assert.equal(lastUnknown.cachedTokens, 40);
  // And the last phase being measured must not masquerade as the whole turn.
  const firstUnknown = stats({ prompt_tokens: 50, completion_tokens: 5 });
  const lastKnown = stats({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 7 } });
  const partial = mergePhaseStats([firstUnknown, lastKnown], 0);
  assert.equal(partial.cachedTokens, 7);
  assert.equal(partial.cacheReadCoverage, 'partially_measured');
});

test('fully measured phases sum cache read/write; fully unknown phases stay unknown', () => {
  const first = stats({ prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 });
  const second = stats({ prompt_tokens: 50, completion_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 });
  const merged = mergePhaseStats([first, second], 0);
  assert.equal(merged.cachedTokens, 60);
  assert.equal(merged.cacheCreationTokens, 15);
  assert.equal(merged.cacheReadCoverage, 'measured');
  assert.equal(merged.cacheWriteCoverage, 'measured');
  assert.equal(merged.uncachedInputTokens, 75, 'gross - reads - writes');
  assert.equal(cacheHitRatio(merged), 40);
  const none = mergePhaseStats([stats({ prompt_tokens: 10, completion_tokens: 1 }),
    stats({ prompt_tokens: 20, completion_tokens: 2 })], 0);
  assert.equal(none.cachedTokens, null);
  assert.equal(none.cacheReadCoverage, 'unavailable');
  assert.equal(none.cacheCreationTokens, null);
});

test('incomplete phases keep final-request stats instead of fabricating a turn sum', () => {
  const tool = stats({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } });
  const missing = stats({});
  const final = stats({ prompt_tokens: 150, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } });
  const merged = mergePhaseStats([tool, missing, final], 0);
  assert.equal(merged.scope, 'final');
  assert.equal(merged.usageSemantics, 'final-request');
  assert.equal(merged.promptTokens, 150, 'the final request is not presented as a three-phase sum');
  assert.equal(merged.cachedTokens, 80, 'cache values describe the final request only');
  assert.equal(merged.cacheReadCoverage, 'measured');
  assert.equal(merged.promptRequests, 3);
  assert.equal(merged.promptCoverage, 'partial');
});

test('streaming usage events merge cache details without double counting', async () => {
  let observed;
  await runMemoryChat({ ...base, onStats: value => { observed = value; }, fetchImpl: async () => stream([
    chunk({ content: 'Answer' }, 'stop'),
    { choices: [], usage: { prompt_tokens: 100 } },
    { choices: [], usage: { completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ]) });
  assert.equal(observed.promptTokens, 100, 'repeated snapshots replace, never add');
  assert.equal(observed.completionTokens, 20);
  assert.equal(observed.cachedTokens, 40);
  assert.equal(observed.uncachedInputTokens, 60);
  assert.equal(observed.cacheReadCoverage, 'measured');
  assert.equal(observed.totalTokens, 120);
});

test('reasoning tokens remain a measured subset, not a second output total', () => {
  const reasoned = stats({ prompt_tokens: 10, completion_tokens: 100, total_tokens: 110,
    completion_tokens_details: { reasoning_tokens: 40 } });
  assert.equal(reasoned.completionTokens, 100);
  assert.equal(reasoned.reasoningTokens, 40);
  assert.equal(reasoned.visibleCompletionTokens, 60);
  assert.equal(reasoned.totalTokens, 110);
  assert.equal(reasoned.reasoningCoverage, 'measured');
  assert.equal(extractReasoningTokens({ usageMetadata: { thoughtsTokenCount: 9 } }), 9);
});

test('cache-hit ratio is withheld unless cache reads are fully measured', () => {
  assert.equal(cacheHitRatio({ grossInputTokens: 100, cachedTokens: 40, cacheReadCoverage: 'measured' }), 40);
  assert.equal(cacheHitRatio({ grossInputTokens: 100, cachedTokens: 40, cacheReadCoverage: 'partially_measured' }), null);
  assert.equal(cacheHitRatio({ grossInputTokens: 100, cachedTokens: null, cacheReadCoverage: 'unavailable' }), null);
  assert.equal(cacheHitRatio({ grossInputTokens: 0, cachedTokens: 0, cacheReadCoverage: 'measured' }), null);
});

test('subagent ledger records cache reads without discounting the input budget', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30 }),
    { input: 100, output: null, cachedInput: 30, reasoning: null });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, usageMetadata: { cachedContentTokenCount: 25 } }),
    { input: 100, output: null, cachedInput: 25, reasoning: null });
  const ledger = createLedger();
  recordTurn(ledger, { usage: { prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 30 } });
  const totals = ledgerTotals(ledger);
  assert.equal(totals.inputTokens, 100, 'cached reads are not a budget discount');
  assert.equal(totals.cacheReadTokens, 30);
  assert.equal(totals.cacheReadCoverage, 'measured');
  const unknown = createLedger();
  recordTurn(unknown, { usage: { prompt_tokens: 100, completion_tokens: 5 } });
  assert.equal(ledgerTotals(unknown).cacheReadTokens, null);
  assert.equal(ledgerTotals(unknown).cacheReadCoverage, 'unavailable');
  const mixed = createLedger();
  recordTurn(mixed, { usage: { prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 30 } });
  recordTurn(mixed, { usage: { prompt_tokens: 100, completion_tokens: 5 } });
  assert.equal(ledgerTotals(mixed).cacheReadTokens, 30);
  assert.equal(ledgerTotals(mixed).cacheReadCoverage, 'partially_measured');
});
