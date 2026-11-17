import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMessagePage } from '../src/lib/spotlightMessageSearch.mjs';

test('automatically crosses empty time slices to find old messages in any chat', async () => {
  const cursors = [];
  const pages = [
    { matches: [], cursor: 900 }, { matches: [], cursor: 500 },
    { matches: [{ id: 12, session_id: 'old-chat', excerpt: 'prayer in quran' }], cursor: 100 },
    { matches: [], cursor: null },
  ];
  const result = await searchMessagePage(async input => { cursors.push(input.cursor); return pages.shift(); }, 'prayer in quran');
  assert.deepEqual(cursors, [null, 900, 500, 100]);
  assert.equal(result.matches[0].session_id, 'old-chat');
  assert.equal(result.cursor, null);
});

test('keeps a continuation after a full page and resumes it', async () => {
  const first = await searchMessagePage(async () => ({ matches: [5,4,3,2,1].map(id => ({id})), cursor: 1 }), 'query');
  assert.equal(first.matches.length, 5);
  const next = await searchMessagePage(async input => { assert.equal(input.cursor, 1); return { matches: [], cursor: null }; }, 'query', { cursor: first.cursor });
  assert.equal(next.cursor, null);
});

test('discards obsolete searches without scanning further', async () => {
  let current = true, calls = 0;
  const result = await searchMessagePage(async () => { calls++; current = false; return { matches: [{id:1}], cursor: 1 }; }, 'old query', { isCurrent: () => current });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('reports a stalled cursor rather than looping forever', async () => {
  await assert.rejects(searchMessagePage(async () => ({matches:[], cursor: 5}), 'query', {cursor:5}), /could not advance/);
});
