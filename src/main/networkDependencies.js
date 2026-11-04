'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function unavailable(detail) { throw Object.assign(new Error(detail), { code: 'NETWORK_DEPENDENCIES_NOT_PACKAGED' }); }
function resolveBundledImpl() {
  const { app } = require('electron');
  if (!app.isPackaged || process.platform !== 'linux' || process.arch !== 'x64') unavailable('No qualified packaged network resource set (only Linux x64 transport has been tested).');
  const root = path.join(process.resourcesPath, 'workspace-network');
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) unavailable('The release has no pinned networking resource manifest.');
  if (fs.realpathSync(root) !== root || fs.realpathSync(manifestPath) !== manifestPath || !fs.statSync(manifestPath).isFile()) unavailable('Network resource manifest path is not a regular trusted resource.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { unavailable('Invalid network resource manifest.'); }
  const files = ['networkPreviewBridge.py', 'networkExecutionWorker.py', 'experimental/network_owner.py', 'workspaceNetworkAddressPolicy.json', `${process.arch}/slirp4netns`];
  if (!manifest || manifest.version !== 1 || !manifest.sha256 || typeof manifest.sha256 !== 'object' || Array.isArray(manifest.sha256)) unavailable('Unsupported network resource manifest.');
  for (const relative of files) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile() ||
        createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') !== manifest.sha256?.[relative]) unavailable('Missing or modified pinned network resource.');
  }
  const helper = path.join(root, `${process.arch}/slirp4netns`);
  try { fs.accessSync(helper, fs.constants.X_OK); }
  catch { unavailable('Pinned network helper is not executable.'); }
  const elf = fs.readFileSync(helper);
  if (elf.length < 64 || elf.subarray(0, 4).toString('hex') !== '7f454c46' ||
      elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 62) unavailable('Network helper must be a Linux x86-64 ELF.');
  // Presence alone cannot establish version compatibility or runtime readiness.
  require('./networkRuntimePrerequisites').assertVersions();
  return { python: '/usr/bin/python3', helper: path.join(root, `${process.arch}/slirp4netns`), worker: path.join(root, 'networkExecutionWorker.py') };
}
function resolveBundled() {
  try { return resolveBundledImpl(); }
  catch (error) {
    if (error.code?.startsWith('NETWORK_')) throw error;
    unavailable('Networking resources could not be read or verified.');
  }
}
module.exports = { resolveBundled };
