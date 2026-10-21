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
  await test('sub-agent protocol keeps requirements without duplication', () => {
    const prompt = workspaceContent('auto');
    assert.equal((prompt.match(/### Sub-Agent Delegation Protocol/g) || []).length, 1);
    assert.match(prompt, /MANDATORY Delegation Triggers/);
    assert.match(prompt, /spawn_sub_agent/);
    assert.match(prompt, /target_files/);
    assert.match(prompt, /investigate.*cannot be combined with `url` or `target_file`/);
    assert.match(prompt, /fixed and read-only/);
    // Removed: the duplicated local-sweep bullet. The raw-matches-vs-delegate
    // decision rule survives in the Local Files trigger below.
    assert.equal((prompt.match(/when only the conclusion matters/g) || []).length, 0);
    assert.match(prompt, /when you want the raw matches in this context/);
    assert.match(prompt, /Delegate the bulk of the reading instead/);
    assert.doesNotMatch(prompt, /Example correct invocation/);
    assert.match(prompt, /Example investigation invocation/);
  });

  await test('casual chat defers details, keeps the safety core', () => {
    const prompt = content('auto');
    // Core behavior present in both modes.
    assert.match(prompt, /CRITICAL: Never output plain status text/);
    assert.match(prompt, /provide your final response directly/);
    assert.match(prompt, /Never run bulk deletion queries/);
    assert.match(prompt, /human confirmation before proceeding/);
    assert.match(prompt, /MANDATORY Delegation Triggers/);
    // Deferred to just-in-time reminders (memoryChat tests prove delivery).
    assert.doesNotMatch(prompt, /replace a specific anchor at the bottom/);
    assert.doesNotMatch(prompt, /collect those ids as you create the records/);
    assert.doesNotMatch(prompt, /Example investigation invocation/);
    // Casual chats keep the stored preference: off renders the DISABLED flow.
    assert.match(prompt, /DISABLED - AUTONOMOUS EXECUTION/);
    assert.match(prompt, /Summarize any assumptions made/);
  });

  await test('visualization keeps a parseable example and all rules', () => {
    const prompt = content('auto');
    assert.match(prompt, /### Visualizations & Charting Protocol/);
    assert.match(prompt, /#### ABSOLUTE FORBIDDEN ACTIONS/);
    assert.match(prompt, /matplotlib/);
    assert.match(prompt, /never numeric strings/);
    assert.match(prompt, /matches a numeric property/);
    const example = prompt.match(/```json:chart\n([\s\S]*?)\n```/)[1];
    assert.equal(JSON.parse(example).type, 'bar');
    assert.doesNotMatch(prompt, /^Trigger: Numerical metrics/m);
  });

  await test('autonomy, safety, browser, MCP and mid-run rules intact', () => {
    const prompt = workspaceContent('auto');
    assert.match(prompt, /CRITICAL: Never output plain status text/);
    assert.match(prompt, /provide your final response directly/);
    assert.match(prompt, /Never run bulk deletion queries/);
    assert.match(prompt, /delete only by that exact id list/);
    assert.match(prompt, /human confirmation before proceeding/);
    assert.match(prompt, /BROWSER AUTOMATION/);
    assert.match(prompt, /playwright-native/);
    assert.match(prompt, /Optional MCP integrations/);
    // Workspace chats force mid-run questions on (see workspaceMidRunQuestions):
    // the prompt advertises the ENABLED clarification flow, never DISABLED.
    assert.match(prompt, /MID-RUN CLARIFICATIONS \(ENABLED\)/);
    assert.match(prompt, /Call the `ask_user` tool/);
    assert.doesNotMatch(prompt, /DISABLED - AUTONOMOUS EXECUTION/);
    assert.doesNotMatch(prompt, /Summarize any assumptions made/);
    // Removed: mid-run bullet duplicating the autonomy loop rule.
    assert.doesNotMatch(prompt, /Complete all tool steps until the task objective is resolved/);
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
