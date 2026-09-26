const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStartupHandler } = require('../src/main/engineManager');
const { BASE_SYSTEM_PROMPT_WITH_TOOLS, prependBaseSystemPrompt } = require('../src/main/baseSystemPrompt');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('split startup logs trigger one authenticated warmup; readiness waits for completion', async () => {
  const statuses = [], requests = [];
  let finish;
  const tools = [{ type: 'function', function: { name: 'example' } }];
  const handler = createStartupHandler({ port: 9090, apiKey: 'secret', getTools: async () => tools,
    onStatus: value => statuses.push(value), fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
    } });
  handler.onOutput('model loa', 'stderr');
  handler.onOutput('ded\n', 'stderr');
  await tick();
  assert.equal(requests.length, 0);
  handler.onOutput('server is listening on 127.0.0.1:9090', 'stdout');
  handler.onOutput('model loaded and listening', 'stderr');
  await tick();
  assert.deepEqual(statuses, ['warming']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:9090/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer secret');
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(payload.messages, [{ role: 'system', content: BASE_SYSTEM_PROMPT_WITH_TOOLS }, { role: 'user', content: 'Warmup sequence initialized.' }]);
  assert.deepEqual(payload.tools, tools);
  assert.equal(payload.max_tokens, 1);
  assert.equal(payload.cache_prompt, true);
  finish({ choices: [{ message: { content: '' } }] });
  await tick();
  assert.deepEqual(statuses, ['warming', 'ready']);
});

test('failed warmup reports failure; cancelled warmup cannot report ready', async () => {
  const statuses = [];
  const failed = createStartupHandler({ getTools: async () => [], onStatus: value => statuses.push(value),
    fetchImpl: async () => ({ ok: false, status: 500 }) });
  failed.onOutput('model loaded\nlistening');
  await tick();
  assert.deepEqual(statuses, ['warming', 'warmup-failed']);
  let finish;
  const cancelled = createStartupHandler({ getTools: async () => [], onStatus: value => statuses.push(value),
    fetchImpl: async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) }) });
  cancelled.onOutput('model loaded\nlistening');
  await tick();
  cancelled.cancel();
  finish({ choices: [{ message: {} }] });
  await tick();
  assert.deepEqual(statuses, ['warming', 'warmup-failed', 'warming']);
});

test('prefix alignment preserves dynamic context without duplicating the base', () => {
  const messages = [{ role: 'system', content: 'Session memory' }, { role: 'user', content: 'Hello' }];
  const aligned = prependBaseSystemPrompt(messages);
  assert.equal(aligned[0].content, BASE_SYSTEM_PROMPT_WITH_TOOLS);
  assert.deepEqual(aligned.slice(1), messages);
  assert.deepEqual(prependBaseSystemPrompt(aligned), aligned);
});
