import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FIND_MARKS } from '../src/lib/chatFind.mjs';
import { findMessageMatches, messageSearchText, resolveActiveMatchIndex } from '../src/lib/chatSearch.mjs';
import {
  SEARCH_CONTEXT_MESSAGES,
  countConversationMessages,
  hasConversationInRange,
  indexOfMessage,
  selectTranscriptWindowAround,
} from '../src/lib/transcriptWindow.mjs';

const conversation = (length, { startId = 1 } = {}) =>
  Array.from({ length }, (_, index) => ({
    id: startId + index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
  }));

test('canonical search finds a match that only exists outside the rendered window', () => {
  const messages = conversation(100);
  messages[4].content = 'unique-needle lives here';
  const matches = findMessageMatches(messages, 'unique-needle');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].messageId, 5);
  assert.equal(matches[0].occurrence, 0);
  // The rendered window (Phase 2) starts at message 86; the hit is far older.
  assert.ok(matches[0].messageId < 86);
});

test('matches are ordered by message then occurrence, case-insensitively', () => {
  const messages = [
    { id: 1, role: 'user', content: 'Alpha alpha' },
    { id: 2, role: 'assistant', content: 'nothing' },
    { id: 3, role: 'user', content: 'ALPHA' },
  ];
  const matches = findMessageMatches(messages, 'alpha');
  assert.deepEqual(
    matches.map((match) => [match.messageId, match.occurrence, match.index]),
    [
      [1, 0, 0],
      [1, 1, 6],
      [3, 0, 0],
    ],
  );
  assert.ok(matches.every((match) => match.length === 5));
});

test('searchable text covers content, thinking, tool calls, steps, and attachments', () => {
  const message = {
    id: 7,
    role: 'assistant',
    content: 'body-text',
    thinkingText: 'reasoning-text',
    attachments: [{ name: 'report.pdf' }],
    toolCalls: [{ toolName: 'web_search', arguments: { query: 'needle-query' }, result: { text: 'result-text' } }],
    executionSteps: [{ type: 'thought', content: 'step-content' }],
  };
  const text = messageSearchText(message);
  for (const fragment of [
    'body-text',
    'reasoning-text',
    'report.pdf',
    'web_search',
    'needle-query',
    'result-text',
    'step-content',
  ]) {
    assert.ok(text.includes(fragment), `expected searchable text to include ${fragment}`);
    assert.equal(findMessageMatches([message], fragment).length, 1, fragment);
  }
});

test('the active reply variant is what gets searched', () => {
  const message = {
    id: 9,
    role: 'assistant',
    active_variant_index: 1,
    variants: [
      { content: 'first-variant-token' },
      { content: 'second-variant-token' },
    ],
  };
  assert.equal(findMessageMatches([message], 'second-variant-token').length, 1);
  assert.equal(findMessageMatches([message], 'first-variant-token').length, 0);
});

test('empty queries, non-arrays, and role-less records degrade safely', () => {
  assert.deepEqual(findMessageMatches(conversation(5), '   '), []);
  assert.deepEqual(findMessageMatches(null, 'x'), []);
  assert.deepEqual(findMessageMatches([null, 'text'], 'x'), []);
  assert.equal(messageSearchText(null), '');
  assert.equal(messageSearchText({ id: 1, role: 'user', content: 42 }), '');
});

test('results are capped at MAX_FIND_MARKS', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    role: 'user',
    content: 'x'.repeat(60),
  }));
  const matches = findMessageMatches(messages, 'x');
  assert.equal(matches.length, MAX_FIND_MARKS);
  assert.equal(MAX_FIND_MARKS, 500);
});

test('a bounded window around an old target never mounts the intervening history', () => {
  const messages = conversation(600);
  const window = selectTranscriptWindowAround(messages, 20);
  assert.equal(window.found, true);
  // 8 context messages on each side plus the target itself.
  assert.equal(window.messages.length, SEARCH_CONTEXT_MESSAGES * 2 + 1);
  assert.equal(window.messages[0].id, 12);
  assert.equal(window.messages.at(-1).id, 28);
  assert.equal(window.hasOlder, true);
  assert.equal(window.hasNewer, true);
  // Even for the oldest message the window stays bounded.
  const oldest = selectTranscriptWindowAround(messages, 1);
  assert.equal(oldest.messages.length, SEARCH_CONTEXT_MESSAGES + 1);
  assert.equal(oldest.hasOlder, false);
  assert.equal(oldest.hasNewer, true);
  // And for the newest message there is nothing newer.
  const newest = selectTranscriptWindowAround(messages, 600);
  assert.equal(newest.messages.at(-1).id, 600);
  assert.equal(newest.hasNewer, false);
});

test('an unknown target degrades to a safe window instead of throwing', () => {
  const messages = conversation(10);
  const window = selectTranscriptWindowAround(messages, 999);
  assert.equal(window.found, false);
  assert.equal(window.messages.length, 10);
  assert.equal(window.hasOlder, false);
});

test('the active result is tracked by identity and never stale', () => {
  const matches = [
    { messageId: 5, occurrence: 0 },
    { messageId: 55, occurrence: 0 },
    { messageId: 55, occurrence: 1 },
    { messageId: 105, occurrence: 0 },
  ];
  // Identity wins over the fallback index.
  assert.equal(resolveActiveMatchIndex(matches, { messageId: 105, occurrence: 0 }, 0), 3);
  assert.equal(resolveActiveMatchIndex(matches, { messageId: 55, occurrence: 1 }, 3), 2);
  // The tracked result disappeared (edited/deleted/regenerated): fall back to a
  // clamped, in-range index instead of a stale position.
  assert.equal(resolveActiveMatchIndex(matches, { messageId: 999, occurrence: 0 }, 1), 1);
  assert.equal(resolveActiveMatchIndex(matches, { messageId: 999, occurrence: 9 }, 99), 3);
  assert.equal(resolveActiveMatchIndex(matches, null, -4), 0);
  assert.equal(resolveActiveMatchIndex([], { messageId: 1, occurrence: 0 }, 7), 0);
});

test('window helpers locate messages and count ranges', () => {
  const messages = [
    { id: 1, role: 'system' },
    { id: 2, role: 'user' },
    { id: 3, role: 'assistant' },
    { id: 4, role: 'tool' },
  ];
  assert.equal(indexOfMessage(messages, 3), 2);
  assert.equal(indexOfMessage(messages, 99), -1);
  assert.equal(indexOfMessage(null, 1), -1);
  assert.equal(hasConversationInRange(messages, 0, 2), true);
  assert.equal(hasConversationInRange(messages, 0, 1), false);
  assert.equal(countConversationMessages(messages), 2);
  assert.equal(countConversationMessages(messages, 2, 4), 1);
});
