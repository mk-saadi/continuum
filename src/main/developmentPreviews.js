'use strict';
// Trusted application infrastructure only. Renderer IPC uses the gated
// singleton; no setting or environment bypass enables it.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { pipeline } = require('node:stream');
const policy = require('./workspaceNetworkPolicy');
const secret = () => randomBytes(32).toString('base64url');
const failure = code => Object.assign(new Error(code), { code });
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const RESERVED = '/.continuum-preview';

function createService({ readiness = policy.readiness, resolveAuthority = require('./backgroundCommands').previewAuthority,
  openExternal = url => require('electron').shell.openExternal(url) } = {}) {
  const previews = new Map();
  let shuttingDown = false;
  function available() { if (shuttingDown || !readiness().available) throw failure('WORKSPACE_NETWORK_NOT_READY'); }
  function lookup(context, commandId) {
    available();
    const authority = resolveAuthority(commandId, context); authority.validate();
    const p = previews.get(commandId);
    if (!p || p.closed) throw failure('PREVIEW_NOT_FOUND');
    p.authority.validate();
    return p;
  }
  function close(p) {
    if (p.closed) return;
    p.closed = true; p.grant = null; p.credentials.clear(); clearInterval(p.monitor);
    p.authority.signal?.removeEventListener('abort', p.abort);
    if (previews.get(p.commandId) === p) previews.delete(p.commandId);
    for (const socket of p.sockets) socket.destroy();
    for (const stream of p.upstreams) stream.destroy();
    p.server.close();
  }
  async function connect(p) {
    p.authority.validate();
    if (p.closed || p.upstreams.size + p.connecting >= 32) throw failure('PREVIEW_CONNECTION_LIMIT');
    p.connecting++;
    try {
      const socket = await p.authority.connect(p.port);
      if (p.closed) { socket.destroy(); throw failure('PREVIEW_CLOSED'); }
      try { p.authority.validate(); } catch (e) { socket.destroy(); throw e; }
      p.upstreams.add(socket);
      socket.once('close', () => p.upstreams.delete(socket));
      // http.ClientRequest accepts pipe-backed Duplex transports.
      socket.setNoDelay ??= () => socket;
      socket.setKeepAlive ??= () => socket;
      socket.setTimeout ??= () => socket;
      return socket;
    } finally { p.connecting--; }
  }
  function stripHopHeaders(headers, websocket = false) {
    const h = { ...headers };
    const nominated = String(h.connection || '').toLowerCase().split(',').map(s => s.trim());
    for (const name of [...nominated, 'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding']) {
      if (websocket && ['connection', 'upgrade'].includes(name)) continue;
      delete h[name];
    }
    if (!websocket) delete h.upgrade;
    return h;
  }
  function headers(p, req, websocket = false) {
    const h = stripHopHeaders(req.headers, websocket);
    h.host = `127.0.0.1:${p.port}`;
    delete h['proxy-authorization'];
    for (const name of Object.keys(h)) if (name.startsWith('x-forwarded-') || name === 'forwarded') delete h[name];
    h.cookie = (h.cookie || '').split(';').filter(part => !part.trim().startsWith(p.cookie + '=')).join(';');
    if (!h.cookie) delete h.cookie;
    // Preserve the authenticated browser Origin. Never broaden upstream CORS.
    return h;
  }
  function responseHeaders(p, incoming, websocket = false) {
    const h = stripHopHeaders(incoming.headers, websocket);
    for (const key of Object.keys(h)) if (key.startsWith('access-control-') || key === 'service-worker-allowed') delete h[key];
    if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].filter(value => !value.startsWith(p.cookie + '='));
    h['referrer-policy'] = 'no-referrer';
    h['content-security-policy'] = [h['content-security-policy'], "worker-src 'none'; frame-ancestors 'none'"].filter(Boolean);
    h['cache-control'] = 'no-store';
    if (typeof h.location === 'string') {
      for (const host of ['127.0.0.1', 'localhost']) {
        const base = `http://${host}:${p.port}`;
        if (h.location.startsWith(base + '/') || h.location === base) h.location = p.origin + h.location.slice(base.length);
      }
    }
    return h;
  }
  function validRequest(p, req, websocket = false) {
    try { available(); p.authority.validate(); } catch { close(p); return false; }
    if (p.closed || req.headers.host !== p.origin.slice(7) || !req.url.startsWith('/') || req.url.startsWith('//') ||
        (req.headers.origin && req.headers.origin !== p.origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
        req.headers['service-worker'] || (websocket && req.headers.origin !== p.origin)) return false;
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(p.cookie + '='));
    const credential = cookies.length === 1 && cookies[0].slice(p.cookie.length + 1);
    const expiration = credential && p.credentials.get(credential);
    return Boolean(expiration && expiration > Date.now());
  }
  function denied(res) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end('Preview authorization required'); }
  function bootstrap(p, req, res) {
    if (req.headers.host !== p.origin.slice(7) || (req.headers.origin && req.headers.origin !== p.origin)) return denied(res);
    if (req.method === 'GET' && req.url === RESERVED) {
      const nonce = secret();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; worker-src 'none'` });
      res.end(`<!doctype html><title>Authorize preview</title><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch('${RESERVED}',{method:'POST',headers:{'Content-Type':'text/plain'},body:token}).then(r=>{if(r.ok)location.replace('/');else document.body.textContent='Preview authorization expired';});</script><body>Authorizing preview…</body>`);
      return;
    }
    if (req.method !== 'POST' || req.url !== RESERVED || req.headers.origin !== p.origin ||
        req.headers['content-type'] !== 'text/plain' || ++p.authAttempts > 60) return denied(res);
    let body = '', bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 128) req.destroy(); else body += chunk.toString('utf8'); });
    req.on('end', () => {
      try { available(); p.authority.validate(); } catch { close(p); return; }
      if (p.closed || !p.grant || p.grant.expires <= Date.now() || !equal(body, p.grant.value)) return denied(res);
      p.grant = null;
      if (p.credentials.size >= 4) p.credentials.delete(p.credentials.keys().next().value);
      const credential = secret(), expires = Math.min(p.authority.expiresAt, Date.now() + 1800000);
      p.credentials.set(credential, expires);
      res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': `${p.cookie}=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}` }); res.end();
    });
  }
  function proxy(p, req, res) {
    if (req.url.split('?')[0] === RESERVED) return bootstrap(p, req, res);
    if (!validRequest(p, req) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return denied(res);
    const length = req.headers['content-length'];
    if (length && Number(length) > 32 * 1024 * 1024) { res.writeHead(413, { Connection: 'close' }); res.end(); return; }
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) req.destroy(); });
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { connect(p).then(s => callback(null, s), callback); };
    const upstream = http.request({ method: req.method, path: req.url, host: '127.0.0.1', port: p.port, headers: headers(p, req), agent, maxHeaderSize: 16384 });
    upstream.on('response', incoming => {
      res.writeHead(incoming.statusCode, responseHeaders(p, incoming));
      pipeline(incoming, res, () => agent.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Preview upstream unavailable'); } else res.destroy(); agent.destroy(); });
    res.on('close', () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
  function upgrade(p, req, socket, head) {
    if (!validRequest(p, req, true) || req.url.split('?')[0] === RESERVED || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { connect(p).then(s => callback(null, s), callback); };
    const upstream = http.request({ method: 'GET', path: req.url, host: '127.0.0.1', port: p.port, headers: headers(p, req, true), agent, maxHeaderSize: 16384 });
    upstream.on('upgrade', (response, stream, initial) => {
      if (p.closed || socket.destroyed) { stream.destroy(); return; }
      let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [key, value] of Object.entries(responseHeaders(p, response, true))) if (value != null) {
        for (const v of Array.isArray(value) ? value : [value]) reply += `${key}: ${v}\r\n`;
      }
      socket.write(reply + '\r\n');
      if (initial.length) socket.write(initial);
      if (head.length) stream.write(head);
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('close', () => { stream.destroy(); agent.destroy(); });
      stream.on('close', () => socket.destroy());
    });
    upstream.on('response', () => { socket.destroy(); agent.destroy(); });
    upstream.on('error', () => { socket.destroy(); agent.destroy(); });
    socket.on('close', () => upstream.destroy()); upstream.end();
  }
  async function create(context, { background_command_id: commandId, guest_port: port }) {
    available();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('PREVIEW_PORT_INVALID');
    const authority = resolveAuthority(commandId, context); authority.validate();
    if (previews.has(commandId) || previews.size >= 4) throw failure('PREVIEW_LIMIT_OR_CONFLICT');
    const p = { commandId, port, authority, sockets: new Set(), upstreams: new Set(), connecting: 0, credentials: new Map(), grant: null, authAttempts: 0,
      cookie: 'continuum_' + randomBytes(12).toString('hex'), closed: false };
    previews.set(commandId, p);
    p.server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 120000, keepAliveTimeout: 5000 }, (req, res) => proxy(p, req, res));
    p.server.maxConnections = 32;
    p.server.on('connection', socket => {
      if (p.closed || p.sockets.size >= 32) { socket.destroy(); return; }
      p.sockets.add(socket); socket.once('close', () => p.sockets.delete(socket));
      socket.on('error', () => {}); socket.setTimeout(120000, () => socket.destroy());
      // Absolute connection lifetime cannot outlive the command's finite lease.
    });
    p.server.on('upgrade', (req, socket, head) => upgrade(p, req, socket, head));
    p.server.on('clientError', (_error, socket) => socket.destroy());
    p.server.on('error', () => close(p));
    p.abort = () => close(p); authority.signal?.addEventListener('abort', p.abort, { once: true });
    p.monitor = setInterval(() => {
      try { available(); authority.validate(); if (Date.now() >= authority.expiresAt) throw failure('PREVIEW_EXPIRED'); }
      catch { close(p); }
      for (const [key, expires] of p.credentials) if (expires <= Date.now()) p.credentials.delete(key);
    }, 50);
    try {
      // Unique loopback origin also avoids browser storage reuse across previews.
      const octets = randomBytes(3); const host = `127.${octets[0]}.${octets[1]}.${octets[2] || 1}`;
      await new Promise((resolve, reject) => { p.server.once('error', reject); p.server.listen(0, host, resolve); });
      p.origin = `http://${host}:${p.server.address().port}`;
      // Probe the actual gateway boundary with a private temporary credential.
      const probeCredential = secret();
      p.credentials.set(probeCredential, Date.now() + 5000);
      await new Promise((resolve, reject) => {
        const request = http.get(p.origin + '/', { headers: { Cookie: `${p.cookie}=${probeCredential}` } }, res => {
          if (res.statusCode < 200 || res.statusCode >= 400) { res.destroy(); reject(failure('PREVIEW_HTTP_NOT_READY')); }
          else { res.destroy(); resolve(); }
        });
        const timer = setTimeout(() => { request.destroy(); reject(failure('PREVIEW_STARTUP_TIMEOUT')); }, 5000);
        request.on('error', reject); request.on('close', () => clearTimeout(timer));
      });
      p.credentials.delete(probeCredential);
      authority.validate(); if (p.closed) throw failure('PREVIEW_CLOSED');
      p.ready = true; return status(context, commandId);
    } catch (e) { close(p); throw e; }
  }
  function status(context, commandId) {
    const p = lookup(context, commandId);
    return { status: p.ready ? 'ready' : 'starting', url: p.ready ? p.origin + '/' : null, expires_at: new Date(p.authority.expiresAt).toISOString() };
  }
  async function open(context, commandId) {
    const p = lookup(context, commandId);
    if (!p.ready) throw failure('PREVIEW_NOT_READY');
    p.grant = { value: secret(), expires: Date.now() + 15000 };
    // Fragment is a single-use handoff, never a tool result/log/history record.
    // Browser bootstrap immediately removes it, then POSTs for an HttpOnly cookie.
    try { await openExternal(`${p.origin}${RESERVED}#${p.grant.value}`); }
    catch { p.grant = null; throw failure('PREVIEW_BROWSER_OPEN_FAILED'); }
  }
  return { create, status, open, close(context, commandId) { close(lookup(context, commandId)); },
    async shutdown() { shuttingDown = true; for (const p of [...previews.values()]) close(p); }, active: () => previews.size };
}
module.exports = { createService, service: createService() };
