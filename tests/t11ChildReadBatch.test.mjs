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
test('child investigation uses the shared per-response cap without limiting task lifetime', async () => {
  const runtime = require('../src/main/subagents');
  const root = await mkdtemp(path.join(os.tmpdir(), 't1-child-'));
  try {
    await writeFile(path.join(root, 'file'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    const requests = [];
    const batches = [calls(25)];
    const output = await runtime.runInvestigation({ task: 'Read the file pages.', rootPath: root,
      engine: { port: 4321, modelId: 'fixture', contextLength: 32768 }, parentSessionId: 't1-child-fixture',
      fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return json(batches.shift() ?? [], 'All inspected.'); } });
    assert.match(output, /All inspected/);
    const results = requests[1].messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 25);
    assert.doesNotMatch(results[24].content, /deferred|skipped/);
    assert.ok(results.slice(0, 24).every(message => !message.content.includes('Tool skipped')));
    assert.equal(requests.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
