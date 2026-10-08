// Run: node --test tests/skillProposalLegacyIpc.test.cjs
// B4: the old skill-proposal IPC path (preload `onSkillProposal` subscribing to
// `skill:propose-approval`, sent from ipcHandlers right after propose_skill
// runs) had no consumers — the production flow is propose_skill → execution
// step → ChatMessage/SkillProposalCard → Register/Decline. The dead path must
// stay removed and the live path must stay wired.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const productionFiles = [];
const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) productionFiles.push(full);
  }
};
walk(path.join(root, 'src'));
for (const entry of ['main.js', 'preload.js']) {
  const full = path.join(root, entry);
  if (fs.existsSync(full)) productionFiles.push(full);
}
const read = file => fs.readFileSync(file, 'utf8');
const relative = file => path.relative(root, file);

test('production code has no reference to the removed proposal IPC path', () => {
  const offenders = productionFiles
    .filter(file => /onSkillProposal|skill:propose-approval/.test(read(file)));
  assert.deepEqual(offenders.map(relative), [],
    'onSkillProposal / skill:propose-approval must stay removed from production sources');
});

test('preload still exposes the register path, without the dead listener', () => {
  const exposed = {};
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {}, removeHandlers: () => {} },
      webUtils: { getPathForFile: () => '' },
    };
    return originalLoad.call(this, name, ...args);
  };
  try {
    delete require.cache[require.resolve('../src/preload.js')];
    require('../src/preload.js');
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(exposed.api, 'preload still exposes the api surface');
  assert.equal(typeof exposed.api.saveSkill, 'function', 'the live register invoke stays exposed');
  assert.equal('onSkillProposal' in exposed.api, false, 'the dead proposal listener exposure is gone');
});

test('the execution-step proposal flow stays wired', () => {
  const chatMessage = read(path.join(root, 'src/components/ChatMessage.jsx'));
  assert.match(chatMessage, /SkillProposalCard/, 'ChatMessage still renders the proposal card');
  assert.match(chatMessage, /saveSkill\(\{ \.\.\.proposal, projectId \}\)/,
    'Register still posts { name, description, instructions, projectId }');
  const ipcHandlers = read(path.join(root, 'src/main/ipcHandlers.js'));
  assert.match(ipcHandlers, /propose_skill/, 'the propose_skill execution step still runs');
  assert.doesNotMatch(ipcHandlers, /propose-approval/, 'the dead sender stays removed');
});
