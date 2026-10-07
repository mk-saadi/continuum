import test from 'node:test';
import assert from 'node:assert/strict';
import { getTabShortcut } from '../src/lib/tabShortcuts.mjs';
import { closeAllTabsState, closeTabState, cycleActiveTabState } from '../src/lib/tabState.mjs';

const key = (value, modifiers = {}) => ({ key: value, ctrlKey: false, metaKey: false,
  shiftKey: false, altKey: false, isComposing: false, ...modifiers });

test('Ctrl and Cmd chords map to tab actions without matching plain typing', () => {
  assert.equal(getTabShortcut(key('t', { ctrlKey: true })), 'new');
  assert.equal(getTabShortcut(key('T', { metaKey: true, target: { tagName: 'TEXTAREA' } })), 'new');
  assert.equal(getTabShortcut(key('w', { ctrlKey: true })), 'close');
  assert.equal(getTabShortcut(key('w', { metaKey: true, shiftKey: true })), 'close-all');
  assert.equal(getTabShortcut(key('PageUp', { ctrlKey: true })), 'previous');
  assert.equal(getTabShortcut(key('Tab', { ctrlKey: true, shiftKey: true })), 'previous');
  assert.equal(getTabShortcut(key('PageDown', { ctrlKey: true })), 'next');
  assert.equal(getTabShortcut(key('Tab', { ctrlKey: true })), 'next');
  assert.equal(getTabShortcut(key('t')), null);
  assert.equal(getTabShortcut(key('t', { ctrlKey: true, altKey: true })), null);
  assert.equal(getTabShortcut(key('t', { metaKey: true, shiftKey: true })), null);
});

test('tab cycling wraps and active closure chooses the left neighbor', () => {
  const tabs = ['a', 'b', 'c'].map(id => ({ id }));
  const fromFirst = { tabs, activeTabId: 'a' };
  assert.equal(cycleActiveTabState(fromFirst, -1).activeTabId, 'c');
  assert.equal(cycleActiveTabState({ tabs, activeTabId: 'c' }, 1).activeTabId, 'a');
  assert.equal(closeTabState({ tabs, activeTabId: 'b' }, 'b', () => ({ id: 'fresh' })).activeTabId, 'a');
  assert.equal(closeTabState(fromFirst, 'a', () => ({ id: 'fresh' })).activeTabId, 'b');
  assert.equal(closeTabState({ tabs, activeTabId: 'c' }, 'a', () => ({ id: 'fresh' })).activeTabId, 'c');
  const last = closeTabState({ tabs: [{ id: 'a' }], activeTabId: 'a' }, 'a', () => ({ id: 'fresh' }));
  assert.deepEqual(last, { tabs: [{ id: 'fresh' }], activeTabId: 'fresh' });
  assert.deepEqual(closeAllTabsState(() => ({ id: 'fresh' })), last);
});
