import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSounds, createSoundDispatcher, subscribeNotificationSounds } from '../src/lib/notificationSounds.mjs';

function fixture() {
  const listeners = {}, played = [];
  const api = Object.fromEntries(['onEvent', 'onToolApproval', 'onAskUser', 'onToolLimitReached', 'onLoopPaused'].map(name => [name, fn => { listeners[name] = fn; return () => delete listeners[name]; }]));
  const dispatch = createSoundDispatcher(kind => played.push(kind));
  return { listeners, played, api, dispatch, off: subscribeNotificationSounds(api, dispatch) };
}
test('live top-level outcomes, background sessions, deduplication, subagents, cancellation and history', () => {
  const f = fixture();
  // Startup/restoration does not query history or emit a sound.
  assert.deepEqual(f.played, []);
  const event = { type: 'task-outcome', requestId: 'r1', runId: 'run1', sessionId: 'background', outcome: 'completed' };
  f.listeners.onEvent({ ...event, type: 'text' });
  f.listeners.onEvent({ ...event, subagentId: 'child' });
  f.listeners.onEvent({ ...event, parentRunId: 'parent' });
  assert.deepEqual(f.played, []);
  f.listeners.onEvent(event); f.listeners.onEvent(event);
  // Switching tabs has no effect on subscriptions or identity.
  f.listeners.onEvent({ ...event, sessionId: 'other', runId: 'run2', outcome: 'interrupted' });
  f.listeners.onEvent({ ...event, runId: 'run3', outcome: 'cancelled' });
  assert.deepEqual(f.played, ['completed', 'interrupted']);
  f.off(); assert.equal(Object.keys(f.listeners).length, 0);
  subscribeNotificationSounds(f.api, f.dispatch);
  f.listeners.onEvent(event); assert.equal(f.played.length, 2);
});
test('approval, shell permissions, questions and repeated limit pauses alert once per transition', () => {
  const f = fixture(), base = { requestId: 'r', sessionId: 's' };
  for (const [name, identity] of [['onToolApproval', { approvalId: 'a', name: 'shell' }], ['onAskUser', { questionId: 'q' }], ['onToolLimitReached', { currentCount: 10 }], ['onLoopPaused', { executionState: 'paused_turn_limit', pauseId: 'p1' }]]) {
    f.listeners[name]({ ...base, ...identity }); f.listeners[name]({ ...base, ...identity });
    f.listeners[name]({ ...base, ...identity, resolved: true });
  }
  f.listeners.onLoopPaused({ ...base, executionState: 'paused_turn_limit', pauseId: 'p2' });
  assert.deepEqual(f.played, Array(5).fill('inputRequired'));
  f.off();
});
function audio(state = 'running') {
  const oscillators = [], gains = [];
  const context = { state, currentTime: 1, destination: {}, closed: 0,
    async resume() { this.state = 'running'; }, async close() { this.closed++; },
    createOscillator() { const o = { frequency: {}, connect() {}, disconnect() { this.disconnected = true; }, start(t) { this.at = t; }, stop(t) { this.end = t; } }; oscillators.push(o); return o; },
    createGain() { const g = { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; gains.push(g); return g; } };
  return { context, oscillators, gains, service: createNotificationSounds({ getContext: () => context }) };
}
test('three short synthesized patterns, context reuse, gentle envelopes and no overlap', async () => {
  const f = audio();
  for (const [kind, count, ascending] of [['completed', 3, true], ['interrupted', 2, false], ['inputRequired', 2, true]]) {
    const offset = f.oscillators.length;
    assert.equal(await f.service.play(kind), true);
    assert.equal(await f.service.play(kind), false);
    const notes = f.oscillators.slice(offset);
    assert.equal(notes.length, count);
    assert.equal(notes[0].frequency.value < notes[1].frequency.value, ascending);
    assert.ok(notes.at(-1).end - notes[0].at < 0.6);
    notes.forEach(o => o.onended());
  }
  f.service.dispose(); assert.equal(f.context.closed, 1);
});
test('master, individual and volume mute; unavailable and rejected/suspended contexts', async () => {
  const f = audio();
  for (const prefs of [{ enabled: false }, { completed: false }, { volume: 0 }]) {
    f.service.setPrefs(prefs); assert.equal(await f.service.play('completed'), false);
  }
  assert.equal(f.oscillators.length, 0);
  assert.equal(await createNotificationSounds({ getContext() { throw Error('Unavailable'); } }).play('completed'), false);
  const suspended = audio('suspended'); assert.equal(await suspended.service.play('completed'), true);
  const blocked = audio('suspended'); blocked.context.resume = async () => { throw Error('Blocked'); };
  assert.equal(await blocked.service.play('completed'), false);
  const stillSuspended = audio('suspended'); stillSuspended.context.resume = async () => {};
  assert.equal(await stillSuspended.service.play('completed'), false);
});
test('shutdown stops nodes and prevents late suspended playback; unmount can remount', async () => {
  const f = audio(); await f.service.play('completed'); f.service.dispose();
  assert.ok(f.oscillators.every(o => o.disconnected));
  assert.equal(await f.service.play('completed'), false);
  f.service.activate(); assert.equal(await f.service.play('completed'), true);
  const s = audio('suspended'); let resume;
  s.context.resume = () => new Promise(resolve => { resume = resolve; });
  const pending = s.service.play('completed'); s.service.dispose(); resume();
  assert.equal(await pending, false); assert.equal(s.oscillators.length, 0);
});
