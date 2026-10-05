const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'markdown-code-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage';
      const root = createRoot(document.getElementById('root'));
      window.renderMessage = content => root.render(<ChatMessage message={{ role: 'assistant', content }} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    const legacyDiagram = '```mermaid\nflowchart LR\nA-->B\n```';
    const codeBlock = await browser.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for the code block');
      };
      window.renderMessage(${JSON.stringify(legacyDiagram)});
      await waitFor(() => document.querySelector('.assistant-markdown pre'));
      const block = document.querySelector('.assistant-markdown pre');
      return {
        code: block.textContent,
        label: block.parentElement?.parentElement?.textContent,
        copy: Boolean(document.querySelector('button[aria-label="Copy code"]')),
        lineNumbers: block.querySelectorAll('.react-syntax-highlighter-line-number').length,
        svg: Boolean(document.querySelector('[aria-label="Mermaid diagram"] svg')),
      };
    })()`);
    if (!codeBlock.code.includes('flowchart LR') || !codeBlock.code.includes('A-->B') ||
      !codeBlock.label.includes('mermaid') || !codeBlock.copy || codeBlock.lineNumbers !== 2 || codeBlock.svg)
      throw new Error('Legacy diagram fence did not render as a standard code block.');
    const charts = await browser.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for chart');
      };
      const payload = { type: 'bar', title: 'Weather', xAxisKey: 'day',
        series: [{ key: 'temp', label: 'Temperature' }, { key: 'rain', label: 'Rain' }],
        data: [{ day: 'Mon', temp: 30, rain: 4 }, { day: 'Tue', temp: 31, rain: 2 }] };
      const fence = String.fromCharCode(96).repeat(3);
      window.renderMessage(fence + 'json:chart\\n' + JSON.stringify(payload) + '\\n' + fence);
      await waitFor(() => document.querySelector('[aria-label="Weather"] .recharts-bar'));
      const toggle = document.querySelector('button[aria-label="Hide Temperature"]');
      if (!toggle) throw new Error('Chart legend missing');
      toggle.click();
      await waitFor(() => document.querySelector('button[aria-label="Show Temperature"]'));
      if (document.querySelector('.assistant-markdown pre')) throw new Error('Chart rendered as code');
      for (const type of ['line', 'area', 'pie']) {
        payload.type = type;
        window.renderMessage(fence + 'chart\\n' + JSON.stringify(payload) + '\\n' + fence);
        await waitFor(() => document.querySelector('.recharts-' + type));
      }
      window.renderMessage(fence + 'json:chart\\n{bad json}\\n' + fence);
      await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('Unable to render chart: invalid JSON schema'));
      window.renderMessage(fence + 'json:chart\\n{"type":"bar"}\\n' + fence);
      await new Promise(resolve => setTimeout(resolve, 100));
      await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('Unable to render chart: invalid JSON schema'));
      return true;
    })()`);
    if (!charts) throw new Error('Interactive chart rendering failed.');
    console.log('Markdown code fallback and interactive charts passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
