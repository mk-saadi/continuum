const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { localEngineFetch } = require('../src/main/localEngineFetch');

test('local completion waits for headers and first data, and remains cancellable', async t => {
  let sendHeaders;
  const requested = new Promise(resolve => { sendHeaders = resolve; });
  const server = http.createServer((req, res) => sendHeaders(res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const pending = localEngineFetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', body: '{}', signal: controller.signal,
  });
  const res = await requested;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  const response = await pending;
  const reader = response.body.getReader();
  const first = reader.read();
  res.write('data: {"choices":[]}\n\n');
  assert.match(new TextDecoder().decode((await first).value), /choices/);
  const next = reader.read();
  controller.abort();
  await assert.rejects(next, { name: 'AbortError' });
});

test('startup prefill has no elapsed-time cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createStartupHandler } = require('../src/main/engineManager');
  const statuses = [];
  let signal, finish;
  const handler = createStartupHandler({ getTools: async () => [],
    onStatus: status => statuses.push(status),
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
    },
  });
  handler.onOutput('model loaded\nlistening');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(600_000);
  assert.equal(signal.aborted, false);
  assert.deepEqual(statuses, ['warming']);
  finish({ choices: [{ message: { content: '' } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, ['warming', 'ready']);
});

test('production local transport counts formatted requests and permits only one reduced overflow retry', async t => {
  let attempts = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = body && JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/props') return res.end(JSON.stringify({ model_path: 'local', chat_template: 'template', default_generation_settings: { n_ctx: 8192 } }));
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: JSON.stringify(payload) }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: Array(100).fill(1) }));
    assert.equal(req.url, '/v1/chat/completions');
    attempts++;
    if (attempts === 1) { res.statusCode = 400; return res.end(JSON.stringify({ error: { type: 'exceed_context_size_error', n_ctx: 8192, n_prompt_tokens: 8619 } })); }
    assert.equal(payload.messages[0].content, 'reduced summary');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let compactions = 0;
  const response = await localEngineFetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'old prompt' }], max_tokens: 512 }),
    contextWindowLimit: 8192,
    contextRecovery: async () => { compactions++; return { messages: [{ role: 'user', content: 'reduced summary' }], max_tokens: 512 }; },
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(compactions, 1); assert.equal(attempts, 2);
});
