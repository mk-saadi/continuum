'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { derive } = require('../scripts/qualify-installed-deb.cjs');
test('installed qualification rejects host identity, overwrite and symlink output before unpacking', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'g6-boundary-'));
  const host=fs.readFileSync('/etc/machine-id','utf8').trim();
  const guest=host === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32);
  try {
    await assert.rejects(derive('/missing',path.join(tmp,'new'),host),/different disposable guest/);
    await assert.rejects(derive('/missing',tmp,guest),/Fresh nonsymlink/);
    fs.mkdirSync(path.join(tmp,'real')); fs.symlinkSync(path.join(tmp,'real'),path.join(tmp,'link'));
    await assert.rejects(derive('/missing',path.join(tmp,'link/out'),guest),/Fresh nonsymlink/);
    const fake=path.join(tmp,'fake.deb');fs.writeFileSync(fake,'substituted');
    await assert.rejects(derive(fake,path.join(tmp,'out'),guest),/Only the fixed/);
    assert.equal(fs.existsSync(path.join(tmp,'out')),false);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
test('guest-only generated readiness expires and cannot confer production eligibility', {skip:!process.env.B2G6_MODULE}, () => {
  const source=fs.readFileSync(process.env.B2G6_MODULE,'utf8');
  const identity=JSON.parse(source.match(/Object\.freeze\((\{[^\n]+\})\)/)[1]);
  const module={exports:{}};
  const req=name=>name==='original-fs'?fs:name==='electron'?{app:{isPackaged:true,getPath:()=>identity.profile}}:require(name);
  vm.runInNewContext('(function(require,module,exports){'+source+'\n})',{Date:{now:()=>identity.expiresAt+1},process})(req,module,module.exports);
  const result=module.exports.readiness();assert.equal(result.available,false);assert.equal(result.productionQualified,false);
  assert.equal(fs.existsSync(path.resolve('src/main/b2g6Qualification.js')),false);
  assert.equal(require('../src/main/workspaceNetworkPolicy').readiness().available,false);
});
