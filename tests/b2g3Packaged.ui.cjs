'use strict';
// Run with node, passing an actual packaged executable. Only blocked production
// behavior is tested; no readiness/storage/backend injection is permitted.
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  if (process.argv.length !== 3) throw Error('Pass the packaged executable path');
  const executable = fs.realpathSync(process.argv[2]);
  const directory = fs.mkdtempSync('/tmp/continuum-g3-packaged-ui-');
  const home = path.join(directory, 'home'), profile = path.join(directory, 'profile');
  fs.mkdirSync(home); fs.mkdirSync(profile);
  // MCP and skills currently use os.homedir independently of userData. Hide
  // the real home using a disposable mount, without changing HOME or profiles.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = path.join(directory, 'launch');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/bwrap --die-with-parent --ro-bind / / --bind /tmp /tmp --dev-bind /dev /dev --bind ' +
    quote(home) + ' ' + quote(os.homedir()) + ' -- ' + quote(executable) + ' "$@"\n', { mode: 0o700 });
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: wrapper,
      args: ['--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    const packaged = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath, userData: app.getPath('userData') }));
    assert.equal(packaged.packaged, true);
    assert.equal(packaged.userData, profile);
    await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);
    const initial = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
    assert.equal(initial.config.workspaceNetwork.policy, 'isolated');
    assert.equal(initial.status.available, false);
    assert.ok(initial.status.blockers.some(s => s.includes('manifest')));
    await window.getByRole('button', { name: 'Open settings', exact: true }).click();
    await window.getByRole('tab', { name: /Engine & API/ }).click();
    const option = window.locator('option[value="trusted_development"]');
    await option.waitFor({ state: 'attached' });
    assert.equal(await option.isDisabled(), true);
    const rejected = await window.evaluate(async () => {
      try { await window.api.setWorkspaceNetwork({ version: 2, policy: 'trusted_development' }); return false; }
      catch { return (await window.api.getConfig()).workspaceNetwork.policy === 'isolated'; }
    });
    assert.equal(rejected, true);
    const image = process.env.B2G3_SCREENSHOT;
    if (image) await window.screenshot({ path: image });
    console.log(JSON.stringify({ passed: true, ...packaged, isolatedDefault: true,
      disabledTrustedChoice: true, nativeIpcActivationRejected: true,
      nativeEnableConfirmation: 'not reached: production gate correctly closed',
      installedNetworking: 'not qualified' }));
  } finally { await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
