const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { serveMediaRequest } = require('../src/main/localMedia');
const mediaUrl = file => pathToFileURL(file).href.replace(/^file:/, 'media:');

test('media handler serves validated files and forwards range requests without buffering', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  try {
    const file = path.join(dir, 'clip #%.mp4');
    await fs.writeFile(file, 'video fixture');
    const tsFile = path.join(dir, 'stream.ts');
    await fs.writeFile(tsFile, 'transport stream fixture');
    let count = 0;
    const fetchFile = async (url, options) => {
      count++;
      assert.ok([pathToFileURL(file).href, pathToFileURL(tsFile).href].includes(url));
      assert.equal(options.headers.get('range'), 'bytes=0-4');
      return new Response('video', { status: 206 });
    };
    const response = await serveMediaRequest(new Request(mediaUrl(file), { headers: { Range: 'bytes=0-4' } }), fetchFile);
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'video');
    // MPEG transport stream (.ts) passes the extension whitelist and streams with range support.
    const tsResponse = await serveMediaRequest(new Request(mediaUrl(tsFile), { headers: { Range: 'bytes=0-4' } }), fetchFile);
    assert.equal(tsResponse.status, 206);
    await fs.writeFile(path.join(dir, 'secret.txt'), 'secret');
    await fs.symlink(path.join(dir, 'secret.txt'), path.join(dir, 'fake.png'));
    for (const url of [mediaUrl(path.join(dir, 'secret.txt')), mediaUrl(path.join(dir, 'fake.png')), mediaUrl(dir), mediaUrl(path.join(dir, 'missing.png')), 'media://server/share/a.png', 'media:///tmp/%00.png']) {
      assert.equal((await serveMediaRequest(new Request(url), fetchFile)).status, 404);
    }
    assert.equal((await serveMediaRequest(new Request(mediaUrl(file), { method: 'POST' }), fetchFile)).status, 405);
    assert.equal(count, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
