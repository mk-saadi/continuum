import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat, AUTO_CONTINUE_NUDGE, REASONING_LOOP_NOTICE } from '../src/lib/memoryChat.mjs';
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

test('empty and unfinished responses pause at the default 30-turn cap', async () => {
  let requests = 0, executions = 0, streamed = '', paused;
  const result = await runMemoryChat({ ...base, onPaused: async state => { paused = state; return false; }, executeTool: async () => { executions++; return 'OK'; }, onText: delta => { streamed += delta; },
    fetchImpl: async (_url, options) => {
      requests++;
      assert.equal(JSON.parse(options.body).tool_choice, 'auto');
      return response(requests === 1 ? tool('first') : { content: requests % 2 ? '' : 'Continuing.' });
    },
  });
  assert.equal(requests, 30); assert.equal(executions, 1);
  assert.equal(paused.executionState, 'paused_turn_limit'); assert.equal(result, streamed);
  assert.ok(!result.includes('[System: Autonomous turn limit'));
});

test('the safety cap covers alternating tool and status turns', async () => {
  let requests = 0, executions = 0;
  const result = await runMemoryChat({ ...base, maxAutoTurns: 3, executeTool: async () => { executions++; return 'OK'; },
    fetchImpl: async () => { requests++; return response(requests % 2 ? tool(`call${requests}`) : { content: 'Still working.' }); },
  });
  assert.equal(requests, 3); assert.equal(executions, 2);
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

test('pause waits for user continuation and never re-executes pending tools', async () => {
  let resume, requests = 0, executions = 0;
  let markPaused;
  const paused = new Promise(resolve => { markPaused = resolve; });
  const run = runMemoryChat({ ...base, maxAutoTurns: 1,
    onPaused: state => { assert.equal(state.reason, 'turn_limit'); markPaused(); return new Promise(resolve => { resume = resolve; }); },
    executeTool: async () => { executions++; return { success: true }; },
    fetchImpl: async (_url, options) => {
      if (++requests === 1) return response(tool('first'));
      assert.equal(JSON.parse(options.body).messages.at(-1).tool_call_id, 'first');
      return response({ content: 'Done. [TASK COMPLETE]' });
    },
  });
  await paused;
  assert.equal(executions, 1); assert.equal(requests, 1);
  resume(true);
  assert.equal(await run, 'Done. [TASK COMPLETE]');
  assert.equal(executions, 1); assert.equal(requests, 2);
});

for (const success of [true, false]) {
  test(`write success=${success} ${success ? 'resets' : 'does not reset'} the turn budget`, async () => {
    let requests = 0, pauses = 0;
    const write = id => ({ tool_calls: [{ id, function: { name: 'write_project_file', arguments: '{}' } }] });
    await runMemoryChat({ ...base, maxAutoTurns: 3,
      chatTools: [...base.chatTools, { type: 'function', function: { name: 'write_project_file' } }],
      onPaused: async () => { pauses++; return false; },
      executeTool: async () => ({ success }),
      fetchImpl: async () => response(++requests <= 2 ? write(`w${requests}`) : requests === 3 ? tool('inspect') : { content: '[TASK COMPLETE]' }),
    });
    assert.equal(requests, success ? 4 : 3);
    assert.equal(pauses, success ? 0 : 1);
  });
}

test('successful boundary write finishes before pausing', async () => {
  let written = false;
  await runMemoryChat({ ...base, maxAutoTurns: 1,
    chatTools: [{ type: 'function', function: { name: 'str_replace_editor' } }],
    executeTool: async () => { await Promise.resolve(); written = true; return { success: true }; },
    onPaused: async () => { assert.ok(written); return false; },
    fetchImpl: async () => response({ tool_calls: [{ id: 'write', function: { name: 'str_replace_editor', arguments: '{}' } }] }),
  });
  assert.ok(written);
});
