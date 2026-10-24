'use strict';
// Session-prompt wording optimization: redundancies reduced, behavior pinned.
// Run with: node --test tests/sessionPromptWording.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-wording-'));
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
const sessions = require('../src/main/sessionManager');
const mcpManager = require('../src/main/mcpManager');
const { buildSessionSystemPrompt } = require('../src/main/promptBuilder');
const { saveAppSettings } = require('../src/main/configManager');

// Fixture MCP config: one enabled server so the capability paragraph renders.
const originalConfigPath = mcpManager.configPath;
const fixtureConfigPath = path.join(directory, 'mcp_config.json');
fs.writeFileSync(fixtureConfigPath, JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }));
mcpManager.configPath = fixtureConfigPath;

const MODEL = 'wording-model';
const content = (mode, projectId = null) => {
  saveAppSettings({ mcpMode: mode });
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL, projectId);
  return buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, userText: '' }).content;
};
// Workspace session for full-text assertions (Casual Chat defers details to
// just-in-time reminders; see memoryChat tests).
const projects = require('../src/main/projectManager');
const workspaceProject = projects.createProject({ name: 'Wording', root_path: directory });
const workspaceContent = (mode) => content(mode, workspaceProject.id);

async function main() {
  await test('specialized delegation protocol accompanies directly available workspace tools', () => {
    const prompt = workspaceContent('auto');
    assert.match(prompt, /use advertised web tools/);
    assert.match(prompt, /### Sub-Agent Delegation Protocol/);
    const deferred = require('../src/main/promptBuilder').subAgentProtocol;
    assert.match(deferred, /MANDATORY Delegation Triggers/);
    assert.match(deferred, /fixed and read-only/);
    assert.match(deferred, /investigate.*cannot be combined with `url` or `target_file`/);
  });
  await test('casual profile preserves safety and omits workspace execution protocol', () => {
    const prompt = content('auto');
    assert.match(prompt, /Never bulk-delete/);
    assert.match(prompt, /explicit human confirmation/);
    assert.match(prompt, /DISABLED - AUTONOMOUS EXECUTION/);
    assert.doesNotMatch(prompt, /create a plan once|Background commands remain/);
  });
  await test('compact chart contract preserves supported types and numeric requirements', () => {
    const prompt = content('auto');
    assert.match(prompt, /bar\/line\/area\/pie/);
    assert.match(prompt, /matching keys and numeric values/);
    assert.match(prompt, /Do not run commands to generate chart images/);
    assert.match(prompt, /soft pastel hues/);
  });
  await test('workspace retains safety, activation, task continuity and MCP discovery', () => {
    const prompt = workspaceContent('auto');
    assert.match(prompt, /Never bulk-delete/);
    assert.match(prompt, /exact IDs created by the test/);
    assert.match(prompt, /explicit human confirmation/);
    assert.match(prompt, /find_and_prepare_mcp_tools/);
    assert.match(prompt, /MID-RUN CLARIFICATIONS \(ENABLED\)/);
    assert.match(prompt, /get the existing plan/);
    assert.match(prompt, /original user requirements authoritative/);
  });

  console.log('Session prompt wording: protocol, visualization, and rule behavior pinned.');
}

main().then(() => {
  saveAppSettings({ mcpMode: 'manual' });
  mcpManager.configPath = originalConfigPath;
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  try { closeDatabase(); } catch {}
  mcpManager.configPath = originalConfigPath;
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = 1;
});
