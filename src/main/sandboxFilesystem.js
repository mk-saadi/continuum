'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const unavailable = p => new Error(`required runtime path unavailable: ${p}`);
const shellPlans = new WeakMap();
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
function buildSandboxMounts({ system, etc, runtimes = [], workspace, writable = true, maskedPaths = [], home, tmp, askpassDirectory, gitMetadata = [], maskedSockets = [], authMounts = [] }) {
  const argv = ['--tmpfs', '/', '--tmpfs', '/tmp', '--dir', '/sandbox-home'];
  // Scratch is invocation-local: never re-expose masked host storage.
  if (home) argv.push('--tmpfs', '/sandbox-home');
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
  for (const socket of maskedSockets) bind('/dev/null', socket);
  for (const p of gitMetadata) bind(p, p);
  // Hidden data is an empty read-only mount, not writable scratch space.
  for (const p of effectiveMasks({ workspace, system, runtimes, maskedPaths })) {
    if (gitMetadata.some(root => inside(p, root)) || (askpassDirectory && inside(p, askpassDirectory)) ||
        authMounts.some(mount => inside(p, mount.destination)))
      throw unavailable(p); // A later rebind would invalidate the exclusion.
    argv.push('--tmpfs', p, '--remount-ro', p);
  }
  if (askpassDirectory) bind(askpassDirectory, askpassDirectory);
  // Host authentication capabilities are explicitly narrow: read-only config
  // files plus the user's existing SSH agent socket. Parent directories do not
  // exist in the empty sandbox root, so create only the path components needed.
  const created = new Set();
  for (const mount of authMounts) {
    let parent = path.dirname(mount.destination);
    const parents = [];
    while (parent !== '/' && parent !== '.' && !created.has(parent)) { parents.unshift(parent); parent = path.dirname(parent); }
    for (const p of parents) { argv.push('--dir', p); created.add(p); }
    bind(mount.source, mount.destination, mount.writable === true);
  }
  argv.push('--proc', '/proc', '--dev', '/dev', '--remount-ro', '/');
  return argv;
}
// Shared by validation and mount construction; only actual covering mounts qualify.
function effectiveMasks({ workspace, system = [], runtimes = [], maskedPaths = [] }) {
  const result = [];
  for (const p of [...new Set(maskedPaths)].sort((a, b) => a.length - b.length)) {
    if (!result.some(parent => inside(parent, p)) &&
        ((workspace && inside(workspace, p)) || [...system, ...runtimes].some(e => inside(e.source, p)))) result.push(p);
  }
  return result;
}
function environment(host = process.env, { home = '/sandbox-home', pathValue = '/usr/local/bin:/usr/bin:/bin' } = {}) {
  const env = { PATH: pathValue, LANG: 'C.UTF-8', HOME: home, TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp/continuum-cache', npm_config_cache: '/tmp/continuum-cache/npm', PIP_CACHE_DIR: '/tmp/continuum-cache/pip' };
  for (const [key, value] of Object.entries(host)) if (/^(?:LANG|LC_[A-Z_]+|TERM|TZ)$/.test(key)) env[key] = value;
  return env;
}
function assertNoSockets(directory, maskedSockets, excluded = []) {
  const pending = [directory];
  while (pending.length) {
    const p = pending.pop();
    if (excluded.includes(p)) {
      if (fs.realpathSync(p) !== p || !fs.lstatSync(p).isDirectory()) throw unavailable(p);
      continue;
    }
    const stat = fs.lstatSync(p);
    if (stat.isSocket()) {
      if (maskedSockets) maskedSockets.push(p);
      else throw new Error(`Sandbox socket path is not permitted: ${p}`);
    }
    if (stat.isDirectory()) for (const child of fs.readdirSync(p)) pending.push(path.join(p, child));
  }
}
// The kernel's active Unix socket table also covers sockets in system runtime
// trees without recursively walking hundreds of thousands of /usr files.
function assertNoExposedHostSockets(roots, maskedSockets = [], excluded = []) {
  let table;
  try { table = fs.readFileSync('/proc/net/unix', 'utf8'); } catch { throw unavailable('/proc/net/unix'); }
  for (const line of table.split('\n').slice(1)) {
    const spelling = line.match(/^(?:\S+\s+){7}(\/.*)$/)?.[1];
    const socket = spelling && path.resolve(spelling);
    if (socket && !excluded.some(p => inside(p, socket)) && !maskedSockets.includes(socket) && roots.some(p => inside(p, socket))) throw new Error(`Sandbox socket path is not permitted: ${socket}`);
  }
}
function resolveAuthMounts(mounts, maskedPaths = []) {
  if (!Array.isArray(mounts)) throw new Error('Authentication mounts must be an array.');
  return mounts.map(mount => {
    const source = mount?.source, destination = mount?.destination;
    if (typeof source !== 'string' || typeof destination !== 'string' ||
        !path.isAbsolute(source) || !path.isAbsolute(destination) || source.includes('\0') || destination.includes('\0'))
      throw unavailable(String(source ?? destination));
    const real = fs.realpathSync(source);
    if (real === '/') throw unavailable(source);
    if (maskedPaths.some(p => inside(p, real) || inside(real, p))) throw unavailable(source);
    const stat = fs.lstatSync(real);
    if (!stat.isFile() && !stat.isSocket()) throw unavailable(source);
    return { source: real, destination, ...(mount.writable === true ? { writable: true } : {}) };
  });
}
function resolveFilesystemImpl({ workspace, network = false, writable = true, home, tmp, askpassDirectory, config, userData, hostEnv = process.env, protectGitMetadata = false, maskWorkspaceSockets = false, authMounts = [] }) {
  if (!config || !userData) {
    const { app } = require('electron');
    config ??= require('./configStore').getConfig();
    userData ??= app.getPath('userData');
  }
  workspace = fs.realpathSync(workspace);
  if (workspace === '/' || inside(workspace, os.homedir())) throw unavailable(workspace);
  const maskedPaths = [config.appDataDirectory, userData, path.join(workspace, '.llm_workspace')].filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p));
  const system = SYSTEM.map(p => resolveEntry(p)).filter(Boolean);
  const etc = [...ETC, ...(network ? ['/etc/resolv.conf', '/etc/hosts'] : [])].map(p => resolveEntry(p)).filter(Boolean).map(e => ({ ...e, fileMapping: true }));
  for (const scratch of [home, tmp].filter(Boolean)) {
    if ([config.appDataDirectory, userData].map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }).some(p => inside(p, scratch) && inside(workspace, p))) throw unavailable(scratch);
  }
  const maskedSockets = [];
  const excluded = effectiveMasks({ workspace, system, maskedPaths });
  assertNoSockets(workspace, maskWorkspaceSockets && !protectGitMetadata ? maskedSockets : undefined, excluded);
  const extras = validateExtraPaths(config.extraReadOnlyRuntimePaths ?? [], { maskedPaths });
  for (const p of extras) assertNoSockets(p);
  const runtimes = extras.map(p => ({ source: p, destination: p }));
  const bins = [];
  for (const name of ['sh', 'node', 'npm', 'git', 'python', 'python3']) {
    let found;
    for (const dir of [...extras.map(p => path.join(p, 'bin')), ...(hostEnv.PATH || '/usr/bin:/bin').split(path.delimiter)]) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); const resolved = resolveEntry(candidate, true).source; if (!fs.statSync(resolved).isFile()) continue; found = resolved; break; } catch {}
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
  assertNoExposedHostSockets([workspace, ...system.map(e => e.source), ...etc.map(e => e.source), ...runtimes.map(e => e.source), ...[askpassDirectory].filter(Boolean)], maskedSockets, excluded);
  const auth = resolveAuthMounts(authMounts, maskedPaths);
  const gitMetadata = protectGitMetadata ? require('./gitMetadata').resolveGitMetadata(workspace, excluded) : [];
  const plan = { gitMetadata, mounts: buildSandboxMounts({ system, etc, runtimes, workspace, writable, maskedPaths, home, tmp, askpassDirectory, gitMetadata, maskedSockets, authMounts: auth }),
    env: environment(hostEnv, { home: home ? '/sandbox-home' : '/tmp', pathValue: [...new Set([...bins, '/usr/local/bin', '/usr/bin', '/bin'])].join(':') }) };
  if (!network && writable && protectGitMetadata) shellPlans.set(plan, { options: { workspace, network, writable, home, tmp, askpassDirectory, config, userData, hostEnv, protectGitMetadata, maskWorkspaceSockets, authMounts }, workspace, mounts: [...plan.mounts], env: { ...plan.env } });
  return plan;
}
function resolveFilesystem(options) {
  try { return resolveFilesystemImpl(options); }
  catch (error) {
    error.sandboxPreparation = {
      code: 'SANDBOX_PREPARATION_FAILED', stage: 'sandbox_preparation',
      operation_executed: false, executionStarted: false,
      restrictionCategory: /socket path/.test(error.message) ? 'exposed_socket' : 'filesystem_boundary',
      retryable: false,
      suggested_action: 'Inspect the identified exposed path or runtime configuration; retry only after correcting it. Keep internal recovery data intact.',
    };
    throw error;
  }
}
// The selected profile is not enough: require a plan built by this module and
// check the actual invocation immediately before handing it to the executor.
function assertShellInvocation(plan, { file, argv, cwd, workspace }) {
  const facts = shellPlans.get(plan);
  // Recheck after asynchronous preparation; never trust a stale socket scan.
  if (facts) {
    const current = resolveFilesystem(facts.options);
    if (JSON.stringify(current.mounts) !== JSON.stringify(facts.mounts)) throw unavailable(workspace);
  }
  const mountStart = argv.indexOf('--tmpfs');
  if (!facts || file !== 'bwrap' || facts.workspace !== fs.realpathSync(workspace) ||
      !inside(facts.workspace, fs.realpathSync(cwd)) ||
      JSON.stringify(argv.slice(0, mountStart)) !== JSON.stringify(['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--cap-drop', 'ALL']) ||
      JSON.stringify(plan.env) !== JSON.stringify(facts.env) ||
      JSON.stringify(argv.slice(mountStart, mountStart + facts.mounts.length)) !== JSON.stringify(facts.mounts) ||
      JSON.stringify(argv.slice(mountStart + facts.mounts.length, -1)) !== JSON.stringify(['--setenv', 'PATH', facts.env.PATH, '--chdir', cwd, '/bin/sh', '-c']))
    throw new Error('Execution blocked: Command must run inside the verified sandboxFilesystem shell profile.');
}

// Separate, single-use protocol: sharing an application-owned isolated network
// does not relax a single filesystem mount. Re-resolve for late sockets/masks.
function networkShellInvocation(plan, { workspace, cwd, command, permit }) {
  const facts = shellPlans.get(plan);
  if (!facts || facts.workspace !== fs.realpathSync(workspace) || !inside(facts.workspace, fs.realpathSync(cwd)))
    throw new Error('Execution blocked: Invalid network filesystem plan.');
  const current = resolveFilesystem(facts.options);
  if (JSON.stringify(current.mounts) !== JSON.stringify(facts.mounts) || JSON.stringify(plan.mounts) !== JSON.stringify(facts.mounts) ||
      JSON.stringify(plan.env) !== JSON.stringify(facts.env)) throw new Error('Execution blocked: Stale or modified network filesystem plan.');
  const protocol = require('./networkLaunchProtocol');
  const authority = protocol.consume(permit, { workspace: facts.workspace, cwd, command });
  if (typeof authority.resolver !== 'string' || !path.isAbsolute(authority.resolver) || inside(facts.workspace, fs.realpathSync(authority.resolver)) ||
      fs.readFileSync(authority.resolver, 'utf8') !== 'nameserver 10.0.2.3\noptions timeout:1 attempts:1\n')
    throw new Error('Execution blocked: Invalid managed network resolver.');
  const mounts = [...facts.mounts];
  mounts.splice(-2, 0, '--ro-bind', authority.resolver, '/etc/resolv.conf');
  const argv = [...protocol.PREFIX, ...mounts, '--clearenv', ...Object.entries(facts.env).flatMap(([key, value]) => ['--setenv', key, value]),
    '--chdir', cwd, '/usr/bin/python3', '-I', '-c', protocol.BOOTSTRAP, '/bin/sh', '-c', command];
  // Freeze both the envelope and argv before transport serialization. The
  // worker supplies its own pinned namespace handles, never caller PID paths.
  return Object.freeze({ file: '/usr/bin/bwrap', argv: Object.freeze(argv), env: Object.freeze({ ...facts.env }) });
}

module.exports = { networkShellInvocation, assertShellInvocation, buildSandboxMounts, resolveFilesystem, validateExtraPaths, environment, inside };
