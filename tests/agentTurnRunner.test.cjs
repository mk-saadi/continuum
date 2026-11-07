'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerChatTurnHandler, runAgentTurn, createHeadlessAdapter } = require('../src/main/agentTurnRunner');

test('the headless adapter has no renderer but records outbound events', () => {
  const events = [];
  const { sender, notify, emitActivity } = createHeadlessAdapter({ onEvent: event => events.push(event) });
  assert.equal(sender.isDestroyed(), false);
  notify({ type: 'text', delta: 'hi' });
  sender.send('engine:stream-status', { status: 'generating' });
  emitActivity({ phase: 'compaction' });
  assert.deepEqual(events, [
    { channel: 'notify', payload: { type: 'text', delta: 'hi' } },
    { channel: 'engine:stream-status', payload: { status: 'generating' } },
    { channel: 'activity', payload: { phase: 'compaction' } },
  ]);
});

test('a turn runs through the registered handler and forwards its events', async () => {
  const events = [];
  registerChatTurnHandler(async (request, notify, sender) => {
    notify({ type: 'text', delta: 'hello' });
    sender.send('engine:stream-status', { status: 'idle' });
    return { text: 'hello', requestId: request.requestId };
  });
  const result = await runAgentTurn({ requestId: 'turn-1' }, { onEvent: event => events.push(event) });
  assert.deepEqual(result, { text: 'hello', requestId: 'turn-1' });
  assert.equal(events.some(event => event.channel === 'notify' && event.payload.type === 'text'), true);
  assert.equal(events.some(event => event.channel === 'engine:stream-status'), true);
});

test('an abort signal cancels the turn through the existing destroyed path', async () => {
  let aborted = false;
  registerChatTurnHandler((request, notify, sender) => new Promise(resolve => {
    sender.once('destroyed', () => { aborted = true; resolve({ aborted: true }); });
  }));
  const controller = new AbortController();
  const running = runAgentTurn({ requestId: 'turn-2' }, { signal: controller.signal });
  controller.abort();
  const result = await running;
  assert.equal(aborted, true);
  assert.deepEqual(result, { aborted: true });
});

test('an already-aborted signal never starts a turn', async () => {
  let called = false;
  registerChatTurnHandler(() => { called = true; return {}; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAgentTurn({ requestId: 'turn-3' }, { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(called, false);
});

test('an unregistered runner fails clearly instead of silently doing nothing', async () => {
  const unregister = registerChatTurnHandler(async () => ({}));
  unregister();
  await assert.rejects(runAgentTurn({ requestId: 'turn-4' }), { code: 'AGENT_RUNNER_UNAVAILABLE' });
});
