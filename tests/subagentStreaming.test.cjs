'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCompletion } = require('../src/main/subagents/providers/streamCompletion');

test('stream publishes progress before completion and assembles split tools, reasoning, and usage', async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const progress = [];
  const encode = chunk => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
  const completion = readCompletion(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), value => progress.push(value));
  controller.enqueue(encode({ choices: [{ delta: { reasoning_content: 'Inspecting' } }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress[0].type, 'thinking');
  assert.equal(progress[0].text, 'Inspecting');
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { completion_tokens: 12 } },
  ];
  // Exercise arbitrary network boundaries, including CRLF splits.
  for (const chunk of chunks) for (const byte of encode(chunk)) controller.enqueue(Uint8Array.of(byte));
  controller.close();
  const result = await completion;
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.equal(result.choices[0].message.reasoning_content, 'Inspecting');
  assert.equal(result.usage.completion_tokens, 12);
  assert.equal(progress.at(-1).type, 'tool-planning');
});

test('JSON-only providers retain their completion shape', async () => {
  const result = { choices: [{ message: { content: 'done' } }] };
  assert.deepEqual(await readCompletion(Response.json(result), () => {}), result);
});

test('stream errors fail the inference', async () => {
  await assert.rejects(readCompletion(new Response('data: {"error":{"message":"failed"}}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })), /failed/);
});

for (const mode of ['json', 'sse']) {
  test(`${mode} Qwen XML is normalized into tools and hidden from response previews`, async () => {
    const xml = '<tool_call><function=search_project_content><parameter=query>/models</parameter><parameter=relative_path>src/main</parameter></function></tool_call>';
    const content = `Before ${xml} After`;
    const response = mode === 'json' ? Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
      : new Response([...content].map(char => `data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`).join('')
        + 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const progress = [];
    const result = await readCompletion(response, event => progress.push(event));
    assert.equal(result.choices[0].message.content, 'Before  After');
    const calls = result.choices[0].message.tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'search_project_content');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { query: '/models', relative_path: 'src/main' });
    assert.ok(progress.filter(event => event.type === 'responding').every(event => !event.text.includes('<')));
  });
  test(`${mode} incomplete XML is marked unusable instead of a final answer`, async () => {
    const content = '<tool_call><function=search_project_content><parameter=query>/models';
    const response = mode === 'json' ? Response.json({ choices: [{ message: { content } }] })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const result = await readCompletion(response);
    assert.equal(result.choices[0].message.content, '');
    assert.equal(result.choices[0].message.toolMarkupIncomplete, true);
    assert.equal(result.choices[0].message.tool_calls, undefined);
  });
}
