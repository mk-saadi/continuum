'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-b2f-'));
const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
const load = Module._load;
Module._load = function(name, ...rest) { return name === 'electron' ? { safeStorage: require('./helpers/networkSafeStorage.cjs'), app: { isPackaged: false, isReady: () => true, getPath: () => temp } } : load.call(this, name, ...rest); };
const config = require('../src/main/configStore');
const filesystem = require('../src/main/sandboxFilesystem');
const policy = require('../src/main/workspaceNetworkPolicy');
const launchProtocol = require('../src/main/networkLaunchProtocol');
const network = require('../src/main/networkExecution');
const originalService = network.service;
const workerScratch = new Set();
function trackedPythonBackend(resources) {
  const backend = network.pythonBackend(resources);
  return async args => {
    const instance = await backend(args);
    const root = path.dirname(path.dirname(instance.resolver));
    assert.ok(path.basename(root).startsWith('continuum-network-worker-'));
    workerScratch.add(root); return instance;
  };
}
const db = require('../src/main/db'); db.initDatabase(temp);
const project = require('../src/main/projectManager').createProject({ name: 'B2F fixture', root_path: workspace });
const sessions = require('../src/main/sessionManager');
const contexts = require('../src/main/lspExecutionContext');
const background = require('../src/main/backgroundCommands');
const dispatch = require('./helpers/approvedNativeCommand.cjs');
let n = 0;
const fixtures = [];
function fixture() {
  const sessionId = `b2f-${++n}`; sessions.getOrCreateSession(sessionId, 'fixture', project.id);
  const runId = `b2f-run-${n}`;
  const executionContext = contexts.createContext(sessionId, 'workspace_write', runId);
  const backgroundContext = { runId, sessionId, workspace };
  const controller = new AbortController();
  background.openRun({ ...backgroundContext, signal: controller.signal });
  const f = { context: executionContext, backgroundContext, controller,
    command: args => dispatch({ name: 'execute_command', arguments: JSON.stringify(args), sessionId, permissionMode: 'workspace_write', signal: controller.signal, executionContext, backgroundContext }) };
  fixtures.push(f); return f;
}
function plan() { return filesystem.resolveFilesystem({ workspace, protectGitMetadata: true, config: { appDataDirectory: path.join(temp, 'data') }, userData: temp, hostEnv: { PATH: '/usr/bin:/bin' } }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminal(id, scope) {
  for (let i = 0; i < 600; i++) { const r = background.status(id, scope); if (!['starting', 'running'].includes(r.status)) return r; await delay(10); }
  throw new Error('Background network command did not terminate');
}
test.after(async () => {
  for (const f of fixtures) await background.closeRun(f.backgroundContext);
  await background.shutdown(); await network.service.shutdown(); network.service = originalService;
  db.closeDatabase(); Module._load = load; fs.rmSync(temp, { recursive: true, force: true });
  assert.ok([...workerScratch].every(root => !fs.existsSync(root)), 'network scratch directories released');
});


const http = require('node:http');
const { createService: previews } = require('../src/main/developmentPreviews');
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
}
async function authorize(gateway, context, id, url, captured) {
  await gateway.open(context, id);
  const handoff = captured.at(-1), token = new URL(handoff).hash.slice(1);
  const response = await request(url + '.continuum-preview', { method: 'POST',
    headers: { Origin: new URL(url).origin, 'Content-Type': 'text/plain' }, body: token });
  assert.equal(response.status, 204);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], token };
}

test('production preview factory remains gated', async () => {
  const gateway = previews();
  await assert.rejects(gateway.create({}, { background_command_id: 'guessed', guest_port: 5173 }), { code: 'WORKSPACE_NETWORK_NOT_READY' });
  assert.equal(gateway.active(), 0); await gateway.shutdown();
});

test('real B1 dispatcher preview: pipe-only upstream, browser authentication, HTTP, Vite HMR and cleanup', { skip: !process.env.B2F_HELPER || !process.env.B2F_VITE, timeout: 90000 }, async () => {
  const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
  network.service = service;
  fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
  const opened = [];
  const gateway = previews({ readiness: () => ({ available: true }), openExternal: url => { opened.push(url); } });
  const f = fixture();
  try {
    // Real registry downloads through the approved Workspace Write dispatcher.
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '6.4.3' } }));
    const installed = await f.command({ command: 'npm install --no-audit --no-fund', timeout_ms: 120000 });
    assert.equal(installed.success, true, JSON.stringify(installed));
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules/vite/bin/vite.js')));
    assert.ok(fs.existsSync(path.join(workspace, 'package-lock.json')));
    const added = await f.command({ command: 'npm install is-number@7.0.0 --no-audit --no-fund', timeout_ms: 120000 });
    assert.equal(added.success, true, JSON.stringify(added));
    for (const [name, probe, command] of [
      ['pnpm', 'command -v pnpm', 'mkdir pnpm-fixture && cd pnpm-fixture && printf \'{"dependencies":{"is-number":"7.0.0"}}\' >package.json && pnpm install --store-dir /tmp/pnpm-store'],
      ['yarn', 'command -v yarn', 'mkdir yarn-fixture && cd yarn-fixture && printf \'{"dependencies":{"is-number":"7.0.0"}}\' >package.json && yarn install --cache-folder /tmp/yarn-cache'],
      ['pip', 'python3 -m pip --version', 'python3 -m pip install --target ./pip-fixture six==1.17.0'],
      ['git', 'command -v git', 'git init /tmp/git-fetch-fixture && git -C /tmp/git-fetch-fixture fetch --depth 1 https://github.com/octocat/Hello-World.git HEAD'],
    ]) {
      const available = await f.command({ command: probe });
      if (!available.success) { console.error('B2G2 optional unavailable:', name, available.stderr); continue; }
      const result = await f.command({ command, timeout_ms: 120000 });
      console.error('B2G2 package workflow:', name, result.success, result.stderr);
      assert.equal(result.success, true, JSON.stringify(result));
    }
    fs.writeFileSync(path.join(workspace, 'index.html'), '<div id="app">initial</div><script type="module" src="/main.js"></script>');
    fs.writeFileSync(path.join(workspace, 'main.js'), "import './style.css'; document.querySelector('#app').textContent='B2F-before'; if(import.meta.hot)import.meta.hot.accept();");
    fs.writeFileSync(path.join(workspace, 'style.css'), 'body{color:rgb(1,2,3)}');
    const running = await f.command({ command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 43119 --strictPort', background: true, survive_run_completion: true, background_lifetime_ms: 60000 });
    assert.ok(running.command_id, JSON.stringify(running));
    let result;
    for (let i = 0; i < 50; i++) {
      result = await f.command({ command: 'curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:43119' });
      if (result.success) break; await delay(50);
    }
    console.error('B2F phase: guest server reachable', result.success);
    if (result.success) {
      const membership = await f.command({ command: 'cat /proc/self/cgroup' });
      const group = '/sys/fs/cgroup' + membership.stdout.trim().split('::')[1];
      console.error('B2F isolated Vite scope bytes/current/peak:',
        fs.readFileSync(path.join(group, 'memory.current'), 'utf8').trim(),
        fs.readFileSync(path.join(group, 'memory.peak'), 'utf8').trim());
    }
    assert.equal(result.success, true, JSON.stringify(background.status(running.command_id, f.backgroundContext)));
    await assert.rejects(gateway.create(f.context, { background_command_id: running.command_id, guest_port: 0 }), /PORT_INVALID/);
    await assert.rejects(gateway.create(f.context, { background_command_id: 'guessed', guest_port: 43119 }), /authorization denied/);
    await assert.rejects(gateway.create({ ...f.context }, { background_command_id: running.command_id, guest_port: 43119 }), /DENIED/);
    const other = fixture();
    await assert.rejects(gateway.create(other.context, { background_command_id: running.command_id, guest_port: 43119 }), /authorization denied/);
    const preview = await gateway.create(f.context, { background_command_id: running.command_id, guest_port: 43119 });
    console.error('B2F phase: gateway ready');
    assert.equal(preview.status, 'ready'); assert.match(preview.url, /^http:\/\/127\./);
    assert.equal((await request(preview.url)).status, 403);
    assert.equal((await request(preview.url, { headers: { Cookie: 'bad=value' } })).status, 403);
    console.error('B2F phase: authenticating');
    const auth = await authorize(gateway, f.context, running.command_id, preview.url, opened);
    assert.equal((await request(preview.url + '.continuum-preview', { method: 'POST', headers: { Origin: new URL(preview.url).origin, 'Content-Type': 'text/plain' }, body: auth.token })).status, 403);
    assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie, Host: 'evil.test' } })).status, 403);
    assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie, Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie } })).status, 200);
    assert.match((await request(preview.url + 'main.js?query=1', { headers: { Cookie: auth.cookie } })).text, /B2F-before/);
    assert.equal((await request(preview.url + 'style.css', { headers: { Cookie: auth.cookie } })).status, 200);
    assert.equal((await request(preview.url + 'client/route', { headers: { Cookie: auth.cookie, Accept: 'text/html' } })).status, 200);
    assert.ok(!JSON.stringify(background.status(running.command_id, f.backgroundContext)).includes(auth.token));
    assert.ok(!JSON.stringify(gateway.status(f.context, running.command_id)).includes(auth.token));
    // Real Chromium external-browser equivalent, without an Electron app or
    // live profile. The fixture browser receives only the one-time handoff.
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.B2F_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
    try {
      const page = await browser.newPage(); const websocketUrls = [], frames = [];
      page.on('websocket', ws => { websocketUrls.push(ws.url()); ws.on('framereceived', frame => frames.push(String(frame.payload))); });
      await gateway.open(f.context, running.command_id);
      console.error('B2F phase: browser handoff');
      await page.goto(opened.at(-1));
      await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'B2F-before');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'B2F-before');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)');
      for (let i = 0; i < 200 && !frames.some(frame => frame.includes('connected')); i++) await delay(25);
      assert.ok(frames.some(frame => frame.includes('connected')), 'HMR WebSocket connected');
      await delay(300); // Let the reloaded module register its hot accept callback.
      fs.writeFileSync(path.join(workspace, 'main.js'), "import './style.css'; document.querySelector('#app').textContent='B2F-after'; if(import.meta.hot)import.meta.hot.accept();");
      await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'B2F-after');
      assert.ok(websocketUrls.length > 0); assert.ok(websocketUrls.every(url => new URL(url).host === new URL(preview.url).host));
      assert.ok(frames.some(frame => frame.includes('update')));
      await background.closeRun(f.backgroundContext, { normalCompletion: true });
      assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie } })).status, 200);
      const later = contexts.createContext(f.context.sessionId, 'workspace_write', 'later-preview');
      const scope = { ...f.backgroundContext, runId: 'later-preview' };
      background.openRun({ ...scope, signal: new AbortController().signal });
      assert.equal(gateway.status(later, running.command_id).url, preview.url);
      await background.stop(running.command_id, scope);
      await delay(100);
      await assert.rejects(request(preview.url)); assert.equal(gateway.active(), 0); assert.equal(service.active(), 0);
      await assert.rejects(gateway.create(later, { background_command_id: running.command_id, guest_port: 43119 }), /authorization denied/);
      await background.closeRun(scope);
    } finally { await browser.close(); }
  } finally {
    await gateway.shutdown(); await service.shutdown(); network.service = originalService;
    fs.writeFileSync(path.join(temp, 'directories.json'), '{}');
  }
});

test('real guest port ownership and lifecycle: sibling commands cannot inherit a selected port', { skip: !process.env.B2F_HELPER, timeout: 60000 }, async () => {
  const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
  network.service = service;
  fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
  const opened = [], gateway = previews({ readiness: () => ({ available: true }), openExternal: url => opened.push(url) });
  const f = fixture();
  try {
    fs.writeFileSync(path.join(workspace, 'b2f-marker.txt'), 'isolated-preview-marker');
    const command = await f.command({ command: 'python3 -I -m http.server 43120 --bind 0.0.0.0', background: true, survive_run_completion: true, background_lifetime_ms: 30000 });
    let response;
    for (let i = 0; i < 40; i++) {
      response = await f.command({ command: 'curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:43120' });
      if (response.success) break; await delay(30);
    }
    assert.equal(response.success, true);
    const sibling = await f.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 30000 });
    await delay(100);
    await assert.rejects(gateway.create(f.context, { background_command_id: sibling.command_id, guest_port: 43120 }));
    const otherRoot = path.join(temp, 'other-workspace'); fs.mkdirSync(otherRoot, { recursive: true });
    const otherProject = require('../src/main/projectManager').createProject({ name: 'Other B2F', root_path: otherRoot });
    sessions.getOrCreateSession('cross-project-preview', 'fixture', otherProject.id);
    const otherContext = contexts.createContext('cross-project-preview', 'workspace_write', 'cross-project-run');
    await assert.rejects(gateway.create(otherContext, { background_command_id: command.command_id, guest_port: 43120 }));
    const preview = await gateway.create(f.context, { background_command_id: command.command_id, guest_port: 43120 });
    const auth = await authorize(gateway, f.context, command.command_id, preview.url, opened);
    assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie } })).status, 200);
    if (process.env.B2F_BROWSER) {
      const browser = await require('playwright').chromium.launch({ headless: true, executablePath: process.env.B2F_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
      try {
        const page = await browser.newPage(); await gateway.open(f.context, command.command_id);
        try { await page.goto(opened.at(-1)); } catch { throw new Error('Isolated browser handoff failed'); }
        await page.waitForURL(preview.url);
        await page.goto(preview.url + 'b2f-marker.txt');
        assert.equal(await page.locator('body').innerText(), 'isolated-preview-marker');
      } finally { await browser.close(); }
    }
    await background.stop(command.command_id, f.backgroundContext); await delay(100);
    await assert.rejects(request(preview.url)); assert.equal(gateway.active(), 0);
    // The sibling remains a live command; it still cannot claim the dead server.
    await assert.rejects(gateway.create(f.context, { background_command_id: command.command_id, guest_port: 43120 }));
    const replacement = await f.command({ command: 'python3 -I -m http.server 43120 --bind 127.0.0.1', background: true, survive_run_completion: true, background_lifetime_ms: 30000 });
    await delay(200);
    await assert.rejects(gateway.create(f.context, { background_command_id: sibling.command_id, guest_port: 43120 }));
    const fresh = await gateway.create(f.context, { background_command_id: replacement.command_id, guest_port: 43120 });
    assert.notEqual(fresh.url, preview.url);
    await background.stop(replacement.command_id, f.backgroundContext);
    await background.stop(sibling.command_id, f.backgroundContext);
    assert.equal(service.active(), 0);
  } finally { await gateway.shutdown(); await service.shutdown(); network.service = originalService; fs.writeFileSync(path.join(temp, 'directories.json'), '{}'); }
});

test('real B1 preview cleanup on lifetime, mode/rules, session termination/deletion and owner shutdown', { skip: !process.env.B2F_HELPER, timeout: 60000 }, async () => {
  const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
  network.service = service;
  const opened = [], gateway = previews({ readiness: () => ({ available: true }), openExternal: url => opened.push(url) });
  fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
  try {
    for (const reason of ['lifetime', 'mode', 'rules', 'termination', 'deletion', 'owner', 'shutdown']) {
      const f = fixture();
      const command = await f.command({ command: 'python3 -I -m http.server 43121 --bind 127.0.0.1', background: true, survive_run_completion: true, background_lifetime_ms: reason === 'lifetime' ? 2000 : 15000 });
      let preview;
      for (let i = 0; i < 40; i++) {
        try { preview = await gateway.create(f.context, { background_command_id: command.command_id, guest_port: 43121 }); break; }
        catch { await delay(50); }
      }
      assert.ok(preview, reason);
      const auth = await authorize(gateway, f.context, command.command_id, preview.url, opened);
      await background.closeRun(f.backgroundContext, { normalCompletion: true });
      assert.equal((await request(preview.url, { headers: { Cookie: auth.cookie } })).status, 200);
      const laterContext = contexts.createContext(f.context.sessionId, 'workspace_write', `later-${reason}`);
      assert.equal(gateway.status(laterContext, command.command_id).status, 'ready');
      if (reason === 'lifetime') await delay(2100);
      if (reason === 'mode') await contexts.setMode(f.context.sessionId, 'read_only');
      if (reason === 'rules') contexts.invalidateRules([f.context.sessionId]);
      if (reason === 'termination') await background.terminateSession(f.context.sessionId);
      if (reason === 'deletion') await background.forgetSession(f.context.sessionId);
      if (reason === 'owner') await service.invalidateSession(f.context.sessionId);
      if (reason === 'shutdown') await service.shutdown();
      for (let i = 0; i < 100 && gateway.active(); i++) await delay(20);
      assert.equal(gateway.active(), 0, reason); await assert.rejects(request(preview.url));
      assert.equal(service.active(), 0, reason);
    }
  } finally { await gateway.shutdown(); await service.shutdown(); network.service = originalService; fs.writeFileSync(path.join(temp, 'directories.json'), '{}'); }
});

test('development profile: standard Node, kernel limits and aggregate OOM fail closed', { skip: !process.env.B2F_HELPER ? 'B2F_HELPER verified helper required; host namespace execution required' : false, timeout: 30000 }, async () => {
  const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
  network.service = service;
  fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
  const f = fixture();
  try {
    const keeper = await f.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 25000 });
    assert.ok(keeper.command_id);
    const normal = await f.command({ command: `node -e 'console.log("STANDARD_NODE_OK")'` });
    assert.equal(normal.success, true, JSON.stringify(normal));
    const limits = await f.command({ command: `python3 -c 'import resource,json; print(json.dumps({n:resource.getrlimit(getattr(resource,n)) for n in ["RLIMIT_AS","RLIMIT_DATA","RLIMIT_RSS","RLIMIT_CPU","RLIMIT_NOFILE"]}))'` });
    const values = JSON.parse(limits.stdout.trim());
    assert.deepEqual(values.RLIMIT_AS, [64 * 1024 ** 4, 64 * 1024 ** 4]);
    assert.deepEqual(values.RLIMIT_CPU, [60, 60]); assert.deepEqual(values.RLIMIT_NOFILE, [256, 256]);
    const membership = await f.command({ command: 'cat /proc/self/cgroup' });
    const group = '/sys/fs/cgroup' + membership.stdout.trim().split('::')[1];
    assert.equal(fs.readFileSync(path.join(group, 'memory.max'), 'utf8').trim(), '1073741824');
    assert.equal(fs.readFileSync(path.join(group, 'memory.swap.max'), 'utf8').trim(), '0');
    assert.equal(fs.readFileSync(path.join(group, 'pids.max'), 'utf8').trim(), '128');
    const helperPids = fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim().split('\n');
    const fdFailure = await f.command({ command: `python3 -c 'files=[open("/dev/null") for _ in range(300)]'` });
    assert.equal(fdFailure.success, false); assert.match(fdFailure.stderr, /Too many open files/);
    console.error('B2F resource profile: kernel memory/tasks limits verified; normal scope bytes', fs.readFileSync(path.join(group, 'memory.current'), 'utf8').trim());
    // One bounded allocation exceeds only our disposable 1 GiB scope. Kernel
    // group OOM kills the worker and all its helpers, never unrelated scopes.
    const abuse = await f.command({ command: `python3 -c 'a=bytearray(1536*1024*1024); print("UNEXPECTED")'` });
    assert.equal(abuse.success, false);
    assert.ok(!abuse.stdout?.includes('UNEXPECTED'));
    for (let i = 0; i < 100 && service.active(); i++) await delay(20);
    assert.equal(service.active(), 0);
    const alive = pid => { try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
    for (let i = 0; i < 100 && helperPids.some(alive); i++) await delay(20);
    assert.ok(helperPids.every(pid => !alive(pid)), 'OOM left no live scope helpers');
  } finally { await service.shutdown(); network.service = originalService; fs.writeFileSync(path.join(temp, 'directories.json'), '{}'); }
});

test('preview fails closed after actual worker, transport and owner SIGKILL without live helpers', { skip: !process.env.B2F_HELPER ? 'B2F_HELPER verified helper required; host namespace execution required' : false, timeout: 30000 }, async () => {
  for (const target of ['worker', 'transport', 'owner']) {
    const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
      backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
    network.service = service;
    const gateway = previews({ readiness: () => ({ available: true }) });
    fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
    const f = fixture();
    try {
      const command = await f.command({ command: 'python3 -I -m http.server 43122 --bind 127.0.0.1', background: true, survive_run_completion: true, background_lifetime_ms: 20000 });
      let preview;
      for (let i = 0; i < 40; i++) {
        try { preview = await gateway.create(f.context, { background_command_id: command.command_id, guest_port: 43122 }); break; } catch { await delay(50); }
      }
      assert.ok(preview);
      const membership = await f.command({ command: 'cat /proc/self/cgroup' });
      const group = '/sys/fs/cgroup' + membership.stdout.trim().split('::')[1];
      const pids = fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim().split('\n');
      const pid = pids.find(pid => {
        try {
          const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          return target === 'worker' ? argv.includes('networkExecutionWorker.py') : target === 'transport' ? argv.includes('--disable-host-loopback') : argv.includes('sys.stdin.buffer.read(1)');
        } catch { return false; }
      });
      assert.ok(pid, target); process.kill(Number(pid), 'SIGKILL');
      await terminal(command.command_id, f.backgroundContext);
      for (let i = 0; i < 100 && gateway.active(); i++) await delay(20);
      assert.equal(gateway.active(), 0); assert.equal(service.active(), 0);
      await assert.rejects(request(preview.url));
      const alive = pid => { try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
      for (let i = 0; i < 100 && pids.some(alive); i++) await delay(20);
      assert.ok(pids.every(pid => !alive(pid)), `${target}: no live helpers`);
    } finally { await gateway.shutdown(); await service.shutdown(); network.service = originalService; fs.writeFileSync(path.join(temp, 'directories.json'), '{}'); }
  }
});

if (process.env.B2F_PARENT_CHILD === '1') {
  test('abrupt parent fixture', async () => {
    network.service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
      backend: trackedPythonBackend({ python: '/usr/bin/python3', helper: process.env.B2F_HELPER }) });
    fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
    const gateway = previews({ readiness: () => ({ available: true }) }), f = fixture();
    const command = await f.command({ command: 'python3 -I -m http.server 43123 --bind 127.0.0.1', background: true, survive_run_completion: true, background_lifetime_ms: 25000 });
    let preview;
    for (let i = 0; i < 40; i++) {
      try { preview = await gateway.create(f.context, { background_command_id: command.command_id, guest_port: 43123 }); break; } catch { await delay(50); }
    }
    assert.ok(preview);
    const membership = await f.command({ command: 'cat /proc/self/cgroup' });
    const group = '/sys/fs/cgroup' + membership.stdout.trim().split('::')[1];
    process.send({ url: preview.url, temp, scratch: [...workerScratch], pids: fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim().split('\n') });
    await new Promise(() => {});
  });
} else {
  test('abrupt application parent SIGKILL closes the preview and inherited worker pipes', { skip: !process.env.B2F_HELPER ? 'B2F_HELPER verified helper required; host namespace execution required' : false, timeout: 20000 }, async () => {
    const child = cp.fork(__filename, [], { execArgv: ['--test-name-pattern=^abrupt parent fixture$'],
      env: { ...process.env, B2F_PARENT_CHILD: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let info;
    try {
      info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('disposable parent fixture startup timed out')), 10000);
        child.once('message', message => { clearTimeout(timer); resolve(message); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('disposable fixture exited before readiness')); });
      });
      child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
      await assert.rejects(request(info.url));
      const alive = pid => { try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
      for (let i = 0; i < 200 && info.pids.some(alive); i++) await delay(20);
      assert.ok(info.pids.every(pid => !alive(pid)), 'parent death left no live scope helpers');
      assert.ok(info.scratch.every(root => !fs.existsSync(root)), 'parent death released resolver scratch');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (info?.temp) fs.rmSync(info.temp, { recursive: true, force: true });
    }
  });
}
