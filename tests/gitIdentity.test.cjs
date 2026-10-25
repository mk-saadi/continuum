'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-identity-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => path.join(directory, 'userdata') } };
  return load.call(this, name, ...args);
};
const identity = require('../src/main/gitIdentity');
const store = require('../src/main/configStore');
const { runGit, executeCommand } = require('../src/main/tools/agentTools');
const git = (root, args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const host = path.join(directory, 'host'); fs.mkdirSync(host);
const hostEnv = { ...process.env, HOME: host, XDG_CONFIG_HOME: host, GIT_CONFIG_GLOBAL: '/must-not-be-used', GIT_AUTHOR_NAME: 'Ambient injection' };
const globalFile = path.join(host, '.gitconfig');
const globalIdentity = (name = '', email = '') => {
  fs.writeFileSync(globalFile, '');
  if (name) git(host, ['config', '--file', globalFile, 'user.name', name]);
  if (email) git(host, ['config', '--file', globalFile, 'user.email', email]);
  identity.initializeHostGitIdentity({ env: hostEnv });
};
function repo() {
  const root = fs.mkdtempSync(path.join(directory, 'repo-')); git(root, ['init', '-q']); return root;
}
function expectEnvironment(env, name, email) {
  assert.deepEqual(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
}
test.after(() => { Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

test('repo-local identity wins over app and global for author and committer', async () => {
  const root = repo(); globalIdentity('Global', 'global@example.test');
  store.saveConfig({ gitIdentity: { name: 'App', email: 'app@example.test' } });
  git(root, ['config', 'user.name', 'Local']); git(root, ['config', 'user.email', 'local@example.test']);
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'Local', 'local@example.test');
  await runGit(root, ['commit', '--allow-empty', '-m', 'local identity'], undefined, { write: true });
  assert.equal(git(root, ['log', '-1', '--format=%an|%ae|%cn|%ce']).trim(), 'Local|local@example.test|Local|local@example.test');
});

test('app identity persists and commits successfully without repo-local identity', async () => {
  const root = repo(); globalIdentity('Global', 'global@example.test');
  store.saveConfig({ gitIdentity: { name: ' App ', email: ' app@example.test ' } });
  assert.deepEqual(store.getConfig().gitIdentity, { name: 'App', email: 'app@example.test' });
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'App', 'app@example.test');
  await runGit(root, ['commit', '--allow-empty', '-m', 'app identity'], undefined, { write: true });
  assert.equal(git(root, ['log', '-1', '--format=%an|%ae|%cn|%ce']).trim(), 'App|app@example.test|App|app@example.test');
});

test('global identity is captured at launch outside sandbox and stays cached', async () => {
  const root = repo(); store.saveConfig({ gitIdentity: {} }); globalIdentity('Launch Global', 'global@example.test');
  git(host, ['config', '--file', globalFile, 'user.name', 'Changed after launch']);
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'Launch Global', 'global@example.test');
  await runGit(root, ['commit', '--allow-empty', '-m', 'global identity'], undefined, { write: true });
  assert.equal(git(root, ['log', '-1', '--format=%an|%ae|%cn|%ce']).trim(), 'Launch Global|global@example.test|Launch Global|global@example.test');
  const result = await executeCommand({ command: 'printf "%s|%s|%s|%s" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"' }, root, undefined, root);
  assert.equal(result.success, true, result.stderr);
  assert.equal(result.stdout, 'Launch Global|global@example.test|Launch Global|global@example.test');
});

test('identity fields fall back independently and local changes are read live', () => {
  const root = repo(); globalIdentity('Global', 'global@example.test');
  store.saveConfig({ gitIdentity: { name: 'App' } });
  git(root, ['config', 'user.email', 'local@example.test']);
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'App', 'local@example.test');
  git(root, ['config', 'user.name', 'New Local']);
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'New Local', 'local@example.test');
  git(root, ['config', '--unset', 'user.email']);
  expectEnvironment(identity.identityEnvironment(root, { required: true }), 'New Local', 'global@example.test');
});

test('missing identity fails commit clearly; inspection and non-git shell remain usable', async () => {
  const root = repo(); globalIdentity(); store.saveConfig({ gitIdentity: {} });
  assert.throws(() => identity.identityEnvironment(root, { required: true }), /Git identity is missing.*Settings/);
  await assert.rejects(runGit(root, ['commit', '--allow-empty', '-m', 'must not commit'], undefined, { write: true }), /Git identity is missing.*Settings/);
  assert.match(await runGit(root, ['status', '--porcelain=v1', '--branch']), /No commits yet/);
  const plain = path.join(directory, 'plain'); fs.mkdirSync(plain);
  const result = await executeCommand({ command: 'printf no-identity-needed' }, plain, undefined, plain);
  assert.equal(result.success, true, result.stderr); assert.equal(result.stdout, 'no-identity-needed');
  store.saveConfig({ gitIdentity: { name: 'Name only' } });
  await assert.rejects(runGit(root, ['commit', '--allow-empty', '-m', 'incomplete'], undefined, { write: true }), /Git identity is missing/);
});

test('settings reject invalid identity and keep the previous saved identity', () => {
  store.saveConfig({ gitIdentity: { name: 'Valid', email: 'valid@example.test' } });
  for (const value of [null, [], { name: 'bad\nname' }, { email: 'bad\0email' }, { name: 'bad <name>' }, { email: 1 }, { name: 'x'.repeat(321) }])
    assert.throws(() => store.saveConfig({ gitIdentity: value }), /Git identity|Invalid Git/);
  assert.deepEqual(store.getConfig().gitIdentity, { name: 'Valid', email: 'valid@example.test' });
});
