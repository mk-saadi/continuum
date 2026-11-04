'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { derive } = require('../scripts/qualify-workspace-network.cjs');
test('qualification derivation cannot overwrite or target a release destination', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'g5-boundary-'));
  try {
    await assert.rejects(derive(temp, temp), /fresh/);
    await assert.rejects(derive(temp, path.resolve('release/g5-forbidden')), /fresh/);
    fs.mkdirSync(path.join(temp, 'real')); fs.symlinkSync(path.join(temp, 'real'), path.join(temp, 'link'));
    await assert.rejects(derive(temp, path.join(temp, 'link/out')), /nonsymlink/);
    await assert.rejects(derive(temp, path.join(temp, 'out')), /Complete pinned/);
    assert.equal(fs.existsSync(path.join(temp, 'out')), false);
    assert.equal(require('../src/main/workspaceNetworkPolicy').readiness().available, false);
    assert.equal(require('../package.json').build.files.some(value => value.includes('qualify-workspace')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('temporary qualification archive expires and never accepts another profile', { skip: !process.env.B2G5_QUALIFICATION_ASAR }, () => {
  const asar = require('@electron/asar'), vm = require('node:vm');
  const source = asar.extractFile(process.env.B2G5_QUALIFICATION_ASAR, 'src/main/b2g5Qualification.js').toString();
  const identity = JSON.parse(source.match(/Object\.freeze\((\{[^\n]+\})\)/)[1]);
  const evaluate = (profile, now) => {
    const module = { exports: {} };
    const localRequire = name => name === 'electron' ? { app: { isPackaged: true, getPath: () => profile } } :
      name === 'node:os' ? { homedir: () => identity.childHome } : require(name);
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { Date: { now: () => now }, process })(localRequire, module, module.exports);
    return module.exports.readiness();
  };
  assert.equal(evaluate(identity.profile, identity.expiresAt + 1).available, false);
  assert.equal(evaluate('/tmp/unrelated-profile', identity.expiresAt - 1).available, false);
  assert.equal(fs.existsSync(path.resolve('src/main/b2g5Qualification.js')), false);
});
