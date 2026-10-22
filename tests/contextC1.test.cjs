'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createRuntimeBudget, atCompactionPressure, createPromptMeasurer, createContextGuardedFetch,
  setContextRuntimeProvider } = require('../src/main/contextBudget');
const url = 'http://localhost:18080/v1/chat/completions';
const payload = { model: 'incident', max_tokens: 1024, messages: [{ role: 'user', content: 'history' }], tools: [] };
function runtime() {
  const state = { capacity: 35072, count: 30528, props: 0, tokenize: 0, dispatch: 0, available: true };
  state.fetch = async (url, options = {}) => {
    switch (new URL(url).pathname) {
      case '/props': state.props++; if (!state.available) throw Error('offline');
        return Response.json({ model_path: 'incident', chat_template: 'template', default_generation_settings: { n_ctx: state.capacity } });
      case '/apply-template': return Response.json({ prompt: options.body });
      case '/tokenize': state.tokenize++; return Response.json({ tokens: Array(state.count).fill(1) });
      default: state.dispatch++; return Response.json({ ok: true });
    }
  };
  return state;
}
const incident = currentInputTokens => createRuntimeBudget({ configuredContextTokens: 70000,
  runtimeContextTokens: 35072, payload, currentInputTokens });

test('exact incident: one contract drives header denominator, panel and 90% pressure', async () => {
  const b = incident(30528);
  assert.equal(b.usableInputTokens, 33920);
  assert.equal(b.autoCompactionTriggerTokens, 30528);
  assert.equal(b.reservedOutputTokens, 1024);
  assert.equal(b.reservedSafetyTokens, 128);
  assert.ok(atCompactionPressure(b));
  const { buildContextLabel, buildContextTooltip } = await import('../src/lib/contextDisplay.mjs');
  assert.equal(buildContextLabel({ total: 29100, limit: b.usableInputTokens }).label, 'Context: 29.1k / 33.9k');
  assert.match(buildContextTooltip({ total: 29100, limit: b.usableInputTokens, budgetContract: b }), /30,528/);
});
for (const [slots, capacity] of [[1, 70144], [2, 35072], [3, 23424], [4, 17600]]) {
  test(`${slots} slots: reported rounded capacity wins over total and arithmetic division`, () => {
    const b = createRuntimeBudget({ configuredContextTokens: 70000, runtimeContextTokens: capacity, payload });
    assert.equal(b.capacityTokens, capacity);
    assert.equal(b.usableInputTokens, capacity - 1152);
  });
}
for (const [tokens, pressure] of [[30527, false], [30528, true], [30529, true], [34000, true]]) {
  test(`pressure at ${tokens} full-request tokens`, () => assert.equal(atCompactionPressure(incident(tokens)), pressure));
}
test('output, reasoning and safety share reservation policy; impossible reserves reject', () => {
  const b = createRuntimeBudget({ runtimeContextTokens: 35072, payload: { max_tokens: 2048, reasoning_budget_tokens: 4096 } });
  assert.equal(b.reservedOutputTokens, 4096);
  assert.equal(b.usableInputTokens, 35072 - 4096 - 128);
  assert.throws(() => createRuntimeBudget({ runtimeContextTokens: 1024, payload: { max_tokens: 1024 } }), /reservation/);
  assert.throws(() => createRuntimeBudget({ runtimeContextTokens: 35072, payload: { max_tokens: Infinity } }), /reservation/);
});
for (const value of [null, 0, -1, NaN, Infinity, 1.5]) {
  test(`invalid capacity ${value} is an explicitly unverified bounded fallback`, () => {
    const b = createRuntimeBudget({ configuredContextTokens: 70000, runtimeContextTokens: value });
    assert.equal(b.capacityTokens, 8192);
    assert.equal(b.runtimeContextTokens, null);
    assert.equal(b.capacityConfidence, 'unverified');
  });
}
test('guard rejects the 70%-to-103% jump without dispatch or changing original input', async () => {
  const r = runtime(); r.count = 34000;
  const original = JSON.stringify(payload);
  await assert.rejects(createContextGuardedFetch(r.fetch)(url, { method: 'POST', body: original, contextWindowLimit: 70000 }), /budget 33920/);
  assert.equal(r.dispatch, 0);
  assert.equal(JSON.stringify(payload), original);
});
test('capacity is refreshed while counts cache; slots/context/process/output/tools/payload update budgets', async () => {
  const r = runtime(), measure = createPromptMeasurer(r.fetch);
  const options = { contextWindowLimit: 70000, runtimeIdentity: 'process-1' };
  const first = await measure(url, payload, options);
  const start = performance.now();
  await measure(url, payload, options);
  const cacheHitMs = performance.now() - start;
  assert.equal(r.tokenize, 1);
  r.capacity = 16384;
  const changed = await measure(url, payload, options);
  assert.equal(changed.limit, 16384);
  assert.equal(changed.budget, 15232);
  await measure(url, payload, { ...options, runtimeIdentity: 'process-2' });
  assert.equal(r.tokenize, 3);
  const output = await measure(url, { ...payload, max_tokens: 2048 }, options);
  assert.equal(output.budget, 14208);
  await measure(url, { ...payload, tools: [{ type: 'function', function: { name: 'new_schema', parameters: {} } }] }, options);
  await measure(url, { ...payload, messages: [{ role: 'user', content: 'new attachment text' }] }, options);
  assert.equal(r.props, 7);
  console.log(JSON.stringify({ cacheHitMs, propsPerExplicitMeasurement: 1, tokenizerCalls: r.tokenize }));
  assert.equal(first.budget, 33920);
});
for (const count of [1, 2]) {
  test(`${count} image(s) keep explicit conservative allowances and estimated confidence`, async () => {
    const r = runtime();
    const result = await createPromptMeasurer(r.fetch)(url, { ...payload, messages: [{ role: 'user', content: [
      { type: 'text', text: 'attachment instructions' }, ...Array.from({ length: count }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } })),
    ] }] }, { contextWindowLimit: 70000 });
    assert.equal(result.imageAllowanceTokens, count * 4096);
    assert.equal(result.budgetContract.measurementConfidence, 'estimated');
    assert.equal(result.budgetContract.capacityConfidence, 'verified');
    assert.equal(r.tokenize, 0);
    assert.equal(result.note, 'image-tokens-estimated');
  });
}
test('backend outage never reuses the last verified large capacity', async () => {
  const r = runtime(), measure = createPromptMeasurer(r.fetch);
  await measure(url, payload, { contextWindowLimit: 70000 });
  r.available = false;
  const result = await measure(url, payload, { contextWindowLimit: 70000 });
  assert.equal(result.limit, 8192);
  assert.equal(result.budgetContract.capacityConfidence, 'unverified');
});
test('runtime change during measurement fails closed', async () => {
  const r = runtime(); let generation = 'one';
  setContextRuntimeProvider(() => ({ port: 18080, runtimeIdentity: generation }));
  try {
    await assert.rejects(createPromptMeasurer(async (url, options) => {
      const response = await r.fetch(url, options);
      if (new URL(url).pathname === '/tokenize') generation = 'two';
      return response;
    })(url, payload, { contextWindowLimit: 70000 }), /backend changed/);
  } finally { setContextRuntimeProvider(() => null); }
});
test('cloud advertised capacity has no local slot arithmetic or verified label', () => {
  const b = createRuntimeBudget({ provider: 'anthropic', runtimeContextTokens: 200000, payload: { max_tokens: 8192 } });
  assert.equal(b.usableInputTokens, 191680);
  assert.equal(b.capacityConfidence, 'unverified');
  assert.equal(b.capacityMethod, 'provider-advertised');
});

test('backend outage during recovery retains a smaller known overflow limit', async () => {
  const r = runtime(); r.available = false;
  const result = await createPromptMeasurer(r.fetch)(url, { ...payload, max_tokens: 128 },
    { contextWindowLimit: 70000 }, 2048);
  assert.equal(result.limit, 2048);
  assert.equal(result.budget, 1899);
  assert.equal(result.budgetContract.capacityConfidence, 'unverified');
});
