const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const mainRequire = createRequire(path.resolve('main.js'));
let port = null, spawnedArgs, spawnCount = 0, child;
const context = {
  require(name) {
    if (name === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, BrowserWindow: {}, protocol: { registerSchemesAsPrivileged() {} }, ipcMain: { on() {}, handle() {} } };
    if (name === './src/main/db.js' || name === './src/main/ipcHandlers.js') return {};
    if (name === './src/main/configManager') return { ...mainRequire(name), getAppSettings: () => ({ apiServerPort: port }) };
    if (name === 'child_process') return { spawn(_command, args) {
      spawnedArgs = args; spawnCount++;
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 42;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    } };
    return mainRequire(name);
  }, process, console, setTimeout, clearTimeout, __dirname: path.resolve('.'),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('main.js', 'utf8') + '\nglobalThis.launch = launchProcess; globalThis.selectPort = getFreePort;', context);
(async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  try {
    const result = await context.launch(null, { modelPath: '/tmp/model.gguf' }, {});
    assert.equal(result.success, false);
    assert.equal(result.error, `Port ${port} is already in use. Please select another port or stop the conflicting service.`);
    assert.equal(spawnCount, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const result = await context.launch(null, { modelPath: '/tmp/model.gguf' }, {});
  assert.equal(result.success, true);
  assert.equal(result.port, port);
  assert.equal(spawnedArgs[spawnedArgs.indexOf('--port') + 1], String(port));
  child.emit('close', 0, null);
  port = null;
  const automatic = await context.launch(null, { modelPath: '/tmp/model.gguf' }, {});
  assert.equal(automatic.success, true);
  assert.ok(automatic.port > 0);
  child.emit('close', 0, null);
  console.log('Occupied port errors, static launch arguments, retry after conflict, and automatic selection passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
