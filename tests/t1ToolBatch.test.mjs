import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMemoryChat, readCompletion, MAX_TOOL_CALLS_PER_RESPONSE } from '../src/lib/memoryChat.mjs';
const require = createRequire(import.meta.url);
const { preflightIndependentRead } = require('../src/main/toolBatchPreflight');
const tools = ['read_project_file', 'write_project_file', 'mcp_unknown', 'lsp_hover'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const calls = (n, prefix = 'a', name = 'read_project_file') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, type: 'function', function: { name, arguments: JSON.stringify({ relative_path: 'file', start_line: i + 1 }) } }));
const json = (toolCalls, content = '') => new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
async function run(batches, extra = {}) {
  const executed = [], requests = [], states = [], steps = [];
  let turn = 0;
  const text = await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture', chatTools: tools,
    messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Read the files.' }],
    preflightIndependentRead: async call => call.function.name === 'read_project_file',
    fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return json(batches[turn++] ?? [], 'Done.'); },
    executeTool: async call => { executed.push(call.id); return { success: true }; },
    onExecutionSteps: value => { steps.splice(0, steps.length, ...structuredClone(value)); },
    onTaskIncomplete: value => states.push(value), ...extra });
  return { executed, requests, states, steps, text };
}
for (const n of [1, 16, 18, 24, 25, 28, 30, 48, 50, 72]) {
  test(`${n} calls obey response cap; excess calls preserve identity and order`, async () => {
    assert.equal(MAX_TOOL_CALLS_PER_RESPONSE, 24);
    const batch = calls(n);
    const result = await run([batch]);
    assert.deepEqual(result.executed, batch.map(call => call.id));
    const history = result.requests[1].messages;
    const results = history.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), batch.map(call => call.id));
    assert.ok(results.every(result => JSON.parse(result.content).success === true));
    assert.equal(result.requests.length, 2);
    assert.equal(result.states.length, 0);
  });
}
test('actual failures remain errors while remaining reads execute once', async () => {
  let count = 0;
  const result = await run([calls(28)], { executeTool: async () => { if (++count === 2) throw new Error('read failed'); return { success: true }; } });
  const outputs = result.requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(JSON.parse(outputs[1].content).error, 'read failed');
  assert.equal(JSON.parse(outputs[27].content).success, true);
  assert.equal(count, 28);
});
for (const kind of ['mixed', 'edit', 'unknown-mcp', 'dependency', 'malformed']) {
  test(`${kind} oversized batch executes nothing and correction succeeds`, async () => {
    const batch = calls(25, 'bad', kind === 'edit' ? 'write_project_file' : 'read_project_file');
    if (kind === 'mixed') batch[24].function.name = 'write_project_file';
    if (kind === 'unknown-mcp') batch[24].function.name = 'mcp_unknown';
    if (kind === 'malformed') batch[24].function.arguments = '{';
    const result = await run([batch, calls(1, 'fixed')], kind === 'dependency' ? { preflightIndependentRead: async () => false } : {});
    assert.deepEqual(result.executed, ['fixed-0']);
    assert.equal(result.states.length, 0);
    assert.ok(result.requests[1].messages.filter(message => message.role === 'tool').every(message => JSON.parse(message.content).status === 'rejected'));
  });
}
test('two unsuccessful correction attempts end explicitly incomplete', async () => {
  const result = await run([calls(25, 'a', 'write_project_file'), calls(25, 'b', 'write_project_file'), calls(25, 'c', 'write_project_file')]);
  assert.deepEqual(result.executed, []);
  assert.equal(result.requests.length, 3);
  assert.equal(result.states[0].reason, 'tool-batch-correction-exhausted');
  assert.match(result.text, /Task incomplete/);
});
test('plain text after rejection cannot claim completed status', async () => {
  const result = await run([calls(25, 'a', 'write_project_file')]);
  assert.equal(result.states[0].reason, 'tool-batch-unresolved');
});
test('cancellation during preflight executes nothing', async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(run([calls(25)], { signal: controller.signal,
    preflightIndependentRead: async () => { controller.abort(); return true; }, executeTool: async () => count++ }), /abort/i);
  assert.equal(count, 0);
});
for (const state of ['deleted', 'permission']) test(`${state} stops overflow continuation`, async () => {
  let count = 0;
  await assert.rejects(run([calls(25)], { getTaskState: async () => {
    if (state === 'deleted') throw new Error('Task session deleted.');
    return { canContinue: false };
  }, executeTool: async () => count++ }), /deleted|permissions changed/);
  assert.equal(count, 0);
});
test('duplicate IDs reject before execution', async () => {
  const batch = calls(25); batch[24].id = batch[0].id;
  await assert.rejects(run([batch]), /repeated tool-call ID/);
});
test('stream fragments assemble 50 logical entries in provider index order', async () => {
  const batch = calls(50);
  const events = batch.flatMap((call, index) => [
    { choices: [{ delta: { tool_calls: [{ index: index * 2, id: call.id, function: { name: call.function.name, arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: index * 2, function: { arguments: '1}' } }] } }] },
  ]);
  events.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  const result = await readCompletion(response, () => {}, undefined, () => 1, () => {});
  assert.deepEqual(result.toolCalls.map(call => call.id), batch.map(call => call.id));
  assert.ok(result.toolCalls.every(call => call.function.arguments === '{"x":1}'));
});
test('production preflight requires schema, native implementation, concrete contained regular file and live authorization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 't1-'));
  try {
    await writeFile(path.join(root, 'file'), 'text');
    let authorized = 0;
    const context = { root, tools, nativeNames: new Set(['read_project_file']), authorize: async () => authorized++ };
    assert.equal(await preflightIndependentRead(calls(1)[0], context), true);
    assert.equal(authorized, 1);
    assert.equal(await preflightIndependentRead(calls(1, 'a', 'mcp_unknown')[0], context), false);
    const directory = calls(1)[0]; directory.function.arguments = '{"relative_path":"."}';
    assert.equal(await preflightIndependentRead(directory, context), false);
    await assert.rejects(preflightIndependentRead(calls(1)[0], { ...context, authorize: async () => { throw new Error('revoked'); } }), /revoked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deferred/rejected statuses persist and never count as successful timeline executions', async () => {
  const { normalizeExecutionSteps } = require('../src/main/executionSteps');
  const { classifyStep, summarizeStage } = await import('../src/lib/executionEvents.mjs');
  const steps = ['deferred', 'rejected'].map((status, i) => ({ type: 'tool_call', id: `s${i}`, toolName: 'read_project_file', status }));
  assert.deepEqual(normalizeExecutionSteps(steps), steps);
  assert.deepEqual(steps.map(step => classifyStep(step).key), ['deferred', 'rejected']);
  const stage = summarizeStage({ events: steps });
  assert.equal(stage.done, 0);
  assert.deepEqual(stage.status, ['1 deferred', '1 rejected']);
});
test('Anthropic pairs every requested operation with explicit real/deferred/rejected results', async () => {
  const { anthropicPayload } = require('../src/main/cloudProviders');
  for (const malformed of [false, true]) {
    const batch = calls(25);
    if (malformed) batch[24].function.arguments = '{';
    const result = await run([batch, calls(1, 'corrected')]);
    const payload = anthropicPayload(result.requests[1], 'claude-fixture');
    const blocks = payload.messages.flatMap(message => message.content);
    const emitted = blocks.filter(block => block.type === 'tool_use');
    const outputs = blocks.filter(block => block.type === 'tool_result');
    assert.deepEqual(outputs.map(block => block.tool_use_id), emitted.map(block => block.id));
    assert.equal(outputs.length, 25);
    assert.match(JSON.stringify(outputs.at(-1)), malformed ? /rejected/ : /success/);
  }
});
test('dynamic tool advertisements and mixed MCP/native batches retain the same cap', async () => {
  let active = false;
  const result = await run([calls(24), calls(24, 'mcp', 'mcp_unknown'), calls(1, 'lsp', 'lsp_hover')], {
    getChatTools: async () => active ? tools : tools.filter(tool => tool.function.name === 'read_project_file'),
    executeTool: async () => { active = true; return { success: true }; },
  });
  assert.equal(result.requests[0].tools.length, 1);
  assert.equal(result.requests[1].tools.length, 4);
  assert.equal(result.states.length, 0);
  const mixed = calls(25); mixed[1].function.name = 'mcp_unknown';
  assert.deepEqual((await run([mixed, calls(1, 'fix')])).executed, ['fix-0']);
});
test('automatic reads leave no deferred correction state', async () => {
  const result = await run([calls(50), calls(1, 'unrelated', 'lsp_hover')]);
  assert.equal(result.states.length, 0);
});
test('identical reads preserve distinct call identities', async () => {
  const batch = calls(25).map(call => ({ ...call, function: { ...call.function, arguments: '{"relative_path":"file"}' } }));
  const result = await run([batch]);
  assert.equal(result.states.length, 0);
  assert.equal(result.executed.length, 25);
});
test('permission revision between internal batches stops pending reads', async () => {
  let checks = 0, executed = 0;
  const result = await run([calls(28)], {
    getTaskState: async () => ({ canContinue: ++checks <= 2 }),
    executeTool: async () => { executed++; return { success: true }; },
  });
  assert.equal(executed, 24);
  assert.equal(result.requests.length, 1);
  assert.equal(result.states[0].reason, 'automatic-read-interrupted');
  assert.ok(result.steps.slice(24).every(step => step.status === 'rejected'));
});
for (const mode of ['sse', 'xml']) test(`${mode} overflow executes all reads after full assembly`, async () => {
  let requests = 0, executed = 0;
  await run([], { executeTool: async () => { executed++; return { success: true }; },
    fetchImpl: async () => {
      if (requests++) return json([]);
      if (mode === 'xml') return json([], Array.from({ length: 25 }, () => '<tool_call><function=read_project_file><parameter=relative_path>file</parameter></function></tool_call>').join(''));
      const batch = calls(25).map((call, index) => ({ ...call, index }));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: batch } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } });
  assert.equal(executed, 25);
  assert.equal(requests, 2);
});
test('context failure after partial read execution interrupts without replay', async () => {
  let requests = 0, executed = 0;
  await assert.rejects(run([], { executeTool: async () => { executed++; return {}; },
    fetchImpl: async () => { if (requests++) throw new Error('Context budget exceeded'); return json(calls(25)); } }), /Context budget exceeded/);
  assert.equal(executed, 25);
  assert.equal(requests, 2);
});

for (const n of [73, 100]) test(`${n} safe reads reject in full above ceiling`, async () => {
  const result = await run([calls(n)]);
  assert.equal(result.executed.length, 0);
  assert.equal(result.states[0].reason, 'tool-batch-unresolved');
  assert.ok(result.requests[1].messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).status === 'rejected'));
});
for (const reason of ['cancellation', 'deletion', 'ownership', 'permission']) test(`${reason} after batch one preserves completed results and blocks unstarted reads`, async () => {
  const controller = new AbortController();
  let count = 0;
  const result = await run([calls(50)], {
    signal: controller.signal,
    getTaskState: async () => {
      if (count < 24) return { canContinue: true };
      if (reason === 'deletion') throw new Error('Session deleted.');
      if (reason === 'ownership') throw new Error('Parent ownership changed.');
      return { canContinue: reason !== 'permission' };
    },
    executeTool: async () => { count++; if (count === 24 && reason === 'cancellation') controller.abort(); return { success: true }; },
  });
  assert.equal(count, 24);
  assert.equal(result.requests.length, 1);
  assert.equal(result.states[0].reason, 'automatic-read-interrupted');
  assert.equal(result.steps.filter(s => s.status === 'complete').length, 24);
  assert.equal(result.steps.filter(s => s.status === 'rejected').length, 26);
});
test('aggregate UTF-8 output guard blocks remaining calls without losing completed output', async () => {
  let count = 0;
  const result = await run([calls(50)], { executeTool: async () => { count++; return { success: true, content: 'line\n'.repeat(220000) }; } });
  assert.equal(count, 2);
  assert.equal(result.states[0].detail, 'aggregate output limit');
  assert.equal(result.steps[0].result.content.length, 1100000);
  assert.equal(result.steps.filter(s => s.status === 'rejected').length, 48);
});
test('every internal boundary revalidates the complete next slice before starting it', async () => {
  const executed = [], boundaries = [];
  const batch = calls(72);
  let initial = 0;
  const result = await run([batch], {
    preflightIndependentRead: async call => {
      if (++initial > 72 && (initial - 73) % 24 === 0) boundaries.push(executed.length);
      return true;
    },
    executeTool: async call => { executed.push(call.id); return { success: true }; },
  });
  assert.deepEqual(boundaries, [0, 24, 48]);
  assert.deepEqual(executed, batch.map(c => c.id));
  assert.equal(result.requests.length, 2);
});
test('a file disappearing between batches prevents the next slice from starting', async () => {
  let count = 0;
  const result = await run([calls(28)], {
    preflightIndependentRead: async () => { if (count >= 24) throw new Error('ENOENT'); return true; },
    executeTool: async () => { count++; return { success: true }; },
  });
  assert.equal(count, 24);
  assert.equal(result.states[0].reason, 'automatic-read-interrupted');
});
test('production preflight rejects traversal, symlink escape, invalid range and unsupported arguments', async () => {
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 't11-safe-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 't11-outside-'));
  try {
    await writeFile(path.join(root, 'file'), 'text');
    await writeFile(path.join(outside, 'file'), 'secret');
    await symlink(path.join(outside, 'file'), path.join(root, 'link'));
    const context = { root, tools, nativeNames: new Set(['read_project_file']), authorize: async () => {} };
    for (const args of [{ relative_path: '../missing' }, { relative_path: 'link' }, { relative_path: 'file', start_line: 3, end_line: 2 }, { relative_path: 'file', char_start: 0 }, { relative_path: 'file', unknown: true }]) {
      const call = { ...calls(1)[0], function: { name: 'read_project_file', arguments: JSON.stringify(args) } };
      let safe = false;
      try { safe = await preflightIndependentRead(call, context); } catch {}
      assert.equal(safe, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('timeline reports actual internal batch completion without duplicate steps', async () => {
  const result = await run([calls(28)]);
  const { summarizeStage } = await import('../src/lib/executionEvents.mjs');
  const summary = summarizeStage({ events: result.steps.filter(s => s.type === 'tool_call') });
  assert.equal(summary.done, 28);
  assert.ok(summary.status.includes('24 completed in batch 1'));
  assert.ok(summary.status.includes('4 completed in batch 2'));
  assert.equal(result.steps.filter(s => s.type === 'tool_call').length, 28);
});
test('stricter remaining execution budget rejects oversized reads before any dispatch', async () => {
  const { planToolBatch } = require('../src/lib/toolBatchPolicy.cjs');
  let checks = 0;
  const plan = await planToolBatch(calls(28), { allowedNames: new Set(['read_project_file']), preflight: async () => { checks++; return true; }, maxAutomaticReads: 25 });
  assert.equal(plan.safe, false);
  assert.equal(checks, 0);
  assert.ok(plan.skipped.every(s => s.status === 'rejected'));
});
test('unresolved approval in full preflight rejects every call', async () => {
  let checks = 0;
  const result = await run([calls(28)], { preflightIndependentRead: async () => { if (++checks === 28) throw new Error('Approval required'); return true; } });
  assert.equal(result.executed.length, 0);
  assert.equal(result.states[0].reason, 'tool-batch-unresolved');
});
