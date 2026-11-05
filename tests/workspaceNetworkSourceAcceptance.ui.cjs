'use strict';
// Source-development acceptance (`npm run dev` equivalent) for default
// outbound Workspace Write networking. Launches the real Vite dev server and
// the real Electron main process (NODE_ENV=development, compact native tool
// profile — the same environment `npm run dev` sets) with a DISPOSABLE
// --user-data-dir, then runs the same command battery as the production run.
const { _electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-dev-acceptance-'));
  const profile = path.join(root, 'profile'), childHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(childHome); fs.mkdirSync(profile); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(childHome, 'host-home-sentinel'), 'private fixture home');
  const vite = cp.spawn('npm', ['run', 'dev:vite'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  vite.stdout.on('data', d => { viteLog += d; });
  vite.stderr.on('data', d => { viteLog += d; });
  const evidence = { checks: {} };
  try {
    for (let i = 0; i < 100; i++) { try { const served = await fetch('http://localhost:5173/'); if (served.ok) break; } catch { await delay(200); continue; } await delay(200); }
    assert.ok(viteLog.includes('Local:'), 'Vite dev server must be serving: ' + viteLog.slice(0, 300));
    const env = { ...process.env, NODE_ENV: 'development', CONTINUUM_NATIVE_TOOL_PROFILE: 'compact', HOME: childHome,
      XDG_CONFIG_HOME: path.join(childHome, '.config'), XDG_CACHE_HOME: path.join(childHome, '.cache'),
      XDG_DATA_HOME: path.join(childHome, '.local/share'), XDG_STATE_HOME: path.join(childHome, '.local/state') };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = require('electron');
    const executable = typeof electron === 'string' ? electron : path.join(process.cwd(), 'node_modules/electron/dist/electron');
    let application = await _electron.launch({ executablePath: executable, chromiumSandbox: true,
      args: ['.', '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 60000 });
    application.on('window', win => { win.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300))); win.on('console', m => { if (m.type() === 'error') console.log('[console-error]', String(m.text()).slice(0, 300)); }); });
    const window = await application.firstWindow();
    window.setDefaultTimeout(20000);
    await window.waitForFunction(() => !!window.api?.getWorkspaceNetworkStatus, undefined, { timeout: 45000 })
      .catch(e => { console.log('[window url]', window.url()); throw e; });
    const mainCall = (fn, argument) => application.evaluate((electron, { source, argument }) =>
      new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(eval('(' + source + ')')(electron, argument)).then(resolve, reject); }
        catch (error) { reject(error); }
      })), { source: String(fn), argument });
    evidence.runtime = await mainCall(({ app }) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
      const dependencies = req('./src/main/networkDependencies').resolveBundled();
      return { packaged: app.isPackaged, build: req('./src/main/localDevelopmentNetwork').buildLabel(),
        resources: dependencies.helper.split('/workspace-network/')[0] };
    });
    assert.equal(evidence.runtime.packaged, false);
    assert.match(evidence.runtime.build, /Local development · source/);
    assert.ok(evidence.runtime.resources.endsWith('.continuum-local/resources'));
    const status = await window.evaluate(async () => ({ config: await window.api.getConfig(), status: await window.api.getWorkspaceNetworkStatus() }));
    assert.equal(status.config.workspaceNetwork.policy, 'standard_outbound');
    assert.equal(status.status.available, true, JSON.stringify(status.status));
    assert.equal(status.status.consentRequired, false);
    evidence.checks.defaultOutboundNoConsent = true;
    console.log('PHASE source default outbound passed');
    evidence.setup = await mainCall(({ app }, workspace) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
      const project = req('./src/main/projectManager').createProject({ name: 'Dev acceptance', root_path: workspace, permissionMode: 'workspace_write' });
      const sessionId = 'dev-acceptance-' + Date.now(), runId = 'dev-acceptance-run';
      req('./src/main/sessionManager').getOrCreateSession(sessionId, 'fixture', project.id);
      const context = req('./src/main/lspExecutionContext').createContext(sessionId, 'workspace_write', runId);
      const bg = { sessionId, runId, workspace }, controller = new AbortController();
      req('./src/main/backgroundCommands').openRun({ ...bg, signal: controller.signal });
      global.acceptance = { req, sessionId, runId, context, bg, controller, prompts: 0 };
      return { sessionId, workspace };
    }, workspace);
    const command = args => mainCall(async (_electron, args) => {
      const f = global.acceptance, permissions = f.req('./src/main/toolPermissions');
      const approval = await permissions.guardTool({ name: 'execute_command', args, sessionId: f.sessionId, permissionMode: 'workspace_write',
        project: permissions.sessionProject(f.sessionId), signal: f.controller.signal, requestApproval: () => { f.prompts++; return true; } });
      return f.req('./src/main/tools/agentTools').executeAgentTool({ name: 'execute_command', arguments: JSON.stringify(args),
        sessionId: f.sessionId, permissionMode: 'workspace_write', executionContext: f.context, backgroundContext: f.bg,
        signal: f.controller.signal, approval, permissionGranted: true });
    }, args);
    const checkCommand = async args => { const result = await command(args); assert.equal(result.success, true, JSON.stringify(result).slice(0, 800)); return result; };
    const dns = await checkCommand({ command: 'getent hosts example.com' });
    evidence.checks.dns = dns.stdout.trim().split('\n')[0];
    const publicRequest = await checkCommand({ command: 'curl --noproxy "*" -fsS --max-time 15 -o /dev/null -w "%{http_code}" https://example.com' });
    assert.equal(publicRequest.stdout, '200');
    evidence.checks.publicHttps = '200';
    const privateLan = await command({ command: 'curl --noproxy "*" -fsS --max-time 4 http://10.11.12.13/ ; echo "exit=$?"' });
    assert.ok(/exit=[1-7]/.test(privateLan.stdout), 'private LAN must stay denied in source mode');
    evidence.checks.isolation = { privateLandenied: true };
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '6.4.3' } }));
    await checkCommand({ command: 'npm install --no-audit --no-fund', timeout_ms: 180000 });
    await checkCommand({ command: 'npm install is-number@7.0.0 --no-audit --no-fund', timeout_ms: 180000 });
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/is-number/index.js')));
    evidence.checks.npm = true;
    console.log('PHASE source npm installs passed');
    fs.writeFileSync(path.join(workspace, 'index.html'), '<div id="app"></div><script type="module" src="/main.js"></script>');
    fs.writeFileSync(path.join(workspace, 'main.js'), 'document.querySelector(\'#app\').textContent=\'dev-ok\';');
    const running = await command({ command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175 --strictPort',
      background: true, survive_run_completion: true, background_lifetime_ms: 120000 });
    assert.ok(running.command_id);
    let reached;
    for (let i = 0; i < 50; i++) { reached = await command({ command: 'curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:5175/' }); if (reached.success) break; await delay(100); }
    assert.equal(reached.success, true, JSON.stringify(reached).slice(0, 500));
    evidence.checks.devServer = true;
    assert.equal(await mainCall(() => global.acceptance.prompts), 0, 'no confirmation dialogs for ordinary networking');
    evidence.passed = true;
    console.log('SOURCE_ACCEPTANCE_RESULT', JSON.stringify(evidence));
    fs.writeFileSync(path.join(root, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2));
    await application.close();
  } finally {
    vite.kill('SIGTERM');
    console.log('EVIDENCE_PATH', path.join(root, 'acceptance-evidence.json'));
    process.exit(process.exitCode || 0);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
