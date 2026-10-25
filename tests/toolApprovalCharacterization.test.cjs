'use strict';
// Frozen against 6cd2600 BEFORE the policy extraction. Regenerate only when
// intentionally changing behavior, never as part of a refactor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-profile-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => profileRoot } };
  return originalLoad.call(this, name, ...args);
};
test.after(() => { Module._load = originalLoad; fs.rmSync(profileRoot, { recursive: true, force: true }); });
const { guardTool } = require('../src/main/toolPermissions');
const { agentTools } = require('../src/main/tools/agentTools');
const { McpManager } = require('../src/main/mcpManager');
const fixture = path.join(__dirname, 'fixtures/toolApprovalCharacterization.json');

async function characterize() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-characterization-'));
  const db = require('../src/main/db'); db.initDatabase(profileRoot);
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
  } finally { db.closeDatabase(); fs.rmSync(temp, { recursive: true, force: true }); }
}

test('real guard and MCP dispatch retain frozen decisions except intentional Workspace Write changes', async () => {
  const actual = await characterize();
  if (process.env.RECORD_WORKSPACE_PHASE2 === '1') {
    const expected = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    for (const id of Object.keys(expected.workspace_write)) if (phase2Row(id)) expected.workspace_write[id] = actual.workspace_write[id];
    assert.deepEqual(actual, expected, 'Recording must never change other modes or unlisted tools');
    fs.writeFileSync(fixture, JSON.stringify(expected, null, 2) + '\n');
  }
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(fixture, 'utf8')));
});

function phase2Row(id) {
  return /^(?:execute_command|run_tests|git_stage|git_unstage|git_create_branch|git_switch|git_stash|git_commit|git_sync|delete_project_file)(?::|$)/.test(id) || id.startsWith('shell:');
}

test('Phase 1 non-workspace fixture sections remain byte-identical', () => {
  const { createHash } = require('node:crypto');
  const source = fs.readFileSync(fixture, 'utf8');
  const keys = Object.keys(JSON.parse(source));
  const hashes = {
    "ask_approval": "5f3befca4ebb4a7edc31ad0a676a357cd3b3609730f6894a1c193441d3ef13e5",
    "read_only": "201fdd02d102d0770ff2d9f3d92c95ddfaf5923a67aae90668f07751350a740f",
    "full_access": "89a3931e688a07af77cb4d75f129794fa9dc7f0ac2b7c3ff025d5e095e62e756",
    "casual": "7f5f20839e93774bf200e600e401119368b953fe9e1f83782bf93ffc511ae607",
    "dispatch": "fa1db9757b84e53a9347dd25040dae5b6522dc3eb7e3920479f30e596c3d2a9e"
};
  for (const [mode, expected] of Object.entries(hashes)) {
    const start = source.indexOf(`  "${mode}": {`);
    const next = keys[keys.indexOf(mode) + 1];
    const end = next ? source.indexOf(`  "${next}": {`) : source.length;
    assert.equal(createHash('sha256').update(source.slice(start, end)).digest('hex'), expected, mode);
  }
});

test('Workspace Write rows for unlisted tools remain frozen', () => {
  const { createHash } = require('node:crypto');
  const rows = JSON.parse(fs.readFileSync(fixture, 'utf8')).workspace_write;
  const unchanged = Object.fromEntries(Object.entries(rows).filter(([id]) => !phase2Row(id)));
  assert.equal(createHash('sha256').update(JSON.stringify(unchanged, null, 2)).digest('hex'), "de2081a004e4d6657c4e8d0169049b80172d083bb363cecb4bd53197315fa01e");
});
