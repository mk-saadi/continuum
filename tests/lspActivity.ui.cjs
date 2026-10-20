const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-activity-ui-')); let window;
  try {
    await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import ToolCallBlock from './src/components/ToolCallBlock.jsx';
      import labels from './src/lib/lspToolLabels.json';
      createRoot(document.getElementById('root')).render(<>{Object.keys(labels).map((name, i) => <ToolCallBlock key={name} step={{ toolName: name, status: i === 5 ? 'error' : 'complete', args: { path: 'src/example.ts', query: 'answer' }, durationMs: 12, result: { success: i !== 5, state: i === 5 ? 'unavailable' : 'stale', returnedCount: 2, content: '<script>window.__unsafe = true</script>', nextCursor: 'opaque-cursor' } }} />)}</>);
    ` }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } }); await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      for (let n = 0; n < 100 && document.querySelectorAll('[aria-label="Tool executions"]').length < 6; n++) await new Promise(r => setTimeout(r, 20));
      const text = document.body.textContent;
      for (const label of ['Find definition', 'Find references', 'Document symbols', 'Search workspace symbols', 'Inspect type information', 'Check diagnostics', 'src/example.ts', '2 results', '12 ms', 'unavailable']) if (!text.includes(label)) throw new Error('Missing: ' + label);
      if (window.__unsafe) throw new Error('Untrusted content executed');
      document.querySelector('[aria-controls]').click();
      await new Promise(r => setTimeout(r, 100));
      if (window.__unsafe) throw new Error('Expanded untrusted content executed');
      if (!document.body.textContent.includes('Arguments') || !document.body.textContent.includes('Result')) throw new Error('Expandable result missing');
    })()`);
    console.error('LSP activity: six labels, locations, count, freshness, duration, expansion and inert content passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); app.exit(process.exitCode ?? 0); }
});
