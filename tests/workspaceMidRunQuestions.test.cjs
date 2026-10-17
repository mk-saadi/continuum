'use strict';
// Workspace chats always allow mid-run questions: with the box unchecked the
// ask_user tool is hidden from the schema while the model is still told about
// it, so agent runs that need input fail instead of asking.
// Run with: node --test tests/workspaceMidRunQuestions.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-midrun-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

const profiles = require('../src/main/profileSettings');
const sessions = require('../src/main/sessionManager');

const MODEL = 'workspace-midrun-model';

test('casual chats keep the stored preference', () => {
  const id = `casual-${Date.now()}`;
  sessions.getOrCreateSession(id, MODEL);
  assert.equal(profiles.getSessionSettings(id, MODEL).effective.allowMidRunQuestions, false);
  profiles.saveSessionMemorySettings(id, MODEL, { allowMidRunQuestions: true });
  assert.equal(profiles.getSessionSettings(id, MODEL).effective.allowMidRunQuestions, true);
  profiles.saveSessionMemorySettings(id, MODEL, { allowMidRunQuestions: false });
  assert.equal(profiles.getSessionSettings(id, MODEL).effective.allowMidRunQuestions, false);
});

test('workspace chats force mid-run questions on', () => {
  const projects = require('../src/main/projectManager');
  const project = projects.createProject({ name: 'Midrun Project' });
  const id = `workspace-${Date.now()}`;
  sessions.getOrCreateSession(id, MODEL, project.id);
  // Explicitly stored off: still forced on for project sessions.
  profiles.saveSessionMemorySettings(id, MODEL, { allowMidRunQuestions: false });
  assert.equal(profiles.getSessionSettings(id, MODEL).effective.allowMidRunQuestions, true);
});

test('forced value reaches the tool schema and system prompt', () => {
  const projects = require('../src/main/projectManager');
  const project = projects.createProject({ name: 'Midrun Schema Project' });
  const id = `schema-${Date.now()}`;
  sessions.getOrCreateSession(id, MODEL, project.id);
  profiles.saveSessionMemorySettings(id, MODEL, { allowMidRunQuestions: false });
  const { getToolContext, buildSessionSystemPrompt } = require('../src/main/promptBuilder');
  const names = getToolContext([], true, id, 'ask_approval', MODEL).tools.map((tool) => tool.function.name);
  assert.ok(names.includes('ask_user'), 'ask_user hidden despite workspace force-on');
  const prompt = buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, userText: '' }).content;
  assert.match(prompt, /MID-RUN CLARIFICATIONS \(ENABLED\)/);
});
