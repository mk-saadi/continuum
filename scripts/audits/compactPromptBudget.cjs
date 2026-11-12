'use strict';
// Fixed, disposable fixture. No live settings, user context, inference, or
// compaction. Byte budgets detect advertisement/instruction growth, NOT tokens.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-prompt-budget-'));
const load = Module._load;
Module._load = function(name, ...rest) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...rest);
};
const oldProfile = process.env.CONTINUUM_NATIVE_TOOL_PROFILE;
const database = require('../../src/main/db');
const activation = require('../../src/main/nativeToolActivation');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  database.initDatabase();
  const builder = require('../../src/main/promptBuilder');
  const mcp = require('../../src/main/mcpManager');
  mcp.configPath = path.join(directory, 'mcp_config.json');
  fs.writeFileSync(mcp.configPath, '{"mcpServers":{}}');
  require('../../src/main/configManager').saveAppSettings({ mcpMode: 'auto' });
  require('../../src/main/profileSettings').saveProfileSettings(null, {
    memoryEnabled: true, systemPrompt: '', richBlocks: 'off', allowMidRunQuestions: true,
  });
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'Original fixture text.\n');
  const project = require('../../src/main/projectManager').createProject({
    name: 'Prompt budget fixture', root_path: workspace, permissionMode: 'workspace_write',
  });
  const { runMemoryChat } = await import('../../src/lib/memoryChat.mjs');
  const records = [];
  for (const profile of ['full', 'compact']) {
    process.env.CONTINUUM_NATIVE_TOOL_PROFILE = profile;
    const sessionId = `prompt-budget-${profile}`, modelId = 'continuum-prompt-budget-fixture';
    require('../../src/main/sessionManager').getOrCreateSession(sessionId, modelId, project.id);
    activation.begin(sessionId, 'fixture-run');
    const messages = builder.prepareChatMessages({ sessionId, modelId, userText: 'hello' });
    const tools = builder.getToolContext([], true, sessionId, 'workspace_write', modelId).tools;
    for (const tool of tools) require('../../src/main/toolSchemaValidation').compile(tool.function.parameters);
    let body;
    await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId, messages, chatTools: tools,
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return Response.json({ choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }] });
      },
    });
    activation.end(sessionId, 'fixture-run');
    // Normalize only volatile fixture values, never production request data.
    body = JSON.parse(JSON.stringify(body).split(directory).join('/tmp/continuum-prompt-budget'));
    for (const message of body.messages) if (typeof message.content === 'string') {
      message.content = message.content
        .replace(/Today's Date: [^\n]*\n/g, "Today's Date: Friday, November 6, 2026 (2026-11-06)\n")
        .replace(/User Timezone Offset: -?\d+ mins/g, 'User Timezone Offset: 0 mins');
    }
    const normalizedBytes = Buffer.byteLength(JSON.stringify(body));
    records.push({ profile, normalizedBytes, toolCount: body.tools.length,
      requestSha256: digest(body), schemasSha256: digest(body.tools),
      estimatedTokens: require('../../src/main/contextBudget').approximateTokens(body),
    });
    const capture = option('--capture-dir');
    if (capture) { fs.mkdirSync(capture, { recursive: true }); fs.writeFileSync(path.join(capture, `${profile}.json`), JSON.stringify(body)); }
  }
  const baseline = JSON.parse(fs.readFileSync(option('--baseline') || path.join(__dirname, 'compactPromptBudget.baseline.json')));
  const growthFailures = [];
  if (!args.includes('--record-only')) for (const record of records) {
    const base = baseline.normalizedBytes[record.profile];
    if (record.normalizedBytes > Math.ceil(base * 1.10)) growthFailures.push(`${record.profile}: ${record.normalizedBytes} bytes exceeds fixed-fixture 10% growth budget (${base}). Inspect the change; do not blindly refresh the baseline.`);
  }
  const compact = records.find(record => record.profile === 'compact');
  if (compact.estimatedTokens >= 10000) growthFailures.push(`compact: ${compact.estimatedTokens} estimated tokens exceeds the fresh-workspace budget (<10000).`);
  const result = { fixture: 'compact-prompt-budget-v1', method: 'Normalized production local-request JSON UTF-8 bytes; estimates use production bytes/3 + per-message overhead, NOT exact model tokens',
    conditions: { user: 'hello', permission: 'workspace_write', mcpMode: 'auto', externalSchemas: 0, browserSchemas: 0,
      persona: 'empty', memories: 0, history: 'one user turn', projectFiles: 'one sample.txt, contents not injected', repositoryInstructions: 0, richBlocks: 'off', date: '2026-11-06', timezoneOffsetMinutes: 0 },
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null, nodeEnv: process.env.NODE_ENV ?? null, packagedAsar: __filename.includes('.asar/') },
    budgetCheck: { checked: !args.includes('--record-only'), passed: growthFailures.length === 0, maxGrowthRatio: 1.10, failures: growthFailures }, records };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  assert.equal(growthFailures.length, 0, growthFailures.join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  database.closeDatabase(); Module._load = load;
  if (oldProfile === undefined) delete process.env.CONTINUUM_NATIVE_TOOL_PROFILE; else process.env.CONTINUUM_NATIVE_TOOL_PROFILE = oldProfile;
  fs.rmSync(directory, { recursive: true, force: true });
});
