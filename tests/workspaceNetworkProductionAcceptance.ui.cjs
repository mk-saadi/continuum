'use strict';
// Production AppImage acceptance for default outbound Workspace Write
// networking. Launches the actual `npm run dist` AppImage on its FUSE mount
// with a disposable child-only profile, then exercises the real packaged
// services: default standard-outbound tier without any consent dialog, real
// DNS/TLS, real npm installs with lifecycle containment, a persistent Vite
// dev server with authenticated preview, and the isolation regressions
// (host loopback/private LAN denied, namespace handles absent, cancellation).
const { _electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HELPER_PIN = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980';

async function main() {
  const executable = fs.realpathSync(process.argv[2]);
  const evidence = { artifact: executable, sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), checks: {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-prod-acceptance-'));
  const profile = path.join(root, 'profile'), childHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(childHome); fs.mkdirSync(profile); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(childHome, 'host-home-sentinel'), 'private fixture home');
  const env = { ...process.env, NODE_ENV: 'production', HOME: childHome,
    XDG_CONFIG_HOME: path.join(childHome, '.config'), XDG_CACHE_HOME: path.join(childHome, '.cache'),
    XDG_DATA_HOME: path.join(childHome, '.local/share'), XDG_STATE_HOME: path.join(childHome, '.local/state') };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR', 'APPIMAGE_EXTRACT_AND_RUN']) delete env[name];
  const mainCall = (fn, argument) => application.evaluate((electron, { source, argument }) =>
    new Promise((resolve, reject) => setImmediate(() => {
      try { Promise.resolve(eval('(' + source + ')')(electron, argument)).then(resolve, reject); }
      catch (error) { reject(error); }
    })), { source: String(fn), argument });
  const command = args => mainCall(async (_electron, args) => {
    const f = global.acceptance, req = f.req, permissions = req('./src/main/toolPermissions');
    const approval = await permissions.guardTool({ name: 'execute_command', args, sessionId: f.sessionId, permissionMode: 'workspace_write',
      project: permissions.sessionProject(f.sessionId), signal: f.controller.signal, requestApproval: () => { f.prompts = (f.prompts || 0) + 1; return true; } });
    return req('./src/main/tools/agentTools').executeAgentTool({ name: 'execute_command', arguments: JSON.stringify(args),
      sessionId: f.sessionId, permissionMode: 'workspace_write', executionContext: f.context, backgroundContext: f.bg,
      signal: f.controller.signal, approval, permissionGranted: true });
  }, args);
  const checkCommand = async args => { const result = await command(args); assert.equal(result.success, true, JSON.stringify(result).slice(0, 800)); return result; };
  let application;
  try {
    application = await _electron.launch({ executablePath: executable, chromiumSandbox: true,
      args: ['--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 60000 });
    const window = await application.firstWindow();
    window.setDefaultTimeout(20000);
    await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus);

    // 1. Production identity and verified bundled resources.
    evidence.runtime = await mainCall(({ app }) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
      const fs = req('node:fs');
      const dependencies = req('./src/main/networkDependencies').resolveBundled();
      return { packaged: app.isPackaged, resources: process.resourcesPath, userData: app.getPath('userData'),
        mount: fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.includes(process.resourcesPath.split('/resources')[0]) && / - fuse\./.test(line)),
        dependencies, helperSha256: req('node:crypto').createHash('sha256').update(fs.readFileSync(dependencies.helper)).digest('hex') };
    });
    assert.equal(evidence.runtime.packaged, true);
    assert.equal(evidence.runtime.userData, profile);
    assert.ok(evidence.runtime.resources.startsWith('/tmp/.mount_'), 'production AppImage must run from its FUSE mount');
    assert.equal(evidence.runtime.helperSha256, HELPER_PIN);
    evidence.checks.productionIdentityAndResources = true;
    console.log('PHASE production identity/resources passed');

    // 2. Default tier: standard outbound, available, no consent required.
    const status = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
    assert.equal(status.config.workspaceNetwork.policy, 'standard_outbound');
    assert.equal(status.status.available, true, JSON.stringify(status.status));
    assert.equal(status.status.effectivePolicy, 'standard_outbound');
    assert.equal(status.status.consentRequired, false);
    assert.ok(!JSON.stringify(status.status).includes('release approval pending'));
    assert.ok(!JSON.stringify(status.status).includes('NETWORK_RELEASE_APPROVAL_PENDING'));
    evidence.checks.defaultOutboundNoConsent = true;
    console.log('PHASE default standard outbound passed');

    // 3. Real workspace setup through the normal permission machinery.
    evidence.setup = await mainCall(({ app }, workspace) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
      const project = req('./src/main/projectManager').createProject({ name: 'Production acceptance', root_path: workspace, permissionMode: 'workspace_write' });
      const sessionId = 'acceptance-' + Date.now(), runId = 'acceptance-run';
      req('./src/main/sessionManager').getOrCreateSession(sessionId, 'fixture', project.id);
      req('./src/main/sessionManager').updateSession(sessionId, 'title', 'Production acceptance');
      const context = req('./src/main/lspExecutionContext').createContext(sessionId, 'workspace_write', runId);
      const bg = { sessionId, runId, workspace }, controller = new AbortController();
      req('./src/main/backgroundCommands').openRun({ ...bg, signal: controller.signal });
      global.acceptance = { req, project, sessionId, runId, context, bg, controller, prompts: 0 };
      return { sessionId, workspace };
    }, workspace);
    await window.reload();

    // 4. DNS + public HTTPS through the sandbox.
    const dns = await checkCommand({ command: 'getent hosts example.com' });
    assert.ok(dns.stdout.trim().length > 0, 'DNS resolution must succeed');
    evidence.checks.dns = dns.stdout.trim().split('\n')[0];
    const publicRequest = await checkCommand({ command: 'curl --noproxy "*" -fsS --max-time 15 -o /dev/null -w "%{http_code}" https://example.com' });
    assert.equal(publicRequest.stdout, '200');
    evidence.checks.publicHttps = '200';
    console.log('PHASE DNS/TLS passed');

    // 5. Isolation regressions inside the networked sandbox.
    const nft = await command({ command: '/usr/sbin/nft flush ruleset' });
    assert.equal(nft.success, false, 'nft mutation must stay denied');
    const ipv6 = await command({ command: 'curl --noproxy "*" -fsS --max-time 4 "http://[fd42::1]:12345"' });
    assert.equal(ipv6.success, false, 'external IPv6 must stay denied');
    const fds = await checkCommand({ command: "python3 -I -c 'import os; print([os.readlink(\"/proc/self/fd/\"+f) for f in os.listdir(\"/proc/self/fd\") if os.path.exists(\"/proc/self/fd/\"+f) and os.readlink(\"/proc/self/fd/\"+f).startswith((\"net:[\",\"user:[\"))])'" });
    assert.equal(fds.stdout.trim(), '[]', 'no inherited namespace handles');
    const sentinel = await command({ command: 'cat "$HOME/../../home/host-home-sentinel" 2>/dev/null; ls "$HOME/.." | head -3' });
    assert.ok(!sentinel.stdout.includes('private fixture home'), 'host home must stay inaccessible');
    // Host loopback service must not be reachable through the guest loopback.
    // A real host listener proves --disable-host-loopback end to end.
    const hostListener = cp.spawn('/usr/bin/python3', ['-I', '-m', 'http.server', '43129', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
    try {
      await delay(700);
      const hostProbe = cp.spawnSync('curl', ['--noproxy', '*', '-fsS', '--max-time', '2', 'http://127.0.0.1:43129/'], { encoding: 'utf8' });
      assert.equal(hostProbe.status, 0, 'the host listener must be reachable from the host itself');
      const hostLoopback = await command({ command: 'curl --noproxy "*" -fsS --max-time 3 http://127.0.0.1:43129/ ; echo "exit=$?"' });
      assert.ok(/exit=[1-7]/.test(hostLoopback.stdout), 'guest loopback must not reach the host listener: ' + hostLoopback.stdout.slice(0, 200));
      const privateLan = await command({ command: 'curl --noproxy "*" -fsS --max-time 4 http://10.11.12.13/ ; echo "exit=$?"' });
      assert.ok(/exit=[1-7]/.test(privateLan.stdout), 'private LAN probe must be denied: ' + privateLan.stdout.slice(0, 200));
    } finally { hostListener.kill(); }
    evidence.checks.isolation = { nftMutationDenied: true, externalIpv6Denied: true, namespaceHandlesAbsent: true, hostHomeInaccessible: true, hostLoopbackDenied: true, privateLandenied: true };
    console.log('PHASE isolation regressions passed');

    // 6. Real npm installs, lifecycle script containment, project build.
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '6.4.3' }, scripts: { postinstall: 'node containment.cjs' } }));
    fs.writeFileSync(path.join(workspace, 'containment.cjs'), `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(path.join(childHome, 'host-home-sentinel'))}))throw Error('host home exposed'); if(!process.env.npm_config_cache.startsWith('/tmp/continuum-cache/'))throw Error('cache');fs.writeFileSync('containment.json',JSON.stringify({home:process.env.HOME,cache:process.env.npm_config_cache}));`);
    await checkCommand({ command: 'npm install --no-audit --no-fund', timeout_ms: 180000 });
    await checkCommand({ command: 'npm install is-number@7.0.0 --no-audit --no-fund', timeout_ms: 180000 });
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/vite/bin/vite.js')));
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/is-number/index.js')));
    assert.ok(fs.existsSync(path.join(workspace, 'package-lock.json')));
    evidence.checks.npm = { passed: true, containment: JSON.parse(fs.readFileSync(path.join(workspace, 'containment.json'))) };
    console.log('PHASE real npm installs passed');
    const build = await checkCommand({ command: 'echo "export default 42" > lib.js && node -e "import(\'./lib.js\').then(m=>{if(m.default!==42)process.exit(1);console.log(\'build-ok\')})"' });
    assert.ok(build.stdout.includes('build-ok'));
    evidence.checks.projectBuild = true;

    // 7. Persistent development server + authenticated preview.
    fs.writeFileSync(path.join(workspace, 'index.html'), '<div id="app"></div><script type="module" src="/main.js"></script>');
    const source = text => `import './style.css'; document.querySelector('#app').textContent='${text}';if(import.meta.hot)import.meta.hot.accept();`;
    fs.writeFileSync(path.join(workspace, 'main.js'), source('before')); fs.writeFileSync(path.join(workspace, 'style.css'), 'body{color:rgb(1,2,3)}');
    const running = await command({ command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort',
      background: true, survive_run_completion: true, background_lifetime_ms: 120000 });
    assert.ok(running.command_id);
    evidence.commandId = running.command_id;
    let reached;
    for (let i = 0; i < 50; i++) { reached = await command({ command: 'curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:5173/' }); if (reached.success) break; await delay(100); }
    assert.equal(reached.success, true, JSON.stringify(reached).slice(0, 500));
    evidence.checks.devServer = true;
    console.log('PHASE dev server passed');
    // Open the workspace chat UI so the background command card is rendered.
    await window.getByRole('button', { name: 'Toggle chat history', exact: true }).click();
    await window.locator('summary').filter({ hasText: /^Projects \(/ }).click();
    await window.getByRole('button', { name: 'All projects', exact: true }).click();
    await window.getByRole('button').filter({ has: window.getByRole('heading', { name: 'Production acceptance', exact: true }) }).click();
    await window.locator('button.project-chat').filter({ hasText: 'Production acceptance' }).click();
    await window.locator('[data-chat-mode="workspace"]').waitFor();
    evidence.checks.workspaceUi = true;
    const controls = window.getByRole('button', { name: 'Toggle chat controls', exact: true });
    if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
    const card = window.locator('section[aria-label="Background commands"]');
    await card.waitFor();
    await card.locator('details').filter({ hasText: running.command_id }).locator('summary').click();
    await card.getByRole('button', { name: 'Create Preview', exact: true }).click();
    await card.getByRole('button', { name: 'Open Preview', exact: true }).waitFor({ timeout: 30000 });
    const preview = await window.evaluate(({ sessionId, commandId }) => window.memoryPalace.getCommandPreview(sessionId, commandId), { sessionId: evidence.setup.sessionId, commandId: running.command_id });
    assert.equal(preview.status, 'ready');
    evidence.preview = preview.url;
    assert.equal((await fetch(preview.url)).status, 403, 'preview requires credentials');
    evidence.checks.authenticatedPreview = true;
    console.log('PHASE authenticated preview passed');

    // 8. Cancellation terminates the owned command; prompts stayed at zero.
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    await card.locator('details').filter({ hasText: running.command_id }).getByText(/user stopped/).waitFor({ timeout: 30000 });
    await assert.rejects(fetch(preview.url));
    assert.equal(await mainCall(() => global.acceptance.req('./src/main/networkExecution').service.active()), 0);
    assert.equal(await mainCall(() => global.acceptance.prompts), 0, 'ordinary networking must not require confirmation dialogs');
    evidence.checks.cancellationAndNoPrompts = true;
    console.log('PHASE cancellation/no-prompt passed');

    // 9. Isolated remains an explicit opt-out that actually revokes networking.
    await window.evaluate(() => window.api.setWorkspaceNetwork({ version: 3, policy: 'isolated' }));
    const reverted = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
    assert.equal(reverted.config.workspaceNetwork.policy, 'isolated');
    const deniedAfterIsolated = await command({ command: 'curl --noproxy "*" -fsS --max-time 6 https://example.com' });
    assert.equal(deniedAfterIsolated.success, false, 'Isolated must revoke internet access');
    evidence.checks.isolatedOptOut = true;
    // Restore the default tier for the record.
    await window.evaluate(() => window.api.setWorkspaceNetwork({ version: 3, policy: 'standard_outbound' }));
    evidence.passed = true;
    console.log('PRODUCTION_ACCEPTANCE_RESULT', JSON.stringify(evidence));
    fs.writeFileSync(path.join(root, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2));
  } finally {
    try { fs.writeFileSync(path.join(root, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2)); } catch {}
    await application?.close();
    console.log('EVIDENCE_PATH', path.join(root, 'acceptance-evidence.json'));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
