'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

// Main-process facts, never supplied by model/renderer arguments. This describes
// the existing executor's selected profile; availability does not guarantee that
// the OS permits namespace creation. Execution still fails closed itself.
async function getWorkspaceSandboxProfile({ workspaceRoot, uncontained }) {
  if (!workspaceRoot || uncontained || process.platform !== 'linux')
    return { bwrapAvailable: false, netUnshared: false, profile: null };
  let bwrapAvailable = false;
  // Match the workspace executor's restricted environment, not the ambient
  // host PATH (which may include user or workspace executables).
  for (const directory of '/usr/local/bin:/usr/bin:/bin'.split(path.delimiter)) {
    try {
      const candidate = path.resolve(directory || '.', 'bwrap');
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) { bwrapAvailable = true; break; }
    } catch { /* Try the next PATH directory. */ }
  }
  return { bwrapAvailable, netUnshared: true, profile: 'bwrap_workspace' };
}
module.exports = { getWorkspaceSandboxProfile };
