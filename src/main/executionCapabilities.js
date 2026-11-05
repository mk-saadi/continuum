'use strict';
const fs = require('node:fs');
const path = require('node:path');
function executable(name, search = process.env.PATH || '') {
  return search.split(path.delimiter).some(dir => {
    if (!path.isAbsolute(dir)) return false;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  });
}
function networkState() {
  try {
    const policy = require('./workspaceNetworkPolicy');
    const selected = policy.normalize(require('./configStore').getConfig().workspaceNetwork).policy;
    if (selected === 'isolated') return { operational: false, selected, code: 'NETWORK_ISOLATED',
      description: 'disabled (Isolated selected). No terminal internet access. Downloads cannot work; use locally available dependencies only. Do not retry unchanged network-dependent operations.' };
    const ready = policy.readiness();
    if (!ready.available) return { operational: false, selected, code: ready.code,
      description: `unavailable (${ready.code}): ${ready.message || ready.blockers.join(' ')}` };
    return { operational: true, selected, code: ready.code,
      description: selected === 'trusted_development'
        ? 'Elevated networking: internet-enabled terminal; package downloads supported; may reach host/private IPv4 services; external IPv6 unavailable. Filesystem/process restrictions remain. Authenticated development previews supported; runtime containment checked on startup.' :
        'Standard outbound internet: enabled by default in Workspace Write; package installs, dependency downloads and public HTTPS/API endpoints work inside the sandbox. Host loopback and private LAN remain blocked; external IPv6 unavailable. Filesystem/process restrictions remain. Authenticated development previews supported; runtime containment checked on startup.' };
  } catch (error) { return { operational: false, code: 'NETWORK_STATUS_UNAVAILABLE', description: 'unavailable: network status could not be read. Do not assume package downloads will work.' }; }
}
function manifest(mode, cwd) {
  const host = mode === 'full_access';
  const sandbox = !host && ['workspace_write', 'ask_approval'].includes(mode) && !!cwd;
  const network = sandbox ? mode === 'workspace_write' ? networkState() : { operational: false, selected: 'standard_outbound', code: 'NETWORK_MODE_NOT_AUTHORIZED', description: 'managed networking applies to Workspace Write only. Downloads are unavailable for the supervised shell; use local dependencies only.' } : null;
  const profile = host ? 'Host' : sandbox ? 'Workspace sandbox' : mode === 'ask_approval' ? 'Host after approval' : 'No executable shell';
  return { profile, sandboxed: sandbox, shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', cwd: cwd || null,
    home: sandbox ? 'isolated' : process.env.HOME || process.env.USERPROFILE ? 'available' : 'unavailable',
    runtimes: Object.fromEntries(['node', 'npm', 'python3', 'git'].map(name => [name, host ? executable(name) ? 'available' : 'unavailable' : 'unknown'])),
    hostNvmInitialization: sandbox ? 'unavailable' : 'unknown', network: sandbox ? network.description : 'unknown (normal OS policy)', networkState: network,
    temporaryFiles: sandbox ? 'workspace scratch; host /tmp not shared' : 'inherited host environment',
    unixSockets: sandbox ? 'unavailable' : 'unknown (normal OS policy)',
    display: sandbox ? 'unavailable' : process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? 'unknown (configured, not verified)' : 'unavailable',
    developmentPreviews: network?.operational ? 'authenticated preview available after bounded server startup' : 'unavailable',
    graphicalTests: sandbox ? 'unavailable' : 'unknown',
    packages: sandbox ? `${mode === 'workspace_write' ? 'autonomous inside sandbox' : 'command approval required'}; ${network.operational ? 'downloads supported' : 'local dependencies only'}; no host fallback` : 'normal permission policy' };
}
function section(mode, cwd) {
  const m = manifest(mode, cwd);
  const runtime = m.sandboxed ? 'node/npm/python3/git unknown' : Object.entries(m.runtimes).map(([k,v]) => `${k} ${v}`).join(',');
  return `[COMMAND ENVIRONMENT] ${m.profile}; ${m.shell}; cwd=${m.cwd}; HOME ${m.home}; ${runtime}; NVM ${m.hostNvmInitialization}; network ${m.network}; tmp ${m.sandboxed ? 'isolated' : 'host'}; Unix/X11/GUI ${m.sandboxed ? 'unavailable' : 'OS policy/display unverified'}; packages ${m.packages}. No Bash syntax. Run tests directly.${require('./workspaceGit').section(mode, cwd)}`;
}

const displayFailure = result => /(?:Missing X server or \$DISPLAY|cannot open display|Unable to open X display|Failed to connect to (?:the )?X server|The platform failed to initialize)/i.test(`${result?.stderr || ''}\n${result?.stdout || ''}`);
const failures = new Map();
function failureKey(args, runId, revision) { return JSON.stringify([runId, revision, args.cwd || '.', args.command]); }
function remember(args, result, sandbox, runId, revision) {
  if (!sandbox || !runId || result.testEvidence?.complete || !displayFailure(result)) return;
  failures.set(failureKey(args, runId, revision), { command: args.command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  while (failures.size > 128) failures.delete(failures.keys().next().value);
}
function preflight(args, sandbox, runId, revision) {
  if (!sandbox) return null;
  // Only a direct known executable invocation, or an explicit requirement.
  // Arbitrary shell text mentioning these programs is not classified.
  const previousEvidence = runId ? failures.get(failureKey(args, runId, revision)) : null;
  const directDisplay = /^\s*(?:\/usr\/bin\/)?(?:Xvfb|xvfb-run)(?:\s|$)/.test(args.command);
  if (args.required_capability !== 'x11_display' && !directDisplay && !previousEvidence) return null;
  return { success: false, status: 'infrastructure_unavailable', executionStatus: 'infrastructure_unavailable', verificationState: 'inconclusive', verificationStatus: 'inconclusive',
    code: 'EXECUTION_CAPABILITY_UNAVAILABLE', requiredCapability: 'x11_display', executionProfile: 'Workspace sandbox',
    ...(previousEvidence ? { previousEvidence, repeatedCapabilityFailure: true } : {}),
    operation_executed: false, exitCode: null, command: args.command, stdout: '', stderr: '',
    reason: 'X11 display sockets are unavailable in this sandbox. Operation was not executed. Use non-graphical verification or ask the user to explicitly choose an appropriate mode.' };
}
module.exports = { networkState, manifest, section, preflight, displayFailure, remember };
