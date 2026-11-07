const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const mainRequire = createRequire(require('node:path').resolve('main.js'));
const handlers = new Map();
const appEvents = new Map(), lifecycleEvents = [], signals = [];
const mockProcess = Object.assign(Object.create(process), { kill: (pid, signal) => signals.push({ pid, signal }) });
let children = [], fail = false, spawnOptions, spawnArgs, spawnCommand;
const context = {
  require(name) {
    if (name === 'electron') return { app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on: (name, fn) => appEvents.set(name, fn), quit() {} }, BrowserWindow: {}, protocol: { registerSchemesAsPrivileged() {} }, ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) } };
    if (name === './src/main/engineLifecycle') return { createEngineLifecycle: options => mainRequire(name).createEngineLifecycle({ ...options, emit: record => lifecycleEvents.push(record) }) };
    if (name === './src/main/db.js') return {};
    if (name === './src/main/ipcHandlers.js') return {};
    if (name === './src/main/configManager') return { ...mainRequire(name), getAppSettings: () => ({ apiServerPort: 8080 }), saveLoadConfig() {}, forgetLoadConfig() {} };
    if (name === './src/main/engineManager') return { ...mainRequire(name), createStartupHandler: ({ onStatus }) => ({ onOutput: () => onStatus('warming'), cancel() {} }) };
    if (name === 'child_process') return { spawn(command, args, options) {
      spawnCommand = command; spawnArgs = args; spawnOptions = options ?? args;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 42 + children.length;
      children.push(child);
      const created = child;
      queueMicrotask(() => created.emit(fail ? 'error' : 'spawn', fail ? new Error('ENOENT') : undefined));
      return child;
    } };
    if (name === 'net') return { createServer() { return { once() {}, listen(_port, cb) { cb(); }, address: () => ({ port: 12345 }), close: cb => cb() }; } };
    return mainRequire(name);
  }, process: mockProcess, console, setTimeout, clearTimeout, __dirname: require('node:path').resolve('.'),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('main.js', 'utf8') + '\nglobalThis.launchForTest = launchProcess; globalThis.switchForTest = launchModel; globalThis.enginesForTest = engines;', context);
const events = [];
context.testWindow = { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } };
vm.runInContext('mainWindow = testWindow;', context);
(async () => {
  const getStatus = handlers.get('engine:get-status');
  const status = () => handlers.get('terminal:status')();

  // A failed spawn reports the failure and leaves no engine behind.
  fail = true;
  const failure = await context.launchForTest(null, { modelPath: '/tmp/model.gguf' }, {});
  assert.equal(failure.success, false);
  assert.match(failure.error, /ENOENT/);
  assert.equal((await status()).running, false);
  assert.equal((await handlers.get('terminal:getConfig')()).activeModelConfig, null);
  assert.equal(context.enginesForTest.size, 0);
  fail = false;

  // First engine loads with the expected argv and reported config.
  const first = await context.launchForTest(null, { modelPath: '/tmp/model with spaces.gguf' }, { contextLength: 32768 });
  assert.equal(first.success, true);
  assert.equal(context.enginesForTest.size, 1);
  const firstChild = children.at(-1);
  assert.equal(getStatus().isLoaded, false);
  assert.equal(getStatus().modelPath, '/tmp/model with spaces.gguf');
  firstChild.stderr.emit('data', 'model loaded; server is listening');
  assert.equal(getStatus().isLoaded, true);
  assert.equal(getStatus().modelName, 'model with spaces.gguf');
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnArgs[1], '/tmp/model with spaces.gguf');
  assert.equal(spawnArgs.includes('--api-key'), false);
  assert.equal(spawnArgs.includes('--api-key-file'), false);
  assert.equal(spawnOptions.env.LLAMA_API_KEY, undefined);
  assert.equal(spawnOptions.env.LLAMA_ARG_API_KEY_FILE, undefined);
  assert.equal((await handlers.get('terminal:getConfig')()).apiKey, undefined);
  assert.equal(spawnArgs[spawnArgs.indexOf('-c') + 1], '32768');
  assert.equal(first.activeModelConfig.contextLength, 32768);
  assert.equal((await handlers.get('terminal:getConfig')()).activeModelConfig.contextLength, 32768);
  assert.equal((await status()).activeModelConfig.contextLength, 32768);
  assert.equal(events.filter(([name]) => name === 'terminal:status').at(-1)[1].activeModelConfig.contextLength, 32768);

  // A second, different model loads beside the first without displacing it.
  const second = await context.launchForTest(null, { modelPath: '/tmp/second.gguf' }, {});
  assert.equal(second.success, true);
  assert.equal(context.enginesForTest.size, 2);
  const secondChild = children.at(-1);
  assert.notEqual(secondChild, firstChild);
  const pooled = await status();
  assert.equal(pooled.engines.length, 2);
  assert.equal(pooled.engines.map(entry => entry.modelPath).sort().join('|'), '/tmp/model with spaces.gguf|/tmp/second.gguf');
  assert.equal(pooled.running, true);

  // A model load must wait for an active turn on a pooled model, and must not
  // create an overlapping engine while it waits.
  const firstEntry = context.enginesForTest.get('/tmp/model with spaces.gguf');
  const firstLease = firstEntry.lifecycle.acquireTurnLease();
  let thirdLoadSettled = false;
  const thirdLoad = context.launchForTest(null, { modelPath: '/tmp/third.gguf' }, {}).then(result => {
    thirdLoadSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(thirdLoadSettled, false, 'the load must wait for the active turn');
  assert.equal(context.enginesForTest.size, 2, 'no overlapping engine may be created while waiting');
  firstLease.release();
  const third = await thirdLoad;
  assert.equal(third.success, true);
  assert.equal(context.enginesForTest.size, 3, 'the load proceeds once the turn releases the model');
  const thirdChild = children.at(-1);
  assert.equal((await handlers.get('engine:unload')({}, { modelId: '/tmp/third.gguf' })).success, true);
  thirdChild.emit('exit', 0, 'SIGTERM');
  thirdChild.emit('close', 0, 'SIGTERM');
  assert.equal(context.enginesForTest.size, 2);

  // The same model cannot be loaded twice.
  const duplicate = await context.launchForTest(null, { modelPath: '/tmp/second.gguf' }, {});
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error, /already loaded/);

  // Unloading one model leaves the other running.
  assert.equal((await handlers.get('engine:unload')({}, { modelId: '/tmp/model with spaces.gguf' })).success, true);
  firstChild.emit('exit', 0, 'SIGTERM');
  firstChild.emit('close', 0, 'SIGTERM');
  assert.equal(context.enginesForTest.size, 1);
  assert.equal((await status()).engines[0].modelPath, '/tmp/second.gguf');

  // Unloading the last model stops the pool.
  assert.equal((await handlers.get('engine:unload')({}, { modelId: '/tmp/second.gguf' })).success, true);
  secondChild.emit('exit', 0, 'SIGTERM');
  secondChild.emit('close', 0, 'SIGTERM');
  assert.equal(context.enginesForTest.size, 0);
  assert.equal((await status()).running, false);
  assert.equal(getStatus().modelPath, null);

  // Custom shell launch stays disabled.
  const custom = await context.launchForTest('llama-server -m "/tmp/model with spaces.gguf" --api-key=secret --api-key-file "/tmp/key file.txt" --port 9090');
  assert.equal(custom.success, false);
  assert.match(custom.error, /shell engine launch is disabled/);
  assert.equal((await handlers.get('terminal:spawn')({}, 'echo forbidden')).success, false);

  // launchModel loads a scanned model through its own path.
  vm.runInContext("scannedModels.set('replacement', { modelPath: __dirname + '/main.js' });", context);
  const replacing = await context.switchForTest('replacement', { rememberSettings: false });
  assert.equal(replacing.success, true);
  assert.equal(context.enginesForTest.size, 1);
  const replacementChild = children.at(-1);
  assert.ok(lifecycleEvents.some(event => event.event === 'server-starting'));

  // App shutdown stops every engine in the pool.
  context.testSignals = signals;
  vm.runInContext('killProcessTree = (pid, signal) => { testSignals.push({ pid, signal }); };', context);
  const beforeShutdown = signals.length;
  appEvents.get('window-all-closed')();
  assert.equal(signals.length, beforeShutdown + 1, 'shutdown signals the one running engine');
  assert.equal(lifecycleEvents.at(-1).reason, 'app-shutdown');
  assert.equal(lifecycleEvents.at(-1).userAction, false);
  replacementChild.emit('exit', 0, 'SIGTERM');
  replacementChild.emit('close', 0, 'SIGTERM');
  assert.equal(context.enginesForTest.size, 0);
  console.log('Launch failures, direct spawning, multi-engine pooling, duplicate protection, per-model unload, and shutdown passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
