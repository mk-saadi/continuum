const { _electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
(async () => {
  const root = '/tmp/opencode/devprobe2';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  const vite = cp.spawn('npm', ['run', 'dev:vite'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', d => process.stdout.write('[vite] ' + d));
  vite.stderr.on('data', d => process.stdout.write('[vite-err] ' + d));
  for (let i = 0; i < 60; i++) { try { await fetch('http://localhost:5173/'); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
  const env = { ...process.env, NODE_ENV: 'development', CONTINUUM_NATIVE_TOOL_PROFILE: 'compact', HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'home/.config'), XDG_CACHE_HOME: path.join(root, 'home/.cache'),
    XDG_DATA_HOME: path.join(root, 'home/.local/share'), XDG_STATE_HOME: path.join(root, 'home/.local/state') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), chromiumSandbox: true,
    args: ['.', '--user-data-dir=' + path.join(root, 'profile'), '--disable-gpu'], env, timeout: 60000 });
  app.on('window', w => { console.log('[window]'); w.on('console', m => console.log('[console]', m.type(), String(m.text()).slice(0, 300))); w.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500))); });
  const win = await app.firstWindow();
  console.log('[firstWindow url]', win.url());
  await win.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(e => console.log('[loadstate]', String(e).slice(0, 200)));
  await new Promise(r => setTimeout(r, 4000));
  console.log('[url now]', win.url());
  console.log('[api present]', await win.evaluate(() => typeof window.api).catch(e => 'eval-failed ' + String(e).slice(0, 200)));
  console.log('[body]', (await win.locator('body').innerText().catch(() => '<none>')).slice(0, 300));
  await app.close(); vite.kill('SIGTERM');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
