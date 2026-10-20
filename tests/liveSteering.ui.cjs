// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/liveSteering.ui.cjs
//
// Deterministic renderer check for Phase 2.1: the composer stays editable while
// a run executes, Steer and Stop are separate actions, Enter steers instead of
// submitting a new turn, and the draft is not cleared by the composer itself.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'live-steering-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import ChatInput from './src/components/ChatInput';
          window.steers = []; window.stops = 0; window.queued = []; window.submissions = [];
          function Fixture() {
            const [busy, setBusy] = useState(false);
            window.setBusy = setBusy;
            return <ChatInput sessionId="steering" canSubmit sendTitle="Send"
              streaming steeringEnabled steeringBusy={busy}
              onSteer={text => window.steers.push(text)}
              onStop={() => { window.stops++; }}
              onQueue={text => window.queued.push(text)}
              onSubmit={text => window.submissions.push(text)} />;
          }
          createRoot(document.getElementById('root')).render(<Fixture />);
        `,
        loader: 'jsx',
        resolveDir: process.cwd(),
      },
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 50 && !document.querySelector('textarea'); i++) await wait();
      await wait();
      const input = document.querySelector('textarea');
      const type = text => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const steerButton = () => document.querySelector('[aria-label="Steer running agent"]');
      const stopButton = () => document.querySelector('[aria-label="Stop"]');

      check(input && !input.disabled && !input.readOnly, 'Composer stays editable during execution');
      check(steerButton(), 'Steer action is present during execution');
      check(stopButton(), 'Stop remains a separate action');
      check(steerButton().disabled, 'Steer is disabled without an instruction');

      type('Focus on the unit tests.');
      await wait();
      check(!steerButton().disabled, 'Steer enables when text is present');

      steerButton().click();
      await wait();
      check(window.steers.length === 1 && window.steers[0] === 'Focus on the unit tests.', 'Steer submits the draft');
      check(input.value === 'Focus on the unit tests.', 'Composer preserves the draft after steering');
      check(window.stops === 0 && window.submissions.length === 0, 'Steering is not sending a new turn or stopping');

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait();
      check(window.steers.length === 2, 'Enter steers instead of submitting a new turn');
      check(input.value === 'Focus on the unit tests.', 'Enter steering preserves the draft');

      stopButton().click();
      await wait();
      check(window.stops === 1 && window.steers.length === 2, 'Stop is independent from Steer');

      window.setBusy(true);
      await wait();
      check(steerButton().disabled, 'Steer is disabled while a submission is in flight');
      window.setBusy(false);
      await wait();

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }));
      await wait();
      check(window.queued[0] === 'Focus on the unit tests.', 'Post-run queue shortcut still works during execution');

      type('   ');
      await wait();
      check(steerButton().disabled, 'Whitespace cannot be steered');
      check(document.querySelector('textarea').value === '   ', 'Whitespace is not cleared by a disabled Steer');
    })()`);
    console.log('Composer steering UI passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
