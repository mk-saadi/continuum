// Low-risk correctness fixes: MCP capability naming, ask_user accuracy,
// temporal anchor dates. Run with: node --test tests/promptCorrectness.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-correctness-'));
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
const profiles = require('../src/main/profileSettings');
const mcpManager = require('../src/main/mcpManager');
const { buildTemporalAnchor } = require('../src/main/baseSystemPrompt');

const MODEL = 'correctness-model';

async function main() {
  await test('temporal anchor agrees with the local calendar date', () => {
    const anchor = buildTemporalAnchor();
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert.match(anchor, new RegExp(`\\(${local}\\)`));
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
    assert.match(anchor, new RegExp(`^\\[TEMPORAL CONTEXT\\]\nToday's Date: ${weekday},`));
  });

  await test('disabled MCP servers are not advertised as active capabilities', async () => {
    const { buildSessionSystemPrompt } = require('../src/main/promptBuilder');
    const { saveAppSettings } = require('../src/main/configManager');
    const originalPath = mcpManager.configPath;
    const configPath = path.join(directory, 'mcp_config.json');
    saveAppSettings({ mcpMode: 'auto' });
    try {
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {
        on: { command: 'on' },
        off: { command: 'off', disabled: true },
      } }));
      mcpManager.configPath = configPath;
      const id = crypto.randomUUID();
      sessions.getOrCreateSession(id, MODEL);
      const content = buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, userText: '' }).content;
      assert.match(content, /"on"/);
      assert.doesNotMatch(content, /"off"/);
      // A server enabled for this session counts even when config-disabled.
      mcpManager.sessionServers.set(id, new Set(['off']));
      try {
        const withSession = buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, userText: '' }).content;
        assert.match(withSession, /"off"/);
      } finally {
        mcpManager.sessionServers.delete(id);
      }
      // All disabled: the paragraph is omitted entirely.
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { off: { command: 'off', disabled: true } } }));
      const none = buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, userText: '' }).content;
      assert.doesNotMatch(none, /Available dynamic tools/);
    } finally {
      mcpManager.configPath = originalPath;
      saveAppSettings({ mcpMode: 'manual' });
    }
  });

  await test('ask_user hides when Mid-Run Questions is off, shows when on', async () => {
    const { getToolContext } = require('../src/main/promptBuilder');
    const id = crypto.randomUUID();
    sessions.getOrCreateSession(id, MODEL);
    const names = (tools) => tools.map(t => t.function.name);
    // Default off: genuinely unavailable, so hidden when identity resolves.
    assert.ok(!names(getToolContext([], true, id, 'ask_approval', MODEL).tools).includes('ask_user'));
    // Enabled: exposed with its generic description.
    profiles.saveSessionMemorySettings(id, MODEL, { allowMidRunQuestions: true });
    const enabled = getToolContext([], true, id, 'ask_approval', MODEL).tools
      .find(t => t.function.name === 'ask_user').function.description;
    assert.match(enabled, /Available only when Mid-Run Questions is enabled/);
    // Without model identity the setting cannot resolve: fail open (present).
    assert.ok(names(getToolContext([], true, id, 'ask_approval').tools).includes('ask_user'));
  });

  console.log('Prompt correctness: anchor dates, MCP naming, ask_user accuracy passed.');
}

main().then(() => {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = 1;
});
