const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const mainRequire = createRequire(require('node:path').resolve('main.js'));
const handlers = new Map();
let child, fail = false, spawnOptions, spawnArgs;
const context = {
  require(name) {
    if (name === 'electron') return { app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {} }, BrowserWindow: {}, ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) } };
    if (name === './src/main/db.js') return {};
    if (name === './src/main/ipcHandlers.js') return {};
    if (name === 'child_process') return { spawn(command, args, options) {
      assert.equal(command, 'llama-server'); spawnArgs = args; spawnOptions = options;
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 42;
      const created = child;
      queueMicrotask(() => created.emit(fail ? 'error' : 'spawn', fail ? new Error('ENOENT') : undefined));
      return child;
    } };
    if (name === 'net') return { createServer() { return { once() {}, listen(_port, cb) { cb(); }, address: () => ({ port: 12345 }), close: cb => cb() }; } };
    return mainRequire(name);
  }, process, console, setTimeout, clearTimeout, __dirname: require('node:path').resolve('.'),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('main.js', 'utf8') + '\nglobalThis.launchForTest = launchProcess;', context);
const events = [];
context.testWindow = { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } };
vm.runInContext('mainWindow = testWindow;', context);
(async () => {
  fail = true;
  const failure = await context.launchForTest(null, { modelPath: '/tmp/model.gguf' }, {});
  assert.equal(failure.success, false);
  assert.match(failure.error, /ENOENT/);
  assert.equal((await handlers.get('terminal:status')()).running, false);
  assert.equal((await handlers.get('terminal:getConfig')()).activeModelConfig, null);
  const failedChild = child;
  fail = false;
  const success = await context.launchForTest(null, { modelPath: '/tmp/model with spaces.gguf' }, { contextLength: 32768 });
  assert.equal(success.success, true);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnArgs[1], '/tmp/model with spaces.gguf');
  assert.equal(spawnArgs.includes('--api-key'), false);
  assert.equal((await handlers.get('terminal:getConfig')()).apiKey, '');
  assert.equal(spawnArgs[spawnArgs.indexOf('-c') + 1], '32768');
  assert.equal(success.activeModelConfig.contextLength, 32768);
  assert.equal((await handlers.get('terminal:getConfig')()).activeModelConfig.contextLength, 32768);
  assert.equal((await handlers.get('terminal:status')()).activeModelConfig.contextLength, 32768);
  assert.equal(events.filter(([name]) => name === 'terminal:status').at(-1)[1].activeModelConfig.contextLength, 32768);
  failedChild.emit('close', 1, null);
  assert.equal((await handlers.get('terminal:status')()).running, true);
  assert.equal((await context.launchForTest(null, { modelPath: 'another.gguf' }, {})).success, false);
  child.emit('close', 0, null);
  assert.equal((await handlers.get('terminal:status')()).running, false);
  assert.equal((await handlers.get('terminal:getConfig')()).activeModelConfig, null);
  assert.equal(events.filter(([name]) => name === 'terminal:status').at(-1)[1].activeModelConfig, null);
  console.log('Launch failures, direct spawning, unauthenticated local access, duplicate launch protection, and stale process exits passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
