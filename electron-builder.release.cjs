'use strict';
// NORMAL PRODUCTION packaging target (`npm run dist`).
//
// Identical to the package.json "build" configuration, plus the networking
// resources required for standard outbound Workspace Write internet access,
// staged OUTSIDE ASAR at process.resourcesPath/workspace-network. Payloads are
// verified against src/main and the independently pinned slirp4netns helper
// before packing and inside the packed resources after packing, so a normal
// production AppImage fails closed if its networking infrastructure is
// missing or modified. Runtime integrity is still enforced by
// src/main/networkDependencies.js on every owner startup.
//
// Source material: build-verified pinned resources under
// .continuum-local/resources (payload byte-equality against src/main is
// re-checked here; the review archive and local-only material are NOT shipped
// in the production package and are never needed at runtime).
const path = require('node:path');
const fs = require('node:fs');
const { verifyConfiguration } = require('./scripts/verify-release-networking.cjs');

const sourceResources = path.resolve(__dirname, '.continuum-local/resources/workspace-network');
const base = require('./package.json').build;

module.exports = {
  ...base,
  extraResources: [...(base.extraResources || []),
    { from: sourceResources, to: 'workspace-network', filter: [
      'manifest.json', 'networkExecutionWorker.py', 'networkPreviewBridge.py',
      'workspaceNetworkAddressPolicy.json', 'experimental/**', 'x64/**'] }],
  beforePack: async () => {
    if (!fs.existsSync(path.join(sourceResources, 'manifest.json')))
      throw new Error('No verified networking resource to package. Run: npm run local:network:prepare -- /absolute/pinned/slirp4netns /absolute/helper-review.tar.gz');
    const prepared = verifyConfiguration(path.dirname(sourceResources));
    if (!prepared.verified)
      throw new Error('Pre-pack networking resource verification failed: ' + prepared.blockers.join(' '));
  },
  afterPack: async context => {
    const packed = verifyConfiguration(path.join(context.appOutDir, 'resources'));
    if (!packed.verified)
      throw Error('Packaged networking resource verification failed: ' + packed.blockers.join('\n'));
  },
};
