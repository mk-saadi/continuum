'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGenerationRuntime, generateLocalCandidate, abortCode, reason } = require('../src/main/workspaceGenerationRuntime');
function clock() {
  let now = 0, next = 0; const timers = new Map();
  return { setTimer(fn, delay) { timers.set(++next, { fn, at: now + delay }); return next; }, clearTimer(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, timers };
}
test('progressing local generation and multiple stages exceed 120 seconds without cancellation', () => {
  const time = clock(), runtime = createGenerationRuntime(null, time);
  for (let stage = 0; stage < 4; stage++) for (let token = 0; token < 20; token++) {
    time.advance(30000); runtime.progress(); assert.equal(runtime.signal.aborted, false);
  }
  runtime.dispose(); assert.equal(time.timers.size, 0);
});
for (const code of ['user-cancelled', 'deleted-conversation', 'renderer-destroyed', 'ipc-disposed']) test(`abort preserves ${code}`, () => {
  const owner = new AbortController(), time = clock(), runtime = createGenerationRuntime(owner.signal, time);
  owner.abort(reason(code)); assert.equal(abortCode(runtime.signal), code); runtime.dispose();
});
test('inactivity is bounded and safely distinguished from unknown propagation', () => {
  const time = clock(), runtime = createGenerationRuntime(null, time);
  time.advance(600001); assert.equal(abortCode(runtime.signal), 'generation-inactivity-timeout'); runtime.dispose();
  const owner = new AbortController(); owner.abort(); assert.equal(abortCode(owner.signal), 'unexpected-abort');
});
function transport(events) { return async () => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')); }
test('local SSE retains completion metadata and hidden reasoning progress', async () => {
  let progress = 0;
  const result = await generateLocalCandidate(transport([{ choices: [{ delta: { reasoning_content: 'thinking' } }] }, { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }, { usage: { completion_tokens: 5708 }, choices: [] }, '[DONE]']), 'http://fixture', {}, { onProgress: () => progress++ });
  assert.equal(progress, 2); assert.equal(result.choices[0].message.content, '{}'); assert.equal(result.usage.completion_tokens, 5708);
  assert.equal(result.choices[0].finish_reason, 'stop');
});
test('backend failure and incomplete stream cannot become valid completion', async () => {
  await assert.rejects(generateLocalCandidate(async () => new Response('', { status: 500 }), 'http://fixture', {}, {}), { code: 'provider-error' });
  await assert.rejects(generateLocalCandidate(transport([{ choices: [{ delta: { content: '{}' } }] }]), 'http://fixture', {}, {}), { code: 'incomplete-response' });
});
test('runtime multi-slot metadata preserves safe per-request capacity', async () => {
  const { createPromptMeasurer } = require('../src/main/contextBudget');
  const measured = await createPromptMeasurer(async url => new Response(JSON.stringify(url.endsWith('/props') ? { total_slots: 2, default_generation_settings: { n_ctx: 35072 } } : url.endsWith('/apply-template') ? { prompt: 'fixture' } : { tokens: [1] })) )('http://localhost:1234/v1/chat/completions', { messages: [{ role: 'user', content: 'fixture' }], max_tokens: 1024 }, { contextWindowLimit: 70000 });
  assert.equal(measured.limit, 35072); assert.equal(measured.budget, 33920); assert.equal(measured.budgetContract.runtimeSlots, 2); assert.equal(measured.budgetContract.autoCompactionTriggerTokens, 30528);
});
test('UI explains distinct safe cancellation reasons', async () => {
  const { activityReason } = await import('../src/lib/compactionActivity.mjs');
  const codes = ['user-cancelled', 'deleted-conversation', 'renderer-destroyed', 'ipc-disposed', 'generation-inactivity-timeout', 'unexpected-abort'];
  assert.equal(new Set(codes.map(activityReason)).size, codes.length);
  assert.match(activityReason('generation-inactivity-timeout'), /10 minutes/);
});

test('W7 serialized llama request disables optional thinking, streams usage, and separates reasoning counts', async () => {
  let body;
  const events = [{ choices: [{ delta: { reasoning_content: 'x'.repeat(6000) } }] },
    { choices: [{ delta: { content: '{}' }, finish_reason: 'length' }] },
    { usage: { completion_tokens: 6144 }, choices: [] }, '[DONE]'];
  const result = await generateLocalCandidate(async (url, options) => {
    body = JSON.parse(options.body); return transport(events)();
  }, 'http://fixture/v1/chat/completions', { max_tokens: 6144, chat_template_kwargs: { enable_thinking: false } }, {});
  assert.equal(body.max_tokens, 6144); assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(result.compactionStreamDiagnostics, { reasoningCharacters: 6000, visibleCharacters: 2, doneMarker: true });
  assert.equal(result.choices[0].finish_reason, 'length');
  assert.equal(JSON.stringify(result).includes('xxx'), false);
});

test('W7 interrupted stream with valid JSON and stop still requires DONE', async () => {
  await assert.rejects(generateLocalCandidate(transport([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]), 'http://fixture', {}, {}), { code: 'incomplete-response' });
});

test('W7 early props connection refusals are transport events, never process exits', async () => {
  const { createTrackedFetch } = require('../src/main/localRequestLifecycle');
  const records = []; let calls = 0, active = 0;
  const owner = { unavailable: false, terminated: false, beginRequest: () => { active++; return () => active--; }, record: (event, details) => records.push({ event, ...details }) };
  const fetch = createTrackedFetch(async () => {
    if (++calls <= 2) throw Object.assign(new Error('fixture'), { code: 'ECONNREFUSED' });
    return new Response('{}');
  }, () => owner);
  for (let i = 0; i < 2; i++) await assert.rejects(fetch('http://fixture/props'));
  await (await fetch('http://fixture/props')).text();
  assert.equal(active, 0); assert.equal(records.length, 2);
  assert.ok(records.every(r => r.event === 'server-unavailable' && r.serverTerminated === false));
});

test('W7 long reasoning stream completes after virtual 300 seconds with a renewable lease', async () => {
  const time = clock(), runtime = createGenerationRuntime(null, time); let chunk = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    time.advance(30000);
    assert.equal(runtime.signal.aborted, false);
    const event = chunk++ < 10 ? { choices: [{ delta: { reasoning_content: 'x' } }] }
      : { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }], usage: { completion_tokens: 12 } };
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    if (chunk === 11) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
  } }));
  try {
    const result = await generateLocalCandidate(async () => response, 'http://fixture', {}, { signal: runtime.signal, onProgress: runtime.progress });
    assert.equal(result.choices[0].finish_reason, 'stop'); assert.equal(result.choices[0].message.content, '{}');
    assert.equal(result.compactionStreamDiagnostics.reasoningCharacters, 10); assert.equal(runtime.signal.aborted, false);
  } finally { runtime.dispose(); }
});

test('C6-A schema request reaches llama transport, explicit unsupported schema falls back once', async () => {
  const requests = [];
  const result = await generateLocalCandidate(async (url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return Response.json({ error: { message: 'response_format schema not supported' } }, { status: 400 });
    return transport([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }, '[DONE]'])();
  }, 'http://fixture', { response_format: { type: 'json_object', schema: { type: 'object' } }, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false } }, {});
  assert.equal(requests.length, 2); assert.ok(requests[0].response_format.schema); assert.equal(requests[1].response_format, undefined);
  assert.equal(requests[1].max_tokens, 1024); assert.equal(requests[1].chat_template_kwargs.enable_thinking, false);
  assert.equal(result.structuredOutput, 'prompt-fallback');
});
