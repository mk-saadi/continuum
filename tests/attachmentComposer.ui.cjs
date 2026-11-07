// xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/attachmentComposer.ui.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const sharp = require('sharp');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
// Never use the installed application's profile.
const directory = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'attachment-composer-ui-'));
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/attachmentComposer.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const database = require('../src/main/db'); database.initDatabase();
    const fixtures = await require('./fixtures/attachmentImages.cjs').attachmentImages();
    for (const mode of ['selection', 'drop', 'paste']) {
      for (const fixture of fixtures) {
        const result = await window.webContents.executeJavaScript(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 20));
          const check = (condition, message) => { if (!condition) throw new Error(message + ': ' + (window.fixtureError || document.body.textContent)); };
          for (let i=0; i<100 && !document.querySelector('textarea[aria-label="Message"]'); i++) await tick();
          check(!window.fixtureError, 'Composer mount');
          const bytes = Uint8Array.from(atob(${JSON.stringify(fixture.bytes.toString('base64'))}), c => c.charCodeAt(0));
          const file = new File([bytes], ${JSON.stringify(mode === 'paste' && fixture.name === 'transparent.png' ? '' : fixture.name)}, {type:${JSON.stringify(fixture.mime)}});
          const transfer = new DataTransfer(); transfer.items.add(file);
          const input = document.querySelector('input[aria-label="Choose attachments"]');
          const textarea = document.querySelector('textarea[aria-label="Message"]');
          if (${JSON.stringify(mode)} === 'selection') { input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); }
          if (${JSON.stringify(mode)} === 'drop') input.closest('[data-dragging]').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
          if (${JSON.stringify(mode)} === 'paste') textarea.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:transfer}));
          let preview;
          for(let i=0;i<100;i++) { preview = document.querySelector('[aria-label="Selected attachments"] img'); if(preview?.complete && preview.naturalWidth) break; await tick(); }
          check(preview?.naturalWidth, 'Original preview decoded');
          const previewUrl = preview.src;
          const previewWidth = preview.naturalWidth, previewHeight = preview.naturalHeight;
          // Real browser rendering must not mutate the source envelope.
          const canvas = document.createElement('canvas'); canvas.width=1; canvas.height=1;
          canvas.getContext('2d').drawImage(preview,0,0);
          const alpha = canvas.getContext('2d').getImageData(0,0,1,1).data[3];
          textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
          for(let i=0;i<100 && !window.uploads.length;i++) await tick();
          check(window.uploads.length === 1, 'One original passed to desktop bridge');
          const original = window.uploads.shift();
          const remove = document.querySelector('[aria-label^="Remove "]'); remove?.click();
          await tick();
          return {original, previewUrl, previewWidth, previewHeight, alpha};
        })()`);
        const original = Buffer.from(result.original.dataUrl.split(',')[1], 'base64');
        assert.deepEqual(original, fixture.bytes, mode + ' ' + fixture.name + ' original bytes');
        assert.equal(result.previewUrl, result.original.dataUrl, 'preview reads the original; no canvas replacement');
        assert.deepEqual([result.previewWidth, result.previewHeight], [fixture.displayWidth || fixture.width, fixture.displayHeight || fixture.height]);
        const metadata = await sharp(original).metadata();
        assert.deepEqual([metadata.width, metadata.height], [fixture.width, fixture.height]);
        const attachments = await require('../src/main/fileUploads').processUploads([result.original]);
        assert.deepEqual(await fs.readFile(attachments[0].file_path), fixture.bytes, 'desktop storage preserves the renderer source');
        const messages = require('../src/main/promptBuilder').prepareChatMessages({ sessionId: `${mode}-${fixture.name}`, modelId: 'fixture', userText: 'Inspect fixture', attachments });
        let outgoing;
        const local = require('../src/main/modelCapabilities').createMediaGuardedFetch(async (url, options) => {
          if (url.endsWith('/props')) return Response.json({ modalities: { vision: true } });
          outgoing = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'Fixture complete' }, finish_reason: 'stop' }] });
        });
        await (await import('../src/lib/memoryChat.mjs')).runMemoryChat({ baseUrl: 'http://127.0.0.1:8999', modelId: 'fixture', messages, fetchImpl: local });
        const sent = outgoing.messages.at(-1).content.find(part => part.type === 'image_url');
        const submitted = Buffer.from(sent.image_url.url.split(',')[1], 'base64');
        const delivered = await sharp(submitted).metadata();
        assert.deepEqual([delivered.width, delivered.height], [fixture.displayWidth || fixture.width, fixture.displayHeight || fixture.height]);
        if (!fixture.displayWidth && fixture.mime !== 'image/webp') assert.deepEqual(submitted, fixture.bytes, 'preview did not replace submitted bytes');
        if (fixture.name === 'transparent.png' || fixture.mime === 'image/webp') assert.equal(result.alpha, 64);
        console.log(`${mode}: ${fixture.name} stored-source ${metadata.width}x${metadata.height} ${fixture.mime}; preview ${result.previewWidth}x${result.previewHeight}; bytes unchanged`);
      }
    }
    console.log('Real ChatInterface selection, drop, paste, preview, storage and outgoing local requests passed.');
  } finally { require('../src/main/db').closeDatabase(); window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
