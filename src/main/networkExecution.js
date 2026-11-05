'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const { randomUUID } = require('node:crypto');
const policy = require('./workspaceNetworkPolicy');
const error = (code, detail = code) => Object.assign(new Error(detail), { code });

// Bridge construction is explicit and trusted; no executable/path options are
// read from model arguments or saved settings. Default release stays gated.
function pythonBackend(resources) {
  return async (identity, networkPolicy) => {
    const { sessionId, workspace } = identity;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-network-worker-'));
    const cleanupScratch = () => fs.rmSync(scratch, { recursive: true, force: true });
    const worker = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet',
      '-p', 'MemoryMax=1G', '-p', 'MemorySwapMax=0',
      '-p', 'TasksMax=128', '-p', 'CPUQuota=200%',
      resources.python, '-I', resources.worker || path.join(__dirname, 'networkExecutionWorker.py')], {
      // __dirname is inside app.asar in packaged Electron; the OS cannot use
      // that virtual directory as a child cwd. All worker inputs are absolute.
      cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map(), bridges = new Map();
    let buffer = '', readyResolve, readyReject, closed = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const send = data => { if (closed) throw error('NETWORK_OWNER_CLOSED'); worker.stdin.write(JSON.stringify(data) + '\n'); };
    const fail = code => {
      closed = true;
      cleanupScratch();
      const failure = error(code);
      readyReject(failure);
      for (const operation of pending.values()) operation.reject(failure);
      pending.clear();
      for (const bridge of bridges.values()) bridge.destroy(failure);
      bridges.clear();
    };
    worker.on('error', e => fail(e.code || 'NETWORK_BACKEND_UNAVAILABLE'));
    worker.on('exit', () => fail('NETWORK_HELPER_EXITED'));
    worker.stdin.on('error', () => fail('NETWORK_CONTROL_LOST'));
    worker.stderr.on('data', () => {}); // Never log ambient/helper credentials.
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === 'ready') { readyResolve(event); continue; }
          if (event.event === 'fatal') { fail(event.code); continue; }
          if (event.event.startsWith('bridge_')) {
            const bridge = bridges.get(event.id);
            if (!bridge) continue;
            if (event.event === 'bridge_ready') bridge.ready();
            else if (event.event === 'bridge_ack') bridge.ack();
            else if (event.event === 'bridge_data') bridge.receive(event.data);
            else bridge.destroy();
            continue;
          }
          const operation = pending.get(event.id);
          if (!operation) continue;
          if (event.event === 'data' || event.event === 'running') operation.onEvent(event);
          else { pending.delete(event.id); event.event === 'failed' ? operation.reject(error(event.code)) : operation.resolve(event); }
        } catch { fail('NETWORK_PROTOCOL_INVALID'); worker.kill('SIGTERM'); }
      }
      if (buffer.length > 65536) { fail('NETWORK_PROTOCOL_LIMIT'); worker.kill('SIGTERM'); }
    });
    send({ op: 'start', session: sessionId, workspace, helper: resources.helper, scratch,
      network_policy: networkPolicy === 'trusted_development' ? 'trusted_development' : 'standard_outbound' });
    let timer;
    const metadata = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => { worker.kill('SIGTERM'); reject(error('NETWORK_STARTUP_TIMEOUT')); }, 10000); })]).finally(() => clearTimeout(timer));
    return {
      resolver: metadata.resolver,
      alive: () => !closed,
      connect(command, port) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
          let ready = false, writeAck = null, readAck = false;
          const timer = setTimeout(() => stream.destroy(error('PREVIEW_CONNECT_TIMEOUT')), 5000);
          const stream = new Duplex({ highWaterMark: 16384,
            read() { if (readAck) { readAck = false; send({ op: 'bridge_ack', id }); } },
            write(chunk, encoding, callback) {
              let offset = 0;
              const next = () => {
                if (offset >= chunk.length) { writeAck = null; callback(); return; }
                const part = chunk.subarray(offset, offset + 16384); offset += part.length;
                writeAck = next;
                try { send({ op: 'bridge_data', id, data: part.toString('base64') }); }
                catch (e) { callback(e); }
              };
              next();
            },
            destroy(failure, callback) {
              clearTimeout(timer); bridges.delete(id);
              try { send({ op: 'bridge_close', id }); } catch {}
              if (!ready) reject(failure || error('PREVIEW_ENDPOINT_UNVERIFIED'));
              const ack = writeAck; writeAck = null;
              if (ack) { /* stream destruction cancels the pending write */ }
              callback(failure);
            },
          });
          stream.on('error', () => {});
          stream.ready = () => { clearTimeout(timer); ready = true; resolve(stream); };
          stream.ack = () => writeAck?.();
          stream.receive = data => {
            if (typeof data !== 'string' || data.length > 21848) { stream.destroy(error('NETWORK_PROTOCOL_LIMIT')); return; }
            if (stream.push(Buffer.from(data, 'base64'))) send({ op: 'bridge_ack', id });
            else readAck = true;
          };
          bridges.set(id, stream);
          try { send({ op: 'bridge_open', id, command, port, session: sessionId, workspace }); }
          catch (e) { stream.destroy(e); }
        });
      },
      execute(launch, { signal, timeoutMs, onEvent }) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
          const abort = () => { try { send({ op: 'cancel', id }); } catch {} };
          pending.set(id, { resolve, reject, onEvent });
          if (signal?.aborted) { pending.delete(id); reject(error('NETWORK_COMMAND_ABORTED')); return; }
          signal?.addEventListener('abort', abort, { once: true });
          const record = pending.get(id);
          record.resolve = value => { signal?.removeEventListener('abort', abort); resolve(value); };
          record.reject = value => { signal?.removeEventListener('abort', abort); reject(value); };
          try { send({ op: 'execute', id, session: sessionId, workspace, timeoutMs, launch }); }
          catch (e) { pending.delete(id); record.reject(e); }
        });
      },
      async close() {
        if (worker.exitCode != null || worker.signalCode != null) return;
        try { send({ op: 'shutdown' }); } catch {}
        await new Promise(resolve => {
          const force = setTimeout(() => { worker.kill('SIGKILL'); }, 1500);
          worker.once('exit', () => { clearTimeout(force); resolve(); });
          if (worker.exitCode != null || worker.signalCode != null) { clearTimeout(force); resolve(); }
        });
      },
    };
  };
}

function createService({ authorize, backend, readiness = policy.readiness, validatePolicy = () => {} }) {
  const owners = new Map();
  let closing = false;
  async function invalidateSession(sessionId) {
    const entries = [...owners.values()].filter(e => e.sessionId === sessionId);
    for (const entry of entries) { entry.revoked = true; owners.delete(entry.key); }
    await Promise.allSettled(entries.map(async e => { await (await e.promise).close(); }));
  }
  async function execute({ context, workspace, cwd, command, filesystem, signal, timeoutMs, timeoutReason = 'timed_out', validateAuthorization, onState }) {
    if (closing) throw error('NETWORK_SHUTTING_DOWN');
    const available = readiness();
    if (!available.available) throw error(available.code || 'WORKSPACE_NETWORK_NOT_READY', available.blockers?.join(' ') || available.code);
    const networkPolicy = policy.normalize(require('./configStore').getConfig().workspaceNetwork).policy;
    if (networkPolicy === 'isolated') throw error('NETWORK_POLICY_REVOKED');
    const identity = authorize(context, workspace);
    const key = JSON.stringify([identity.sessionId, identity.workspace, identity.revision]);
    let entry = owners.get(key);
    if (!entry) {
      if (owners.size >= 2) throw error('NETWORK_OWNER_LIMIT');
      entry = { key, ...identity, refs: 0, revoked: false, networkPolicy };
      owners.set(key, entry);
      entry.promise = Promise.resolve().then(() => backend(identity, networkPolicy));
    }
    // An owner runs the ruleset it was created with. A selected-tier change
    // (elevation granted or revoked, Isolated chosen) must never leave a live
    // owner filtering traffic under stale authority.
    if (entry.networkPolicy !== networkPolicy) {
      entry.revoked = true; owners.delete(key);
      const stale = entry; entry = { key, ...identity, refs: 0, revoked: false, networkPolicy };
      owners.set(key, entry);
      entry.promise = Promise.resolve().then(async () => { await stale.promise.then(o => o.close(), () => {}); return backend(identity, networkPolicy); });
    }
    if (entry.refs >= 4) throw error('NETWORK_COMMAND_LIMIT');
    entry.refs++;
    let interval, operationAlive = true;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const owner = await entry.promise;
      const validate = () => {
        validatePolicy(entry.networkPolicy);
        validateAuthorization();
        const current = authorize(context, workspace);
        if (entry.revoked || !owner.alive() || current.revision !== identity.revision || current.workspace !== identity.workspace)
          throw error('NETWORK_AUTHORIZATION_REVOKED');
      };
      validate();
      const permit = require('./networkLaunchProtocol').issue({ context, workspace: identity.workspace, cwd, command, resolver: owner.resolver, validate });
      const launch = require('./sandboxFilesystem').networkShellInvocation(filesystem, { workspace: identity.workspace, cwd, command, permit });
      interval = setInterval(() => { try { validate(); } catch { controller.abort(); void invalidateSession(identity.sessionId); } }, 50);
      const out = require('./foregroundCommand').capture(), err = require('./foregroundCommand').capture();
      const readOutput = () => ({ stdout: out.text(), stderr: err.text(), output_truncated: out.truncated || err.truncated });
      onState?.({ readOutput });
      const started = Date.now();
      const result = await owner.execute(launch, { signal: controller.signal, timeoutMs,
        onEvent: event => { if (event.event === 'running') onState?.({ status: 'running', previewAuthority: Object.freeze({
          validate() { if (!operationAlive || controller.signal.aborted) throw error('PREVIEW_COMMAND_ENDED'); validate(); },
          async connect(port) {
            this.validate();
            if (!Number.isInteger(port) || port < 1 || port > 65535 || !owner.connect) throw error('PREVIEW_PORT_INVALID');
            const stream = await owner.connect(event.id, port);
            try { this.validate(); } catch (e) { stream.destroy(); throw e; }
            return stream;
          },
        }) });
          else (event.stream === 'stderr' ? err : out).add(event.text); } });
      return { ...result, ...readOutput(), status: controller.signal.aborted ? 'cancelled' : result.status === 'timed_out' ? timeoutReason : result.status,
        duration_ms: Date.now() - started, timeout_ms: timeoutMs, requested_timeout_ms: timeoutMs };
    } finally {
      operationAlive = false;
      clearInterval(interval);
      signal?.removeEventListener('abort', abort);
      if (--entry.refs === 0) {
        if (owners.get(key) === entry) owners.delete(key);
        await entry.promise.then(o => o.close(), () => {});
      }
    }
  }
  const invalidateAll = () => Promise.all([...new Set([...owners.values()].map(e => e.sessionId))].map(invalidateSession));
  return { execute, invalidateSession, invalidateAll, async shutdown() { closing = true; await invalidateAll(); }, active: () => owners.size };
}
function trustedIdentity(context, workspace) {
  const contexts = require('./lspExecutionContext');
  if (!contexts.isTrusted(context) || context.childSessionId || context.permissionMode !== 'workspace_write') throw error('NETWORK_AUTHORIZATION_DENIED');
  const project = require('./toolPermissions').sessionProject(context.sessionId);
  const root = fs.realpathSync(workspace);
  if (!project?.root_path || fs.realpathSync(project.root_path) !== root) throw error('NETWORK_WORKSPACE_DENIED');
  const revision = contexts.persistentRevision(context.sessionId);
  if (revision == null) throw error('NETWORK_AUTHORIZATION_DENIED');
  return { sessionId: context.sessionId, workspace: root, revision };
}
const service = createService({ authorize: trustedIdentity,
  backend: (identity, networkPolicy) => pythonBackend(require('./networkDependencies').resolveBundled())(identity, networkPolicy),
  validatePolicy: ownerPolicy => { if (policy.normalize(require('./configStore').getConfig().workspaceNetwork).policy !== ownerPolicy) throw error('NETWORK_POLICY_REVOKED'); } });
module.exports = { service, createService, pythonBackend, trustedIdentity };
