'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { audit } = require('../scripts/audit-workspace-network.cjs');

const root = path.resolve(__dirname, '..');
const local = require('../src/main/localDevelopmentNetwork');

test('eligibility is code-owned and cannot be enabled by an arbitrary importer or external input', () => {
  // No environment variable, argv entry, renderer value or manifest field
  // participates: resolveEligibility only reads packaged/mainField.
  assert.deepEqual(local.resolveEligibility({ packaged: true, mainField: 'main.js' }), { eligible: false, mode: null });
  assert.deepEqual(local.resolveEligibility({ packaged: true, mainField: 'anything-else.js' }), { eligible: false, mode: null });
  assert.deepEqual(local.resolveEligibility({ packaged: true, mainField: null }), { eligible: false, mode: null });
  // Without a real Electron app, initialize() must not enable anything.
  assert.equal(local.active(), false);
  assert.equal(local.initialize(), false);
  assert.equal(local.active(), false);
});

test('a source-local repository launch is eligible; a normal packaged main is not', () => {
  assert.deepEqual(local.resolveEligibility({ packaged: false, mainField: 'main.js' }), { eligible: true, mode: 'source' });
  assert.deepEqual(local.resolveEligibility({ packaged: false, mainField: 'src/main/localDevelopmentEntry.js' }), { eligible: true, mode: 'source' });
  // Production AppImages keep package.json main = main.js, so they are rejected.
  assert.deepEqual(local.resolveEligibility({ packaged: true, mainField: 'main.js' }), { eligible: false, mode: null });
});

test('the packaged local developer entry is eligible only as the code-owned local main', () => {
  assert.deepEqual(local.resolveEligibility({ packaged: true, mainField: 'src/main/localDevelopmentEntry.js' }), { eligible: true, mode: 'packaged-local' });
});

test('main-profile resolution: no launcher forces a separate userData profile', () => {
  const shim = fs.readFileSync(path.join(root, 'scripts/local-development-main.cjs'), 'utf8');
  assert.ok(!shim.includes("setPath('userData'") && !shim.includes('setPath("userData"'), 'compatibility launcher must not override the profile');
  assert.ok(!shim.includes('.continuum-local/profile'), 'compatibility launcher must not reference the removed profile');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(main.includes('localDevelopmentNetwork").initialize()'), 'main entry must establish eligibility');
  // The primary profile always comes from package.json productName, unchanged.
  assert.equal(require('../package.json').productName, 'Continuum');
});

test('normal production packaging excludes local resources, local entry and profile, and defines no local extraResources', () => {
  const config = require('../package.json').build;
  assert.equal(config.extraResources, undefined);
  assert.equal(config.extraMetadata, undefined);
  for (const file of config.files) assert.ok(!file.includes('scripts/') && !file.includes('.continuum-local'));
  assert.equal(require('../scripts/local-network-resource-pins.cjs').productionQualified, false);
});

test('the local packaging target stays local-only and keeps the primary product name', () => {
  const localBuild = require('../electron-builder.local.cjs');
  assert.equal(localBuild.extraMetadata.main, 'src/main/localDevelopmentEntry.js');
  assert.equal(localBuild.productName, require('../package.json').build.productName, 'the local target keeps the production product name to reuse the primary profile');
  assert.equal(localBuild.directories.output, 'release-local');
  assert.ok(localBuild.extraResources.some(entry => entry.to === '.'));
  assert.notEqual(localBuild.directories.output, require('../package.json').build.directories.output);
});

const resources = path.resolve(__dirname, '../.continuum-local/resources');
test('real reconstructed resources pass only local review identity, never production qualification', { skip: !fs.existsSync(path.join(resources, 'workspace-network/manifest.json')) }, () => {
  const localAudit = audit(resources, { localDevelopment: true }), normal = audit(resources);
  assert.equal(localAudit.payloadIntegrity, true);
  assert.equal(localAudit.reviewMaterialsIntegrity, true);
  assert.equal(localAudit.productionQualified, false);
  assert.equal(normal.reviewMaterialsIntegrity, false, 'new local envelope cannot silently replace production review pin');
  assert.equal(normal.productionQualified, false);
});

test('local status caches verified bytes, but same-size same-mtime tampering invalidates authorization', { skip: !fs.existsSync(path.join(resources, 'workspace-network/manifest.json')) }, () => {
  const Module = require('node:module'), load = Module._load;
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'continuum-local-integrity-'));
  const originalActive = local.active, originalResources = local.resources;
  const runtime = require('../src/main/networkRuntimePrerequisites'), originalAssert = runtime.assertVersions;
  let probes = 0;
  try {
    fs.cpSync(path.join(resources, 'workspace-network'), path.join(temp, 'workspace-network'), { recursive: true });
    local.active = () => true; local.resources = temp;
    Module._load = function(name, ...args) { return name === 'electron' ? { app: { isPackaged: false } } : load.call(this, name, ...args); };
    runtime.assertVersions = () => { probes++; return originalAssert(); };
    const file = path.join(temp, 'workspace-network/networkExecutionWorker.py');
    fs.utimesSync(file, 1700000000, 1700000000);
    const timestamp = fs.statSync(file, { bigint: true }).mtimeNs;
    const dependencies = require('../src/main/networkDependencies');
    const first = dependencies.resolveBundled();
    assert.equal(dependencies.resolveBundled(), first);
    assert.equal(probes, 1, 'polling status must not spawn version probes repeatedly');
    const stat = fs.statSync(file), bytes = fs.readFileSync(file); bytes[0] ^= 1;
    fs.writeFileSync(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, timestamp);
    assert.throws(() => dependencies.resolveBundled(), { code: 'NETWORK_RESOURCE_VALIDATION_FAILED' });
  } finally {
    Module._load = load; local.active = originalActive; local.resources = originalResources; runtime.assertVersions = originalAssert;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
