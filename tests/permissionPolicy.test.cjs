const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-policy-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const originalLoad = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => root },
    Notification: { isSupported: () => false },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
  };
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => fetchMock(...params) };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const { getToolContext } = require('../src/main/promptBuilder');
const { isToolVisible, effectiveMode } = require('../src/main/toolPermissions');

const MCP_TOOL = { type: 'function', function: { name: 'mcp_fetch', description: 'MCP tool', parameters: { type: 'object', properties: {} } } };
const names = (sessionId, permissionMode, mcpTools = []) =>
  getToolContext(mcpTools, true, sessionId, permissionMode).tools.map(tool => tool.function.name);

const response = content => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

(async () => {
  let dispose;
  try {
    initDatabase(root);
    const project = require('../src/main/projectManager').createProject({ name: 'Policy', root_path: workspace });
    require('../src/main/sessionManager').getOrCreateSession('pol-work', 'model', project.id);
    require('../src/main/sessionManager').getOrCreateSession('pol-casual', 'model');

    // 1. Casual workspace_write normalizes to ask_approval: identical tool lists.
    const casualWrite = names('pol-casual', 'workspace_write', [MCP_TOOL]);
    const casualAsk = names('pol-casual', 'ask_approval', [MCP_TOOL]);
    assert.deepEqual(casualWrite, casualAsk, 'casual workspace_write equals casual ask_approval');
    assert.equal(effectiveMode('workspace_write', null), 'ask_approval');

    // 2. Casual chat hides workspace file-write tools but keeps work tools visible.
    for (const hidden of ['write_project_file', 'str_replace_editor', 'edit_file']) {
      assert.ok(!casualWrite.includes(hidden), `${hidden} must be hidden in casual chat`);
      assert.ok(!casualAsk.includes(hidden), `${hidden} must be hidden in casual ask_approval`);
    }
    for (const shown of ['execute_command', 'save_memory', 'search_memory', 'get_recent_chat_history', 'mcp_fetch']) {
      assert.ok(casualAsk.includes(shown), `${shown} stays available in casual chat`);
    }

    // 3. spawn_sub_agent is visible in all four modes and both contexts.
    for (const mode of ['read_only', 'workspace_write', 'ask_approval', 'full_access']) {
      assert.ok(names('pol-casual', mode).includes(`spawn_sub_agent`), `casual ${mode}`);
      assert.ok(names('pol-work', mode).includes(`spawn_sub_agent`), `workspace ${mode}`);
      assert.equal(isToolVisible('spawn_sub_agent', { permissionMode: mode, project: { root_path: workspace } }), true, `isToolVisible workspace ${mode}`);
      assert.equal(isToolVisible('spawn_sub_agent', { permissionMode: mode }), true, `isToolVisible casual ${mode}`);
    }

    // 4. Read only hides commands, writes, memory writes and MCP tools.
    const readOnly = names('pol-work', 'read_only', [MCP_TOOL]);
    for (const hidden of ['execute_command', 'write_project_file', 'str_replace_editor', 'save_memory', 'mcp_fetch']) {
      assert.ok(!readOnly.includes(hidden), `${hidden} must be hidden in read_only`);
    }
    for (const shown of ['read_project_file', 'search_project_content', 'spawn_sub_agent', 'search_memory', 'get_recent_chat_history']) {
      assert.ok(readOnly.includes(shown), `${shown} stays available in read_only`);
    }

    // 5. save_memory is never a dead end outside read_only, workspace or casual.
    for (const mode of ['workspace_write', 'ask_approval', 'full_access']) {
      assert.ok(names('pol-work', mode).includes('save_memory'), `workspace ${mode}`);
      assert.ok(names('pol-casual', mode).includes('save_memory'), `casual ${mode}`);
    }

    // 6. Workspace modes keep working tools and MCP tools visible.
    const workspaceWrite = names('pol-work', 'workspace_write', [MCP_TOOL]);
    for (const shown of ['execute_command', 'write_project_file', 'save_memory', 'spawn_sub_agent', 'mcp_fetch']) {
      assert.ok(workspaceWrite.includes(shown), `${shown} available in workspace_write`);
    }

    // 7. In-workspace commands run autonomously in ask_approval (no approval
    //    channel exists here, so a prompt would fail this call).
    const { executeAgentTool } = require('../src/main/tools/agentTools');
    const dev = await executeAgentTool({
      name: 'execute_command', arguments: { command: 'printf dev > dev.txt' }, sessionId: 'pol-work', permissionMode: 'ask_approval',
    });
    assert.equal(dev.exitCode, 0, dev.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'dev.txt'), 'utf8'), 'dev');
    // System-affecting commands cannot self-approve through the same path.
    const risky = await executeAgentTool({
      name: 'execute_command', arguments: { command: 'sudo touch pwned.txt' }, sessionId: 'pol-work', permissionMode: 'ask_approval',
    });
    assert.equal(risky.success, false);
    assert.match(risky.error, /approval denied/);
    assert.equal(fs.existsSync(path.join(workspace, 'pwned.txt')), false);

    // 8. engine:chat advertises spawn_sub_agent even when the user text looks
    //    like local-file inspection, and the prompt no longer forbids it.
    // Never touch the real user MCP config: reload()/load() spawn stdio servers.
    const mcpManager = require('../src/main/mcpManager');
    mcpManager.init = async () => {};
    mcpManager.reload = async () => {};
    mcpManager.load = async () => {};
    mcpManager.getTools = () => [];
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
      isTrustedSender: () => true,
      getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }),
      beginEngineRequest: () => () => {},
    });
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    sender.send = () => {};
    const requests = [];
    fetchMock = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response('Handled.');
    };
    const result = await handlers.get('engine:chat')({ sender }, {
      requestId: 'policy-1',
      modelId: 'model',
      sessionId: 'pol-casual',
      permissionMode: 'workspace_write',
      messages: [{ role: 'user', content: 'Search the local workspace files and inspect the logs for errors' }],
    });
    assert.equal(result.text, 'Handled.');
    const offered = requests[0].tools.map(tool => tool.function.name);
    assert.ok(offered.includes('spawn_sub_agent'), 'spawn_sub_agent stays offered for local-file inspection asks');
    assert.ok(!offered.includes('write_project_file'), 'casual chat does not offer workspace write tools');
    const payload = JSON.stringify(requests[0].messages);
    assert.ok(payload.includes('### Sub-Agent Delegation Protocol'), 'the delegation protocol is advertised');
    assert.ok(!payload.includes('Never use `spawn_sub_agent`'), 'the instruction forbidding sub-agent file inspection is gone');

    console.log('Permission policy: visibility/execution agreement, casual normalization, read_only filtering, autonomous dev commands and spawn visibility passed.');
  } finally {
    dispose?.();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
