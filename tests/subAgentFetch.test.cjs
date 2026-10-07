const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

require('../src/main/subAgentRunner');

test('sub-agent fetch uses Node HTTP for GET, redirects, text and JSON', async () => {
  const originalGet = http.get;
  http.get = (url, options, callback) => {
    assert.equal(options.family, 4);
    const req = new EventEmitter();
    req.setTimeout = milliseconds => assert.equal(milliseconds, 15000);
    const redirect = url.pathname === '/redirect';
    const json = url.pathname === '/json';
    const body = json ? JSON.stringify({ userAgent: options.headers['user-agent'] }) : 'Hello';
    const res = Readable.from([Buffer.from(redirect ? '' : body)]);
    res.statusCode = redirect ? 302 : 200;
    res.statusMessage = redirect ? 'Found' : 'OK';
    res.headers = redirect ? { location: '/json' } : { 'content-type': json ? 'application/json' : 'text/plain' };
    queueMicrotask(() => callback(res));
    return req;
  };
  try {
    const base = 'http://example.com';
    const text = await fetch(`${base}/text`);
    assert.equal(text.status, 200);
    assert.equal(text.headers.get('content-type'), 'text/plain');
    assert.equal(await text.text(), 'Hello');
    const json = await fetch(`${base}/redirect`);
    assert.equal((await json.json()).userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const manual = await fetch(`${base}/redirect`, { redirect: 'manual' });
    assert.equal(manual.status, 302);
    assert.equal(manual.headers.get('location'), '/json');
    await manual.body.cancel();
    await assert.rejects(fetch(base, { method: 'POST' }), /only supports GET/);
  } finally {
    http.get = originalGet;
  }
});
