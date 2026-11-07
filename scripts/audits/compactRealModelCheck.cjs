'use strict';
// Opt-in live acceptance against an already loaded local model. All application
// state and Git/file/command operations are confined to disposable fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const endpoint = option('--endpoint') || 'http://127.0.0.1:8080';
assert.match(endpoint, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const output = option('--output'); assert.ok(output, '--output is required');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-real-model-'));
const load = Module._load;
Module._load = function(name, ...rest) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...rest);
};
const originalProfile = process.env.CONTINUUM_NATIVE_TOOL_PROFILE;
const database = require('../../src/main/db');
const activation = require('../../src/main/nativeToolActivation');
const result = { method: 'Live local model; production builders, serializer, loop, schema and permission guards; disposable profile/workspaces; no GUI',
  node: process.versions.node, electron: process.versions.electron ?? null, nodeEnv: process.env.NODE_ENV ?? null,
  asar: __filename.includes('.asar/'), cases: [], completed: false };
const persist = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git = (root, ...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
async function main() {
  const props = await (await fetch(endpoint + '/props', { signal: AbortSignal.timeout(5000) })).json();
  const modelId = props.model_path;
  assert.equal(path.basename(modelId), 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf');
  result.runtime = { model: path.basename(modelId), context: props.default_generation_settings?.n_ctx, slots: props.total_slots,
    build: props.build_info, templateSha256: hash(props.chat_template), defaultParams: props.default_generation_settings?.params };
  database.initDatabase();
  const builder = require('../../src/main/promptBuilder');
  const contexts = require('../../src/main/lspExecutionContext');
  const policy = require('../../src/main/toolPermissions');
  const config = require('../../src/main/configManager');
  require('../../src/main/mcpManager').configPath = path.join(directory, 'mcp.json'); fs.writeFileSync(path.join(directory, 'mcp.json'), '{"mcpServers":{}}');
  config.saveAppSettings({ mcpMode: 'manual' });
  require('../../src/main/profileSettings').saveProfileSettings(null, { memoryEnabled: true, systemPrompt: '', richBlocks: 'off', allowMidRunQuestions: true });
  const { runMemoryChat } = await import('../../src/lib/memoryChat.mjs');
  const measure = require('../../src/main/contextBudget').createPromptMeasurer(fetch);
  const cases = [
    ['hello-full', 'full', 'hello'],
    ['hello-compact', 'compact', 'hello'],
    ['native-read', 'compact', 'Read sample.txt using the native file-reading tool and report its contents. Do not use commands or change any files.'],
    ['native-read-page', 'compact', 'Read only line 1 of sample.txt with read_project_file, explicitly setting start_line=1 and end_line=1. Report the line. Do not use commands or modify files.'],
    ['native-attachment', 'compact', 'Read only line 1 of the attached text file with read_project_file using its attachment_id and start_line=1, end_line=1. Do not use a workspace path or commands. Report the line.'],
    ['permission-denial', 'compact', 'Stage only sample.txt using the native git_stage tool. Do not commit or modify files. If approval is denied, stop and report the denial.'],
    ['permission-downgrade', 'compact', 'Replace exactly Original fixture text. with Edited fixture text. in sample.txt using str_replace_editor. If permissions are revoked, stop and report that.'],
    ['files-command', 'compact', 'Read sample.txt, then replace exactly "Original fixture text." with "Edited fixture text." in that file. Run node verify.cjs to verify the change and report the command result. Do not change verify.cjs.'],
    ['atomic-discovery', 'compact', 'Use the native atomic batch-edit capability to change "Before A" to "After A" in first.txt and "Before B" to "After B" in second.txt in one atomic operation. Read both files first. Do not use a shell script or separate non-atomic edits. Verify both final contents.'],
    ['git-discovery', 'compact', 'Inspect Git status, stage only sample.txt, commit with message "Update fixture text", then show the latest commit and final status. Do not modify files or contact a remote.'],
  ];
  for (const [name, selectedProfile, task] of cases) {
    if (option('--case') && !option('--case').split(',').includes(name)) continue;
    const profile = option('--profile') || selectedProfile;
    assert.ok(['full', 'compact'].includes(profile));
    process.env.CONTINUUM_NATIVE_TOOL_PROFILE = profile;
    const root = path.join(directory, name); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'sample.txt'), 'Original fixture text.\n');
    fs.writeFileSync(path.join(root, 'verify.cjs'), 'const fs=require("node:fs");require("node:assert/strict").equal(fs.readFileSync("sample.txt","utf8"),"Edited fixture text.\\n");console.log("VERIFIED");');
    fs.writeFileSync(path.join(root, 'first.txt'), 'Before A\n'); fs.writeFileSync(path.join(root, 'second.txt'), 'Before B\n');
    if (name === 'git-discovery' || name === 'permission-denial') {
      git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
      git(root, 'add', 'sample.txt'); git(root, 'commit', '-qm', 'Initial');
      fs.writeFileSync(path.join(root, 'sample.txt'), 'Updated Git fixture.\n');
    }
    const project = require('../../src/main/projectManager').createProject({ name: 'Real-model acceptance fixture', root_path: root, permissionMode: name === 'permission-denial' ? 'ask_approval' : 'workspace_write' });
    const sessionId = name, runId = name + '-run';
    require('../../src/main/sessionManager').getOrCreateSession(sessionId, modelId, project.id);
    let attachments;
    if (name === 'native-attachment') attachments = await require('../../src/main/fileUploads').processUploads([path.join(root, 'sample.txt')]);
    const context = contexts.createContext(sessionId, name === 'permission-denial' ? 'ask_approval' : 'workspace_write', runId);
    activation.begin(sessionId, runId);
    const record = { name, profile, requests: [], calls: [], initialGroups: activation.snapshot(sessionId), approvals: [], passed: false };
    result.cases.push(record); persist(); console.log('Starting live case:', name);
    const tools = () => builder.getToolContext([], true, sessionId, context.permissionMode, modelId).tools;
    let currentManifest = new Map(), text = '', stats;
    const responseTraces = [];
    try {
      await runMemoryChat({ baseUrl: endpoint, modelId, loadedContextSize: props.default_generation_settings?.n_ctx,
        messages: builder.prepareChatMessages({ sessionId, modelId, userText: task, attachments }), chatTools: tools(), getChatTools: async () => tools(),
        projectId: project.id, workspaceRoot: root, samplingParams: { temperature: 0.2, seed: 42, max_tokens: name === 'native-read' ? 512 : 2048 },
        maxAutoTurns: Number(option('--rounds') || 16), maxToolRounds: Number(option('--rounds') || 16), signal: AbortSignal.timeout(240000),
        onText: value => { text += value; }, onStats: value => { stats = value; },
        fetchImpl: async (url, options) => {
          // Workspace production runs intentionally have no request ceiling;
          // bound only this opt-in acceptance harness, not application policy.
          if (record.requests.length >= Number(option('--rounds') || 16)) throw Error('ACCEPTANCE_REQUEST_LIMIT');
          const body = JSON.parse(options.body);
          currentManifest = new Map(body.tools.map(t => [t.function.name, t]));
          const measured = await measure(url, body, {}, props.default_generation_settings?.n_ctx);
          const request = { index: record.requests.length + 1, preparedTokens: measured.tokens, method: measured.method, note: measured.note,
            bodySha256: hash(body), serializedBytes: Buffer.byteLength(options.body), tools: body.tools.map(t => t.function.name) };
          record.requests.push(request);
          persist();
          const response = await fetch(url, options);
          responseTraces.push(response.clone().text().then(raw => {
            const calls = new Map();
            for (const line of raw.split('\n')) {
              if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
              let chunk; try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
              if (chunk.usage) request.providerUsage = chunk.usage;
              for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
                const current = calls.get(call.index ?? 0) ?? { name: '', arguments: '' };
                current.name += call.function?.name ?? '';
                current.arguments += call.function?.arguments ?? '';
                calls.set(call.index ?? 0, current);
              }
            }
            request.providerCalls = [...calls.values()].map(call => {
              try { return { name: call.name, argumentKeys: Object.keys(JSON.parse(call.arguments)) }; }
              catch { return { name: call.name, invalidJson: true }; }
            });
          }).catch(error => { request.traceError = error.name; }));
          return response;
        },
        executeTool: async call => {
          const event = { name: call.name, success: false };
          record.calls.push(event);
          try {
            if (name === 'permission-downgrade' && ['str_replace_editor', 'write_project_file', 'edit_project_files', 'apply_patch'].includes(call.name) && !record.downgrade) {
              await contexts.setMode(sessionId, 'read_only');
              record.downgrade = { mode: context.permissionMode, editAdvertised: tools().some(t => t.function.name === 'str_replace_editor') };
            }
            const tool = tools().find(t => t.function.name === call.name);
            assert.ok(tool && currentManifest.has(call.name), 'TOOL_NOT_ADVERTISED');
            const values = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
            event.argumentKeys = Object.keys(values);
            if (call.name === 'read_project_file') event.readShape = { source: Object.hasOwn(values, 'attachment_id') ? 'attachment' : Object.hasOwn(values, 'relative_path') ? 'workspace' : 'missing', start: values.start_line, end: values.end_line };
            if (call.name === 'manage_native_tools') event.arguments = values;
            require('../../src/main/toolSchemaValidation').validate(tool.function.parameters, values);
            const approval = await policy.guardTool({ name: call.name, args: values, native: true, sessionId, project,
              permissionMode: context.permissionMode, requestApproval: async request => { record.approvals.push({ name: request.name, accepted: false }); return false; } });
            const value = await require('../../src/main/tools/agentTools').executeAgentTool({ ...call, arguments: values, sessionId,
              permissionMode: context.permissionMode, permissionGranted: true, approval, executionContext: context });
            event.success = !value.error && value.success !== false; event.code = value.code ?? null;
            if (!event.success) event.error = typeof value.error === 'string' ? value.error.slice(0, 250).split(directory).join('/tmp/fixture') : value.error;
            if (call.name === 'execute_command') event.commandResult = { exitCode: value.exitCode, status: value.status,
              stdout: value.stdout?.slice(0, 500), stderr: value.stderr?.slice(0, 500).split(directory).join('/tmp/fixture'), spawnError: value.spawnError };
            event.activation = activation.snapshot(sessionId); persist(); return value;
          } catch (error) { event.error = error.message.split(directory).join('/tmp/fixture'); event.code = error.code; persist(); return { success: false, error: event.error, code: event.code }; }
        },
      });
      record.usage = stats;
      record.answerSha256 = hash(text);
      record.finalGroups = activation.snapshot(sessionId);
      record.nativeReadPassed = record.calls.some(c => c.name === 'read_project_file' && c.success);
      if (name.startsWith('hello')) record.passed = record.calls.length === 0 && record.requests.length === 1 && !!text.trim() && (name !== 'hello-compact' || (stats?.promptTokens < 10000));
      if (name === 'files-command') record.passed = fs.readFileSync(path.join(root, 'sample.txt'), 'utf8') === 'Edited fixture text.\n' && record.calls.some(c => c.name === 'read_project_file' && c.success) && record.calls.some(c => ['str_replace_editor', 'edit_project_files'].includes(c.name) && c.success) && record.calls.some(c => c.name === 'execute_command' && c.success && c.commandResult?.exitCode === 0 && c.commandResult?.stdout?.includes('VERIFIED'));
      if (name === 'files-command') record.objectivePassed = fs.readFileSync(path.join(root, 'sample.txt'), 'utf8') === 'Edited fixture text.\n' && record.calls.some(c => c.name === 'execute_command' && c.success && c.commandResult?.exitCode === 0 && c.commandResult?.stdout?.includes('VERIFIED'));
      if (name === 'permission-denial') record.passed = record.approvals.some(a => a.accepted === false) && git(root, 'diff', '--cached').trim() === '' && fs.readFileSync(path.join(root, 'sample.txt'), 'utf8') === 'Updated Git fixture.\n';
      if (name === 'permission-downgrade') record.passed = record.downgrade?.mode === 'read_only' && record.downgrade.editAdvertised === false && record.calls.some(c => c.error?.includes('TOOL_NOT_ADVERTISED')) && fs.readFileSync(path.join(root, 'sample.txt'), 'utf8') === 'Original fixture text.\n';
      if (name === 'native-read-page' || name === 'native-attachment') record.passed = record.calls.some(c => c.name === 'read_project_file' && c.success && c.readShape.start === 1 && c.readShape.end === 1 && c.readShape.source === (name === 'native-attachment' ? 'attachment' : 'workspace')) && !record.calls.some(c => c.name === 'execute_command');
      if (name === 'native-read') record.passed = record.nativeReadPassed && !record.calls.some(c => c.name === 'execute_command');
      if (name === 'atomic-discovery') record.passed = fs.readFileSync(path.join(root, 'first.txt'), 'utf8') === 'After A\n' && fs.readFileSync(path.join(root, 'second.txt'), 'utf8') === 'After B\n' && record.calls.some(c => c.name === 'manage_native_tools' && c.arguments.action === 'activate' && c.success) && record.calls.some(c => c.name === 'edit_project_files' && c.success) && !record.requests[0].tools.includes('edit_project_files');
      if (name === 'git-discovery') {
        record.gitOutcome = { headMessage: git(root, 'log', '-1', '--format=%s').trim(), stagedDiffEmpty: git(root, 'diff', '--cached').trim() === '' };
        const showedCommit = record.calls.some(c => ['git_log', 'git_show'].includes(c.name) && c.success) ||
          record.calls.some(c => c.name === 'execute_command' && c.success && c.commandResult?.exitCode === 0 && c.commandResult?.stdout?.includes('Update fixture text'));
        record.passed = record.gitOutcome.headMessage === 'Update fixture text' && record.gitOutcome.stagedDiffEmpty &&
          record.calls.some(c => c.name === 'git_commit' && c.success) && record.calls.some(c => c.name === 'git_status' && c.success) && showedCommit;
      }
    } catch (error) { record.usage = stats; record.error = error.message.split(directory).join('/tmp/fixture'); }
    await Promise.all(responseTraces);
    activation.end(sessionId, runId);
    record.afterEnd = activation.snapshot(sessionId);
    activation.begin(sessionId, runId + '-fresh'); record.freshRun = { profile: activation.profile(sessionId), ...activation.snapshot(sessionId), tools: tools().map(t => t.function.name) };
    activation.end(sessionId, runId + '-fresh');
    persist(); console.log('Completed live case:', name, record.passed ? 'PASS' : 'FAIL');
  }
  result.completed = true; result.passed = result.cases.every(c => c.passed); persist();
  if (!result.passed) process.exitCode = 1;
}
main().catch(error => { result.error = error.message; persist(); console.error(error.message); process.exitCode = 1; }).finally(() => {
  database.closeDatabase(); Module._load = load;
  if (originalProfile === undefined) delete process.env.CONTINUUM_NATIVE_TOOL_PROFILE; else process.env.CONTINUUM_NATIVE_TOOL_PROFILE = originalProfile;
  fs.rmSync(directory, { recursive: true, force: true });
});
