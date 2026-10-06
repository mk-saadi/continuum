'use strict';

const https = require('node:https');
const http = require('node:http');
const { Readable } = require('node:stream');

// Electron's RUN_AS_NODE environment can break native (undici) fetch with
// ERR_INVALID_IP_ADDRESS, so outbound requests share this Node HTTP transport.
// It is deliberately independent of whatever global.fetch currently points at,
// which lets cloud providers POST while the sub-agent override stays GET-only.
function nodeHttpFetch(url, options = {}) {
  const target = new URL(url);
  const protocol = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!protocol) return Promise.reject(new TypeError('Only HTTP and HTTPS URLs are supported.'));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);

  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (!headers.has('user-agent')) headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  let body = null;
  if (options.body != null && (typeof options.body === 'string' || Buffer.isBuffer(options.body))) {
    body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    if (!headers.has('content-length')) headers.set('content-length', String(body.byteLength));
  }

  return new Promise((resolve, reject) => {
    const onResponse = res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location && options.redirect !== 'manual') {
        res.resume();
        const redirects = options._redirects || 0;
        if (redirects >= 5) { reject(new Error('Too many fetch redirects.')); return; }
        resolve(nodeHttpFetch(new URL(res.headers.location, target), {
          ...options, dispatcher: undefined, _redirects: redirects + 1,
        }));
        return;
      }
      const responseBody = [204, 205, 304].includes(status) ? null : Readable.toWeb(res);
      if (!responseBody) res.resume();
      resolve(new Response(responseBody, { status, statusText: res.statusMessage, headers: res.headers }));
    };
    // GET keeps the short idle deadline (bounded page fetches). POSTs stream long
    // cloud completions whose silence can legitimately last minutes; their
    // lifetime is governed by the caller's AbortSignal instead.
    const req = method === 'GET'
      ? protocol.get(target, {
        family: 4, // Bypass Node 20 autoSelectFamily in Electron's RUN_AS_NODE sandbox.
        headers: Object.fromEntries(headers),
        lookup: options.dispatcher?.nodeLookup,
        signal: options.signal,
      }, onResponse)
      : (() => {
        const request = protocol.request(target, {
          family: 4,
          method,
          headers: Object.fromEntries(headers),
          lookup: options.dispatcher?.nodeLookup,
          signal: options.signal,
        }, onResponse);
        if (body) request.write(body);
        request.end();
        return request;
      })();
    req.on('error', reject);
    if (method === 'GET') req.setTimeout(15000, () => req.destroy(new Error('Fetch timeout exceeded')));
  });
}

module.exports = { nodeHttpFetch };
