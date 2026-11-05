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
const trusted = { version: 3, policy: 'trusted_development' };
const isolated = { version: 3, policy: 'isolated' };
const standardOutbound = { version: 3, policy: 'standard_outbound' };
const legacyTrusted = Object.freeze({ version: 2, policy: 'trusted_development' });
const legacyIsolated = Object.freeze({ version: 2, policy: 'isolated' });
const file = path.join(temporary, 'directories.json');
const readiness = policy.readiness;
test.after(() => { policy.readiness = readiness; Module._load = load; fs.rmSync(temporary, { recursive: true, force: true }); });
test('legacy, malformed and manually edited choices confer no protected trust', () => {
  for (const value of [undefined, 'development', {}, { version: 1, policy: 'development' }, legacyTrusted]) {
    fs.writeFileSync(file, JSON.stringify({ workspaceNetwork: value }));
    assert.equal(config.getConfig().workspaceNetwork.policy, 'standard_outbound');
  }
  // An explicit legacy Isolated choice keeps its meaning across the upgrade.
  fs.writeFileSync(file, JSON.stringify({ workspaceNetwork: legacyIsolated }));
  assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  assert.throws(() => config.saveConfig({ workspaceNetwork: trusted }), { code: 'WORKSPACE_NETWORK_TRUST_REQUIRED' });
});
test('strict settings values and unavailable readiness fail closed before prompting', async () => {
  for (const value of [null, {}, { version: 2, policy: 'trusted_development' }, { version: 2, policy: 'isolated' }, { version: 1, policy: 'development' }, { version: 2, policy: 'anything' }])
    await assert.rejects(config.setWorkspaceNetwork(value), { code: 'WORKSPACE_NETWORK_POLICY_INVALID' });
  await assert.rejects(config.setWorkspaceNetwork(trusted), { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' });
  assert.equal(dialogs, 0);
});
test('only confirmed native settings decision persists protected trust; reverting revokes', async () => {
  policy.readiness = () => ({ available: true }); // Explicit fixture only.
  response = 0;
  const beforeCancel = config.networkRevision();
  assert.equal((await config.setWorkspaceNetwork(trusted)).workspaceNetwork.policy, 'isolated', 'cancelled consent keeps the prior explicit tier');
  assert.equal(config.networkRevision(), beforeCancel, 'cancelled consent must not interrupt already authorized commands');
  response = 1;
  assert.equal((await config.setWorkspaceNetwork(trusted)).workspaceNetwork.policy, 'trusted_development');
  assert.equal(config.getConfig().workspaceNetwork.policy, 'trusted_development');
  assert.equal(dialogs, 2);
  const saved = JSON.parse(fs.readFileSync(file));
  saved.workspaceNetworkReceipt = 'forged'; fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(config.getConfig().workspaceNetwork.policy, 'standard_outbound');
  await config.setWorkspaceNetwork(trusted);
  const previous = invalidations;
  await config.setWorkspaceNetwork(isolated);
  assert.ok(invalidations > previous);
  assert.equal(config.getConfig().workspaceNetwork.policy, 'isolated');
  assert.equal(JSON.parse(fs.readFileSync(file)).workspaceNetworkReceipt, undefined);
});
test('disclosure states the network boundary and retained limits', () => {
  const disclosure = policy.disclosureFor('trusted_development');
  assert.match(disclosure, /network-side effects/);
  assert.match(disclosure, /lifecycle scripts|same authority/);
  assert.match(disclosure, /External IPv6 is unsupported/);
  assert.match(disclosure, /autonomously inside the sandbox/);
  assert.match(policy.disclosureFor('standard_outbound'), /public package registries/);
  assert.match(policy.disclosureFor('standard_outbound'), /Host loopback, private LAN.*remain blocked/);
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
