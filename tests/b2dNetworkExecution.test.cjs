'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-b2d-'));
const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
const load = Module._load;
Module._load = function(name, ...rest) { return name === 'electron' ? { safeStorage: require('./helpers/networkSafeStorage.cjs'), app: { isPackaged: false, isReady: () => true, getPath: () => temp } } : load.call(this, name, ...rest); };
const config = require('../src/main/configStore');
const filesystem = require('../src/main/sandboxFilesystem');
const policy = require('../src/main/workspaceNetworkPolicy');
const launchProtocol = require('../src/main/networkLaunchProtocol');
const network = require('../src/main/networkExecution');
const originalService = network.service;
const db = require('../src/main/db'); db.initDatabase(temp);
const project = require('../src/main/projectManager').createProject({ name: 'B2D fixture', root_path: workspace });
const sessions = require('../src/main/sessionManager');
const contexts = require('../src/main/lspExecutionContext');
const background = require('../src/main/backgroundCommands');
const dispatch = require('./helpers/approvedNativeCommand.cjs');
let n = 0;
const fixtures = [];
function fixture() {
  const sessionId = `b2d-${++n}`; sessions.getOrCreateSession(sessionId, 'fixture', project.id);
  const runId = `b2d-run-${n}`;
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
});

test('policy migration and activation stay fail closed, with no dependency/workspace PATH execution', async () => {
  for (const value of [undefined, {}, 'development', { version: 1, policy: 'development' }, { version: 2, policy: 'development' }]) assert.equal(policy.normalize(value).policy, 'standard_outbound');
  // A previous explicit v2 trusted decision migrates; unknown v2 stays default.
  assert.equal(policy.normalize({ version: 2, policy: 'trusted_development' }).policy, 'trusted_development');
  assert.equal(config.getConfig().workspaceNetwork.policy, 'standard_outbound');
  assert.throws(() => config.saveConfig({ workspaceNetwork: { version: 1, policy: 'development' } }), { code: 'WORKSPACE_NETWORK_TRUST_REQUIRED' });
  assert.equal(policy.readiness().available, false);
  assert.throws(() => require('../src/main/networkDependencies').resolveBundled(), { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' });
  await assert.rejects(originalService.execute({}), { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' });
  assert.equal(originalService.active(), 0);
});

test('network verifier rejects forged, replayed, mutated and late-socket plans', async () => {
  const resolver = path.join(temp, 'resolv.conf'); fs.writeFileSync(resolver, 'nameserver 10.0.2.3\noptions timeout:1 attempts:1\n');
  const f = fixture();
  const scope = { context: f.context, workspace, cwd: workspace, command: 'printf verified', resolver, validate() {} };
  assert.throws(() => launchProtocol.issue({ ...scope, context: { sessionId: f.context.sessionId, permissionMode: 'workspace_write' } }), { code: 'NETWORK_AUTHORIZATION_DENIED' });
  assert.throws(() => filesystem.networkShellInvocation(plan(), { ...scope, permit: {} }), /authority/);
  const permit = launchProtocol.issue(scope);
  const invocation = filesystem.networkShellInvocation(plan(), { ...scope, permit });
  assert.ok(Object.isFrozen(invocation.argv)); assert.equal(invocation.file, '/usr/bin/bwrap');
  assert.equal(invocation.argv.at(-1), scope.command);
  assert.throws(() => filesystem.networkShellInvocation(plan(), { ...scope, permit }), /authority/);
  assert.throws(() => filesystem.networkShellInvocation(plan(), { ...scope, command: 'changed', permit: launchProtocol.issue(scope) }), /authority/);
  const mutated = plan(); mutated.mounts.push('--bind', '/', '/');
  assert.throws(() => filesystem.networkShellInvocation(mutated, { ...scope, permit: launchProtocol.issue(scope) }), /modified/);
  assert.throws(() => filesystem.networkShellInvocation({ ...plan() }, { ...scope, permit: launchProtocol.issue(scope) }), /Invalid/);
  const socket = require('node:net').createServer(); const stale = plan();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(path.join(workspace, 'late.sock'), resolve); });
  try { assert.throws(() => filesystem.networkShellInvocation(stale, { ...scope, permit: launchProtocol.issue(scope) }), /socket/); }
  finally { await new Promise(resolve => socket.close(resolve)); }
});

test('trusted context rejects forged authority and preserves persistent revisions across ordinary runs', () => {
  const f = fixture();
  assert.throws(() => network.trustedIdentity({ sessionId: f.context.sessionId, permissionMode: 'workspace_write' }, workspace), { code: 'NETWORK_AUTHORIZATION_DENIED' });
  const first = network.trustedIdentity(f.context, workspace);
  const next = contexts.createContext(f.context.sessionId, 'workspace_write', 'later-run');
  assert.equal(network.trustedIdentity(next, workspace).revision, first.revision);
  assert.throws(() => network.trustedIdentity(next, temp), { code: 'NETWORK_WORKSPACE_DENIED' });
});

test('readiness and backend failures cannot fall back to host execution; invalidation closes pending leases', async () => {
  const f = fixture();
  const failure = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: async () => { throw Object.assign(new Error('setup failed'), { code: 'NETWORK_POLICY_SETUP_FAILED' }); } });
  await assert.rejects(failure.execute({ context: f.context, workspace, cwd: workspace, command: 'touch fallback-must-not-exist', filesystem: plan(), timeoutMs: 1000, validateAuthorization() {} }), { code: 'NETWORK_POLICY_SETUP_FAILED' });
  assert.equal(fs.existsSync(path.join(workspace, 'fallback-must-not-exist')), false); assert.equal(failure.active(), 0);
  let invalidated = false, closed = false;
  const resolver = path.join(temp, 'resolv.conf');
  const service = network.createService({ readiness: () => ({ available: true }),
    authorize: (context, root) => { if (invalidated) throw new Error('simulated host/authority epoch changed'); return network.trustedIdentity(context, root); },
    backend: async () => ({ resolver, alive: () => true, close: async () => { closed = true; },
      execute: (_launch, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('invalidated')), { once: true })) }) });
  const pending = service.execute({ context: f.context, workspace, cwd: workspace, command: 'true', filesystem: plan(), timeoutMs: 1000, validateAuthorization() {} });
  await delay(10); invalidated = true;
  await assert.rejects(pending, /invalidated/);
  assert.equal(closed, true); assert.equal(service.active(), 0);
  await service.shutdown();
});

test('real production dispatcher and B1 use the verified rootless transport with explicit fixture dependencies', { skip: !process.env.B2D_HELPER }, async () => {
  const service = network.createService({ authorize: network.trustedIdentity, readiness: () => ({ available: true }),
    backend: network.pythonBackend({ python: '/usr/bin/python3', helper: process.env.B2D_HELPER }) });
  network.service = service;
  // The fixture supplies its own backend/readiness; routing must see the same
  // fixture truth instead of the real (electron-only) resource verification.
  const executionCapabilities = require('../src/main/executionCapabilities');
  const realNetworkState = executionCapabilities.networkState;
  executionCapabilities.networkState = () => ({ operational: true, selected: 'trusted_development' });
  // Explicit disposable test configuration; saveConfig correctly refuses this
  // activation in the real app. No live user settings/database are touched.
  fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
  const f = fixture();
  try {
    const publicRequest = await f.command({ command: 'curl --noproxy "*" -fsS --max-time 5 -o /dev/null -w "%{http_code}" https://example.com' });
    assert.equal(publicRequest.success, true, JSON.stringify(publicRequest)); assert.equal(publicRequest.stdout, '200');
    assert.equal(service.active(), 0);
    const net = require('node:net');
    const serverFixture = net.createServer(socket => { socket.resume(); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK'); });
    const address = cp.execFileSync('/usr/bin/python3', ['-c', 'import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect(("1.1.1.1",443));print(s.getsockname()[0]);s.close()'], { encoding: 'utf8' }).trim();
    await new Promise(resolve => serverFixture.listen(0, address, resolve));
    try {
      const port = serverFixture.address().port;
      const blocked = await f.command({ command: `curl --noproxy "*" -fsS --max-time 2 http://${address}:${port}` });
      assert.equal(blocked.success, true, JSON.stringify(blocked)); assert.equal(blocked.stdout, 'OK');
      assert.equal((await f.command({ command: 'python3 -I -c \'import socket;print(bool(socket.getaddrinfo("example.com",443)))\'' })).stdout.trim(), 'True');
      assert.equal((await f.command({ command: 'curl --noproxy "*" -fsS --max-time 2 "http://[fd42::1]:12345"' })).success, false);
      assert.equal((await f.command({ command: '/usr/sbin/nft flush ruleset' })).success, false);
    } finally { await new Promise(resolve => serverFixture.close(resolve)); }
    const server = await f.command({ command: "python3 -I -c 'import http.server;http.server.HTTPServer((\"127.0.0.1\",43119),http.server.SimpleHTTPRequestHandler).serve_forever()'", background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    assert.ok(server.command_id, JSON.stringify(server));
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    let response;
    for (let i = 0; i < 50; i++) {
      response = await f.command({ command: 'curl --noproxy "*" -fsS --max-time 1 -o /dev/null -w "%{http_code}" http://127.0.0.1:43119' });
      if (response.success) break;
      await delay(30);
    }
    assert.equal(response.stdout, '200', JSON.stringify(response));
    // Scratch is fresh even while networking is shared.
    await f.command({ command: 'echo scratch >/tmp/b2d-private-scratch' });
    assert.equal((await f.command({ command: 'test ! -e /tmp/b2d-private-scratch' })).success, true);
    await background.closeRun(f.backgroundContext, { normalCompletion: true });
    const later = contexts.createContext(f.context.sessionId, 'workspace_write', 'later-network-run');
    const scope = { ...f.backgroundContext, runId: 'later-network-run' };
    background.openRun({ ...scope, signal: new AbortController().signal });
    assert.equal(network.trustedIdentity(later, workspace).revision, network.trustedIdentity(f.context, workspace).revision);
    assert.equal(service.active(), 1);
    const stopped = await background.stop(server.command_id, scope);
    assert.equal(stopped.status, 'cancelled'); assert.equal(service.active(), 0);
    await background.closeRun(scope);
    // Revocation travels through the real session policy hook.
    const g = fixture();
    const running = await g.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    await contexts.setMode(g.context.sessionId, 'read_only');
    await terminal(running.command_id, g.backgroundContext);
    assert.equal(service.active(), 0);
    const h = fixture();
    const expiring = await h.command({ command: 'sleep 20', background: true, background_lifetime_ms: 1000 });
    const expired = await terminal(expiring.command_id, h.backgroundContext);
    assert.equal(expired.status, 'timed_out'); assert.equal(service.active(), 0);
    const k = fixture();
    const terminating = await k.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    await background.terminateSession(k.context.sessionId);
    await terminal(terminating.command_id, k.backgroundContext);
    assert.equal(service.active(), 0);
    const rules = fixture();
    const rulesCommand = await rules.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    contexts.invalidateRules([rules.context.sessionId]);
    await terminal(rulesCommand.command_id, rules.backgroundContext); assert.equal(service.active(), 0);
    const deleting = fixture();
    await deleting.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    await background.forgetSession(deleting.context.sessionId);
    assert.equal(service.active(), 0); assert.deepEqual(background.list(deleting.context.sessionId, workspace), []);
    const policyChange = fixture();
    const policyCommand = await policyChange.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    await config.setWorkspaceNetwork({ version: 3, policy: 'isolated' });
    await terminal(policyCommand.command_id, policyChange.backgroundContext); assert.equal(service.active(), 0);
    fs.writeFileSync(path.join(temp, 'directories.json'), JSON.stringify({ workspaceNetwork: { version: 2, policy: 'trusted_development' }, workspaceNetworkReceipt: require('./helpers/networkSafeStorage.cjs').encryptString(JSON.stringify({ version: 2, policy: 'trusted_development' })).toString('base64'), appDataDirectory: path.join(temp, 'data') }));
    const shutting = fixture();
    const last = await shutting.command({ command: 'sleep 20', background: true, survive_run_completion: true, background_lifetime_ms: 15000 });
    for (let i = 0; i < 300 && service.active() === 0; i++) await delay(10);
    await service.shutdown(); await terminal(last.command_id, shutting.backgroundContext);
    assert.equal(service.active(), 0);
  } finally {
    executionCapabilities.networkState = realNetworkState;
    await service.shutdown(); network.service = originalService;
    fs.writeFileSync(path.join(temp, 'directories.json'), '{}');
  }
});
