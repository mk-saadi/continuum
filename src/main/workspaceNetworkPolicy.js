'use strict';
const isolated = Object.freeze({ version: 2, policy: 'isolated' });
const trusted = Object.freeze({ version: 2, policy: 'trusted_development' });
const disclosure = 'Trusted Development permits terminal internet access and may reach host-local, private LAN, VPN and local development services, including authenticated endpoints using credentials available to the command. Dependency lifecycle scripts have this same network authority. Filesystem and process restrictions remain, but do not prevent network-side effects. External IPv6 is unsupported; host loopback aliases remain transport-restricted. Package installation still requires command authorization. This applies to all Workspace Write sessions.';
function normalize(value) {
  return value?.version === 2 && value.policy === trusted.policy ? trusted : isolated;
}
function validate(value) {
  if (value?.version !== 2 || !['isolated', 'trusted_development'].includes(value.policy))
    throw Object.assign(new Error('Invalid workspace networking policy.'), { code: 'WORKSPACE_NETWORK_POLICY_INVALID' });
  return normalize(value);
}
function readiness() {
  const blockers = ['Pinned networking resources, licenses/source obligations and supported Linux runtime prerequisites are not release-qualified.',
    'Actual AppImage/deb networking, resource containment and lifecycle acceptance is incomplete.'];
  try { require('./networkDependencies').resolveBundled(); }
  catch (error) { blockers.unshift(error.message); }
  // Deliberate release gate: a valid manifest alone is not runtime qualification.
  return { available: false, code: 'WORKSPACE_NETWORK_NOT_READY', blockers };
}
module.exports = { normalize, validate, readiness, disclosure };
