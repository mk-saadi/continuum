// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/defaultWebSearch.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'search-settings-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await require('esbuild').build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import McpSettingsTab from './src/components/settings/McpSettingsTab';
      let settings = { mcpMode: 'auto', webSearchProvider: null };
      window.saved = null;
      window.api = { getAppSettings: async () => settings,
        saveAppSettings: async patch => { window.saved = patch; settings = {...settings, ...patch}; return settings; } };
      createRoot(document.getElementById('root')).render(<McpSettingsTab
        config={{ mcpServers: { search: { disabled: false }, disabled: { disabled: true } } }}
        status={{ servers: [{name: 'search', status: 'connected', tools: [{name: 'search_web', label: 'web'}]},
          {name:'disabled', tools:[{name:'disabled_web', label:'hidden'}]}] }} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 40));
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      for (let i=0;i<80 && !document.querySelector('[aria-haspopup="listbox"]:not(:disabled)');i++) await tick();
      const select = document.querySelector('[aria-haspopup="listbox"]');
      check(select && !select.disabled, 'shared SelectField loaded');
      select.click(); await tick();
      let options = document.querySelectorAll('[role="option"]');
      check(options.length === 2, 'native and enabled server options only');
      options[1].click(); await tick();
      check(window.saved.webSearchProvider.serverName === 'search', 'selected server saved');
      check(!('toolName' in window.saved.webSearchProvider), 'selection covers the server');
      select.click(); await tick();
      document.querySelectorAll('[role="option"]')[0].click(); await tick();
      check(window.saved.webSearchProvider === null, 'reset to native saved');
    })()`);
    console.log('Default web search selector, enabled tools, saving and native reset passed.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window.destroy(); await fs.rm(directory, {recursive:true, force:true}); app.exit(process.exitCode || 0); }
});
