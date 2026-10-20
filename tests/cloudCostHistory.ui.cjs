// Run with the same Electron harness as tokenHistory.ui.cjs. Verifies the
// cost additions to Token History: an estimated cloud total, a cache-savings
// figure, an explicit "not applicable" statement for local turns (never
// $0.00), precise tiny-cost formatting, per-model cost, and chart tooltips.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-cost-history-ui-'));
  const window = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/cloudCostHistory.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 120));
      const check = (condition, text) => { if (!condition) throw new Error(text); };
      const body = () => document.getElementById('root').textContent;
      await wait();
      check(body().includes('Estimated cloud cost'), 'a dedicated cost panel is shown');
      check(body().includes('$0.0121'), 'the measured cloud total is shown precisely');
      check(body().includes('Cache savings') && body().includes('+$0.006'), 'positive cache savings are shown as a signed value');
      check(body().includes('local model') && body().includes('not $0.00'), 'local turns are labelled not applicable, never $0.00');
      check(body().includes('Cost coverage: measured'), 'cost coverage states how complete the total is');
      const modelRows = [...document.querySelectorAll('tbody tr')].map(row => row.textContent);
      check(modelRows.some(row => row.includes('tiny-model') && row.includes('< $0.0001')), 'a tiny non-zero model cost is not rendered as $0.00');
      const tooltip = document.querySelector('[role="tooltip"]').textContent;
      check(tooltip.includes('Est. cloud cost:'), 'the chart tooltip carries the period cost');
    })()`);
    console.log('Cloud cost history UI: total, savings, not-applicable local, tiny-cost formatting, model cost and chart tooltip passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
