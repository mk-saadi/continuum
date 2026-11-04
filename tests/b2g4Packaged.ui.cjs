'use strict';
// Actual packaged GUI with complete NONRELEASE resources. No readiness,
// safeStorage, backend or IPC substitution. Does not claim enabled networking.
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  if (process.argv.length !== 3) throw Error('Pass an actual packaged executable');
  const executable = fs.realpathSync(process.argv[2]);
  const directory = fs.mkdtempSync('/tmp/continuum-g4-gui-');
  const home = path.join(directory, 'home'), profile = path.join(directory, 'profile');
  fs.mkdirSync(home); fs.mkdirSync(profile);
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const wrapper = path.join(directory, 'launch');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/bwrap --die-with-parent --ro-bind / / --bind /tmp /tmp --dev-bind /dev /dev --bind ' +
    quote(home) + ' ' + quote(os.homedir()) + ' -- ' + quote(executable) + ' "$@"\n', { mode: 0o700 });
  const env = { ...process.env, NODE_ENV: 'production' }; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  const runs = [];
  try {
    for (let restart = 0; restart < 2; restart++) {
      application = await _electron.launch({ executablePath: wrapper,
        args: ['--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 });
      const window = await application.firstWindow();
      await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);
      const runtime = await application.evaluate(({ app }) => {
        const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
        return { packaged: app.isPackaged, resources: process.resourcesPath, userData: app.getPath('userData'),
          dependencies: req('./src/main/networkDependencies').resolveBundled() };
      });
      assert.equal(runtime.packaged, true); assert.equal(runtime.userData, profile);
      assert.ok(runtime.dependencies.worker.startsWith(runtime.resources + '/workspace-network/'));
      const status = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
      assert.equal(status.config.workspaceNetwork.policy, 'isolated');
      assert.equal(status.status.available, false);
      assert.ok(status.status.blockers.some(text => text.includes('licenses/source')));
      assert.equal(status.status.blockers.some(text => text.includes('manifest')), false);
      await window.getByRole('button', { name: 'Open settings', exact: true }).click();
      await window.getByRole('tab', { name: /Engine & API/ }).click();
      const option = window.locator('option[value="trusted_development"]');
      await option.waitFor({ state: 'attached' }); assert.equal(await option.isDisabled(), true);
      const rejected = await window.evaluate(async () => {
        try { await window.api.setWorkspaceNetwork({ version: 2, policy: 'trusted_development' }); return false; }
        catch { return (await window.api.getConfig()).workspaceNetwork.policy === 'isolated'; }
      });
      assert.equal(rejected, true);
      runs.push({ restart, ...runtime, isolated: true, trustDisabled: true, nativeActivationRejected: true });
      await application.close(); application = null;
    }
    console.log(JSON.stringify({ passed: true, evidenceLevel: 'actual extracted non-release package GUI', runs,
      trustedConfirmation: 'not reached: release gate closed', installedNetworkingAccepted: false }));
  } finally { await application?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
