'use strict';
// Actual dpkg-installed closed-gate deb launch. Child-only disposable HOME is used for its normal
// purpose; the invoking shell and user's profile are never changed.
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const cp = require('node:child_process');
async function main() {
  assert.equal(process.argv.length, 3, 'Pass the exact G.4 candidate AppImage');
  const executable = fs.realpathSync(process.argv[2]);
  const pin = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  assert.equal(executable, '/opt/Continuum/continuum');
  assert.equal(cp.execFileSync('/usr/bin/dpkg-query', ['-W', '-f=${Status}', 'continuum'], {encoding:'utf8'}), 'install ok installed');
  const directory = fs.mkdtempSync('/tmp/continuum-g5-normal-');
  const profile = path.join(directory, 'profile');
  const childHome = path.join(directory, 'home');
  fs.mkdirSync(childHome); fs.mkdirSync(profile);
  const env = { ...process.env, NODE_ENV: 'production', HOME: childHome,
    XDG_CONFIG_HOME: path.join(childHome, '.config'), XDG_CACHE_HOME: path.join(childHome, '.cache'),
    XDG_DATA_HOME: path.join(childHome, '.local/share'), XDG_STATE_HOME: path.join(childHome, '.local/state') };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR', 'APPIMAGE_EXTRACT_AND_RUN']) delete env[name];
  let application;
  const runs = [];
  try {
    for (let restart = 0; restart < 2; restart++) {
      application = await _electron.launch({ executablePath: executable, chromiumSandbox: true,
        args: ['--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 45000 });
      const window = await application.firstWindow();
      await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);
      const runtime = await application.evaluate(({ app }) => {
        const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
        const fs = req('node:fs');
        const dependencies = req('./src/main/networkDependencies').resolveBundled();
        return { packaged: app.isPackaged, resources: process.resourcesPath, userData: app.getPath('userData'),
          home: req('node:os').homedir(), argv: process.argv, dependencies,
          mountInfo: fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(line => line.includes(process.resourcesPath.split('/resources')[0])),
          helperMode: fs.statSync(dependencies.helper).mode & 0o777,
          helperSha256: req('node:crypto').createHash('sha256').update(fs.readFileSync(dependencies.helper)).digest('hex') };
      });
      assert.equal(runtime.packaged, true); assert.equal(runtime.userData, profile); assert.equal(runtime.home, childHome);
      assert.equal(runtime.resources, '/opt/Continuum/resources');
      assert.equal(fs.existsSync(runtime.resources + '/B2G6-INSTALL-RECEIPT.json'), false, 'normal deb contains no qualification receipt');
      assert.ok(!runtime.argv.includes('--no-sandbox'));
      assert.equal(runtime.helperMode, 0o755);
      assert.equal(runtime.helperSha256, 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980');
      const status = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
      assert.equal(status.config.workspaceNetwork.policy, 'isolated'); assert.equal(status.status.available, false);
      assert.ok(status.status.blockers.some(text => text.includes('licenses/source')));
      assert.ok(!status.status.blockers.some(text => text.includes('manifest')));
      await window.getByRole('button', { name: 'Open settings', exact: true }).click();
      await window.getByRole('tab', { name: /Engine & API/ }).click();
      const option = window.locator('option[value="trusted_development"]');
      await option.waitFor({ state: 'attached' }); assert.equal(await option.isDisabled(), true);
      const rejected = await window.evaluate(async () => {
        try { await window.api.setWorkspaceNetwork({ version: 2, policy: 'trusted_development' }); return false; }
        catch { return (await window.api.getConfig()).workspaceNetwork.policy === 'isolated'; }
      });
      assert.equal(rejected, true);
      runs.push({ restart, ...runtime, status: status.status, isolated: true, nativeActivationRejected: true });
      await application.close(); application = null;
      assert.equal(fs.existsSync(runtime.resources), true);
      assert.equal(application, null);
    }
    console.log(JSON.stringify({ passed: true, artifactSha256: pin, evidenceLevel: 'dpkg-installed NONRELEASE deb GUI; networking disabled', runs, normalShutdown: true }));
  } finally { await application?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
