'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const controls = require('../src/lib/reasoningControls.cjs');

// These tests isolate the runtime bridge from the database-backed settings and
// provider registries. The bridge resolves lazily on every request, so the
// mocks stay installed for the whole file and record each lookup.
const originalLoad = Module._load;
const settingsCalls = [];
let settingsByModel = new Map();
let providerRows = [];
let metadataRows = [];

Module._load = function (name, parent, isMain) {
  if (name === './profileSettings') {
    return {
      getSessionSettings(sessionId, modelId) {
        settingsCalls.push({ sessionId: sessionId ?? null, modelId: modelId ?? '' });
        return { effective: settingsByModel.get(modelId ?? '') ?? {} };
      },
    };
  }
  if (name === './cloudProviders') {
    return {
      getCloudProviders: () => providerRows,
      getCloudModelMetadata: async () => metadataRows,
    };
  }
  return originalLoad.call(this, name, parent, isMain);
};

const runtime = require('../src/main/reasoningRuntime');

after(() => { Module._load = originalLoad; });

function reset({ settings = {}, providers = [], metadata = [] } = {}) {
  settingsCalls.length = 0;
  settingsByModel = new Map(Object.entries(settings));
  providerRows = providers;
  metadataRows = metadata;
}

const localCapableModel = {
  hasReasoning: true,
  reasoningEfforts: ['low', 'high'],
  supportsReasoningEffort: true,
  supportsReasoningBudget: true,
  supportsDisableReasoning: true,
};
const localModelWithoutControls = {
  hasReasoning: false,
  reasoningEfforts: [],
  supportsReasoningEffort: false,
  supportsReasoningBudget: false,
  supportsDisableReasoning: false,
};

test('child resolution reads the child model settings, never the parent session', async () => {
  reset({ settings: { '/models/child.gguf': { thinkingBudget: -1, reasoningEffort: 'high' } } });
  const engine = { modelId: '/models/child.gguf', contextLength: 16384 };

  const resolution = await runtime.resolveChildReasoning({ engine, localModel: localCapableModel });

  assert.deepEqual(settingsCalls, [{ sessionId: null, modelId: '/models/child.gguf' }]);
  assert.deepEqual(resolution.effective, { mode: 'effort', effort: 'high', budget: null });
  assert.deepEqual(runtime.requestFieldsForEngine(engine, resolution), { reasoning_effort: 'high' });
});

test('cloud children resolve their own model key and carry a serializable descriptor', async () => {
  reset({
    settings: { 'cloud:router:foo/bar': { thinkingBudget: 4000, reasoningEffort: null } },
    providers: [{ id: 'router', baseUrl: 'https://openrouter.ai/api/v1', apiType: 'openai' }],
    metadata: [{
      providerId: 'router',
      modelId: 'foo/bar',
      reasoning: { supported: true, efforts: ['low', 'high'], supports_max_tokens: true, mandatory: false },
      supportedParameters: ['reasoning'],
    }],
  });
  const engine = { provider: 'cloud', chatTarget: { type: 'cloud', provider: 'router', model: 'foo/bar' } };

  const resolution = await runtime.resolveChildReasoning({ engine });

  assert.deepEqual(settingsCalls, [{ sessionId: null, modelId: 'cloud:router:foo/bar' }]);
  assert.equal(resolution.capabilities.family, 'openrouter');
  assert.deepEqual(resolution.effective, { mode: 'budget', budget: 4000, effort: null });
  const fields = runtime.requestFieldsForEngine(engine, resolution);
  assert.deepEqual(fields, {
    reasoning: {
      effective: { mode: 'budget', budget: 4000, effort: null },
      capabilities: { family: 'openrouter', metadata: { supportedParameters: ['reasoning'] } },
    },
  });
  // The transport consumes the same descriptor and emits the provider's wire
  // contract rather than a generic or local reasoning field.
  assert.deepEqual(controls.cloudRequestFields(fields.reasoning), { fields: { reasoning: { max_tokens: 4000 } } });
});

test('compatible cloud children only advertise parameters their metadata lists', async () => {
  reset({
    settings: { 'cloud:custom:legacy': { thinkingBudget: -1, reasoningEffort: 'low' } },
    providers: [{ id: 'custom', baseUrl: 'https://inference.example.test/v1', apiType: 'openai' }],
    metadata: [{
      providerId: 'custom',
      modelId: 'legacy',
      reasoning: { supported: true, efforts: ['low', 'high'] },
      supportedParameters: ['reasoning_effort'],
    }],
  });
  const engine = { provider: 'cloud', chatTarget: { type: 'cloud', provider: 'custom', model: 'legacy' } };

  const resolution = await runtime.resolveChildReasoning({ engine });
  const fields = runtime.requestFieldsForEngine(engine, resolution);

  assert.equal(resolution.capabilities.family, 'compatible');
  assert.deepEqual(fields.reasoning.capabilities.metadata.supportedParameters, ['reasoning_effort']);
  assert.deepEqual(controls.cloudRequestFields(fields.reasoning).fields, { reasoning_effort: 'low' });
});

test('budget resolution re-reads settings and context on every request', async () => {
  reset({ settings: { '/models/local.gguf': { thinkingBudget: 32768, reasoningEffort: null } } });
  const args = { modelId: '/models/local.gguf', localModel: localCapableModel };

  const small = await runtime.resolveChatReasoning({ ...args, contextSize: 8192 });
  assert.equal(small.effective.mode, 'budget');
  assert.equal(small.effective.budget, 6144);
  assert.match(small.warnings.join(' '), /limited to 6,144/);

  const large = await runtime.resolveChatReasoning({ ...args, contextSize: 32768 });
  assert.equal(large.effective.budget, 30720);

  // A model switch mid-chat must pick up the new model's own settings and
  // template capabilities instead of reusing the previous resolution.
  settingsByModel.set('/models/other.gguf', { thinkingBudget: -1, reasoningEffort: 'high' });
  const switched = await runtime.resolveChatReasoning({
    ...args, modelId: '/models/other.gguf', contextSize: 8192,
  });
  assert.deepEqual(switched.effective, { mode: 'effort', effort: 'high', budget: null });
  assert.deepEqual(settingsCalls.map(call => call.modelId),
    ['/models/local.gguf', '/models/local.gguf', '/models/other.gguf']);
});

test('unsupported saved intent resolves to Automatic with no wire fields', async () => {
  reset({ settings: { '/models/plain.gguf': { thinkingBudget: 2048, reasoningEffort: null } } });
  const engine = { modelId: '/models/plain.gguf' };

  const resolution = await runtime.resolveChatReasoning({
    modelId: '/models/plain.gguf', localModel: localModelWithoutControls,
  });

  assert.equal(resolution.unsupported, true);
  assert.deepEqual(resolution.effective, { mode: 'auto', effort: null, budget: null });
  assert.deepEqual(runtime.requestFieldsForEngine(engine, resolution), {});
  assert.match(resolution.warnings.join(' '), /not supported/i);
});

test('Automatic preserves the provider default for local and cloud targets', async () => {
  reset({ settings: {} });
  const localEngine = { modelId: '/models/local.gguf' };
  const local = await runtime.resolveChatReasoning({
    modelId: '/models/local.gguf', localModel: localCapableModel, contextSize: 8192,
  });
  assert.deepEqual(local.effective, { mode: 'auto', effort: null, budget: null });
  assert.deepEqual(runtime.requestFieldsForEngine(localEngine, local), {});

  reset({
    providers: [{ id: 'router', baseUrl: 'https://openrouter.ai/api/v1', apiType: 'openai' }],
    metadata: [{ providerId: 'router', modelId: 'foo/bar', reasoning: { supported: true } }],
  });
  const cloudEngine = { provider: 'cloud', chatTarget: { type: 'cloud', provider: 'router', model: 'foo/bar' } };
  const cloud = await runtime.resolveChildReasoning({ engine: cloudEngine });
  assert.deepEqual(cloud.effective, { mode: 'auto', effort: null, budget: null });
  assert.deepEqual(runtime.requestFieldsForEngine(cloudEngine, cloud), {});
});

test('engine target helpers keep local and cloud identities distinct', () => {
  const local = { modelId: '/models/local.gguf' };
  const cloud = { provider: 'cloud', chatTarget: { type: 'cloud', provider: 'router', model: 'foo/bar' } };
  assert.deepEqual(runtime.targetFromEngine(local), { type: 'local' });
  assert.deepEqual(runtime.targetFromEngine(cloud), { type: 'cloud', provider: 'router', model: 'foo/bar' });
  assert.equal(runtime.settingsModelIdForEngine(local), '/models/local.gguf');
  assert.equal(runtime.settingsModelIdForEngine(cloud), 'cloud:router:foo/bar');

  const described = runtime.describeResolution({
    capabilities: { family: 'local', source: 'local-metadata', reasoning: true, efforts: ['low'],
      supportsEffort: true, canDisable: true, budget: { supported: false, min: 0, max: null } },
    intent: { mode: 'effort', effort: 'low', budget: null },
    effective: { mode: 'effort', effort: 'low', budget: null },
    warnings: ['kept'],
  });
  assert.equal(described.family, 'local');
  assert.deepEqual(described.warnings, ['kept']);
  assert.equal(JSON.stringify(described).includes('apiKey'), false);
});
