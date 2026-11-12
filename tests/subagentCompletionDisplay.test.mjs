import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { truncateToolOutput } = require('../src/main/engineManager');
import { runMemoryChat } from '../src/lib/memoryChat.mjs';
test('a later child finishes visibly before the first child while model history stays in call order', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let latest = [], requests = 0;
  const tool = { type: 'function', function: { name: 'spawn_sub_agent', parameters: { type: 'object' } } };
  const reply = (content, tool_calls = []) => Response.json({ choices: [{ finish_reason: tool_calls.length ? 'tool_calls' : 'stop', message: { content, tool_calls } }] });
  const running = runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture',
    messages: [{ role: 'system', content: 'Investigate.' }, { role: 'user', content: 'Investigate independently.' }], chatTools: [tool],
    resolveTool: () => ({ serverName: 'native' }),
    onExecutionSteps: steps => { latest = structuredClone(steps); },
    executeTool: call => call.id === 'slow' ? slow : Promise.resolve('Second child complete.'),
    fetchImpl: async (_url, options) => {
      if (requests++ === 0) return reply('', ['slow', 'fast'].map(id => ({ id, type: 'function', function: { name: 'spawn_sub_agent', arguments: '{}' } })));
      assert.deepEqual(JSON.parse(options.body).messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['slow', 'fast']);
      return reply('Both complete.');
    } });
  try {
    for (let i = 0; i < 100 && latest.find(step => step.id === 'fast')?.status !== 'complete'; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(latest.find(step => step.id === 'fast')?.status, 'complete');
    assert.equal(latest.find(step => step.id === 'slow')?.status, 'running');
    assert.equal(requests, 1, 'parent waits for both before asking the model again');
  } finally { release('First child complete.'); }
  assert.equal(await running, 'Both complete.');
});

for (const name of ['spawn_sub_agent', 'delegate_task', 'extract_web_page_data']) {
  test(`${name} delivers a long answer intact to the parent's next model request`, async () => {
    const answer = 'ANSWER_START\n' + 'Detailed finding with file paths and rationale.\n'.repeat(1000) + 'ANSWER_END';
    let requests = 0;
    await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture',
      messages: [{ role: 'system', content: 'Use the child findings.' }, { role: 'user', content: 'Analyze.' }],
      chatTools: [{ type: 'function', function: { name, parameters: { type: 'object' } } }],
      resolveTool: () => ({ serverName: 'native' }), guardToolContent: truncateToolOutput,
      executeTool: async () => answer,
      fetchImpl: async (_url, options) => {
        const response = message => Response.json({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
        if (requests++ === 0) return response({ content: '', tool_calls: [{ id: 'child-handoff', type: 'function', function: { name, arguments: '{}' } }] });
        const tool = JSON.parse(options.body).messages.find(m => m.role === 'tool');
        assert.equal(tool.content, answer, 'full body, middle and ending survive the production tool guard');
        return response({ content: 'Received the complete findings.' });
      } });
    assert.equal(requests, 2);
  });
}
