const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverDirectories } = require('../src/main/directoryDiscovery');

test('discovers nested and ambiguous names without following symlinks or dependencies', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-discovery-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const folder of ['src/context', 'other/context', 'node_modules/pkg/context', '.git/context', 'outside/context']) {
        await fs.mkdir(path.join(root, folder), { recursive: true });
    }
    const workspace = path.join(root, 'src');
    await fs.symlink(path.join(root, 'outside'), path.join(workspace, 'linked'));
    assert.deepEqual((await discoverDirectories(workspace, 'context')).matches, ['context']);
    const result = await discoverDirectories(root, 'context');
    assert.deepEqual(result.matches.sort(), ['other/context', 'outside/context', 'src/context']);
    assert.equal(result.truncated, false);
    assert.equal((await discoverDirectories(root, 'context', { limit: 1 })).truncated, true);
    assert.deepEqual((await discoverDirectories(root, 'absent')).matches, []);
    await assert.rejects(discoverDirectories(root, '/context'), /single folder name/);
    await assert.rejects(discoverDirectories(root, '..'), /single folder name/);
});
