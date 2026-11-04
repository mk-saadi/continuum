'use strict';
// Build-time only. Unqualified helper material may enter disposable fixtures,
// never the normal release. No download, helper execution or readiness override.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { audit } = require('./audit-workspace-network.cjs');
const payloads = Object.freeze(['networkExecutionWorker.py', 'networkPreviewBridge.py',
  'workspaceNetworkAddressPolicy.json', 'experimental/network_owner.py']);
const helperPin = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(file) {
  const absolute = path.resolve(file);
  if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile())
    throw Error('Expected a regular nonsymlink file: ' + absolute);
  return fs.readFileSync(absolute);
}
function assemble({ helper, output, fixture = false, reviewArchive }) {
  // This is a code-reviewed release boundary, not a manifest assertion. Replace
  // only after the source/relink package and installed acceptance are reviewed.
  if (!fixture) throw Error('NETWORK_RELEASE_UNQUALIFIED: exact helper source/relink inventory and installed acceptance require review.');
  const destination = path.resolve(output);
  const parent = path.dirname(destination);
  const temporary = fs.realpathSync(os.tmpdir());
  if (fs.realpathSync(parent) !== parent || !parent.startsWith(temporary + path.sep))
    throw Error('Non-release fixtures must be assembled in an existing nonsymlink directory beneath ' + temporary);
  if (fs.existsSync(destination)) throw Error('Refusing to overwrite an existing output.');
  const binary = regular(helper);
  if (hash(binary) !== helperPin) throw Error('Independent helper pin mismatch.');
  if (binary.length < 64 || binary.subarray(0, 4).toString('hex') !== '7f454c46' ||
      binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 62)
    throw Error('Expected Linux x86-64 ELF.');
  fs.accessSync(path.resolve(helper), fs.constants.X_OK);
  // Snapshot every input before creating output. Never trust an old generated
  // manifest: hashes always describe the bytes copied in this invocation.
  const files = payloads.map(file => [file, regular(path.join(__dirname, '../src/main', file))]);
  files.push(['x64/slirp4netns', binary]);
  if (reviewArchive) {
    const bytes = regular(reviewArchive);
    if (hash(bytes) !== require('../docs/b2-g4-helper-candidate.json').reviewArchive?.sha256)
      throw Error('Pinned source/relink review archive mismatch.');
    files.push(['review/helper-review.tar.gz', bytes]);
  }
  fs.mkdirSync(destination);
  try {
    const root = path.join(destination, 'workspace-network');
    const manifest = { version: 1, sha256: {} };
    for (const [file, bytes] of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: file.endsWith('/slirp4netns') ? 0o755 : 0o644 });
      manifest.sha256[file] = hash(bytes);
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'NONRELEASE.json'), JSON.stringify({
      purpose: 'Disposable technical acceptance fixture only. DO NOT DISTRIBUTE.',
      redistributionQualified: false, productionQualified: false,
      helperSha256: helperPin, reviewMaterialsIncluded: !!reviewArchive,
      missing: require('../docs/b2-g4-helper-candidate.json').releaseBlockers,
    }, null, 2) + '\n');
    const result = audit(destination);
    if (!result.payloadIntegrity) throw Error(result.blockers.join('\n'));
    return result;
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}
if (require.main === module) {
  try {
    const [mode, helper, output, reviewArchive, extra] = process.argv.slice(2);
    if (!['--fixture', '--release'].includes(mode) || !helper || !output || extra)
      throw Error('Usage: node scripts/assemble-workspace-network.cjs <--fixture|--release> <helper> <new-resources-directory> [pinned-review-archive]');
    console.log(JSON.stringify(assemble({ helper, output, fixture: mode === '--fixture', reviewArchive }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { assemble, payloads, helperPin };
