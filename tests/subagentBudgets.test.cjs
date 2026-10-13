'use strict';
// Sub-agent generation reliability: ceilings, split budgets, adaptive retry.
// Run with: node --test tests/subagentBudgets.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-budgets-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const budgets = require('../src/main/subagents/budgets');
const budgetSettings = require('../src/main/subagents/budgetSettings');

const auto = () => budgetSettings.normalizeBudgetSettings(null);
const engine = (contextLength = 32768) => ({ provider: 'local', port: 9, modelId: 'm', contextLength });

async function main() {
  await test('settings validate, persist, and round-trip', () => {
    assert.deepEqual(budgetSettings.normalizeBudgetSettings(null),
      { mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    assert.throws(() => budgetSettings.normalizeBudgetSettings({ mode: 'turbo' }), /mode/);
    assert.throws(() => budgetSettings.normalizeBudgetSettings({ mode: 'custom', maxOutputTokens: 10 }), /Output budget/);
    assert.throws(() => budgetSettings.normalizeBudgetSettings({ mode: 'custom', maxInputTokens: 1.5 }), /Input budget/);
    const saved = budgetSettings.saveBudgetSettings({ mode: 'custom', maxInputTokens: 200000, maxOutputTokens: 16000, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    assert.deepEqual(saved, { mode: 'custom', maxInputTokens: 200000, maxOutputTokens: 16000, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    assert.deepEqual(budgetSettings.getBudgetSettings(), saved);
    const partial = budgetSettings.saveBudgetSettings({ mode: 'auto' });
    assert.deepEqual(partial, { mode: 'auto', maxInputTokens: 200000, maxOutputTokens: 16000, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    budgetSettings.saveBudgetSettings({ mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    assert.deepEqual(budgetSettings.getBudgetSettings(),
      { mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
  });

  await test('automatic policy scales per kind and context, custom overrides per field', () => {
    const inv = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(102400), settings: auto() });
    assert.deepEqual([inv.inputBudget, inv.outputBudget, inv.perRequestCeiling], [409600, 16384, 2048]);
    const small = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(8192), settings: auto() });
    assert.equal(small.inputBudget, 4 * 8192);
    const file = budgets.resolveTaskBudgets({ kind: 'file-analysis', engine: engine(), settings: auto() });
    assert.deepEqual([file.outputBudget, file.perRequestCeiling], [6144, 3072]);
    const web = budgets.resolveTaskBudgets({ kind: 'web-extraction', engine: engine(), settings: auto() });
    assert.deepEqual([web.outputBudget, web.perRequestCeiling], [2048, 1024]);
    const custom = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(),
      settings: { mode: 'custom', maxInputTokens: 50000, maxOutputTokens: null } });
    assert.equal(custom.inputBudget, 50000);
    assert.equal(custom.outputBudget, 16384);
    assert.deepEqual(custom.sources, { input: 'custom', output: 'auto:8-turns' });
    const unknown = budgets.resolveTaskBudgets({ kind: 'investigation', engine: {}, settings: auto() });
    assert.equal(unknown.inputBudget, 4 * 32768);
  });

  await test('ledger records measured usage and falls back with coverage flags', () => {
    const ledger = budgets.createLedger();
    const messages = [{ role: 'user', content: 'hi' }];
    budgets.recordTurn(ledger, { messages, usage: { prompt_tokens: 1000, completion_tokens: 50 } });
    budgets.recordTurn(ledger, { messages, usage: { prompt_tokens: 1200, completion_tokens: 60 } });
    assert.deepEqual([ledger.inputMeasured, ledger.outputMeasured], [2200, 110]);
    let totals = budgets.ledgerTotals(ledger);
    assert.equal(totals.inputCoverage, 'measured');
    assert.equal(totals.outputCoverage, 'measured');
    budgets.recordTurn(ledger, { messages }); // usage omitted: estimate + unknown
    totals = budgets.ledgerTotals(ledger);
    assert.ok(totals.inputTokens > 2200);
    assert.equal(totals.inputCoverage, 'mixed');
    assert.equal(totals.outputCoverage, 'partial');
    assert.equal(budgets.ledgerTotals(budgets.createLedger()).inputCoverage, 'unavailable');
  });

  await test('affordability gate keeps input and completion allowances independent', () => {
    const ledger = budgets.createLedger();
    const resolved = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(), settings: auto() });
    assert.equal(budgets.canAffordNext(ledger, resolved, 1000).ok, true);
    const tiny = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(),
      settings: { mode: 'custom', maxInputTokens: 600, maxOutputTokens: 100000 } });
    assert.deepEqual(budgets.canAffordNext(ledger, tiny, 601), { ok: false, reason: 'input' });
    const tinyOut = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(),
      settings: { mode: 'custom', maxInputTokens: 100000, maxOutputTokens: 100 } });
    assert.deepEqual(budgets.canAffordNext(ledger, tinyOut, 100), { ok: false, reason: 'output' });
  });

  await test('escalation raises once, clamped to budget and window', () => {    const resolved = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(), settings: auto() });
    const ledger = budgets.createLedger();
    assert.equal(budgets.escalatedCeiling(2048, resolved, ledger, 1000), 4096);
    const spent = budgets.createLedger();
    spent.outputMeasured = 16000; // 384 left of 16384
    assert.equal(budgets.escalatedCeiling(2048, resolved, spent, 1000), null);
    const custom = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(),
      settings: { mode: 'custom', maxInputTokens: 100000, maxOutputTokens: 300 } });
    assert.equal(budgets.escalatedCeiling(2048, custom, budgets.createLedger(), 100), null);
    const bigCtx = budgets.resolveTaskBudgets({ kind: 'investigation', engine: engine(4096), settings: auto() });
    assert.equal(budgets.escalatedCeiling(2048, bigCtx, budgets.createLedger(), 4000), null);
  });

  await test('investigation uses the raised ceiling without reasoning parameters', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const bodies = [];
    const json = (message, usage) => Response.json({ choices: [{ finish_reason: 'stop', message }], usage });
    const fetchImpl = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return json({ content: 'Found it.' }, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    };
    const session = {};
    const { output } = await runInvestigationExecution({ session, task: 'Find it.', rootPath: directory,
      engine: engine(), fetchImpl });
    assert.equal(output, 'Found it.');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].max_tokens, 2048);
    for (const key of ['thinking_budget', 'reasoning_budget', 'max_thinking_tokens', 'reasoning_effort']) {
      assert.ok(!(key in bodies[0]), `${key} must not be sent (unsupported by the verified backend)`);
    }
  });

  await test('length-truncated empty turns escalate once, then succeed', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const bodies = [];
    const emptyLength = () => Response.json({ choices: [{ finish_reason: 'length',
      message: { content: null, reasoning_content: 'thinking...' } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } });
    const fetchImpl = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1 ? emptyLength()
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Recovered.' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    };
    const session = {};
    const { output } = await runInvestigationExecution({ session, task: 'Recover.', rootPath: directory,
      engine: engine(), fetchImpl });
    assert.equal(output, 'Recovered.');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 2048);
    assert.equal(bodies[1].max_tokens, 4096);
  });

  await test('custom budgets block silent escalation and stop exhausted turns', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    budgetSettings.saveBudgetSettings({ mode: 'custom', maxInputTokens: 100000, maxOutputTokens: 300 });
    try {
      const bodies = [];
      const emptyLength = () => Response.json({ choices: [{ finish_reason: 'length', message: { content: null } }],
        usage: { prompt_tokens: 100, completion_tokens: 250, total_tokens: 350 } });
      const fetchImpl = async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return emptyLength();
      };
      const session = {};
      const result = await runInvestigationExecution({ session, task: 'Stuck.', rootPath: directory, engine: engine(), fetchImpl });
      assert.equal(result.stopReason, 'output_budget'); assert.equal(result.outcome, 'failed');
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].max_tokens, 300);
    } finally {
      budgetSettings.saveBudgetSettings({ mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    }
  });

  await test('tiny custom input budget stops before any request, preserving state', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    budgetSettings.saveBudgetSettings({ mode: 'custom', maxInputTokens: 512, maxOutputTokens: 100000 });
    try {
      let calls = 0;
      const session = {};
      const { output } = await runInvestigationExecution({ session, task: 'Expensive?', rootPath: directory,
        engine: engine(), fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
      assert.equal(calls, 0);
      assert.match(output, /input_budget/);
    } finally {
      budgetSettings.saveBudgetSettings({ mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    }
  });

  await test('valid tool calls on truncated turns are preserved, never retried', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const root = path.join(directory, 'toolonce');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    const bodies = [];
    const toolTurn = () => Response.json({ choices: [{ finish_reason: 'length',
      message: { content: null, tool_calls: [{ id: 'only', type: 'function',
        function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return bodies.length <= 1
        ? toolTurn()
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Listed.' } }],
          usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } });
    };
    const session = {};
    const { output } = await runInvestigationExecution({ session, task: 'List.', rootPath: root,
      engine: engine(), fetchImpl });
    assert.equal(output, 'Listed.');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].max_tokens, 2048);
  });

  await test('missing usage still completes with documented coverage', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Fine.' } }] });
    const session = {};
    const { output, usage } = await runInvestigationExecution({ session, task: 'Hi.', rootPath: directory,
      engine: engine(), fetchImpl });
    assert.equal(output, 'Fine.');
    assert.equal(usage, null);
  });

  await test('turn limits stay independent from token budgets', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const bodies = [];
    const fetchImpl = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: `c${bodies.length}`, type: 'function',
          function: { name: 'list_directory', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    const session = {};
    const result = await runInvestigationExecution({ session, task: 'Loop.', rootPath: directory, engine: engine(), fetchImpl, maxTurns: 1 });
    assert.equal(result.stopReason, 'turn_limit'); assert.equal(result.outcome, 'failed');
    assert.equal(bodies.length, 1); assert.deepEqual(bodies[0].tools, []);
  });

  await test('one-shot ceilings, escalation, and custom enforcement', async () => {
    const { runFileAnalysisExecution, runWebExtractionExecution } = require('../src/main/subagents/executionManager');
    const root = path.join(directory, 'oneshot-budget');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'g.txt'), 'content here');
    const engine8k = engine();
    let bodies = [];
    const fileFetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return Response.json({ choices: [{ finish_reason: 'length', message: { content: null } }],
          usage: { prompt_tokens: 200 } });
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'File says hi.' } }],
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } });
    };
    const first = await runFileAnalysisExecution({ session: {}, task_description: 'Read it.', target_files: ['g.txt'],
      rootPath: root, engine: engine8k, fetchImpl: fileFetch });
    assert.equal(first.output, 'File says hi.');
    assert.equal(bodies[0].max_tokens, 3072);
    assert.equal(bodies[1].max_tokens, 3072); // Missing usage retains first allowance reservation.
    assert.ok(!('thinking_budget' in bodies[0]));
    // Custom output too small for any escalation: identical retry, explicit fail, never exceeded.
    budgetSettings.saveBudgetSettings({ mode: 'custom', maxInputTokens: 100000, maxOutputTokens: 500 });
    try {
      bodies = [];
      const failFetch = async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return Response.json({ choices: [{ finish_reason: 'length', message: { content: null } }],
          usage: { prompt_tokens: 200 } });
      };
      const stopped = await runFileAnalysisExecution({ session: {}, task_description: 'Read it.', target_files: ['g.txt'], rootPath: root, engine: engine8k, fetchImpl: failFetch });
      assert.equal(stopped.stopReason, 'output_budget'); assert.equal(stopped.outcome, 'partial');
      assert.equal(bodies[0].max_tokens, 500);
      assert.equal(bodies.length, 1);
    } finally {
      budgetSettings.saveBudgetSettings({ mode: 'auto', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null });
    }
    // Web ceiling and no-thinking-keys.
    const webBodies = [];
    const webFetch = async (_url, options) => {
      webBodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Answer.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
    };
    const web = await runWebExtractionExecution({ session: {}, url: 'https://example.com/p', query: 'Q?',
      engine: engine8k, pageFetchImpl: async () => new Response('<p>Answer.</p>', { headers: { 'content-type': 'text/html' } }),
      fetchImpl: webFetch });
    assert.equal(web.output, 'Answer.');
    assert.equal(webBodies[0].max_tokens, 1024);
  });

  await test('engine context resolves per backend, never hardcoded', async () => {
    const { resolveEngineContextLength } = budgets;
    // Local descriptor carries its own window: no lookup.
    assert.deepEqual(await resolveEngineContextLength({ provider: 'local', port: 9, modelId: 'm', contextLength: 102400 }),
      { contextLength: 102400, source: 'engine' });
    // Cloud resolves from provider metadata (injected here; cached live).
    const cloud = { provider: 'cloud', modelId: 'claude-sonnet-5', chatTarget: { type: 'cloud', provider: 'anthropic', model: 'claude-sonnet-5' } };
    const meta = async () => [{ providerId: 'anthropic', modelId: 'claude-sonnet-5', contextLength: 1000000 }];
    assert.deepEqual(await resolveEngineContextLength(cloud, { getCloudModelMetadata: meta }),
      { contextLength: 1000000, source: 'provider-metadata' });
    // Unknown model, failed lookup, or no engine: documented fallback.
    assert.deepEqual(await resolveEngineContextLength(cloud, { getCloudModelMetadata: async () => [] }),
      { contextLength: 32768, source: 'fallback' });
    assert.deepEqual(await resolveEngineContextLength(cloud, { getCloudModelMetadata: async () => { throw new Error('offline'); } }),
      { contextLength: 32768, source: 'fallback' });
    assert.deepEqual(await resolveEngineContextLength(null), { contextLength: 32768, source: 'fallback' });
    // A 1M cloud window scales the automatic budgets instead of tripping early.
    const resolved = budgets.resolveTaskBudgets({ kind: 'investigation', engine: cloud, settings: auto(), contextLength: 1000000 });
    assert.equal(resolved.inputBudget, 4000000);
    assert.equal(resolved.contextLength, 1000000);
    // Custom user numbers always win over any resolution.
    const custom = budgets.resolveTaskBudgets({ kind: 'investigation', engine: cloud,
      settings: { mode: 'custom', maxInputTokens: 50000, maxOutputTokens: null }, contextLength: 1000000 });
    assert.equal(custom.inputBudget, 50000);
  });

  console.log('Sub-agent budgets: settings, policy, ledger, and escalation passed.');
}

main().then(() => {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = 1;
});
