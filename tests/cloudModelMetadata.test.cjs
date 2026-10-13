const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCloudModel } = require('../src/main/cloudModelMetadata');
test('OpenRouter modalities, tool/reasoning parameters, limits and prices normalize independently', () => {
  const model = normalizeCloudModel({ id: 'example', architecture: { input_modalities: ['text', 'image', 'audio'] }, supported_parameters: ['tools', 'reasoning'], context_length: 128000, top_provider: { max_completion_tokens: 16384 }, pricing: { prompt: '0.000002', completion: '0.000006' } }, 'https://openrouter.ai/api/v1', 'openai');
  assert.equal(model.providerName, 'OpenRouter');
  assert.deepEqual(model.capabilities, { image: true, audio: true, video: false, tools: true, reasoning: true });
  assert.equal(model.contextLength, 128000);
  assert.equal(model.maxOutputTokens, 16384);
  assert.equal(model.pricing.input, 0.000002);
});
test('Anthropic nested capability flags and missing fields retain their meaning', () => {
  const model = normalizeCloudModel({ id: 'claude', max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, thinking: { supported: true } } }, 'https://api.anthropic.com/v1', 'anthropic');
  assert.equal(model.providerName, 'Anthropic');
  assert.equal(model.capabilities.image, true);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.tools, null);
  assert.equal(model.capabilities.audio, null);
  assert.equal(model.pricing.input, null);
});
test('sparse compatible-provider replies remain unknown rather than unsupported', () => {
  const model = normalizeCloudModel({ id: 'custom' }, 'https://custom.example/v1', 'openai');
  assert.equal(model.contextLength, null);
  assert.equal(model.capabilities.image, null);
  assert.equal(model.capabilities.tools, null);
});
