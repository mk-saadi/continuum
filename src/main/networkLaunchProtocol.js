'use strict';
// Capability identity stays in the main process. Serialized/model-supplied
// objects cannot authorize namespace sharing. Only trusted service code calls
// issue; a consumed permit is scoped to one exact verified invocation.
const permits = new WeakMap();
const BOOTSTRAP = "import os,sys\nfor n in os.listdir('/proc/self/fd'):\n f=int(n)\n if f>2:\n  try: os.close(f)\n  except OSError: pass\nos.execvpe(sys.argv[1],sys.argv[1:],os.environ)\n";
const PREFIX = Object.freeze(['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL']);
function issue({ context, workspace, cwd, command, resolver, validate }) {
  const identity = require('./networkExecution').trustedIdentity(context, workspace);
  validate();
  const permit = Object.freeze({});
  permits.set(permit, { context, identity, workspace, cwd, command, resolver, validate, expires: Date.now() + 5000 });
  return permit;
}
function consume(permit, scope) {
  const facts = permit && permits.get(permit);
  permits.delete(permit);
  if (!facts || facts.expires < Date.now() || ['workspace', 'cwd', 'command'].some(k => facts[k] !== scope[k]))
    throw new Error('Execution blocked: Invalid network launch authority.');
  facts.validate();
  const current = require('./networkExecution').trustedIdentity(facts.context, facts.workspace);
  if (current.revision !== facts.identity.revision || current.sessionId !== facts.identity.sessionId)
    throw new Error('Execution blocked: Network launch authority was revoked.');
  return facts;
}
module.exports = { issue, consume, BOOTSTRAP, PREFIX };
