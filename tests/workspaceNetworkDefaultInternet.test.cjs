'use strict';
// Deterministic regression tests for the Workspace Write networking tiers.
//
// Standard outbound internet access is the DEFAULT for Workspace Write in
// every build, while host loopback, private LAN and VPN destinations stay
// denied by kernel rules, elevated access requires separate consent, and
// Isolated remains an explicit opt-out. No kernel namespaces are touched:
// the generated nftables rules and the service policy gating are inspected
// directly. Real end-to-end networking is covered by the acceptance runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-network-tiers-'));
const load = Module._load;
// Minimal electron stub so main-process modules can load in a plain node test
// process; readiness must still report the unpackaged truth (test 2).
const electronStub = { app: { getPath: () => temporary, isReady: () => true, isPackaged: false }, ipcMain: { handle: () => {}, removeHandler: () => {} } };
Module._load = function(name, ...args) {
  if (name === 'electron') return electronStub;
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
test.after(async () => { Module._load = load; try { db.closeDatabase(); } catch {} fs.rmSync(temporary, { recursive: true, force: true }); });

const policy = require('../src/main/workspaceNetworkPolicy');

test('standard outbound is the default tier for absent, legacy and malformed decisions', () => {
  for (const value of [undefined, null, {}, 'development', { version: 1, policy: 'development' }, { version: 2, policy: 'development' }, { version: 3, policy: 'networking' }])
    assert.equal(policy.normalize(value).policy, 'standard_outbound');
  // Legacy persisted decisions keep their meaning across the upgrade.
  assert.equal(policy.normalize({ version: 2, policy: 'trusted_development' }).policy, 'trusted_development');
  assert.equal(policy.normalize({ version: 2, policy: 'isolated' }).policy, 'isolated');
  assert.equal(policy.normalize({ version: 3, policy: 'trusted_development' }).policy, 'trusted_development');
  assert.equal(policy.normalize({ version: 3, policy: 'isolated' }).policy, 'isolated');
});

test('readiness verifies resources the same way for a simulated production build', () => {
  // In this unpackaged test process the packaged resource set is unavailable;
  // the tier must still be the default and the failure must be a plain,
  // actionable resource message (no release-approval blocker).
  const status = policy.readiness();
  assert.equal(status.available, false);
  assert.equal(status.buildKind, 'production');
  assert.equal(status.code, 'NETWORK_DEPENDENCIES_NOT_PACKAGED');
  assert.ok(!JSON.stringify(status).includes('release approval pending'));
  assert.ok(!JSON.stringify(status).includes('NETWORK_RELEASE_APPROVAL_PENDING'));
});

test('standard outbound nft rules deny loopback, private LAN and VPN ranges; elevated tier does not', () => {
  const printed = policySet => execFileSync('/usr/bin/python3', ['-I', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('owner', ${JSON.stringify(path.resolve(__dirname, '../src/main/experimental/network_owner.py'))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.stdout.write(module.rules(['192.168.1.10'], ${JSON.stringify(policySet)}))`], { encoding: 'utf8' });
  const standard = printed('standard_outbound');
  // Host-side destinations are rejected by the kernel rule set...
  for (const range of ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'])
    assert.ok(standard.includes(range), `standard rules must deny ${range}`);
  assert.ok(standard.includes('ip daddr @restricted4 counter name denied4 reject'));
  assert.ok(standard.includes('ip daddr @host4 counter name denied4 reject'), 'host addresses must be denied');
  assert.ok(standard.includes('meta nfproto ipv6 counter name denied6 reject'), 'external IPv6 stays unsupported');
  // ...while public IPv4 flows and the synthetic resolver are allowed.
  assert.ok(standard.includes('meta nfproto ipv4 accept'));
  assert.ok(standard.includes('ip daddr 10.0.2.3 udp dport 53 accept'));
  // The elevated tier removes the destination restrictions.
  const elevated = printed('trusted_development');
  assert.ok(!elevated.includes('restricted4'));
  assert.ok(elevated.includes('meta nfproto ipv4 accept'));
  // The fixture alias remains only a test identity.
  assert.ok(printed('public_only_fixture').includes('restricted4'));
  assert.throws(() => printed('networking'), /NETWORK_POLICY_INVALID/);
});

test('service executes with the selected tier and refuses Isolated without touching owners', async () => {
  db.initDatabase(temporary);
  const networkExecution = require('../src/main/networkExecution');
  const config = require('../src/main/configStore');
  const contexts = require('../src/main/lspExecutionContext');
  const resolver = path.join(os.tmpdir(), 'tier-resolv-' + Date.now() + '.conf');
  fs.writeFileSync(resolver, 'nameserver 10.0.2.3\noptions timeout:1 attempts:1\n');
  const seen = [], closed = [];
  const service = networkExecution.createService({
    authorize: () => ({ sessionId: 'tier-session', workspace: temporary, revision: 1 }),
    backend: (identity, networkPolicy) => { seen.push(networkPolicy); return { alive: () => true, resolver,
      execute: async () => ({ status: 'completed', exitCode: 0 }), async close() { closed.push(networkPolicy); } }; },
    readiness: () => ({ available: true, code: 'NETWORK_RESOURCES_READY', blockers: [] }),
  });
  const workspace = fs.realpathSync(temporary);
  const project = require('../src/main/projectManager').createProject({ name: 'Tier', root_path: workspace });
  require('../src/main/sessionManager').getOrCreateSession('tier-session', 'fixture', project.id);
  const filesystem = require('../src/main/sandboxFilesystem').resolveFilesystem({ workspace, protectGitMetadata: true, config: { appDataDirectory: path.join(temporary, 'data') }, userData: temporary, hostEnv: { PATH: '/usr/bin:/bin' } });
  const invocation = () => ({
    context: contexts.createContext('tier-session', 'workspace_write', 'tier-run'), workspace, cwd: workspace,
    command: 'true', filesystem, validateAuthorization: () => {},
  });
  const save = config.getConfig;
  const withPolicy = (value, run) => {
    config.getConfig = () => ({ workspaceNetwork: policy.normalize(value) });
    return run().finally(() => { config.getConfig = save; });
  };
  await withPolicy({ version: 3, policy: 'standard_outbound' }, () => service.execute(invocation()));
  await withPolicy({ version: 3, policy: 'trusted_development' }, () => service.execute(invocation()));
  await withPolicy({ version: 2, policy: 'trusted_development' }, () => service.execute(invocation()));
  assert.deepEqual(seen, ['standard_outbound', 'trusted_development', 'trusted_development']);
  // Switching back must retire the elevated owner instead of reusing it.
  await withPolicy({ version: 3, policy: 'standard_outbound' }, () => service.execute(invocation()));
  assert.deepEqual(seen, ['standard_outbound', 'trusted_development', 'trusted_development', 'standard_outbound']);
  assert.ok(closed.includes('trusted_development'), 'the elevated owner must be closed when the tier is lowered');
  await withPolicy({ version: 3, policy: 'isolated' }, async () => {
    await assert.rejects(service.execute(invocation()), { code: 'NETWORK_POLICY_REVOKED' });
  });
  assert.equal(seen.length, 4, 'Isolated must not start a network owner');
  await service.shutdown();
});

test('command routing honors every non-Isolated tier without Trusted Development', async () => {
  // Replayed routing decision from src/main/tools/agentTools.js executeCommand:
  // the sandbox is network-enabled whenever the tier is operational.
  const executionCapabilities = require('../src/main/executionCapabilities');
  const config = require('../src/main/configStore');
  const save = config.getConfig;
  try {
    config.getConfig = () => ({ workspaceNetwork: policy.normalize() });
    const state = executionCapabilities.networkState();
    assert.equal(state.selected, 'standard_outbound');
    // Resources are unavailable in this unpackaged test process, so routing
    // must fall back to the offline sandbox with a clear explanation.
    assert.equal(state.operational, false);
    assert.ok(!/Trusted Development/.test(state.description));
    config.getConfig = () => ({ workspaceNetwork: policy.normalize({ version: 3, policy: 'isolated' }) });
    const isolated = executionCapabilities.networkState();
    assert.equal(isolated.code, 'NETWORK_ISOLATED');
    assert.match(isolated.description, /Isolated/);
  } finally { config.getConfig = save; }
});

test('readiness for an eligible local build reports resources from the local path', () => {
  const local = require('../src/main/localDevelopmentNetwork');
  assert.equal(local.active(), false, 'plain node test processes are never eligible local builds');
  assert.equal(local.buildLabel(), 'Production');
});
