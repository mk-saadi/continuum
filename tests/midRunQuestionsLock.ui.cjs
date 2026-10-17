const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'midrun-lock-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AgentSettingsPopover } from './src/components/AgentSettingsPopover';
      const root = createRoot(document.getElementById('root'));
      window.writes = [];
      window.render = (props) => root.render(
        <AgentSettingsPopover sessionId="chat" modelId="model"
          onMidRunQuestionsChange={(value) => window.writes.push(value)} {...props} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    await browser.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const open = async () => {
        document.querySelector('button[title="Agent Run Settings"]').click();
        await tick();
      };
      const box = () => [...document.querySelectorAll('input[type="checkbox"]')]
        .find(input => input.closest('label')?.textContent.includes('Mid-Run Questions'));
      // Locked (workspace): checked, disabled, workspace hint, no writes.
      window.render({ allowMidRunQuestions: false, midRunQuestionsLocked: true });
      await open();
      const locked = box();
      check(!!locked, 'mid-run checkbox missing');
      check(locked.checked === true, 'locked box not forced on');
      check(locked.disabled === true, 'locked box still editable');
      check(document.body.textContent.includes('Always on in workspace'), 'workspace hint missing');
      locked.click(); await tick();
      check(window.writes.length === 0, 'locked box wrote a change');
      // Unlocked (casual): reflects the prop, stays editable.
      window.writes = [];
      window.render({ allowMidRunQuestions: false, midRunQuestionsLocked: false });
      await tick(); await open();
      const openBox = box();
      check(openBox.checked === false, 'casual box should reflect off');
      check(openBox.disabled === false, 'casual box should stay editable');
      openBox.click(); await tick();
      check(window.writes.length === 1 && window.writes[0] === true, 'casual toggle not delivered');
    })()`);
    console.log('Mid-run lock UI passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
