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
    assert.equal((await run('execute_command', { command: 'touch blocked.txt', user_confirmed: true }, 'ask_approval')).success, false);
    await assert.rejects(fs.stat(path.join(root, 'blocked.txt')));
    assert.equal((await run('write_project_file', { relative_path: '../outside.txt', content: 'no' }, 'workspace_write')).success, false);
    assert.equal((await run('write_project_file', { relative_path: '../outside.txt', content: 'yes' }, 'full_access')).success, true);
    assert.equal(await fs.readFile(path.join(temp, 'outside.txt'), 'utf8'), 'yes');
    const command = await run('execute_command', { command: 'printf autonomous' }, 'full_access');
    assert.equal(command.stdout, 'autonomous');
    const sandbox = await run('execute_command', { command: 'printf escaped > ../escaped.txt' }, 'workspace_write');
    assert.notEqual(sandbox.exitCode, 0);
    await assert.rejects(fs.stat(path.join(temp, 'escaped.txt')));
  } finally { await fs.rm(temp, { recursive: true, force: true }); Module._load = originalLoad; }
});
