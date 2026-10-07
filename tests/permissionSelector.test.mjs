// The permission selector's context rules and the backend engine must come
// from one catalog: what the composer offers, what loadChat resolves, and what
// toolPermissions enforces can never drift apart. These tests pin the shared
// helpers (src/lib/permissionModes.mjs) against the real backend
// (src/main/toolPermissions.js) so the UI can never advertise a mode the
// engine would reject or silently normalize away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_DEFAULTS,
  isPermissionMode,
  availablePermissionModes,
  defaultPermissionMode,
  normalizePermissionMode,
  resolveChatPermissionMode,
} from '../src/lib/permissionModes.mjs';

const require = createRequire(import.meta.url);
const backend = require('../src/main/toolPermissions.js');

const workspace = { id: 'p1', root_path: '/tmp/permission-selector-workspace' };
const rootless = { id: 'p2', root_path: '' };
const storedProject = { id: 'p3', root_path: '/tmp/permission-selector-workspace', permission_mode: 'read_only' };

test('casual chats offer exactly read_only, ask_approval, full_access', () => {
  assert.deepEqual(availablePermissionModes(null), ['read_only', 'ask_approval', 'full_access']);
  assert.ok(!availablePermissionModes(null).includes('workspace_write'));
});

test('workspace chats offer all four modes, rootless projects behave casual', () => {
  assert.deepEqual(availablePermissionModes(workspace), [...PERMISSION_MODES]);
  assert.deepEqual(availablePermissionModes(rootless), ['read_only', 'ask_approval', 'full_access']);
});

test('context defaults: casual ask_approval, workspace workspace_write', () => {
  assert.equal(PERMISSION_MODE_DEFAULTS.casual, 'ask_approval');
  assert.equal(PERMISSION_MODE_DEFAULTS.workspace, 'workspace_write');
  assert.equal(defaultPermissionMode(null), 'ask_approval');
  assert.equal(defaultPermissionMode(workspace), 'workspace_write');
  // A project without a root cannot run workspace writes, so its default is
  // the normalized mode — never one the backend would rewrite.
  assert.equal(defaultPermissionMode(rootless), 'ask_approval');
  assert.equal(defaultPermissionMode(storedProject), 'read_only');
  for (const project of [null, workspace, rootless, storedProject]) {
    const mode = defaultPermissionMode(project);
    assert.ok(isPermissionMode(mode), `default must be a catalog mode: ${mode}`);
    assert.ok(availablePermissionModes(project).includes(mode), 'default must be selectable');
  }
});

test('every advertised mode is honored as-is by the backend', () => {
  for (const project of [null, workspace, rootless, storedProject]) {
    for (const mode of availablePermissionModes(project)) {
      assert.equal(backend.effectiveMode(mode, project), mode,
        `${mode} must not be rewritten in ${JSON.stringify(project)}`);
      assert.equal(backend.resolveMode(mode, project), mode);
    }
  }
});

test('renderer and backend agree on available modes and defaults', () => {
  for (const project of [null, workspace, rootless, storedProject]) {
    assert.deepEqual(availablePermissionModes(project), backend.availableModes(project));
    assert.equal(defaultPermissionMode(project), backend.effectiveMode(undefined, project));
  }
});

test('the backend accepts every catalog mode and rejects unknown ones', () => {
  for (const mode of PERMISSION_MODES) {
    assert.equal(backend.resolveMode(mode, null), mode);
  }
  assert.throws(() => backend.resolveMode('root', null), /Invalid permission mode/);
  assert.throws(() => backend.resolveMode('', null), /Invalid permission mode/);
});

test('labels cover every mode the selector can render', () => {
  for (const mode of PERMISSION_MODES) {
    assert.ok(PERMISSION_MODE_LABELS[mode], `missing label for ${mode}`);
  }
  assert.deepEqual(Object.keys(PERMISSION_MODE_LABELS).sort(), [...PERMISSION_MODES].sort());
});

test('workspace_write normalizes to ask_approval instead of appearing', () => {
  assert.equal(normalizePermissionMode('workspace_write', null), 'ask_approval');
  assert.equal(normalizePermissionMode('workspace_write', workspace), 'workspace_write');
  assert.equal(normalizePermissionMode('read_only', null), 'read_only');
});

test('loadChat applies a context default only when nothing is stored', () => {
  // No stored selection: the loaded chat starts on its context default.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's2', currentSessionId: 's1', tabMode: 'full_access', sessionMode: undefined, project: null,
  }), 'ask_approval');
  assert.equal(resolveChatPermissionMode({
    sessionId: 's2', currentSessionId: 's1', tabMode: 'full_access', sessionMode: undefined, project: workspace,
  }), 'workspace_write');
  // A stored session selection beats both the tab's mode and the default.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's2', currentSessionId: 's1', tabMode: 'full_access', sessionMode: 'read_only', project: workspace,
  }), 'read_only');
  // The tab's stored mode only applies to the session it already shows, so a
  // stale mode never leaks into a different chat — that chat starts on its
  // own context default instead.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's2', currentSessionId: 's1', tabMode: 'full_access', sessionMode: undefined, project: workspace,
  }), 'workspace_write');
});

test('a stored mode survives reload of the same session', () => {
  // App restart: the in-memory session map is empty, but the tab persisted the
  // selection. Reloading the same session must restore it, not reset it.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's1', currentSessionId: 's1', tabMode: 'read_only', sessionMode: undefined, project: workspace,
  }), 'read_only');
  assert.equal(resolveChatPermissionMode({
    sessionId: 's1', currentSessionId: 's1', tabMode: 'full_access', sessionMode: 'read_only', project: null,
  }), 'read_only');
});

test('a stored mode is normalized for the context it is loaded into', () => {
  // workspace_write stored on the tab, then a casual chat is shown: the UI
  // must fall back to the mode the backend would actually run.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's1', currentSessionId: 's1', tabMode: 'workspace_write', sessionMode: undefined, project: null,
  }), 'ask_approval');
  assert.equal(resolveChatPermissionMode({
    sessionId: 's2', currentSessionId: 's1', tabMode: 'full_access', sessionMode: 'workspace_write', project: rootless,
  }), 'ask_approval');
  // Unknown/garbage stored values are ignored, not displayed.
  assert.equal(resolveChatPermissionMode({
    sessionId: 's1', currentSessionId: 's1', tabMode: 'root', sessionMode: 'root', project: workspace,
  }), 'workspace_write');
});
