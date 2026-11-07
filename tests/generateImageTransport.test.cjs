'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('loading sub-agent execution does not replace the process fetch', () => {
  const before = globalThis.fetch;
  require('../src/main/subagents/executionManager');
  assert.equal(globalThis.fetch, before);
});

test('image generation POST and image download work independently of global fetch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-transport-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const requests = [];
  let baseUrl;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', req.url === '/image.png' ? 'image/png' : 'application/json');
    res.end(req.url === '/image.png' ? png : JSON.stringify({ data: [{ url: `${baseUrl}/image.png` }] }));
  });
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    Module._load = function(name, ...args) {
      if (name === '../cloudProviders') return { getActiveMediaModel: () => ({ name: 'Test', apiType: 'openai-images', baseUrl, modelId: 'image-model', apiKey: 'test-key' }) };
      if (name === 'electron') return { app: { getPath: () => directory } };
      return originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = () => { throw new Error('Global fetch must not be used'); };
    const { generateImage } = require('../src/main/tools/generateImage');
    const result = await generateImage({ prompt: 'A glass rabbit' });
    assert.match(result, /^!\[Generated image\]/);
    assert.deepEqual(requests.map(r => [r.method, r.url]), [['POST', '/images/generations'], ['GET', '/image.png']]);
    assert.deepEqual(JSON.parse(requests[0].body), { model: 'image-model', prompt: 'A glass rabbit' });
    assert.equal(requests[0].auth, 'Bearer test-key');
    assert.equal(requests[1].auth, undefined);
    const [file] = await fs.readdir(path.join(directory, 'generated_media'));
    assert.deepEqual(await fs.readFile(path.join(directory, 'generated_media', file)), png);
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
