const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const userData = path.join(root, 'userData');
const temp = path.join(root, 'temp');
fs.mkdirSync(userData); fs.mkdirSync(temp);
const originalTmpdir = os.tmpdir;
os.tmpdir = () => temp;
const originalLoad = Module._load;
let captureOptions;
const handlers = new Map();
Module._load = function(name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: name => name === 'userData' ? userData : root },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 800, height: 600 }, scaleFactor: 1 }), getAllDisplays: () => [] },
    BrowserWindow: { getAllWindows: () => [] },
    desktopCapturer: { getSources: async options => { captureOptions = options; return [{ id: 'screen:1:0', display_id: '1', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from('png-test') } }]; } },
  };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const { executeAgentTool, agentTools, isPathAllowed } = require('../src/main/tools/agentTools');
const run = (name, args, sessionId = 'chat', permissionMode = ['execute_command', 'take_screenshot', 'approve_mcp_mutation', 'manage_mcp_servers'].includes(name) ? 'full_access' : 'workspace_write') => executeAgentTool({ name, arguments: JSON.stringify(args), sessionId, permissionMode });
(async () => {
  let dispose;
  try {
    initDatabase(root);
    const project = require('../src/main/projectManager').createProject({ name: 'Tools', root_path: workspace });
    require('../src/main/sessionManager').getOrCreateSession('chat', 'model', project.id);
    assert.ok(agentTools.length >= 11);
    assert.equal(require('../src/main/promptBuilder').getToolContext([], false, 'chat').tools.length, agentTools.length + 1, 'ask_user is also available');
    assert.ok(require('../src/main/promptBuilder').getToolContext([], false, null).tools.some(tool => tool.function.name === 'manage_mcp_servers'));
    const mcpManager = require('../src/main/mcpManager');
    const originalManage = mcpManager.manageServers;
    const originalConfigPath = mcpManager.configPath;
    try {
      mcpManager.manageServers = async (action, names, sessionId) => ({ success: true, action, names, sessionId });
      assert.deepEqual(await run('manage_mcp_servers', { action: 'enable', server_names: ['terminal'] }),
        { success: true, action: 'enable', names: ['terminal'], sessionId: 'chat' });
      const configPath = path.join(root, 'mcp_config.json');
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { terminal: { command: 'terminal', inputSchema: { heavy: 'unused' } }, browser: { command: 'browser' } } }));
      mcpManager.configPath = configPath;
      const prompt = require('../src/main/promptBuilder').buildSessionSystemPrompt({ sessionId: 'chat', modelId: 'model' }).content;
      assert.match(prompt, /Available dynamic tools \(MCP servers\): "terminal", "browser"/);
      assert.doesNotMatch(prompt, /heavy/);
    } finally {
      mcpManager.manageServers = originalManage;
      mcpManager.configPath = originalConfigPath;
    }
    const { approvedMutations } = require('../src/main/safetyGuards');
    assert.equal(require('../src/main/tools/agentTools').approvedMutations, approvedMutations);
    const hash = '0123456789abcdef';
    assert.deepEqual(await run('approve_mcp_mutation', { hash }, null), { success: true, hash });
    assert.ok(approvedMutations.delete(hash), 'Approval is available without a project');
    for (const hash of ['', 'not-a-hash', 42, null]) {
      assert.equal((await run('approve_mcp_mutation', { hash }, null)).success, false);
    }
    assert.equal(approvedMutations.size, 0);
    assert.equal((await run('write_project_file', { relative_path: 'src/test.txt', content: 'alpha\nbeta\nalpha\n' })).success, true);
    for (const old_str of ['missing', 'alpha', '']) {
      const result = await run('str_replace_editor', { relative_path: 'src/test.txt', old_str, new_str: 'oops' });
      assert.equal(result.success, false); assert.match(result.error, /surrounding lines/);
    }
    assert.equal((await run('str_replace_editor', { relative_path: 'src/test.txt', old_str: 'beta\nalpha', new_str: '$&\nlast' })).success, true);
    assert.equal((await run('read_project_file', { relative_path: 'src/test.txt' })).content, 'alpha\n$&\nlast\n');
    fs.writeFileSync(path.join(workspace, 'overlap.txt'), 'aaa');
    assert.equal((await run('str_replace_editor', { relative_path: 'overlap.txt', old_str: 'aa', new_str: 'b' })).success, false);
    const editCases = [
      { content: 'before\r\n  alpha  \r\n\tbeta\t\r\nafter\n', old_str: '\talpha\n beta ', new_str: '  changed\n$&', expected: 'before\r\n  changed\n$&\r\nafter\n' },
      { content: 'before\n  alpha\n \t\n beta\nafter', old_str: 'alpha\r\n\r\nbeta', new_str: 'replacement', expected: 'before\nreplacement\nafter' },
      { content: '  alpha\rinside \nlast', old_str: 'alphainside', new_str: 'first', expected: 'first\nlast' },
      { content: 'before\n  last  ', old_str: 'last', new_str: '', expected: 'before\n' },
      { content: '  first\nlast\n', old_str: 'first\nlast\n', new_str: 'whole', expected: 'whole' },
      { content: 'alpha\n  alpha  \n', old_str: 'alpha', error: /not unique/ },
      { content: 'x\n x \nx', old_str: 'x\nx', error: /not unique/ },
      { content: 'alpha beta\n', old_str: 'alpha  beta', error: /not found/ },
      { content: 'alpha\n\nbeta', old_str: 'alpha\nbeta', error: /not found/ },
      { content: 'alpha', old_str: 'alpha\nbeta', error: /not found/ },
    ];
    for (const { content, old_str, new_str = 'oops', expected, error } of editCases) {
      const relative_path = 'whitespace.txt';
      fs.writeFileSync(path.join(workspace, relative_path), content);
      const result = await run('str_replace_editor', { relative_path, old_str, new_str });
      assert.equal(result.success, !error, JSON.stringify({ content, old_str, result }));
      if (error) assert.match(result.error, error);
      assert.equal(fs.readFileSync(path.join(workspace, relative_path), 'utf8'), error ? content : expected);
    }
    fs.writeFileSync(path.join(root, 'outside.txt'), 'unchanged');
    fs.symlinkSync(root, path.join(workspace, 'escape'));
    for (const relative_path of ['../outside.txt', 'escape/outside.txt', 'escape/new/file.txt', path.join(root, 'outside.txt')]) {
      for (const name of ['write_project_file', 'str_replace_editor']) {
        const args = name === 'write_project_file' ? { content: 'bad' } : name === 'str_replace_editor' ? { old_str: 'unchanged', new_str: 'bad' } : name === 'search_project_content' ? { query: 'unchanged' } : {};
        assert.equal((await run(name, { relative_path, ...args })).success, false, `${name}: ${relative_path}`);
      }
    }
    for (const relative_path of ['../outside.txt', 'escape/outside.txt', path.join(root, 'outside.txt')]) {
      assert.equal((await run('read_project_file', { relative_path })).content, 'unchanged');
      assert.equal((await run('search_project_content', { query: 'unchanged', relative_path })).matches.length, 1);
    }
    assert.ok((await run('list_directory', { relative_path: root })).entries.some(entry => entry.name === 'outside.txt'));
    assert.match((await run('read_project_file', { relative_path: 'escape/new/file.txt' })).error, /FILE_NOT_FOUND/);
    assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'unchanged');
    fs.mkdirSync(path.join(workspace, 'node_modules'));
    fs.writeFileSync(path.join(workspace, 'node_modules', 'ignore.txt'), 'needle');
    fs.writeFileSync(path.join(workspace, 'binary'), Buffer.from('needle\0'));
    fs.writeFileSync(path.join(workspace, 'matches.txt'), Array(30).fill('needle').join('\n'));
    const found = await run('search_project_content', { query: 'n[e]+dle' });
    assert.equal(found.matches.length, 20);
    assert.ok(found.matches.every((match, i) => match.file_path === 'matches.txt' && match.line_number === i + 1));
    assert.ok((await run('list_directory', {})).entries.some(entry => entry.name === 'src'));
    assert.equal((await run('read_project_file', { relative_path: 'src/test.txt' }, 'missing')).success, false);
    const command = await run('execute_command', { command: 'pwd; printf failure >&2; exit 7' });
    assert.equal(command.exitCode, 7); assert.match(command.stdout, /workspace/); assert.equal(command.stderr, 'failure');
    const verbose = await run('execute_command', { command: "i=0; while [ $i -lt 100 ]; do printf 'line-%s padding-padding-padding\n' $i; i=$((i+1)); done" });
    assert.match(verbose.stdout, /Outputs 36 lines truncated/); assert.match(verbose.stdout, /line-99/); assert.ok(!verbose.stdout.includes('line-20 '));
    assert.equal((await run('execute_command', { command: 'pwd', cwd: '..' }, 'chat', 'workspace_write')).success, false);
    const commandSchema = agentTools.find(tool => tool.function.name === 'execute_command').function.parameters;
    assert.equal(commandSchema.properties.user_confirmed.type, 'boolean');
    assert.ok(!commandSchema.required.includes('user_confirmed'));
    // Harmless shell payload with a mutation-shaped string exercises the real guard and dispatch.
    const guardedCommand = "printf 'DELETE FROM test_records' > confirmed-command.txt";
    const marker = path.join(workspace, 'confirmed-command.txt');
    for (const confirmation of [{}, { user_confirmed: false }, { user_confirmed: 'true' }, { user_confirmed: 1 }]) {
      assert.match((await run('execute_command', { command: guardedCommand, ...confirmation }, 'chat', 'ask_approval')).error, /approval denied/);
      assert.equal(fs.existsSync(marker), false, 'Intercepted commands must not execute');
    }
    const confirmed = await run('execute_command', { command: guardedCommand, user_confirmed: true });
    assert.equal(confirmed.exitCode, 0);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'DELETE FROM test_records');
    assert.equal((await run('execute_command', { command: guardedCommand, user_confirmed: true, cwd: '..' }, 'chat', 'workspace_write')).success, false);
    assert.match((await run('execute_command', { command: guardedCommand, user_confirmed: true }, 'chat', 'ask_approval')).error, /approval denied/, 'Model cannot grant its own approval');
    const image = await run('take_screenshot', {});
    assert.equal(image.image_url.url, 'data:image/png;base64,cG5nLXRlc3Q=');
    assert.match(image.file_path, /[\\/]\.llm_workspace[\\/]screenshots[\\/]screenshot_\d+\.png$/);
    assert.equal(fs.readFileSync(image.file_path).toString(), 'png-test');
    assert.equal(fs.existsSync(path.join(workspace, '.gitignore')), false, 'Do not create a missing gitignore');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/');
    const [secondImage, thirdImage] = await Promise.all([run('take_screenshot', {}), run('take_screenshot', {})]);
    assert.notEqual(secondImage.file_path, thirdImage.file_path);
    assert.equal(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8'), 'node_modules/\n.llm_workspace/\n');
    assert.equal((await run('read_project_file', { relative_path: image.file_path })).image_url.url, image.image_url.url);
    fs.writeFileSync(path.join(userData, 'attachment.txt'), 'App attachment');
    fs.writeFileSync(path.join(temp, 'temp.txt'), 'Temporary file');
    for (const [directory, file, content] of [[userData, 'attachment.txt', 'App attachment'], [temp, 'temp.txt', 'Temporary file']]) {
      const filePath = path.join(directory, file);
      assert.equal(await isPathAllowed(filePath, workspace), true);
      assert.equal((await run('read_project_file', { relative_path: filePath })).content, content);
      assert.ok((await run('list_directory', { relative_path: directory })).entries.some(entry => entry.name === file));
      const search = await run('search_project_content', { query: content, relative_path: directory });
      assert.equal(search.matches[0].file_path, filePath);
      assert.equal((await run('write_project_file', { relative_path: filePath, content: 'blocked' })).success, false);
      assert.equal((await run('str_replace_editor', { relative_path: filePath, old_str: content, new_str: 'blocked' })).success, false);
    }
    const lookalike = path.join(root, 'userData-other'); fs.mkdirSync(lookalike);
    fs.writeFileSync(path.join(lookalike, 'secret.txt'), 'secret');
    assert.equal(await isPathAllowed(path.join(lookalike, 'secret.txt'), workspace), true);
    assert.equal((await run('read_project_file', { relative_path: path.join(lookalike, 'secret.txt') })).content, 'secret');
    assert.equal((await run('search_project_content', { query: 'secret', relative_path: lookalike })).matches[0].file_path, path.join(lookalike, 'secret.txt'));
    fs.symlinkSync(lookalike, path.join(temp, 'escape'));
    assert.equal((await run('read_project_file', { relative_path: path.join(temp, 'escape', 'secret.txt') })).content, 'secret');
    fs.unlinkSync(path.join(workspace, '.gitignore'));
    fs.symlinkSync(path.join(userData, 'attachment.txt'), path.join(workspace, '.gitignore'));
    assert.equal((await run('take_screenshot', {})).success, false, 'Screenshot must not modify an external gitignore symlink');
    assert.equal(fs.readFileSync(path.join(userData, 'attachment.txt'), 'utf8'), 'App attachment');
    fs.unlinkSync(path.join(workspace, '.gitignore'));
    fs.renameSync(path.join(workspace, '.llm_workspace'), path.join(workspace, '.saved_workspace'));
    fs.symlinkSync(temp, path.join(workspace, '.llm_workspace'));
    assert.equal((await run('take_screenshot', {})).success, false, 'Screenshot writes must stay in project even when temp reads are allowed');
    assert.equal((await run('take_screenshot', {}, null)).file_path, undefined, 'Global screenshot still returns an image without a project path');
    assert.deepEqual(captureOptions.types, ['screen', 'window']);
    assert.equal((await run('take_screenshot', { display_id: 'missing' })).success, false);
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: event => event.trusted });
    await assert.rejects(handlers.get('agent:execute-tool')({ trusted: false }, {}), /Unauthorized/);
    assert.equal((await handlers.get('agent:get-tools')({ trusted: true })).length, agentTools.length);
    assert.equal((await handlers.get('agent:execute-tool')({ trusted: true }, { name: 'read_project_file', arguments: { relative_path: 'src/test.txt' }, sessionId: 'chat' })).content, 'alpha\n$&\nlast\n');
    console.log('Agent tools: file scope, symlinks, editing, search, command output, screenshot payload and IPC passed.');
  } finally { dispose?.(); closeDatabase(); Module._load = originalLoad; os.tmpdir = originalTmpdir; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
