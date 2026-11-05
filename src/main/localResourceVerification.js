'use strict';
// Runtime verification of LOCAL, NON-DISTRIBUTABLE networking resources.
//
// This ships inside the application and does not depend on the build-time
// scripts/ directory, docs/ provenance file or the source checkout. It is only
// reached for a code-owned local-development build (source or the local
// developer AppImage) after networkDependencies has confirmed the fixed
// resource layout. The authoritative check is still the manifest + independent
// helper/review-archive pin; the package.json / entry identity only decides
// whether the local path is eligible at all.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { helperSha256, reviewArchiveSha256 } = require('./localDevelopmentNetwork');

// Copied byte-for-byte from src/main at build time; re-checked here.
const sourcePayloads = ['networkExecutionWorker.py', 'networkPreviewBridge.py',
  'workspaceNetworkAddressPolicy.json', 'experimental/network_owner.py'];

function fail(detail) {
  throw Object.assign(new Error(detail), { code: 'NETWORK_RESOURCE_VALIDATION_FAILED' });
}
function readRegular(root, relative) {
  const absolute = path.join(root, relative);
  if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile()) fail(`${relative}: not a regular nonsymlink application resource`);
  return fs.readFileSync(absolute);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function assertLocalResources(root) {
  root = path.resolve(root);
  let manifest;
  try { manifest = JSON.parse(readRegular(root, 'manifest.json')); }
  catch (error) { if (error.code === 'NETWORK_RESOURCE_VALIDATION_FAILED') throw error; fail('manifest.json: ' + error.message); }
  if (!manifest || manifest.version !== 1 || !manifest.sha256 || typeof manifest.sha256 !== 'object' || Array.isArray(manifest.sha256))
    fail('unsupported local resource manifest');
  for (const relative of [...sourcePayloads, 'x64/slirp4netns']) {
    const bytes = readRegular(root, relative);
    const actual = digest(bytes);
    if (actual !== manifest.sha256?.[relative]) fail(`${relative}: missing or mismatched manifest digest`);
    if (relative === 'x64/slirp4netns') {
      if (actual !== helperSha256) fail('independent local helper pin mismatch');
      if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) fail('local helper is not an x86-64 ELF');
      fs.accessSync(path.join(root, relative), fs.constants.X_OK);
    } else if (!bytes.equals(fs.readFileSync(path.join(__dirname, relative)))) {
      fail(`${relative}: packaged payload differs from current source`);
    }
  }
  const review = readRegular(root, 'review/helper-review.tar.gz');
  const reviewDigest = digest(review);
  if (reviewDigest !== manifest.sha256?.['review/helper-review.tar.gz'] || reviewDigest !== reviewArchiveSha256)
    fail('source/relink review archive digest mismatch');
}

module.exports = { assertLocalResources };
