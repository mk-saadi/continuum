import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat, MAX_TOOL_ARGUMENT_CHARS, TOOL_ARGUMENT_SIZE_ERROR } from '../src/lib/memoryChat.mjs';

const base = { baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Work' }],
  chatTools: [{ type: 'function', function: { name: 'write_project_file' } }] };
const call = args => ({ id: 'large', type: 'function', function: { name: 'write_project_file', arguments: args } });
const json = message => Response.json({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
const sse = args => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ ...call(args.slice(0, 250000)), index: 0 }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(250000) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
};

test('500000-character arguments execute intact, including writes above the old 64K cap', async () => {
  const args = JSON.stringify({ content: 'x'.repeat(MAX_TOOL_ARGUMENT_CHARS - 14) });
  assert.equal(args.length, MAX_TOOL_ARGUMENT_CHARS);
  let requests = 0, executed = 0;
  await runMemoryChat({ ...base,
    executeTool: async tool => { executed++; assert.equal(tool.arguments, args); return { success: true }; },
    fetchImpl: async () => ++requests === 1 ? sse(args) : json({ content: '[TASK COMPLETE]' }),
  });
  assert.equal(executed, 1);
});

for (const mode of ['sse', 'json', 'xml']) {
  test(`oversized ${mode} calls return a tool error and allow a smaller retry`, async () => {
    const args = JSON.stringify({ content: 'x'.repeat(MAX_TOOL_ARGUMENT_CHARS) });
    let requests = 0, executed = 0;
    await runMemoryChat({ ...base,
      executeTool: async tool => { executed++; assert.equal(tool.arguments, '{}'); return { success: true }; },
      fetchImpl: async (_url, options) => {
        requests++;
        if (requests === 1) {
          if (mode === 'sse') return sse(args);
          if (mode === 'json') return json({ tool_calls: [call(args)] });
          return json({ content: `<tool_call><function=write_project_file><parameter=content>${'x'.repeat(MAX_TOOL_ARGUMENT_CHARS)}</parameter></function></tool_call>` });
        }
        if (requests === 2) {
          const history = JSON.parse(options.body).messages;
          const error = JSON.parse(history.at(-1).content);
          assert.equal(error.success, false);
          assert.equal(error.error, TOOL_ARGUMENT_SIZE_ERROR);
          assert.equal(history.at(-2).tool_calls[0].function.arguments, '{}');
          assert.ok(options.body.length < 10000, 'rejected arguments never inflate the retry context');
          return json({ tool_calls: [{ ...call('{}'), id: 'retry' }] });
        }
        return json({ content: '[TASK COMPLETE]' });
      },
    });
    assert.equal(executed, 1, 'only the smaller retry executes');
    assert.equal(requests, 3);
  });
}
