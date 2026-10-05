const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveMode, guardTool, workspacePath, requestToolApproval } = require('../src/main/toolPermissions');

test('permission defaults and validation', () => {
  assert.equal(resolveMode(undefined, null), 'ask_approval');
  assert.equal(resolveMode(undefined, {}), 'workspace_write');
  assert.equal(resolveMode(undefined, { permissionMode: 'read_only' }), 'read_only');
  assert.throws(() => resolveMode('invalid', {}), /Invalid permission/);
});
test('read only denies mutations, commands and unknown tools regardless of arguments', async () => {
  for (const name of ['write_file', 'write_project_file', 'str_replace_editor', 'execute_command', 'save_memory', 'delete_file', 'execute_sql', 'approve_mcp_mutation']) {
    await assert.rejects(guardTool({ name, permissionMode: 'read_only', args: { user_confirmed: true } }), { message: 'Execution blocked: Chat is in Read Only mode.' });
  }
  await guardTool({ name: 'read_project_file', permissionMode: 'read_only' });
  for (const name of ['read_file', 'list_directory', 'search_code', 'take_screenshot'])
    await guardTool({ name, permissionMode: 'read_only' });
  await guardTool({ name: 'delegate_task', permissionMode: 'read_only' });
  await assert.rejects(guardTool({ name: 'read_project_file', native: false, permissionMode: 'read_only' }));
});
test('workspace guards traversal, sibling-prefix paths, symlinks and dangling symlinks', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-'));
  try {
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    await fs.mkdir(path.join(temp, 'project-other'));
    await fs.symlink(temp, path.join(root, 'escape'));
    await fs.symlink(path.join(temp, 'missing'), path.join(root, 'dangling'));
    assert.equal(await workspacePath(root, 'new/file.txt'), path.join(root, 'new/file.txt'));
    for (const value of ['../outside', '../project-other/file', 'escape/file', 'dangling/file']) await assert.rejects(workspacePath(root, value));
    await guardTool({ name: 'write_project_file', args: { relative_path: 'new/file' }, permissionMode: 'workspace_write', project: { root_path: root } });
    await guardTool({ name: 'take_screenshot', permissionMode: 'workspace_write', project: { root_path: root } });
    await assert.rejects(guardTool({ name: 'take_screenshot', permissionMode: 'workspace_write' }), /project root/);
    await fs.mkdir(path.join(root, '.llm_workspace'));
    await fs.symlink(temp, path.join(root, '.llm_workspace', 'screenshots'));
    await assert.rejects(guardTool({ name: 'take_screenshot', permissionMode: 'workspace_write', project: { root_path: root } }), /Symlink escapes/);
    await fs.rm(path.join(root, '.llm_workspace', 'screenshots'));
    for (const command of ['sudo true', 'apt install foo', 'npm install -g foo', 'pip install -g foo']) {
      await assert.rejects(guardTool({ name: 'execute_command', args: { command }, permissionMode: 'workspace_write', project: { root_path: root } }), /Global installations/);
    }
    await guardTool({ name: 'execute_command', args: { command: 'echo ok' }, permissionMode: 'workspace_write', project: { root_path: root } });
    for (const command of ['git init', 'git add .', 'git commit -m test', 'git status', 'git diff', 'git branch'])
      await guardTool({ name: 'execute_command', args: { command }, permissionMode: 'workspace_write', project: { root_path: root } });
    await assert.rejects(guardTool({ name: 'execute_command', args: { command: 'echo ok', cwd: '..' }, permissionMode: 'workspace_write', project: { root_path: root } }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('ask approval waits, denies and does not trust user_confirmed', async () => {
  for (const name of ['execute_command', 'delete_file', 'save_memory', 'execute_sql']) {
    let requested = false;
    await guardTool({ name, permissionMode: 'ask_approval', requestApproval: async () => { requested = true; return true; } });
    assert.equal(requested, true);
    await assert.rejects(guardTool({ name, args: { user_confirmed: true }, permissionMode: 'ask_approval', requestApproval: async () => false }), /approval denied/);
  }
  await guardTool({ name: 'execute_command', permissionMode: 'full_access', requestApproval: () => { throw new Error('must not ask'); } });
});
test('approval IDs are one-use and cancellation settles pending requests', async () => {
  const events = [];
  const sender = { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, ...payload }) };
  const controller = new AbortController();
  const pending = requestToolApproval({ controller, sender, requestId: 'turn', sessionId: 'chat', name: 'execute_command', args: { command: 'pwd' } });
  assert.equal(events[0].channel, 'engine:request-tool-approval');
  const id = events[0].approvalId;
  controller.toolApprovals.get(id)(true);
  assert.equal(await pending, true);
  assert.equal(controller.toolApprovals.has(id), false);
  const cancelled = requestToolApproval({ controller, sender, requestId: 'turn', name: 'delete_file', args: {} });
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(controller.toolApprovals.size, 0);
});
