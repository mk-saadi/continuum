// Deterministic rendered UI acceptance. No model or provider is used.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'summary-panel-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await require('esbuild').build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import ContextPanel from './src/components/ContextPanel';
      const root = createRoot(document.getElementById('root'));
      window.renderPanel = sessionId => root.render(<ContextPanel sessionId={sessionId} modelId="model" active />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 100));
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      let fail = false, release;
      window.memoryPalace = {
        getSessionSummary: async id => { if (fail) throw new Error('write unavailable'); if (id === 'slow') return new Promise(resolve => { release = resolve; });
          return { text: id === 'empty' ? null : '## Objective\\nFinish the task <img src=x onerror=alert(1)>', status: id === 'empty' ? 'deferred' : 'completed' }; },
        getContextUsage: async () => ({ totalTokens: 500 }),
        onCompressionComplete: () => () => {},
      };
      const text = () => document.getElementById('root').textContent;
      window.renderPanel('saved'); await wait(); await wait();
      check(text().includes('Compaction summary') && text().includes('Finish the task'), 'saved summary renders');
      check(!document.querySelector('#root img'), 'summary is escaped');
      for (const old of ['Original task brief','Rolling summary','Archived messages','Current checkpoint']) check(!text().includes(old), 'retired panel absent: ' + old);
      window.renderPanel('empty'); await wait(); await wait();
      check(text().includes('No compaction summary yet') && text().includes('Deferred'), 'empty and deferred state');
      window.renderPanel('slow'); await wait();
      window.renderPanel('saved'); await wait(); await wait();
      release({ text: 'UNRELATED_OLD_SUMMARY' }); await wait();
      check(!text().includes('UNRELATED_OLD_SUMMARY'), 'stale session fetch cannot publish');
      fail = true; document.querySelector('#root button').click(); await wait();
      check(text().includes('write unavailable') && document.querySelector('[role="alert"]'), 'failure is visible');
      return { summary: true, escaped: true, retiredPanelsAbsent: true, deferred: true, isolated: true, failure: true };
    })()`);
    assert.ok(result.isolated && result.summary && result.failure); console.log(JSON.stringify(result));
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
