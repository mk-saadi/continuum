const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStreamDispatcher } = require('../src/main/streamDispatcher');

test('batches token events and drains them before a tool event', () => {
  const sent = [];
  const sender = { isDestroyed: () => false, send: (channel, value) => sent.push({ channel, value }) };
  const dispatcher = createStreamDispatcher(sender, 'request', 'session', () => true);
  for (let index = 0; index < 1000; index++) dispatcher.dispatch({ type: 'text', delta: 'x' });
  dispatcher.dispatch({ type: 'tool', id: 'tool-1' });
  dispatcher.close();
  const events = sent.filter(item => item.channel === 'engine:chat-event').map(item => item.value);
  assert.equal(events.length, 2);
  assert.equal(events[0].delta.length, 1000);
  assert.equal(events[1].type, 'tool');
  assert.equal(sent.filter(item => item.channel === 'engine:stream-chunk').length, 1);
});

test('close drains a partial stream and does not send to a destroyed renderer', () => {
  const sent = [];
  let destroyed = false;
  const sender = { isDestroyed: () => destroyed, send: (...args) => sent.push(args) };
  const dispatcher = createStreamDispatcher(sender, 'request', 'session', () => true);
  dispatcher.dispatch({ type: 'text', delta: 'partial' });
  dispatcher.close();
  assert.equal(sent.find(([channel]) => channel === 'engine:chat-event')[1].delta, 'partial');
  destroyed = true;
  dispatcher.dispatch({ type: 'tool', id: 'late' });
  assert.equal(sent.length, 2);
});
