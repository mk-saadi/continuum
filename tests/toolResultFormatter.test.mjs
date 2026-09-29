import { JPEG_BASE64, largePng } from './fixtures/visionImages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolResult, moveToolImagesToUser, redactToolMedia } from '../src/lib/toolResultFormatter.mjs';
import { runMemoryChat, sanitizeChatMessages } from '../src/lib/memoryChat.mjs';
const png = largePng();
const jpeg = JPEG_BASE64;
const system = { role: 'system', content: 'You are helpful.' };
const call = (id, name = 'read_media_file') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const resultResponse = (content = 'I can see the image. [TASK COMPLETE]') => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const tools = ['read_media_file', 'take_screenshot', 'plain_tool'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const imageParts = result => result.content.filter(part => part.type === 'image_url');
function assertNoImageText(content) {
  if (typeof content === 'string') assert.ok(!content.includes(png) && !content.includes(jpeg));
  else if (Array.isArray(content)) for (const part of content) if (part.type === 'text') assertNoImageText(part.text);
}

test('native, MCP JSON, embedded resources, nested and inline image outputs are multimodal', () => {
  const cases = [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    { content: [{ type: 'image', mimeType: 'image/png', data: png }] },
    JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: png }, { type: 'text', text: 'Screenshot of a terminal' }] }),
    { content: [{ type: 'resource', resource: { mimeType: 'image/png', blob: png } }] },
    { result: { mime_type: 'image/png', base64: png } },
    `Captured: data:image/png;base64,${png}`,
    png,
  ];
  for (const value of cases) {
    const formatted = formatToolResult(value, 'read_media_file');
    assert.equal(imageParts(formatted)[0].image_url.url, `data:image/png;base64,${png}`);
    assertNoImageText(formatted.content);
    assert.ok(!JSON.stringify(formatted.displayResult).includes(png));
  }
  const mixed = formatToolResult({ content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: { image_base64: png } });
  assert.equal(imageParts(mixed).length, 1, 'duplicate content and structuredContent images are deduplicated');
});

test('MIME types, accompanying text, nonmedia JSON and canonical content stay intact', () => {
  const output = { content: [{ type: 'image', mimeType: 'image/jpeg', data: jpeg }, { type: 'text', text: 'A useful caption' }] };
  const formatted = formatToolResult(output);
  assert.equal(imageParts(formatted)[0].image_url.url, `data:image/jpeg;base64,${jpeg}`);
  assert.match(formatted.content[0].text, /A useful caption/);
  assert.equal(formatToolResult('plain text').content, 'plain text');
  assert.equal(formatToolResult('{ "ok": true }').content, '{ "ok": true }');
  assert.equal(formatToolResult({ matches: [] }).content, '{"matches":[]}');
  const canonical = [{ type: 'text', text: 'Caption' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } }];
  assert.deepEqual(formatToolResult(canonical).content, canonical);
  assert.deepEqual(formatToolResult(formatToolResult(canonical).content).content, canonical);
  assert.ok(!formatToolResult({ base64: 'A'.repeat(500000) }).content.includes('A'.repeat(100)), 'untyped large encoded output is safely omitted');
});

test('sanitizer repairs legacy encoded tool results without losing call IDs', () => {
  const history = [system, { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: png }] }) },
    { role: 'tool', tool_call_id: 'b', content: 'Second result' }];
  const messages = sanitizeChatMessages(history);
  assert.equal(messages[2].tool_call_id, 'a');
  assert.equal(messages[2].content[1].type, 'image_url');
  assertNoImageText(messages[2].content);
  const fallback = moveToolImagesToUser(messages);
  assert.deepEqual(fallback.map(message => message.role), ['system', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(fallback[3].content, 'Second result');
  assert.equal(fallback[4].content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(typeof history[2].content, 'string', 'input history is not mutated');
});

test('large MCP images reach tool-role image parts without inflating text or execution steps', async () => {
  const requests = [], steps = [];
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'vision', messages: [system], chatTools: tools,
    executeTool: async () => JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: png }] }),
    onExecutionSteps: value => steps.push(value),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return requests.length === 1 ? Response.json({ choices: [{ message: { tool_calls: [call('a')] }, finish_reason: 'tool_calls' }] }) : resultResponse();
    },
  });
  const tool = requests[1].messages.at(-1);
  assert.equal(tool.role, 'tool'); assert.equal(tool.tool_call_id, 'a');
  assert.equal(tool.content[1].image_url.url, `data:image/png;base64,${png}`);
  assertNoImageText(tool.content);
  assert.ok(tool.content[0].text.length < 1000);
  assert.ok(!JSON.stringify(steps).includes(png));
});

test('backend rejection retries once with hidden user images after the full batch, without rerunning tools', async () => {
  const requests = []; let executions = 0;
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'vision', messages: [system], chatTools: tools,
    executeTool: async ({ name }) => { executions++; return name === 'plain_tool' ? 'text result' : { mimeType: 'image/jpeg', data: jpeg }; },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (requests.length === 1) return Response.json({ choices: [{ message: { tool_calls: [call('a'), call('b', 'plain_tool')] }, finish_reason: 'tool_calls' }] });
      if (requests.length === 2) return new Response('tool content must be a string, not an array', { status: 400 });
      if (requests.length === 3) return Response.json({ choices: [{ message: { tool_calls: [call('c', 'take_screenshot')] }, finish_reason: 'tool_calls' }] });
      return resultResponse();
    },
  });
  assert.equal(executions, 3); assert.equal(requests.length, 4);
  assert.ok(Array.isArray(requests[1].messages[2].content));
  for (const body of requests.slice(2)) {
    const messages = body.messages;
    assert.ok(messages.filter(message => message.role === 'tool').every(message => typeof message.content === 'string'));
    messages.forEach(message => assertNoImageText(message.content));
    assert.equal(messages[3].tool_call_id, 'b');
    assert.equal(messages[4].role, 'user');
    assert.equal(messages[4].content.filter(part => part.type === 'image_url').length, 1);
  }
  assert.equal(requests[3].messages.at(-1).role, 'user');
});

test('unrelated failures do not trigger retries and diagnostics redact image bytes', async (t) => {
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  let calls = 0;
  await assert.rejects(runMemoryChat({ baseUrl: 'http://local', modelId: 'vision', messages: [system,
    { role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: { mimeType: 'image/png', data: png } }],
    fetchImpl: async () => { calls++; return new Response('Context exceeds the token limit', { status: 400 }); },
  }), /HTTP 400/);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(logs).includes(png));
  assert.equal(redactToolMedia('A plain server error'), 'A plain server error');
});

test('compatibility retry stops after one rejection and respects cancellation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const messages = [system, { role: 'assistant', tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: { mimeType: 'image/png', data: png } }];
  let attempts = 0;
  await assert.rejects(runMemoryChat({ baseUrl: 'http://local', modelId: 'vision', messages,
    fetchImpl: async () => { attempts++; return new Response('Jinja template: content must be a string', { status: 500 }); },
  }), /HTTP 500/);
  assert.equal(attempts, 2);
  const controller = new AbortController(); attempts = 0;
  await assert.rejects(runMemoryChat({ baseUrl: 'http://local', modelId: 'vision', messages, signal: controller.signal,
    fetchImpl: async () => { attempts++; controller.abort(); return new Response('tool content must be a string', { status: 400 }); },
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
