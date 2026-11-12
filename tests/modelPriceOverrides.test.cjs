const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const pricing = require('../src/lib/cloudPricing.cjs');

test('model prices drive sync, async, and child estimates without leaking to other models', async () => {
  let manual = { inputPrice: 2, outputPrice: 8 };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/main/costEstimator'), 'utf8'), {
    module, Date,
    require: name => {
      if (name === '../lib/cloudPricing.cjs') return pricing;
      if (name === './cloudProviders') return {
        getStoredProvider: id => ({ id, baseUrl: 'https://openrouter.ai/api/v1', pricing: { input: 999, output: 999 } }),
        getKnownModelMetadata: () => ({ pricingRaw: { prompt: '0.000001', completion: '0.000003' } }),
        getCloudModelMetadata: async () => [],
      };
      if (name === './capabilityOverrides') return { getOverrides: target => target.provider === 'one' && target.model === 'custom/model' ? manual : {} };
      throw new Error(name);
    },
  });
  const service = module.exports;
  const target = { providerId: 'one', modelId: 'custom/model' };
  assert.equal(service.resolveTurnPricingSync(target).input, 2);
  assert.equal((await service.resolveTurnPricingAsync(target)).output, 8);
  assert.equal(service.resolveTurnPricingSync({ ...target, modelId: 'other/model' }).input, 1);
  assert.equal(service.resolveTurnPricingSync({ ...target, providerId: 'two' }).input, 1);
  const child = service.estimateFromChild({ ...target, usage: { prompt_tokens: 1000000, uncached_input_tokens: 1000000, cache_read_input_tokens: 0, cache_write_input_tokens: 0, completion_tokens: 1000000 } });
  assert.equal(child.totalCost, 10);
  const stats = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000 };
  assert.equal(service.estimateFromStats({ ...target, stats }).totalCost, 10, 'main chat uses per-model prices');
  assert.equal(service.estimateFromStats({ ...target, stats: { ...stats, providerReportedCost: 0.75 } }).totalCost, 0.75, 'provider charge wins over an estimate');

  manual = { inputPrice: 0, outputPrice: 0 };
  assert.equal(service.resolveTurnPricingSync(target).input, 0);
  manual = {};
  assert.equal(service.resolveTurnPricingSync(target).input, 1, 'reset restores provider metadata');
});
