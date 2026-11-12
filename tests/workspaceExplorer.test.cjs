const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

test('workspace browsing bounds reads and rejects paths outside the project', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-explorer-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, 'hello.txt'), 'Hello workspace');
    await fs.writeFile(path.join(root, 'large.txt'), 'a'.repeat(600 * 1024));
    await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(directory, 'outside.txt'), 'outside');
    await fs.symlink(path.join(directory, 'outside.txt'), path.join(root, 'escape'));
    const service = { exports: {} };
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/main/workspaceExplorer.js'), 'utf8'), {
      module: service, Buffer, process, URL,
      require: name => name === './projectManager' ? { getProject: id => {
        assert.equal(id, 'project'); return { root_path: root };
      } } : name === './workspaceGit' ? require('../src/main/workspaceGit') : name === './toolPermissions' ? require('../src/main/toolPermissions') : require(name),
    });
    const { listDirectory, readFile, gitStatus, repositoryInfo } = service.exports;
    const listing = await listDirectory('project');
    assert.equal(listing.items[0].name, 'src');
    assert.ok(!listing.items.some(item => item.name === '.git'));
    assert.equal((await readFile('project', 'hello.txt')).content, 'Hello workspace');
    assert.equal((await readFile('project', 'binary.dat')).binary, true);
    const large = await readFile('project', 'large.txt');
    assert.equal(large.content.length, 512 * 1024);
    assert.equal(large.truncated, true);
    await assert.rejects(readFile('project', '../outside.txt'), /escapes/);
    await assert.rejects(readFile('project', 'escape'), /escapes/);
    await assert.rejects(listDirectory('project', '..'), /escapes/);
    await assert.rejects(readFile('project', 'src'), /regular file/);
    const git = args => require('node:child_process').execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    // Remove the fake metadata marker before initializing a real test repo.
    await fs.rm(path.join(root, '.git'), { recursive: true });
    git(['init']);
    assert.equal((await repositoryInfo('project')).available, true, 'local repository needs no GitHub remote');
    git(['add', 'hello.txt']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial']);
    await fs.writeFile(path.join(root, 'hello.txt'), 'Modified');
    assert.equal((await gitStatus('project')).connected, false);
    git(['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const firstRead = gitStatus('project');
    assert.equal(gitStatus('project'), firstRead, 'concurrent status requests share one pending read');
    assert.equal((await firstRead).connected, true);
    assert.ok((await gitStatus('project')).modified.includes('hello.txt'));
    git(['add', 'hello.txt']);
    assert.ok((await gitStatus('project')).modified.includes('hello.txt'), 'staged modifications included');
    git(['remote', 'set-url', 'origin', 'git@github.com:example/project.git']);
    assert.equal((await gitStatus('project')).connected, true, 'SSH remote recognized');
    git(['remote', 'set-url', 'origin', 'https://github.com.evil.test/example/project.git']);
    assert.equal((await gitStatus('project')).connected, false, 'lookalike hosts rejected');

  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
