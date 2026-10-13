'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-phase1-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(directory);
const settings = require('../src/main/subagents/budgetSettings');
const budgets = require('../src/main/subagents/budgets');
const runtime = require('../src/main/subagents');
const sessions = require('../src/main/subagents/sessionManager');
const scheduler = require('../src/main/subagents/inferenceScheduler');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
const engine = { provider: 'local', port: 9, modelId: 'fixture', contextLength: 32768 };
const call = (id, name = 'list_directory', args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls = [], finish_reason = 'stop', usage = { prompt_tokens: 50, completion_tokens: 10 }) => Response.json({ choices: [{ finish_reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage });
function script(responses) {
  const requests = [];
  return { requests, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length, 'unexpected extra generation');
    return responses.shift();
  } };
}
function configure(patch = {}) { settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null, maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null, ...patch }); }
async function run(session, s, options = {}) { return runInvestigationExecution({ session, task: 'Inspect the project.', rootPath: directory, engine, ...s, ...options }); }
test.after(() => { db.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });
test.beforeEach(() => configure());

test('legacy settings normalize safely and Custom fields resolve independently', () => {
  const legacy = settings.normalizeBudgetSettings({ mode: 'auto', maxInputTokens: 200000, maxOutputTokens: 16000 });
  assert.equal(legacy.maxToolCalls, null);
  const auto = budgets.resolveTaskBudgets({ kind: 'investigation', engine, settings: legacy });
  assert.equal(auto.maxToolCalls, 10); assert.equal(auto.maxTurns, 8); assert.equal(auto.maxAggregateToolCalls, 40);
  const custom = budgets.resolveTaskBudgets({ kind: 'investigation', engine, settings: { mode: 'custom', maxToolCalls: 50, maxTurns: 30 } });
  assert.equal(custom.maxToolCalls, 50); assert.equal(custom.maxTurns, 30); assert.equal(custom.outputBudget, 30 * 2048);
  assert.equal(custom.inputBudget, 4 * 32768);
  assert.throws(() => settings.normalizeBudgetSettings({ maxTurns: 0 }), /Turn/);
  configure({ maxToolCalls: 50 }); settings.saveBudgetSettings({ mode: 'auto' });
  assert.equal(settings.getBudgetSettings().maxToolCalls, 50);
});

test('batch crossing child ceiling pairs skipped calls and finalizes once without tools', async () => {
  configure({ maxToolCalls: 1 });
  const session = {}; const s = script([reply(null, [call('a'), call('b'), call('c')], 'tool_calls'), reply('Found the directory; more work remains.')]);
  const result = await run(session, s);
  assert.equal(result.stopReason, 'tool_limit'); assert.equal(result.outcome, 'partial');
  assert.equal(session.budgetState.toolCalls, 1);
  const tools = session.context.filter(m => m.role === 'tool');
  assert.equal(tools.length, 3); assert.match(tools[1].content, /skipped.*tool_limit/i);
  assert.match(tools[2].content, /skipped.*tool_limit/i);
  assert.equal(result.accounting.blockedCalls, 2, 'each skipped requested call is a blocked attempt');
  assert.equal(s.requests.length, 2); assert.deepEqual(s.requests[1].tools, []); assert.equal(s.requests[1].tool_choice, 'none');
  assert.match(result.output, /tool_limit/);
});

test('turn ceiling includes finalization and empty/reasoning continuation', async () => {
  configure({ maxTurns: 2 });
  const session = {}; const s = script([Response.json({ choices: [{ finish_reason: 'length', message: { reasoning_content: 'thinking', content: null } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), reply(null)]);
  const result = await run(session, s);
  assert.equal(result.outcome, 'failed'); assert.equal(result.stopReason, 'turn_limit'); assert.equal(s.requests.length, 2);
  assert.equal(session.budgetState.ledger.turns, 2); assert.deepEqual(s.requests[1].tools, []);
});

test('aggregate scope applies across children, fresh scopes do not replenish old children', async () => {
  configure({ maxAggregateToolCalls: 1 });
  const scope = runtime.createParentRunBudget();
  const a = {}; const sa = script([reply(null, [call('a')]), reply('Found A.')]);
  await run(a, sa, { budgetScope: scope });
  const b = {}; const sb = script([reply(null, [call('b')]), reply('No tool findings.')]);
  const result = await run(b, sb, { budgetScope: scope });
  assert.equal(scope.toolCalls, 1); assert.equal(b.budgetState.toolCalls, 0); assert.equal(result.stopReason, 'aggregate_tool_limit');
  assert.equal(sb.requests.length, 0); // Scope exhausted before starting model work.
  assert.equal(result.outcome, 'failed');
});

test('lifetime token/turn/tool ledgers survive continuation and setting changes', async () => {
  configure({ maxToolCalls: 2 });
  const session = {}; const a = script([reply(null, [call('a')]), reply('First.')]);
  await run(session, a);
  const state = session.budgetState; const before = state.ledger.turns;
  configure({ maxToolCalls: 100, maxOutputTokens: 500000 });
  const b = script([reply(null, [call('b')]), reply('Second.')]);
  const result = await run(session, b);
  assert.equal(session.budgetState, state); assert.equal(state.toolCalls, 2); assert.equal(state.budgets.maxToolCalls, 2);
  assert.equal(state.ledger.turns, before + 2); assert.equal(result.stopReason, 'tool_limit');
});

test('remaining output clamps every request; missing usage reserves the whole allowance', async () => {
  configure({ maxOutputTokens: 300 });
  const session = {}; const s = script([reply(null, [call('a')], 'length', undefined)]);
  // JSON without a usage block must not create a free generation.
  s.fetchImpl = async (_url, options) => { s.requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [call('a')] } }] }); };
  const result = await run(session, s);
  assert.equal(s.requests.length, 1); assert.equal(s.requests[0].max_tokens, 300);
  assert.equal(result.stopReason, 'output_budget'); assert.equal(result.outcome, 'partial');
  assert.equal(session.budgetState.ledger.outputReserved, 300);
  assert.equal(result.accounting.outputCoverage, 'reserved');
});

test('no remaining input prevents requests and does not manufacture findings', async () => {
  configure({ maxInputTokens: 512 });
  const s = script([]); const result = await run({}, s);
  assert.equal(s.requests.length, 0); assert.equal(result.stopReason, 'input_budget'); assert.equal(result.outcome, 'failed');
  assert.match(result.output, /No usable findings/);
});

test('length with tools executes once; provider ignores tool-free finalization without dispatch', async () => {
  configure({ maxToolCalls: 1 });
  const session = {}; const s = script([reply(null, [call('a')], 'length'), reply(null, [call('a')])]);
  const result = await run(session, s);
  assert.equal(session.budgetState.toolCalls, 1); assert.equal(s.requests.length, 2);
  assert.equal(session.context.filter(m => m.role === 'tool').length, 2);
  assert.equal(result.stopReason, 'tool_limit'); assert.equal(result.outcome, 'partial');
});

test('runtime and parent preserve partial outcome and bounded stop header', async () => {
  configure({ maxToolCalls: 1 });
  const { executeSpawnSubagent } = require('../src/main/tools/subagent');
  const original = scheduler.scheduleInference;
  const responses = [reply(null, [call('a')]), reply('Useful finding. '.repeat(400))];
  scheduler.scheduleInference = options => original({ ...options, fetchImpl: async () => responses.shift() });
  let childId;
  try {
    const output = await executeSpawnSubagent({ task: 'Inspect.', investigate: true, rootPath: directory, engine, onSpawn: id => { childId = id; } });
    assert.match(output, /^\[Sub-agent partial: tool_limit\]/); assert.ok(output.length <= 1800);
    const child = sessions.getSession(childId);
    assert.equal(child.status, 'partial'); assert.equal(child.stopReason, 'tool_limit');
    assert.equal(runtime.getChildTranscript(childId).stopReason, 'tool_limit');
    const transcript = runtime.getChildTranscript(childId);
    const { subagentUsageLines, subagentResultTitle } = await import('../src/lib/subagentDisplay.mjs');
    assert.equal(subagentResultTitle(transcript.status), 'Partial findings');
    assert.match(transcript.result.text, /Useful finding/);
    assert.match(subagentUsageLines(transcript).join('\n'), /Child model requests: 2 \/ 8/);
    assert.match(subagentUsageLines(transcript).join('\n'), /Child tool calls: 1 \/ 1/);
    assert.equal(transcript.accounting.finalizationAttempted, true);
  } finally { scheduler.scheduleInference = original; }
});

test('9/10/11 requested tool boundaries never overshoot or replay dispatches', async () => {
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool;
  tools.executeAgentTool = async () => 'Read evidence.';
  try { for (const count of [9, 10, 11]) {
    configure({ maxToolCalls: 10 });
    const session = {};
    const s = script([reply(null, Array.from({ length: count }, (_, i) => call(`c${i}`, 'list_directory', { relative_path: String(i) }))), reply('Bounded report.')]);
    const result = await run(session, s);
    assert.equal(session.budgetState.toolCalls, Math.min(count, 10));
    const outputs = session.context.filter(m => m.role === 'tool');
    assert.equal(outputs.length, count);
    assert.equal(result.stopReason, count >= 10 ? 'tool_limit' : 'completed');
    assert.equal(s.requests.length, 2);
  } } finally { tools.executeAgentTool = execute; }
});

test('repetition detection intercepts canonical duplicate attempts without cached output', async () => {
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool;
  let effects = 0;
  tools.executeAgentTool = async () => { effects++; return `current state ${effects}`; };
  try {
    const session = {};
    const s = script([reply(null, [call('a', 'list_directory', { x: 1, y: 2 })]),
      reply(null, [call('b', 'list_directory', { y: 2, x: 1 })]),
      reply(null, [call('c', 'list_directory', { x: 1, y: 2 })]), reply('Observed changing values.')]);
    const result = await run(session, s);
    assert.equal(effects, 2); assert.equal(session.budgetState.toolCalls, 2);
    assert.equal(result.stopReason, 'no_progress');
    assert.match(session.context.find(m => m.role === 'tool' && m.tool_call_id === 'a').content, /state 1/);
    assert.match(session.context.find(m => m.role === 'tool' && m.tool_call_id === 'b').content, /state 2/);
  } finally { tools.executeAgentTool = execute; }
});

test('cancellation during a batch preserves completed and skipped pairs without replay', async () => {
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool;
  const controller = new AbortController(); let effects = 0;
  tools.executeAgentTool = async () => { effects++; controller.abort(new DOMException('Cancelled', 'AbortError')); return 'done'; };
  const session = {}; const s = script([reply(null, [call('a'), call('b')])]);
  try { await assert.rejects(run(session, s, { signal: controller.signal }), { name: 'AbortError' }); }
  finally { tools.executeAgentTool = execute; }
  assert.equal(effects, 1); assert.equal(session.context.filter(m => m.role === 'tool').length, 2);
  assert.match(session.context.at(-1).content, /cancelled/);
  assert.equal(session.budgetState.toolCalls, 1);
});

test('provider overrun is explicit and no tool requested by violating response runs', async () => {
  configure({ maxOutputTokens: 300 }); const session = {};
  const s = script([reply(null, [call('a')], 'tool_calls', { prompt_tokens: 10, completion_tokens: 301 })]);
  const result = await run(session, s);
  assert.equal(result.stopReason, 'provider_budget_violation'); assert.equal(result.outcome, 'failed');
  assert.equal(session.budgetState.toolCalls, 0); assert.equal(s.requests.length, 1);
});

test('tool-free finalization fails once and keeps actual source evidence', async () => {
  configure({ maxToolCalls: 1 });
  const session = {}; const s = script([reply(null, [call('a')]), new Response('failure', { status: 500 })]);
  const result = await run(session, s);
  assert.equal(result.outcome, 'partial'); assert.equal(result.stopReason, 'tool_limit');
  assert.match(result.output, /Tool evidence/); assert.equal(s.requests.length, 2);
  assert.equal(session.budgetState.ledger.turns, 2);
});

test('token gates cannot replenish child usage through runtime messages', async () => {
  configure({ maxTurns: 3 });
  const a = script([reply('First.')]); let id;
  await runtime.runInvestigation({ parentSessionId: 'messages', task: 'One', rootPath: directory, engine, ...a, onSpawn: value => { id = value; } });
  const child = sessions.getSession(id); const state = child.budgetState;
  // Change the script's closure for the next request, not the fixed child engine.
  const original = scheduler.scheduleInference;
  scheduler.scheduleInference = options => original({ ...options, fetchImpl: script([reply('Second.')]).fetchImpl });
  const done = require('node:events').once(runtime.backgroundEvents, 'completed');
  try {
    runtime.sendMessage(id, 'Two', { parentSessionId: 'messages' });
    await done;
    assert.equal(child.budgetState, state); assert.equal(state.ledger.turns, 2);
    assert.equal(child.usage.completion_tokens, 20);
  } finally { scheduler.scheduleInference = original; }
});

test('nested runtime child inherits its owning child scope without enabling nested tools', async () => {
  configure({ maxAggregateToolCalls: 1 });
  const a = script([reply('Parent child ready.')]); let id;
  await runtime.runInvestigation({ parentSessionId: 'nest', task: 'One', rootPath: directory, engine, ...a, onSpawn: value => { id = value; } });
  const parent = sessions.getSession(id);
  const b = script([reply(null, [call('b')]), reply('Nested report.')]); let nested;
  await runtime.runInvestigation({ parentSessionId: id, task: 'Two', rootPath: directory, engine, ...b, onSpawn: value => { nested = value; } });
  assert.equal(sessions.getSession(nested).budgetState.scope, parent.budgetState.scope);
  assert.equal(parent.budgetState.scope.toolCalls, 1);
});

test('file/web reads share aggregate budget and retries sum provider usage', async () => {
  const { runFileAnalysisExecution, runWebExtractionExecution } = require('../src/main/subagents/executionManager');
  configure({ maxAggregateToolCalls: 1 }); fs.writeFileSync(path.join(directory, 'phase1.txt'), 'source evidence');
  const scope = runtime.createParentRunBudget(); const session = {};
  const s = script([reply(null), reply('Read file.')]);
  const result = await runFileAnalysisExecution({ session, task_description: 'Read', target_files: ['phase1.txt'], rootPath: directory, engine, budgetScope: scope, ...s });
  assert.equal(result.outcome, 'completed'); assert.equal(result.usage.prompt_tokens, 100); assert.equal(result.usage.completion_tokens, 20);
  const blocked = await runWebExtractionExecution({ session: {}, url: 'https://example.com', query: 'Q', engine, budgetScope: scope,
    pageFetchImpl: async () => { assert.fail('aggregate-exhausted fetch must not run'); } });
  assert.equal(blocked.stopReason, 'aggregate_tool_limit'); assert.equal(scope.toolCalls, 1);
});

test('background partial result includes reason/accounting and persisted history retains them', async () => {
  configure({ maxToolCalls: 1 });
  const s = script([reply(null, [call('a')]), reply('Partial finding.')]);
  const done = require('node:events').once(runtime.backgroundEvents, 'partial');
  const handle = runtime.startInvestigation({ parentSessionId: 'background-partial', task: 'One', rootPath: directory, engine, ...s });
  const [event] = await done;
  assert.equal(event.childSessionId, handle.childSessionId); assert.equal(event.stopReason, 'tool_limit');
  assert.equal(event.accounting.toolCalls, 1);
  const row = db.db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(handle.childSessionId);
  assert.equal(row.status, 'partial'); assert.equal(row.stop_reason, 'tool_limit');
  assert.equal(JSON.parse(row.accounting_json).toolCalls, 1);
});

// Exercise the real guarded transport with deterministic counting/recovery
// fixtures: failed dispatch, summary and retry each count, never the probes.
test('existing overflow recovery requests use the same bounded request/token ledger', async () => {
  const { createContextGuardedFetch } = require('../src/main/contextBudget');
  const budget = require('../src/main/subagents/executionBudget');
  configure({ maxTurns: 3, maxOutputTokens: 6000 }); const session = {};
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine });
  let completions = 0;
  const raw = async (url, options) => {
    if (new URL(url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
    completions++;
    if (completions === 1) return Response.json({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 99999, n_ctx: 32768 } }, { status: 400 });
    return reply('Recovered.', [], 'stop', { prompt_tokens: 40, completion_tokens: 20 });
  };
  const guarded = createContextGuardedFetch(raw);
  const tracked = budget.budgetedFetch(guarded, state);
  const url = 'http://127.0.0.1:9/v1/chat/completions';
  const payload = { messages: [{ role: 'user', content: 'Original task' }], max_tokens: 1024 };
  const response = await tracked(url, { method: 'POST', body: JSON.stringify(payload), contextWindowLimit: 32768,
    contextRecovery: async ({ payload }) => {
      const summary = await tracked(url, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Summarize' }], max_tokens: 512 }) });
      await summary.json();
      return { ...payload, messages: [{ role: 'user', content: 'Recovered task' }] };
    } });
  await response.json();
  assert.equal(completions, 3); assert.equal(state.ledger.turns, 3);
  assert.equal(state.ledger.outputMeasured, 40); assert.equal(state.ledger.outputReserved, 1024);
  await assert.rejects(tracked(url, { method: 'POST', body: JSON.stringify(payload) }), error => error.stopReason === 'turn_limit');
  assert.equal(completions, 3);
});

test('concurrent children atomically compete for one aggregate dispatch slot', async () => {
  configure({ maxAggregateToolCalls: 1 }); const scope = runtime.createParentRunBudget();
  const children = [{}, {}];
  const scripts = children.map((_, i) => script([reply(null, [call(`parallel-${i}`)]), reply('Bounded partial report.')]));
  const results = await Promise.all(children.map((child, i) => run(child, scripts[i], { budgetScope: scope })));
  assert.equal(scope.toolCalls, 1);
  assert.equal(children.reduce((sum, child) => sum + child.budgetState.toolCalls, 0), 1);
  assert.equal(results.filter(result => result.stopReason === 'aggregate_tool_limit').length, 2);
  for (const child of children) {
    const calls = child.context.filter(m => m.tool_calls).flatMap(m => m.tool_calls);
    const outputs = child.context.filter(m => m.role === 'tool');
    assert.equal(outputs.length, calls.length);
  }
});

test('failed requests retain reservations and do not become free continuation work', async () => {
  configure({ maxOutputTokens: 300 });
  const session = {}; const s = script([new Response('failed', { status: 500 })]);
  const result = await run(session, s);
  assert.equal(result.stopReason, 'provider_error'); assert.equal(result.outcome, 'failed');
  assert.equal(session.budgetState.ledger.turns, 1); assert.equal(session.budgetState.ledger.outputReserved, 300);
  const again = script([]); const continued = await run(session, again);
  assert.equal(continued.stopReason, 'output_budget'); assert.equal(again.requests.length, 0);
});

test('SSE usage is reconciled once and independently clamps the next request', async () => {
  configure({ maxOutputTokens: 500, maxToolCalls: 1 });
  const session = {}; const requests = [];
  const chunk = { choices: [{ delta: { tool_calls: [ { ...call('sse'), index: 0 } ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 200 } };
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return reply('Reported.', [], 'stop', { prompt_tokens: 40, completion_tokens: 20 });
  };
  const result = await run(session, { fetchImpl });
  assert.equal(result.stopReason, 'tool_limit'); assert.equal(requests[0].max_tokens, 500); assert.equal(requests[1].max_tokens, 300);
  assert.equal(result.usage.completion_tokens, 220); assert.equal(result.accounting.outputReserved, 0);
});

test('Qwen XML reporting after tool exhaustion returns source findings rather than another tool call', async () => {
  const tools = require('../src/main/tools/agentTools'); const execute = tools.executeAgentTool;
  tools.executeAgentTool = async () => 'SOURCE src/main/cloudProviders.js: lists provider models.';
  try {
    for (const mode of ['json', 'sse', 'incomplete']) {
      configure({ maxToolCalls: 1 });
      const xml = '<tool_call><function=search_project_content><parameter=query>/models</parameter><parameter=relative_path>src/main</parameter></function></tool_call>';
      const content = mode === 'incomplete' ? xml.slice(0, -20) : xml;
      const final = mode === 'sse' ? new Response([...content].map(char => `data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`).join('')
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) : reply(content);
      const s = script([reply(xml), final]);
      const session = {}; const result = await run(session, s);
      assert.equal(result.outcome, 'partial'); assert.equal(result.stopReason, 'tool_limit');
      assert.equal(result.accounting.finalizationStopReason, 'malformed_response');
      assert.equal(result.accounting.blockedCalls, mode === 'incomplete' ? 0 : 1);
      assert.equal(result.accounting.toolCalls, 1); assert.equal(s.requests.length, 2);
      assert.match(result.output, /SOURCE src\/main\/cloudProviders.js/);
      assert.ok(!result.output.includes('<tool_call>'));
      if (mode !== 'incomplete') assert.match(session.context.find(message => message.role === 'tool' && message.content.includes('Tools are disabled')).content, /Tools are disabled/);
    }
  } finally { tools.executeAgentTool = execute; }
});
