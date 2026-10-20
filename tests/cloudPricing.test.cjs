'use strict';
// Phase 2.0C-3: deterministic coverage of the pure cloud pricing resolver and
// cost estimator. No network, no inference, no live pricing API. Every price
// used here is either a verified catalog entry, an explicit OpenRouter metadata
// fixture, or a user-configured rate.
const assert = require('node:assert/strict');
const test = require('node:test');
const pricing = require('../src/lib/cloudPricing.cjs');

const MIL = 1_000_000;
const sonnet = { route: pricing.ROUTES.ANTHROPIC, modelId: 'claude-sonnet-5' };
const costOf = (context, usage, at = null) => pricing.estimateUsageCost({ pricing: pricing.resolvePricing(context), usage, at });
// Component costs are exact floats; compare within a sub-cent tolerance so a
// last-bit difference never reads as a wrong price.
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test('1. a direct Anthropic exact model ID resolves from the verified catalog', () => {
  const resolved = pricing.resolvePricing(sonnet);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.source, 'anthropic-catalog');
  assert.equal(resolved.input, 2);
  assert.equal(resolved.output, 10);
  assert.equal(resolved.cacheRead, 0.2);
  assert.equal(resolved.cacheWrite, 2.5);
  assert.equal(resolved.cacheWrite1h, 4);
});

test('2. an unlisted Anthropic version is unavailable, never inferred from a similar name', () => {
  for (const modelId of ['claude-sonnet-5.5', 'claude-sonnet-6', 'claude-sonnet']) {
    const resolved = pricing.resolvePricing({ route: pricing.ROUTES.ANTHROPIC, modelId });
    assert.equal(resolved.status, 'unavailable', modelId);
    assert.equal(resolved.source, 'unavailable');
  }
});

test('3. Anthropic cache reads are billed at the cache-read rate', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 1000, cacheReadTokens: 5000, outputTokens: 0 });
  close(estimate.components.cacheRead, 5000 * 0.2 / MIL, 'cache read');
  close(estimate.components.uncachedInput, 1000 * 2 / MIL, 'uncached');
});

test('4. Anthropic cache writes are billed at the 5-minute write premium', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 0, cacheWriteTokens: 1000, outputTokens: 0 });
  close(estimate.components.cacheWrite, 1000 * 2.5 / MIL, 'cache write');
});

test('5. cache savings are positive when reads replace full-price input', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 1000, outputTokens: 500, grossInputTokens: 7000 });
  close(estimate.totalCost, 0.0105, 'total');
  close(estimate.cacheSavings, 0.014 - 0.0055, 'savings');
  assert.ok(estimate.cacheSavings > 0);
});

test('6. cache savings are negative when a write is never read back', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10000, outputTokens: 0, grossInputTokens: 10000 });
  close(estimate.components.cacheWrite, 0.025, 'cache write');
  close(estimate.cacheSavings, -0.005, 'negative savings');
  assert.ok(estimate.cacheSavings < 0);
});

test('7. cache savings are exactly zero when nothing was cached', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, grossInputTokens: 4000 });
  close(estimate.cacheSavings, 0, 'zero savings');
});

test('8. the 1-hour cache-write premium is billed separately when reported', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 0, cacheWrite1hTokens: 1000, outputTokens: 0, grossInputTokens: 1000 });
  close(estimate.components.cacheWrite1h, 1000 * 4 / MIL, 'cache write 1h');
  close(estimate.cacheSavings, (1000 * 2 / MIL) - (1000 * 4 / MIL), '1h savings');
});

test('9. a direct OpenAI exact model ID resolves from the verified catalog', () => {
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.OPENAI, modelId: 'gpt-5' });
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.source, 'openai-catalog');
  assert.equal(resolved.input, 1.25);
  assert.equal(resolved.output, 10);
  assert.equal(resolved.cacheRead, 0.125);
});

test('10. OpenAI long-context pricing applies only above the documented threshold', () => {
  const below = pricing.effectiveRates(pricing.resolvePricing({ route: pricing.ROUTES.OPENAI, modelId: 'gpt-5' }), { grossInputTokens: 272000 });
  const above = pricing.effectiveRates(pricing.resolvePricing({ route: pricing.ROUTES.OPENAI, modelId: 'gpt-5' }), { grossInputTokens: 272001 });
  assert.equal(below.input, 1.25);
  assert.equal(above.input, 2.5, 'strictly greater than the threshold escalates the rate');
  assert.equal(above.output, 15);
});

test('11. OpenAI cache reads are billed at the discounted cached rate', () => {
  const estimate = costOf({ route: pricing.ROUTES.OPENAI, modelId: 'gpt-5' }, { uncachedInputTokens: 900, cacheReadTokens: 100, outputTokens: 0 });
  close(estimate.components.cacheRead, 100 * 0.125 / MIL, 'openai cache read');
});

const openRouterMeta = {
  pricing: {
    prompt: '0.000002', completion: '0.00001',
    input_cache_read: '0.0000002', input_cache_write: '0.0000025',
    overrides: [],
  },
};
test('12. OpenRouter per-token metadata is normalized to per-million rates', () => {
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.OPENROUTER, modelId: 'anthropic/claude-sonnet-5', providerMeta: openRouterMeta });
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.source, 'openrouter-metadata');
  assert.equal(resolved.input, 2);
  assert.equal(resolved.output, 10);
  assert.equal(resolved.cacheRead, 0.2);
});

test('13. an OpenRouter provider-reported charge is authoritative over the estimate', () => {
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.OPENROUTER, modelId: 'vendor/model', providerMeta: openRouterMeta });
  const estimate = pricing.estimateUsageCost({ pricing: resolved,
    usage: { uncachedInputTokens: 1000, outputTokens: 100, providerReportedCost: 1.234567 } });
  assert.equal(estimate.totalCost, 1.234567);
  assert.equal(estimate.source, 'provider-reported');
  assert.equal(estimate.providerReportedCost, 1.234567);
  assert.ok(estimate.estimatedTotal !== null, 'the rate-based estimate is retained for audit');
});

test('14. an OpenRouter conditional override wins only above its min_prompt_tokens', () => {
  const providerMeta = { pricing: { ...openRouterMeta.pricing,
    overrides: [{ min_prompt_tokens: 100000, prompt: '0.000004', completion: '0.00002' }] } };
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.OPENROUTER, modelId: 'vendor/model', providerMeta });
  const small = pricing.effectiveRates(resolved, { grossInputTokens: 50000 });
  const large = pricing.effectiveRates(resolved, { grossInputTokens: 150000 });
  assert.equal(small.input, 2);
  assert.equal(large.input, 4);
  assert.equal(large.output, 20);
});

test('15. an OpenRouter UTC time-window override applies and wraps midnight', () => {
  const providerMeta = { pricing: { ...openRouterMeta.pricing,
    overrides: [{ utc_start: '22:00', utc_end: '02:00', prompt: '0.000006' }] } };
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.OPENROUTER, modelId: 'vendor/model', providerMeta });
  assert.equal(pricing.effectiveRates(resolved, { at: new Date('2026-04-01T23:30:00Z') }).input, 6, 'inside the wrapping window');
  assert.equal(pricing.effectiveRates(resolved, { at: new Date('2026-04-01T12:00:00Z') }).input, 2, 'outside the window');
});

test('16. OpenRouter Claude is billed as OpenRouter, never as direct Anthropic', () => {
  assert.equal(pricing.detectRoute({ apiType: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }), 'openrouter');
  assert.equal(pricing.detectRoute({ apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic');
  // The same model string is not a direct-Anthropic catalog key, so it must not
  // silently resolve to the direct-provider price.
  const direct = pricing.resolvePricing({ route: pricing.ROUTES.ANTHROPIC, modelId: 'anthropic/claude-sonnet-5' });
  assert.equal(direct.status, 'unavailable');
  const routed = pricing.resolvePricing({ route: pricing.ROUTES.OPENROUTER, modelId: 'anthropic/claude-sonnet-5', providerMeta: null });
  assert.equal(routed.status, 'unavailable', 'without OpenRouter metadata there is no OpenRouter price either');
});

test('17. user-configured rates override the catalog', () => {
  const resolved = pricing.resolvePricing({ ...sonnet, userRates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } });
  assert.equal(resolved.source, 'user-configured');
  assert.equal(resolved.input, 1);
  const estimate = pricing.estimateUsageCost({ pricing: resolved, usage: { uncachedInputTokens: 1000, outputTokens: 1000 } });
  close(estimate.totalCost, (1000 * 1 + 1000 * 4) / MIL, 'user-rate total');
});

test('18. user rates without both input and output are refused, not treated as zero', () => {
  assert.equal(pricing.normalizeUserRates({ input: 3 }), null);
  const resolved = pricing.resolvePricing({ ...sonnet, userRates: { input: 3 } });
  assert.equal(resolved.source, 'anthropic-catalog', 'an incomplete override falls back to real evidence');
});

test('19. a local model has no cloud charge — not applicable, never $0.00', () => {
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.LOCAL, modelId: 'llama-3-8b' });
  assert.equal(resolved.status, 'not_applicable');
  const estimate = pricing.estimateUsageCost({ pricing: resolved, usage: { uncachedInputTokens: 1000, outputTokens: 500 } });
  assert.equal(estimate.status, 'not_applicable');
  assert.equal(estimate.completeness, 'not_applicable');
  assert.equal(estimate.totalCost, null, 'null, so a renderer cannot mislabel it $0.00');
});

test('20. reasoning tokens are a subset of output and are never added twice', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 0, outputTokens: 1000, reasoningTokens: 400 });
  close(estimate.components.output, 1000 * 10 / MIL, 'output');
  close(estimate.components.reasoning, 400 * 10 / MIL, 'reasoning subset');
  close(estimate.totalCost, 1000 * 10 / MIL, 'total charges output once');
});

test('21. tiny non-zero costs format precisely and never as $0.00', () => {
  assert.equal(pricing.formatUsd(0.00002), '< $0.0001');
  assert.equal(pricing.formatUsd(0.00123), '$0.00123');
  assert.equal(pricing.formatUsd(0), '$0.00');
  assert.equal(pricing.formatUsd(1.5), '$1.50');
  assert.equal(pricing.formatSignedUsd(-0.005), '-$0.005');
});

test('22. a missing counter makes the estimate partial, not a false total', () => {
  const estimate = costOf(sonnet, { uncachedInputTokens: 1000, outputTokens: null });
  assert.equal(estimate.totalCost, null);
  assert.equal(estimate.completeness, 'partial');
  assert.ok(estimate.missing.includes('output'));
});

test('23. an unknown route/model has no price evidence and stays unavailable', () => {
  const resolved = pricing.resolvePricing({ route: pricing.ROUTES.CUSTOM, modelId: 'some-local-server-model' });
  assert.equal(resolved.status, 'unavailable');
  const estimate = pricing.estimateUsageCost({ pricing: resolved, usage: { uncachedInputTokens: 100, outputTokens: 10 } });
  assert.equal(estimate.totalCost, null);
  assert.equal(estimate.completeness, 'unavailable');
  // ... but a provider-reported charge is still trusted even without a rate.
  const withReport = pricing.estimateUsageCost({ pricing: resolved, usage: { uncachedInputTokens: 100, outputTokens: 10, providerReportedCost: 0.002 } });
  assert.equal(withReport.totalCost, 0.002);
  assert.equal(withReport.source, 'provider-reported');
});
