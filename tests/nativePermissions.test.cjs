const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
let project;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if ((name === '../db' || name === './db') && args[0]?.filename.includes(`${path.sep}src${path.sep}main${path.sep}`)) {
    return { db: { prepare: () => ({ get: () => project }) } };
  }
  return originalLoad.call(this, name, ...args);
};
const { executeAgentTool } = require('../src/main/tools/agentTools');

test('native tool guard prevents writes and model self-approval, full access can write outside root', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'native-permissions-'));
  try {
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    project = { root_path: root };
    const run = (name, args, mode) => executeAgentTool({ name, arguments: args, sessionId: 'test', permissionMode: mode });
    const blocked = await run('write_project_file', { relative_path: 'blocked.txt', content: 'no' }, 'read_only');
    assert.equal(blocked.error, 'Execution blocked: Chat is in Read Only mode.');
    // A system-affecting command must request approval; the model cannot grant
    // its own, so nothing runs and nothing is written.
    const unapproved = await run('execute_command', { command: 'sudo touch blocked.txt', user_confirmed: true }, 'ask_approval');
    assert.equal(unapproved.success, false);
    assert.match(unapproved.error, /approval denied/);
    await assert.rejects(fs.stat(path.join(root, 'blocked.txt')));
    assert.equal((await run('write_project_file', { relative_path: '../outside.txt', content: 'no' }, 'workspace_write')).success, false);
    assert.equal((await run('write_project_file', { relative_path: '../outside.txt', content: 'yes' }, 'full_access')).success, true);
    assert.equal(await fs.readFile(path.join(temp, 'outside.txt'), 'utf8'), 'yes');
    const command = await run('execute_command', { command: 'printf autonomous' }, 'full_access');
    assert.equal(command.stdout, 'autonomous');
    if (process.platform === 'linux') {
      const git = await run('execute_command', {
        command: 'git init -q && git config user.email test@example.com && git config user.name Test && printf safe > tracked.txt && git add tracked.txt && git commit -qm first && git status --short && git diff HEAD && git branch --show-current',
      }, 'workspace_write');
      assert.equal(git.exitCode, 0, git.stderr);
      assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'safe');
      // $HOME and /tmp are workspace-local and writable inside the sandbox.
      const env = await run('execute_command', { command: 'echo "$HOME|$TMPDIR"' }, 'workspace_write');
      assert.equal(env.exitCode, 0, env.stderr);
      assert.deepEqual(env.stdout.trim().split('|'), [
        path.join(root, '.llm_workspace', 'sandbox', 'home'),
        path.join(root, '.llm_workspace', 'sandbox', 'tmp'),
      ]);
      const writable = await run('execute_command', { command: 'touch "$HOME/marker" "$TMPDIR/marker"' }, 'workspace_write');
      assert.equal(writable.exitCode, 0, writable.stderr);
      await fs.stat(path.join(root, '.llm_workspace', 'sandbox', 'home', 'marker'));
      await fs.stat(path.join(root, '.llm_workspace', 'sandbox', 'tmp', 'marker'));
      await assert.rejects(fs.stat(path.join(os.tmpdir(), 'marker')), /ENOENT/, 'sandbox /tmp is not the host /tmp');
    }
    // The boundary is the sandbox, not shell-string matching: an absolute
    // write to a host path outside the workspace fails and touches nothing.
    const outside = path.join(os.homedir(), `native-escape-${process.pid}.txt`);
    const escaped = await run('execute_command', { command: `printf escaped > ${outside}` }, 'workspace_write');
    assert.notEqual(escaped.exitCode, 0);
    await assert.rejects(fs.stat(outside), 'the host outside the workspace stays untouched');
    // A relative `..` write never reaches the host outside the workspace.
    // When the workspace itself lives under /tmp, `..` resolves into the
    // sandbox's writable /tmp overlay, which is workspace-local on the host.
    await run('execute_command', { command: 'printf escaped > ../escaped.txt' }, 'workspace_write');
    await assert.rejects(fs.stat(path.join(temp, 'escaped.txt')));
  } finally { await fs.rm(temp, { recursive: true, force: true }); Module._load = originalLoad; }
});
