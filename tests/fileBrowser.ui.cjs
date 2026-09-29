// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/fileBrowser.ui.cjs
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { registerLocalMediaProtocol } = require('../src/main/localMedia');
protocol.registerSchemesAsPrivileged([{ scheme: 'local', privileges: { standard: true, secure: true, stream: true } }]);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'file-browser-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    registerLocalMediaProtocol(protocol);
    const photo = path.join(directory, 'photo #100%.png');
    await fs.writeFile(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ToolCallBlock from './src/components/ToolCallBlock';
      window.opened = [];
      window.api = { openPath: async path => { window.opened.push(path); if(path.endsWith('missing.txt')) throw new Error('File missing'); } };
      const items = [
        { name: 'Photos', path: ${JSON.stringify(directory)}, type: 'directory' },
        { name: 'Photo', path: ${JSON.stringify(photo)}, type: 'file' },
        { name: 'Missing', path: '/tmp/missing.txt', type: 'file' },
      ];
      createRoot(document.getElementById('root')).render(<>
        <ToolCallBlock step={{ toolName: 'mcp_list_directory_with_size', status: 'complete', result: JSON.stringify(items) }} />
        <ToolCallBlock step={{ toolName: 'list_directory', status: 'complete', result: [] }} />
        <ToolCallBlock step={{ toolName: 'mcp_list_directory', status: 'complete', result: 'unrecognized output' }} />
      </>);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const source = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf8');
    const csp = source.match(/content="(default-src[^"]+)"/)[1];
    await fs.writeFile(path.join(directory, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="${csp}"><div id="root"></div><script src="fixture.js"></script>`);
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 60 && !document.querySelector('img')?.naturalWidth; i++) await tick();
      check(document.querySelector('img')?.naturalWidth === 1, 'Actual local image loads through protocol and CSP');
      const sections = document.querySelectorAll('[aria-label="Directory contents"]');
      check(sections.length === 2, 'Recognized listings render automatically');
      check(sections[1].textContent.includes('empty'), 'Empty state');
      document.querySelector('[aria-label="Open Photos"]').click(); await tick();
      document.querySelector('[aria-label="Open Photo"]').click(); await tick();
      check(window.opened.length === 2 && window.opened[1].includes('#100%'), 'Open receives original absolute paths');
      document.querySelector('[aria-label="Open Missing"]').click(); await tick();
      check(document.querySelector('[role="alert"]').textContent.includes('File missing'), 'Opening failures shown');
      const blocks = document.querySelectorAll('[aria-label="Tool executions"]');
      blocks[2].querySelector('button').click(); await tick();
      check(blocks[2].textContent.includes('unrecognized output'), 'Raw fallback preserved');
      blocks[0].querySelector('button').click(); await tick();
      check(blocks[0].querySelector('button').getAttribute('aria-expanded') === 'false', 'Widget can collapse');
    })()`);
    console.log('File browser integration, local image loading, native-open bridge calls, errors, empty state, and fallback passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
