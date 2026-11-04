'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { resolveBundled } = require('../src/main/networkDependencies');

test('packaged resource validation rejects tampering, substitution, wrong architecture and permissions', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-b2e-'));
  const root = path.join(temp, 'workspace-network');
  const previous = process.resourcesPath;
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return { app: { isPackaged: true } };
    // Resource-only fixture; version failures are exercised separately by G.3.
    if (name === './networkRuntimePrerequisites') return { assertVersions() {} };
    return load.call(this, name, ...args);
  };
  process.resourcesPath = temp;
  const files = ['networkPreviewBridge.py', 'networkExecutionWorker.py', 'experimental/network_owner.py', 'workspaceNetworkAddressPolicy.json', 'x64/slirp4netns'];
  const elf = Buffer.alloc(64); Buffer.from('7f454c46', 'hex').copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  function fixture() {
    fs.rmSync(root, { recursive: true, force: true });
    const manifest = { version: 1, sha256: {} };
    for (const file of files) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = file.endsWith('slirp4netns') ? elf : Buffer.from('fixture');
      fs.writeFileSync(target, data, { mode: 0o755 });
      manifest.sha256[file] = createHash('sha256').update(data).digest('hex');
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  }
  function denied() { assert.throws(resolveBundled, { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' }); }
  try {
    fixture();
    // Acceptance here is resource validation only; these fixture bytes are never executed.
    assert.equal(resolveBundled().helper, path.join(root, 'x64/slirp4netns'));
    for (const file of files) { fixture(); fs.appendFileSync(path.join(root, file), 'tampered'); denied(); }
    fixture(); fs.chmodSync(path.join(root, 'x64/slirp4netns'), 0o644); denied();
    fixture(); fs.unlinkSync(path.join(root, files[0])); denied();
    fixture(); const target = path.join(root, files[0]); fs.renameSync(target, target + '.real'); fs.symlinkSync(target + '.real', target); denied();
    fixture(); const manifest = path.join(root, 'manifest.json'); fs.renameSync(manifest, manifest + '.real'); fs.symlinkSync(manifest + '.real', manifest); denied();
    fixture(); fs.writeFileSync(manifest, '{'); denied();
    for (const data of ['null', '[]', '{"version":1,"sha256":[]}']) {
      fixture(); fs.writeFileSync(manifest, data); denied();
    }
    elf.writeUInt16LE(183, 18); fixture(); denied();
  } finally {
    Module._load = load;
    if (previous === undefined) delete process.resourcesPath; else process.resourcesPath = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
