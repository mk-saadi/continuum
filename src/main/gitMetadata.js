'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const SHELL_HINT = 'Git metadata is read-only in the shell; use the git_* tools for this.';
const MESSAGE = 'Git metadata is read-only here; use the git_* tools';
// Resolve gitfiles relative to their containing directory, and commondir relative
// to gitdir. Do not invoke git or trust repository configuration for discovery.
function resolveGitMetadata(workspace) {
  const found = new Set();
  function metadata(marker) {
    const real = fs.realpathSync(marker);
    found.add(real);
    if (fs.statSync(real).isDirectory()) return;
    const match = fs.readFileSync(real, 'utf8').match(/^gitdir:\s*(.+)\s*$/);
    if (!match) throw new Error(`Invalid git metadata file: ${marker}`);
    const gitdir = fs.realpathSync(path.resolve(path.dirname(marker), match[1].trim()));
    found.add(gitdir);
    const common = path.join(gitdir, 'commondir');
    if (fs.existsSync(common)) found.add(fs.realpathSync(path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim())));
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.name === '.git') { metadata(p); continue; }
      if (entry.isDirectory()) walk(p);
    }
  }
  walk(fs.realpathSync(workspace));
  return [...found].sort((a, b) => a.length - b.length);
}
function assertWritable(workspace, target) {
  target = path.resolve(target);
  // Protect even a not-yet-created .git path and aliases through existing parents.
  let existing = target, suffix = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  const real = path.join(fs.realpathSync(existing), ...suffix);
  if (target.split(path.sep).includes('.git') || resolveGitMetadata(workspace).some(p => inside(p, real) || inside(real, p))) throw new Error(MESSAGE);
}
// Diagnose the failing path, never the shell command (which may invoke Git
// through an alias, script or interpreter). Require both facts on the same line.
function shellMetadataReadOnlyFailure(metadata, cwd, stderr) {
  const lines = String(stderr ?? '').split('\n').filter(line => /read-only file system/i.test(line));
  if (!lines.length) return false;
  for (const line of lines) {
    // Git sometimes emits absolute config paths without quoting spaces.
    // Match known roots directly before falling back to diagnostic tokens.
    for (const parent of metadata) {
      for (const spelling of [parent, path.relative(cwd, parent), './' + path.relative(cwd, parent)]) {
        if (!spelling) continue;
        let offset = line.indexOf(spelling);
        while (offset !== -1) {
          const before = offset ? line[offset - 1] : '';
          const after = line[offset + spelling.length] ?? '';
          if ((!before || /[\s'"`]/.test(before)) && (!after || /[\s/'"`:]/.test(after))) return true;
          offset = line.indexOf(spelling, offset + 1);
        }
      }
    }
    const paths = line.matchAll(/'([^']+)'|"([^"]+)"|`([^`]+)`|(\S+)/g);
    for (const match of paths) {
      const candidate = match[1] ?? match[2] ?? match[3] ?? match[4].replace(/[:,]+$/, '');
      if (!candidate.includes(path.sep) && candidate !== '.git') continue;
      let target = path.resolve(cwd, candidate), suffix = [];
      // index.lock and new refs do not exist; canonicalize their existing
      // ancestor to recognize metadata reached through a symlink as well.
      while (!fs.existsSync(target) && path.dirname(target) !== target) {
        suffix.unshift(path.basename(target)); target = path.dirname(target);
      }
      try { target = path.join(fs.realpathSync(target), ...suffix); } catch { continue; }
      if (metadata.some(parent => inside(parent, target))) return true;
    }
  }
  return false;
}
module.exports = { resolveGitMetadata, assertWritable, MESSAGE, SHELL_HINT, shellMetadataReadOnlyFailure };
