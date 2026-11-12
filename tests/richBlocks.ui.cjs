const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
// Keep the main process alive through cleanup so a failed assertion reaches the
// catch handler instead of exiting when the fixture window is destroyed.
app.on('window-all-closed', () => {});
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
      import AttachmentPreview from './src/components/chat/AttachmentPreview';
      import { RichBlock } from './src/components/RichBlocks';
      const root = createRoot(document.getElementById('root'));
      const previewPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
      window.openAttachmentCalls = 0;
      window.api = {
        previewAttachment: async () => ({ dataUrl: previewPng }),
        openAttachment: async () => { window.openAttachmentCalls++; },
      };
      window.renderMessage = content => root.render(<ChatMessage message={{ role: 'assistant', content }} />);
      window.renderAttachments = attachments => root.render(<AttachmentPreview attachments={attachments} />);
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
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
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
      // 1b. Cards media: local paths normalize to media://, https image/video pass through, invalid dropped.
      const mediaCards = JSON.stringify({ items: [
        { title: 'Local image', media: '/tmp/preview.png', swatches: ['#A8D8EA'] },
        { title: 'Remote image', media: 'https://example.com/banner.jpg' },
        { title: 'Local video', media: '/tmp/clip.webm' },
        { title: 'Remote video', media: 'https://example.com/clip.mp4' },
        { title: 'Invalid', media: 'javascript:alert(1)', swatches: ['#F7C6D0'] },
      ]});
      window.renderMessage(fence + 'json:cards\\n' + mediaCards + '\\n' + fence);
      await waitFor(() => document.querySelectorAll('.rich-card').length === 5);
      out.media = [...document.querySelectorAll('.rich-card-media')].map(el => el.tagName + ':' + el.getAttribute('src'));
      out.cardOpenIcons = document.querySelectorAll('.rich-card-media-open').length;
      // Swatches are suppressed whenever a card has media; the invalid-media card keeps its own.
      out.mediaSwatchCount = document.querySelectorAll('.rich-swatches').length;
      // 1c. Card images open a lightbox with previous/next navigation and video support.
      document.querySelector('.rich-card-media-button').click();
      await waitFor(() => document.querySelector('.media-lightbox[open]'));
      out.lightboxInitial = document.querySelector('.media-lightbox-media')?.getAttribute('src');
      out.lightboxCount = document.querySelector('.media-lightbox-count')?.textContent.trim();
      document.querySelector('.media-lightbox-next').click();
      await waitFor(() => document.querySelector('.media-lightbox-media')?.getAttribute('src') === 'https://example.com/banner.jpg');
      out.lightboxNext = document.querySelector('.media-lightbox-media')?.getAttribute('src');
      document.querySelector('.media-lightbox-next').click();
      await waitFor(() => document.querySelector('.media-lightbox-media')?.tagName === 'VIDEO');
      out.lightboxVideo = document.querySelector('.media-lightbox-media')?.tagName;
      document.querySelector('.media-lightbox-prev').click();
      await waitFor(() => document.querySelector('.media-lightbox-media')?.getAttribute('src') === 'https://example.com/banner.jpg');
      out.lightboxPrev = document.querySelector('.media-lightbox-media')?.getAttribute('src');
      document.querySelector('.media-lightbox-close').click();
      await waitFor(() => !document.querySelector('.media-lightbox'));
      out.lightboxClosed = !document.querySelector('.media-lightbox');
      // 1d. Remote video in plain Markdown renders as <video>, not an <img>.
      window.renderMessage('<video src="https://example.com/clip.mp4" controls></video>');
      await waitFor(() => [...document.querySelectorAll('.assistant-markdown video')].some(el => el.getAttribute('src') === 'https://example.com/clip.mp4'));
      out.markdownRemoteVideo = [...document.querySelectorAll('.assistant-markdown video')].map(el => el.getAttribute('src')).find(src => src === 'https://example.com/clip.mp4');
      // 1e. Agent-rendered Markdown images open in the lightbox.
      window.renderMessage('<img src="' + png + '" alt="Inline photo">');
      await waitFor(() => document.querySelector('.markdown-media-button img'));
      document.querySelector('.markdown-media-button').click();
      await waitFor(() => document.querySelector('.media-lightbox[open]'));
      out.markdownImageLightbox = document.querySelector('.media-lightbox-media')?.getAttribute('src');
      document.querySelector('.media-lightbox-close').click();
      await waitFor(() => !document.querySelector('.media-lightbox'));
      // 1f. User-sent image attachments open in the lightbox, not the desktop app.
      window.openAttachmentCalls = 0;
      window.renderAttachments([
        { id: 'a1', session_id: 's1', version_id: 'v1', file_path: '/tmp/a1.png', name: 'First', mime_type: 'image/png' },
        { id: 'a2', session_id: 's1', version_id: 'v2', file_path: '/tmp/a2.png', name: 'Second', mime_type: 'image/png' },
      ]);
      await waitFor(() => document.querySelector('[aria-label="View attachment First"] img'));
      document.querySelector('[aria-label="View attachment First"]').click();
      await waitFor(() => document.querySelector('.media-lightbox[open]'));
      out.attachmentLightbox = document.querySelector('.media-lightbox-media')?.getAttribute('src');
      out.attachmentCount = document.querySelector('.media-lightbox-count')?.textContent.trim();
      document.querySelector('.media-lightbox-next').click();
      await waitFor(() => document.querySelector('.media-lightbox-count')?.textContent.trim() === '2 / 2');
      out.attachmentNextCount = document.querySelector('.media-lightbox-count')?.textContent.trim();
      document.querySelector('.media-lightbox-close').click();
      await waitFor(() => !document.querySelector('.media-lightbox'));
      out.attachmentDesktopCalls = window.openAttachmentCalls;
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
      // 6d. Parallel flow rows: branches side by side, arrow after the row.
      const pflow = JSON.stringify({ title: 'P', steps: [{ title: 'a' }, { parallel: [{ title: 'b1' }, { title: 'b2' }, { title: 'b3' }] }, { title: 'c' }] });
      window.renderMessage(fence + 'json:flow\\n' + pflow + '\\n' + fence);
      await waitFor(() => document.querySelector('.rich-flow-row'));
      out.parallelLanes = document.querySelectorAll('.rich-flow-row .rich-card').length;
      out.parallelArrows = document.querySelectorAll('.rich-arrow').length;
      out.parallelConverges = [...document.querySelectorAll('.rich-card-title')].some(el => el.textContent === 'c');
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
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const expectedMedia = [
      'IMG:media://files/tmp/preview.png',
      'IMG:https://example.com/banner.jpg',
      'VIDEO:media://files/tmp/clip.webm',
      'VIDEO:https://example.com/clip.mp4',
    ];
    if (JSON.stringify(result.media) !== JSON.stringify(expectedMedia)) throw new Error('cards media wrong: ' + JSON.stringify(result.media));
    if (result.cardOpenIcons !== 0) throw new Error('card media still renders an expand icon');
    if (result.mediaSwatchCount !== 1) throw new Error('swatches not suppressed for media cards: ' + result.mediaSwatchCount);
    if (result.lightboxInitial !== 'media://files/tmp/preview.png') throw new Error('lightbox did not open the clicked image: ' + result.lightboxInitial);
    if (result.lightboxCount !== '1 / 4') throw new Error('lightbox count wrong: ' + result.lightboxCount);
    if (result.lightboxNext !== 'https://example.com/banner.jpg') throw new Error('lightbox next failed: ' + result.lightboxNext);
    if (result.lightboxVideo !== 'VIDEO') throw new Error('lightbox did not render video: ' + result.lightboxVideo);
    if (result.lightboxPrev !== 'https://example.com/banner.jpg') throw new Error('lightbox previous failed: ' + result.lightboxPrev);
    if (!result.lightboxClosed) throw new Error('lightbox did not close');
    if (result.markdownRemoteVideo !== 'https://example.com/clip.mp4') throw new Error('remote Markdown video did not render: ' + JSON.stringify(result.markdownRemoteVideo));
    if (result.markdownImageLightbox !== png) throw new Error('Markdown image did not open in the lightbox: ' + result.markdownImageLightbox);
    if (result.attachmentLightbox !== png) throw new Error('attachment did not open in the lightbox: ' + result.attachmentLightbox);
    if (result.attachmentCount !== '1 / 2') throw new Error('attachment lightbox count wrong: ' + result.attachmentCount);
    if (result.attachmentNextCount !== '2 / 2') throw new Error('attachment lightbox navigation failed: ' + result.attachmentNextCount);
    if (result.attachmentDesktopCalls !== 0) throw new Error('attachment media still opened the desktop app: ' + result.attachmentDesktopCalls);
    if (!result.invalidFallback) throw new Error('invalid JSON did not fall back');
    if (!result.skeleton) throw new Error('streaming skeleton missing');
    if (!result.scriptLiteral || !result.noScriptTag) throw new Error('script not rendered as literal text');
    if (!result.clipped) throw new Error('strings not clipped');
    if (!result.flow) throw new Error('flow missing');
    if (result.parallelLanes !== 3) throw new Error('parallel lanes wrong: ' + result.parallelLanes);
    if (result.parallelArrows !== 2) throw new Error('parallel arrows wrong: ' + result.parallelArrows);
    if (!result.parallelConverges) throw new Error('parallel row did not converge to next step');
    if (result.bareArray !== 'Cloud|Local|Hybrid') throw new Error('bare-array cards failed: ' + result.bareArray);
    if (!result.emptyFallback) throw new Error('empty items did not fall back');
    const got = hexOf(result.chartSwatch) || (result.chartFill || '').toUpperCase();
    if (!pastel.map(p => p.toUpperCase()).includes(got)) throw new Error('chart pastel default missing: ' + JSON.stringify(result.chartSwatch) + ' ' + result.chartFill);
    console.log('Rich blocks UI passed: ' + JSON.stringify({ swatches: result.swatchCount, fill: got }));
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
