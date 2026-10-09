// Regression tests for the ERR_INVALID_STATE ("Controller is already closed")
// crash in nodeHttpFetch's Web Stream adaptation of Node's IncomingMessage.
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/nodeHttpFetchCancel.test.cjs
//
// Electron 30.5.1 embeds Node 20.16.0, whose Readable.toWeb() adapter is
// missing the cancellation guard from nodejs/node#54206, so a cancelled
// response body followed by the IncomingMessage 'close' event threw an
// uncaught exception. The child-process test below is authoritative: it runs
// the scenarios under the embedded Electron runtime and must exit cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { nodeHttpFetch } = require('../src/main/nodeHttpFetch');
const { getSingleWebPageContent } = require('../src/main/tools/webSearch');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  server.closeAllConnections();
  server.close();
}

// Route the real tool through the real transport: a public-looking hostname so
// publicWebUrl() accepts it, with the request pinned to the local test server
// the same way webSearch.publicDispatcher() pins DNS.
function pinnedFetch(port) {
  return (url, options) => nodeHttpFetch(url, {
    ...options,
    dispatcher: { nodeLookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4) },
  });
}

// In-process safety net. The stream adapter raises the exception asynchronously,
// so a listener alone is not sufficient evidence — the child-process test below
// asserts on a real crash — but catching it here still fails the specific test
// that provoked it.
function captureUncaught(t) {
  const errors = [];
  const onError = error => errors.push(error);
  process.on('uncaughtException', onError);
  t.after(() => process.removeListener('uncaughtException', onError));
  return errors;
}

test('webpage tool reads a JSON response without a process-level exception', async t => {
  const uncaught = captureUncaught(t);
  const payload = JSON.stringify({ latitude: 46.7, temperature_2m: 21.4 });
  const server = await startServer((req, res) => {
    res.on('error', () => {});
    if (req.url === '/file.pdf') {
      // JSON content types are now supported, so the unsupported-content-type
      // cancel path (the original crash site) is exercised with a binary type.
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  t.after(() => closeServer(server));
  const port = server.address().port;
  const content = await getSingleWebPageContent({ url: `http://api.example.test:${port}/v1/forecast`, fetchImpl: pinnedFetch(port) });
  assert.match(content, /"temperature_2m": 21\.4/);
  await sleep(500); // let any cancelled IncomingMessage's 'close' event fire
  assert.deepEqual(uncaught, []);

  await assert.rejects(
    getSingleWebPageContent({ url: `http://api.example.test:${port}/file.pdf`, fetchImpl: pinnedFetch(port) }),
    /did not return HTML, plain text or JSON/);
  await sleep(500);
  assert.deepEqual(uncaught, []);
});

test('explicit body cancellation followed by stream close does not throw', async t => {
  const uncaught = captureUncaught(t);
  const payload = JSON.stringify({ ok: true, data: 'small' });
  const server = await startServer((req, res) => {
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}/json`;

  // Cancel a fully received body (default reason).
  const first = await nodeHttpFetch(url);
  assert.equal(first.status, 200);
  await first.body.cancel();
  await sleep(500);
  assert.deepEqual(uncaught, []);

  // Cancel with an explicit error reason.
  const second = await nodeHttpFetch(url);
  await second.body.cancel(new Error('body discarded: unsupported content type'));
  await sleep(500);
  assert.deepEqual(uncaught, []);
});

test('cancelling a redirect or error response does not throw', async t => {
  const uncaught = captureUncaught(t);
  const server = await startServer((req, res) => {
    res.on('error', () => {});
    if (req.url === '/redirect') {
      res.writeHead(301, { location: '/final', 'content-length': 11 });
      res.end('redirecting!');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain', 'content-length': 4 });
      res.end('boom');
    }
  });
  t.after(() => closeServer(server));
  const port = server.address().port;

  const redirect = await nodeHttpFetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  await redirect.body.cancel();
  const failed = await nodeHttpFetch(`http://127.0.0.1:${port}/final`);
  assert.equal(failed.status, 500);
  await failed.body.cancel();
  await sleep(500);
  assert.deepEqual(uncaught, []);

  // The same two cancel sites exercised through the tool (webSearch.js
  // lines 125 and 130): 301 followed, then HTTP 500 rejected.
  await assert.rejects(
    getSingleWebPageContent({ url: `http://api.example.test:${port}/redirect`, fetchImpl: pinnedFetch(port) }),
    /Web page request failed \(HTTP 500\)/);
  await sleep(500);
  assert.deepEqual(uncaught, []);
});

test('normal HTML responses are still consumed end to end', async t => {
  const uncaught = captureUncaught(t);
  const payload = '<!doctype html><html><body><article><p>Useful article text</p></article></body></html>';
  const server = await startServer((req, res) => {
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  t.after(() => closeServer(server));
  const port = server.address().port;

  const response = await nodeHttpFetch(`http://127.0.0.1:${port}/page`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('Useful article text'));

  const content = await getSingleWebPageContent({ url: `http://api.example.test:${port}/page`, fetchImpl: pinnedFetch(port) });
  assert.ok(content.includes('Useful article text'));
  await sleep(300);
  assert.deepEqual(uncaught, []);
});

test('cancellation scenarios pass under the embedded Electron Node runtime', async () => {
  // Always run the child with Electron's binary when it is available, so the
  // regression is validated against Electron 30.5.1's Node 20.16.0 — the
  // runtime that ships the broken Readable.toWeb() adapter — even when the
  // parent test suite runs on a newer system Node.
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');
  const execPath = fs.existsSync(electron) ? electron : process.execPath;
  const child = spawn(execPath, [path.join(__dirname, 'fixtures', 'fetchCancelChild.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const { code, signal } = await new Promise(resolve => {
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const detail = `exit=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  assert.doesNotMatch(stderr, /ERR_INVALID_STATE/, detail);
  assert.equal(code, 0, detail);
  assert.match(stdout, /CHILD_OK/, detail);
});
