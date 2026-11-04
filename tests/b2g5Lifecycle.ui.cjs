'use strict';
// Actual FUSE-launched qualification archive and its default production services.
// No backend/readiness/safeStorage/dialog replacement. Native command approvals
// are explicit trusted harness user decisions through the normal guardTool API.
const { _electron, chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const [executable, identityPath] = process.argv.slice(2);
  const id = JSON.parse(fs.readFileSync(identityPath));
  assert.equal(id.productionQualified, false);
  const root = id.root, workspace = path.join(root, 'workspace');
  const evidence = { artifact: fs.realpathSync(executable), sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    qualificationAsarSha256: id.qualificationAsarSha256, nativeCommandApprovals: 'explicit trusted harness decisions through guardTool; no permission bypass', checks: {} };
  const env = { ...process.env, NODE_ENV: 'production', HOME: id.childHome,
    XDG_CONFIG_HOME: id.childHome + '/.config', XDG_CACHE_HOME: id.childHome + '/.cache', XDG_DATA_HOME: id.childHome + '/.local/share' };
  delete env.ELECTRON_RUN_AS_NODE;
  const bin = path.join(root, 'browser-handler'); fs.mkdirSync(bin, { recursive: true });
  const handler = path.join(bin, 'xdg-open');
  fs.writeFileSync(handler, '#!/bin/sh\ncase "$1" in http://127.*) exec /opt/google/chrome/chrome --user-data-dir=' + JSON.stringify(path.join(root, 'browser')) + ' "$@";; *) exit 1;; esac\n', { mode: 0o700 });
  env.PATH = bin + ':' + process.env.PATH; env.BROWSER = handler; env.XDG_CURRENT_DESKTOP = 'X-Generic';
  const applications = path.join(env.XDG_DATA_HOME, 'applications'); fs.mkdirSync(applications, { recursive: true }); fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  fs.writeFileSync(path.join(applications, 'g5-browser.desktop'), '[Desktop Entry]\nType=Application\nName=Disposable G5 Chrome\nExec=' + handler + ' %u\nMimeType=x-scheme-handler/http;\nNoDisplay=true\n');
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'mimeapps.list'), '[Default Applications]\nx-scheme-handler/http=g5-browser.desktop\n');
  let application, browser;
  // Inspector callbacks can run while a native SQLite rowFactory frame is
  // suspended. Schedule trusted harness work on the main loop to avoid
  // re-entering app APIs during that frame; do not change database behavior.
  const mainCall = (fn, argument) => application.evaluate((electron, { source, argument }) =>
    new Promise((resolve, reject) => setImmediate(() => {
      try { Promise.resolve(eval('(' + source + ')')(electron, argument)).then(resolve, reject); }
      catch (error) { reject(error); }
    })), { source: String(fn), argument });
  const launch = async () => {
    application = await _electron.launch({ executablePath: fs.realpathSync(executable), chromiumSandbox: true,
      args: ['--user-data-dir=' + id.profile, '--disable-gpu'], env, timeout: 45000 });
    const window = await application.firstWindow();
    window.setDefaultTimeout(15000);
    await window.setViewportSize({ width: 1600, height: 900 });
    await mainCall(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 900 }));
    await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);
    evidence.runtime = await mainCall(({ app, safeStorage }) => ({ packaged: app.isPackaged,
      resources: process.resourcesPath, profile: app.getPath('userData'), storage: safeStorage.getSelectedStorageBackend(),
      encryption: safeStorage.isEncryptionAvailable(), argv: process.argv }));
    assert.ok(evidence.runtime.packaged); assert.ok(evidence.runtime.resources.startsWith('/tmp/.mount_'));
    assert.ok(!evidence.runtime.argv.includes('--no-sandbox'));
    return window;
  };
  const nativeChoice = async (window, choice) => {
    const pending = window.locator('select').filter({ has: window.locator('option[value="trusted_development"]') }).selectOption('trusted_development');
    const child = cp.spawn('/usr/bin/python3', [path.join(__dirname, 'helpers/b2g5NativeDialog.py'), String(application.process().pid), choice], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = ''; child.stderr.on('data', data => { diagnostic += data; });
    await new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(Error(diagnostic || 'Native dialog failed'))));
    await pending; await window.waitForTimeout(400);
  };
  const command = args => mainCall(async (_electron, args) => {
    const f = global.g5, req = f.req, permissions = req('./src/main/toolPermissions');
    const approval = await permissions.guardTool({ name: 'execute_command', args, sessionId: f.sessionId, permissionMode: 'workspace_write',
      project: permissions.sessionProject(f.sessionId), signal: f.controller.signal, requestApproval: () => true });
    return req('./src/main/tools/agentTools').executeAgentTool({ name: 'execute_command', arguments: JSON.stringify(args),
      sessionId: f.sessionId, permissionMode: 'workspace_write', executionContext: f.context, backgroundContext: f.bg,
      signal: f.controller.signal, approval, permissionGranted: true });
  }, args);
  const checkCommand = async args => { const result = await command(args); assert.equal(result.success, true, JSON.stringify(result)); return result; };
  try {
    let window = await launch();
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'isolated');
    assert.equal((await window.evaluate(() => window.api.getWorkspaceNetworkStatus())).qualificationOnly, true);
    await window.getByRole('button', { name: 'Open settings', exact: true }).click();
    await window.getByRole('tab', { name: /Engine & API/ }).click();
    await window.getByText(/Trusted Development permits terminal internet access/).waitFor();
    assert.ok((await window.locator('body').innerText()).includes('private LAN'));
    await nativeChoice(window, 'cancel');
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'isolated');
    await nativeChoice(window, 'accept');
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'trusted_development');
    evidence.checks.nativeConsent = 'fresh Isolated, real native cancellation and acceptance passed';
    const persisted = JSON.parse(fs.readFileSync(path.join(id.profile, 'directories.json')));
    assert.equal(typeof persisted.workspaceNetworkReceipt, 'string'); assert.ok(persisted.workspaceNetworkReceipt.length > 20);
    await application.close(); application = null; window = await launch();
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'trusted_development');
    evidence.checks.protectedRestart = true;
    evidence.setup = await mainCall(({ app }, root) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
      const project = req('./src/main/projectManager').createProject({ name: 'B2G5 workflow', root_path: root + '/workspace', permissionMode: 'workspace_write' });
      const sessionId = 'g5-' + Date.now(), runId = 'g5-run';
      const sessions = req('./src/main/sessionManager'); sessions.getOrCreateSession(sessionId, 'fixture', project.id);
      sessions.updateSession(sessionId, 'title', 'B2G5 workflow');
      const context = req('./src/main/lspExecutionContext').createContext(sessionId, 'workspace_write', runId);
      const bg = { sessionId, runId, workspace: root + '/workspace' }, controller = new AbortController();
      req('./src/main/backgroundCommands').openRun({ ...bg, signal: controller.signal });
      global.g5 = { req, project, sessionId, runId, context, bg, controller }; return { sessionId, workspace: bg.workspace };
    }, root);
    evidence.faults = [];
    for (const reason of ['expiry', 'permission', 'termination', 'deletion', 'worker', 'helper', 'owner', 'oom', 'isolated', 'shutdown']) {
      if (reason === 'shutdown') {
        await window.getByRole('button', { name: 'Open settings', exact: true }).click();
        await window.getByRole('tab', { name: /Engine & API/ }).click();
        await nativeChoice(window, 'accept');
        assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'trusted_development');
      }
      const sessionId = await mainCall((_electron, reason) => {
        const f = global.g5, req = f.req; f.sessionId = 'g5-fault-' + reason + '-' + Date.now(); f.runId = f.sessionId;
        req('./src/main/sessionManager').getOrCreateSession(f.sessionId, 'fixture', f.project.id);
        f.context = req('./src/main/lspExecutionContext').createContext(f.sessionId, 'workspace_write', f.runId);
        f.bg = { sessionId: f.sessionId, runId: f.runId, workspace: f.bg.workspace }; f.controller = new AbortController();
        req('./src/main/backgroundCommands').openRun({ ...f.bg, signal: f.controller.signal }); return f.sessionId;
      }, reason);
      const server = await command({ command: 'python3 -I -m http.server 5174 --bind 127.0.0.1', background: true,
        survive_run_completion: true, background_lifetime_ms: reason === 'expiry' ? 5000 : 120000 });
      assert.ok(server.command_id);
      let faultPreview;
      for (let i = 0; i < 40; i++) {
        try { faultPreview = await window.evaluate(({ sessionId, commandId }) => window.memoryPalace.createCommandPreview(sessionId, commandId, 5174), { sessionId, commandId: server.command_id }); break; }
        catch { await delay(50); }
      }
      assert.ok(faultPreview, reason + ' preview readiness');
      // Resolve the actual packaged worker's host cgroup directly. A
      // foreground probe can finish after a short-lived fixture has expired;
      // its returned membership is not authoritative for the server scope.
      const workerPids = fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
        try { const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'); return argv.startsWith('/usr/bin/python3\0') && argv.includes(evidence.runtime.resources + '/workspace-network/networkExecutionWorker.py'); }
        catch { return false; }
      });
      assert.equal(workerPids.length, 1, reason + ' exactly one owned packaged worker');
      const membership = fs.readFileSync('/proc/' + workerPids[0] + '/cgroup', 'utf8');
      const group = '/sys/fs/cgroup' + membership.trim().split('::')[1];
      assert.equal(fs.readFileSync(path.join(group, 'memory.max'), 'utf8').trim(), '1073741824');
      const pids = fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim().split('\n');
      assert.ok(pids.includes(workerPids[0]));
      const before = await mainCall((_electron, commandId) => global.g5.req('./src/main/backgroundCommands').status(commandId, global.g5.bg), server.command_id);
      assert.equal(before.status, 'running', reason + ' fault requires a live server');
      if (reason === 'isolated') await window.evaluate(() => window.api.setWorkspaceNetwork({ version: 2, policy: 'isolated' }));
      if (reason === 'permission') await mainCall(() => global.g5.req('./src/main/lspExecutionContext').setMode(global.g5.sessionId, 'read_only'));
      if (reason === 'termination') await mainCall(() => global.g5.req('./src/main/backgroundCommands').terminateSession(global.g5.sessionId));
      if (reason === 'deletion') await mainCall(() => global.g5.req('./src/main/sessionDeletion').deleteConversation(global.g5.sessionId, null, () => false));
      if (['worker', 'helper', 'owner'].includes(reason)) {
        const target = pids.find(pid => { try { const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
          return reason === 'worker' ? argv.includes('networkExecutionWorker.py') : reason === 'helper' ? argv.includes('--disable-host-loopback') : argv.includes('sys.stdin.buffer.read(1)'); } catch { return false; } });
        assert.ok(target, reason); process.kill(Number(target), 'SIGKILL');
      }
      if (reason === 'oom') {
        const began = Date.now();
        const oom = await command({ command: 'python3 -I -c "x=bytearray(1536*1024*1024)"', timeout_ms: 15000 });
        assert.notEqual(oom.success, true); assert.ok(Date.now() - began < 20000, 'OOM must precede server lifetime');
      }
      if (reason === 'shutdown') {
        await application.close(); application = null;
        await assert.rejects(fetch(faultPreview.url));
        window = await launch();
        assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'trusted_development');
        await mainCall(({ app }) => { global.g5 = { req: process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js') }; });
        await assert.rejects(window.evaluate(({ sessionId, commandId }) => window.memoryPalace.getCommandPreview(sessionId, commandId), { sessionId, commandId: server.command_id }));
        evidence.checks.activeShutdownRestart = true;
      }
      for (let i = 0; i < 300; i++) {
        const active = await mainCall(() => ({ network: global.g5.req('./src/main/networkExecution').service.active(), previews: global.g5.req('./src/main/developmentPreviews').service.active() }));
        if (!active.network && !active.previews) break; await delay(30);
      }
      assert.equal(await mainCall(() => global.g5.req('./src/main/networkExecution').service.active()), 0, reason);
      assert.equal(await mainCall(() => global.g5.req('./src/main/developmentPreviews').service.active()), 0, reason);
      await assert.rejects(fetch(faultPreview.url));
      const alive = pid => { try { return !fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
      for (let i = 0; i < 100 && pids.some(alive); i++) await delay(20);
      assert.ok(pids.every(pid => !alive(pid)), reason + ' no live scope helpers');
      for (let i = 0; i < 100 && fs.existsSync(group); i++) await delay(20);
      assert.equal(fs.existsSync(group), false, reason + ' disposable scope removed');
      evidence.faults.push({ reason, passed: true, scope: group, capturedPids: pids, capturedScopePidsExited: true, scopeRemoved: true });
      console.log('FAULT', reason, 'passed');
    }
    await window.evaluate(() => window.api.setWorkspaceNetwork({ version: 2, policy: 'isolated' }));
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'isolated'); evidence.checks.isolatedRevert = true;
    fs.writeFileSync(path.join(root, 'lifecycle-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('PACKAGED_LIFECYCLE_RESULT', JSON.stringify(evidence));
  } finally { fs.writeFileSync(path.join(root, 'lifecycle-evidence.json'), JSON.stringify(evidence, null, 2)); await browser?.close(); await application?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
