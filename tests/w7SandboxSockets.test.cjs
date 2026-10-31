'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const sandbox = require('../src/main/sandboxFilesystem');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-sockets-'));
const workspace = path.join(root, 'project');
const internal = path.join(workspace, '.llm_workspace');
const tmp = path.join(internal, 'sandbox/tmp');
const home = path.join(internal, 'sandbox/home');
fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(workspace, 'docs')); fs.writeFileSync(path.join(workspace, 'docs/example.md'), 'example\n');
fs.writeFileSync(path.join(workspace, 'pass.cjs'), "require('node:test')('works',()=>{});\n");
const opts = { workspace, home, tmp, config: { appDataDirectory: path.join(root, 'data') }, userData: path.join(root, 'userdata'), protectGitMetadata: true };
const socket = async (p, fn) => {
 fs.mkdirSync(path.dirname(p), { recursive: true });
 const server = net.createServer();
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, resolve); });
 try { await fn(); assert.ok(fs.lstatSync(p).isSocket()); }
 finally { await new Promise(resolve => server.close(resolve)); }
};
const argv = plan => ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--cap-drop', 'ALL', ...plan.mounts, '--setenv', 'PATH', plan.env.PATH, '--chdir', workspace, '/bin/sh', '-c', 'pwd'];
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('historical X77 and arbitrary hidden sockets remain intact; all exposed variants reject', async () => {
 for (const rel of ['sandbox/tmp/.X11-unix/X77', 'sandbox/home/other.sock', 'recovery/retained.sock']) {
  await socket(path.join(internal, rel), () => {
   assert.doesNotThrow(() => sandbox.resolveFilesystem(opts));
   const plan = sandbox.resolveFilesystem(opts);
   assert.ok(!plan.mounts.includes(tmp)); assert.ok(!plan.mounts.includes(home));
  });
 }
 for (const rel of ['root.sock', 'nested/deep/socket', '.git/socket', '.llm_workspace-other/socket', '.X11-unix/X77']) {
  await socket(path.join(workspace, rel), () => assert.throws(() => sandbox.resolveFilesystem(opts), /socket path is not permitted/));
 }
 await socket(path.join(workspace, 'traversal.sock'), () => assert.throws(() => sandbox.resolveFilesystem({ ...opts, workspace: path.join(workspace, 'docs/..') }), /socket path/));
});
test('symlink aliases cannot expose hidden sockets; reverse aliases do not skip exposed content', async () => {
 const alias = path.join(workspace, 'alias'); fs.symlinkSync(tmp, alias);
 try { await socket(path.join(tmp, 'hidden.sock'), () => assert.doesNotThrow(() => sandbox.resolveFilesystem(opts))); }
 finally { fs.unlinkSync(alias); }
 fs.symlinkSync(path.join(workspace, 'docs'), path.join(internal, 'outward'));
 await socket(path.join(workspace, 'docs/exposed.sock'), () => assert.throws(() => sandbox.resolveFilesystem(opts), /socket path/));
});
test('mount mismatch fails closed and late socket creation is rechecked before shell dispatch', async () => {
 assert.throws(() => sandbox.buildSandboxMounts({ system: [], etc: [], workspace, maskedPaths: [internal], askpassDirectory: tmp }), /unavailable/);
 const plan = sandbox.resolveFilesystem(opts);
 await socket(path.join(workspace, 'late.sock'), () => assert.throws(() => sandbox.assertShellInvocation(plan, { file: 'bwrap', argv: argv(plan), cwd: workspace, workspace }), /socket path/));
 const prior = sandbox.resolveFilesystem(opts);
 const moved = path.join(root, 'moved-internal'); fs.renameSync(internal, moved); fs.symlinkSync(moved, internal);
 try { assert.throws(() => sandbox.assertShellInvocation(prior, { file: 'bwrap', argv: argv(prior), cwd: workspace, workspace }), /unavailable/); }
 finally { fs.unlinkSync(internal); fs.renameSync(moved, internal); }
 const changed = sandbox.resolveFilesystem(opts); const args = argv(changed); args.splice(args.indexOf('--remount-ro'), 2);
 assert.throws(() => sandbox.assertShellInvocation(changed, { file: 'bwrap', argv: args, cwd: workspace, workspace }), /verified sandboxFilesystem/);
});
test('socket table traversal spelling cannot borrow an internal exclusion', () => {
 const original = fs.readFileSync;
 fs.readFileSync = function(p, ...args) {
  if (p === '/proc/net/unix') return `Num RefCount Protocol Flags Type St Inode Path\n000: 00000002 00000000 00010000 0001 01 123 ${internal}/../exposed.sock\n`;
  return original.call(this, p, ...args);
 };
 try { assert.throws(() => sandbox.resolveFilesystem(opts), /socket path is not permitted/); }
 finally { fs.readFileSync = original; }
});
test('real bubblewrap commands, Git inspection and isolated scratch with intact X77', async t => {
 await socket(path.join(tmp, '.X11-unix/X77'), async () => {
  cp.execFileSync('git', ['init', '-q', workspace]);
  cp.execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', 'docs', 'pass.cjs']);
  cp.execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  fs.symlinkSync(tmp, path.join(workspace, 'hidden-alias'));
  const plan = sandbox.resolveFilesystem(opts);
  const run = command => cp.spawnSync('bwrap', [...argv(plan).slice(0, -1), command], { env: plan.env, encoding: 'utf8', timeout: 15000 });
  const probe = run('true');
  if (probe.error || probe.status !== 0) { t.skip(`real bwrap unavailable: ${probe.stderr || probe.error}`); return; }
  for (const command of ['pwd', 'grep -rn example docs/', 'find docs/ -type f', 'node --version', 'node --test pass.cjs', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'test ! -e hidden-alias/.X11-unix/X77; test ! -e /tmp/.X11-unix/X77; test ! -e .llm_workspace/sandbox/tmp/.X11-unix/X77; echo isolated > /tmp/w7; echo isolated > "$HOME/w7"']) {
   const result = run(command); assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  assert.equal(run('test ! -e /tmp/w7; test ! -e "$HOME/w7"').status, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'w7')), false);
  const concurrent = value => new Promise((resolve, reject) => {
   cp.execFile('bwrap', [...argv(plan).slice(0, -1), `echo ${value} > /tmp/concurrent; node -e 'setTimeout(()=>{},100)'; test \"$(cat /tmp/concurrent)\" = ${value}`], { env: plan.env }, error => error ? reject(error) : resolve());
  });
  await Promise.all([concurrent('first'), concurrent('second')]);

 });
});
