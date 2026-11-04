'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { audit } = require('../scripts/audit-workspace-network.cjs');
const sourceFiles = ['networkExecutionWorker.py', 'networkPreviewBridge.py',
  'workspaceNetworkAddressPolicy.json', 'experimental/network_owner.py'];
function fixture(helper) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-g3-resources-'));
  const root = path.join(directory, 'workspace-network');
  const manifest = { version: 1, sha256: {} };
  for (const relative of [...sourceFiles, 'x64/slirp4netns']) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const bytes = relative.endsWith('slirp4netns') ? helper : fs.readFileSync(path.join(__dirname, '../src/main', relative));
    fs.writeFileSync(absolute, bytes, { mode: 0o755 });
    manifest.sha256[relative] = createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return { directory, root, manifest, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
test('archive audit rejects a self-consistent substituted helper and records compliance blockers', () => {
  const f = fixture(Buffer.alloc(64));
  try {
    const result = audit(f.directory);
    assert.equal(result.payloadIntegrity, false);
    assert.equal(result.productionQualified, false);
    assert.ok(result.blockers.some(s => s.includes('independent helper pin')));
    assert.ok(result.blockers.some(s => s.includes('corresponding sources')));
    assert.ok(result.blockers.some(s => s.includes('copyright notices')));
  } finally { f.close(); }
});
test('exact helper and final source bytes still cannot waive licensing or installed acceptance', { skip: !process.env.B2G3_HELPER }, () => {
  const f = fixture(fs.readFileSync(process.env.B2G3_HELPER));
  try {
    assert.equal(audit(f.directory).payloadIntegrity, true);
    assert.equal(audit(f.directory).productionQualified, false);
    for (const file of sourceFiles) {
      const absolute = path.join(f.root, file), bytes = fs.readFileSync(absolute);
      fs.appendFileSync(absolute, '\n# stale');
      assert.equal(audit(f.directory).payloadIntegrity, false);
      fs.writeFileSync(absolute, bytes);
    }
    const helper = path.join(f.root, 'x64/slirp4netns');
    fs.chmodSync(helper, 0o644); assert.equal(audit(f.directory).payloadIntegrity, false); fs.chmodSync(helper, 0o755);
    const target = path.join(f.root, sourceFiles[0]);
    fs.renameSync(target, target + '.real'); fs.symlinkSync(target + '.real', target);
    assert.equal(audit(f.directory).payloadIntegrity, false);
    fs.unlinkSync(target); fs.renameSync(target + '.real', target);
    f.manifest.version = 2;
    fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest));
    assert.equal(audit(f.directory).payloadIntegrity, false);
  } finally { f.close(); }
});
