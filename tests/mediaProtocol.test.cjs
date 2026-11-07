const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { serveMediaRequest } = require('../src/main/localMedia');
const mediaUrl = file => pathToFileURL(file).href.replace(/^file:\/\//, 'media://files');

test('media handler streams actual file bytes with HTTP range support', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  try {
    const file = path.join(dir, 'clip #%.mp4');
    await fs.writeFile(file, 'video fixture');
    const tsFile = path.join(dir, 'stream.ts');
    const packets = Buffer.alloc(188 * 5);
    for (let i = 0; i < 5; i++) packets[i * 188] = 0x47;
    await fs.writeFile(tsFile, packets);
    const get = (range, method = 'GET') => serveMediaRequest(new Request(mediaUrl(file), {
      method, headers: range ? { Range: range } : {},
    }), () => true);
    const response = await get('bytes=0-4');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-4/13');
    assert.equal(response.headers.get('content-length'), '5');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(await response.text(), 'video');
    for (const [range, expected] of [['bytes=6-', 'fixture'], ['bytes=-7', 'fixture'], ['bytes=10-999', 'ure']]) {
      const part = await get(range);
      assert.equal(part.status, 206);
      assert.equal(await part.text(), expected);
    }
    for (const range of ['bytes=13-', 'bytes=8-2', 'bytes=-0']) {
      const invalid = await get(range);
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), 'bytes */13');
    }
    const full = await get();
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), 'video fixture');
    const head = await get(null, 'HEAD');
    assert.equal(head.headers.get('content-length'), '13');
    assert.equal(await head.text(), '');
    const tsResponse = await serveMediaRequest(new Request(mediaUrl(tsFile), { headers: { Range: 'bytes=0-4' } }), () => true);
    assert.equal(tsResponse.status, 206);
    assert.deepEqual(Buffer.from(await tsResponse.arrayBuffer()), packets.subarray(0, 5));
    await fs.writeFile(path.join(dir, 'secret.txt'), 'secret');
    await fs.symlink(path.join(dir, 'secret.txt'), path.join(dir, 'fake.png'));
    for (const url of [mediaUrl(path.join(dir, 'secret.txt')), mediaUrl(path.join(dir, 'fake.png')), mediaUrl(dir), mediaUrl(path.join(dir, 'missing.png')), 'media://server/share/a.png', 'media:///tmp/%00.png']) {
      assert.equal((await serveMediaRequest(new Request(url))).status, 404);
    }
    assert.equal((await serveMediaRequest(new Request(mediaUrl(file), { method: 'POST' }))).status, 405);
    await fs.writeFile(tsFile, 'export const answer: number = 42;');
    assert.equal((await serveMediaRequest(new Request(mediaUrl(tsFile)), () => true)).status, 404);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Downloads media is public but registered attachments remain protected', () => {
  const Module = require('node:module');
  const original = Module._load;
  const root = path.join(os.tmpdir(), 'media-policy-fixture');
  const downloads = path.join(root, 'Downloads');
  const protectedFile = path.join(downloads, 'private.webm');
  Module._load = function(name, parent, ...rest) {
    if (parent?.filename === require.resolve('../src/main/localMedia')) {
      if (name === 'electron') return { app: { getPath: kind => kind === 'downloads' ? downloads : path.join(root, 'profile') } };
      if (name === './configStore') return { getConfig: () => ({ appDataDirectory: path.join(root, 'data') }) };
      if (name === './attachmentStore') return { directory: () => path.join(root, 'managed') };
      if (name === './db') return { isInitialized: () => true, db: { prepare: () => ({ get: file => file === protectedFile ? {} : undefined, all: () => [] }) } };
    }
    return original.call(this, name, parent, ...rest);
  };
  try {
    const { publicMediaPath } = require('../src/main/localMedia');
    assert.equal(publicMediaPath(path.join(downloads, 'clip.webm')), true);
    assert.equal(publicMediaPath(protectedFile), false);
    assert.equal(publicMediaPath(path.join(root, 'other', 'clip.webm')), false);
  } finally { Module._load = original; }
});
