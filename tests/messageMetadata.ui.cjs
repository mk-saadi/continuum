// Run under Electron with a virtual display, like memorySettings.ui.cjs.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-metadata-ui-'));
  app.setPath('userData', directory);
  const { initDatabase, closeDatabase } = require('../src/main/db');
  const sessions = require('../src/main/sessionManager');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    initDatabase();
    sessions.getOrCreateSession('chat', 'model');
    const stats = { time: 2, totalTokens: 20, tokensPerSecond: 10 };
    const toolCalls = [{ id: 'tool', serverName: 'terminal', toolName: 'run_command', status: 'complete', result: { content: [{ type: 'text', text: 'OK' }] } }];
    const saved = sessions.saveMessage('chat', 'assistant', 'First answer', [], stats, toolCalls, { text: 'Recorded thinking', duration: 0 });
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/messageMetadata.jsx')], bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<html><body><div id="root"></div><script src="fixture.js"></script></body></html>');
    await window.loadFile(path.join(directory, 'index.html'));
    async function renderAndCheck(messages) {
      const result = await window.webContents.executeJavaScript(`(async () => {
        window.renderMessages(${JSON.stringify(messages)});
        await new Promise(resolve => setTimeout(resolve, 80));
        const article = document.querySelector('[data-message-id="${saved.id}"]');
        const thinking = article.querySelector('details');
        thinking.querySelector('summary').click();
        return {
          tool: article.querySelector('[aria-label="Tool executions"]').textContent,
          thinking: thinking.textContent,
          stats: article.querySelector('[aria-label="Generation statistics"]').textContent,
          open: thinking.open,
        };
      })()`);
      assert.match(result.tool, /terminal \/ run_command/);
      assert.match(result.tool, /complete/);
      assert.match(result.thinking, /Recorded thinking/);
      assert.match(result.thinking, /0.0s/);
      assert.match(result.stats, /20 total tokens/);
      assert.match(result.stats, /10.0 tok\/sec/);
    }
    await renderAndCheck([saved]);
    sessions.saveMessage('chat', 'user', 'Next turn');
    await renderAndCheck(sessions.loadSession('chat').messages);
    closeDatabase(); initDatabase();
    await renderAndCheck(sessions.getActiveMessages('chat'));
    console.log('Tool cards, thinking accordion/zero duration, and stats render after a new turn and SQLite close/reopen.');
  } finally { window.destroy(); closeDatabase(); await fs.rm(directory, { recursive: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
