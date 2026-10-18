'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Phase 1.3A follow-up: budgets must resolve from the *effective child model*,
// not the parent chat's model. The sub-agent model setting (Settings ->
// Sub-Agent Model) picks one of:
//
//   null                          follow the chat model (the parent engine)
//   { type: 'local' }             the running local server's loaded model
//   { type: 'cloud', ... }        a saved cloud provider + model
//
// Whatever it picks, token/context limits, the Automatic budget, cumulative
// accounting, usage normalization and scheduling lanes all derive from the
// child engine — and selecting a different child model never mutates the
// parent's engine, context, or budget.

// --- electron mock (db.js captures `app` at require time) ------------------
const directory = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'subagent-model-budgets-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const db = require('../src/main/db');
const cloudProviders = require('../src/main/cloudProviders');
const modelSelection = require('../src/main/subagents/modelSelection');
const budgets = require('../src/main/subagents/budgets');
const executionBudget = require('../src/main/subagents/executionBudget');
const executionManager = require('../src/main/subagents/executionManager');
const providers = require('../src/main/subagents/providers');
// db.js lazily requires this at initDatabase() time; cache it now, while the
// electron mock (with app.getPath) is still installed.
require('../src/main/legacyDataMigration');
Module._load = originalLoad;

const saveCloudProvider = cloudProviders.saveCloudProvider;
const originalCreateCloudFetch = cloudProviders.createCloudFetch;
const originalGetCloudModelMetadata = cloudProviders.getCloudModelMetadata;

// --- engines under test ----------------------------------------------------
// A local chat: the parent descriptor carries its own window.
const localParent = () => ({ port: 4321, modelId: 'local-parent', contextLength: 32768 });
// A cloud chat: ipcHandlers buildChatEngine produces exactly this shape, with
// no contextLength — the window is only knowable from provider metadata.
const CLOUD_PARENT_TARGET = { type: 'cloud', provider: 'prov-a', model: 'org/cloud-big' };
const cloudParent = () => ({ provider: 'cloud', modelId: 'org/cloud-big', chatTarget: CLOUD_PARENT_TARGET });

const setSelection = value => modelSelection.saveSubagentModel(value);
const clearSelection = () => modelSelection.saveSubagentModel(null);
const snapshot = value => JSON.stringify(value);

before(async () => {
  db.initDatabase(directory);
  // The saved cloud provider the selection validates against (same registry
  // the chat uses — nothing is hard-coded in the runtime).
  saveCloudProvider({
    id: 'prov-a', name: 'Provider A', baseUrl: 'https://cloud.example/v1',
    modelId: 'org/cloud-big', apiKey: 'test-key', apiType: 'openai',
  });
});

after(async () => {
  try { clearSelection(); } catch { /* the database may never have opened */ }
  modelSelection.setEngineConfigProvider(() => null);
  cloudProviders.createCloudFetch = originalCreateCloudFetch;
  cloudProviders.getCloudModelMetadata = originalGetCloudModelMetadata;
  try { db.closeDatabase(); } catch { /* already closed */ }
  await fs.rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Follow the chat model (the default) is preserved for both chat types.
// ---------------------------------------------------------------------------

test('follow-the-chat-model: a local chat child is the parent engine, unchanged', () => {
  clearSelection();
  const parent = localParent();
  const before = snapshot(parent);
  const child = modelSelection.resolveChildEngine(parent);
  assert.equal(child, parent, 'the parent descriptor is inherited by identity');
  assert.equal(snapshot(parent), before, 'inheriting never mutates the parent');

  const b = budgets.resolveTaskBudgets({ kind: 'investigation', engine: child });
  assert.equal(b.contextLength, 32768, 'budgets use the inherited window');
  assert.equal(b.inputBudget, 200 * 32768);
  assert.equal(b.maxTurns, 200);
  assert.equal(b.maxToolCalls, 400);
});

test('follow-the-chat-model: a cloud chat child keeps the parent cloud target', () => {
  clearSelection();
  const parent = cloudParent();
  const before = snapshot(parent);
  const child = modelSelection.resolveChildEngine(parent);
  assert.equal(child, parent);
  assert.equal(snapshot(parent), before);
  // No descriptor window on a cloud chat: the Automatic policy uses the
  // documented fallback until the provider resolves the real window.
  const b = budgets.resolveTaskBudgets({ kind: 'investigation', engine: child });
  assert.equal(b.contextLength, budgets.FALLBACK_CONTEXT_LENGTH);
});

// ---------------------------------------------------------------------------
// 2. Local parent -> cloud child: budgets come from the CLOUD model's window.
// ---------------------------------------------------------------------------

test('local parent + cloud child: token/context limits resolve from the cloud model', async () => {
  await setSelection({ type: 'cloud', provider: 'prov-a', model: 'org/cloud-big' });
  const parent = localParent();
  const before = snapshot(parent);

  const child = modelSelection.resolveChildEngine(parent);
  assert.equal(child.provider, 'cloud');
  assert.equal(child.modelId, 'org/cloud-big');
  assert.deepEqual(child.chatTarget, CLOUD_PARENT_TARGET);
  assert.equal(snapshot(parent), before, 'routing to a cloud child never alters the parent');

  // The cloud descriptor carries no window; provider metadata supplies it.
  const resolved = await budgets.resolveEngineContextLength(child, {
    getCloudModelMetadata: async () => [
      { providerId: 'prov-a', modelId: 'org/cloud-big', contextLength: 200000 },
    ],
  });
  assert.deepEqual(resolved, { contextLength: 200000, source: 'provider-metadata' });

  const b = budgets.resolveTaskBudgets({ kind: 'investigation', engine: child, contextLength: resolved.contextLength });
  assert.equal(b.contextLength, 200000, 'Automatic uses the child model capacity');
  assert.equal(b.inputBudget, 200 * 200000, 'cumulative input envelope scales with the child window');
  assert.notEqual(b.contextLength, 32768, 'the parent window is never used');

  // The parent's own derived budgets are unchanged by resolving the child.
  const parentBudget = budgets.resolveTaskBudgets({ kind: 'investigation', engine: parent });
  assert.equal(parentBudget.contextLength, 32768);
  assert.equal(parentBudget.inputBudget, 200 * 32768);
});

test('cloud metadata that cannot be resolved falls back and says so', async () => {
  await setSelection({ type: 'cloud', provider: 'prov-a', model: 'org/cloud-big' });
  const child = modelSelection.resolveChildEngine(localParent());
  const resolved = await budgets.resolveEngineContextLength(child, { getCloudModelMetadata: async () => [] });
  assert.deepEqual(resolved, { contextLength: budgets.FALLBACK_CONTEXT_LENGTH, source: 'fallback' });
  const b = budgets.resolveTaskBudgets({ kind: 'investigation', engine: child, contextLength: resolved.contextLength });
  assert.equal(b.contextLength, budgets.FALLBACK_CONTEXT_LENGTH);
  assert.equal(b.inputBudget, 200 * budgets.FALLBACK_CONTEXT_LENGTH);
});

// ---------------------------------------------------------------------------
// 3. Cloud parent -> local child: budgets come from the LOCAL model's window.
// ---------------------------------------------------------------------------

test('cloud parent + local child: token/context limits resolve from the local model', () => {
  setSelection({ type: 'local' });
  modelSelection.setEngineConfigProvider(() => ({
    port: 8123, modelPath: '/models/loaded.gguf', activeModelConfig: { contextLength: 8192 },
  }));
  const parent = cloudParent();
  const before = snapshot(parent);

  const child = modelSelection.resolveChildEngine(parent);
  assert.deepEqual(child, {
    provider: 'local', port: 8123, modelId: '/models/loaded.gguf', contextLength: 8192,
  });
  assert.equal(snapshot(parent), before, 'a local child never touches the cloud parent');

  const b = budgets.resolveTaskBudgets({ kind: 'investigation', engine: child });
  assert.equal(b.contextLength, 8192, 'Automatic uses the local loaded model capacity');
  assert.equal(b.inputBudget, 200 * 8192);
  assert.notEqual(b.contextLength, budgets.FALLBACK_CONTEXT_LENGTH);
});

// ---------------------------------------------------------------------------
// 4. Budget/accounting independence between parent and child.
// ---------------------------------------------------------------------------

test('a child budget state is independent of the parent engine and other children', async () => {
  const localEngine = localParent();
  const cloudEngine = { provider: 'cloud', modelId: 'org/cloud-big', chatTarget: CLOUD_PARENT_TARGET, contextLength: 100000 };
  const localSession = { id: 'local-child', activity: [] };
  const cloudSession = { id: 'cloud-child', activity: [] };

  const localState = await executionBudget.getExecutionBudget(localSession, { kind: 'investigation', engine: localEngine });
  const cloudState = await executionBudget.getExecutionBudget(cloudSession, { kind: 'investigation', engine: cloudEngine });

  assert.equal(localState.budgets.contextLength, 32768);
  assert.equal(cloudState.budgets.contextLength, 100000);
  assert.notEqual(localState.budgets, cloudState.budgets);
  assert.notEqual(localState.ledger, cloudState.ledger);
  // Spending one child's ledger never moves the other's.
  budgets.recordTurn(cloudState.ledger, { usage: { prompt_tokens: 5000, completion_tokens: 100 } });
  assert.equal(budgets.ledgerTotals(cloudState.ledger).inputTokens, 5000);
  assert.equal(budgets.ledgerTotals(localState.ledger).inputTokens, 0);
});

// ---------------------------------------------------------------------------
// 5. Usage normalization across backends (requirement 4).
// ---------------------------------------------------------------------------

test('usage is normalized across local and cloud provider shapes', () => {
  // local llama.cpp / OpenAI-compatible cloud
  assert.deepEqual(budgets.normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 }),
    { input: 100, output: 50, cachedInput: null });
  // alias fields some providers emit
  assert.deepEqual(budgets.normalizeUsage({ input_tokens: 7, output_tokens: 3 }),
    { input: 7, output: 3, cachedInput: null });
  // Anthropic-normalized cloud response folds cache into prompt_tokens; the
  // cached portion is surfaced but never added twice.
  assert.deepEqual(budgets.normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 20, cache_read_input_tokens: 400, cache_creation_input_tokens: 100,
  }), { input: 1000, output: 20, cachedInput: 400 });
  // OpenAI prompt_tokens_details.cached_tokens
  assert.deepEqual(budgets.normalizeUsage({ prompt_tokens: 64, prompt_tokens_details: { cached_tokens: 32 } }),
    { input: 64, output: null, cachedInput: 32 });
  // missing / malformed usage stays null so accounting labels it estimated
  assert.deepEqual(budgets.normalizeUsage(undefined), { input: null, output: null, cachedInput: null });
  assert.deepEqual(budgets.normalizeUsage({ prompt_tokens: 1.5, completion_tokens: -1 }),
    { input: null, output: null, cachedInput: null });
});

test('missing usage is accounted as estimated, never as a measured zero', () => {
  const ledger = budgets.createLedger();
  budgets.recordTurn(ledger, { messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  const totals = budgets.ledgerTotals(ledger);
  assert.equal(totals.turns, 1);
  assert.equal(totals.outputCoverage, 'partial');
  assert.equal(totals.inputCoverage, 'estimated');
  assert.ok(totals.inputTokens > 0, 'an estimate is recorded, not zero');
  assert.equal(totals.outputMeasured, 0);
});

// ---------------------------------------------------------------------------
// 6. Cumulative accounting is independent of the per-request context window.
// ---------------------------------------------------------------------------

test('cumulative tokens can exceed the context window without an overflow report', () => {
  const window = 8192;
  const ledger = budgets.createLedger();
  // Four turns of 4000 input tokens each: 16000 cumulative > the 8192 window.
  for (let turn = 0; turn < 4; turn++) {
    budgets.recordTurn(ledger, { usage: { prompt_tokens: 4000, completion_tokens: 100 } });
  }
  const totals = budgets.ledgerTotals(ledger);
  assert.equal(totals.inputTokens, 16000);
  assert.ok(totals.inputTokens > window, 'cumulative usage legitimately exceeds one window');
  assert.equal(totals.inputCoverage, 'measured');
  // The finite cumulative input envelope is separate from the window.
  assert.equal(budgets.limitReached(200 * window, totals.inputTokens), false);
  assert.equal(budgets.remaining(200 * window, totals.inputTokens), 200 * window - 16000);
  // Unbounded accounting never reports a finite limit or a NaN remainder.
  assert.equal(budgets.limitReached(null, 10 ** 12), false);
  assert.equal(budgets.remaining(null, 10 ** 12), Infinity);
});

// ---------------------------------------------------------------------------
// 7. Backend-specific lanes are preserved regardless of the child model.
// ---------------------------------------------------------------------------

test('child model selection keeps provider-specific scheduling limits', () => {
  const local = providers.resolveProvider({ provider: 'local', modelId: 'm', port: 1 }).capability({ provider: 'local', modelId: 'm', port: 1 });
  assert.equal(local.provider, 'local');
  assert.equal(local.maxConcurrency, 1, 'the local server keeps its single slot');

  const cloud = providers.resolveProvider({ provider: 'cloud', modelId: 'm', chatTarget: CLOUD_PARENT_TARGET })
    .capability({ provider: 'cloud', modelId: 'org/cloud-big', chatTarget: CLOUD_PARENT_TARGET });
  assert.equal(cloud.provider, 'cloud');
  assert.equal(cloud.maxConcurrency, 4, 'a cloud lane keeps its own slot count');
  assert.equal(cloud.model, 'prov-a/org/cloud-big', 'the lane is keyed by provider + child model');
});

// ---------------------------------------------------------------------------
// 8. Regression: a cloud child file-analysis uses the resolved child window.
// ---------------------------------------------------------------------------

test('cloud child file-analysis injects per the provider-resolved window, not the local default', async () => {
  const target = { type: 'cloud', provider: 'meta-cloud', model: 'org/wide' };
  const cloudChild = { provider: 'cloud', modelId: 'org/wide', chatTarget: target };
  const captured = [];

  cloudProviders.getCloudModelMetadata = async () => [
    { providerId: 'meta-cloud', modelId: 'org/wide', contextLength: 200000 },
  ];
  cloudProviders.createCloudFetch = () => async (_url, options) => {
    captured.push(JSON.parse(options.body));
    return Response.json({
      choices: [{ message: { role: 'assistant', content: 'Summary.', finish_reason: 'stop' } }],
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    });
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-model-budgets-files-'));
  const marker = '<END-OF-BIG-FILE>';
  // ~100k characters: larger than the old 64k default-derived cap, smaller
  // than the 128k cap the resolved 200k window derives.
  await fs.writeFile(path.join(root, 'big.txt'), 'a'.repeat(100000) + marker);

  const session = { id: 'cloud-file-child', activity: [] };
  try {
    const result = await executionManager.runFileAnalysisExecution({
      session,
      task_description: 'Summarize the file.',
      target_files: ['big.txt'],
      rootPath: root,
      engine: cloudChild,
    });
    assert.equal(result.outcome, 'completed');

    // The child's effective window is the provider-metadata 200000, so the full
    // 100k file is injected — the trailing marker survives.
    assert.equal(session.budgetState.contextSource, 'provider-metadata');
    assert.equal(session.budgetState.budgets.contextLength, 200000);
    const body = captured[0];
    const userContent = body.messages.find(message => message.role === 'user').content;
    assert.ok(userContent.includes(marker), 'the full file text is injected under the resolved window');
    assert.ok(!userContent.includes('[TRUNCATED due to budget]'), 'nothing was truncated');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a local child reporting a below-floor window still fails loudly', async () => {
  const session = { id: 'tiny-local-child', activity: [] };
  await assert.rejects(
    executionManager.runFileAnalysisExecution({
      session, task_description: 'Summarize.', target_files: ['x.txt'], rootPath: process.cwd(),
      engine: { port: 4321, modelId: 'tiny', contextLength: 1024 },
    }),
    /too small for delegation/,
  );
});
