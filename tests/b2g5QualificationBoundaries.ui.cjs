'use strict';
const { _electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const [executable, record] = process.argv.slice(2), id = JSON.parse(fs.readFileSync(record));
  const profile = fs.mkdtempSync('/tmp/g5-wrong-profile-');
  const env = { ...process.env, NODE_ENV: 'production', HOME: id.childHome, XDG_CONFIG_HOME: id.childHome + '/.config', XDG_DATA_HOME: id.childHome + '/.local/share', XDG_CACHE_HOME: id.childHome + '/.cache' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: executable, chromiumSandbox: true, args: ['--user-data-dir=' + profile, '--disable-gpu'], env });
    const window = await app.firstWindow(); await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);
    const status = await window.evaluate(() => window.api.getWorkspaceNetworkStatus());
    assert.equal(status.available, false); assert.equal(status.code, 'QUALIFICATION_UNAVAILABLE');
    const rejected = await window.evaluate(async () => { try { await window.api.setWorkspaceNetwork({ version: 2, policy: 'trusted_development' }); return false; } catch { return true; } });
    assert.equal(rejected, true);
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'isolated');
    console.log(JSON.stringify({ passed: true, wrongProfileRejected: true, nativeActivationRejected: true, status }));
  } finally { await app?.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
