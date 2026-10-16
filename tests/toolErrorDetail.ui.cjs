// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/toolErrorDetail.ui.cjs
// Failed tool cards must show the recorded error detail (not just the
// classified one-liner) and Copy error must copy banner + detail.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const writeSync = require('node:fs').writeSync;
const path = require('node:path');
const mark = text => writeSync(2, `${text}\n`);
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'tool-error-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ToolEventCard from './src/components/chat/ToolEventCard';
      const root = createRoot(document.getElementById('root'));
      window.renderStep = step => root.render(<ToolEventCard step={step} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 80));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      window.__copied = null;
      try {
        navigator.clipboard.writeText = text => { window.__copied = text; return Promise.resolve(); };
      } catch {
        navigator.clipboard = { writeText: text => { window.__copied = text; return Promise.resolve(); } };
      }
      const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? '';
      const clickCopyError = async () => {
        window.__copied = null;
        const button = document.querySelector('button[aria-label="Copy error"]');
        if (!button) throw new Error('Copy error button missing');
        button.click();
        await wait(); await wait();
      };
      // 1. Failed edit: banner one-liner plus the recorded detail underneath.
      window.renderStep({ id: 'e1', type: 'tool_call', toolName: 'edit_project_files', status: 'error',
        error: 'A tool call failed.',
        result: { isError: true, error: 'old_str not found in invoice-backend/src/services/authService.js (edit 1 of 2)' },
        args: { edits: [] } });
      await wait();
      check(alertText().includes('A tool call failed.'), 'banner one-liner missing');
      check(alertText().includes('old_str not found'), 'recorded edit error not shown');
      await clickCopyError();
      check(window.__copied.includes('A tool call failed.'), 'copy lost the summary line');
      check(window.__copied.includes('old_str not found'), 'copy lost the actual error');
      // 2. Failed command: stderr shown; copy carries banner + stderr.
      window.renderStep({ id: 'e2', type: 'tool_call', toolName: 'execute_command', status: 'error',
        error: 'Command exited with status 2.',
        result: { exitCode: 2, stdout: 'partial output\\n', stderr: "ls: cannot access 'sms-collector': No such file\\n" },
        args: { command: 'ls sms-collector' } });
      await wait();
      check(alertText().includes('Command exited with status 2.'), 'exit banner missing');
      check(alertText().includes('cannot access'), 'stderr not shown under banner');
      await clickCopyError();
      check(window.__copied.includes('Command exited with status 2.'), 'copy lost exit line');
      check(window.__copied.includes('cannot access'), 'copy lost stderr');
      // 3. No duplication when result adds nothing beyond the banner.
      window.renderStep({ id: 'e3', type: 'tool_call', toolName: 'read_file', status: 'error',
        error: 'A file path was not found.',
        result: { isError: true, error: 'A file path was not found.' },
        args: { path: 'nope.txt' } });
      await wait();
      check(!document.querySelector('[aria-label="Error details"]'), 'duplicate detail block rendered');
      return true;
    })()`);
    mark('Tool error detail UI passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
