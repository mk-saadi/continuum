// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/projectModal.ui.cjs
//
// Regression guard for the "Create Project" modal hang.
//
// 6a19e7c moved project creation into a useCallback (handleCreateProject) and
// dropped the closeProjectModal()/setProjectModalOpen(false) call it replaced.
// The modal stayed open with busy=true forever ("Saving…"), and because busy
// disables Cancel and blocks Escape, the only escape was refreshing the app.
// The fix belongs in the modal (matching ModelSelectorModal/MemorySettings):
// onClose() runs after a successful onCreate. This harness renders a wrapper
// that unmounts the modal on close, exactly like GlobalModals in App.jsx.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
// Destroying the last window in `finally` would otherwise trigger Electron's
// default quit-on-last-window-closed, exiting 0 before `.catch` can report a
// failed assertion. Keep the process alive so failures actually fail.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'project-modal-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import ProjectModal from './src/components/ProjectModal';
        window.closeCalls = 0;
        window.apiCalls = { create: [] };
        window.scenario = 'ok';
        window.api = { pickDirectory: async () => '/home/user/demo-folder' };
        function Harness() {
          const [open, setOpen] = useState(true);
          return open ? (
            <ProjectModal
              onClose={() => { window.closeCalls++; setOpen(false); }}
              onCreate={async (fields) => {
                window.apiCalls.create.push(fields);
                if (window.scenario === 'fail') throw new Error('boom');
              }}
            />
          ) : null;
        }
        createRoot(document.getElementById('root')).render(<Harness />);
    `, loader: 'jsx', resolveDir: process.cwd() },
      bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const evalResult = await window.webContents.executeJavaScript(`(async () => {
      const flow = (async () => {
      try {
      const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
      const dialog = () => document.querySelector('dialog.project-dialog');
      const settle = async (predicate) => { for (let i = 0; i < 60 && !predicate(); i++) await tick(); };

      await settle(() => dialog());
      check(dialog(), 'project modal opens');
      check(document.body.textContent.includes('Create a project'), 'modal renders its heading');

      // Folder picker populates root_path (the path the reporter selected).
      button('Choose Folder').click();
      await settle(() => document.body.textContent.includes('demo-folder'));
      check(document.body.textContent.includes('demo-folder'), 'chosen folder path is shown');

      // Name is a controlled input; drive it through React's value setter.
      const input = dialog().querySelector('input');
      const setValue = (el, value) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(input, 'Demo Project');
      await tick();
      check(button('Create Project') && !button('Create Project').disabled, 'create is enabled once named');

      // Failure: the modal must stay open, show the error, and reset busy.
      window.scenario = 'fail';
      button('Create Project').click();
      await settle(() => document.body.textContent.includes('boom'));
      check(document.body.textContent.includes('boom'), 'failure surfaces the error');
      check(dialog(), 'modal stays open after a failed create');
      check(window.closeCalls === 0, 'modal is not closed on failure');
      check(button('Create Project'), 'button leaves the Saving… state after failure');

      // Success: the modal must close, and the fields must reach the handler.
      window.scenario = 'ok';
      button('Create Project').click();
      await settle(() => !dialog());
      check(!dialog(), 'modal closes after a successful create (the regression)');
      check(window.closeCalls === 1, 'onClose fires exactly once on success');
      check(window.apiCalls.create.length === 2, 'create invoked once per submit');
      const last = window.apiCalls.create[1];
      check(last && last.name === 'Demo Project', 'name is forwarded to onCreate');
      check(last && last.root_path === '/home/user/demo-folder', 'root_path is forwarded to onCreate');
      return { ok: true };
      } catch (error) { return { evalError: error?.message ?? String(error) }; }
      })();
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 60000));
      return Promise.race([flow, timeout]);
    })()`);
    if (evalResult?.evalError) throw new Error(`UI flow failed: ${evalResult.evalError}`);
    if (evalResult?.timedOut) throw new Error('UI flow timed out without completing');
    require('node:fs').writeSync(1, 'Project modal closes on successful create, stays open and reports failure otherwise.\n');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { require('node:fs').writeSync(2, `${error?.stack ?? error}\n`); app.exit(1); });
