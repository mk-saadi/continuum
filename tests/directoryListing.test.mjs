import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectoryListing, isDirectoryTool, localMediaUrl } from '../src/lib/directoryListing.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { resolveMediaPath, validateLocalPath } = createRequire(import.meta.url)('../src/main/localMedia');

test('recognizes both directory tools and normalizes JSON and MCP wrappers', () => {
  for (const name of ['list_directory', 'mcp_list_directory', 'list_directory_with_size', 'mcp_list_directory_with_size']) assert.ok(isDirectoryTool(name));
  assert.equal(isDirectoryTool('search_files'), false);
  const items = [{ name: 'photo #1%.png', type: 'file', path: '/tmp/photo #1%.png', size: 123 }];
  for (const input of [items, JSON.stringify(items), { structuredContent: { entries: items } }, { content: [{ type: 'text', text: JSON.stringify(items) }] }]) {
    assert.deepEqual(parseDirectoryListing(input).items, items);
  }
  assert.deepEqual(parseDirectoryListing('[]').items, []);
  assert.equal(parseDirectoryListing('{oops'), null);
  assert.equal(parseDirectoryListing({ isError: true, structuredContent: items }), null);
  assert.equal(parseDirectoryListing([{ type: 'file', path: 'relative.png' }]), null);
  assert.equal(parseDirectoryListing([{ type: 'file', name: '../secret' }], { path: '/tmp' }), null);
});

test('resolves text entries with sizes, Windows paths, and truncation notices', () => {
  const result = parseDirectoryListing({ content: [{ type: 'text', text: '[DIR] photos\n[FILE] a b.png    2.5 KB\nTotal files: 1\nTotal directories: 1\nTotal size: 2.5 KB' }] }, { path: '/tmp' });
  assert.equal(result.items[0].path, '/tmp/photos');
  assert.equal(result.items[1].path, '/tmp/a b.png');
  assert.equal(result.items[1].size, '2.5 KB');
  assert.equal(parseDirectoryListing('[FILE] a.txt\nTotal: 1 files, 0 directories\nCombined size: 4 B', { path: '/tmp' }).items[0].path, '/tmp/a.txt');
  assert.equal(parseDirectoryListing('[FILE] photo.png', { path: 'C:\\Photos' }).items[0].path, 'C:\\Photos\\photo.png');
  const capped = parseDirectoryListing('[{"type":"file","path":"/tmp/a"}]\n...and 2 more items omitted to save context space.');
  assert.equal(capped.items.length, 1);
  assert.match(capped.notice, /2 more/);
});

test('local protocol round-trips encoded filenames and rejects unsafe resources', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-'));
  try {
    const file = path.join(directory, '日本 #100%.png');
    await fs.writeFile(file, 'fixture');
    assert.equal(await resolveMediaPath(localMediaUrl(file)), file);
    for (const value of ['relative.png', 'https://example.com/a.png', '/tmp/../secret.png', '/tmp/a\0.png', '//server/share/a.png']) {
      assert.throws(() => validateLocalPath(value));
    }
    for (const url of ['local://other/%2Ftmp%2Fa.png', 'local://media/%ZZ', localMediaUrl(file) + '?x=1', localMediaUrl('/tmp/secret.txt'), localMediaUrl(directory)]) {
      await assert.rejects(resolveMediaPath(url));
    }
    const secret = path.join(directory, 'secret.txt');
    await fs.writeFile(secret, 'secret');
    const link = path.join(directory, 'link.png');
    await fs.symlink(secret, link);
    await assert.rejects(resolveMediaPath(localMediaUrl(link)));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
