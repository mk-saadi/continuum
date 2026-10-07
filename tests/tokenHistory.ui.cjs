const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'token-history-ui-'));
  const window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/tokenHistory.jsx')], bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 100));
      const check = (condition, text) => { if (!condition) throw new Error(text); };
      await wait();
      check(document.querySelector('figure'), 'Chart rendered');
      check(document.querySelector('[role="tooltip"]').textContent.includes('1,200'), 'Exact counts shown');
      const selects = document.querySelectorAll('select');
      selects[0].value = 'p1'; selects[0].dispatchEvent(new Event('change', { bubbles: true })); await wait();
      check(window.queries.at(-1).projectId === 'p1', 'Project filter');
      selects[1].value = 'week'; selects[1].dispatchEvent(new Event('change', { bubbles: true })); await wait();
      check(window.queries.at(-1).groupBy === 'week', 'Week grouping');
      selects[3].value = '3'; selects[3].dispatchEvent(new Event('change', { bubbles: true })); await wait();
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Save retention').click(); await wait();
      check(window.retained === 3, 'Retention saved');
      check(document.querySelectorAll('svg,canvas').length === 0, 'HTML-only chart');
    })()`);
    console.log('Token history chart, project filter, grouping and retention UI passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
