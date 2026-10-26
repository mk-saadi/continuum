'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPromptMeasurer } = require('../src/main/contextBudget');
const request = { messages: [{ role: 'user', content: 'fixture' }], max_tokens: 1024 };
test('transient estimate expires; exact cache and concurrent counts remain reusable', async () => {
  let broken = true, tokenizations = 0;
  const measure = createPromptMeasurer(async url => {
    if (url.endsWith('/props')) return Response.json({ model_path: 'fixture', chat_template: 'fixture', default_generation_settings: { n_ctx: 8192 } });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: 'fixture' });
    tokenizations++;
    return broken ? new Response('', { status: 503 }) : Response.json({ tokens: [1, 2, 3] });
  });
  const url = 'http://fixture/v1/chat/completions';
  const first = await measure(url, request); assert.equal(first.method, 'approximate-full-request'); assert.equal(first.measurementStatus, 'temporarily-unavailable'); assert.equal(first.limit, 8192);
  broken = false;
  await new Promise(resolve => setTimeout(resolve, 600));
  await measure(url, request); assert.equal(tokenizations, 1);
  // A read inside the cooldown must not extend the expiry indefinitely.
  await new Promise(resolve => setTimeout(resolve, 600));
  const results = await Promise.all([measure(url, request), measure(url, request), measure(url, request)]);
  assert.ok(results.every(r => r.tokens === 3 && r.method === 'server-template-tokenizer')); assert.equal(tokenizations, 2);
  await measure(url, request); assert.equal(tokenizations, 2);
});
