import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat, AUTO_CONTINUE_NUDGE, AUTO_TURN_LIMIT_NOTICE, REASONING_LOOP_NOTICE } from '../src/lib/memoryChat.mjs';
const tool = id => ({ tool_calls: [{ id, type: 'function', function: { name: 'inspect', arguments: '{}' } }] });
const response = message => Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const base = { baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Work autonomously.' }],
  chatTools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }] };

test('status-only response after a tool is nudged, retains history, then executes the next tool', async () => {
  const requests = []; let executed = 0, streamed = '', stats;
  const replies = [tool('first'), { content: 'Resuming the fix now...' }, tool('second'), { content: 'Fixed and verified. [TASK COMPLETE]   ' }];
  const result = await runMemoryChat({ ...base, executeTool: async () => { executed++; return 'Inspected'; },
    onText: delta => { streamed += delta; }, onStats: value => { stats = value; },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return response(replies[requests.length - 1]); },
  });
  assert.equal(executed, 2); assert.equal(requests.length, 4);
  assert.equal(requests[2].messages.at(-2).content, 'Resuming the fix now...');
  assert.equal(requests[2].messages.at(-1).content, AUTO_CONTINUE_NUDGE);
  assert.equal(requests[2].tool_choice, 'auto');
  assert.equal(requests[3].messages.at(-1).tool_call_id, 'second');
  assert.equal(result, streamed); assert.ok(!result.includes(AUTO_CONTINUE_NUDGE));
  assert.equal(stats.completionTokens, 20);
  assert.equal(base.messages.length, 1, 'caller history is unchanged');
});

for (const ending of ['Which file should I change?  \n', 'Changes verified. [TASK COMPLETE]\n']) {
  test(`stops for an explicit final ending: ${ending.trim()}`, async () => {
    let requests = 0;
    await runMemoryChat({ ...base, executeTool: async () => 'OK', fetchImpl: async () => response(++requests === 1 ? tool('first') : { content: ending }) });
    assert.equal(requests, 2);
  });
}

test('ordinary answers without prior tool execution finish immediately', async () => {
  let requests = 0;
  const result = await runMemoryChat({ ...base, fetchImpl: async () => { requests++; return response({ content: 'Hello.' }); } });
  assert.equal(result, 'Hello.'); assert.equal(requests, 1);
});

test('empty and unfinished responses hit the 15-follow-up cap and publish a notice', async () => {
  let requests = 0, executions = 0, streamed = '';
  const result = await runMemoryChat({ ...base, executeTool: async () => { executions++; return 'OK'; }, onText: delta => { streamed += delta; },
    fetchImpl: async (_url, options) => {
      requests++;
      if (requests === 16) assert.equal(JSON.parse(options.body).tool_choice, 'none');
      return response(requests === 1 ? tool('first') : { content: requests % 2 ? '' : 'Continuing.' });
    },
  });
  assert.equal(requests, 16); assert.equal(executions, 1);
  assert.ok(result.endsWith(AUTO_TURN_LIMIT_NOTICE)); assert.equal(result, streamed);
});

test('the safety cap covers alternating tool and status turns', async () => {
  let requests = 0, executions = 0;
  const result = await runMemoryChat({ ...base, maxAutoTurns: 3, executeTool: async () => { executions++; return 'OK'; },
    fetchImpl: async () => { requests++; return response(requests % 2 ? tool(`call${requests}`) : { content: 'Still working.' }); },
  });
  assert.equal(requests, 4); assert.equal(executions, 2); assert.ok(result.endsWith(AUTO_TURN_LIMIT_NOTICE));
});

test('reasoning-loop termination after a tool never triggers an automatic restart', async () => {
  let requests = 0;
  const paragraph = 'I should inspect the implementation carefully before choosing the next approach.\n';
  const result = await runMemoryChat({ ...base, executeTool: async () => 'OK', fetchImpl: async () => response(++requests === 1
    ? tool('first') : { reasoning_content: paragraph.repeat(3), content: 'Do not resume.' }) });
  assert.equal(requests, 2); assert.ok(result.endsWith(REASONING_LOOP_NOTICE));
});

test('cancellation while nudging prevents another request', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(runMemoryChat({ ...base, signal: controller.signal, executeTool: async () => 'OK',
    onText: text => { if (text === 'Still working.') controller.abort(); },
    fetchImpl: async () => response(++requests === 1 ? tool('first') : { content: 'Still working.' }),
  }), { name: 'AbortError' });
  assert.equal(requests, 2);
});
