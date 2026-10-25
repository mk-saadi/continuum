// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/gitIdentitySettings.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'git-identity-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await require('esbuild').build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import GitIdentitySettings from './src/components/GitIdentitySettings';
        window.api = {
          getConfig: async () => ({ gitIdentity: { name: 'Saved Name', email: 'saved@example.test' } }),
          setGitIdentity: async identity => {
            window.saved = identity;
            if (window.rejectSave) throw new Error('Identity could not be saved');
            return { gitIdentity: identity };
          },
        };
        createRoot(document.getElementById('root')).render(<GitIdentitySettings />);
      `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (value, message) => { if (!value) throw new Error(message); };
      for (let i = 0; i < 80 && document.querySelector('input')?.value !== 'Saved Name'; i++) await tick();
      const [name, email] = document.querySelectorAll('input');
      check(name.value === 'Saved Name' && email.value === 'saved@example.test', 'saved identity loads');
      check(name.labels.length && email.labels.length, 'fields have labels');
      const set = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(name, 'New Name'); set(email, 'new@example.test'); await tick();
      document.querySelector('form').requestSubmit(); await tick();
      check(window.saved.name === 'New Name' && window.saved.email === 'new@example.test', 'save passes both fields');
      check(document.body.textContent.includes('Git identity saved.'), 'success is shown');
      set(name, ''); set(email, ''); await tick();
      document.querySelector('form').requestSubmit(); await tick();
      check(window.saved.name === '' && window.saved.email === '', 'blank fields permit global fallback');
      window.rejectSave = true; document.querySelector('form').requestSubmit(); await tick();
      check(document.body.textContent.includes('Identity could not be saved'), 'save error is shown');
    })()`);
    console.log('Git identity Settings: load, labeled fields, save, clearing and failure passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
