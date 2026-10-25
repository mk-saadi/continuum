'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const { buildSandboxMounts, resolveFilesystem, validateExtraPaths, environment } = require('../src/main/sandboxFilesystem');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-filesystem-'));
const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
const data = path.join(workspace, 'private-data'); fs.mkdirSync(data);
for (const p of ['memory_palace.db', 'memory_palace.db-wal']) fs.writeFileSync(path.join(data, p), 'synthetic-secret');
const internal = path.join(workspace, '.llm_workspace'); fs.mkdirSync(internal);
fs.writeFileSync(path.join(internal, 'private'), 'synthetic-secret');
const home = path.join(internal, 'sandbox/home'), tmp = path.join(internal, 'sandbox/tmp');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
const config = { appDataDirectory: data };
const options = { workspace, config, userData: path.join(directory, 'userdata'), home, tmp };
const launch = (plan, command, offline = false) => cp.spawnSync('/usr/bin/bwrap', ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', ...(offline ? ['--unshare-net'] : []), ...plan.mounts, '--chdir', workspace, '/bin/sh', '-ec', command], { env: plan.env, encoding: 'utf8', timeout: 15000 });
function available(t, offline = false) {
  const r = launch(resolveFilesystem(options), 'true', offline);
  if (r.error || r.status !== 0) { t.skip(`bwrap namespaces unavailable: ${r.stderr || r.error?.code}`); return false; }
  return true;
}
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
test('pure mount builder starts empty, preserves symlinks and masks after workspace before scratch', () => {
  const a = buildSandboxMounts({ system: [{ source: '/usr', destination: '/usr' }, { source: '/usr/bin', destination: '/bin', symlink: true }], etc: [], workspace: '/w', maskedPaths: ['/w/data', '/w/.llm_workspace'], home: '/w/.llm_workspace/sandbox/home', tmp: '/w/.llm_workspace/sandbox/tmp' });
  assert.deepEqual(a.slice(0, 2), ['--tmpfs', '/']);
  assert.ok(!a.join(' ').includes('--ro-bind / /'));
  assert.ok(a.join(' ').includes('--symlink /usr/bin /bin'));
  assert.ok(a.indexOf('/w/data') > a.indexOf('/w'));
  assert.ok(a.lastIndexOf('/sandbox-home') > a.indexOf('/w/.llm_workspace'));
  assert.ok(a.includes('--remount-ro'));
});
test('network profile adds only hosts/resolver; offline omits them; no host root/run/mnt/media/home bind', () => {
  for (const network of [false, true]) {
    const a = resolveFilesystem({ ...options, network }).mounts;
    assert.equal(a.includes('/etc/resolv.conf'), network);
    assert.equal(a.includes('/etc/hosts'), network);
    for (let i = 0; i < a.length; i++) if (['--bind', '--ro-bind'].includes(a[i])) {
      assert.ok(!['/', '/etc', '/home', os.homedir(), '/run', '/mnt', '/media'].includes(a[i + 1]));
    }
  }
});
test('runtime settings reject root, home, credential directories, data overlaps and missing paths', () => {
  for (const p of ['/', os.homedir(), data, workspace, '/run', '/path/does-not-exist']) assert.throws(() => validateExtraPaths([p], { maskedPaths: [data] }), /required runtime path unavailable/);
  assert.deepEqual(validateExtraPaths(['/usr/bin'], { maskedPaths: [data] }), ['/usr/bin']);
});
test('environment allowlist strips ambient secrets and executable injection controls', () => {
  const e = environment({ PATH: '/evil', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', TZ: 'UTC', NODE_OPTIONS: '--require evil', NPM_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', SSH_AUTH_SOCK: '/run/socket', GIT_CONFIG_COUNT: '1' });
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR', 'TZ']);
  assert.equal(e.PATH, '/usr/local/bin:/usr/bin:/bin');
});
test('workspace socket refuses setup before any process launch', async () => {
  const socket = path.join(workspace, 'fixture.sock'); const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  try { assert.throws(() => resolveFilesystem(options), /socket path is not permitted/); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('real contained filesystem hides synthetic secrets, aliases and proc tricks; workspace and scratch writable', t => {
  if (!available(t)) return;
  const outside = path.join(directory, 'host-home'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret'), 'synthetic-secret');
  fs.symlinkSync(outside, path.join(workspace, 'alias'));
  for (const name of ['.ssh', '.aws', '.config', '.gnupg', 'browser-profile', 'etc', 'mnt', 'run']) {
    fs.mkdirSync(path.join(outside, name)); fs.writeFileSync(path.join(outside, name, 'secret'), 'synthetic-secret');
  }
  fs.writeFileSync(path.join(workspace, '.env'), 'PROJECT_SECRET=legitimate');
  for (const network of [false, true]) {
    const plan = resolveFilesystem({ ...options, network });
    const r = launch(plan, `test ! -e '${outside}/secret'; test ! -e alias/secret; test ! -e private-data/memory_palace.db; test ! -e private-data/memory_palace.db-wal; test ! -e .llm_workspace/private; test ! -e /proc/self/root${outside}/secret; test ! -e /proc/${process.pid}/root; test ! -e /run; test ! -e /mnt; test ! -e /media; test ! -e /etc/shadow; test -r .env; echo ok > written; echo ok > "$HOME/test"; echo ok > /tmp/test; test -r /etc/ssl/certs/ca-certificates.crt; node -e 'console.log("node-ok")'; python3 -c 'print("python-ok")'; git --version; npm --version; locale`, !network);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /node-ok/); assert.match(r.stdout, /python-ok/);
  }
});
test('nvm-style installation binds resolved prefix, not the rest of home', () => {
  const fakeHome = path.join(directory, 'fake-home'); const prefix = path.join(fakeHome, '.nvm/versions/node/v1');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true }); fs.writeFileSync(path.join(prefix, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const plan = resolveFilesystem({ ...options, hostEnv: { PATH: `${prefix}/bin:/usr/bin:/bin` } });
  assert.ok(plan.mounts.includes(prefix)); assert.ok(!plan.mounts.includes(fakeHome));
});
test('offline profile cannot reach host listener and never falls back', async t => {
  if (!available(t, true)) return;
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  try {
    const port = server.address().port;
    const lan = Object.values(os.networkInterfaces()).flat().find(x => x.family === 'IPv4' && !x.internal)?.address;
    const r = launch(resolveFilesystem(options), `node -e 'const s=require("net").connect(${port}, "127.0.0.1"); s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),500)'`, true);
    assert.equal(r.status, 0, r.stderr);
    if (lan) {
      const l = launch(resolveFilesystem(options), `node -e 'const s=require("net").connect(${port}, "${lan}"); s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),500)'`, true);
      assert.equal(l.status, 0, l.stderr);
    }
  } finally { server.close(); }
});
test('invalid required runtime input fails before spawn', () => {
  assert.throws(() => resolveFilesystem({ ...options, config: { ...config, extraReadOnlyRuntimePaths: ['/not/a/runtime'] } }), /required runtime path unavailable/);
});

test('Volta resolver binds actual image and leaves shim/home unmounted', () => {
  const volta = path.join(directory, 'volta-home/.volta/bin'), image = path.join(directory, 'volta-home/.volta/tools/image/node/22');
  fs.mkdirSync(volta, { recursive: true }); fs.mkdirSync(path.join(image, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(volta, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(volta, 'volta'), `#!/bin/sh\nprintf '%s\\n' '${image}/bin/node'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(image, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const plan = resolveFilesystem({ ...options, hostEnv: { PATH: `${volta}:/usr/bin:/bin` } });
  assert.ok(plan.mounts.includes(image)); assert.ok(!plan.mounts.includes(volta));
});

test('nested protected data masks collapse before scratch rebinds', t => {
  const nested = path.join(internal, 'app-data'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'memory_palace.db'), 'synthetic-secret');
  if (!available(t)) return;
  const plan = resolveFilesystem({ ...options, config: { appDataDirectory: nested } });
  const r = launch(plan, 'test ! -e .llm_workspace/app-data/memory_palace.db; echo ok > "$HOME/nested-test"; echo ok > /tmp/nested-test', true);
  assert.equal(r.status, 0, r.stderr);
});

test('active filesystem sockets in admitted system runtime trees reject setup', () => {
  const original = fs.readFileSync;
  fs.readFileSync = function(p, ...args) {
    if (p === '/proc/net/unix') return 'Num RefCount Protocol Flags Type St Inode Path\n000: 00000002 00000000 00010000 0001 01 123 /usr/local/runtime-service.sock\n';
    return original.call(this, p, ...args);
  };
  try { assert.throws(() => resolveFilesystem(options), /socket path is not permitted: \/usr\/local/); }
  finally { fs.readFileSync = original; }
});

test('shell metadata mounts follow workspace; native profile stays writable; init is discovered next time', t => {
  const repo = path.join(directory, 'git-project'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(repo, 'file'), 'one'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  const opts = { ...options, workspace: repo, protectGitMetadata: true };
  const plan = resolveFilesystem(opts), marker = path.join(repo, '.git');
  assert.ok(plan.mounts.join(' ').includes(`--bind ${repo} ${repo} --ro-bind ${marker} ${marker}`));
  assert.ok(!resolveFilesystem({ ...opts, protectGitMetadata: false }).mounts.includes(marker));
  const run = command => cp.spawnSync('/usr/bin/bwrap', ['--die-with-parent', '--unshare-user', '--unshare-net', ...plan.mounts, '--chdir', repo, '/bin/sh', '-ec', command], { env: { ...plan.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' });
  const probe = run('true');
  if (probe.status !== 0) { t.skip(`bwrap unavailable: ${probe.stderr}`); return; }
  for (const command of ['git status', 'git diff', 'git log', 'git show']) assert.equal(run(command).status, 0, command);
  for (const command of ['rm -rf .git', 'echo bad > .git/config', 'echo bad > .git/hooks/evil', 'git commit --allow-empty -m blocked']) assert.notEqual(run(command).status, 0, command);
});
