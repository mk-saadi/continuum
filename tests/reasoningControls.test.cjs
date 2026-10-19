const test = require('node:test');
const assert = require('node:assert/strict');
const controls = require('../src/lib/reasoningControls.cjs');

const localModel = {
  hasReasoning: true,
  supportsReasoningEffort: true,
  supportsReasoningBudget: true,
  supportsDisableReasoning: true,
  reasoningEfforts: ['low', 'high'],
};
const effortsOnlyModel = {
  hasReasoning: true, reasoningEfforts: ['low', 'medium', 'high'],
  supportsReasoningEffort: true, supportsReasoningBudget: false, supportsDisableReasoning: true,
};
const noReasoningModel = { hasReasoning: false, supportsReasoningEffort: false,
  supportsReasoningBudget: false, supportsDisableReasoning: false };

const provider = (kind) => {
  if (kind === 'anthropic') return { apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' };
  if (kind === 'openrouter') return { apiType: 'openai', baseUrl: 'https://openrouter.ai/api/v1' };
  if (kind === 'deepseek') return { apiType: 'openai', baseUrl: 'https://api.deepseek.com/v1' };
  if (kind === 'gemini') return { apiType: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
  if (kind === 'openai') return { apiType: 'openai', baseUrl: 'https://api.openai.com/v1' };
  return { apiType: 'openai', baseUrl: 'https://compatible.example/v1' };
};

function resolveCloud(kind, modelId, intent, metadata = null) {
  const capabilities = controls.resolveCapabilities({
    target: { type: 'cloud' }, provider: provider(kind), modelId, metadata,
  });
  const resolution = controls.resolveReasoning({ intent, capabilities });
  return { capabilities, resolution, wire: controls.cloudRequestFields(resolution, { modelId, maxTokens: -1 }) };
}

function resolveLocal(intent, model = localModel, contextSize = null) {
  const capabilities = controls.resolveCapabilities({ target: { type: 'local' }, localModel: model });
  const resolution = controls.resolveReasoning({ intent, capabilities, contextSize });
  return { capabilities, resolution, wire: controls.localRequestFields(resolution) };
}

const openRouterMetadata = (overrides = {}) => ({
  capabilities: { reasoning: true },
  reasoning: { supported: true, efforts: ['low', 'medium', 'high'],
    default_effort: 'medium', supports_max_tokens: true, min_tokens: 1024, max_tokens: 32000, mandatory: false, ...overrides },
  supportedParameters: ['reasoning', 'reasoning_effort', 'include_reasoning'],
});

test('intent normalization keeps auto, off, effort, and numeric budget distinct', () => {
  assert.deepEqual(controls.normalizeIntent({}), { mode: 'auto', effort: null, budget: null });
  assert.deepEqual(controls.normalizeIntent({ thinkingBudget: -1 }), { mode: 'auto', effort: null, budget: null });
  assert.deepEqual(controls.normalizeIntent({ thinkingBudget: 0 }), { mode: 'off', effort: null, budget: null });
  assert.deepEqual(controls.normalizeIntent({ thinkingBudget: 2500 }), { mode: 'budget', effort: null, budget: 2500 });
  assert.deepEqual(controls.normalizeIntent({ reasoningEffort: 'HIGH' }), { mode: 'effort', effort: 'high', budget: null });
  // Persisted values are mutually exclusive; a numeric budget wins if both exist.
  assert.deepEqual(controls.normalizeIntent({ thinkingBudget: 1024, reasoningEffort: 'high' }),
    { mode: 'budget', effort: null, budget: 1024 });
  assert.deepEqual(controls.normalizeIntent({ thinkingBudget: -5, reasoningEffort: ' ' }),
    { mode: 'auto', effort: null, budget: null });
});

test('Automatic always preserves the provider default by sending nothing', () => {
  assert.deepEqual(controls.localRequestFields(resolveLocal({ mode: 'auto' }).resolution), {});
  assert.deepEqual(controls.cloudRequestFields(resolveCloud('openrouter', 'm', { mode: 'auto' },
    openRouterMetadata()).resolution, { modelId: 'm', maxTokens: 1500 }),
  { fields: {}, maxTokens: 1500 });
});

test('local mapping uses the installed runtime fields and never legacy aliases', () => {
  const effort = resolveLocal({ mode: 'effort', effort: 'high' }).wire;
  assert.deepEqual(effort, { reasoning_effort: 'high' });
  const budget = resolveLocal({ mode: 'budget', budget: 2500 }).wire;
  assert.deepEqual(budget, { reasoning_budget_tokens: 2500 });
  const off = resolveLocal({ mode: 'off' }).wire;
  assert.deepEqual(off, { reasoning_effort: 'none', reasoning_budget_tokens: 0 });
  for (const fields of [effort, budget, off]) {
    assert.equal(Object.hasOwn(fields, 'thinking_budget'), false);
    assert.equal(Object.hasOwn(fields, 'reasoning_budget'), false);
    assert.equal(Object.hasOwn(fields, 'max_thinking_tokens'), false);
    assert.equal(Object.hasOwn(fields, 'chat_template_kwargs'), false);
  }
});

test('local off omits the numeric zero when the template has no budget support', () => {
  assert.deepEqual(resolveLocal({ mode: 'off' }, effortsOnlyModel).wire, { reasoning_effort: 'none' });
});

test('a local numeric budget is gated by template evidence and clamped to context', () => {
  const withoutTags = { hasReasoning: true, supportsReasoningEffort: false,
    supportsReasoningBudget: false, supportsDisableReasoning: false };
  const unsupported = resolveLocal({ mode: 'budget', budget: 4096 }, withoutTags);
  assert.equal(unsupported.resolution.unsupported, true);
  assert.deepEqual(unsupported.wire, {});

  const capable = { hasReasoning: true, supportsReasoningBudget: true, supportsDisableReasoning: true };
  assert.deepEqual(resolveLocal({ mode: 'budget', budget: 2500 }, capable, 8192).wire,
    { reasoning_budget_tokens: 2500 });
  const clamped = resolveLocal({ mode: 'budget', budget: 32768 }, capable, 8192);
  assert.equal(clamped.resolution.effective.budget, 6144);
  assert.match(clamped.resolution.warnings.join(' '), /limited to 6,144/);
});

test('unsupported intent resolves to Automatic with an honest warning, never a coercion', () => {
  const noReasoning = resolveLocal({ mode: 'effort', effort: 'high' }, noReasoningModel);
  assert.equal(noReasoning.resolution.unsupported, true);
  assert.equal(noReasoning.resolution.effective.mode, 'auto');
  assert.match(noReasoning.resolution.warnings[0], /not supported/);

  const wrongEffort = resolveLocal({ mode: 'effort', effort: 'max' }, effortsOnlyModel);
  assert.equal(wrongEffort.resolution.unsupported, true);
  assert.equal(wrongEffort.resolution.effective.mode, 'auto');
  // It must not silently become "high" or a token budget.
  assert.equal(wrongEffort.resolution.effective.effort, null);
  assert.equal(wrongEffort.resolution.effective.budget, null);
});

test('provider-family detection uses apiType and documented hosts only', () => {
  assert.equal(controls.providerFamily(provider('anthropic')), 'anthropic');
  assert.equal(controls.providerFamily(provider('openrouter')), 'openrouter');
  assert.equal(controls.providerFamily(provider('deepseek')), 'deepseek');
  assert.equal(controls.providerFamily(provider('gemini')), 'gemini');
  assert.equal(controls.providerFamily(provider('openai')), 'openai');
  assert.equal(controls.providerFamily({ baseUrl: 'http://127.0.0.1:8080/v1' }), 'compatible');
  assert.equal(controls.providerFamily({}), 'compatible');
});

test('Anthropic version detection selects adaptive versus legacy contracts', () => {
  assert.deepEqual(controls.anthropicVersion('claude-opus-4-7'), { major: 4, minor: 7 });
  assert.deepEqual(controls.anthropicVersion('claude-sonnet-4.6'), { major: 4, minor: 6 });
  assert.deepEqual(controls.anthropicVersion('claude-3-7-sonnet-20250219'), { major: 3, minor: 7 });
  assert.equal(controls.anthropicAdaptive('claude-opus-4-6'), false);
  assert.equal(controls.anthropicAdaptive('claude-opus-4-7'), true);
});

test('Anthropic adaptive effort uses thinking.type=adaptive plus output_config.effort', () => {
  const effort = resolveCloud('anthropic', 'claude-opus-4-7', { mode: 'effort', effort: 'high' });
  assert.deepEqual(effort.wire.fields, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.equal(effort.wire.maxTokens, 4096);

  const off = resolveCloud('anthropic', 'claude-opus-4-7', { mode: 'off' });
  assert.deepEqual(off.wire.fields, { thinking: { type: 'disabled' } });

  const budget = resolveCloud('anthropic', 'claude-opus-4-7', { mode: 'budget', budget: 4096 });
  assert.equal(budget.resolution.unsupported, true);
  assert.deepEqual(budget.wire.fields, {});
});

test('Anthropic legacy budget enforces the documented minimum and max_tokens relationship', () => {
  const budget = resolveCloud('anthropic', 'claude-sonnet-4-6', { mode: 'budget', budget: 4096 });
  assert.deepEqual(budget.wire.fields, { thinking: { type: 'enabled', budget_tokens: 4096 } });
  assert.ok(budget.wire.maxTokens > 4096);

  const tooSmall = resolveCloud('anthropic', 'claude-sonnet-4-6', { mode: 'budget', budget: 512 });
  assert.equal(tooSmall.resolution.unsupported, true);
  assert.deepEqual(tooSmall.wire.fields, {});

  const off = resolveCloud('anthropic', 'claude-sonnet-4-6', { mode: 'off' });
  assert.deepEqual(off.wire.fields, {}); // extended thinking defaults off
});

test('OpenRouter maps metadata-advertised effort, budget, and disable', () => {
  const metadata = openRouterMetadata();
  const effort = resolveCloud('openrouter', 'any/model', { mode: 'effort', effort: 'medium' }, metadata);
  assert.deepEqual(effort.wire.fields, { reasoning: { effort: 'medium' } });
  const budget = resolveCloud('openrouter', 'any/model', { mode: 'budget', budget: 2000 }, metadata);
  assert.deepEqual(budget.wire.fields, { reasoning: { max_tokens: 2000 } });
  const off = resolveCloud('openrouter', 'any/model', { mode: 'off' }, metadata);
  assert.deepEqual(off.wire.fields, { reasoning: { enabled: false } });

  const mandatory = resolveCloud('openrouter', 'any/model', { mode: 'off' },
    openRouterMetadata({ mandatory: true }));
  assert.equal(mandatory.resolution.unsupported, true);
  assert.deepEqual(mandatory.wire.fields, {});

  const budgetTooSmall = resolveCloud('openrouter', 'any/model', { mode: 'budget', budget: 10 }, metadata);
  assert.equal(budgetTooSmall.resolution.unsupported, true);
});

test('OpenRouter without metadata never guesses a control', () => {
  for (const intent of [{ mode: 'effort', effort: 'high' }, { mode: 'budget', budget: 2048 }, { mode: 'off' }]) {
    const result = resolveCloud('openrouter', 'unknown/model', intent);
    assert.equal(result.resolution.unsupported, true);
    assert.deepEqual(result.resolution.effective, { mode: 'auto', effort: null, budget: null });
    assert.deepEqual(result.wire.fields, {});
  }
});

test('DeepSeek supports documented effort and disable, never a numeric budget', () => {
  const effort = resolveCloud('deepseek', 'deepseek-reasoner', { mode: 'effort', effort: 'max' });
  assert.deepEqual(effort.wire.fields, { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  const off = resolveCloud('deepseek', 'deepseek-reasoner', { mode: 'off' });
  assert.deepEqual(off.wire.fields, { thinking: { type: 'disabled' } });
  const budget = resolveCloud('deepseek', 'deepseek-reasoner', { mode: 'budget', budget: 4096 });
  assert.equal(budget.resolution.unsupported, true);
  assert.deepEqual(budget.wire.fields, {});
});

test('Gemini respects per-model disable and budget rules', () => {
  const effort = resolveCloud('gemini', 'gemini-3-pro-preview', { mode: 'effort', effort: 'high' });
  assert.deepEqual(effort.wire.fields, { reasoning_effort: 'high' });
  const cannotDisable = resolveCloud('gemini', 'gemini-3-pro-preview', { mode: 'off' });
  assert.equal(cannotDisable.resolution.unsupported, true);

  const off = resolveCloud('gemini', 'gemini-2.5-flash', { mode: 'off' });
  assert.deepEqual(off.wire.fields, { reasoning_effort: 'none' });
  const budget = resolveCloud('gemini', 'gemini-2.5-flash', { mode: 'budget', budget: 10000 });
  assert.deepEqual(budget.wire.fields,
    { extra_body: { google: { thinking_config: { thinking_budget: 10000 } } } });
  const tooLarge = resolveCloud('gemini', 'gemini-2.5-flash', { mode: 'budget', budget: 30000 });
  assert.equal(tooLarge.resolution.effective.budget, 24576);
});

test('OpenAI exposes effort only, with no numeric Chat Completions budget', () => {
  const effort = resolveCloud('openai', 'gpt-5.1', { mode: 'effort', effort: 'high' });
  assert.deepEqual(effort.wire.fields, { reasoning_effort: 'high' });
  const budget = resolveCloud('openai', 'gpt-5.1', { mode: 'budget', budget: 2048 });
  assert.equal(budget.resolution.unsupported, true);
  assert.deepEqual(budget.wire.fields, {});
  const off = resolveCloud('openai', 'gpt-5.1', { mode: 'off' });
  assert.equal(off.resolution.unsupported, true);
  const unknown = resolveCloud('openai', 'future-model', { mode: 'effort', effort: 'low' });
  assert.equal(unknown.resolution.unsupported, true);
});

test('generic compatible endpoints only receive parameters their metadata advertises', () => {
  const metadata = {
    capabilities: { reasoning: true },
    reasoning: { supported: true, efforts: [], supports_max_tokens: true },
    supportedParameters: ['reasoning'],
  };
  const budget = resolveCloud('compatible', 'custom', { mode: 'budget', budget: 1500 }, metadata);
  assert.deepEqual(budget.wire.fields, { reasoning: { max_tokens: 1500 } });
  const off = resolveCloud('compatible', 'custom', { mode: 'off' }, metadata);
  assert.deepEqual(off.wire.fields, { reasoning: { enabled: false } });

  const effortOnly = {
    capabilities: { reasoning: true }, reasoning: { supported: true, efforts: ['low', 'high'] },
    supportedParameters: ['reasoning_effort'],
  };
  assert.deepEqual(resolveCloud('compatible', 'custom', { mode: 'effort', effort: 'low' }, effortOnly).wire.fields,
    { reasoning_effort: 'low' });

  const noWire = {
    capabilities: { reasoning: true }, reasoning: { supported: true, efforts: ['low'] },
    supportedParameters: [],
  };
  const unsupported = resolveCloud('compatible', 'custom', { mode: 'effort', effort: 'low' }, noWire);
  assert.equal(unsupported.resolution.unsupported, true);
  assert.deepEqual(unsupported.wire.fields, {});
});

test('public capability view contains no transport internals or secrets', () => {
  const publicView = controls.publicCapabilities(resolveLocal({ mode: 'auto' }).capabilities);
  assert.deepEqual(Object.keys(publicView).sort(),
    ['budget', 'canDisable', 'efforts', 'family', 'reasoning', 'source']);
  assert.equal(JSON.stringify(publicView).includes('apiKey'), false);
});
