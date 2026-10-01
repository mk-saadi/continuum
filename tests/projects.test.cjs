const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
const originalLoad = Module._load;
const handlers = new Map();
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: {
    handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name),
  } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');
const { buildProjectContext, buildSessionSystemPrompt, prepareChatMessages } = require('../src/main/promptBuilder');
(async () => {
  let dispose;
  try {
    let connection = initDatabase(directory);
    sessions.getOrCreateSession('legacy', 'model');
    connection.exec('DROP INDEX idx_sessions_project; ALTER TABLE sessions DROP COLUMN project_id; DROP TABLE project_files; DROP TABLE projects;');
    closeDatabase();
    connection = initDatabase(directory);
    assert.equal(sessions.loadSession('legacy').project_id, null);
    assert.ok(connection.pragma('foreign_key_list(sessions)').some(key => key.from === 'project_id' && key.table === 'projects'));
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'hello');
    fs.writeFileSync(path.join(workspace, 'src', 'nested', 'too-deep.js'), 'hidden');
    for (const name of ['node_modules', '.git', 'dist', 'build']) fs.mkdirSync(path.join(workspace, name));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Use the complete repository rules.\nSecond line.');
    fs.writeFileSync(path.join(workspace, 'PROJECT.md'), 'Fallback rules.');
    const project = projects.createProject({ name: 'Demo', description: 'Ship a useful app', custom_instructions: 'Keep changes small', root_path: workspace });
    assert.throws(() => projects.createProject({ name: 'Duplicate', root_path: workspace }), /UNIQUE/);
    assert.throws(() => projects.createProject({ name: ' ' }), /name/);
    assert.equal(projects.updateProject(project.id, { description: 'Updated goal' }).custom_instructions, 'Keep changes small');
    assert.equal(projects.updateProject(project.id, { description: null }).description, null);
    projects.updateProject(project.id, { description: 'Updated goal' });
    const file = projects.addProjectFile(project.id, { file_path: '/notes/spec.md', content: 'Stored specification' });
    assert.equal(projects.getProject(project.id).files[0].file_name, 'spec.md');
    sessions.getOrCreateSession('chat', 'model', project.id);
    assert.throws(() => sessions.getOrCreateSession('bad', 'model', 'missing'), /FOREIGN KEY/);
    assert.equal(buildProjectContext('legacy'), '');
    const context = buildProjectContext('chat');
    for (const expected of ['[PROJECT GOAL]\nUpdated goal', '[PROJECT INSTRUCTIONS]\nKeep changes small', '[PROJECT CONTEXT FILES]', 'Stored specification', '[REPOSITORY GUIDELINES]\nUse the complete repository rules.\nSecond line.', '[WORKSPACE STRUCTURE]', 'app.js', 'nested/']) assert.ok(context.includes(expected), expected);
    for (const absent of ['Fallback rules.', 'too-deep.js', 'node_modules', '.git', 'dist/', 'build/']) assert.ok(!context.includes(absent), absent);
    require('../src/main/profileSettings').saveSessionMemorySettings('chat', 'model', { memoryEnabled: false });
    const messages = prepareChatMessages({ sessionId: 'chat', modelId: 'model', userText: 'Hello' });
    assert.ok(messages.some(message => message.role === 'system' && message.content.includes('[PROJECT GOAL]')));
    assert.ok(messages.some(message => message.role === 'system' && message.content.includes('[AUTONOMY RULES]') && message.content.includes('CRITICAL: Never output plain status text') && message.content.includes('[TASK COMPLETE]')));
    for (const sessionId of ['chat', 'casual']) {
      const content = buildSessionSystemPrompt({ sessionId, modelId: 'model' }).content;
      assert.match(content, /### Visualizations & Charting/);
      assert.match(content, /NEVER run terminal commands \(`execute_command`\)/);
      assert.match(content, /xychart-beta/);
      assert.match(content, /pie title Weather Distribution/);
      assert.match(content, /graph TD/);
      assert.equal((content.match(/### Visualizations & Charting/g) || []).length, 1);
      assert.match(content, /### Sub-Agent Delegation Protocol/);
      assert.match(content, /MANDATORY Delegation Triggers/);
      assert.match(content, /spawn_subagent/);
      assert.match(content, /target_files/);
      assert.equal((content.match(/### Sub-Agent Delegation Protocol/g) || []).length, 1);
    }
    assert.ok(!buildSessionSystemPrompt({ sessionId: 'casual', modelId: 'model' }).content.includes('[PROJECT GOAL]'));
    assert.ok(!buildSessionSystemPrompt({ sessionId: 'casual', modelId: 'model', delegationAvailable: false }).content.includes('### Sub-Agent Delegation Protocol'));
    const subAgentRunner = require('../src/main/subAgentRunner');
    const originalExtract = subAgentRunner.extractWebPageData;
    try {
      subAgentRunner.extractWebPageData = async ({ url, query }) => {
        assert.equal(url, 'https://example.com/benchmarks');
        assert.match(query, /MMLU/);
        return 'MMLU: 68.0';
      };
      assert.equal(await require('../src/main/tools/agentTools').executeAgentTool({
        name: 'spawn_subagent', sessionId: 'chat', engine: { port: 4321, modelId: 'model' },
        arguments: { task: 'Inspect https://example.com/benchmarks for MMLU.' },
      }), 'MMLU: 68.0');
    } finally { subAgentRunner.extractWebPageData = originalExtract; }
    const branch = sessions.branchChat('chat', sessions.loadSession('chat').messages[0].id);
    assert.equal(sessions.loadSession(branch.sessionId).project_id, project.id);
    fs.unlinkSync(path.join(workspace, 'AGENTS.md'));
    assert.match(buildProjectContext('chat'), /\[REPOSITORY GUIDELINES\]\nFallback rules\./);
    projects.updateProject(project.id, { root_path: path.join(directory, 'missing') });
    assert.ok(!buildProjectContext('chat').includes('[WORKSPACE STRUCTURE]'));
    assert.match(buildProjectContext('chat'), /Stored specification/);
    const importPath = path.join(directory, 'reference.md');
    fs.writeFileSync(importPath, '# Imported reference');
    const imported = await projects.importProjectFiles(project.id, [importPath]);
    assert.equal(imported[0].content, '# Imported reference');
    assert.equal(imported[0].file_name, 'reference.md');
    assert.match(buildProjectContext('chat'), /# Imported reference/);
    const binaryPath = path.join(directory, 'binary.txt');
    fs.writeFileSync(binaryPath, 'bad\0bytes');
    const countBefore = projects.getProject(project.id).files.length;
    await assert.rejects(projects.importProjectFiles(project.id, [importPath, binaryPath]), /Binary/);
    assert.equal(projects.getProject(project.id).files.length, countBefore);
    projects.removeProjectFile(imported[0].id);
    projects.removeProjectFile(file.id);
    assert.equal(projects.getProject(project.id).files.length, 0);
    assert.throws(() => projects.removeProjectFile(file.id), /not found/);
    projects.setProjectPinned(project.id, true);
    assert.equal(projects.listProjects()[0].is_pinned, 1);
    assert.throws(() => projects.setProjectPinned(project.id, 'false'), /is_pinned/);
    closeDatabase(); initDatabase(directory);
    assert.equal(projects.getProject(project.id).is_pinned, 1);
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: event => event.trusted });
    const invoke = (channel, payload) => handlers.get(channel)({ trusted: true }, payload);
    await assert.rejects(handlers.get('project:create')({ trusted: false }, { name: 'Bad' }), /Unauthorized/);
    const ipcProject = await invoke('project:create', { name: 'IPC', description: 'Goal', custom_instructions: 'Instructions', root_path: workspace });
    assert.equal((await invoke('project:update', { id: ipcProject.id, description: 'New goal' })).description, 'New goal');
    const ipcFile = await invoke('project:add_file', { project_id: ipcProject.id, file_path: 'empty.txt', content: '' });
    assert.equal((await invoke('project:get_by_id', { id: ipcProject.id })).files.length, 1);
    await invoke('project:remove_file', { id: ipcFile.id });
    await invoke('project:set_pinned', { id: ipcProject.id, is_pinned: 1 });
    assert.equal((await invoke('project:list')).length, 2);
    await invoke('project:delete', { id: ipcProject.id });
    projects.addProjectFile(project.id, { file_path: 'cleanup.txt', content: 'cleanup' });
    projects.deleteProject(project.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_files').get().n, 0);
    assert.equal(sessions.loadSession('chat').project_id, null);
    assert.equal(sessions.loadSession('chat').messages.length, 1);
    assert.equal(connection.open, false);
    console.log('Project migration, CRUD, IPC, persistence, session linking, branches and context injection passed.');
  } finally {
    dispose?.(); closeDatabase(); Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
