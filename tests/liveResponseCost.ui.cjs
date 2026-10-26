// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/liveResponseCost.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-response-ui-'));
  const window = new BrowserWindow({ show: false, width: 500, height: 1000, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import RightSidebar from './src/components/RightSidebar';
      window.sessionTotals = { casual: 0.025, other: 1.5 };
      window.api = {
        getSessionCost: async id => ({ total: window.sessionTotals[id] ?? 0, partial: false }),
        getSubagentModel: async () => ({ mode: 'inherit' }),
        getModels: async () => [],
        getCloudProviders: async () => [],
        getCloudModelMetadata: async () => [],
        getEffectiveSettings: async () => ({ source: 'model', overrides: {}, effective: { systemPrompt: '', memoryEnabled: true, compactionEnabled: true } }),
        getSamplingParams: async () => ({ params: { temperature: 1, top_p: 0.9, repeat_penalty: 1 }, overrides: {}, exists: true }),
      };
      function Fixture() {
        const [state, setState] = useState({ streaming: true, liveResponseCost: { total: 0.001 } });
        window.updateCost = setState;
        return <RightSidebar open cloudChat isWorkspace={state.workspace ?? false} onClose={() => {}}
          sessionId={state.sessionId ?? "casual"} modelId="test" agents={[]} runtime={state} />;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, outfile: path.join(directory, 'fixture.js') });
    const assets = path.join(process.cwd(), 'dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><body style="background:#14191e;color:#ddd;--border:#45515b;--surface:#222b32;--text-secondary:#bbc2c8;--text-muted:#a2aab3;--accent:#f3c156"><div id="root" style="height:950px"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    const text = () => window.webContents.executeJavaScript(`document.querySelector('[aria-label="Response cost"]')?.textContent ?? ''`);
    await pause();
    assert.match(await text(), /Live response estimate.*\$0.001/);
    assert.match(await text(), /Total spent in this chat.*\$0.025/);
    await window.webContents.executeJavaScript('window.updateCost({ streaming: true, liveResponseCost: { total: 0.006 } })');
    await pause();
    assert.match(await text(), /\$0.006/);
    await fs.writeFile('/tmp/live-response-sidebar.png', (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`window.updateCost({ streaming: false, messages: [{ role: 'assistant', stats: { cost: { total: 0.005 } } }] })`);
    await pause();
    assert.match(await text(), /Latest response cost.*\$0.005/);
    await window.webContents.executeJavaScript('window.updateCost({ workspace: true, streaming: true, liveResponseCost: { total: 0.007 } })');
    await pause();
    assert.match(await text(), /Live response estimate.*\$0.007/);
    await window.webContents.executeJavaScript('window.updateCost({ workspace: true, sessionId: "other" })');
    await pause();
    assert.match(await text(), /Total spent in this chat.*\$1.50/);
    console.log('Live and settled cost display with independent session totals in both chat modes.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
