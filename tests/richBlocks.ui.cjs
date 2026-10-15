const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rich-blocks-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage';
      import { RichBlock } from './src/components/RichBlocks';
      const root = createRoot(document.getElementById('root'));
      window.renderMessage = content => root.render(<ChatMessage message={{ role: 'assistant', content }} />);
      window.renderRich = (kind, raw, streaming) => root.render(
        <RichBlock kind={kind} raw={raw} streaming={streaming} fallback={<pre>fallback:{raw}</pre>} />
      );
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
      const fence = String.fromCharCode(96).repeat(3);
      const out = {};
      // 1. Cards render with badge + pastel swatch, non-hex dropped.
      const cards = JSON.stringify({ title: 'Pick', items: [
        { title: 'A', badge: 'fast', body: 'hello', note: 'n', swatches: ['#A8D8EA', 'red', 'url(javascript:alert(1))', '#zzz'] },
        { title: 'B', body: 'world' },
      ]});
      window.renderMessage(fence + 'json:cards\\n' + cards + '\\n' + fence);
      await waitFor(() => document.querySelector('.rich-block .rich-card-title'));
      out.cards = document.querySelector('.rich-block').textContent;
      const sw = [...document.querySelectorAll('.rich-swatches span')].map(s => s.style.backgroundColor);
      out.swatchCount = sw.length;
      if (!out.cards.includes('Pick') || !out.cards.includes('fast')) throw new Error('cards missing title/badge');
      if (out.swatchCount !== 1) throw new Error('non-hex swatches not dropped: ' + out.swatchCount);
      // 2. Invalid JSON finished -> fallback code block.
      window.renderMessage(fence + 'json:cards\\n{bad json}\\n' + fence);
      await waitFor(() => document.querySelector('.assistant-markdown pre'));
      out.invalidFallback = document.querySelector('.assistant-markdown pre').textContent.includes('bad json');
      // 3. Streaming skeleton via RichBlock directly.
      window.renderRich('cards', '{"items":[', true);
      await waitFor(() => document.querySelector('.rich-skeleton'));
      out.skeleton = Boolean(document.querySelector('.rich-skeleton'));
      // 4. Script string renders as literal text.
      const evil = JSON.stringify({ items: [{ title: '<script>alert(1)</script>' }] });
      window.renderMessage(fence + 'json:cards\\n' + evil + '\\n' + fence);
      await waitFor(() => document.querySelector('.rich-card-title'));
      out.scriptLiteral = document.querySelector('.rich-card-title').textContent.includes('<script>alert(1)</script>');
      out.noScriptTag = !document.querySelector('.rich-block script');
      // 5. Clipping: 10 items -> 8, long strings clipped.
      const many = JSON.stringify({ items: Array.from({length: 10}, (_, i) => ({ title: 'T'.repeat(500), body: 'B'.repeat(900) })) });
      window.renderMessage(fence + 'json:cards\\n' + many + '\\n' + fence);
      await waitFor(() => document.querySelectorAll('.rich-card').length === 8);
      out.clipped = document.querySelector('.rich-card-title').textContent.length <= 100;
      // 6. Flow renders arrows.
      const flow = JSON.stringify({ title: 'Pipe', steps: [{ title: 's1', body: 'b1' }, { title: 's2' }] });
      window.renderMessage(fence + 'json:flow\\n' + flow + '\\n' + fence);
      await waitFor(() => document.querySelector('.rich-arrow'));
      out.flow = document.querySelector('.rich-flow').textContent.includes('s1');
      // 6b. Bare-array cards (models improvise [...] instead of {"items":[...]}).
      const bare = JSON.stringify([
        { title: 'Cloud', body: 'Managed infrastructure with elastic scaling.' },
        { title: 'Local', body: 'Full control over hardware and data.' },
        { title: 'Hybrid', body: 'Critical data local, elastic peaks in cloud.' },
      ]);
      window.renderMessage(fence + 'json:cards\\n' + bare + '\\n' + fence);
      await waitFor(() => document.querySelectorAll('.rich-card').length === 3);
      out.bareArray = [...document.querySelectorAll('.rich-card-title')].map(el => el.textContent).join('|');
      // 6c. Empty items fall back to a code block, never empty chrome.
      window.renderMessage(fence + 'json:cards\\n{"items":[]}\\n' + fence);
      await waitFor(() => document.querySelector('.assistant-markdown pre'));
      out.emptyFallback = !document.querySelector('.rich-block');
      // 7. Chart pastel default: omitted colors use pastel palette.
      const chart = JSON.stringify({ type: 'bar', title: 'C', xAxisKey: 'd', series: [{ key: 'v' }], data: [{ d: 'x', v: 1 }] });
      window.renderMessage(fence + 'json:chart\\n' + chart + '\\n' + fence);
      await waitFor(() => document.querySelector('.recharts-bar'));
      const legendSwatch = document.querySelector('.recharts-legend-wrapper span')?.style?.backgroundColor || '';
      const barFill = document.querySelector('.recharts-bar path')?.getAttribute('fill') || '';
      out.chartSwatch = legendSwatch;
      out.chartFill = barFill;
      return out;
    })()`);
    const pastel = ['#A8D8EA', '#F7C6D0', '#C9E4C5', '#FDE2B3', '#D4C5F0', '#B8E0D8'];
    const hexOf = (v) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v || '');
      if (!m) return (v || '').toLowerCase();
      return '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
    };
    if (!result.invalidFallback) throw new Error('invalid JSON did not fall back');
    if (!result.skeleton) throw new Error('streaming skeleton missing');
    if (!result.scriptLiteral || !result.noScriptTag) throw new Error('script not rendered as literal text');
    if (!result.clipped) throw new Error('strings not clipped');
    if (!result.flow) throw new Error('flow missing');
    if (result.bareArray !== 'Cloud|Local|Hybrid') throw new Error('bare-array cards failed: ' + result.bareArray);
    if (!result.emptyFallback) throw new Error('empty items did not fall back');
    const got = hexOf(result.chartSwatch) || (result.chartFill || '').toUpperCase();
    if (!pastel.map(p => p.toUpperCase()).includes(got)) throw new Error('chart pastel default missing: ' + JSON.stringify(result.chartSwatch) + ' ' + result.chartFill);
    console.log('Rich blocks UI passed: ' + JSON.stringify({ swatches: result.swatchCount, fill: got }));
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
