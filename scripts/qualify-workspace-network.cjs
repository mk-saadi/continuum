'use strict';
// OFFLINE, NON-DISTRIBUTABLE fixture derivation. Never imported by the app or
// normal builder. Shipping source/readiness and original artifacts stay intact.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { audit } = require('./audit-workspace-network.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function derive(source, destination) {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  const parent = fs.realpathSync(path.dirname(destination));
  if (!destination.startsWith(fs.realpathSync(os.tmpdir()) + '/') || parent !== path.dirname(destination) || fs.existsSync(destination))
    throw Error('A fresh nonsymlink /tmp destination is required.');
  const resources = path.join(source, 'resources');
  const reviewed = audit(resources);
  if (!reviewed.payloadIntegrity || !reviewed.reviewMaterialsIntegrity) throw Error('Complete pinned G.4 resources/materials required.');
  const archive = path.join(resources, 'app.asar');
  for (const file of ['main.js', 'src/main/workspaceNetworkPolicy.js', 'src/main/networkDependencies.js', 'src/main/configStore.js',
    'src/main/networkExecution.js', 'src/main/sandboxFilesystem.js', 'src/main/tools/agentTools.js']) {
    if (!asar.extractFile(archive, file).equals(fs.readFileSync(path.join(__dirname, '..', file))))
      throw Error('Candidate archive differs from reviewed source: ' + file);
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const appdir = path.join(destination, 'app'); fs.cpSync(source, appdir, { recursive: true });
  const tree = path.join(destination, 'archive-source'); asar.extractAll(archive, tree);
  const profile = path.join(destination, 'profile'), childHome = path.join(destination, 'home');
  fs.mkdirSync(profile); fs.mkdirSync(childHome); fs.mkdirSync(path.join(destination, 'workspace'));
  const identity = { kind: 'B2G5-NONRELEASE-TECHNICAL-QUALIFICATION', productionQualified: false,
    sourceAsarSha256: hash(archive), helperSha256: reviewed.checks.find(c => c.file === 'x64/slirp4netns').sha256,
    reviewSha256: require('../docs/b2-g4-helper-candidate.json').reviewArchive.sha256,
    root: destination, profile, childHome, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  // This generated module exists ONLY in the copied temporary archive. The
  // runtime cannot opt in via environment/renderer/manifest or select a path.
  const fixture = `'use strict';
const identity = Object.freeze(${JSON.stringify(identity)});
let verifiedReadOnlyMount = false;
function readiness() {
  try {
    const { app } = require('electron');
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    if (!app.isPackaged || Date.now() > identity.expiresAt || app.getPath('userData') !== identity.profile ||
        require('node:os').homedir() !== identity.childHome || fs.realpathSync(identity.root) !== identity.root ||
        !(fs.statSync(identity.root).mode & 0o700) || (fs.statSync(identity.root).mode & 0o077)) throw Error('Fixture profile/home/expiry boundary failed.');
    // A qualification package is admitted only on its immutable FUSE mount.
    // Rehashing a 124 MB archive and spawning version probes on a 50 ms
    // preview monitor would starve the event loop. The real default backend
    // independently resolves/verifies the manifest on every owner startup.
    if (!verifiedReadOnlyMount) {
    const appdir = path.dirname(process.resourcesPath);
    const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').find(line => line.split(' ')[4] === appdir);
    if (!appdir.startsWith('/tmp/.mount_') || !mount || !mount.split(' ')[5].split(',').includes('ro') || !mount.includes(' - fuse.'))
      throw Error('Qualification requires a read-only FUSE package mount.');
    const dep = require('./networkDependencies').resolveBundled();
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest(dep.helper) !== identity.helperSha256 || digest(path.join(process.resourcesPath, 'workspace-network/review/helper-review.tar.gz')) !== identity.reviewSha256)
      throw Error('Independent qualification pins failed.');
    verifiedReadOnlyMount = true;
    }
    return { available: true, productionQualified: false, qualificationOnly: true, code: identity.kind, blockers: [] };
  } catch (error) { return { available: false, productionQualified: false, code: 'QUALIFICATION_UNAVAILABLE', blockers: [error.message] }; }
}
module.exports = { readiness, identity };
`;
  fs.writeFileSync(path.join(tree, 'src/main/b2g5Qualification.js'), fixture);
  const policyFile = path.join(tree, 'src/main/workspaceNetworkPolicy.js');
  fs.appendFileSync(policyFile, "\n// Temporary qualification archive only; production source is unchanged.\nmodule.exports.readiness = require('./b2g5Qualification').readiness;\n");
  const banner = `
// Visibly identify the disposable qualification application before any window.
require('electron').app.setName('Continuum B2G5 NONRELEASE');
require('electron').app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript(${JSON.stringify("{ const banner = document.createElement('div'); banner.textContent = 'NONRELEASE · B2G5 technical qualification · release approval pending'; banner.style = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#7f1d1d;color:white;text-align:center;font:12px sans-serif;pointer-events:none'; document.body.appendChild(banner); }")}).catch(() => {}));
});
`;
  const mainFile = path.join(tree, 'main.js'); fs.writeFileSync(mainFile, banner + fs.readFileSync(mainFile, 'utf8'));
  const copiedArchive = path.join(appdir, 'resources/app.asar');
  fs.unlinkSync(copiedArchive);
  await asar.createPackageWithOptions(tree, copiedArchive, { unpack: '{**/*.node,node_modules/@playwright/**,node_modules/playwright*/**,node_modules/typescript-language-server/**,node_modules/typescript/**}' });
  identity.qualificationAsarSha256 = hash(copiedArchive);
  fs.writeFileSync(path.join(destination, 'QUALIFICATION.json'), JSON.stringify(identity, null, 2));
  return identity;
}
if (require.main === module) {
  if (process.argv.length !== 4) { console.error('Usage: node scripts/qualify-workspace-network.cjs <complete unpacked candidate> <fresh /tmp destination>'); process.exitCode = 2; }
  else derive(process.argv[2], process.argv[3]).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { derive };
