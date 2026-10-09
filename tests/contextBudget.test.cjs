const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextGuardedFetch, isContextOverflow } = require('../src/main/contextBudget');
const { backend, overflow } = require('./fixtures/contextBackend.cjs');
const payload = { model: 'loaded', messages: [{ role: 'system', content: 'instructions and skills' }, { role: 'user', content: 'expanded attachment' }], tools: [{ type: 'function', function: { name: 'read', description: 'tool schema', parameters: { type: 'object' } } }] };
const send = (b, body = payload, extra = {}) => b.fetch('http://localhost/v1/chat/completions', { method: 'POST', body: JSON.stringify(body), contextWindowLimit: 8192, ...extra });

test('assembled system, schemas and attachments enter template counting and output reserve', async () => {
  const b = backend({ tokens: text => { assert.match(text, /instructions and skills/); assert.match(text, /expanded attachment/); assert.match(text, /tool schema/); return 7500; } });
  await assert.rejects(send(b), /cannot fit/);
  assert.equal(b.calls.length, 0); // 7500 input fits raw context but not its reserved output.
});
test('fallback counts the complete request and fails safely when mandatory content is too large', async () => {
  const b = backend({ available: false });
  await assert.rejects(send(b, { ...payload, messages: [{ role: 'system', content: 'x'.repeat(40000) }] }), /Required instructions/);
  assert.equal(b.calls.length, 0);
});
test('backend overflow applies one rebuilt retry, including current schemas', async () => {
  let recoveries = 0;
  const b = backend({ infer: (_payload, attempt) => attempt === 1 ? overflow() : Response.json({ ok: true }) });
  const response = await send(b, payload, { contextRecovery: async () => { recoveries++; return { ...payload, messages: [{ role: 'system', content: 'summary and current instructions' }], tools: [] }; } });
  assert.equal(response.status, 200); assert.equal(recoveries, 1); assert.equal(b.calls.length, 2);
  assert.equal(b.calls[1].messages[0].content, 'summary and current instructions');
});
test('second overflow does not trigger a third request or another compaction', async () => {
  let recoveries = 0; const b = backend({ infer: overflow });
  await assert.rejects(send(b, payload, { contextRecovery: async () => { recoveries++; return { ...payload, messages: [{ role: 'user', content: 'reduced' }] }; } }), /single recovery retry/);
  assert.equal(b.calls.length, 2); assert.equal(recoveries, 1);
});
test('unchanged recovery is never resubmitted', async () => {
  const b = backend({ infer: overflow });
  await assert.rejects(send(b, payload, { contextRecovery: async () => payload }), /did not reduce/);
  assert.equal(b.calls.length, 1);
});
test('ordinary 400, transport failures and cancellation never cause compaction', async () => {
  let recoveries = 0;
  const recovery = async () => { recoveries++; return payload; };
  const b = backend({ infer: () => new Response('{"error":{"message":"invalid sampling parameter"}}', { status: 400 }) });
  assert.equal((await send(b, payload, { contextRecovery: recovery })).status, 400);
  const network = backend({ infer: () => { throw new Error('network'); } });
  await assert.rejects(send(network, payload, { contextRecovery: recovery }), /network/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(send(b, payload, { signal: controller.signal, contextRecovery: recovery }), { name: 'AbortError' });
  assert.equal(recoveries, 0); assert.equal(isContextOverflow({ status: 400, responseBody: 'invalid' }), false);
});
test('safe cached counts are reused but tools/template changes invalidate them', async () => {
  const b = backend(); await send(b); await send(b);
  assert.equal(b.probes.filter(p => p === '/tokenize').length, 1);
  await send(b, { ...payload, tools: [] });
  assert.equal(b.probes.filter(p => p === '/tokenize').length, 2);
  b.setTemplate('changed template'); await send(b);
  assert.equal(b.probes.filter(p => p === '/tokenize').length, 3);
});
test('rebuilt request is rechecked and a scheduled acknowledgement is not completion', async () => {
  const b = backend({ tokens: text => text.includes('expanded attachment') ? 8000 : 100 });
  await assert.rejects(send(b, payload, { contextRecovery: async () => ({ scheduled: true }) }), /cannot fit/);
  assert.equal(b.calls.length, 0);
});
test('normalization merges system instructions before counting and dispatch', async () => {
  const b = backend(); await send(b, { ...payload, messages: [{ role: 'system', content: 'base' }, { role: 'system', content: 'skill' }, { role: 'user', content: 'request' }] });
  assert.equal(b.calls[0].messages[0].content, 'base\n\nskill');
  assert.equal(b.calls[0].messages.filter(m => m.role === 'system').length, 1);
});

test('server slot limit wins over a larger configured limit', async () => {
  const b = backend({ context: 4096, tokens: 3500 });
  await assert.rejects(send(b), /budget 3031/);
  assert.equal(b.calls.length, 0);
});
test('a message-only template cannot pretend to count tool schemas', async () => {
  const b = backend({ omitTools: true });
  await assert.rejects(send(b, { ...payload, tools: [{ type: 'function', function: { name: 'read', description: 'x'.repeat(40000), parameters: {} } }] }), /approximate-full-request/);
  assert.equal(b.calls.length, 0); assert.ok(!b.probes.includes('/tokenize'));
});

test('failed summary preserves the actionable context error and never retries inference', async () => {
  const b = backend({ infer: overflow });
  await assert.rejects(send(b, payload, { contextRecovery: async () => { throw new Error('summary unavailable'); } }), /summary unavailable.*Required instructions/);
  assert.equal(b.calls.length, 1);
});

test('multimodal requests retain images and use the documented approximate allowance', async () => {
  const b = backend();
  const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,unchanged' } };
  await send(b, { ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, image] }] });
  assert.ok(!b.probes.includes('/tokenize'));
  assert.deepEqual(b.calls[0].messages[0].content[1], image);
});
