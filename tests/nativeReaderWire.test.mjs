import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompletion, runMemoryChat } from '../src/lib/memoryChat.mjs';
const args = [
  {}, { relative_path: 'sample.txt', start_line: 2, end_line: 3 },
  { relative_path: 'sample.txt', expected_content_hash: 'sha256:' + 'a'.repeat(64) },
  { attachment_id: 'fixture-attachment', start_line: 1, end_line: 2 },
  { relative_path: 'sample.txt', attachment_id: 'fixture-attachment' },
];
const call = value => ({ id: 'reader', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify(value) } });
function stream(value, id = 'reader') {
  const text = JSON.stringify(value);
  const chunks = [{ tool_calls: [{ index: 0, id, function: { name: 'read_project_file', arguments: '' } }] },
    ...Array.from(text, character => ({ tool_calls: [{ index: 0, function: { arguments: character } }] }))];
  const raw = chunks.map(delta => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n').join('') +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  // Also split transport bytes inside JSON and SSE delimiters.
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
for (const value of args) test('wire parity preserves source presence: ' + JSON.stringify(value), async () => {
  for (const response of [stream(value), Response.json({ choices: [{ message: { tool_calls: [call(value)] }, finish_reason: 'tool_calls' }] })]) {
    const parsed = await readCompletion(response, () => {}, AbortSignal.timeout(2000), Date.now, () => {});
    assert.equal(parsed.toolCalls.length, 1);
    assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), value);
  }
});
test('empty reader call is rejected, corrected retry retains its explicit source', async () => {
  let requests = 0;
  const observed = [];
  await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture', messages: [{ role: 'system', content: 'Use tools' }, { role: 'user', content: 'Read sample.txt' }],
    chatTools: [{ type: 'function', function: { name: 'read_project_file', parameters: { type: 'object' } } }],
    signal: AbortSignal.timeout(3000),
    fetchImpl: async () => {
      assert.ok(++requests <= 3, 'request ceiling');
      return requests < 3 ? stream(requests === 1 ? {} : { relative_path: 'sample.txt' }, 'reader-' + requests) :
        Response.json({ choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] });
    },
    executeTool: async call => {
      const values = JSON.parse(call.arguments); observed.push(values);
      return values.relative_path ? { success: true, content: 'Fixture' } :
        { success: false, code: 'INVALID_READ_SOURCE', error: 'Provide exactly one source' };
    } });
  assert.deepEqual(observed, [{}, { relative_path: 'sample.txt' }]);
  assert.equal(requests, 3);
});
