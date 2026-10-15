const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'color-swatches-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage';
      const root = createRoot(document.getElementById('root'));
      window.renderMessage = content => root.render(<ChatMessage message={{ role: 'assistant', content }} />);
    `, loader: 'jsx', resolveDir: process.cwd(),
      }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    const result = await browser.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out: ' + document.getElementById('root').innerHTML.slice(0, 500));
      };
      const tick = String.fromCharCode(96);
      const fence = tick.repeat(3);
      const out = {};
      // 1. Hex + rgb/rgba/hsl in prose each gain a swatch with the right fill.
      window.renderMessage('Use #A8D8EA for calm, rgb(255, 0, 0) for alerts, rgba(0, 128, 0, 0.5) for go and hsl(210, 50%, 40%) for links.');
      await waitFor(() => document.querySelectorAll('.inline-color-swatch').length === 4);
      out.fills = [...document.querySelectorAll('.inline-color-swatch')].map(el => getComputedStyle(el).backgroundColor);
      out.labels = [...document.querySelectorAll('.inline-color-swatch')].map(el => el.getAttribute('aria-label'));
      out.titles = [...document.querySelectorAll('.inline-color-swatch')].map(el => el.getAttribute('title'));
      out.proseKept = document.querySelector('.assistant-markdown p').textContent.includes('#A8D8EA');
      // 2. Fenced blocks never gain swatches; inline code does (palette tables
      // list values as backticked HEX literals).
      window.renderMessage(fence + 'css\\n#FF0000\\nrgb(0, 0, 255)\\n' + fence);
      await waitFor(() => document.querySelector('.assistant-markdown pre'));
      await new Promise(resolve => setTimeout(resolve, 300));
      out.fenceSwatches = document.querySelectorAll('.inline-color-swatch').length;
      out.codeKept = document.querySelector('.assistant-markdown pre').textContent.includes('#FF0000');
      window.renderMessage('Inline ' + tick + '#00FF00' + tick + ' code.');
      await waitFor(() => document.querySelector('.inline-color-swatch'));
      out.inlineSwatch = getComputedStyle(document.querySelector('.inline-color-swatch')).backgroundColor;
      out.inlineKept = document.querySelector('.assistant-markdown').textContent.includes('#00FF00');
      // 3. Invalid values and non-colors stay plain.
      window.renderMessage('C# is a language, rgb(999, 0, 0) is out of range, issue #1234567 filed.');
      await waitFor(() => document.querySelector('.assistant-markdown p'));
      await new Promise(resolve => setTimeout(resolve, 300));
      out.invalidSwatches = document.querySelectorAll('.inline-color-swatch').length;
      out.invalidKept = document.querySelector('.assistant-markdown p').textContent.includes('rgb(999, 0, 0)');
      // 4. Bold text still gains swatches.
      window.renderMessage('Try **#F7C6D0 bold** color.');
      await waitFor(() => document.querySelector('.inline-color-swatch'));
      out.boldSwatch = getComputedStyle(document.querySelector('.inline-color-swatch')).backgroundColor;
      out.boldKept = document.querySelector('.assistant-markdown').textContent.includes('#F7C6D0');
      // 5. Palette table with backticked hex (the real-world case).
      window.renderMessage('| Color | Hex |\\n|---|---|\\n| Dusty Rose | ' + tick + '#E8B4B8' + tick + ' |\\n| Blush Pink | ' + tick + '#F5C6D0' + tick + ' |');
      await waitFor(() => document.querySelectorAll('.assistant-table .inline-color-swatch').length === 2);
      out.tableFills = [...document.querySelectorAll('.assistant-table .inline-color-swatch')].map(el => getComputedStyle(el).backgroundColor);
      return out;
    })()`);
    const has = (fill, rgb) => (fill || '').replace(/\s+/g, ' ').includes(rgb);
    if (result.fills.length !== 4) throw new Error('expected 4 swatches, got ' + result.fills.length);
    if (!has(result.fills[0], '168, 216, 234')) throw new Error('hex fill wrong: ' + result.fills[0]);
    if (!has(result.fills[1], '255, 0, 0')) throw new Error('rgb fill wrong: ' + result.fills[1]);
    if (!has(result.fills[2], '0, 128, 0')) throw new Error('rgba fill wrong: ' + result.fills[2]);
    if (!has(result.fills[3], '51, 102, 153')) throw new Error('hsl fill wrong: ' + result.fills[3]);
    if (!result.labels.every(label => /^Color preview: /.test(label || '')))
      throw new Error('swatches missing accessible labels');
    if (JSON.stringify(result.titles) !== JSON.stringify(['#A8D8EA', 'rgb(255, 0, 0)', 'rgba(0, 128, 0, 0.5)', 'hsl(210, 50%, 40%)']))
      throw new Error('swatch titles wrong: ' + JSON.stringify(result.titles));
    if (!result.proseKept) throw new Error('prose color text was removed');
    if (result.fenceSwatches !== 0) throw new Error('fenced block gained swatches');
    if (!result.codeKept) throw new Error('code content was altered');
    if (!has(result.inlineSwatch, '0, 255, 0')) throw new Error('inline code swatch wrong: ' + result.inlineSwatch);
    if (!result.inlineKept) throw new Error('inline code text was removed');
    if (result.invalidSwatches !== 0) throw new Error('invalid values gained swatches');
    if (!result.invalidKept) throw new Error('invalid text was removed');
    if (!has(result.boldSwatch, '247, 198, 208')) throw new Error('bold swatch wrong: ' + result.boldSwatch);
    if (!result.boldKept) throw new Error('bold color text was removed');
    if (result.tableFills.length !== 2 || !has(result.tableFills[0], '232, 180, 184') || !has(result.tableFills[1], '245, 198, 208'))
      throw new Error('palette table swatches wrong: ' + JSON.stringify(result.tableFills));
    console.log('Color swatches UI passed: ' + JSON.stringify({ fills: result.fills }));
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
