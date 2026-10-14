// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoveryCard.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();

async function renderCase(window, directory, name, chatId, running) {
  await esbuild.build({
    stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import RecoveryCard from './src/components/chat/RecoveryCard';
      window.opened = 0;
      window.api = {
        getRecoveryOverview: async (sessionId) => {
          if (sessionId === 'empty-chat') return { state: 'empty', reason: 'no-history' };
          if (sessionId === 'partial-chat') return { state: 'partial', checkpointCount: 2, otherCheckpointCount: 0,
            latest: { id: 7, kind: 'shell', originChat: 'abc123', changedKinds: { modified: 3, created: 1, deleted: 0, renamed: 0, other: 0 }, skipped: [{ path: 'big.bin', reason: 'too_large' }] },
            runStart: { id: 5, kind: 'op' }, blobsChecked: 4, blobsMissing: 0 };
          if (sessionId === 'chat-b') return { state: 'protected', checkpointCount: 1, otherCheckpointCount: 0,
            latest: { id: 3, kind: 'op', originChat: 'chat-b', changedKinds: null, skipped: [] },
            runStart: { id: 3, kind: 'op' }, blobsChecked: 1, blobsMissing: 0 };
          return { state: 'protected', checkpointCount: 3, otherCheckpointCount: 1,
            latest: { id: 9, kind: 'op', originChat: 'abc123', changedKinds: null, skipped: [] },
            runStart: { id: 4, kind: 'op' }, blobsChecked: 2, blobsMissing: 0 };
        },
      };
      function Switcher() {
        const [chatId, setChatId] = useState('${chatId}');
        window.switchChat = setChatId;
        return <RecoveryCard sessionId={chatId} running={${running ? 'true' : 'false'}} onOpenHistory={() => window.opened++} />;
      }
      createRoot(document.getElementById('root')).render(<Switcher />);
    `, loader: 'jsx', resolveDir: process.cwd() },
    bundle: true, outfile: path.join(directory, `${name}.js`),
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  await fs.writeFile(path.join(directory, `${name}.html`), `<div id="root"></div><script src="${name}.js"></script>`);
  await window.loadFile(path.join(directory, `${name}.html`));
}

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'recovery-card-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await renderCase(window, directory, 'protected', 'chat-1', false);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 60 && !document.body.textContent.includes('Workspace Recovery'); i++) await tick();
      check(document.body.textContent.includes('Protected'), 'protected state shown');
      check(document.body.textContent.includes('+1 checkpoint'), 'other-chat count shown without mixing');
      check(document.body.textContent.includes('Run-start point available'), 'run-start presence shown');
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('View recovery history'));
      check(button && !button.disabled, 'history entry point enabled');
      button.click(); await tick();
      check(window.opened === 1, 'history opens exactly once');
    })()`);
    await renderCase(window, directory, 'partial', 'partial-chat', true);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 60 && !document.body.textContent.includes('Partial coverage'); i++) await tick();
      check(document.body.textContent.includes('3 modified · 1 created'), 'change summary shown');
      check(document.body.textContent.includes('1 path could not be captured'), 'skipped paths called out');
      check(document.body.textContent.includes('restoration unlocks when it stops'), 'active-run notice shown');
    })()`);
    await renderCase(window, directory, 'empty', 'empty-chat', false);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 60 && !document.body.textContent.includes('No recovery snapshots'); i++) await tick();
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('View recovery history'));
      check(button && button.disabled, 'empty state disables history entry');
    })()`);
    await renderCase(window, directory, 'switch', 'chat-1', false);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 60 && !document.body.textContent.includes('+1 checkpoint'); i++) await tick();
      window.switchChat('chat-b');
      for (let i = 0; i < 60 && !document.body.textContent.includes('chat-b'); i++) await tick();
      const text = document.body.textContent;
      check(!text.includes('+1 checkpoint'), 'previous chat state cleared on switch, nothing leaks');
    })()`);
    console.log('Recovery card protected/partial/empty states, counts, chat switching, and entry point passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
