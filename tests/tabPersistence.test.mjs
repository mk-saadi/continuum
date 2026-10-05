import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_STORAGE_KEY,
  closeTabState,
  dropOrphanTabs,
  moveTabState,
  parseTabState,
  sanitizeTab,
  serializeTabState,
} from '../src/lib/tabState.mjs';

const tab = (over = {}) => ({
  id: 'tab_1',
  sessionId: 's1',
  title: 'New chat',
  modelId: 'm',
  projectId: null,
  permissionMode: 'ask_approval',
  view: 'chat',
  saved: false,
  status: 'idle',
  ...over,
});

test('a round trip preserves identity, order, and the active tab', () => {
  const state = {
    tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb', title: 'Second' })],
    activeTabId: 'b',
  };
  assert.deepEqual(parseTabState(serializeTabState(state)), state);
});

test('stale runtime status never survives a restart', () => {
  const restored = parseTabState(serializeTabState({
    tabs: [tab({ status: 'generating' })],
    activeTabId: 'tab_1',
  }));
  assert.equal(restored.tabs[0].status, 'idle');
});

test('corrupt, empty, and malformed payloads fall back to no restored state', () => {
  assert.equal(parseTabState('not json'), null);
  assert.equal(parseTabState('[]'), null);
  assert.equal(parseTabState('{"tabs":[]}'), null);
  assert.equal(parseTabState(''), null);
  assert.equal(parseTabState('{}'), null);
});

test('tabs missing an id or session are rejected rather than half-restored', () => {
  assert.equal(sanitizeTab({ sessionId: 's' }), null);
  assert.equal(sanitizeTab({ id: 'i' }), null);
  assert.equal(sanitizeTab(null), null);
  assert.equal(sanitizeTab('nope'), null);
});

test('duplicate ids and duplicate sessions are collapsed to one tab', () => {
  const restored = parseTabState(JSON.stringify({
    tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'a', sessionId: 'sb' }), tab({ id: 'c', sessionId: 'sa' })],
    activeTabId: 'c',
  }));
  assert.equal(restored.tabs.length, 1);
  // The requested active tab was dropped, so the first survivor becomes active.
  assert.equal(restored.activeTabId, 'a');
});

test('an active id that no longer exists falls back to the first tab', () => {
  const restored = parseTabState(JSON.stringify({
    tabs: [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb' })],
    activeTabId: 'gone',
  }));
  assert.equal(restored.activeTabId, 'a');
});

test('unknown view and permission values are coerced to safe defaults', () => {
  const restored = parseTabState(JSON.stringify({
    tabs: [tab({ id: 'a', sessionId: 'sa', view: 'evil', permissionMode: 'root' })],
    activeTabId: 'a',
  }));
  assert.equal(restored.tabs[0].view, 'chat');
  assert.equal(restored.tabs[0].permissionMode, 'ask_approval');
});

test('a project tab without an explicit mode regains workspace permissions', () => {
  const restored = parseTabState(JSON.stringify({
    tabs: [{ id: 'a', sessionId: 'sa', projectId: 'p1' }],
    activeTabId: 'a',
  }));
  assert.equal(restored.tabs[0].permissionMode, 'workspace_write');
});

test('closing the only tab writes the replacement, purging the closed entry', () => {
  const before = serializeTabState({ tabs: [tab()], activeTabId: 'tab_1' });
  const next = closeTabState(parseTabState(before), 'tab_1', () => tab({ id: 'fresh', sessionId: 'freshS' }));
  const after = serializeTabState(next);
  assert.ok(!after.includes('tab_1'), 'closed tab id must be purged');
  assert.equal(next.tabs.length, 1);
});

test('dropping orphans keeps unsaved blank tabs but removes deleted chats', () => {
  const state = {
    tabs: [
      tab({ id: 'live', sessionId: 'liveS', saved: true }),
      tab({ id: 'deleted', sessionId: 'goneS', saved: true }),
      tab({ id: 'blank', sessionId: 'blankS', saved: false }),
    ],
    activeTabId: 'deleted',
  };
  const kept = dropOrphanTabs(state, id => id === 'liveS');
  assert.deepEqual(kept.tabs.map(t => t.id), ['live', 'blank']);
  assert.equal(kept.activeTabId, 'live');
});

test('dropping every orphan reports null so a default tab can be opened', () => {
  const state = { tabs: [tab({ id: 'gone', sessionId: 'goneS', saved: true })], activeTabId: 'gone' };
  assert.equal(dropOrphanTabs(state, () => false), null);
  assert.equal(dropOrphanTabs(null, () => true), null);
});

test('reordering keeps the active tab in front', () => {
  const tabs = [tab({ id: 'a', sessionId: 'sa' }), tab({ id: 'b', sessionId: 'sb' }), tab({ id: 'c', sessionId: 'sc' })];
  const moved = moveTabState({ tabs, activeTabId: 'b' }, 0, 2);
  assert.deepEqual(moved.tabs.map(t => t.id), ['b', 'c', 'a']);
  assert.equal(moved.activeTabId, 'b');
});

test('invalid reorder targets are ignored', () => {
  const state = { tabs: [tab({ id: 'a' })], activeTabId: 'a' };
  assert.equal(moveTabState(state, 0, 0), state);
  assert.equal(moveTabState(state, 5, 0), state);
  assert.equal(moveTabState(state, 0, -1), state);
});

test('the storage key matches the documented contract', () => {
  assert.equal(TAB_STORAGE_KEY, 'continuum_open_tabs');
});