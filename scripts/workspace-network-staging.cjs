'use strict';
// Separate electron-builder config for NON-DISTRIBUTABLE technical fixtures.
// Normal `npm run dist` never includes the unqualified helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { audit } = require('./audit-workspace-network.cjs');
const root = process.env.B2G4_STAGING_RESOURCES;
const output = process.env.B2G4_STAGING_OUTPUT;
function beneathTemporary(directory) {
  const resolved = path.resolve(directory);
  return fs.realpathSync(resolved) === resolved && resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep);
}
if (!root || !output || !beneathTemporary(root) || !beneathTemporary(output))
  throw Error('Explicit existing /tmp fixture resources and output directories are required.');
const result = audit(root);
if (!result.payloadIntegrity || !result.reviewMaterialsIntegrity || !fs.existsSync(path.join(root, 'workspace-network/NONRELEASE.json')))
  throw Error('Assemble and audit the explicitly labeled non-release fixture first.');
const config = require('../package.json').build;
module.exports = {
  ...config,
  directories: { ...config.directories, output },
  artifactName: 'Continuum-B2G4-NONRELEASE-${version}-${arch}.${ext}',
  extraResources: [{ from: path.join(root, 'workspace-network'), to: 'workspace-network', filter: ['**/*'] }],
  deb: { ...config.deb, compression: 'gz', depends: [...config.deb.depends, 'python3 (>= 3.11)',
    'util-linux (>= 2.39.3)', 'bubblewrap (>= 0.11.0)', 'nftables (>= 1.0.9)',
    'iproute2 (>= 6.1.0)', 'systemd (>= 255)', 'libpam-systemd (>= 255)'] },
  async afterPack(context) {
    const packed = audit(path.join(context.appOutDir, 'resources'));
    if (!packed.payloadIntegrity || !packed.reviewMaterialsIntegrity) throw Error('Packaged fixture resource audit failed: ' + packed.blockers.join('\n'));
  },
};
