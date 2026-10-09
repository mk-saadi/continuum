'use strict';
// Run with Electron, without --no-sandbox:
// env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron tests/preloadSandbox.integration.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-preload-sandbox-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('Sandbox test timed out'); app.exit(1); }, 60000);
const shape = {
  windowAPI: ['minimize', 'maximize', 'close'],
  terminalAPI: ['spawn', 'kill', 'status', 'onOutput', 'onStatus'],
  modelsAPI: ['scanLocalModels', 'getActiveModels'],
  engineAPI: ['getConfig'],
  electronAPI: ['getEngineStatus'],
  memoryPalace: ['getOrCreateSession', 'saveMessage', 'loadSession', 'onCompressionComplete'],
  mcpAPI: ['getStatus', 'getTools', 'setToolEnabled', 'onChanged'],
  chatAPI: ['run', 'cancel', 'cancelSession', 'onEvent', 'onStreamStatus', 'onStreamChunk'],
  api: ['getConfig', 'createProject', 'importProjectFiles', 'processUploads', 'launchEngine', 'saveSkill'],
};
const events = [
  ['terminalAPI', 'onOutput', 'terminal:output'], ['terminalAPI', 'onStatus', 'terminal:status'],
  ['memoryPalace', 'onCompressionComplete', 'session:compression-complete'],
  ['mcpAPI', 'onChanged', 'mcp:changed'],
  ['chatAPI', 'onStreamStatus', 'engine:stream-status'], ['chatAPI', 'onStreamChunk', 'engine:stream-chunk'],
  ['chatAPI', 'onToolApproval', 'engine:request-tool-approval'], ['chatAPI', 'onAskUser', 'engine:ask-user'],
  ['chatAPI', 'onToolLimitReached', 'engine:tool-limit-reached'], ['chatAPI', 'onLoopPaused', 'loop:paused'],
  ['chatAPI', 'onStepUpdate', 'stream:step-update'], ['chatAPI', 'onEvent', 'engine:chat-event'],
];
app.whenReady().then(async () => {
  let window, dispose;
  const database = require('../src/main/db');
  try {
    assert.ok(!process.argv.includes('--no-sandbox'));
    database.initDatabase();
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(root, 'src/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    const preloadErrors = [];
    window.webContents.on('preload-error', (_event, file, error) => preloadErrors.push({ file, message: error.message }));
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
      isTrustedSender: event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
      getEngineConfig: () => null,
    });
    // These controls live in main.js; record their send/invoke wire contracts here.
    const controls = [];
    for (const channel of ['window:minimize', 'window:maximize', 'window:close']) ipcMain.on(channel, () => controls.push(channel));
    for (const [channel, value] of Object.entries({
      'terminal:status': { running: false }, 'terminal:getConfig': null,
      'engine:get-status': { isLoaded: false, modelPath: null, modelName: null },
      'get-active-models': { data: [] }, 'models:scanLocal': { success: true, models: [] },
    })) ipcMain.handle(channel, (_event, argument) => { if (channel === 'models:scanLocal') assert.equal(argument, directory); return value; });
    const html = path.join(directory, 'index.html');
    fs.writeFileSync(html, '<input id="file" type="file"><img id="media">');
    window.webContents.debugger.attach('1.3');
    console.log('Loading fixture');
    await window.loadFile(html);
    console.log('Fixture loaded');
    assert.deepEqual(preloadErrors, []);
    assert.equal(process.versions.electron, '44.7.0');
    assert.equal(process.versions.node, '24.21.0');
    const pid = window.webContents.getOSProcessId();
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0\s]+/);
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(status, /^Seccomp:\s+2$/m);
    assert.ok(args.includes('--enable-sandbox'));
    assert.ok(!args.some(arg => ['--no-sandbox', '--disable-seccomp-filter-sandbox', '--disable-setuid-sandbox'].includes(arg)));
    const sandbox = { pid, noNewPrivs: 1, seccomp: 2, args, versions: process.versions };
    const evaluate = expression => window.webContents.executeJavaScript(expression);
    const available = await evaluate(`Object.fromEntries(Object.entries(${JSON.stringify(shape)}).map(([namespace,methods])=>[namespace,methods.every(method=>typeof window[namespace]?.[method]==='function')]))`);
    assert.deepEqual(available, Object.fromEntries(Object.keys(shape).map(key => [key, true])));
    assert.deepEqual(await evaluate('[typeof require,typeof process]'), ['undefined', 'undefined']);
    await evaluate('window.windowAPI.minimize();window.windowAPI.maximize();window.windowAPI.close();true');
    await evaluate('window.terminalAPI.status()'); // IPC barrier after the sends
    assert.deepEqual(controls, ['window:minimize', 'window:maximize', 'window:close']);
    assert.deepEqual(await evaluate('window.electronAPI.getEngineStatus()'), { isLoaded: false, modelPath: null, modelName: null });
    assert.equal(await evaluate('window.engineAPI.getConfig()'), null);
    assert.deepEqual(await evaluate('window.modelsAPI.getActiveModels()'), { data: [] });
    assert.deepEqual(await evaluate(`window.modelsAPI.scanLocalModels(${JSON.stringify(directory)})`), { success: true, models: [] });
    console.log('Checking MCP');
    assert.ok(await evaluate('window.mcpAPI.getTools()'));
    assert.ok(await evaluate('window.mcpAPI.getStatus()'));
    await evaluate('window.chatAPI.cancel("absent-request")');
    await evaluate('window.chatAPI.cancelSession("absent-session")');
    await evaluate(`window.received=[];window.cleanups=${JSON.stringify(events)}.map(([ns,method,channel])=>window[ns][method]((...args)=>window.received.push({channel,args})));true`);
    for (const [, , channel] of events) window.webContents.send(channel, { requestId: 'test', status: 'cancelled', channel });
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    const received = await evaluate('window.received');
    assert.deepEqual(received, events.map(([, , channel]) => ({ channel, args: [{ requestId: 'test', status: 'cancelled', channel }] })));
    await evaluate('window.cleanups.forEach(cleanup=>cleanup());true');
    for (const [, , channel] of events) window.webContents.send(channel, { unexpected: true });
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.deepEqual(await evaluate('window.received'), received);
    const project = await evaluate('window.api.createProject({name:"Sandbox test"})');
    const file = path.join(directory, 'sample.txt');
    fs.writeFileSync(file, 'sandbox project import');
    // Chromium creates a genuine disk-backed File, rather than a JS File with an empty path.
    const document = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#file' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
    const imported = await evaluate(`window.api.importProjectFiles(${JSON.stringify(project.id)},Array.from(document.querySelector('#file').files))`);
    assert.equal(imported[0].file_path, file);
    assert.equal(imported[0].content, 'sandbox project import');
    const uploads = await evaluate("window.api.processUploads(Array.from(document.querySelector('#file').files))");
    assert.equal(fs.readFileSync(uploads[0].file_path, 'utf8'), 'sandbox project import');
    const { JPEG_BASE64 } = await import('./fixtures/visionImages.mjs');
    const optimized = await evaluate(`window.api.processUploads([{name:'image.jpg',dataUrl:${JSON.stringify('data:image/jpeg;base64,' + JPEG_BASE64)}}])`);
    assert.equal(optimized[0].mime_type, 'image/jpeg');
    assert.ok(fs.readFileSync(optimized[0].file_path).equals(Buffer.from(JPEG_BASE64, 'base64')));
    await evaluate(`document.querySelector('#media').src=${JSON.stringify('data:image/jpeg;base64,' + JPEG_BASE64)};new Promise((resolve,reject)=>{const image=document.querySelector('#media');image.onload=()=>resolve(true);image.onerror=reject})`);
    await evaluate('window.memoryPalace.getOrCreateSession("sandbox-session","test-model")');
    const saved = await evaluate('window.memoryPalace.saveMessage("sandbox-session","user","sandbox persisted")');
    assert.equal(saved.content, 'sandbox persisted');
    database.closeDatabase();
    database.initDatabase();
    const session = await evaluate('window.memoryPalace.loadSession("sandbox-session")');
    assert.ok(session.messages.some(message => message.content === 'sandbox persisted'));
    console.log('PASS production sandboxed preload; nine API shapes; 12 event/cleanup contracts; controls; real project/file/upload IPC; JPEG rendering; SQLite reopen', JSON.stringify(sandbox));
  } finally {
    dispose?.(); database.closeDatabase(); window?.destroy();
    clearTimeout(timeout); fs.rmSync(directory, { recursive: true, force: true });
  }
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
