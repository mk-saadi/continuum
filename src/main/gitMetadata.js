'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
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
module.exports = { resolveGitMetadata, assertWritable, MESSAGE };
