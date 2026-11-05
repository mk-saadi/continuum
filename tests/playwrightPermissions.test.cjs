'use strict';
// Trusted bundled Playwright: read-only page operations auto-approve in every
// permission mode and chat context, while side-effecting operations keep the
// mode's existing approval gates. Read-only approval never widens to clicks,
// and trust binds the exact launch configuration only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { McpManager } = require('../src/main/mcpManager');
const { nativePlaywrightConfig, isTrustedNativePlaywright } = require('../src/main/nativePlaywright');
const { guardTool } = require('../src/main/toolPermissions');
const { decideToolApproval } = require('../src/main/toolApprovalPolicy');

const MODES = ['read_only', 'ask_approval', 'workspace_write', 'full_access'];
const PROJECTS = [null, { root_path: process.cwd() }];
const READ_ONLY_OPS = [
  ['browser_navigate', { url: 'http://localhost:5173/' }],
  ['browser_snapshot', {}],
];
// Production @playwright/mcp derives annotations from the tool type:
// action-typed tools declare destructiveHint, read-only tools readOnlyHint.
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const tools = [
  { name: 'browser_navigate', description: 'Navigate to a page', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: DESTRUCTIVE },
  { name: 'browser_snapshot', description: 'Inspect page accessibility', inputSchema: { type: 'object', properties: {} }, annotations: READ_ONLY },
  { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: {} }, annotations: DESTRUCTIVE },
];

async function fixture(definition) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-perm-'));
  const manager = new McpManager({ configPath: path.join(directory, 'mcp.json'), lazyByDefault: true,
    createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools }),
      callTool: async name => ({ content: [{ type: 'text', text: `${name} executed` }] }),
      async close() { this.onclose?.(); } }) });
  await manager.saveConfig({ mcpServers: { 'playwright-native': definition } });
  await manager.manageServers('enable', ['playwright-native'], 'browser-chat');
  return { manager, async close() { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('trusted read-only browser operations auto-approve in every mode and chat context', async () => {
  const f = await fixture(nativePlaywrightConfig());
  try {
    for (const [name, args] of READ_ONLY_OPS) {
      const facts = f.manager.getApprovalFacts('playwright-native', name);
      assert.equal(facts.trustedNativePlaywright, true, name);
      for (const project of PROJECTS) for (const permissionMode of MODES) {
        // Resolves without throwing and without ever calling requestApproval;
        // a denial would reject (Read Only blocks) rather than return.
        const approval = await guardTool({ name, args, native: false, project, permissionMode, ...facts,
          requestApproval: () => assert.fail(`${name} must not prompt`) });
        assert.equal(typeof approval.approved, 'boolean', `${name} ${permissionMode}`);
        assert.equal(require('../src/main/toolPermissions').isToolVisible(name, { native: false, project, permissionMode, ...facts }), true, `visible ${name} ${permissionMode}`);
      }
    }
  } finally { await f.close(); }
});

test('trusted side-effect browser operations: Read Only blocks, Ask prompts, Workspace Write and Full Access allow', async () => {
  const f = await fixture(nativePlaywrightConfig());
  try {
    const facts = f.manager.getApprovalFacts('playwright-native', 'browser_click');
    assert.equal(facts.trustedNativePlaywright, true);
    const project = { root_path: process.cwd() };
    // Read Only blocks the click outright: no prompt, no execution.
    await assert.rejects(guardTool({ name: 'browser_click', native: false, project, permissionMode: 'read_only', ...facts,
      requestApproval: () => assert.fail('Read Only must block, not prompt') }), /Read Only/);
    // Ask for Approval still prompts exactly once for the click.
    let prompts = 0;
    const approval = await guardTool({ name: 'browser_click', native: false, project, permissionMode: 'ask_approval', ...facts,
      requestApproval: async () => { prompts++; return true; } });
    assert.equal(prompts, 1);
    assert.equal(approval.approved, true);
    // Workspace Write and Full Access authorize side-effecting Playwright operations without a prompt.
    for (const permissionMode of ['workspace_write', 'full_access']) {
      let modePrompts = 0;
      await guardTool({ name: 'browser_click', native: false, project, permissionMode, ...facts,
        requestApproval: async () => { modePrompts++; return true; } });
      assert.equal(modePrompts, 0, permissionMode);
    }
    // Untrusted configuration produces the identical click behavior: read-only
    // trust never relaxes a side-effect gate.
    const untrusted = { ...facts, trustedNativePlaywright: false };
    await assert.rejects(guardTool({ name: 'browser_click', native: false, project, permissionMode: 'read_only', ...untrusted,
      requestApproval: () => assert.fail('Read Only must block, not prompt') }), /Read Only/);
    let untrustedPrompts = 0;
    await guardTool({ name: 'browser_click', native: false, project, permissionMode: 'ask_approval', ...untrusted,
      requestApproval: async () => { untrustedPrompts++; return true; } });
    assert.equal(untrustedPrompts, 1);
  } finally { await f.close(); }
});

test('dispatch backstop auto-allows trusted reads and Workspace Write clicks', () => {
  const base = { native: false, serverName: 'playwright-native', mode: 'workspace_write', workspaceMcp: true,
    workspaceRoot: process.cwd(), approved: false, stage: 'mcp_dispatch', serverTrusted: true, trustedNativePlaywright: true };
  const navigate = decideToolApproval({ ...base, tool: 'browser_navigate', args: { url: 'http://localhost:5173/' }, annotations: DESTRUCTIVE });
  assert.equal(navigate.decision, 'allow', JSON.stringify(navigate));
  const snapshot = decideToolApproval({ ...base, tool: 'browser_snapshot', args: {}, annotations: READ_ONLY });
  assert.equal(snapshot.decision, 'allow', JSON.stringify(snapshot));
  const click = decideToolApproval({ ...base, tool: 'browser_click', args: {}, annotations: DESTRUCTIVE });
  assert.equal(click.decision, 'allow', JSON.stringify(click));
  // Ask for Approval still prompts for clicks.
  const askBase = { ...base, mode: 'ask_approval' };
  const askClick = decideToolApproval({ ...askBase, tool: 'browser_click', args: {}, annotations: DESTRUCTIVE });
  assert.equal(askClick.decision, 'ask', JSON.stringify(askClick));
});

test('legacy stored Node-launch Playwright configuration is trusted after normalization', async () => {
  const expected = nativePlaywrightConfig();
  // Stored pre-resolution launch: host Node against the bundled CLI under a
  // stale AppImage mount. The browser executable path stays current.
  const legacy = { command: 'node',
    args: ['/tmp/.mount-Continu5f3k/node_modules/@playwright/mcp/cli.js', '--headless', '--executable-path', expected.args[3]] };
  assert.equal(isTrustedNativePlaywright('playwright-native', legacy), true);
  const f = await fixture(legacy);
  try {
    for (const [name, args] of READ_ONLY_OPS) {
      const facts = f.manager.getApprovalFacts('playwright-native', name);
      assert.equal(facts.trustedNativePlaywright, true, name);
      for (const project of PROJECTS) for (const permissionMode of MODES) {
        await guardTool({ name, args, native: false, project, permissionMode, ...facts,
          requestApproval: () => assert.fail(`legacy trusted ${name} must not prompt`) });
      }
    }
  } finally { await f.close(); }
});

test('replacement or tampered launch configurations stay untrusted and prompt', async () => {
  const expected = nativePlaywrightConfig();
  const legacy = { command: 'node',
    args: ['/tmp/.mount-Continu5f3k/node_modules/@playwright/mcp/cli.js', '--headless', '--executable-path', expected.args[3]] };
  // A replacement command is the user's own server: never normalized, never trusted.
  // The trusted flag alone never grants trust either (covered with the
  // mismatched launches below and by the manager-level fixture).
  for (const change of [{ command: 'replacement' }, { command: 'evil' },
    { args: [...legacy.args, '--config', '/tmp/evil'] }, { env: { NODE_OPTIONS: '--require /tmp/evil' } }]) {
    assert.equal(isTrustedNativePlaywright('playwright-native', { ...legacy, ...change }), false, JSON.stringify(change));
  }
  const f = await fixture({ ...expected, command: 'replacement', trusted: true });
  try {
    const facts = f.manager.getApprovalFacts('playwright-native', 'browser_navigate');
    assert.equal(facts.trustedNativePlaywright, false);
    let prompts = 0;
    await guardTool({ name: 'browser_navigate', args: { url: 'http://localhost:5173/' }, native: false,
      project: { root_path: process.cwd() }, permissionMode: 'ask_approval', ...facts,
      requestApproval: async () => { prompts++; return true; } });
    assert.equal(prompts, 1, 'untrusted navigate still prompts');
  } finally { await f.close(); }
});
