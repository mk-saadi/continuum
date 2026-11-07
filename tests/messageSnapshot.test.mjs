import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMessageSnapshot } from '../src/lib/messageSnapshot.mjs';

test('snapshot refresh preserves unchanged rows and the whole unchanged array', () => {
  const previous = [{ id: 1, content: 'hello', variants: [{ content: 'hi' }], attachments: [{ id: 7 }] }];
  assert.equal(reconcileMessageSnapshot(previous, structuredClone(previous)), previous);
  const appended = reconcileMessageSnapshot(previous, [...structuredClone(previous), { id: 2, content: 'new' }]);
  assert.equal(appended[0], previous[0]);
  assert.equal(appended.length, 2);
});

test('changed nested state, deletions, ordering and field removal remain visible', () => {
  const previous = [{ id: 1, content: 'one', variants: [{ content: 'old' }] }, { id: 2, content: 'two' }];
  const incoming = structuredClone(previous);
  incoming[0].variants[0].content = 'edited';
  const changed = reconcileMessageSnapshot(previous, incoming);
  assert.equal(changed[0], incoming[0]);
  assert.equal(changed[1], previous[1]);
  assert.deepEqual(reconcileMessageSnapshot(previous, [structuredClone(previous[1])]), [previous[1]]);
  const reordered = reconcileMessageSnapshot(previous, structuredClone(previous).reverse());
  assert.equal(reordered[0], previous[1]);
  const removed = { id: 1, content: 'one' };
  assert.equal(reconcileMessageSnapshot(previous, [removed])[0], removed);
  assert.notEqual(reconcileMessageSnapshot([{ content: 'old' }], [{ content: 'new' }])[0].content, 'old');
});
