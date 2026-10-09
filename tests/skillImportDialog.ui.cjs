// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/skillImportDialog.ui.cjs
// The native dialog cannot offer file and folder selection at once (on Linux it
// becomes a folder picker), so the Skills UI exposes two explicit actions:
// "Import Skill File" (.md/.zip) → importSkill, and "Import Skill Folder" →
// importSkillFolder. Both must keep the existing busy/error handling, and the
// project card must keep passing its projectId.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const writeSync = require('node:fs').writeSync;
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
// The repo's UI tests note that app.exit can swallow console output, so the
// result is written synchronously to stderr.
const mark = text => writeSync(2, `${text}\n`);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-import-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SkillsSettingsTab from './src/components/settings/SkillsSettingsTab';
      import ProjectSkillsCard from './src/components/project/ProjectSkillsCard';
      window.calls = [];
      window.hold = false;
      window.release = null;
      window.failWith = null;
      const respond = kind => projectId => {
        window.calls.push({ kind, projectId });
        if (window.failWith) { const message = window.failWith; window.failWith = null; return Promise.reject(new Error(message)); }
        if (window.hold) return new Promise(resolve => { window.release = () => resolve({ id: 'held-' + kind }); });
        return Promise.resolve({ id: 'imported-' + kind });
      };
      window.api = {
        listSkills: async () => [],
        getAppSettings: async () => ({ disabledSkills: [] }),
        saveAppSettings: async () => ({ disabledSkills: [] }),
        deleteSkill: async () => ({ deleted: true }),
        importSkill: respond('file'),
        importSkillFolder: respond('folder'),
        getProject: async id => ({ id, enabledSkills: [] }),
        updateProject: async (id, patch) => ({ id, ...patch }),
      };
      createRoot(document.getElementById('settings')).render(<SkillsSettingsTab />);
      createRoot(document.getElementById('card')).render(
        <ProjectSkillsCard project={{ id: 'p9', name: 'Project', enabledSkills: [] }} onUpdated={() => {}} />
      );
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="settings"></div><div id="card"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === label);
      const untilIdle = async root => {
        // React defers the busy render by a microtask after a click, so an
        // immediate check can read pre-render DOM (all enabled) and return
        // while the buttons are about to be disabled — the next click would
        // then be swallowed. Let one macrotask pass before measuring.
        await wait();
        for (let i = 0; i < 60; i++) {
          const busy = [...root.querySelectorAll('button')].filter(node => node.disabled);
          if (!busy.length) return;
          await wait();
        }
        throw new Error('import actions never left the busy state');
      };
      const settings = () => document.getElementById('settings');
      const card = () => document.getElementById('card');
      await wait(); await wait();

      // 1. The settings tab offers both explicit actions; the old ambiguous
      //    single action is gone.
      const fileBtn = button(settings(), 'Import Skill File');
      const folderBtn = button(settings(), 'Import Skill Folder');
      check(fileBtn && folderBtn, 'settings exposes file and folder import actions');
      check(!button(settings(), 'Import Skill'), 'the old ambiguous action is gone');
      check(fileBtn.className.includes('primary') && !folderBtn.className.includes('primary'),
        'file import keeps the primary styling, folder import is secondary');

      // 2. File action → file API only, no projectId for global skills.
      fileBtn.click();
      await untilIdle(settings());
      check(window.calls.length === 1, 'exactly one import call per click');
      check(window.calls[0].kind === 'file', 'file action calls importSkill, got: ' + JSON.stringify(window.calls[0]));
      check(window.calls[0].projectId === undefined, 'global import passes no project id');

      // 3. Folder action → folder API only.
      folderBtn.click();
      await untilIdle(settings());
      check(window.calls.at(-1).kind === 'folder',
        'folder action calls importSkillFolder, got: ' + JSON.stringify(window.calls.at(-1)));

      // 4. Busy handling is unchanged: both actions disable while an import
      //    runs and re-enable afterwards.
      window.hold = true;
      fileBtn.click();
      await wait();
      check(fileBtn.disabled && folderBtn.disabled, 'both actions disable while an import runs');
      window.hold = false;
      window.release();
      await untilIdle(settings());
      check(!fileBtn.disabled && !folderBtn.disabled, 'actions re-enable after the import');

      // 5. Error handling is unchanged: the failure surfaces in the alert and
      //    the UI recovers.
      window.failWith = 'Skill import exploded';
      folderBtn.click();
      for (let i = 0; i < 60 && !settings().querySelector('[role="alert"]'); i++) await wait();
      const alert = settings().querySelector('[role="alert"]');
      check(alert && alert.textContent.includes('Skill import exploded'), 'import errors surface in the alert');
      await untilIdle(settings());
      check(!button(settings(), 'Import Skill Folder').disabled, 'the action recovers after a failed import');

      // 6. The project card offers both actions and keeps its projectId.
      button(card(), 'Manage Project Skills').click();
      await wait();
      const dialog = card().querySelector('[role="dialog"]');
      check(dialog, 'project skills dialog opens');
      const cardFile = button(dialog, 'Import Skill File');
      const cardFolder = button(dialog, 'Import Skill Folder');
      check(cardFile && cardFolder, 'project dialog offers file and folder import actions');
      cardFile.click();
      await untilIdle(dialog);
      check(JSON.stringify(window.calls.at(-1)) === JSON.stringify({ kind: 'file', projectId: 'p9' }),
        'project file import keeps the project id: ' + JSON.stringify(window.calls.at(-1)));
      cardFolder.click();
      await untilIdle(dialog);
      check(JSON.stringify(window.calls.at(-1)) === JSON.stringify({ kind: 'folder', projectId: 'p9' }),
        'project folder import keeps the project id: ' + JSON.stringify(window.calls.at(-1)));
    })()`);
    mark('Skill import UI: file/folder actions wired, busy/error handling intact, projectId preserved.');
    // Remove the bundle while the window is alive: destroying the last window
    // can trigger Electron's default quit before this cleanup runs.
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    mark(`Skill import UI test failed: ${error && error.stack ? error.stack : error}`);
    // Do not destroy the window first: closing the last window triggers
    // Electron's default quit with code 0, which races (and here beat)
    // the app.exit(1) below, so failures reported exit code 0.
    await fs.rm(directory, { recursive: true, force: true });
    app.exit(1);
    return;
  }
  window.destroy();
  app.exit(0);
}).catch(error => { mark(`Skill import UI test failed: ${error && error.stack ? error.stack : error}`); app.exit(1); });
