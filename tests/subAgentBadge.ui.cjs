const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'sub-agent-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage';
      const root = createRoot(document.getElementById('root'));
      window.renderMessage = message => root.render(<ChatMessage message={message} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const step = { id: 'task1', type: 'tool_call', toolName: 'delegate_task', status: 'running', args: { task_description: 'Find routing code', target_files: ['app.js', 'routes.js'] } };
      window.renderMessage({ id: 'reply1', role: 'assistant', content: '', executionSteps: [step] }); await wait();
      let badge = document.querySelector('[aria-label="Sub-agent delegation"]');
      check(badge && !badge.open, 'Badge starts collapsed');
      check(badge.querySelector('summary').textContent.includes('Researching 2 files...'), 'Running label reports file count');
      badge.querySelector('summary').click(); await wait();
      check(badge.open && badge.textContent.includes('routes.js'), 'Expanded badge shows task and filenames');
      window.renderMessage({ id: 'reply1', role: 'assistant', content: 'Done', executionSteps: [{ ...step, status: 'complete', result: 'Routing lives in routes.js.' }] }); await wait();
      badge = document.querySelector('[aria-label="Sub-agent delegation"]');
      check(badge.open && badge.textContent.includes('Routing lives in routes.js.'), 'Completion preserves expansion and shows summary');
      check(badge.querySelector('summary').textContent.includes('Researched 2 files'), 'Completed label');
      window.renderMessage({ id: 'reply2', role: 'assistant', content: '', executionSteps: [{ ...step, status: 'error', result: { success: false, error: 'Request cancelled.' } }] }); await wait();
      badge = document.querySelector('[aria-label="Sub-agent delegation"]');
      check(badge.textContent.includes('Research failed') && badge.textContent.includes('Request cancelled.'), 'Failure status and reason');
      window.renderMessage({ id: 'legacy', role: 'assistant', content: '', toolCalls: [{ function: { name: 'delegate_task', arguments: JSON.stringify(step.args) }, status: 'complete', result: 'Legacy summary' }] }); await wait();
      check(document.querySelector('[aria-label="Sub-agent delegation"]').textContent.includes('Legacy summary'), 'Legacy tool call renders badge');
    })()`);
    console.log('Sub-agent badge: running, complete, error, collapse/expand, and legacy rendering passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
