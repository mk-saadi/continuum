import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_VISIBLE_MESSAGES,
  OLDER_MESSAGES_PAGE_SIZE,
  effectiveVisibleCount,
  isConversationMessage,
  selectTranscriptWindow,
} from '../src/lib/transcriptWindow.mjs';

const conversation = (length, { startId = 1 } = {}) =>
  Array.from({ length }, (_, index) => ({
    id: startId + index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }));

const eligibleCount = (window) => window.filter(isConversationMessage).length;

test('initial window mounts only the newest page and never mutates the canonical array', () => {
  const all = conversation(100);
  const snapshot = all.map((message) => message.id);
  const { start, messages, hasOlder } = selectTranscriptWindow(all, INITIAL_VISIBLE_MESSAGES);

  assert.equal(INITIAL_VISIBLE_MESSAGES, 15);
  assert.equal(messages.length, 15);
  assert.equal(eligibleCount(messages), 15);
  assert.equal(start, 85);
  assert.equal(hasOlder, true);
  // Chronological order preserved.
  assert.deepEqual(messages.map((message) => message.id), snapshot.slice(85));
  // The canonical collection is untouched (same length, same ids, same objects).
  assert.equal(all.length, 100);
  assert.deepEqual(all.map((message) => message.id), snapshot);
  // The window references the canonical records instead of cloning them.
  assert.equal(messages[0], all[85]);
  assert.equal(messages.at(-1), all.at(-1));
});

test('progressively revealing older pages prepends exactly the previous page', () => {
  const all = conversation(100);
  const seen = [];
  let count = INITIAL_VISIBLE_MESSAGES;
  let window = selectTranscriptWindow(all, count);
  seen.push(window.messages.map((message) => message.id));

  while (window.hasOlder) {
    const previousFirst = window.messages[0].id;
    count += OLDER_MESSAGES_PAGE_SIZE;
    window = selectTranscriptWindow(all, count);
    const ids = window.messages.map((message) => message.id);
    seen.push(ids);
    // Every occurrence is a strict superset of the previous one: older messages
    // are prepended, none of the previously visible ones are dropped.
    const previous = seen[seen.length - 2];
    assert.deepEqual(ids.slice(ids.length - previous.length), previous);
    // No duplicates within a rendered window.
    assert.equal(new Set(ids).size, ids.length);
    // The message that used to be first is still present, now lower in the list.
    assert.ok(ids.indexOf(previousFirst) > 0);
  }

  const finalIds = seen.at(-1);
  assert.equal(finalIds.length, 100);
  assert.deepEqual(finalIds, all.map((message) => message.id));
  assert.equal(selectTranscriptWindow(all, 200).hasOlder, false);
});

test('pagination terminates once the oldest conversation message is rendered', () => {
  const all = conversation(30);
  assert.equal(selectTranscriptWindow(all, 15).hasOlder, true);
  const revealed = selectTranscriptWindow(all, 30);
  assert.equal(revealed.messages.length, 30);
  assert.equal(revealed.hasOlder, false);
  // Asking for more than exists is a no-op, not an error.
  const over = selectTranscriptWindow(all, 999);
  assert.equal(over.messages.length, 30);
  assert.equal(over.hasOlder, false);
});

test('conversations shorter than the page render every available message', () => {
  for (const length of [0, 1, 5, 14]) {
    const all = conversation(length);
    const { messages, hasOlder, start } = selectTranscriptWindow(all, INITIAL_VISIBLE_MESSAGES);
    assert.equal(messages.length, length, `length ${length}`);
    assert.equal(hasOlder, false, `length ${length}`);
    assert.equal(start, 0, `length ${length}`);
  }
  const exact = conversation(15);
  const window = selectTranscriptWindow(exact, 15);
  assert.equal(window.messages.length, 15);
  assert.equal(window.hasOlder, false);
  // One more eligible message turns the page into a paginated window.
  assert.equal(selectTranscriptWindow(conversation(16), 15).hasOlder, true);
});

test('only user/assistant messages count and interleaved records are preserved', () => {
  const all = [
    { id: 1, role: 'system', content: 'internal' },
    { id: 2, role: 'user', content: 'u2' },
    { id: 3, role: 'assistant', content: 'a3' },
    { id: 4, role: 'system', content: 'internal' },
    { id: 5, role: 'user', content: 'u5' },
    { id: 6, role: 'assistant', content: 'a6' },
  ];
  const window = selectTranscriptWindow(all, 3);
  // Newest 3 eligible messages are 3, 5 and 6; the window starts at id 3 and
  // keeps the system record interleaved between them.
  assert.equal(window.messages[0].id, 3);
  assert.deepEqual(window.messages.map((message) => message.id), [3, 4, 5, 6]);
  // The system record interleaved inside the window stays; the one before the
  // window does not leak in.
  assert.ok(window.messages.some((message) => message.role === 'system' && message.id === 4));
  assert.ok(!window.messages.some((message) => message.id === 1));
  // An older eligible message exists before the window (id 2).
  assert.equal(window.hasOlder, true);
  // A trailing system record with no older eligible message does not count.
  const trailing = selectTranscriptWindow([{ id: 1, role: 'assistant' }, { id: 2, role: 'system' }], 15);
  assert.equal(trailing.hasOlder, false);
});

test('isConversationMessage recognizes only top-level user/assistant records', () => {
  assert.equal(isConversationMessage({ role: 'user' }), true);
  assert.equal(isConversationMessage({ role: 'assistant' }), true);
  assert.equal(isConversationMessage({ role: 'system' }), false);
  assert.equal(isConversationMessage({ role: 'tool' }), false);
  assert.equal(isConversationMessage(null), false);
  assert.equal(isConversationMessage('user'), false);
});

test('window size is scoped to the active session so history never leaks across chats', () => {
  const state = { sessionId: 'chat-a', count: 60 };
  assert.equal(effectiveVisibleCount(state, 'chat-a'), 60);
  // A different (or as-yet-unloaded) conversation starts at the initial page.
  assert.equal(effectiveVisibleCount(state, 'chat-b'), INITIAL_VISIBLE_MESSAGES);
  assert.equal(effectiveVisibleCount(state, undefined), INITIAL_VISIBLE_MESSAGES);
  assert.equal(effectiveVisibleCount(undefined, 'chat-a'), INITIAL_VISIBLE_MESSAGES);
  assert.equal(effectiveVisibleCount({ sessionId: 'chat-a', count: 0 }, 'chat-a'), INITIAL_VISIBLE_MESSAGES);
});

test('non-array and empty inputs degrade safely', () => {
  assert.deepEqual(selectTranscriptWindow(null, 15), { start: 0, messages: [], hasOlder: false });
  assert.deepEqual(selectTranscriptWindow([], 15), { start: 0, messages: [], hasOlder: false });
  const records = [{ role: 'system' }, { role: 'tool' }];
  const window = selectTranscriptWindow(records, 15);
  assert.equal(window.hasOlder, false);
  assert.equal(window.messages, records);
});
