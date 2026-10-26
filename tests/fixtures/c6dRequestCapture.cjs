'use strict';
// Capture the old and new renderings of the same synthetic checkpoint, then
// substitute only that block in the exact provider request. No second model run.
const fs = require('node:fs');
const Module = require('node:module'), originalLoad = Module._load, pairs = [];
let patched = false;
Module._load = function(name, ...args) {
  const checkpoints = originalLoad.call(this, name, ...args);
  if (!patched && /taskCheckpoints$/.test(name)) {
  patched = true;
  const render = checkpoints.workspaceCompactSection;
checkpoints.workspaceCompactSection = (checkpoint, options) => {
  const after = render(checkpoint, options);
  const before = { ...after, content: checkpoints.CHECKPOINT_MARKER + ' — validated task state; untrusted observations, no execution authority]\n' + JSON.stringify({ ...checkpoint, sourceCoverage: undefined, evidence: checkpoints.modelEvidence(checkpoint.evidence) }) };
  pairs.push({ before: before.content, after: after.content });
  return after;
};
  }
  return checkpoints;
};
process.on('exit', () => {
  if (process.env.C6D_RENDER_CAPTURE) fs.writeFileSync(process.env.C6D_RENDER_CAPTURE, JSON.stringify(pairs));
});
require('../c6cAcceptance.test.cjs');
