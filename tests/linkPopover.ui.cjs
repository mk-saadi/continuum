// Run with Electron, with ELECTRON_RUN_AS_NODE unset.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-popover-'));
 const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
 try {
  await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import LinkPopover from './src/components/chat/LinkPopover.jsx'; createRoot(document.getElementById('root')).render(<LinkPopover href="http://localhost:5173/">Local server</LinkPopover>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, outfile: path.join(dir, 'app.js') });
  await fs.writeFile(path.join(dir, 'index.html'), '<div id="root"></div><script src="app.js"></script>');
  await win.loadFile(path.join(dir, 'index.html'));
  await win.webContents.executeJavaScript(`(async () => {
   const tick = () => new Promise(r => setTimeout(r, 60));
   const check = (v, text) => { if (!v) throw Error(text); };
   await tick(); let opened = []; let copied = [];
   window.open = (...args) => opened.push(args);
   Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
   const link = document.querySelector('a');
   check(!document.querySelector('[role=dialog]'), 'closed initially');
   link.click(); await tick();
   check(document.querySelector('[role=dialog]') && opened.length === 0, 'click opens actions without navigation');
   document.querySelector('[role=dialog] button').click(); await tick();
   check(copied[0] === 'http://localhost:5173/', 'copy retains exact URL');
   document.querySelectorAll('[role=dialog] button')[1].click(); await tick();
   check(opened[0][0] === 'http://localhost:5173/' && !document.querySelector('[role=dialog]'), 'explicit browser action opens and closes');
   link.click(); await tick(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await tick();
   check(!document.querySelector('[role=dialog]') && document.activeElement === link, 'Escape dismisses and restores focus');
   link.click(); await tick(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await tick();
   check(!document.querySelector('[role=dialog]'), 'outside click dismisses');
   link.click(); await tick(); window.dispatchEvent(new Event('scroll')); await tick();
   check(!document.querySelector('[role=dialog]'), 'scroll dismisses');
  })()`);
  console.log('Link popover: click, copy, browser action, Escape, outside click and scroll passed.');
 } finally { win.destroy(); await fs.rm(dir, { recursive: true, force: true }); }
 app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
