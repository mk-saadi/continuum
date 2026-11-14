import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarStore } from '../src/lib/sidebarState.mjs';

test('both sidebars stay isolated by conversation and restore independently', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const store = createSidebarStore(storage);
  const first = store.forSession('first');
  const second = store.forSession('second');
  let secondUpdates = 0;
  second.subscribe(() => secondUpdates++);
  first.setOpen('left', true);
  first.setOpen('right', value => !value);
  assert.deepEqual(second.getSnapshot(), { left: false, right: false });
  assert.equal(secondUpdates, 0);
  second.setOpen('right', true);
  first.setOpen('right', false);
  assert.deepEqual(store.forSession('first').getSnapshot(), { left: true, right: false });
  assert.deepEqual(second.getSnapshot(), { left: false, right: true });
  const restored = createSidebarStore(storage);
  assert.deepEqual(restored.forSession('first').getSnapshot(), first.getSnapshot());
  assert.deepEqual(restored.forSession('second').getSnapshot(), second.getSnapshot());
});

test('sidebar state works without storage and ignores invalid saved values', () => {
  const store = createSidebarStore({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  const entry = store.forSession('chat');
  entry.setOpen('left', true);
  assert.equal(entry.getSnapshot().left, true);
  const invalid = createSidebarStore({ getItem: () => '{"left":"true","right":1}' });
  assert.deepEqual(invalid.forSession('chat').getSnapshot(), { left: false, right: false });
});
