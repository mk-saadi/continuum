const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createEngineRuntimeState,
  killProcessTree,
  killProcessTreeSync,
  isProcessAlive,
  readCommandLine,
} = require('../src/main/engineRuntimeState');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForDeath = async (pid) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!isProcessAlive(pid)) return true;
    await sleep(20);
  }
  return !isProcessAlive(pid);
};
const spawnSleep = () => {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
};

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-runtime-state-'));
  const stateFile = path.join(directory, 'engine-runtime.json');
  const warnings = [];
  const state = createEngineRuntimeState({
    stateFile,
    engineBinary: 'llama-server',
    onWarning: (message) => warnings.push(message),
  });

  // A missing file is not an error and yields no engines.
  assert.deepEqual(state.readAll(), []);

  // save/readAll round-trips the whole set.
  state.save([
    { enginePid: 111, port: 8081, modelPath: '/models/a.gguf' },
    { enginePid: 222, port: 8082, modelPath: '/models/b.gguf' },
  ]);
  assert.deepEqual(state.readAll().map((entry) => entry.enginePid), [111, 222]);

  // Clearing one engine keeps the others; clearing the last removes the file.
  state.clear(111);
  assert.deepEqual(state.readAll().map((entry) => entry.enginePid), [222]);
  state.clear(222);
  assert.deepEqual(state.readAll(), []);
  assert.equal(fs.existsSync(stateFile), false, 'last engine clears the file');

  // A stale close from a replaced engine must not erase another engine's entry.
  state.save([{ enginePid: 333, port: 8083, modelPath: '/models/c.gguf' }]);
  state.clear(999);
  assert.deepEqual(state.readAll().map((entry) => entry.enginePid), [333]);
  state.clear(333);

  // A live app instance owns its engines: reap must leave both processes alone.
  const appProcess = spawnSleep();
  const ownedEngine = spawnSleep();
  try {
    state.save([{ enginePid: ownedEngine.pid, port: 1, modelPath: 'owned-model.gguf', engineCommand: 'sleep' }]);
    // Simulate a different live app instance owning the engine.
    const meta = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...meta, appPid: appProcess.pid }));
    assert.equal(await state.reap(), false, 'a live owner is not reaped');
    assert.ok(isProcessAlive(ownedEngine.pid), 'the owned engine keeps running');
  } finally {
    try { process.kill(ownedEngine.pid, 'SIGKILL'); } catch {}
    try { process.kill(appProcess.pid, 'SIGKILL'); } catch {}
  }
  await waitForDeath(ownedEngine.pid);
  await waitForDeath(appProcess.pid);
  state.clear();

  // An orphaned engine whose command line still references the model is reaped
  // and its entry removed.
  const orphanedEngine = spawnSleep();
  const orphanPid = orphanedEngine.pid;
  state.save([{ enginePid: orphanPid, port: 9000, modelPath: null, engineCommand: '/bin/sleep' }]);
  fs.writeFileSync(stateFile, JSON.stringify({ appPid: 999999, engines: state.readAll() }));
  assert.equal(await state.reap(), true, 'an orphaned engine is reaped');
  assert.ok(await waitForDeath(orphanPid), 'the orphaned engine is terminated');
  assert.deepEqual(state.readAll(), []);
  assert.match(warnings.join(' '), /Cleaning up orphaned/);

  // A PID reused by an unrelated process must never be killed.
  const unrelated = spawnSleep();
  try {
    state.save([{ enginePid: unrelated.pid, port: 9001, modelPath: '/models/missing.gguf', engineCommand: 'llama-server' }]);
    fs.writeFileSync(stateFile, JSON.stringify({ appPid: 999999, engines: state.readAll() }));
    assert.equal(await state.reap(), false, 'an unrelated process is not reaped');
    assert.ok(isProcessAlive(unrelated.pid), 'the unrelated process keeps running');
  } finally {
    try { process.kill(unrelated.pid, 'SIGKILL'); } catch {}
  }
  await waitForDeath(unrelated.pid);

  // Command-line inspection drives the safety check.
  const probe = spawnSleep();
  try {
    assert.match(readCommandLine(probe.pid), /sleep/);
    assert.equal(readCommandLine(999999), '');
  } finally {
    try { process.kill(probe.pid, 'SIGKILL'); } catch {}
  }
  await waitForDeath(probe.pid);

  // The async and synchronous tree killers both terminate a detached process.
  const asyncVictim = spawnSleep();
  await killProcessTree(asyncVictim.pid, 'SIGKILL');
  assert.ok(await waitForDeath(asyncVictim.pid), 'killProcessTree terminates a detached process');
  const syncVictim = spawnSleep();
  killProcessTreeSync(syncVictim.pid);
  assert.ok(await waitForDeath(syncVictim.pid), 'killProcessTreeSync terminates a detached process');

  // Clearing a path that does not exist is silent.
  const errors = [];
  const unreadable = createEngineRuntimeState({
    stateFile: path.join(directory, 'missing-dir', 'engine.json'),
    onError: (message) => errors.push(message),
  });
  unreadable.clear(1);
  assert.equal(errors.length, 0, 'clearing a path that does not exist is silent');

  fs.rmSync(directory, { recursive: true, force: true });
  console.log('Engine runtime state: multi-engine persistence, ownership, orphan reaping, PID-reuse safety, and tree killing passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
