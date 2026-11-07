import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppShortcut } from '../src/lib/appShortcuts.mjs';
const event = (key, patch = {}) => ({ key, ctrlKey: true, ...patch });
test('requested shortcut bindings and keyboard guards', () => {
  for (const [key, command] of [['[','left'],[']','right'],['.','settings'],['m','models']]) {
    assert.equal(getAppShortcut(event(key)), command);
    assert.equal(getAppShortcut(event(key, { ctrlKey: false, metaKey: true })), command);
    assert.equal(getAppShortcut(event(key, { shiftKey: true })), null);
  }
  assert.equal(getAppShortcut(event('P', { shiftKey: true })), 'spotlight');
  for (const guard of [{ ctrlKey: false }, { altKey: true }, { isComposing: true }, { repeat: true }])
    assert.equal(getAppShortcut(event('m', guard)), null);
  for (const key of ['t','w','Tab','PageUp','PageDown','f','r']) assert.equal(getAppShortcut(event(key)), null);
});
