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

async function readFile(projectId, relativePath) {
  const target = await targetFor(projectId, relativePath);
  // Opening nonblocking avoids hanging on named pipes and other special files.
  const handle = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Select a regular file to preview.');
    const buffer = Buffer.alloc(Math.min(stat.size, PREVIEW_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { binary: true, size: stat.size };
    return { content: bytes.toString('utf8'), size: stat.size, truncated: stat.size > PREVIEW_LIMIT };
  } finally { await handle.close(); }
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
module.exports = { listDirectory, readFile, gitStatus, repositoryInfo };
