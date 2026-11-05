'use strict';
// No downloads or pin overrides. Inputs must be the exact reviewed artifacts.
const fs = require('node:fs');
const path = require('node:path');
const { assemble } = require('./assemble-workspace-network.cjs');
const { audit } = require('./audit-workspace-network.cjs');
const destination = path.resolve(__dirname, '../.continuum-local/resources');
const [helper, reviewArchive] = process.argv.slice(2);
if (!helper || !reviewArchive || process.argv.length !== 4)
  throw Error('Usage: npm run local:network:prepare -- /absolute/pinned/slirp4netns /absolute/helper-review.tar.gz');
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
if (fs.existsSync(destination)) {
  const result = audit(destination, { localDevelopment: true });
  if (!result.payloadIntegrity || !result.reviewMaterialsIntegrity) throw Error('Existing local resources are invalid or stale. Preserve them elsewhere before preparing fresh resources.');
} else assemble({ helper, reviewArchive, output: destination, localDevelopment: true });
require('../src/main/networkRuntimePrerequisites').assertVersions();
console.log('Pinned local resources and runtime version checks passed. Launch npm run dev (primary profile) or build the developer AppImage with npm run dist:local; native consent and runtime containment checks remain required.');
