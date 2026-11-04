'use strict';
// Offline archive/resource audit only. Does not stage, download, execute, or
// authorize a helper. Never imported by production readiness.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const payloads = ['networkExecutionWorker.py', 'networkPreviewBridge.py',
  'workspaceNetworkAddressPolicy.json', 'experimental/network_owner.py', 'x64/slirp4netns'];
const pin = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980';
function audit(resources) {
  const root = path.join(path.resolve(resources), 'workspace-network');
  const blockers = [], checks = [];
  function read(relative) {
    const absolute = path.join(root, relative);
    if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile()) throw Error('not a regular nonsymlink application resource');
    return fs.readFileSync(absolute);
  }
  let manifest, manifestValid = false;
  try {
    manifest = JSON.parse(read('manifest.json'));
    if (!manifest || manifest.version !== 1 || !manifest.sha256 || typeof manifest.sha256 !== 'object' || Array.isArray(manifest.sha256)) throw Error('unsupported manifest schema');
    manifestValid = true;
  } catch (error) { blockers.push('manifest.json: ' + error.message); }
  for (const relative of payloads) {
    try {
      const bytes = read(relative);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== manifest?.sha256?.[relative]) throw Error('missing or mismatched manifest digest');
      if (relative.endsWith('/slirp4netns')) {
        if (digest !== pin) throw Error('independent helper pin mismatch');
        if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw Error('not an x86-64 ELF');
        fs.accessSync(path.join(root, relative), fs.constants.X_OK);
      } else if (!bytes.equals(fs.readFileSync(path.join(__dirname, '../src/main', relative)))) {
        throw Error('packaged payload differs from current source');
      }
      checks.push({ file: relative, sha256: digest, ok: true });
    } catch (error) { checks.push({ file: relative, ok: false }); blockers.push(relative + ': ' + error.message); }
  }
  // A hash manifest says nothing about redistribution compliance. There is
  // deliberately no CLI switch or manifest field to waive this release gate.
  const provenance = require('../docs/b2-g4-helper-candidate.json');
  let reviewMaterialsIntegrity = false;
  try {
    const relative = 'review/helper-review.tar.gz';
    const digest = createHash('sha256').update(read(relative)).digest('hex');
    if (digest !== manifest?.sha256?.[relative] || digest !== provenance.reviewArchive?.sha256)
      throw Error('source/relink archive digest mismatch');
    reviewMaterialsIntegrity = true;
  } catch (error) { blockers.push('Incomplete or modified release review material: ' + error.message); }
  blockers.push(...provenance.releaseBlockers);
  blockers.push('Installed AppImage/deb trusted workflow and supported runtime matrix remain unqualified.');
  return { root, payloadIntegrity: checks.every(check => check.ok) && manifestValid,
    reviewMaterialsIntegrity, productionQualified: false, checks, blockers };
}
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/audit-workspace-network.cjs <application-resources-directory>'); process.exitCode = 2; }
  else { const result = audit(process.argv[2]); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.productionQualified ? 0 : 1; }
}
module.exports = { audit };
