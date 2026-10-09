// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/skillImportIpc.test.cjs
// Linux cannot show one native picker for both files and folders: when
// `properties` lists openFile and openDirectory together, Electron opens a
// directory picker and .md/.zip files cannot be chosen. The skills:import
// handler therefore opens one mode per action — file (openFile + md/zip
// filter) or folder (openDirectory) — and both feed the same
// skills.importSkill(path, projectId) implementation.
const test = require('node:test');
const after = require('node:test').after;
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlers = new Map();
const dialogCalls = [];
let selection = null;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
  if (name === './promptBuilder') return { ...originalLoad.call(this, name, ...args), buildSessionSystemPrompt: () => ({ role: 'system', content: 'test', memoryContext: true }) };
  if (name === './profileSettings') return { ...originalLoad.call(this, name, ...args),
    getSessionSettings: () => ({ effective: { memoryEnabled: false, allowMidRunQuestions: false }, params: {} }) };
  if (name === 'electron') return {
    app: { isReady: () => true },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
    // Stands in for the native GTK picker: the test "selects" a path and the
    // recorded options prove which picker mode the handler asked the OS for.
    dialog: { showOpenDialogSync: options => { dialogCalls.push(options); return selection ? [selection] : []; } },
  };
  return originalLoad.call(this, name, ...args);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-home-'));
process.env.HOME = home;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-data-'));
const { initDatabase } = require('../src/main/db');
const manager = require('../src/main/mcpManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
Module._load = originalLoad;

initDatabase(dataDir);
manager.configPath = path.join(dataDir, 'mcp_config.json');
fs.writeFileSync(manager.configPath, JSON.stringify({ mcpServers: {} }));
manager.init = async () => {};
registerIpcHandlers({ isTrustedSender: event => event.trusted, getEngineConfig: () => ({ port: 12345 }), getReasoningEfforts: () => ['low', 'high'] });

const skills = require('../src/main/skillsManager');
const projects = require('../src/main/projectManager');

// 1. External SKILL.md file with frontmatter.
const markdown = path.join(home, 'deploy-checklist.md');
fs.writeFileSync(markdown, '---\nname: Deploy Checklist\ndescription: Run the deploy steps\n---\n# Deploy\nShip it.');
// 2. ZIP archive containing SKILL.md plus a supporting file.
function storedZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const filename = Buffer.from(name), content = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + content.length;
  }
  return Buffer.concat([...local, ...central]);
}
const archive = path.join(home, 'bundle.zip');
fs.writeFileSync(archive, storedZip([['bundle/SKILL.md', '# Bundle\nUse the guide.'], ['bundle/guide.txt', 'Supporting instructions']]));
// 3. Folder containing SKILL.md plus supporting files.
const folder = path.join(home, 'skill-folder');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'SKILL.md'), '# Folder Skill\nDo the folder thing.');
fs.writeFileSync(path.join(folder, 'notes.txt'), 'Folder notes');
// Fixtures for the unchanged validation paths. Note that a folder with no
// SKILL.md at all surfaces fs.statSync's ENOENT — that is the behaviour at
// HEAD, unchanged by this fix; the friendly message fires when SKILL.md exists
// but is not a file.
const wrongTypeFolder = path.join(home, 'wrong-type');
fs.mkdirSync(path.join(wrongTypeFolder, 'SKILL.md'), { recursive: true });
const brokenFolder = path.join(home, 'not-a-skill');
fs.mkdirSync(brokenFolder);
fs.writeFileSync(path.join(brokenFolder, 'README.txt'), 'no skill here');
const plainFile = path.join(home, 'readme.txt');
fs.writeFileSync(plainFile, 'not importable');
// Separate fixtures so every test imports a unique skill id.
const handoff = path.join(home, 'handoff.md');
fs.writeFileSync(handoff, '# Handoff\nPass the baton.');
const releaseFolder = path.join(home, 'release-notes');
fs.mkdirSync(releaseFolder);
fs.writeFileSync(path.join(releaseFolder, 'SKILL.md'), '# Release\nCut the release.');
const globalSkill = path.join(home, 'global-skill.md');
fs.writeFileSync(globalSkill, '# Global\nApplies everywhere.');

const sender = new EventEmitter();
const pick = value => { selection = value; };
const invoke = payload => handlers.get('skills:import')({ trusted: true, sender }, payload);
const lastDialog = () => dialogCalls.at(-1);
// Remove the fixture home and database rather than straying in /tmp.
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('file action opens a file picker only — no directory property (the Linux bug)', async () => {
  pick(markdown);
  const imported = await invoke({});
  assert.deepEqual(lastDialog(), { properties: ['openFile'], filters: [{ name: 'Skills', extensions: ['md', 'zip'] }] });
  assert.ok(!lastDialog().properties.includes('openDirectory'),
    'a combined picker silently becomes a folder picker on Linux');
  assert.equal(imported.id, 'deploy-checklist');
  assert.equal(imported.title, 'Deploy Checklist');
  assert.match(imported.description, /Run the deploy steps/);
  assert.ok(skills.listSkills().some(item => item.id === 'deploy-checklist'));
});

test('file picker selection imports a ZIP archive with its supporting files', async () => {
  pick(archive);
  const imported = await invoke({});
  assert.deepEqual(lastDialog().properties, ['openFile']);
  assert.equal(imported.id, 'bundle');
  assert.equal(skills.readSkillFile('bundle', 'guide.txt'), 'Supporting instructions');
});

test('folder action opens a directory picker only and imports the skill folder', async () => {
  pick(folder);
  const imported = await invoke({ kind: 'folder' });
  assert.deepEqual(lastDialog(), { properties: ['openDirectory'] });
  assert.ok(!lastDialog().properties.includes('openFile'),
    'the folder action must not offer file selection');
  assert.equal(lastDialog().filters, undefined);
  assert.equal(imported.id, 'skill-folder');
  assert.equal(skills.readSkillFile('skill-folder', 'notes.txt'), 'Folder notes');
});

test('cancelling either picker imports nothing', async () => {
  const before = skills.listSkills().length;
  pick(null);
  assert.equal(await invoke({}), null);
  assert.deepEqual(lastDialog().properties, ['openFile']);
  pick(null);
  assert.equal(await invoke({ kind: 'folder' }), null);
  assert.deepEqual(lastDialog().properties, ['openDirectory']);
  assert.equal(skills.listSkills().length, before, 'a cancelled dialog never starts an import');
});

test('validation and error handling are unchanged for both pickers', async () => {
  // SKILL.md exists but is not a file → the documented message, unchanged.
  pick(wrongTypeFolder);
  await assert.rejects(invoke({ kind: 'folder' }), /Folder must contain SKILL\.md\./);
  assert.ok(!skills.listSkills().some(item => item.id === 'wrong-type'), 'failed folder import leaves nothing behind');
  // Folder with no SKILL.md at all → same ENOENT as before, nothing imported.
  pick(brokenFolder);
  await assert.rejects(invoke({ kind: 'folder' }), /ENOENT/);
  assert.ok(!skills.listSkills().some(item => item.id === 'not-a-skill'), 'failed folder import leaves nothing behind');
  // Non-skill file chosen through the file picker → same message as before.
  pick(plainFile);
  await assert.rejects(invoke({}), /Choose a Markdown file, ZIP archive, or folder\./);
  assert.ok(!skills.listSkills().some(item => item.id === 'readme'));
});

test('projectId reaches the import for both file and folder actions', async () => {
  const project = projects.createProject({ name: 'Import Project' });
  pick(handoff);
  const fromFile = await invoke({ projectId: project.id });
  assert.equal(fromFile.id, 'handoff');
  assert.deepEqual(projects.getProject(project.id).enabledSkills, ['handoff']);

  pick(releaseFolder);
  const fromFolder = await invoke({ projectId: project.id, kind: 'folder' });
  assert.equal(fromFolder.id, 'release-notes');
  assert.deepEqual(projects.getProject(project.id).enabledSkills, ['handoff', 'release-notes'],
    'folder import enables the skill for the project exactly like file import');

  // Global imports (no projectId) keep the historical behaviour: the project's
  // enabled list is untouched. The id still comes from the document title.
  pick(globalSkill);
  const global = await invoke({});
  assert.equal(global.id, 'global');
  assert.equal(global.title, 'Global');
  assert.equal(global.active, true);
  assert.deepEqual(projects.getProject(project.id).enabledSkills, ['handoff', 'release-notes']);
});

test('preload routes both actions through skills:import with the right picker kind', async () => {
  // Loads the real preload against a mocked electron so the seam the renderer
  // actually calls is covered, not just the handler.
  const invokes = [];
  const exposed = {};
  const mock = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, payload) => { invokes.push({ channel, payload }); return Promise.resolve(null); },
      on: () => {}, removeListener: () => {}, send: () => {}, removeAllListeners: () => {},
    },
    webUtils: { getPathForFile: () => '' },
  };
  const load = Module._load;
  Module._load = function(name, ...args) { if (name === 'electron') return mock; return load.call(this, name, ...args); };
  try {
    delete require.cache[require.resolve('../src/preload')];
    require('../src/preload');
  } finally {
    Module._load = load;
  }
  const api = exposed.api;
  assert.equal(typeof api.importSkill, 'function');
  assert.equal(typeof api.importSkillFolder, 'function');
  await api.importSkill('proj-1');   // project card keeps its positional projectId
  await api.importSkill();           // settings tab stays global
  await api.importSkillFolder('proj-1');  // folder action adds only the kind
  assert.deepEqual(invokes, [
    { channel: 'skills:import', payload: { projectId: 'proj-1' } },
    { channel: 'skills:import', payload: { projectId: undefined } },
    { channel: 'skills:import', payload: { projectId: 'proj-1', kind: 'folder' } },
  ]);
});
