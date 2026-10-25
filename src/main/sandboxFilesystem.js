'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const unavailable = p => new Error(`required runtime path unavailable: ${p}`);
const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
const ETC = ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/localtime', '/etc/ssl/certs', '/etc/ca-certificates', '/etc/mime.types', '/etc/alternatives'];
function resolveEntry(p, required = false) {
  try { const source = fs.realpathSync(p); return { source, destination: p, symlink: source !== p }; }
  catch (error) { if (!required && error.code === 'ENOENT') return null; throw unavailable(p); }
}
function validateExtraPaths(paths, { home = os.homedir(), maskedPaths = [] } = {}) {
  if (!Array.isArray(paths)) throw new Error('Extra read-only runtime paths must be an array.');
  return paths.map(p => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw unavailable(String(p));
    const real = resolveEntry(p, true).source;
    const secrets = ['.ssh', '.aws', '.config', '.gnupg', '.mozilla', '.npmrc', '.local/share/keyrings'].map(p => path.join(home, p));
    if (secrets.some(p => inside(p, real) || inside(real, p)) || real === '/' || inside(real, home) || ['/run', '/mnt', '/media', '/proc', '/dev', '/etc'].some(x => inside(x, real)) ||
        maskedPaths.some(x => inside(x, real) || inside(real, x)) || !fs.statSync(real).isDirectory()) throw unavailable(p);
    return real;
  });
}
// Pure: inputs contain already resolved paths. Mount ordering is security-critical.
function buildSandboxMounts({ system, etc, runtimes = [], workspace, writable = true, maskedPaths = [], home, tmp, askpassDirectory }) {
  const argv = ['--tmpfs', '/', '--tmpfs', '/tmp', '--dir', '/sandbox-home'];
  if (tmp) argv.push('--bind', tmp, '/tmp');
  const bound = new Set();
  const bind = (source, destination, write = false) => argv.push(write ? '--bind' : '--ro-bind', source, destination);
  for (const entry of [...system, ...etc, ...runtimes]) {
    if (entry.fileMapping) { bind(entry.source, entry.destination); continue; }
    if (!bound.has(entry.source)) { bind(entry.source, entry.source); bound.add(entry.source); }
    if (entry.destination !== entry.source) {
      if (entry.symlink) argv.push('--symlink', entry.source, entry.destination);
      else bind(entry.source, entry.destination);
    }
  }
  if (workspace) bind(workspace, workspace, writable);
  // Hidden data is an empty read-only mount, not writable scratch space.
  for (const p of [...new Set(maskedPaths)].sort((a, b) => a.length - b.length)) {
    if ((workspace && inside(workspace, p)) || [...system, ...runtimes].some(e => inside(e.source, p))) argv.push('--tmpfs', p, '--remount-ro', p);
  }
  if (home) bind(home, '/sandbox-home', true);
  if (askpassDirectory) bind(askpassDirectory, askpassDirectory);
  argv.push('--proc', '/proc', '--dev', '/dev');
  return argv;
}
function environment(host = process.env, { home = '/sandbox-home', pathValue = '/usr/local/bin:/usr/bin:/bin' } = {}) {
  const env = { PATH: pathValue, LANG: 'C.UTF-8', HOME: home, TMPDIR: '/tmp' };
  for (const [key, value] of Object.entries(host)) if (/^(?:LANG|LC_[A-Z_]+|TERM|TZ)$/.test(key)) env[key] = value;
  return env;
}
function assertNoSockets(directory) {
  const pending = [directory];
  while (pending.length) {
    const p = pending.pop();
    const stat = fs.lstatSync(p);
    if (stat.isSocket()) throw new Error(`Sandbox socket path is not permitted: ${p}`);
    if (stat.isDirectory()) for (const child of fs.readdirSync(p)) pending.push(path.join(p, child));
  }
}
function resolveFilesystem({ workspace, network = false, writable = true, home, tmp, askpassDirectory, config, userData, hostEnv = process.env }) {
  if (!config || !userData) {
    const { app } = require('electron');
    config ??= require('./configStore').getConfig();
    userData ??= app.getPath('userData');
  }
  workspace = fs.realpathSync(workspace);
  const maskedPaths = [config.appDataDirectory, userData, path.join(workspace, '.llm_workspace')].filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p));
  const system = SYSTEM.map(p => resolveEntry(p)).filter(Boolean);
  const etc = [...ETC, ...(network ? ['/etc/resolv.conf', '/etc/hosts'] : [])].map(p => resolveEntry(p)).filter(Boolean).map(e => ({ ...e, fileMapping: true }));
  for (const scratch of [home, tmp].filter(Boolean)) {
    if ([config.appDataDirectory, userData].map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }).some(p => inside(p, scratch) && inside(workspace, p))) throw unavailable(scratch);
  }
  assertNoSockets(workspace);
  const extras = validateExtraPaths(config.extraReadOnlyRuntimePaths ?? [], { maskedPaths });
  for (const p of extras) assertNoSockets(p);
  const runtimes = extras.map(p => ({ source: p, destination: p }));
  const bins = [];
  for (const name of ['sh', 'node', 'npm', 'git', 'python', 'python3']) {
    let found;
    for (const dir of [...extras.map(p => path.join(p, 'bin')), ...(hostEnv.PATH || '/usr/bin:/bin').split(path.delimiter)]) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); found = resolveEntry(candidate, true).source; break; } catch {}
    }
    if (!found) { if (name === 'sh' || name === 'git') throw unavailable(name); continue; }
    if (system.some(e => inside(e.source, found))) continue;
    // Ask the installed manager for the actual image, never bind its shim directory.
    if (found.includes('/.volta/bin/')) {
      try {
        const volta = path.join(path.dirname(found), 'volta');
        const resolved = require('node:child_process').execFileSync(volta, ['which', name], {
          encoding: 'utf8', timeout: 5000, env: { ...environment(hostEnv), HOME: os.homedir(), VOLTA_HOME: path.dirname(path.dirname(found)) },
        }).trim();
        if (!path.isAbsolute(resolved)) throw unavailable(found);
        found = resolveEntry(resolved, true).source;
      } catch { throw unavailable(found); }
    }
    if (found.includes('/shims/')) {
      try {
        const asdf = [...(hostEnv.PATH || '').split(path.delimiter)].filter(path.isAbsolute).map(p => path.join(p, 'asdf')).find(p => fs.existsSync(p));
        if (!asdf) throw unavailable(found);
        const resolved = require('node:child_process').execFileSync(asdf, ['which', name], { cwd: workspace,
          encoding: 'utf8', timeout: 5000, env: { ...environment(hostEnv), HOME: os.homedir() } }).trim();
        if (!path.isAbsolute(resolved)) throw unavailable(found);
        found = resolveEntry(resolved, true).source;
      } catch { throw unavailable(found); }
    }
    if (found.includes('/shims/') || found.includes('/.volta/bin/')) throw unavailable(found);
    const parent = path.dirname(found);
    const install = path.basename(parent) === 'bin' ? path.dirname(parent) : parent;
    const validated = validateExtraPaths([install], { maskedPaths })[0];
    assertNoSockets(validated);
    runtimes.push({ source: validated, destination: validated });
    bins.push(path.join(validated, 'bin'), parent);
  }
  return { mounts: buildSandboxMounts({ system, etc, runtimes, workspace, writable, maskedPaths, home, tmp, askpassDirectory }),
    env: environment(hostEnv, { home: home ? '/sandbox-home' : '/tmp', pathValue: [...new Set([...bins, '/usr/local/bin', '/usr/bin', '/bin'])].join(':') }) };
}
module.exports = { buildSandboxMounts, resolveFilesystem, validateExtraPaths, environment, inside };
