'use strict';

const https = require('node:https');
const http = require('node:http');
const { finished, destroy } = require('node:stream');
const { ReadableStream, CountQueuingStrategy, ByteLengthQueuingStrategy } = require('node:stream/web');

// Workaround for nodejs/node#54205, present in Electron 30.5.1's embedded
// Node 20.16.0 and fixed upstream in nodejs/node#54206 (released in Node
// 20.18.0 / 22.7.0, so Electron will only pick it up in a future runtime).
// There, cancelling a response body — webSearch.js does this for redirect,
// error and unsupported-content-type responses — followed by the underlying
// IncomingMessage's 'close' event drove the Readable.toWeb() adapter's
// finished() callback to call controller.close() on an already-closed Web
// Stream controller, throwing ERR_INVALID_STATE as an uncaught exception in
// the main process.
//
// readableToWeb() is adapted from Node.js lib/internal/webstreams/adapters.js
// (newReadableStreamFromStreamReadable), MIT License, Copyright Node.js
// contributors — see https://github.com/nodejs/node/blob/main/LICENSE — with
// the upstream #54206 guard (wasCanceled) applied. It uses only public APIs
// (stream.finished, stream.destroy, stream/web); streaming, backpressure,
// error propagation and cancellation behavior otherwise match the upstream
// adapter. The upstream #54206 guard only covers the close path because
// controller.error() is a no-op on an already-closed stream, per the Web
// Streams spec. Remove this helper once Electron ships a Node runtime that
// includes nodejs/node#54206.
class ResponseAbortError extends Error {
  // Mirrors Node's internal AbortError; callers only check the name/code
  // (subagent code treats name === 'AbortError' || code === 'ABORT_ERR' as a
  // stop signal, and upstream's adapter reports premature closes this way).
  constructor(options) {
    super('The operation was aborted', options);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

function readableToWeb(streamReadable) {
  if (typeof streamReadable?._readableState !== 'object') {
    throw new TypeError('streamReadable must be a node.js Readable stream.');
  }
  if (streamReadable.destroyed || !streamReadable.readable) {
    const closed = new ReadableStream();
    closed.cancel();
    return closed;
  }

  const objectMode = streamReadable.readableObjectMode;
  const highWaterMark = streamReadable.readableHighWaterMark;
  const strategy = objectMode
    ? new CountQueuingStrategy({ highWaterMark })
    : new ByteLengthQueuingStrategy({ highWaterMark });

  let controller;
  let wasCanceled = false;

  function onData(chunk) {
    // Copy the Buffer to detach it from the pool. (as in the Node adapter)
    if (Buffer.isBuffer(chunk) && !objectMode) chunk = new Uint8Array(chunk);
    controller.enqueue(chunk);
    if (controller.desiredSize <= 0) streamReadable.pause();
  }

  streamReadable.pause();

  const cleanup = finished(streamReadable, error => {
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') error = new ResponseAbortError({ cause: error });
    cleanup();
    // This is a protection against non-standard, legacy streams
    // that happen to emit an error event again after finished is called.
    streamReadable.on('error', () => {});
    if (error) return controller.error(error);
    // nodejs/node#54206: the consumer may already have canceled this body,
    // which closed the controller; closing again throws ERR_INVALID_STATE
    // from inside this callback as an uncaught exception.
    if (wasCanceled) return;
    controller.close();
  });

  streamReadable.on('data', onData);

  return new ReadableStream({
    start(c) { controller = c; },

    pull() { streamReadable.resume(); },

    cancel(reason) {
      wasCanceled = true;
      destroy(streamReadable, reason);
    },
  }, strategy);
}

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
      const responseBody = [204, 205, 304].includes(status) ? null : readableToWeb(res);
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
