const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { McpManager } = require('../src/main/mcpManager');
const { nativePlaywrightConfig, isTrustedNativePlaywright } = require('../src/main/nativePlaywright');
const { guardTool } = require('../src/main/toolPermissions');
const singleton = require('../src/main/mcpManager');
const schema = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

async function fixture(fail = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-mcp-'));
  let launches = 0;
  const manager = new McpManager({ configPath: path.join(directory, 'mcp.json'), lazyByDefault: true,
    createConnection: async () => {
      launches++;
      if (fail) throw new Error('fixture initialization failed');
      return { setNotificationHandler() {}, listTools: async () => ({ tools: [
        { name: 'browser_snapshot', description: 'Inspect page accessibility', inputSchema: { type: 'object', properties: {} } },
      ] }), callTool: async () => ({ content: [{ type: 'text', text: 'Local page inspected' }] }),
      async close() { this.onclose?.(); } };
    } });
  await manager.saveConfig({ mcpServers: { 'playwright-native': nativePlaywrightConfig(directory),
    unknown: { command: 'untrusted', description: 'Explicit user capability description' } } });
  return { manager, launches: () => launches, async close() { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('trust binds the complete executable configuration, never a name or trust flag', () => {
  const config = nativePlaywrightConfig('/tmp');
  assert.equal(isTrustedNativePlaywright('playwright-native', config), true);
  for (const change of [{ command: 'evil' }, { args: [...config.args, '--config', '/tmp/evil'] },
    { env: { ...config.env, NODE_OPTIONS: '--require /tmp/evil' } }, { url: 'http://localhost' }]) {
    assert.equal(isTrustedNativePlaywright('playwright-native', { ...config, ...change, trusted: true }), false);
  }
  assert.equal(isTrustedNativePlaywright('playwright-other', config), false);
});

for (const cloud of [false, true]) for (const streaming of [false, true]) test(`real tool loop hot activates, preserves transcript and steering (cloud=${cloud}, streaming=${streaming})`, async () => {
  const f = await fixture();
  const previous = singleton.isTrustedActivation;
  const permissions = require('../src/main/toolPermissions');
  const previousProject = permissions.sessionProject;
  permissions.sessionProject = () => ({ root_path: f.manager.servers.get('playwright-native').definition.cwd });
  singleton.isTrustedActivation = (...args) => f.manager.isTrustedActivation(...args);
  try {
    const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
    const catalog = f.manager.getDiscoveryCatalog('chat-a');
    assert.match(catalog, /navigation, page\/DOM inspection and page screenshots/);
    assert.match(catalog, /inactive/);
    assert.match(catalog, /not trusted/);
    assert.doesNotMatch(catalog, /inputSchema|ELECTRON_RUN_AS_NODE/);
    assert.equal(f.launches(), 0);
    let requests = 0, approvals = 0, delivered = 0;
    const outputs = [];
    let activationMs, firstCallMs, afterSchemaChars;
    await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture', cloud,
      messages: [{ role: 'system', content: catalog }, { role: 'user', content: 'Keep the existing task plan and inspect the app.' }],
      takeSteeringInstructions: async () => requests === 0 ? [{ id: 'steer-1', content: 'Use Playwright to inspect the local page.' }] : [],
      markSteeringDelivered: async () => { delivered++; },
      getChatTools: async () => [schema('manage_mcp_servers'), ...f.manager.getTools('chat-a')],
      executeTool: async call => {
        if (call.name === 'manage_mcp_servers') {
          const args = { action: 'enable', server_names: ['playwright-native'] };
          const grant = await guardTool({ name: call.name, args, permissionMode: 'workspace_write', project: { root_path: f.manager.servers.get('playwright-native').definition.cwd }, requestApproval: async () => { approvals++; return false; } });
          const start = performance.now();
          const result = await f.manager.manageServers(args.action, args.server_names, 'chat-a', { trustedOnly: grant.trustedMcpActivation });
          activationMs = performance.now() - start;
          afterSchemaChars = JSON.stringify([schema('manage_mcp_servers'), ...f.manager.getTools('chat-a')]).length;
          return result;
        }
        const resolved = f.manager.resolveTool(call.name, 'chat-a');
        const callStart = performance.now();
        const output = await f.manager.callTool(resolved.serverName, resolved.toolName, {}, { sessionId: 'chat-a', permissionMode: 'workspace_write' });
        firstCallMs = performance.now() - callStart;
        outputs.push(output); return output;
      },
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body); requests++;
        assert.ok(payload.messages.some(m => String(m.content).includes('existing task plan')));
        if (requests === 1) assert.equal(payload.tools.length, 1);
        if (requests === 2) {
          assert.equal(payload.tools.length, 2);
          assert.ok(payload.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call1'));
        }
        const name = requests === 1 ? 'manage_mcp_servers' : f.manager.getTools('chat-a')[0].function.name;
        const message = requests < 3 ? { tool_calls: [{ id: `call${requests}`, type: 'function', function: { name, arguments: '{}' } }] } : { content: 'Local page inspected. [TASK COMPLETE]' };
        if (streaming) return new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: requests < 3 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
        return Response.json({ choices: [{ message, finish_reason: requests < 3 ? 'tool_calls' : 'stop' }] });
      } });
    assert.equal(requests, 3); assert.equal(approvals, 0); assert.equal(delivered, 1);
    assert.match(outputs[0], /Local page inspected/);
    assert.equal(f.launches(), 1); assert.equal(f.manager.getTools('chat-b').length, 0);
    const repeatStart = performance.now();
    await f.manager.manageServers('enable', ['playwright-native'], 'chat-a');
    const repeatMs = performance.now() - repeatStart;
    assert.equal(f.launches(), 1);
    const stale = f.manager.getTools('chat-a')[0].function.name;
    await f.manager.manageServers('disable', ['playwright-native'], 'chat-a');
    assert.throws(() => f.manager.resolveTool(stale, 'chat-a'), /unavailable/);
    console.log(JSON.stringify({ cloud, catalogChars: catalog.length, initialSchemaChars: JSON.stringify([schema('manage_mcp_servers')]).length, requests, launches: f.launches(), activationMs, firstCallMs, repeatMs, afterSchemaChars }));
  } finally { singleton.isTrustedActivation = previous; permissions.sessionProject = previousProject; await f.close(); }
});

test('initialization failure and queued manual switch do not expose tools', async () => {
  const f = await fixture(true);
  try {
    const result = await f.manager.manageServers('enable', ['playwright-native'], 'a');
    assert.equal(result.success, false); assert.match(result.message, /initialization failed/);
    assert.deepEqual(f.manager.getTools('a'), []);
    f.manager.getMcpMode = () => 'manual';
    await assert.rejects(f.manager.manageServers('enable', ['playwright-native'], 'a'), /Manual/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.manager.manageServers('enable', ['playwright-native'], 'a', { signal: abort.signal }), /abort/i);
  } finally { await f.close(); }
});

 test('permission modes and config-race revalidation remain restrictive', async () => {
  const f = await fixture();
  const original = singleton.isTrustedActivation;
  singleton.isTrustedActivation = (...args) => f.manager.isTrustedActivation(...args);
  try {
    const invoke = (mode, names = ['playwright-native']) => guardTool({ name: 'manage_mcp_servers',
      args: { action: 'enable', server_names: names }, permissionMode: mode,
      project: { root_path: f.manager.servers.get('playwright-native').definition.cwd } });
    await assert.rejects(invoke('read_only'), /blocked|denied/i);
    await assert.rejects(invoke('ask_approval'), /approval denied/i);
    await assert.rejects(invoke('workspace_write', ['unknown']), /approval denied/i);
    assert.equal((await invoke('full_access')).mode, 'full_access');
    assert.equal((await invoke('workspace_write')).trustedMcpActivation, true);
    const config = await f.manager.getConfig();
    config.mcpServers['playwright-native'].command = 'untrusted';
    await f.manager.writeConfig(config);
    await assert.rejects(f.manager.manageServers('enable', ['playwright-native'], 'a', { trustedOnly: true }), /not trusted/);
    assert.equal(f.launches(), 0);
  } finally { singleton.isTrustedActivation = original; await f.close(); }
});
