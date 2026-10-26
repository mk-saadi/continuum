import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';

function response() {
  const events = [
    { choices: [{ delta: { reasoning: 'Thinking about the answer' } }] },
    { choices: [{ delta: { content: 'Hello there! ' } }] },
    { choices: [{ delta: { content: 'How can I help you?' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 20, cost: 0.001 } },
  ];
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

for (const casualMode of [true, false]) test(`${casualMode ? 'casual' : 'workspace'} cloud responses publish growing live estimates without persisting approximate counters`, async () => {
  const live = [], settled = [];
  let clock = 0;
  await runMemoryChat({ baseUrl: 'http://test', modelId: 'test', cloud: true, casualMode,
    messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hi' }], chatTools: [],
    now: () => clock += 250, fetchImpl: async () => response(),
    onLiveUsage: value => live.push(structuredClone(value)), onStats: value => settled.push(value) });
  assert.ok(live.length >= 4);
  assert.equal(live[0].current.completionTokens, 0);
  assert.ok(live[1].current.completionTokens > 0, 'hidden reasoning contributes to the estimate');
  assert.ok(live[2].current.completionTokens > live[1].current.completionTokens);
  assert.equal(settled.at(-1).promptTokens, 80);
  assert.equal(settled.at(-1).completionTokens, 20);
  assert.equal(settled.at(-1).providerCost, 0.001);
});

test('local responses do not publish live cloud estimates', async () => {
  for (const mode of [{ cloud: false, casualMode: false }, { cloud: false, casualMode: true }]) {
    const live = [];
    await runMemoryChat({ baseUrl: 'http://test', modelId: 'test', ...mode,
      messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hi' }], chatTools: [],
      fetchImpl: async () => response(), onLiveUsage: value => live.push(value) });
    assert.deepEqual(live, []);
  }
});

test('tool follow-ups include completed requests once and keep the active request separate', async () => {
  const live = [];
  let clock = 0, requests = 0;
  await runMemoryChat({ baseUrl: 'http://test', modelId: 'test', cloud: true, casualMode: true,
    messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Check' }],
    chatTools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => 'done', now: () => clock += 250,
    onLiveUsage: value => live.push(structuredClone(value)),
    fetchImpl: async () => {
      if (++requests > 1) return response();
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: {
        tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'check', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 60, completion_tokens: 10, cost: 0.0007 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(requests, 2);
  const followup = live.find(value => value.phases.length === 1);
  assert.ok(followup);
  assert.equal(followup.phases[0].providerCost, 0.0007);
  assert.equal(followup.phases[0].completionTokens, 10);
  assert.equal(followup.current.completionTokens, 0);
  assert.ok(live.every(value => value.phases.length <= 1));
});
