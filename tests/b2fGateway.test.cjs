'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const wsFixture = require('./helpers/previewWebSocket.cjs');
const { createService } = require('../src/main/developmentPreviews');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    if (body != null) options = { ...options, headers: { ...options.headers, 'Content-Length': Buffer.byteLength(body) } };
    const req = http.request(url, options, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
const websocket = wsFixture.connect;
async function fixture(expiresIn = 60000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/malformed') { req.socket.end('invalid response\r\n\r\n'); return; }
    if (req.url === '/large') {
      let remaining = 128; const chunk = Buffer.alloc(65536, 'x');
      const pump = () => { while (remaining-- > 0) { if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
      pump(); return;
    }
    if (req.url === '/stream') { res.writeHead(200); res.write('first'); setTimeout(() => res.end('last'), 100); return; }
    if (req.url === '/') { res.end('ready'); return; }
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      res.writeHead(201, { 'x-query': req.url, 'x-cookie': req.headers.cookie || '', 'access-control-allow-origin': '*', 'x-origin': req.headers.origin || '', 'x-authorization': req.headers.authorization || '' });
      res.end(req.method + ':' + Buffer.concat(chunks));
    });
  });
  wsFixture.server(server);
  const sockets = new Set(); server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController(), context = {}, opened = [];
  let live = true;
  const authority = { signal: controller.signal, expiresAt: Date.now() + expiresIn,
    validate() { if (!live || controller.signal.aborted) throw new Error('revoked'); },
    async connect() { return new Promise((resolve, reject) => { const socket = net.connect(server.address().port, '127.0.0.1'); socket.once('connect', () => resolve(socket)); socket.once('error', reject); }); } };
  const gateway = createService({ readiness: () => ({ available: true }),
    resolveAuthority(id, actor) { assert.equal(actor, context); assert.equal(id, 'owned'); return authority; }, openExternal(url) { opened.push(url); } });
  const preview = await gateway.create(context, { background_command_id: 'owned', guest_port: server.address().port });
  async function grant() {
    await gateway.open(context, 'owned');
    const token = new URL(opened.at(-1)).hash.slice(1);
    const res = await request(preview.url + '.continuum-preview', { method: 'POST', headers: { Origin: new URL(preview.url).origin, 'Content-Type': 'text/plain' } }, token);
    assert.equal(res.status, 204);
    assert.match(res.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    return { token, cookie: res.headers['set-cookie'][0].split(';')[0] };
  }
  return { server, gateway, preview, context, controller, opened, grant, revoke() { live = false; }, async close() {
    await gateway.shutdown(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve));
  } };
}

test('authentication, single-use expiry, Host/Origin, streaming methods and WebSockets (controlled gateway transport)', async () => {
  const f = await fixture(7200000);
  try {
    const { url } = f.preview, origin = new URL(url).origin;
    assert.equal((await request(url)).status, 403);
    const landing = await request(url + '.continuum-preview'); assert.equal(landing.status, 200);
    assert.match(landing.body, /history.replaceState/);
    await assert.rejects(websocket(url.replace('http:', 'ws:'), { origin }), /403/);
    await f.gateway.open(f.context, 'owned');
    const expired = new URL(f.opened.at(-1)).hash.slice(1);
    const now = Date.now;
    let res;
    try { Date.now = () => now() + 16000;
      res = await request(url + '.continuum-preview', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' } }, expired);
    } finally { Date.now = now; }
    assert.equal(res.status, 403);
    assert.equal((await request(url + '.continuum-preview', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' } }, 'é'.repeat(43))).status, 403);
    const { cookie, token } = await f.grant();
    assert.equal((await request(url + '.continuum-preview', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' } }, token)).status, 403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      res = await request(url + 'echo?query=1', { method, headers: { Cookie: cookie + '; app=value', Origin: origin, Authorization: 'Bearer application-credential' } }, 'data');
      assert.equal(res.status, 201); assert.equal(res.body, method + ':data');
      assert.equal(res.headers['x-query'], '/echo?query=1'); assert.equal(res.headers['x-cookie'].trim(), 'app=value');
      assert.equal(res.headers['x-authorization'], 'Bearer application-credential');
      assert.equal(res.headers['x-origin'], origin); assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await request(url, { headers: { Cookie: cookie, Host: 'evil.test' } })).status, 403);
    assert.equal((await request(url, { headers: { Cookie: cookie, Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request(url, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request(url, { headers: { Cookie: cookie, 'Service-Worker': 'script' } })).status, 403);
    assert.equal((await request(url + 'malformed', { headers: { Cookie: cookie } })).status, 502);
    const seen = [];
    await new Promise((resolve, reject) => {
      http.get(url + 'stream', { headers: { Cookie: cookie } }, incoming => {
        incoming.on('data', data => seen.push(data.toString())); incoming.on('end', resolve);
      }).on('error', reject);
    }); assert.deepEqual(seen, ['first', 'last']);
    assert.equal((await request(url + 'echo', { method: 'POST', headers: { Cookie: cookie, 'Content-Length': 33554433 } })).status, 413);
    const currentTime = Date.now;
    try {
      Date.now = () => currentTime() + 1800001;
      assert.equal((await request(url, { headers: { Cookie: cookie } })).status, 403);
    } finally { Date.now = currentTime; }
    // Refresh a browser credential after its bounded lifetime.
    const refreshed = await f.grant();
    const ws = await websocket(url.replace('http:', 'ws:'), { origin, headers: { Cookie: refreshed.cookie } });
    const echoed = new Promise(resolve => ws.once('message', data => resolve(data.toString()))); ws.send('hmr-like');
    assert.equal(await echoed, 'hmr-like');
    f.controller.abort(); await delay(100);
    assert.equal(ws.readyState, 3); assert.equal(f.gateway.active(), 0); await assert.rejects(request(url));
  } finally { await f.close(); }
});

test('expiry, revocation, shutdown and restart never preserve preview authority', async () => {
  for (const reason of ['expiry', 'revoked', 'shutdown']) {
    const f = await fixture(reason === 'expiry' ? 250 : 60000);
    try {
      const { cookie } = await f.grant();
      if (reason === 'expiry') await delay(350);
      if (reason === 'revoked') { f.revoke(); await delay(100); }
      if (reason === 'shutdown') await f.gateway.shutdown();
      assert.equal(f.gateway.active(), 0);
      await assert.rejects(request(f.preview.url, { headers: { Cookie: cookie } }));
      const restarted = createService(); assert.equal(restarted.active(), 0); await restarted.shutdown();
    } finally { await f.close(); }
  }
});


test('concurrent creation, bounded large streaming, malformed clients, disconnect and active shutdown', async () => {
  const f = await fixture();
  try {
    f.gateway.close(f.context, 'owned');
    const attempts = await Promise.allSettled([1, 2].map(() => f.gateway.create(f.context,
      { background_command_id: 'owned', guest_port: f.server.address().port })));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(r => r.status === 'rejected').length, 1);
    const url = attempts.find(r => r.status === 'fulfilled').value.url;
    await f.gateway.open(f.context, 'owned');
    const response = await request(url + '.continuum-preview', { method: 'POST', headers: {
      Origin: new URL(url).origin, 'Content-Type': 'text/plain' } }, new URL(f.opened.at(-1)).hash.slice(1));
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    let bytes = 0;
    await new Promise((resolve, reject) => {
      http.get(url + 'large', { headers: { Cookie: cookie } }, res => {
        res.on('data', chunk => { bytes += chunk.length; res.pause(); setTimeout(() => res.resume(), 1); });
        res.on('end', resolve); res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(bytes, 8 * 1024 * 1024);
    const parsed = new URL(url);
    for (const raw of ['INVALID HTTP\r\n\r\n', `GET / HTTP/1.1\r\nHost: ${parsed.host}\r\nX-Large: ${'x'.repeat(17000)}\r\n\r\n`]) {
      await new Promise((resolve, reject) => {
        const socket = net.connect(Number(parsed.port), parsed.hostname, () => socket.end(raw));
        socket.on('data', () => {}); socket.on('close', resolve); socket.on('error', reject);
        socket.setTimeout(2000, () => { socket.destroy(); reject(Error('malformed client retained')); });
      });
    }
    const flood = Array.from({ length: 40 }, () => {
      const socket = net.connect(Number(parsed.port), parsed.hostname);
      socket.on('error', () => {}); return socket;
    });
    await delay(150);
    assert.ok(flood.filter(socket => !socket.destroyed).length <= 32, 'connection cap');
    flood.forEach(socket => socket.destroy()); await delay(50);
    await new Promise((resolve, reject) => {
      http.get(url + 'large', { headers: { Cookie: cookie } }, res => {
        res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {});
      }).on('error', reject);
    });
    const active = await new Promise((resolve, reject) => {
      http.get(url + 'large', { headers: { Cookie: cookie } }, res => { res.pause(); res.on('error', () => {}); resolve(res); }).on('error', reject);
    });
    await f.gateway.shutdown(); active.destroy();
    assert.equal(f.gateway.active(), 0); await assert.rejects(request(url));
  } finally { await f.close(); }
});


test('host listener allocation failure releases the preview slot and allows retry', async () => {
  const f = await fixture();
  const listen = http.Server.prototype.listen;
  try {
    f.gateway.close(f.context, 'owned');
    http.Server.prototype.listen = function() {
      process.nextTick(() => this.emit('error', Object.assign(Error('occupied'), { code: 'EADDRINUSE' })));
      return this;
    };
    await assert.rejects(f.gateway.create(f.context, { background_command_id: 'owned', guest_port: f.server.address().port }), { code: 'EADDRINUSE' });
    assert.equal(f.gateway.active(), 0);
    http.Server.prototype.listen = listen;
    assert.equal((await f.gateway.create(f.context, { background_command_id: 'owned', guest_port: f.server.address().port })).status, 'ready');
  } finally { http.Server.prototype.listen = listen; await f.close(); }
});
