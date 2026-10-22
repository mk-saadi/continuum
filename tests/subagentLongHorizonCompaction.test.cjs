'use strict';
// Phase 1.4 Step 8 — long-horizon deterministic benchmark.
//
// A single child runs a long-horizon read-only task through the *real* loop,
// real budget ledger, real mid-run compaction pipeline and real authorized
// renewal. Nothing here spends provider tokens: a scripted transport reports
// synthetic usage, and tool execution is stubbed. The benchmark is a workload,
// not a claim about live-model summary fidelity.
//
// Requirements exercised together (Phase 1.4 Step 8):
//   * >= 200 tool calls and >= 200 model requests in a 32K window;
//   * > 2,000,000 simulated cumulative tokens;
//   * >= 3 mid-run context compactions;
//   * a budget-exhausted suspension at a finite tool-call limit;
//   * an authorized renewal of that limit;
//   * continued execution of the same child after the renewal;
//   * an accurate terminal result.
// Run with: node --test tests/subagentLongHorizonCompaction.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-long-horizon-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const database = require('../src/main/db');
database.initDatabase(directory);
const settings = require('../src/main/subagents/budgetSettings');
const budget = require('../src/main/subagents/executionBudget');
const continuationState = require('../src/main/subagents/continuationState');
const { validatePairs } = require('../src/main/subagents/contextRecovery');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');

const engine = { provider: 'local', port: 9, modelId: 'bench-child', contextLength: 32768 };
const { ELIGIBILITY } = continuationState;
// Every request reports a large synthetic prompt, so cumulative input crosses
// 2M well before the workload ends without touching a real backend.
const SYNTHETIC_USAGE = { prompt_tokens: 22000, completion_tokens: 400 };
const response = (content, calls = [], finish_reason = 'stop') => Response.json({
  choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }],
  usage: SYNTHETIC_USAGE });
const toolCall = id => ({ id, type: 'function',
  function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path: `src/${id}.js` }) } });

test('long-horizon benchmark: 220 tool calls in 32K, 3+ compactions, suspension, renewal and accurate completion',
  { timeout: 180000 }, async () => {
    settings.saveBudgetSettings({ mode: 'custom', maxTurns: 4000, maxToolCalls: 150,
      maxAggregateToolCalls: 300, maxInputTokens: 8000000, maxOutputTokens: 8000000 });

    const tools = require('../src/main/tools/agentTools');
    const execute = tools.executeAgentTool;
    let executed = 0;
    const executedIds = [];
    tools.executeAgentTool = async ({ arguments: args }) => {
      executed++;
      const relative = JSON.parse(args).relative_path;
      executedIds.push(relative);
      return JSON.stringify({ file_path: relative, total_lines: 800,
        content: `EARLY_VALUE=17\n${'evidence line\n'.repeat(2000)}\nError: preserve this diagnostic\nEND` });
    };

    let session;
    let phaseTarget = 150; // run 1 stops at the finite tool-call limit
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      // C1 cannot treat a configured total as verified per-request capacity.
      if (new URL(url).pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: engine.contextLength } });
      if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
      const p = JSON.parse(options.body); requests.push(p);
      const system = p.messages[0].content;
      if (system.startsWith('Summarize')) {
        // A real summarizer returns a concise, replacing summary. (An
        // ever-appending summary would legitimately exhaust the window; the
        // loop reports that truthfully as context_exhausted, never as success.)
        return response('EARLY_VALUE=17 confirmed across the inspected paths; comparison of the remaining paths is still pending. Read-only was respected throughout.');
      }
      if (system.startsWith('You are compressing a Workspace')) {
        const input = JSON.parse(p.messages[1].content);
        const evidence = input.evidence.find(e => e.outcome === 'success');
        return response(JSON.stringify({ objective: 'Read every listed path and confirm EARLY_VALUE=17; read-only.',
          outstandingRequirements: [], filesChanged: [], commands: [], tests: [], blockers: [], risks: [],
          decisions: evidence ? [{ text: `EARLY_VALUE=17 from ${evidence.paths[0]}`, verified: false,
            sources: [{ messageId: evidence.messageId, stepId: evidence.stepId }] }] : [],
          completedWork: evidence ? [{ text: `Read ${evidence.paths[0]}`,
            sources: [{ messageId: evidence.messageId, stepId: evidence.stepId }] }] : [],
          nextActions: ['Continue the remaining reads'], unknowns: ['No edits performed'] }));
      }
      // Finalization (tool_choice:none) reports the partial honestly.
      if (p.tool_choice === 'none') return response('Partial: EARLY_VALUE=17 found; some paths remain unread.');
      if (session.budgetState.toolCalls < phaseTarget) {
        const n = session.budgetState.toolCalls + 1;
        return response(null, [toolCall(`b${n}`)], 'tool_calls');
      }
      return response('FINAL: EARLY_VALUE=17 verified across every inspected path; read-only was respected.');
    };

    try {
      session = { id: `bench-${randomUUID()}`, inputSummary: { task: 'Read every listed path and confirm EARLY_VALUE=17. Constraint: read-only.' } };
      const task = session.inputSummary.task;
      const originalRunId = session.id;
      // ---- Phase 1: exhaustive work up to the finite tool-call limit -------
      const first = await runInvestigationExecution({ session, task, engine, rootPath: directory, fetchImpl });
      assert.equal(first.outcome, 'partial', 'a finite tool-call budget suspends with partial work');
      assert.equal(first.stopReason, 'tool_limit');
      assert.equal(session.budgetState.toolCalls, 150, 'exactly the configured limit ran');
      assert.equal(session.budgetState.scope.toolCalls, 150, 'aggregate accounting matches');
      assert.ok(session.compactionState.version >= 3, 'context is compacted several times mid-run');
      const tokensDuringFirst = budget.totals(session.budgetState).inputTokens;
      assert.ok(tokensDuringFirst > 1500000, 'a large fraction of the token envelope is simulated');

      // The suspension is the legitimate, renewable Phase 1.3C case.
      const decision = continuationState.evaluateContinuation({ status: first.outcome, stopReason: first.stopReason, context: session.context });
      assert.equal(decision.eligibility, ELIGIBILITY.NEEDS_RENEWAL);

      // ---- Authorized renewal (monotonic; consumption untouched) ----------
      const renewed = budget.renewBudget(session.budgetState, { maxToolCalls: 250 }, { reason: 'long-horizon benchmark', source: 'user' });
      assert.equal(renewed.applied.maxToolCalls, 250);
      assert.equal(session.budgetState.toolCalls, 150, 'renewal never resets consumption');
      assert.equal(budget.totals(session.budgetState).inputTokens, tokensDuringFirst, 'renewal never resets usage');
      assert.equal(session.budgetState.renewals.length, 1);
      assert.equal(session.budgetState.renewals[0].granted, 100);

      // ---- Phase 2: continue the same child to an accurate completion ------
      phaseTarget = 220;
      const second = await runInvestigationExecution({ session, task, engine, rootPath: directory, fetchImpl });
      assert.equal(second.outcome, 'completed', 'the renewed child reaches a truthful completion');
      assert.equal(second.stopReason, 'completed');
      assert.equal(session.budgetState.toolCalls, 220, 'additional work ran only after the renewal');
      assert.equal(session.budgetState.scope.toolCalls, 220);
      assert.equal(executed, 220, 'each tool call executed exactly once across both phases');
      assert.equal(new Set(executedIds).size, 220, 'no tool call was repeated');

      // ---- Benchmark budgets: all thresholds met --------------------------
      assert.ok(executed >= 200, `>=200 tool calls (${executed})`);
      assert.ok(requests.length >= 150, `>=150 model requests (${requests.length})`);
      assert.ok(session.compactionState.version >= 3, `>=3 compactions (${session.compactionState.version})`);
      const totals = budget.totals(session.budgetState);
      assert.ok(totals.inputTokens > 2000000, `>2M simulated cumulative tokens (${totals.inputTokens})`);
      console.error(`[phase1.4 benchmark] toolCalls=${executed} requests=${requests.length} ` +
        `simulatedInputTokens=${totals.inputTokens} compactions=${session.compactionState.version} outcome=${second.outcome}`);

      // ---- Information preservation and accounting ------------------------
      const active = JSON.stringify(session.context);
      assert.equal(session.id, originalRunId);
      assert.match(active, /EARLY_VALUE=17/, 'the original finding survives every compaction and the renewal');
      assert.match(active, /read-only|never edit/, 'the read-only constraint is still present');
      assert.equal(session.rawContext.filter(m => m.role === 'tool').length, 220, 'raw evidence is fully retained');
      validatePairs(session.context);

      const allowance = continuationState.summarizeAllowance(session.budgetState);
      assert.equal(allowance.original.maxToolCalls, 150, 'original allowance is preserved');
      assert.equal(allowance.current.maxToolCalls, 250, 'current allowance reflects the renewal');
      assert.equal(allowance.consumed.toolCalls, 220, 'consumption is cumulative across the renewal');
      assert.equal(allowance.consumed.aggregateToolCalls, 220);
      assert.equal(allowance.aggregate.limit, 300);
      assert.equal(allowance.remaining.maxToolCalls, 30);
      assert.equal(allowance.renewals.length, 1);

      const { approximateTokens, reserveTokens } = require('../src/main/contextBudget');
      for (const request of requests) {
        assert.ok(approximateTokens(request) + reserveTokens(request, 32768) <= 32768,
          'every dispatched request including summary/checkpoint fits its estimated budget');
      }
      assert.ok(session.compactionState.summary.length < 512, 'replacement summary stays bounded');
      console.error('[context measurements] ' + JSON.stringify(session.compactionState.events.map(event => ({
        version: event.version, before: event.before.tokens, after: event.after.tokens,
        reserve: event.after.reserve, limit: event.after.limit,
      }))));
      // Every compaction event is observable and internally consistent.
      for (const event of session.compactionState.events) {
        assert.ok(['pressure', 'overflow'].includes(event.reason));
        assert.ok(event.after.tokens < event.before.tokens, 'each compaction reduced the active context');
        assert.ok(event.after.tokens + event.after.reserve <= event.after.limit);
        assert.equal(event.after.limit, 32768);
      }
    } finally { tools.executeAgentTool = execute; }
  });

test('long-horizon reliability: a failing tool is recovered, dispatches stay unique, and no work runs after the terminal answer',
  { timeout: 120000 }, async () => {
    settings.saveBudgetSettings({ mode: 'custom', maxTurns: 400, maxToolCalls: 80,
      maxAggregateToolCalls: 200, maxInputTokens: 4000000, maxOutputTokens: 4000000 });

    const call = (id, name = 'read_project_file', args = { relative_path: `src/${id}.js` }) =>
      ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const tools = require('../src/main/tools/agentTools');
    const execute = tools.executeAgentTool;
    const executed = [];
    tools.executeAgentTool = async ({ name, arguments: args }) => {
      const parsed = JSON.parse(args);
      const target = parsed.relative_path ?? 'x';
      executed.push(`${name}:${target}`);
      if (target === 'missing.txt') return { success: false, error: `FILE_NOT_FOUND: ${target}` };
      return JSON.stringify({ file_path: target, content: `evidence for ${target}` });
    };

    const TOOL_TURNS = 24;
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      // C1 cannot treat a configured total as verified per-request capacity.
      if (new URL(url).pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: engine.contextLength } });
      if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
      const p = JSON.parse(options.body); requests.push(p);
      const n = requests.length;
      if (n <= TOOL_TURNS) {
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call(`r${n}`)] } }], usage: SYNTHETIC_USAGE });
      }
      // One legitimate read-only failure the loop must survive and report,
      // followed by a truthful final answer built on the other evidence.
      if (n === TOOL_TURNS + 1) {
        return Response.json({ choices: [{ finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [call('rfail', 'read_project_file', { relative_path: 'missing.txt' })] } }], usage: SYNTHETIC_USAGE });
      }
      return Response.json({ choices: [{ finish_reason: 'stop',
        message: { content: 'FINAL: every requested path was read; one was missing and reported as an error.' } }], usage: SYNTHETIC_USAGE });
    };

    try {
      const session = { id: `bench-reliability-${randomUUID()}`, inputSummary: { task: 'Read every listed path; report one missing file honestly.' } };
      const result = await runInvestigationExecution({ session, task: session.inputSummary.task, engine, rootPath: directory, fetchImpl });

      // A truthful completion, never a false one.
      assert.equal(result.outcome, 'completed');
      assert.equal(result.stopReason, 'completed');
      assert.equal(result.completionClass, 'complete');
      assert.match(result.output, /FINAL:/);

      // The failure was executed once, reported as an error, and did not abort the loop.
      assert.equal(executed.length, TOOL_TURNS + 1, 'every requested call dispatched exactly once');
      assert.equal(new Set(executed).size, executed.length, 'no side-effecting call was replayed');
      const failedTool = session.context.find(m => m.role === 'tool' && /missing\.txt/.test(m.content ?? '') === false
        && m.content?.startsWith('Error:'));
      const errorTool = session.context.filter(m => m.role === 'tool' && m.content?.startsWith('Error:'));
      assert.equal(errorTool.length, 1, 'the single failure is recorded as an error result');
      assert.match(errorTool[0].content, /FILE_NOT_FOUND/);
      assert.equal(failedTool, undefined, 'only the missing-file read failed');

      // No work runs after the terminal answer: the request count is frozen.
      const terminalRequests = requests.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.length, terminalRequests, 'no post-terminal generation may start');
    } finally {
      tools.executeAgentTool = execute;
    }
  });

test.after(() => { database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });
console.log('Phase 1.4 long-horizon benchmark: threshold, multi-compaction, suspension/renewal and terminal accuracy passed.');