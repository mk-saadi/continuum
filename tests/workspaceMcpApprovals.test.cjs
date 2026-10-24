'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardTool } = require('../src/main/toolPermissions');
const { requiresGitApproval } = require('../src/main/mcpPermissionPolicy');
const { McpManager } = require('../src/main/mcpManager');
const permissions = require('../src/main/toolPermissions');
const project = { root_path: process.cwd() };

test('Workspace Write manages configured MCP servers without approval prompts', async () => {
  for (const action of ['search', 'inspect', 'activate', 'enable', 'disable', 'restart']) {
    const result = await guardTool({ name: 'manage_mcp_servers', args: { action, server_names: ['custom'], tool_names: ['read'] },
      permissionMode: 'workspace_write', project,
      requestApproval: () => assert.fail('Unexpected MCP management prompt') });
    assert.equal(result.approved, false);
  }
});

test('Workspace Write uses MCP tools autonomously, Ask for Approval still prompts', async () => {
  for (const name of ['browser_navigate', 'query', 'write_file']) {
    await guardTool({ name, args: { query: 'SELECT * FROM records' }, native: false, permissionMode: 'workspace_write', project,
      requestApproval: () => assert.fail('Unexpected MCP tool prompt') });
  }
  let prompts = 0;
  await guardTool({ name: 'browser_navigate', native: false, permissionMode: 'ask_approval', project,
    requestApproval: () => { prompts++; return true; } });
  assert.equal(prompts, 1);
  await assert.rejects(guardTool({ name: 'write_file', native: false, permissionMode: 'read_only', project }), /blocked/);
});

test('Git commits and publishing through MCP still require approval', async () => {
  for (const [name, args, serverName] of [
    ['git_commit', {}, 'git'], ['git_push', {}, 'git'], ['push_files', {}, 'github'],
    ['create_or_update_file', {}, 'github'], ['delete_file', {}, 'github'],
    ['run_command', { command: 'git push origin main' }, 'terminal'],
    ['request', { method: 'PUT', url: 'https://api.github.com/repos/o/r/contents/file' }, 'http'],
  ]) {
    assert.equal(requiresGitApproval(name, args, serverName), true);
    let prompts = 0;
    await assert.rejects(guardTool({ name, args, serverName, native: false, permissionMode: 'workspace_write', project,
      requestApproval: () => { prompts++; return false; } }), /approval denied/);
    assert.equal(prompts, 1);
  }
  for (const name of ['list_commits', 'get_commit', 'browser_navigate', 'write_file']) assert.equal(requiresGitApproval(name), false);
});

test('Workspace Write MCP dispatch skips the generic SQL mutation challenge but keeps Git approval', async () => {
  const previousProject = permissions.sessionProject;
  permissions.sessionProject = () => project;
  const manager = new McpManager();
  let calls = 0;
  manager.servers.set('custom', { enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'query' }, { name: 'push_files' }],
    client: { callTool: async () => { calls++; return { content: [] }; } } });
  try {
    await manager.callTool('custom', 'query', { query: 'SELECT * FROM records' }, { sessionId: 'workspace-mcp', permissionMode: 'workspace_write' });
    assert.equal(calls, 1);
    await assert.rejects(manager.callTool('custom', 'push_files', {}, { sessionId: 'workspace-mcp', permissionMode: 'workspace_write', permissionGranted: true }), /requires explicit approval/);
    assert.equal(calls, 1);
    await manager.callTool('custom', 'push_files', {}, { sessionId: 'workspace-mcp', permissionMode: 'workspace_write', permissionGranted: true,
      approval: { mode: 'workspace_write', approved: true } });
    assert.equal(calls, 2);
  } finally { permissions.sessionProject = previousProject; }
});

test('Full Access retains ordinary tool access and requires protected execution approval', async () => {
  for (const [name, args, native] of [
    ['manage_mcp_servers', { action: 'inspect', server_names: ['custom'] }, true],

    ['delete_project_file', { path: 'file' }, true], ['generate_image', {}, true],
 ['query', { query: 'SELECT * FROM records' }, false],
  ]) {
    const result = await guardTool({ name, args, native, permissionMode: 'full_access', project,
      requestApproval: () => assert.fail(`Unexpected Full Access approval for ${name}`) });
    assert.equal(result.mode, 'full_access');
  }
  for (const [name,args,native] of [['git_commit',{message:'Commit'},true],['execute_command',{command:'printf opaque'},true],['git_sync',{action:'push'},true],['push_files',{},false]]) {
    await assert.rejects(guardTool({name,args,native,permissionMode:'full_access',project,requestApproval:()=>false}),/approval denied/);
  }
});

test('Full Access MCP dispatch bypasses mutation challenges even without an outer grant', async () => {
  const previousProject = permissions.sessionProject;
  permissions.sessionProject = () => project;
  const manager = new McpManager();
  let calls = 0;
  manager.servers.set('custom', { enabled: true, status: 'connected', disabledTools: new Set(),
    tools: [{ name: 'query' }, { name: 'push_files' }],
    client: { callTool: async () => { calls++; return { content: [] }; } } });
  try {
    for (const sessionId of [undefined, 'full-access-mcp']) {
      await manager.callTool('custom', 'query', { query: 'SELECT * FROM records' }, { sessionId, permissionMode: 'full_access' });
      await assert.rejects(manager.callTool('custom', 'push_files', {}, { sessionId, permissionMode: 'full_access' }), /approval/);
    }
    assert.equal(calls, 2);
  } finally { permissions.sessionProject = previousProject; }
});

test('external deletion requires explicit approval in every writable mode', async () => {
  for (const permissionMode of ['workspace_write', 'ask_approval', 'full_access']) {
    let prompts = 0;
    const options = { name: 'delete_project_file', args: { path: 'obsolete.txt' }, native: false, permissionMode, project,
      requestApproval: () => { prompts++; return true; } };
    const result = await guardTool(options);
    assert.equal(prompts, 1);
    assert.equal(result.approved, true);
    if (permissionMode !== 'full_access') {
      await assert.rejects(guardTool({ ...options, requestApproval: () => false }), /approval denied/);
    }
  }
});

test('MCP deletion dispatch enforces approval even when outer permission is granted', async () => {
  const recovery = require('../src/main/recoveryBoundary');
  const previousScan = recovery.shouldScanMcpCall;
  recovery.shouldScanMcpCall = async () => false;
  const previousProject = permissions.sessionProject;
  permissions.sessionProject = () => project;
  const manager = new McpManager();
  let calls = 0;
  manager.servers.set('custom', { enabled: true, status: 'connected', disabledTools: new Set(),
    tools: [{ name: 'delete_project_file' }],
    client: { callTool: async () => { calls++; return { content: [] }; } } });
  try {
    for (const permissionMode of ['workspace_write', 'ask_approval']) {
      const options = { sessionId: 'delete-mcp', permissionMode, permissionGranted: true };
      await assert.rejects(manager.callTool('custom', 'delete_project_file', {}, options), /File deletion requires explicit approval/);
      await manager.callTool('custom', 'delete_project_file', {}, { ...options, approval: { mode: permissionMode, approved: true } });
    }
    await assert.rejects(manager.callTool('custom', 'delete_project_file', {}, { sessionId: 'delete-mcp', permissionMode: 'full_access' }), /approval denied/);
    await manager.callTool('custom', 'delete_project_file', {}, { sessionId: 'delete-mcp', permissionMode: 'full_access', permissionGranted: true, approval: {mode:'full_access',approved:true} });
    assert.equal(calls, 3);
  } finally { permissions.sessionProject = previousProject; recovery.shouldScanMcpCall = previousScan; }
});
