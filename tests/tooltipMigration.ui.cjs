// Run with ELECTRON_RUN_AS_NODE unset under xvfb-run electron --no-sandbox.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tooltip-migration-'));
  const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        resolveDir: process.cwd(), loader: 'jsx', contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { Titlebar } from './src/components/main-app/Titlebar.jsx';
          import ToolEventCard from './src/components/chat/ToolEventCard.jsx';
          import LinkPopover from './src/components/chat/LinkPopover.jsx';
          import { SettingsButton } from './src/components/settings/SettingsSection.jsx';
          import { SelectField } from './src/components/FormControls.jsx';
          window.minimized = 0;
          window.windowAPI = { minimize: () => window.minimized++ };
          createRoot(document.getElementById('root')).render(<>
            <Titlebar />
            <ToolEventCard defaultExpanded={false} step={{type:'tool_call',toolName:'read_file',args:{relative_path:'src/main/baseSystemPrompt.js'},status:'success',result:'contents'}} />
            <SettingsButton tooltip="Import a skill" id="import">Import</SettingsButton>
            <SelectField tooltip="Choose permissions" label="Permissions" value="ask"><option value="ask">Ask</option></SelectField>
            <LinkPopover href="https://example.com" title="Reference page">Reference</LinkPopover>
          </>);
        `,
      },
      bundle: true, jsx: 'automatic', outfile: path.join(directory, 'app.js'),
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="app.js"></script>');
    await win.loadFile(path.join(directory, 'index.html'));
    win.focus();
    await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw Error(message); };
      await wait(80);
      check(!document.querySelector('[title]'), 'native titles must be absent, including forwarded props');
      const hover = async (element, text) => {
        check(element, 'tooltip trigger exists: ' + text);
        element.dispatchEvent(new MouseEvent('mouseover', {bubbles:true,clientX:20,clientY:20}));
        await wait(400);
        const tip = document.querySelector('[role="tooltip"]');
        check(tip?.textContent === text, 'custom hover tooltip: ' + text);
        check(element.getAttribute('aria-describedby') === tip.id, 'trigger describes tooltip');
        element.dispatchEvent(new MouseEvent('mouseout', {bubbles:true,relatedTarget:document.body}));
        await wait(20);
        check(!document.querySelector('[role="tooltip"]'), 'tooltip dismisses on leave');
      };
      const minimize = document.querySelector('[aria-label="Minimize"]');
      await hover(minimize, 'Minimize');
      minimize.click();
      check(window.minimized === 1, 'wrapped button retains click handler');
      const filePath = [...document.querySelectorAll('span')].find(el => el.textContent === 'src/main/baseSystemPrompt.js');
      await hover(filePath, 'src/main/baseSystemPrompt.js');
      await hover(document.querySelector('[aria-haspopup="listbox"]'), 'Choose permissions');
      await hover(document.querySelector('a'), 'Reference page');
      const button = document.querySelector('#import');
      button.focus(); await wait(400);
      check(document.querySelector('[role="tooltip"]')?.textContent === 'Import a skill', 'keyboard focus opens tooltip');
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await wait(20);
      check(!document.querySelector('[role="tooltip"]'), 'Escape dismisses tooltip');
    })()`);
    console.log('PASS: native titles removed; file paths, controls, links, hover, focus, Escape, and click handlers verified.');
  } finally {
    win.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
