'use strict';
// Verification of the RUNTIME networking resources required for standard
// outbound internet access in a packaged (production or local) application.
//
// Unlike scripts/audit-workspace-network.cjs — a build-time archive audit that
// also checks release review material — this checks exactly what the running
// application verifies at runtime (see src/main/networkDependencies.js):
//   * manifest.json (version 1) with a sha256 record per payload
//   * the four source payloads, byte-identical to the packaged src/main code
//   * the pinned x86-64 slirp4netns helper, executable and hash-pinned
// No release-approval gate and no .continuum-local path is involved at runtime.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const helperPin = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980';
const payloads = ['networkExecutionWorker.py', 'networkPreviewBridge.py',
  'workspaceNetworkAddressPolicy.json', 'experimental/network_owner.py'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyConfiguration(applicationResourcesDirectory) {
  const root = path.join(path.resolve(applicationResourcesDirectory), 'workspace-network');
  const blockers = [], checks = [];
  function read(relative) {
    const absolute = path.join(root, relative);
    if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile())
      throw Error('not a regular nonsymlink application resource');
    return fs.readFileSync(absolute);
  }
  let manifest;
  try {
    manifest = JSON.parse(read('manifest.json'));
    if (!manifest || manifest.version !== 1 || !manifest.sha256 || typeof manifest.sha256 !== 'object' || Array.isArray(manifest.sha256))
      throw Error('unsupported manifest schema');
  } catch (error) { blockers.push('manifest.json: ' + error.message); }
  for (const relative of [...payloads, 'x64/slirp4netns']) {
    try {
      const bytes = read(relative);
      const actual = digest(bytes);
      if (actual !== manifest?.sha256?.[relative]) throw Error('missing or mismatched manifest digest');
      if (relative.endsWith('/slirp4netns')) {
        if (actual !== helperPin) throw Error('independent helper pin mismatch');
        if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62)
          throw Error('not a Linux x86-64 ELF');
        fs.accessSync(path.join(root, relative), fs.constants.X_OK);
      } else if (!bytes.equals(fs.readFileSync(path.join(__dirname, '..', 'src/main', relative))))
        throw Error('packaged payload differs from current source');
      checks.push({ file: relative, sha256: actual, ok: true });
    } catch (error) { checks.push({ file: relative, ok: false }); blockers.push(relative + ': ' + error.message); }
  }
  return { root, verified: blockers.length === 0, checks, blockers };
}

module.exports = { verifyConfiguration, helperPin, payloads };
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/verify-release-networking.cjs <application-resources-directory>'); process.exitCode = 2; }
  else { const result = verifyConfiguration(process.argv[2]); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verified ? 0 : 1; }
}
