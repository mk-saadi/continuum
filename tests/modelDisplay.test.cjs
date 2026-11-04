'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelDisplayName, modelIdentity } = require('../src/lib/modelDisplay.cjs');

test('local usage labels omit directories on either platform', () => {
  assert.equal(modelDisplayName('/home/user/models/Qwen3-Q4_K_M.gguf'), 'Qwen3-Q4_K_M');
  assert.equal(modelDisplayName('C:\\Models\\Qwen3.gguf'), 'Qwen3');
});
test('cloud keys resolve names using their embedded provider and retain colons in model IDs', () => {
  const key = 'cloud:provider-id:vendor/model:free';
  assert.deepEqual(modelIdentity(key), { providerId: 'provider-id', modelId: 'vendor/model:free' });
  assert.equal(modelDisplayName(key, { metadata: (provider, model) => {
    assert.equal(provider, 'provider-id');
    assert.equal(model, 'vendor/model:free');
    return { name: 'Friendly Model (free)' };
  } }), 'Friendly Model (free)');
});
test('missing metadata has a readable fallback without a provider UUID', () => {
  assert.equal(modelDisplayName('cloud:deleted-provider:vendor/deepseek-v4.1-flash-free'), 'Deepseek V4.1 Flash Free');
  assert.equal(modelDisplayName(null), 'Unknown model');
  assert.equal(modelDisplayName('vendor/model', { name: 'Official Name' }), 'Official Name');
});

test('browser ESM entry point matches the backend helper', async () => {
  const browser = await import('../src/lib/modelDisplay.mjs');
  for (const id of [null, '/models/Qwen.gguf', 'C:\\Models\\Qwen.gguf', 'cloud:provider:vendor/model:free', 'vendor/model']) {
    assert.equal(browser.modelDisplayName(id), modelDisplayName(id));
    assert.deepEqual(browser.modelIdentity(id), modelIdentity(id));
  }
});
