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
