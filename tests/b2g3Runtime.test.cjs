'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main/networkRuntimePrerequisites'), 'utf8');
const versions = new Map([
  ['/usr/bin/python3', 'Python 3.12.3'], ['/usr/bin/bwrap', 'bubblewrap 0.11.0'],
  ['/usr/bin/unshare', 'unshare from util-linux 2.39.3'], ['/usr/bin/nsenter', 'nsenter from util-linux 2.39.3'],
  ['/usr/sbin/nft', 'nftables v1.0.9 (Old Doc Yak #3)'], ['/usr/sbin/ip', 'ip utility, iproute2-6.1.0, libbpf 1.3.0'],
  ['/usr/bin/systemd-run', 'systemd 255 (255.4-1ubuntu8)\n+PAM'],
]);
function fixture(changes = new Map()) {
  const module = { exports: {} };
  const calls = [];
  const require = name => {
    assert.equal(name, 'node:child_process');
    return { execFileSync(file, args, options) {
      calls.push(file);
      assert.ok(versions.has(file));
      assert.equal(options.cwd, '/');
      assert.equal(options.timeout, 2000);
      assert.equal(options.maxBuffer, 16384);
      assert.equal(options.env.PYTHONPATH, undefined);
      const value = changes.has(file) ? changes.get(file) : versions.get(file);
      if (value instanceof Error) throw value;
      return value;
    } };
  };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})')(require, module, module.exports);
  return { api: module.exports, calls };
}
test('candidate version success never establishes runtime qualification or production activation', () => {
  const { api, calls } = fixture();
  const result = api.assertVersions();
  assert.equal(result.versionsCompatible, true);
  assert.equal(result.runtimeQualified, false);
  assert.equal(calls.length, 7);
  assert.equal(require('../src/main/workspaceNetworkPolicy').readiness().available, false);
});
test('every absent, broken, timed-out or unrecognized fixed prerequisite fails closed', () => {
  for (const file of versions.keys()) {
    for (const value of [Object.assign(new Error('absent'), { code: 'ENOENT' }),
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'unknown tool output']) {
      const { api } = fixture(new Map([[file, value]]));
      assert.equal(api.inspectVersions().versionsCompatible, false, file);
      assert.throws(() => api.assertVersions(), error => error.code.startsWith('NETWORK_PREREQUISITE_') && error.message.includes(file));
    }
  }
});
test('incompatible versions cannot pass through executable presence', () => {
  const old = ['Python 3.10.99', 'bubblewrap 0.10.0', 'unshare from util-linux 2.39.2',
    'nsenter from util-linux 2.38.0', 'nftables v1.0.8', 'ip utility, iproute2-6.0.0', 'systemd 254'];
  [...versions.keys()].forEach((file, index) => {
    const { api } = fixture(new Map([[file, old[index]]]));
    assert.throws(() => api.assertVersions(), { code: 'NETWORK_PREREQUISITE_VERSION_UNSUPPORTED' });
  });
  const { api } = fixture(new Map([['/usr/bin/python3', 'Python 3.11.0']]));
  assert.equal(api.assertVersions().versionsCompatible, true);
});
test('source trees and unsupported packaged architectures cannot resolve networking resources', () => {
  const dependencies = fs.readFileSync(require.resolve('../src/main/networkDependencies'), 'utf8');
  for (const [platform, arch, isPackaged] of [['linux', 'arm64', true], ['win32', 'x64', true], ['darwin', 'x64', true], ['linux', 'x64', false]]) {
    const module = { exports: {} };
    const builtinRequire = name => name === 'electron' ? { app: { isPackaged } } : name === './networkRuntimePrerequisites'
      ? { assertVersions() { throw Error('must not probe unsupported runtime'); } } : require(name);
    vm.runInNewContext('(function(require,module,exports,process){' + dependencies + '\n})')(
      builtinRequire, module, module.exports, { platform, arch });
    assert.throws(() => module.exports.resolveBundled(), { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' });
  }
});
