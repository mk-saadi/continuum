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
    await window.reload();
    await window.getByRole('button', { name: 'Toggle chat history', exact: true }).click();
    await window.locator('summary').filter({ hasText: /^Projects \(/ }).click();
    await window.getByRole('button', { name: 'All projects', exact: true }).click();
    await window.getByRole('button').filter({ has: window.getByRole('heading', { name: 'B2G5 workflow', exact: true }) }).click();
    await window.locator('button.project-chat').filter({ hasText: 'B2G5 workflow' }).click();
    await window.locator('[data-chat-mode="workspace"]').waitFor();
    evidence.checks.workspaceUi = true;
    const publicRequest = await checkCommand({ command: 'curl --noproxy "*" -fsS --max-time 10 -o /dev/null -w "%{http_code}" https://example.com' });
    assert.equal(publicRequest.stdout, '200'); evidence.checks.packagedDnsTls = true; console.log('PHASE DNS/TLS passed');
    const nft = await command({ command: '/usr/sbin/nft flush ruleset' }); assert.equal(nft.success, false);
    const ipv6 = await command({ command: 'curl --noproxy "*" -fsS --max-time 2 "http://[fd42::1]:12345"' }); assert.equal(ipv6.success, false);
    const fds = await checkCommand({ command: "python3 -I -c 'import os; print([os.readlink(\"/proc/self/fd/\"+f) for f in os.listdir(\"/proc/self/fd\") if os.path.exists(\"/proc/self/fd/\"+f) and os.readlink(\"/proc/self/fd/\"+f).startswith((\"net:[\",\"user:[\"))])'" });
    assert.equal(fds.stdout.trim(), '[]');
    evidence.checks.packagedSecurity = { nftMutationDenied: true, externalIpv6RequestDenied: true, inheritedNamespaceHandlesAbsent: true };
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '6.4.3' },
      scripts: { postinstall: 'node containment.cjs' } }));
    fs.writeFileSync(path.join(id.childHome, 'host-home-sentinel'), 'private fixture home');
    fs.writeFileSync(path.join(workspace, 'containment.cjs'), `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(path.join(id.childHome, 'host-home-sentinel'))}))throw Error('host home exposed'); if(!process.env.npm_config_cache.startsWith('/tmp/continuum-cache/'))throw Error('cache');fs.writeFileSync('containment.json',JSON.stringify({home:process.env.HOME,cache:process.env.npm_config_cache}));`);
    await checkCommand({ command: 'npm install --no-audit --no-fund', timeout_ms: 120000 });
    await checkCommand({ command: 'npm install is-number@7.0.0 --no-audit --no-fund', timeout_ms: 120000 });
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/vite/bin/vite.js')));
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/is-number/index.js')));
    assert.ok(fs.existsSync(path.join(workspace, 'package-lock.json')));
    console.log('PHASE real npm and lifecycle containment passed');
    evidence.checks.npm = { passed: true, containment: JSON.parse(fs.readFileSync(path.join(workspace, 'containment.json'))) };
    fs.writeFileSync(path.join(workspace, 'index.html'), '<div id="app"></div><script type="module" src="/main.js"></script>');
    const source = text => `import './style.css'; document.querySelector('#app').textContent='${text}';if(import.meta.hot)import.meta.hot.accept();`;
    fs.writeFileSync(path.join(workspace, 'main.js'), source('G5-before')); fs.writeFileSync(path.join(workspace, 'style.css'), 'body{color:rgb(1,2,3)}');
    const running = await command({ command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort',
      background: true, survive_run_completion: true, background_lifetime_ms: 120000 });
    console.log('PHASE persistent command returned', running.command_id);
    evidence.commandId = running.command_id; assert.ok(running.command_id);
    let reached;
    for (let i = 0; i < 40; i++) { reached = await command({ command: 'curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:5173/' }); if (reached.success) break; await delay(100); }
    assert.equal(reached.success, true, JSON.stringify(reached));
    console.log('PHASE guest Vite reached');
    // Host-side negative exposure probe only: bind without listen, then close.
    // This never executes the project on the host or contacts another service.
    cp.execFileSync('/usr/bin/python3', ['-I', '-c', 'import socket;s=socket.socket();s.bind(("127.0.0.1",5173));s.close()']);
    evidence.checks.rawHostVitePortAbsent = true;
    const membership = await checkCommand({ command: 'cat /proc/self/cgroup' });
    const group = '/sys/fs/cgroup' + membership.stdout.trim().split('::')[1];
    evidence.cgroup = { path: group };
    for (const file of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max', 'memory.oom.group']) evidence.cgroup[file] = fs.readFileSync(path.join(group, file), 'utf8').trim();
    assert.equal(evidence.cgroup['memory.max'], '1073741824'); assert.equal(evidence.cgroup['pids.max'], '128');
    assert.equal(evidence.cgroup['cpu.max'], '200000 100000');
    assert.equal(evidence.cgroup['memory.swap.max'], '0'); assert.equal(evidence.cgroup['memory.oom.group'], '1');
    const complete = await mainCall(async (_electron, commandId) => {
      const f = global.g5, bg = f.req('./src/main/backgroundCommands'); await bg.closeRun(f.bg, { normalCompletion: true });
      f.context = f.req('./src/main/lspExecutionContext').createContext(f.sessionId, 'workspace_write', 'g5-later');
      f.bg = { ...f.bg, runId: 'g5-later' }; bg.openRun({ ...f.bg, signal: f.controller.signal });
      return bg.status(commandId, f.bg);
    }, running.command_id);
    assert.ok(['starting', 'running'].includes(complete.status));
    // No authority is revived by a new run; the existing persistent command owns it.
    evidence.checks.survivedCompletion = (await command({ command: 'curl --noproxy "*" -fsS --max-time 2 http://127.0.0.1:5173/' })).success;
    assert.equal(evidence.checks.survivedCompletion, true);
    console.log('PHASE completion survival passed');
    const controls = window.getByRole('button', { name: 'Toggle chat controls', exact: true });
    if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
    const card = window.locator('section[aria-label="Background commands"]');
    await card.waitFor();
    await card.locator('details').filter({ hasText: running.command_id }).locator('summary').click();
    await card.getByRole('button', { name: 'Create Preview', exact: true }).click();
    await card.getByRole('button', { name: 'Open Preview', exact: true }).waitFor();
    const preview = await window.evaluate(({ sessionId, commandId }) => window.memoryPalace.getCommandPreview(sessionId, commandId),
      { sessionId: evidence.setup.sessionId, commandId: running.command_id });
    evidence.checks.backgroundCardCreate = true;
    assert.equal(preview.status, 'ready'); evidence.preview = preview.url;
    assert.equal((await fetch(preview.url)).status, 403); evidence.checks.credentialFreeDenied = true;
    console.log('PACKAGED_PHASE', JSON.stringify({ ...evidence, uiText: (await window.locator('body').innerText()).slice(0, 4000) }));
    // Browser acceptance below uses real Chrome and the packaged gateway; the
    // handoff is obtained only by the native Open action in a disposable browser.
    browser = await chromium.launchPersistentContext(path.join(root, 'browser'), { executablePath: '/opt/google/chrome/chrome', headless: false,
      chromiumSandbox: true, args: ['--no-proxy-server'], env });
    const browserPages = browser.pages(); const page = browserPages[0];
    const wsUrls = [], frames = [];
    const attach = page => page.on('websocket', ws => { wsUrls.push(ws.url()); ws.on('framereceived', frame => frames.push(String(frame.payload))); });
    browser.pages().forEach(attach); browser.on('page', attach);
    await card.getByRole('button', { name: 'Open Preview', exact: true }).click();
    evidence.checks.backgroundCardOpen = true;
    let previewPage;
    for (let i = 0; i < 100; i++) { previewPage = browser.pages().find(page => page.url().startsWith(preview.url)); if (previewPage) break; await delay(100); }
    assert.ok(previewPage, 'native browser handoff must reach only the disposable Chrome profile');
    await previewPage.waitForFunction(() => document.querySelector('#app')?.textContent === 'G5-before');
    assert.equal(await previewPage.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)');
    await previewPage.goto(preview.url + 'client/route'); await previewPage.reload();
    await previewPage.waitForFunction(() => document.querySelector('#app')?.textContent === 'G5-before');
    for (let i = 0; i < 100 && !frames.some(frame => frame.includes('connected')); i++) await delay(50);
    assert.ok(frames.some(frame => frame.includes('connected')));
    await delay(300); fs.writeFileSync(path.join(workspace, 'main.js'), source('G5-after'));
    await previewPage.waitForFunction(() => document.querySelector('#app')?.textContent === 'G5-after');
    assert.ok(wsUrls.length && wsUrls.every(url => new URL(url).host === new URL(preview.url).host));
    assert.equal((await fetch(preview.url)).status, 403);
    evidence.checks.browserHandoff = { nativeOpen: true, javascript: true, css: true, routingReload: true, websocketHmr: true, disposableChrome: true };
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    await card.locator('details').filter({ hasText: running.command_id }).getByText(/user stopped/).waitFor();
    await assert.rejects(fetch(preview.url));
    await assert.rejects(previewPage.goto(preview.url));
    assert.equal(await mainCall(() => global.g5.req('./src/main/networkExecution').service.active()), 0);
    evidence.checks.stop = true;
    await window.evaluate(() => window.api.setWorkspaceNetwork({ version: 2, policy: 'isolated' }));
    assert.equal((await window.evaluate(() => window.api.getConfig())).workspaceNetwork.policy, 'isolated'); evidence.checks.isolatedRevert = true;
    fs.writeFileSync(path.join(root, 'workflow-evidence.json'), JSON.stringify(evidence, null, 2));
    evidence.passed = true;
    console.log('PACKAGED_RESULT', JSON.stringify(evidence));
  } finally { fs.writeFileSync(path.join(root, 'workflow-evidence.json'), JSON.stringify(evidence, null, 2)); await browser?.close(); await application?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
