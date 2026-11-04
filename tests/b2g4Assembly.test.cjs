'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble } = require('../scripts/assemble-workspace-network.cjs');
const { audit } = require('../scripts/audit-workspace-network.cjs');
test('release assembly cannot be authorized by a caller or a manifest assertion', () => {
  assert.throws(() => assemble({ helper: '/missing', output: '/missing' }), /NETWORK_RELEASE_UNQUALIFIED/);
  assert.throws(() => assemble({ helper: '/missing', output: '/missing', releaseApproved: true }), /NETWORK_RELEASE_UNQUALIFIED/);
});
test('fixture assembly rejects substitution before creating output', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-g4-assembly-'));
  try {
    const helper = path.join(temp, 'helper'); fs.writeFileSync(helper, Buffer.alloc(64), { mode: 0o755 });
    const output = path.join(temp, 'resources');
    assert.throws(() => assemble({ helper, output, fixture: true }), /pin mismatch/);
    assert.equal(fs.existsSync(output), false);
    fs.symlinkSync(helper, helper + '.link');
    assert.throws(() => assemble({ helper: helper + '.link', output, fixture: true }), /nonsymlink/);
    fs.mkdirSync(path.join(temp, 'real')); fs.symlinkSync(path.join(temp, 'real'), path.join(temp, 'link'));
    assert.throws(() => assemble({ helper, output: path.join(temp, 'link/out'), fixture: true }), /nonsymlink/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('real pinned fixture assembles deterministically, remains unqualified and rejects stale payloads', { skip: !process.env.B2G4_HELPER }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-g4-assembly-'));
  try {
    const a = path.join(temp, 'a'), b = path.join(temp, 'b');
    for (const output of [a, b]) {
      const result = assemble({ helper: process.env.B2G4_HELPER, output, fixture: true });
      assert.equal(result.payloadIntegrity, true); assert.equal(result.productionQualified, false);
      assert.equal(result.reviewMaterialsIntegrity, false);
      assert.ok(result.blockers.some(value => value.includes('corresponding sources')));
      const label = JSON.parse(fs.readFileSync(path.join(output, 'workspace-network/NONRELEASE.json')));
      assert.equal(label.redistributionQualified, false);
    }
    const manifest = output => path.join(output, 'workspace-network/manifest.json');
    assert.deepEqual(fs.readFileSync(manifest(a)), fs.readFileSync(manifest(b)));
    assert.throws(() => assemble({ helper: process.env.B2G4_HELPER, output: a, fixture: true }), /overwrite/);
    const source = path.join(a, 'workspace-network/networkPreviewBridge.py');
    fs.appendFileSync(source, '\n# stale');
    const value = JSON.parse(fs.readFileSync(manifest(a)));
    value.sha256['networkPreviewBridge.py'] = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    fs.writeFileSync(manifest(a), JSON.stringify(value));
    assert.equal(audit(a).payloadIntegrity, false, 'rehashing stale sources must not hide them');
    assert.equal(require('../src/main/workspaceNetworkPolicy').readiness().available, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('review archive pin is checked independently of manifest claims', { skip: !process.env.B2G4_REVIEW || !process.env.B2G4_HELPER }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-g4-review-'));
  try {
    const output = path.join(temp, 'resources');
    const result = assemble({ helper: process.env.B2G4_HELPER, output, fixture: true, reviewArchive: process.env.B2G4_REVIEW });
    assert.equal(result.reviewMaterialsIntegrity, true); assert.equal(result.productionQualified, false);
    const archive = path.join(output, 'workspace-network/review/helper-review.tar.gz');
    fs.appendFileSync(archive, 'modified');
    const manifest = path.join(output, 'workspace-network/manifest.json');
    const value = JSON.parse(fs.readFileSync(manifest));
    value.sha256['review/helper-review.tar.gz'] = require('node:crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify(value));
    assert.equal(audit(output).reviewMaterialsIntegrity, false);
    assert.throws(() => assemble({ helper: process.env.B2G4_HELPER, output: path.join(temp, 'bad'), fixture: true, reviewArchive: archive }), /archive mismatch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
