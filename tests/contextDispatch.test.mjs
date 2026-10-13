import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';
import fixture from './fixtures/contextBackend.cjs';
import child from '../src/main/subagents/agentLoop.js';
import local from '../src/main/subagents/providers/localProvider.js';
const { backend, overflow } = fixture;
const reply = content => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const toolReply = () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
const tool = description => [{ type: 'function', function: { name: 'read', description, parameters: { type: 'object' } } }];
const base = { baseUrl: 'http://localhost', modelId: 'loaded', loadedContextSize: 8192,
  messages: [{ role: 'system', content: 'old instructions' }, { role: 'user', content: 'current attached text' }], chatTools: tool('read') };

test('tool-loop additions and refreshed schemas are guarded before the second completion', async () => {
  let schemas = 0, recovery = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: toolReply });
  await assert.rejects(runMemoryChat({ ...base, fetchImpl: b.fetch,
    getChatTools: () => tool(++schemas === 1 ? 'read' : 'x'.repeat(30000)),
    executeTool: async () => 'y'.repeat(18000),
    recoverContext: async () => { recovery++; return null; },
  }), /cannot fit/);
  assert.equal(b.calls.length, 1); assert.equal(recovery, 1);
});
test('recovery refreshes RAG/settings/tools and preserves live tool pairs without re-executing tools', async () => {
  let executions = 0, retrievals = 0, schemaReads = 0;
  const b = backend({ infer: (_payload, n) => n === 1 ? toolReply() : n === 2 ? overflow() : reply('Done [TASK COMPLETE]') });
  const result = await runMemoryChat({ ...base, fetchImpl: b.fetch,
    getChatTools: () => tool(`fresh schema ${++schemaReads}`),
    getSamplingParams: () => ({ temperature: schemaReads > 2 ? 0.2 : 0.7 }),
    retrieveDocuments: async () => [{ file_name: 'notes', chunk_index: 0, chunk_text: `retrieved ${++retrievals}` }],
    executeTool: async () => { executions++; return 'tool result retained'; },
    recoverContext: async () => ({ messages: [{ role: 'system', content: 'updated summary and skill' }, { role: 'user', content: 'current attached text' }] }),
  });
  assert.equal(result, 'Done [TASK COMPLETE]'); assert.equal(executions, 1); assert.equal(b.calls.length, 3);
  const retried = b.calls[2]; assert.match(retried.messages[0].content, /updated summary and skill/); assert.match(retried.messages[0].content, /retrieved 2/);
  assert.equal(retried.temperature, 0.2); assert.match(retried.tools[0].function.description, /fresh schema 3/);
  const call = retried.messages.find(m => m.tool_calls)?.tool_calls[0];
  const resultMessage = retried.messages.find(m => m.role === 'tool');
  assert.equal(call.id, resultMessage.tool_call_id); assert.equal(resultMessage.content, 'tool result retained');
});
function childSession() {
  const context = [{ role: 'system', content: 'Child instructions' }, { role: 'user', content: 'Original task' }];
  for (let i = 0; i < 8; i++) context.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: `Original result ${i} ${'.'.repeat(1800)}` }, { role: 'user', content: `Continue ${i}` });
  return { context };
}
test('child investigation compacts under pressure, preserves raw originals and paired protected rounds', async () => {
  const session = childSession(); const originals = structuredClone(session.context); let attempts = 0, summaries = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: payload => {
    if (payload.messages[0].content.startsWith('Summarize')) { summaries++; return reply('faithful child summary'); }
    if (payload.messages[0].content.startsWith('You are compressing')) return reply(JSON.stringify({ objective: 'Original task', nextActions: ['Continue investigation'] }));
    attempts++; return reply('Child final answer');
  } });
  const result = await child.runInvestigationExecution({ session, engine: { provider: 'local', port: 9999, modelId: 'loaded', contextLength: 8192 }, fetchImpl: b.fetch });
  assert.equal(result.output, 'Child final answer'); assert.equal(attempts, 1); assert.equal(summaries, 1);
  assert.equal(session.compactionState.version, 1);
  assert.deepEqual(session.rawContext.slice(0, originals.length).map(({id, ...message}) => message), originals);
  const retainedCalls = session.context.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id));
  assert.deepEqual(session.context.filter(m => m.role === 'tool').map(m => m.tool_call_id), retainedCalls);
});
test('child overflow with only protected rounds stops; one-shot task has no recovery retry', async () => {
  const session = childSession(); let attempts = 0, summaries = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: payload => {
    if (payload.messages[0].content.startsWith('Summarize')) { summaries++; return reply('child summary'); }
    if (payload.messages[0].content.startsWith('You are compressing')) return reply(JSON.stringify({ objective: 'Original task', nextActions: ['Continue investigation'] }));
    attempts++; return overflow();
  } });
  const result = await child.runInvestigationExecution({ session, engine: { port: 9999, modelId: 'loaded', contextLength: 8192 }, fetchImpl: b.fetch });
  assert.equal(result.stopReason, 'context_exhausted'); assert.equal(result.outcome, 'partial');
  assert.equal(attempts, 1); assert.equal(summaries, 1);
  const one = backend({ infer: overflow });
  await assert.rejects(local.chatCompletion({ engine: { port: 9999, modelId: 'loaded', contextLength: 8192 }, payload: { model: 'loaded', messages: [{ role: 'system', content: 'required instructions' }, { role: 'user', content: 'required file/task' }], max_tokens: 1024 }, fetchImpl: one.fetch }), /cannot fit/);
  assert.equal(one.calls.length, 1);
});
