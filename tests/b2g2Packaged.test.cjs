'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const asar = require('@electron/asar');
const { createHash } = require('node:crypto');
test('built archive matches source and rejects activation without qualified resources', { skip: !process.env.B2G2_RESOURCES }, () => {
  const root = path.resolve(process.env.B2G2_RESOURCES);
  const archive = path.join(root, 'app.asar');
  for (const file of ['src/main/workspaceNetworkPolicy.js', 'src/main/networkDependencies.js', 'src/main/configStore.js', 'src/main/networkExecution.js']) {
    const packed = asar.extractFile(archive, file);
    assert.equal(createHash('sha256').update(packed).digest('hex'), asar.statFile(archive, file).integrity.hash, file + ' archive integrity');
    assert.ok(packed.equals(fs.readFileSync(path.join(__dirname, '..', file))), file + ' source match');
  }
  const previous = process.resourcesPath;
  process.resourcesPath = root;
  function packedModule(file) {
    const module = { exports: {} };
    const source = asar.extractFile(archive, 'src/main/' + file + '.js').toString();
    const localRequire = name => name === 'electron' ? { app: { isPackaged: true } } : name === './networkDependencies' ? packedModule('networkDependencies') : require(name);
    vm.runInNewContext('(function(require,module,exports,process){' + source + '\n})', { Buffer })(localRequire, module, module.exports, process);
    return module.exports;
  }
  try {
    const status = packedModule('workspaceNetworkPolicy').readiness();
    assert.equal(status.available, false);
    assert.ok(status.blockers.some(s => s.includes('manifest')));
  } finally { process.resourcesPath = previous; }
});
