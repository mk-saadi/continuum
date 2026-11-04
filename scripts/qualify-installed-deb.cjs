'use strict';
// Offline B2-G.6 NONRELEASE fixture only. Never imported by shipping code.
// Derives one pinned deb for one disposable guest, profile and 24-hour window.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { audit } = require('./audit-workspace-network.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const candidate = '5780b4081baa528c587d9d0d0f64d43399cca4b38d5c74c319cb310bb010af65';
async function derive(deb, output, machineId) {
  output = path.resolve(output);
  if (!/^[a-f0-9]{32}$/.test(machineId) || machineId === fs.readFileSync('/etc/machine-id', 'utf8').trim())
    throw Error('An explicit different disposable guest machine-id is required.');
  if (!output.startsWith(fs.realpathSync(os.tmpdir()) + '/') || fs.existsSync(output) ||
      fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw Error('Fresh nonsymlink /tmp destination required.');
  if (hash(deb) !== candidate) throw Error('Only the fixed G.5 NONRELEASE deb is admitted.');
  fs.mkdirSync(output, { mode: 0o700 });
  const tree = path.join(output, 'package');
  cp.execFileSync('dpkg-deb', ['-R', path.resolve(deb), tree]);
  const resources = path.join(tree, 'opt/Continuum/resources');
  const audited = audit(resources);
  if (!audited.payloadIntegrity || !audited.reviewMaterialsIntegrity) throw Error('Pinned source/helper/review audit failed.');
  const archive = path.join(resources, 'app.asar');
  for (const file of ['main.js', 'src/main/workspaceNetworkPolicy.js', 'src/main/networkDependencies.js',
    'src/main/configStore.js', 'src/main/networkExecution.js', 'src/main/sandboxFilesystem.js', 'src/main/tools/agentTools.js']) {
    if (!asar.extractFile(archive, file).equals(fs.readFileSync(path.join(__dirname, '..', file)))) throw Error('Current source mismatch: ' + file);
  }
  const source = path.join(output, 'archive-source'); asar.extractAll(archive, source);
  const identity = { kind: 'B2G6-NONRELEASE-INSTALLED-DEB', productionQualified: false,
    sourceDebSha256: candidate, sourceAsarSha256: hash(archive), guestMachineId: machineId,
    root: '/home/tester/b2g6/qualification', profile: '/home/tester/b2g6/qualification/profile',
    childHome: '/home/tester/b2g6/qualification/home', installedResources: '/opt/Continuum/resources',
    helperSha256: 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980',
    reviewSha256: '676fcef46f406b7511c64f638114a45dd9f38951899e3461e0d7e2c53e0e5225',
    expiresAt: Date.now() + 86400000 };
  const generated = `'use strict';
const identity = Object.freeze(${JSON.stringify(identity)});
let verified = false;
function readiness() {
 try {
  const fs = require('original-fs'), path = require('node:path'), crypto = require('node:crypto');
  const { app } = require('electron');
  if (!app.isPackaged || process.platform !== 'linux' || process.arch !== 'x64' || Date.now() > identity.expiresAt ||
      fs.readFileSync('/etc/machine-id','utf8').trim() !== identity.guestMachineId ||
      process.resourcesPath !== identity.installedResources || app.getPath('userData') !== identity.profile ||
      require('node:os').homedir() !== identity.childHome || fs.realpathSync(identity.root) !== identity.root ||
      fs.statSync(identity.root).uid !== process.getuid() || (fs.statSync(identity.root).mode & 0o077)) throw Error('Guest/install/profile/home/lifetime boundary failed.');
  if (!verified) {
   const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
   const owned = file => { const s=fs.lstatSync(file); if(s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o002) || ((s.mode & 0o020) && s.gid !== 0)) throw Error('Installed qualification must be root-owned and nonwritable to unprivileged users: '+file); };
   for (const file of ['/', '/opt', '/opt/Continuum', process.resourcesPath, process.resourcesPath+'/app.asar', process.resourcesPath+'/B2G6-INSTALL-RECEIPT.json']) owned(file);
   const receipt=JSON.parse(fs.readFileSync(process.resourcesPath+'/B2G6-INSTALL-RECEIPT.json','utf8'));
   if (receipt.guestMachineId !== identity.guestMachineId || receipt.sourceDebSha256 !== identity.sourceDebSha256 || receipt.qualificationAsarSha256 !== digest(process.resourcesPath+'/app.asar')) throw Error('Installed qualification receipt mismatch.');
   const status=require('node:child_process').execFileSync('/usr/bin/dpkg-query',['-W','-f=\u0024{Status}', 'continuum'],{encoding:'utf8'});
   if(status !== 'install ok installed') throw Error('The deb must actually be installed.');
   const dep=require('./networkDependencies').resolveBundled();
   if(digest(dep.helper)!==identity.helperSha256 || digest(path.join(process.resourcesPath,'workspace-network/review/helper-review.tar.gz'))!==identity.reviewSha256) throw Error('Independent helper/review pins failed.');
   verified=true;
  }
  return {available:true,productionQualified:false,qualificationOnly:true,code:identity.kind,blockers:[]};
 } catch(error) {return {available:false,productionQualified:false,code:'QUALIFICATION_UNAVAILABLE',blockers:[error.message]};}
}
module.exports={readiness,identity};
`;
  fs.writeFileSync(path.join(source, 'src/main/b2g6Qualification.js'), generated);
  fs.appendFileSync(path.join(source, 'src/main/workspaceNetworkPolicy.js'), "\n// Offline guest-specific NONRELEASE derivation only.\nmodule.exports.readiness = require('./b2g6Qualification').readiness;\n");
  const main = path.join(source, 'main.js');
  fs.writeFileSync(main, "require('electron').app.setName('Continuum B2G6 NONRELEASE');\nrequire('electron').app.on('browser-window-created',(_e,w)=>w.webContents.on('did-finish-load',()=>w.webContents.executeJavaScript(\"{const b=document.createElement('div');b.textContent='NONRELEASE · B2G6 installed-deb qualification · approval pending';b.style='position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#7f1d1d;color:white;text-align:center;pointer-events:none';document.body.appendChild(b)}\").catch(()=>{})));\n" + fs.readFileSync(main,'utf8'));
  fs.unlinkSync(archive);
  await asar.createPackageWithOptions(source, archive, { unpack: '{**/*.node,node_modules/@playwright/**,node_modules/playwright*/**,node_modules/typescript-language-server/**,node_modules/typescript/**}' });
  identity.qualificationAsarSha256 = hash(archive);
  fs.writeFileSync(path.join(resources, 'B2G6-INSTALL-RECEIPT.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(output, 'QUALIFICATION.json'), JSON.stringify(identity, null, 2));
  const artifact = path.join(output, 'Continuum-B2G6-NONRELEASE-QUALIFICATION-amd64.deb');
  cp.execFileSync('dpkg-deb', ['--root-owner-group', '-Zgzip', '-z1', '-b', tree, artifact], { stdio: 'inherit' });
  const result = { ...identity, artifact, debSha256: hash(artifact) };
  fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify(result, null, 2)); return result;
}
module.exports = { derive };
if (require.main === module) {
 if(process.argv.length !== 5) throw Error('Usage: node scripts/qualify-installed-deb.cjs <fixed-NONRELEASE.deb> <fresh-/tmp-output> <guest-machine-id>');
 derive(...process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
