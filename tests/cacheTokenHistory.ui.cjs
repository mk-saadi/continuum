// Run with the same Electron harness as tokenHistory.ui.cjs. Verifies the
// compact cache additions: gross vs uncached input, measured-zero/unknown
// labels, a ratio only for complete data, model filtering, and tooltip detail.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-token-history-ui-'));
  const window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/cacheTokenHistory.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 100));
      const check = (condition, text) => { if (!condition) throw new Error(text); };
      const body = () => document.getElementById('root').textContent;
      await wait();
      check(body().includes('Prompt (gross)') && body().includes('1,200'), 'gross prompt total shown');
      check(body().includes('Cached input') && body().includes('≥ 500'), 'partial cache total is a known subtotal');
      check(body().includes('1,000') && body().includes('500'), 'uncached and completion values shown');
      check(body().includes('Cache-hit ratio unavailable'), 'incomplete data withholds the ratio');
      check(body().includes('Cached reads may still occupy the context window'), 'occupancy is not implied to fall');
      const tooltip = document.querySelector('[role="tooltip"]').textContent;
      check(tooltip.includes('Gross input: 1,000'), 'tooltip separates gross input');
      check(tooltip.includes('Cached input: 500'), 'tooltip shows measured cache reads');
      check(tooltip.includes('Uncached input: 500'), 'tooltip shows uncached input');
      check(tooltip.includes('Cache hit: 50.0%'), 'tooltip ratio uses measured pair');
      const select = [...document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'model-a'));
      check(select, 'model filter is available when history carries model IDs');
      select.value = 'model-a'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
      check(window.queries.at(-1).modelId === 'model-a', 'model filter is sent to the history query');
      check(body().includes('Cache-hit ratio: 50.0%'), 'complete filtered history shows the ratio');
      check(body().includes('not reported') === false, 'measured filtered history does not claim missing data');
    })()`);
    console.log('Cache-aware token history UI: gross/uncached split, honest coverage, ratio and model filter passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
