'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const PREVIEW_LIMIT = 512 * 1024;

async function targetFor(projectId, relativePath = '.') {
  const project = require('./projectManager').getProject(projectId);
  if (!project.root_path) throw new Error('Choose a workspace folder in project settings to browse files.');
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('A workspace-relative path is required.');
  return require('./toolPermissions').workspacePath(project.root_path, relativePath);
}

async function listDirectory(projectId, relativePath = '.') {
  const target = await targetFor(projectId, relativePath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = entries.filter(entry => entry.name !== '.git').map(entry => ({
    name: entry.name,
    path: path.posix.join(relativePath === '.' ? '' : relativePath, entry.name),
    directory: entry.isDirectory(),
    symlink: entry.isSymbolicLink(),
  })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { items: items.slice(0, 2000), truncated: items.length > 2000 };
}

// Bounded filename/path search. Never follow directory symlinks or enter
// repository metadata, dependencies, or generated build trees.
async function searchFiles(projectId, query) {
  if (typeof query !== 'string' || query.length > 256) throw new Error('Enter a file name up to 256 characters.');
  const needle = query.trim().toLowerCase();
  if (!needle) return { items: [], truncated: false };
  await targetFor(projectId);
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__']);
  const pending = ['.'];
  const items = [];
  let scanned = 0;
  let visited = 0;
  let truncated = false;
  search: while (pending.length) {
    if (++visited > 2000) { truncated = true; break; }
    const directory = pending.shift();
    let handle;
    try { handle = await fs.opendir(await targetFor(projectId, directory)); }
    catch (error) { if (directory === '.') throw error; continue; }
    for await (const entry of handle) {
      if (++scanned > 20000) { truncated = true; break search; }
      if (entry.isSymbolicLink()) continue;
      const relative = path.posix.join(directory === '.' ? '' : directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) pending.push(relative);
      } else if (entry.isFile() && relative.toLowerCase().includes(needle)) {
        items.push({ name: entry.name, path: relative });
        if (items.length >= 100) { truncated = true; break search; }
      }
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, truncated };
}

async function readFile(projectId, relativePath) {
  const target = await targetFor(projectId, relativePath);
  // Opening nonblocking avoids hanging on named pipes and other special files.
  const handle = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Select a regular file to preview.');
    const extension = path.extname(target).toLowerCase();
    const kind = /\.(png|jpe?g|webp|gif|avif|bmp|ico)$/.test(extension) ? 'image'
      : /\.(mp4|webm|mov|mkv|avi|m4v|ogv|ogg|mpeg|mpg|3gp|3g2|wmv|flv|vob)$/.test(extension) ? 'video' : null;
    if (kind) return { kind, src: 'local://media/' + encodeURIComponent(target), size: stat.size };
    if (/\.(pdf|zip|gz|7z|rar|docx?|xlsx?|pptx?|exe|dll|so|woff2?|ttf|otf|gguf)$/.test(extension))
      return { binary: true, size: stat.size };
    const buffer = Buffer.alloc(Math.min(stat.size, PREVIEW_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { binary: true, size: stat.size };
    return { content: bytes.toString('utf8'), size: stat.size, truncated: stat.size > PREVIEW_LIMIT };
  } finally { await handle.close(); }
}
// User-initiated edits only; reject partial/binary previews and stale contents.
async function writeFile(projectId, relativePath, content, expectedContent) {
  if (typeof content !== 'string' || typeof expectedContent !== 'string' || Buffer.byteLength(content) > PREVIEW_LIMIT)
    throw new Error('Editing is limited to text files up to 512 KB.');
  const target = await targetFor(projectId, relativePath);
  return require('./tools/fileMutationQueue').withFileMutationQueue(target, async () => {
  const handle = await fs.open(target, require('node:fs').constants.O_RDWR | require('node:fs').constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PREVIEW_LIMIT) throw new Error('Only complete text files up to 512 KB can be edited.');
    const bytes = await handle.readFile();
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('This file is not editable UTF-8 text.');
    if (bytes.toString('utf8') !== expectedContent) throw new Error('The file changed on disk. Copy your edits, then refresh before saving.');
    const output = Buffer.from(content);
    let offset = 0;
    while (offset < output.length) {
      const { bytesWritten } = await handle.write(output, offset, output.length - offset, offset);
      offset += bytesWritten;
    }
    await handle.truncate(output.length);
    return { saved: true };
  } finally { await handle.close(); }
  });
}
// UI reads only: never fetch, authenticate, or follow a parent repository.
async function readGitStatus(projectId) {
  const root = await targetFor(projectId);
  const repo = require('./workspaceGit').repository(root);
  if (repo.state !== 'detected') return { connected: false, modified: [] };
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_DIR: repo.gitdir, GIT_WORK_TREE: root, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = async args => (await execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  try {
    const remotes = await git(['remote', '-v']);
    const connected = remotes.split('\n').some(line => {
      const remote = line.split('\t')[1]?.split(' ')[0];
      if (!remote) return false;
      if (/^(?:[^@/\s]+@)?github\.com:[^/\s]+\/[^\s]+$/i.test(remote)) return true;
      try { const url = new URL(remote); return ['https:', 'ssh:', 'git:'].includes(url.protocol) && url.hostname.toLowerCase() === 'github.com'; } catch { return false; }
    });
    if (!connected) return { connected: false, modified: [] };
    const entries = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'])).split('\0');
    const modified = [];
    for (let i = 0; i < entries.length; i++) {
      const code = entries[i].slice(0, 2);
      const file = entries[i].slice(3);
      if (file && code.includes('M')) modified.push(file);
      if (/[RC]/.test(code)) i++; // NUL status lists the rename/copy source separately.
    }
    return { connected: true, modified };
  } catch { return { connected: false, modified: [] }; }
}
// Concurrent tabs share the same pending read; settled results are never retained.
const statusReads = new Map();
function gitStatus(projectId) {
  if (statusReads.has(projectId)) return statusReads.get(projectId);
  const pending = readGitStatus(projectId).finally(() => statusReads.delete(projectId));
  statusReads.set(projectId, pending);
  return pending;
}
async function repositoryInfo(projectId) {
  const root = await targetFor(projectId);
  return { available: require('./workspaceGit').repository(root).state === 'detected' };
}
async function resolvePreviewFile(projectId, href) {
  if (typeof href !== 'string' || !href || href.includes('\0')) return null;
  const root = await targetFor(projectId);
  let requested;
  try { requested = decodeURIComponent(href); } catch { requested = href; }
  if (requested.startsWith('file:')) {
    try { requested = require('node:url').fileURLToPath(requested); } catch { return null; }
  }
  const relativePath = path.relative(root, path.resolve(root, requested));
  try {
    const target = await targetFor(projectId, relativePath);
    if (!(await fs.stat(target)).isFile()) return null;
    return { path: relativePath.split(path.sep).join('/') };
  } catch { return null; }
}
async function revealFile(projectId, relativePath) {
  const target = await targetFor(projectId, relativePath);
  if (!(await fs.stat(target)).isFile()) throw new Error('Select a regular file.');
  require('electron').shell.showItemInFolder(target);
}
module.exports = { searchFiles, writeFile, resolvePreviewFile, revealFile, listDirectory, readFile, gitStatus, repositoryInfo };
