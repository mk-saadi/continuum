'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const policy = require('../src/main/workspaceNetworkPolicy');
const safeStorage = require('./helpers/networkSafeStorage.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-b2g2-settings-'));
const load = Module._load;
let nextDialog = null;
let response = 0, dialogs = 0, invalidations = 0;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => temporary }, safeStorage,
    dialog: { async showMessageBox(options) { dialogs++; assert.match(options.detail, /host-local, private LAN, VPN/); assert.equal(options.defaultId, 0); return nextDialog ? nextDialog() : { response }; } } };
  if (name === './networkExecution') return { service: { async invalidateAll() { invalidations++; } } };
  return load.call(this, name, ...args);
};
const config = require('../src/main/configStore');
const trusted = { version: 2, policy: 'trusted_development' };
const isolated = { version: 2, policy: 'isolated' };
const file = path.join(temporary, 'directories.json');
const readiness = policy.readiness;
test.after(() => { policy.readiness = readiness; Module._load = load; fs.rmSync(temporary, { recursive: true, force: true }); });
test('legacy, malformed and manually edited choices confer no trust', () => {
  for (const value of [undefined, 'development', {}, { version: 1, policy: 'development' }, trusted]) {
    fs.writeFileSync(file, JSON.stringify({ workspaceNetwork: value }));
    assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  }
  assert.throws(() => config.saveConfig({ workspaceNetwork: trusted }), { code: 'WORKSPACE_NETWORK_TRUST_REQUIRED' });
});
test('strict settings values and production readiness fail closed before prompting', async () => {
  for (const value of [null, {}, { version: 1, policy: 'development' }, { version: 2, policy: 'anything' }])
    await assert.rejects(config.setWorkspaceNetwork(value), { code: 'WORKSPACE_NETWORK_POLICY_INVALID' });
  await assert.rejects(config.setWorkspaceNetwork(trusted), { code: 'WORKSPACE_NETWORK_NOT_READY' });
  assert.equal(dialogs, 0);
});
test('only confirmed native settings decision persists protected trust; reverting revokes', async () => {
  policy.readiness = () => ({ available: true }); // Explicit fixture only.
  response = 0;
  assert.equal((await config.setWorkspaceNetwork(trusted)).workspaceNetwork.policy, 'isolated');
  response = 1;
  assert.equal((await config.setWorkspaceNetwork(trusted)).workspaceNetwork.policy, 'trusted_development');
  assert.equal(config.getConfig().workspaceNetwork.policy, 'trusted_development');
  assert.equal(dialogs, 2);
  const saved = JSON.parse(fs.readFileSync(file));
  saved.workspaceNetworkReceipt = 'forged'; fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  await config.setWorkspaceNetwork(trusted);
  const previous = invalidations;
  await config.setWorkspaceNetwork(isolated);
  assert.ok(invalidations > previous);
  assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  assert.equal(JSON.parse(fs.readFileSync(file)).workspaceNetworkReceipt, undefined);
});
test('disclosure states the network boundary and retained limits', () => {
  assert.match(policy.disclosure, /network-side effects/);
  assert.match(policy.disclosure, /lifecycle scripts/);
  assert.match(policy.disclosure, /External IPv6 is unsupported/);
  assert.match(policy.disclosure, /command authorization/);
});

test('pending confirmation cannot override a later Isolated decision', async () => {
  policy.readiness = () => ({ available: true });
  let confirm;
  nextDialog = () => new Promise(resolve => { confirm = resolve; });
  const pending = config.setWorkspaceNetwork(trusted);
  await config.setWorkspaceNetwork(isolated);
  confirm({ response: 1 });
  await pending;
  assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  nextDialog = null;
});
test('plaintext storage backend cannot record a trust decision', async () => {
  const backend = safeStorage.getSelectedStorageBackend;
  safeStorage.getSelectedStorageBackend = () => 'basic_text';
  try { await assert.rejects(config.setWorkspaceNetwork(trusted), /OS-protected/); }
  finally { safeStorage.getSelectedStorageBackend = backend; }
});
