'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2-budgets-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const builder = require('../src/main/promptBuilder');
const activation = require('../src/main/nativeToolActivation');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const profiles = require('../src/main/profileSettings');
const mcp = require('../src/main/mcpManager');
const oldConfig = mcp.configPath;
mcp.configPath = path.join(directory, 'mcp.json');
fs.writeFileSync(mcp.configPath, '{"mcpServers":{}}');
require('../src/main/configManager').saveAppSettings({ mcpMode: 'auto' });
const estimate = value => value.length === 0 ? 0 : Math.ceil(JSON.stringify(value).length / 4);
const evidence = [];
function fixture(mode = null) {
  const id = randomUUID();
  const root = path.join(directory, id); fs.mkdirSync(root);
  const project = mode && projects.createProject({ name: 'Disposable', root_path: root, permissionMode: mode });
  sessions.getOrCreateSession(id, 'fixture', project?.id);
  return { id, root, project };
}
function payload(f, mode = 'read_only', text = 'hello') {
  const messages = builder.prepareChatMessages({ sessionId: f.id, modelId: 'fixture', userText: text });
  const tools = builder.getToolContext([], true, f.id, mode, 'fixture').tools;
  return { model: 'fixture', messages, tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, cache_prompt: true, temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 };
}
test.after(() => {
  if (process.env.T2_EVIDENCE_PATH) fs.writeFileSync(process.env.T2_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  mcp.configPath = oldConfig; database.closeDatabase(); Module._load = load;
  fs.rmSync(directory, { recursive: true, force: true });
});
for (const mode of [null, 'read_only', 'ask_approval', 'workspace_write', 'full_access']) test(`production fresh request profile ${mode || 'casual'} (estimated guard, not exact tokenizer proof)`, () => {
  const f = fixture(mode), body = payload(f, mode || 'read_only');
  const count = estimate(body);
  assert.ok(count <= (mode ? 11000 : 2000), String(count));
  if (mode) { assert.ok(body.tools.some(t => t.function.name === 'read_project_file')); assert.ok(!body.tools.some(t => t.function.name === 'manage_native_tools')); }
  else assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['find_and_prepare_mcp_tools', 'manage_native_tools']);
  assert.ok(body.messages.some(m => m.content === 'hello'));
  const nativeToolSchemaTokens = estimate(body.tools);
  evidence.push({ chatMode: mode ? 'workspace' : 'casual', permissionMode: mode || 'read_only', provider: 'local', model: 'fixture', measurementMethod: 'serialized-json-characters/4', measurementConfidence: 'estimated', initialRequestInputTokens: count, nativeToolSchemaTokens, systemInstructionTokens: estimate(body.messages.filter(m => m.role === 'system')), projectContextTokens: estimate(builder.buildProjectContext(f.id)), taskStateTokens: estimate(body.messages.filter(m => /^\[WORKSPACE TASK BRIEF\]|^\[TASK CHECKPOINT\]/.test(m.content))), dynamicToolActivationCount: 0, activatedToolGroups: [], postActivationRequestInputTokens: null, toolCount: body.tools.length });
});
test('custom persona, required project guidelines, huge user text and task briefs survive', () => {
  const f = fixture('full_access');
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'REQUIRED_PROJECT_INSTRUCTION');
  const persona = 'CUSTOM_PERSONA_RULE '.repeat(1000);
  const agent = require('../src/main/agentManager').createAgent({ name: 'Budget Persona', system_prompt: persona });
  require('../src/main/agentManager').applyAgent(f.id, agent.id, 'fixture');
  const text = 'AUTHORITATIVE_REQUEST '.repeat(10000), body = payload(f, 'full_access', text);
  assert.ok(body.messages.some(m => m.content.includes(persona.trim())));
  assert.ok(body.messages.some(m => m.content.includes('REQUIRED_PROJECT_INSTRUCTION')));
  assert.ok(body.messages.some(m => m.content === text));
  assert.ok(require('../src/main/taskBriefs').getAllBriefs(f.id).some(brief => brief.content_text.includes(text)));
  assert.ok(estimate(body) > 6000, 'variable user input/configuration is never forced into initial budget');
});
test('catalog covers every native tool; activation only changes exposure and cleans up by owner', async () => {
  const all = new Set(Object.values(activation.groups).flat());
  for (const item of agentTools) assert.ok(item.function.name === 'manage_native_tools' || all.has(item.function.name), item.function.name);
  const f = fixture('read_only'); activation.begin(f.id, 'owner');
  const available = builder.getToolContext([], true, f.id, 'read_only', 'fixture', { fullCatalog: true }).tools;
  assert.throws(() => activation.manage({ action: 'activate', groups: ['editing'] }, f.id, available), /No authorized/);
  assert.throws(() => activation.manage({ action: 'activate', groups: ['files'] }, f.id, available, 'other'), /owning/);
  activation.manage({ action: 'activate', groups: ['files'] }, f.id, available, 'owner');
  assert.ok(builder.getToolContext([], true, f.id, 'read_only', 'fixture').tools.some(t => t.function.name === 'read_project_file'));
  const result = await require('./helpers/approvedNativeCommand.cjs')({ sessionId: f.id, name: 'write_project_file', arguments: { relative_path: 'forbidden', content: 'no' }, permissionMode: 'read_only' });
  assert.ok(result.error); assert.ok(!fs.existsSync(path.join(f.root, 'forbidden')));
  activation.end(f.id, 'other'); assert.equal(activation.snapshot(f.id).dynamicToolActivationCount, 1);
  activation.end(f.id, 'owner'); assert.equal(activation.snapshot(f.id).dynamicToolActivationCount, 0);
});
for (const cloud of [false, true]) test(`real agent loop activates, edits and verifies in one run (cloud=${cloud})`, async () => {
  const f = fixture('full_access'), runId = randomUUID(); activation.begin(f.id, runId);
  fs.writeFileSync(path.join(f.root, 'SettingsModal.jsx'), 'export const title = "Settings";\n');
  // The durable plan is stored once, independently from schema refresh.
  const originalPlan = await require('./helpers/approvedNativeCommand.cjs')({ sessionId: f.id, name: 'update_plan', arguments: { action: 'create', objective: 'Fix settings modal', steps: [{ description: 'Inspect, edit, verify' }] }, permissionMode: 'full_access' });
  assert.ok(originalPlan.success);
  const context = require('../src/main/lspExecutionContext').createContext(f.id, 'full_access', runId);
  const initial = payload(f, 'full_access', 'Locate the settings modal, inspect, make a small change and run tests.');
  const operations = [
    ['search_project_content', { query: 'Settings' }],
    ['read_project_file', { relative_path: 'SettingsModal.jsx' }],
    ['str_replace_editor', { relative_path: 'SettingsModal.jsx', old_str: 'export const title = "Settings";', new_str: 'export const title = "Preferences";' }],
    ['run_tests', { command: `${JSON.stringify(process.execPath)} -e 'require("node:assert/strict").match(require("node:fs").readFileSync("SettingsModal.jsx","utf8"), /Preferences/)'` }],
  ];
  let requests = 0, executed = 0, delivered = 0, total = 0;
  const requestProfiles = [], activationLatenciesMs = [];
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  try {
    await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture', cloud, messages: initial.messages, chatTools: initial.tools,
      getChatTools: async () => builder.getToolContext([], true, f.id, 'full_access', 'fixture').tools,
      takeSteeringInstructions: async () => requests === 2 ? [{ id: 'steer', content: 'Preserve the task plan and keep the change small.' }] : [],
      markSteeringDelivered: async () => { delivered++; },
      executeTool: async call => {
        executed++;
        const started = performance.now();
        const result = await require('./helpers/approvedNativeCommand.cjs')({ ...call, sessionId: f.id, permissionMode: 'full_access', executionContext: context });
        if (call.name === 'manage_native_tools') activationLatenciesMs.push(performance.now() - started);
        assert.ok(!result?.error, JSON.stringify(result));
        if (call.name === 'run_tests') assert.equal(result.status, 'passed');
        return result;
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); total += estimate(body);
        requestProfiles.push({ request: requests + 1, estimatedInputTokens: estimate(body), toolCount: body.tools.length, ...activation.snapshot(f.id) });
        if (requests) assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === `call${requests}`));
        // Exercise real Anthropic serialization on every evolving transcript.
        const anthropic = require('../src/main/cloudProviders').anthropicPayload(body, 'claude-fixture');
        assert.equal(anthropic.tools.length, body.tools.length);
        if (requests) assert.ok(anthropic.messages.some(m => m.content.some(block => block.type === 'tool_result' && block.tool_use_id === `call${requests}`)));
        const operation = operations[requests++];
        if (!operation) return Response.json({ choices: [{ message: { content: 'Verified. [TASK COMPLETE]' }, finish_reason: 'stop' }] });
        assert.ok(body.tools.some(t => t.function.name === operation[0]), operation[0]);
        return Response.json({ choices: [{ message: { tool_calls: [{ id: `call${requests}`, type: 'function', function: { name: operation[0], arguments: JSON.stringify(operation[1]) } }] }, finish_reason: 'tool_calls' }] });
      },
    });
    assert.equal(executed, operations.length); assert.equal(requests, operations.length + 1); assert.equal(delivered, 1);
    assert.match(fs.readFileSync(path.join(f.root, 'SettingsModal.jsx'), 'utf8'), /Preferences/);
    assert.equal(activation.snapshot(f.id).dynamicToolActivationCount, 0);
    const recovered = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'fixture' });
    assert.ok(recovered.some(m => m.content.includes('Fix settings modal')));
    assert.ok(builder.getToolContext([], true, f.id, 'full_access', 'fixture').tools.some(t => t.function.name === 'run_tests'));
    const other = fixture('full_access'); assert.ok(builder.getToolContext([], true, other.id, 'full_access', 'fixture').tools.some(t => t.function.name === 'read_project_file'));
    // Live runtime context is authoritative: downgrade through its policy API.
    await require('../src/main/lspExecutionContext').setMode(f.id, 'read_only');
    assert.ok(!builder.getToolContext([], true, f.id, 'read_only', 'fixture').tools.some(t => t.function.name === 'str_replace_editor'));
    evidence.push({ scenario: 'settings-modal-agent', cloud, requests, operations: executed, totalEstimatedInputTokens: total, additionalActivationRequests: 0, activationLatenciesMs, requestProfiles, ...activation.snapshot(f.id) });
  } finally { activation.end(f.id, runId); }
});
test('Casual custom persona is preserved once within the estimated initial budget', () => {
  const f = fixture();
  const agent = require('../src/main/agentManager').createAgent({ name: 'Tutor', system_prompt: 'Explain clearly and ask one teaching question.' });
  require('../src/main/agentManager').applyAgent(f.id, agent.id, 'fixture');
  const body = payload(f);
  assert.equal(JSON.stringify(body.messages).split(agent.system_prompt).length - 1, 1);
  assert.ok(estimate(body) <= 2000);
  assert.deepEqual(body.tools.map(t => t.function.name), ['find_and_prepare_mcp_tools', 'manage_native_tools']);
});
test('native and MCP activation coexist, preserve inactive discovery and session scope', async () => {
  const { McpManager } = require('../src/main/mcpManager');
  const manager = new McpManager({ configPath: path.join(directory, 'isolated-mcp.json'), lazyByDefault: true,
    createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools: [{ name: 'browser_snapshot', description: 'Fixture browser', inputSchema: { type: 'object', properties: {} } }] }), close: async () => {} }) });
  const f = fixture('full_access'); activation.begin(f.id, 'mcp-coexist');
  try {
    await manager.saveConfig({ mcpServers: { fixture: { command: 'never-launched', description: 'Disposable browser' } } });
    assert.match(manager.getDiscoveryCatalog(f.id), /inactive/);
    assert.equal(manager.getTools(f.id).length, 0);
    const old = mcp.configPath; mcp.configPath = manager.configPath;
    try {
      const initial = payload(f, 'full_access');
      assert.ok(estimate(initial) < 11000);
      assert.ok(!initial.messages.some(m => m.content.includes('Disposable browser')));
      assert.equal(manager.searchCapabilities({query:'Disposable browser'}, f.id).results[0].serverId, 'fixture');
      assert.ok(!JSON.stringify(initial.tools).includes('browser_snapshot'));
    } finally { mcp.configPath = old; }
    const available = builder.getToolContext([], true, f.id, 'full_access', 'fixture', { fullCatalog: true }).tools;
    activation.manage({ action: 'activate', groups: ['files', 'mcp'] }, f.id, available, 'mcp-coexist');
    await manager.manageServers('enable', ['fixture'], f.id);
    const refreshed = builder.getToolContext(manager.getTools(f.id), true, f.id, 'full_access', 'fixture').tools;
    assert.ok(refreshed.some(t => t.function.name === 'read_project_file'));
    assert.ok(refreshed.some(t => t.function.name === 'find_and_prepare_mcp_tools'));
    assert.ok(refreshed.some(t => t.function.name.includes('browser_snapshot')));
    assert.equal(new Set(refreshed.map(t => t.function.name)).size, refreshed.length);
    assert.equal(manager.getTools('other-session').length, 0);
  } finally { activation.end(f.id, 'mcp-coexist'); await manager.close(); }
});
test('twenty-call continuation retains activation through a tool error without schema thrashing', async () => {
  const f = fixture('full_access'), runId = 'twenty-calls';
  fs.writeFileSync(path.join(f.root, 'sample.txt'), 'disposable evidence'); activation.begin(f.id, runId);
  let requests = 0, operations = 0, total = 0, lastTokens = 0;
  const initial = payload(f, 'full_access', 'Read the fixture repeatedly to verify continuation.');
  try {
    const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
    await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture', messages: initial.messages,
      chatTools: initial.tools, getChatTools: async () => builder.getToolContext([], true, f.id, 'full_access', 'fixture').tools,
      executeTool: async call => { operations++; return executeAgentTool({ ...call, sessionId: f.id, permissionMode: 'full_access' }); },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); lastTokens = estimate(body); total += lastTokens;
        if (requests) assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === `twenty-${requests}`));
        const index = requests++;
        if (index === 20) return Response.json({ choices: [{ message: { content: 'Continuation verified. [TASK COMPLETE]' }, finish_reason: 'stop' }] });
        const name = 'read_project_file';
        const args = { relative_path: index === 10 ? 'missing.txt' : 'sample.txt' };
        assert.ok(body.tools.some(t => t.function.name === name));
        return Response.json({ choices: [{ message: { tool_calls: [{ id: `twenty-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
      },
    });
    assert.equal(operations, 20); assert.equal(requests, 21);
    assert.equal(activation.snapshot(f.id).dynamicToolActivationCount, 0);
    evidence.push({ scenario: 'after-20-tool-calls', requests, operations, initialRequestInputTokens: estimate(initial), postActivationRequestInputTokens: lastTokens, totalEstimatedInputTokens: total, additionalActivationRequests: 0, ...activation.snapshot(f.id) });
  } finally { activation.end(f.id, runId); }
});
