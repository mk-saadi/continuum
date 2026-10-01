const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'mermaid-ui-'));
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
    const diagram = '```mermaid\nflowchart LR\nA-->B\n```';
    const result = await browser.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for Mermaid SVG');
      };
      document.documentElement.setAttribute('data-theme', 'light');
      window.renderMessage(${JSON.stringify(diagram)});
      await waitFor(() => document.querySelector('[aria-label="Mermaid diagram"] svg'));
      const light = document.querySelector('[aria-label="Mermaid diagram"]').innerHTML;
      if (document.querySelector('.assistant-markdown pre')) throw new Error('Mermaid rendered as code');
      document.documentElement.setAttribute('data-theme', 'dark');
      await waitFor(() => {
        const svg = document.querySelector('[aria-label="Mermaid diagram"]')?.innerHTML;
        return svg && svg !== light;
      });
      return { svg: true, themeChanged: true };
    })()`);
    if (!result.svg || !result.themeChanged) throw new Error('Mermaid rendering failed.');
    console.log('Mermaid diagram and theme update passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
