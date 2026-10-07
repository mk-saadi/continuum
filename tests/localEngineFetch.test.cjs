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
