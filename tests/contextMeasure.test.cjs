'use strict';
// Standalone measurer: merged system messages, strict-template constraints,
// empty chats, and labeled fallbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPromptMeasurer } = require('../src/main/contextBudget');
const { mergeSystemMessages } = require('../src/lib/systemMessages.cjs');

test('merge helper collapses system turns and preserves order', () => {
  const messages = [
    { role: 'system', content: 'base' },
    { role: 'system', content: 'session' },
    { role: 'user', content: 'hi' },
  ];
  assert.deepEqual(mergeSystemMessages(messages), [
    { role: 'system', content: 'base\n\nsession' },
    { role: 'user', content: 'hi' },
  ]);
  const single = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(mergeSystemMessages(single), single);
});

// Strict backend: single leading system turn + user message required, tools
// must be rendered, like the local Qwen template.
function strictBackend({ promptTokens = 100 } = {}) {
  return async (href, options = {}) => {
    const url = String(href);
    if (url.endsWith('/props')) return Response.json({ model_path: 'm', chat_template: 'strict',
      default_generation_settings: { n_ctx: 8192 } });
    if (url.endsWith('/apply-template')) {
      const payload = JSON.parse(options.body);
      const systems = payload.messages.filter(m => m.role === 'system');
      if (systems.length !== 1) return new Response(`{"error":{"message":"System message must be at the beginning"}}`, { status: 500 });
      if (!payload.messages.some(m => m.role === 'user')) return new Response(`{"error":{"message":"No user query found in messages."}}`, { status: 500 });
      return Response.json({ prompt: `RENDERED:${payload.tools.map(t => `${t.function.name}:${t.function.description}:${JSON.stringify(t.function.parameters)}`).join('|')}:${JSON.stringify(payload.messages)}` });
    }
    if (url.endsWith('/tokenize')) {
      const { content } = JSON.parse(options.body);
      return Response.json({ tokens: new Array(promptTokens + content.length % 7).fill(1) });
    }
    throw new Error(`unexpected route ${url}`);
  };
}

const tools = [{ type: 'function', function: { name: 'read', description: 'read things', parameters: { type: 'object' } } }];

test('multi-system prompts are merged before template rendering', async () => {
  const measure = createPromptMeasurer(strictBackend());
  const result = await measure('http://x/v1/chat/completions',
    { model: 'm', messages: [{ role: 'system', content: 'base' }, { role: 'system', content: 'session' }, { role: 'user', content: 'go' }], tools },
    { contextWindowLimit: 8192 });
  assert.equal(result.method, 'server-template-tokenizer');
  assert.ok(result.tokens > 100);
});

test('empty initial chats fall back with an explicit reason, not silence', async () => {
  const measure = createPromptMeasurer(strictBackend());
  const result = await measure('http://x/v1/chat/completions',
    { model: 'm', messages: [{ role: 'system', content: 'base' }, { role: 'system', content: 'session' }], tools },
    { contextWindowLimit: 8192 });
  assert.equal(result.method, 'approximate-full-request');
  assert.equal(result.note, 'no-user-message');
  assert.ok(result.tokens > 0);
});

test('tool-ignoring templates are labeled instead of miscounted', async () => {
  const fetchImpl = async (href, options = {}) => {
    const url = String(href);
    if (url.endsWith('/props')) return Response.json({ model_path: 'm', chat_template: 't', default_generation_settings: { n_ctx: 8192 } });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: 'message-only template without schemas' });
    if (url.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
    throw new Error(url);
  };
  const result = await createPromptMeasurer(fetchImpl)('http://x/v1/chat/completions',
    { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools },
    { contextWindowLimit: 8192 });
  assert.equal(result.method, 'approximate-full-request');
  assert.equal(result.note, 'tools-absent-from-template');
});

test('unreachable backends degrade without throwing', async () => {
  const result = await createPromptMeasurer(async () => { throw new Error('refused'); })('http://x/v1/chat/completions',
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    { contextWindowLimit: 8192 });
  assert.equal(result.method, 'approximate-full-request');
  assert.equal(result.note, 'tokenizer-measurement-failed');
});

test('abort still aborts instead of degrading', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createPromptMeasurer(strictBackend())('http://x/v1/chat/completions',
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    { signal: controller.signal, contextWindowLimit: 8192 }), { name: 'AbortError' });
});
