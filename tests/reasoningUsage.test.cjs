'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractReasoningTokens, phaseStats, mergePhaseStats,
} = require('../src/lib/completionStats.mjs');
const { createLedger, normalizeUsage, recordTurn, ledgerTotals } = require('../src/main/subagents/budgets');

// Provider reasoning tokens are a measured *subset* of output tokens. They are
// never a second output total, never inferred from a configured budget, and
// stay unreported when the provider omits them.

test('every supported usage shape exposes reasoning tokens', () => {
  assert.equal(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 12 } }), 12);
  assert.equal(extractReasoningTokens({ output_tokens_details: { reasoning_tokens: 13 } }), 13);
  assert.equal(extractReasoningTokens({ reasoning_tokens: 14 }), 14);
  assert.equal(extractReasoningTokens({ thoughts_token_count: 15 }), 15);
  assert.equal(extractReasoningTokens({}, { reasoning_n: 16 }), 16);
  assert.equal(extractReasoningTokens({ prompt_tokens: 10 }), null);
  // Invalid values never become zero or a fabricated measurement.
  assert.equal(extractReasoningTokens({ reasoning_tokens: -1 }), null);
  assert.equal(extractReasoningTokens({ reasoning_tokens: 1.5 }), null);
});

test('phase stats subtract reasoning from visible output without changing totals', () => {
  const stats = phaseStats({
    usage: { prompt_tokens: 30, completion_tokens: 100, total_tokens: 130,
      completion_tokens_details: { reasoning_tokens: 40 } },
    startTime: 1000, endTime: 3000,
  });
  assert.equal(stats.completionTokens, 100);
  assert.equal(stats.reasoningTokens, 40);
  assert.equal(stats.visibleCompletionTokens, 60);
  assert.equal(stats.totalTokens, 130);
  assert.equal(stats.reasoningCoverage, 'measured');
});

test('unreported reasoning leaves visible output unknown instead of assumed', () => {
  const stats = phaseStats({
    usage: { prompt_tokens: 30, completion_tokens: 100, total_tokens: 130 },
    startTime: 0, endTime: 1000,
  });
  assert.equal(stats.reasoningTokens, null);
  assert.equal(stats.visibleCompletionTokens, null);
  assert.equal(stats.reasoningCoverage, 'unreported');
  assert.equal(stats.completionTokens, 100);
});

test('reasoning across phases is summed as a subset, not double counted', () => {
  const first = phaseStats({ usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60,
    completion_tokens_details: { reasoning_tokens: 20 } }, startTime: 0, endTime: 1000 });
  const last = phaseStats({ usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 10 } }, startTime: 1000, endTime: 2000 });
  const merged = mergePhaseStats([first, last], 0);
  assert.equal(merged.scope, 'all');
  assert.equal(merged.promptTokens, 80);
  assert.equal(merged.completionTokens, 80);
  assert.equal(merged.totalTokens, 160);
  assert.equal(merged.reasoningTokens, 30);
  assert.equal(merged.visibleCompletionTokens, 50);
  assert.equal(merged.reasoningCoverage, 'measured');
});

test('a phase without reasoning metadata keeps only measured values', () => {
  const measured = phaseStats({ usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60,
    completion_tokens_details: { reasoning_tokens: 20 } }, startTime: 0, endTime: 1000 });
  const unreported = phaseStats({ usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    startTime: 1000, endTime: 2000 });
  const merged = mergePhaseStats([measured, unreported], 0);
  assert.equal(merged.reasoningTokens, null);
  assert.equal(merged.visibleCompletionTokens, null);
  assert.equal(merged.reasoningCoverage, 'unreported');
});

test('subagent ledgers keep reasoning as a measured subset with honest coverage', () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 20, completion_tokens: 80,
    completion_tokens_details: { reasoning_tokens: 30 },
  }), { input: 20, output: 80, cachedInput: null, reasoning: 30 });

  const ledger = createLedger();
  recordTurn(ledger, { messages: [], usage: {
    prompt_tokens: 20, completion_tokens: 80,
    completion_tokens_details: { reasoning_tokens: 30 },
  } });
  let totals = ledgerTotals(ledger);
  assert.equal(totals.outputTokens, 80);
  assert.equal(totals.reasoningTokens, 30);
  assert.equal(totals.visibleOutputTokens, 50);
  assert.equal(totals.reasoningCoverage, 'measured');

  recordTurn(ledger, { messages: [{ role: 'user', content: 'more' }], usage: { prompt_tokens: 30, completion_tokens: 20 } });
  totals = ledgerTotals(ledger);
  assert.equal(totals.outputTokens, 100);
  assert.equal(totals.reasoningTokens, 30);
  assert.equal(totals.visibleOutputTokens, 70);
  assert.equal(totals.reasoningCoverage, 'partial');

  const unreported = createLedger();
  recordTurn(unreported, { messages: [{ role: 'user', content: 'hi' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  totals = ledgerTotals(unreported);
  assert.equal(totals.reasoningTokens, 0);
  assert.equal(totals.reasoningCoverage, 'unreported');
  assert.equal(totals.visibleOutputTokens, 5);
});
