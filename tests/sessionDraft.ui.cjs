const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-draft-ui-'));
  app.setPath('userData', directory);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/sessionDraft.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 30));
      window.renderDraft('a'); await wait(); window.updateDraft('Draft A'); await wait();
      window.renderDraft('b'); await wait();
      const emptyB = document.querySelector('textarea').value;
      window.updateDraft('Draft B'); await wait();
      window.renderDraft('a'); await wait();
      const restoredA = document.querySelector('textarea').value;
      window.updateDraft(''); await wait();
      return { emptyB, restoredA, a: localStorage.getItem('chat_draft_a'), b: localStorage.getItem('chat_draft_b') };
    })()`);
    assert.deepEqual(result, { emptyB: '', restoredA: 'Draft A', a: null, b: 'Draft B' });
    await window.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const restored = await window.webContents.executeJavaScript(`(async () => {
      window.renderDraft('b'); await new Promise(resolve => setTimeout(resolve, 40));
      return document.querySelector('textarea').value;
    })()`);
    assert.equal(restored, 'Draft B');
    console.log('Per-session drafts survive switching and reload, and clear independently.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
