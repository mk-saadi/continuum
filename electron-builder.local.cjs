'use strict';
// LOCAL DEVELOPER, NON-DISTRIBUTABLE packaging target (`npm run dist:local`).
//
// This is not a production release. It reuses the project's normal packaging
// configuration, keeps productName "Continuum" (so the developer AppImage uses
// the primary application profile), points the packaged "main" at the
// code-owned local entry, and stages the independently verified local
// networking resources outside ASAR at process.resourcesPath/workspace-network.
//
// Production stays on `npm run dist`, whose gate rejects those local-only
// resources and the local entry identity.
const path = require('node:path');
const fs = require('node:fs');
const { audit } = require('./scripts/audit-workspace-network.cjs');

const sourceResources = path.resolve(__dirname, '.continuum-local/resources');
const base = require('./package.json').build;

module.exports = {
  ...base,
  directories: { ...base.directories, output: 'release-local' },
  // The packaged main is the code-owned local entry. productName is inherited
  // unchanged so the primary profile is reused.
  extraMetadata: { ...(base.extraMetadata || {}), main: 'src/main/localDevelopmentEntry.js' },
  // Stage verified local networking resources outside ASAR. `from` is a
  // directory; `to: '.'` places workspace-network at process.resourcesPath.
  extraResources: [{ from: sourceResources, to: '.' }],
  linux: { ...base.linux, target: ['AppImage'] },
  beforePack: async () => {
    const manifest = path.join(sourceResources, 'workspace-network/manifest.json');
    if (!fs.existsSync(manifest))
      throw new Error('Prepare local networking resources first: npm run local:network:prepare -- <helper> <review-archive>');
    const result = audit(sourceResources, { localDevelopment: true });
    if (!result.payloadIntegrity || !result.reviewMaterialsIntegrity)
      throw new Error('Local networking resource audit failed: ' + result.integrityBlockers.join(' '));
  },
};
