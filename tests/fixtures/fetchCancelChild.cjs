'use strict';
// Child process for tests/nodeHttpFetchCancel.test.cjs.
//
// Run under Electron's embedded Node runtime:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/fixtures/fetchCancelChild.cjs
//
// This script deliberately installs NO 'uncaughtException' handler. The bug it
// reproduces was an async ERR_INVALID_STATE thrown from Node's Web Stream
// adapter (lib/internal/webstreams/adapters.js) after a response body was
// cancelled, which crashed the Electron main process. Any such exception must
// fail this process with a non-zero exit code so the parent test can assert it.
const http = require('node:http');
const path = require('node:path');

const { nodeHttpFetch } = require(path.join(__dirname, '../../src/main/nodeHttpFetch'));
const { getSingleWebPageContent } = require(path.join(__dirname, '../../src/main/tools/webSearch'));

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// The crash surfaces on the IncomingMessage 'close' event some ticks after
// cancel(); give it time to happen before declaring a scenario clean.
const SETTLE_MS = 500;

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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

async function main() {
  const servers = [];
  const track = server => { servers.push(server); return server; };
  const closeAll = () => servers.forEach(server => { server.closeAllConnections(); server.close(); });

  // Scenario 1: the original incident — webpage tool fetches a JSON API whose
  // content type used to trip the type check and cancel the body (the crash
  // site). JSON is now supported, so the body is consumed end to end; the
  // unsupported-content-type cancel is exercised with a binary type instead.
  {
    const payload = JSON.stringify({ latitude: 46.7, temperature_2m: 21.4 });
    const server = track(await startServer((req, res) => {
      res.on('error', () => {});
      if (req.url === '/file.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end('%PDF-1.7');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    }));
    const port = server.address().port;
    const content = await getSingleWebPageContent({ url: `http://api.example.test:${port}/v1/forecast`, fetchImpl: pinnedFetch(port) });
    if (!content.includes('"temperature_2m": 21.4')) throw new Error('scenario 1: expected the tool to return the JSON response');
    await sleep(SETTLE_MS);
    try {
      await getSingleWebPageContent({ url: `http://api.example.test:${port}/file.pdf`, fetchImpl: pinnedFetch(port) });
      throw new Error('scenario 1: expected the tool to reject the unsupported content type');
    } catch (err) {
      if (!/did not return HTML, plain text or JSON/.test(err.message)) throw err;
    }
    await sleep(SETTLE_MS);
    console.log('scenario 1 ok: JSON read end to end, unsupported type cancelled, no process exception');
  }

  // Scenario 2: explicit cancellation of an already-received small body.
  {
    const payload = JSON.stringify({ ok: true });
    const server = track(await startServer((req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    }));
    const response = await nodeHttpFetch(`http://127.0.0.1:${server.address().port}/json`);
    if (response.status !== 200) throw new Error(`scenario 2: unexpected status ${response.status}`);
    await response.body.cancel(); // same as webSearch.js cancel paths
    await sleep(SETTLE_MS);
    console.log('scenario 2 ok: body cancel after receipt, no process exception');
  }

  // Scenario 3: cancellation before the body arrives (late body, then close).
  {
    const server = track(await startServer((req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'application/json' });
      const timer = setTimeout(() => res.end(JSON.stringify({ late: true })), 3000);
      res.on('close', () => clearTimeout(timer));
    }));
    const response = await nodeHttpFetch(`http://127.0.0.1:${server.address().port}/late`);
    await response.body.cancel();
    await sleep(SETTLE_MS);
    console.log('scenario 3 ok: body cancel before receipt, no process exception');
  }

  // Scenario 4: redirect and error responses cancelled both at the transport
  // level (redirect: 'manual') and through the tool's own cancel sites
  // (webSearch.js lines 125 and 130).
  {
    const server = track(await startServer((req, res) => {
      res.on('error', () => {});
      if (req.url === '/redirect') {
        res.writeHead(301, { location: '/final', 'content-length': 11 });
        res.end('redirecting!');
      } else {
        res.writeHead(500, { 'content-type': 'text/plain', 'content-length': 4 });
        res.end('boom');
      }
    }));
    const port = server.address().port;
    const redirect = await nodeHttpFetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });
    if (redirect.status !== 301) throw new Error(`scenario 4: unexpected redirect status ${redirect.status}`);
    await redirect.body.cancel();
    const failed = await nodeHttpFetch(`http://127.0.0.1:${port}/final`);
    if (failed.status !== 500) throw new Error(`scenario 4: unexpected error status ${failed.status}`);
    await failed.body.cancel();
    await sleep(SETTLE_MS);
    try {
      await getSingleWebPageContent({ url: `http://api.example.test:${port}/redirect`, fetchImpl: pinnedFetch(port) });
      throw new Error('scenario 4: expected the tool to reject the HTTP 500');
    } catch (err) {
      if (!/Web page request failed \(HTTP 500\)/.test(err.message)) throw err;
    }
    await sleep(SETTLE_MS);
    console.log('scenario 4 ok: redirect/error responses cancelled, no process exception');
  }

  // Scenario 5: normal HTML still reads end to end (control).
  {
    const payload = '<!doctype html><html><body><article><p>Useful article text</p></article></body></html>';
    const server = track(await startServer((req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    }));
    const port = server.address().port;
    const response = await nodeHttpFetch(`http://127.0.0.1:${port}/page`);
    const text = await response.text();
    if (!text.includes('Useful article text')) throw new Error('scenario 5: raw HTML read was corrupted');
    const content = await getSingleWebPageContent({ url: `http://api.example.test:${port}/page`, fetchImpl: pinnedFetch(port) });
    if (!content.includes('Useful article text')) throw new Error('scenario 5: tool HTML read was corrupted');
    await sleep(SETTLE_MS);
    console.log('scenario 5 ok: HTML consumed normally');
  }

  closeAll();
  console.log('CHILD_OK');
}

main().then(
  () => process.exit(0),
  err => { console.error(err && err.stack || err); process.exit(1); },
);
