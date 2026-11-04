'use strict';
const { execFileSync } = require('node:child_process');

// Conservative candidate floors, NOT a supported-distribution declaration.
// Python's floor is required by hashlib.file_digest. Other floors match the
// exercised host; lower versions need separate qualification before admission.
const requirements = Object.freeze([
  { file: '/usr/bin/python3', args: ['--version'], pattern: /^Python (\d+\.\d+\.\d+)/, minimum: [3, 11, 0] },
  { file: '/usr/bin/bwrap', args: ['--version'], pattern: /^bubblewrap (\d+\.\d+\.\d+)/, minimum: [0, 11, 0] },
  { file: '/usr/bin/unshare', args: ['--version'], pattern: /util-linux (\d+\.\d+\.\d+)/, minimum: [2, 39, 3] },
  { file: '/usr/bin/nsenter', args: ['--version'], pattern: /util-linux (\d+\.\d+\.\d+)/, minimum: [2, 39, 3] },
  { file: '/usr/sbin/nft', args: ['--version'], pattern: /^nftables v(\d+\.\d+\.\d+)/, minimum: [1, 0, 9] },
  { file: '/usr/sbin/ip', args: ['-Version'], pattern: /^ip utility, iproute2-(\d+\.\d+\.\d+)/, minimum: [6, 1, 0] },
  { file: '/usr/bin/systemd-run', args: ['--version'], pattern: /^systemd (\d+)\b/, minimum: [255, 0, 0] },
].map(entry => Object.freeze({ ...entry, args: Object.freeze(entry.args), minimum: Object.freeze(entry.minimum) })));

function atLeast(actual, minimum) {
  for (let i = 0; i < 3; i++) {
    const delta = (actual[i] || 0) - minimum[i];
    if (delta) return delta > 0;
  }
  return true;
}
function inspectVersions() {
  const checks = requirements.map(requirement => {
    const { file, args, minimum, pattern } = requirement;
    const base = { file, minimum: minimum.join('.') };
    try {
      // No shell, workspace cwd, ambient Python variables, or PATH discovery.
      const output = execFileSync(file, args, { cwd: '/', encoding: 'utf8',
        timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
      const match = output.match(pattern);
      if (!match) return { ...base, ok: false, code: 'NETWORK_PREREQUISITE_VERSION_UNKNOWN' };
      const actual = match[1].split('.').map(Number);
      const ok = atLeast(actual, minimum);
      return { ...base, version: match[1], ok, ...(ok ? {} : { code: 'NETWORK_PREREQUISITE_VERSION_UNSUPPORTED' }) };
    } catch (error) {
      return { ...base, ok: false, code: 'NETWORK_PREREQUISITE_UNAVAILABLE',
        reason: error.code === 'ETIMEDOUT' ? 'version probe timed out' : 'fixed executable could not report its version' };
    }
  });
  return { versionsCompatible: checks.every(check => check.ok), runtimeQualified: false, checks };
}
function assertVersions() {
  const result = inspectVersions();
  const failed = result.checks.find(check => !check.ok);
  if (failed) throw Object.assign(new Error(`${failed.file}: ${failed.code}; requires candidate floor ${failed.minimum}${failed.version ? `, found ${failed.version}` : ''}.`), { code: failed.code });
  // Kernel/user-session capabilities still require real owner startup and
  // effective cgroup verification; version success never opens readiness.
  return result;
}
module.exports = { inspectVersions, assertVersions };
