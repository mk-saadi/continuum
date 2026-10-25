'use strict';
// Frozen against 6cd2600 BEFORE the policy extraction. Regenerate only when
// intentionally changing behavior, never as part of a refactor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { guardTool } = require('../src/main/toolPermissions');
const { agentTools } = require('../src/main/tools/agentTools');
const { McpManager } = require('../src/main/mcpManager');
const fixture = path.join(__dirname, 'fixtures/toolApprovalCharacterization.json');

async function characterize() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-characterization-'));
  const root = path.join(temp, 'project');
  fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Initial']);
  git(['init', '--bare', path.join(root, 'remote.git')]);
  git(['remote', 'add', 'origin', path.join(root, 'remote.git')]);
  fs.writeFileSync(path.join(root, 'file.txt'), 'fixture\n');
  git(['add', 'file.txt']);
  fs.symlinkSync(temp, path.join(root, 'escape'));
  const args = { command: 'printf fixture', path: 'file.txt', relative_path: 'file.txt',
    source_path: 'file.txt', destination_path: 'moved.txt', paths: ['file.txt'], message: 'Fixture commit', action: 'list' };
  const names = [...new Set([
    ...agentTools.map(t => t.function.name), 'save_memory', 'search_memory', 'read_file', 'write_file',
    'edit_file', 'delete_file', 'list_directory', 'search_code', 'delegate_task', 'unknown_tool',
  ])].sort();
  const cases = names.map(name => ({ id: name, name, args }));
  for (const action of ['fetch', 'pull', 'push', 'invalid']) cases.push({ id: `git_sync:${action}`, name: 'git_sync', args: { action } });
  for (const action of ['list', 'show', 'push', 'drop', 'clear']) cases.push({ id: `git_stash:${action}`, name: 'git_stash', args: { action } });
  for (const [id, name, extra] of [
    ['shell:outside', 'execute_command', { cwd: '..' }],
    ['shell:system', 'execute_command', { command: 'sudo true' }],
    ['shell:install', 'execute_command', { command: 'npm install fixture' }],
    ['shell:invalid', 'execute_command', { command: '' }],
    ['shell:oversized', 'execute_command', { command: 'x'.repeat(4001) }],
    ['write:outside', 'write_project_file', { relative_path: '../outside' }],
    ['write:symlink', 'write_project_file', { relative_path: 'escape/outside' }],
    ['delete:missing', 'delete_project_file', { path: 'missing' }],
  ]) cases.push({ id, name, args: { ...args, ...extra } });
  for (const [name, a, serverName = 'custom'] of [
    ['read_records', {}], ['write_file', { path: 'file', content: 'hello' }], ['send_message', { text: 'hello' }],
    ['publish', {}], ['read_records', { script: 'return 1' }], ['delete_project_file', { path: 'file.txt' }],
    ['delete_file', { path: 'file.txt' }], ['push_files', {}, 'github'], ['get_data', { action: 'custom' }],
    ['unknown', {}], ['query', { query: 'UPDATE records SET value=1' }], ['query', { query: 'SELECT * FROM records' }],
  ]) cases.push({ id: `mcp:${name}:${JSON.stringify(a)}`, name, args: a, native: false, serverName });
  const rows = {};
  try {
    for (const context of ['workspace_write', 'ask_approval', 'read_only', 'full_access', 'casual']) {
      rows[context] = {};
      for (const c of cases) {
        const prompts = [];
        let row;
        try {
          const result = await guardTool({ ...c, permissionMode: context === 'casual' ? undefined : context,
            project: context === 'casual' ? null : { root_path: root },
            requestApproval: payload => { prompts.push(payload); return true; } });
          row = { decision: prompts.length ? 'ask' : 'allow', prompts: prompts.length, mode: result.mode, approved: result.approved,
            ...(Object.hasOwn(result, 'commandUncontained') ? { commandUncontained: result.commandUncontained } : {}),
            fingerprints: ['gitCommitFingerprint', 'gitPushFingerprint', 'deleteFingerprint'].filter(k => result[k]),
            promptActions: prompts.map(p => p.args.action ?? null) };
        } catch (error) { row = { decision: 'block', message: error.message, prompts: prompts.length }; }
        rows[context][c.id] = row;
      }
    }
    // Also freeze the independent MCP dispatch backstop (without outer guard).
    rows.dispatch = {};
    for (const mode of ['workspace_write', 'ask_approval', 'read_only', 'full_access', undefined]) {
      for (const c of cases.filter(c => c.native === false)) {
        const manager = new McpManager();
        manager.servers.set(c.serverName, { enabled: true, status: 'connected', disabledTools: new Set(),
          tools: [{ name: c.name }], client: { callTool: async () => ({ content: [] }) } });
        try { await manager.callTool(c.serverName, c.name, c.args, { permissionMode: mode });
          rows.dispatch[`${mode}:${c.id}`] = { decision: 'allow' };
        } catch (error) { rows.dispatch[`${mode}:${c.id}`] = { decision: 'block', message: error.message.replace(/hash [a-f0-9]+/, 'hash <HASH>') }; }
      }
    }
    return rows;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

test('real guard and MCP dispatch retain every pre-refactor decision', async () => {
  const actual = await characterize();
  if (process.env.RECORD_APPROVAL_CHARACTERIZATION === '1') fs.writeFileSync(fixture, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(fixture, 'utf8')));
});
