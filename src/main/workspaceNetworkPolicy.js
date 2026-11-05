'use strict';
// Workspace Write networking tiers (code-owned ownership in the main process).
//
//   * standard_outbound — DEFAULT. Ordinary outbound public internet access
//     (package registries, HTTPS endpoints, dependency downloads, public APIs,
//     DNS) inside the existing sandbox. Host loopback, private LAN, VPN and
//     other host-side IPv4 special-purpose addresses stay denied by kernel
//     packet filtering; no user consent dialog is required for this tier.
//   * trusted_development — separate, explicit elevation for workflows that
//     must also reach host-local, private LAN, VPN or authenticated local
//     services. Requires the existing consent dialog and OS-protected storage.
//   * isolated — explicit opt-out: no terminal internet access at all.
//
// Availability (resources, runtime prerequisites, sandbox containment) is
// verified the same way for every build, including normal production AppImages;
// build identity decides only whether the local pre-approval resource path is
// used. Nothing here can be enabled by renderer input, environment, argv or
// model output.
const STANDARD_OUTBOUND = Object.freeze({ version: 3, policy: 'standard_outbound' });
const TRUSTED = Object.freeze({ version: 3, policy: 'trusted_development' });
const ISOLATED = Object.freeze({ version: 3, policy: 'isolated' });
const enabledPolicies = ['standard_outbound', 'trusted_development', 'isolated'];
const outboundDisclosure = 'Standard outbound internet access permits Workspace Write commands — including package-dependency lifecycle scripts — to reach public package registries, ordinary HTTPS endpoints and public APIs, with normal DNS resolution, autonomously inside the existing workspace sandbox. Host loopback, private LAN, VPN and other host-side services remain blocked by kernel packet filtering; external IPv6 is unsupported. Downstream endpoints can be untrusted; treat downloaded packages with normal developer caution. You can switch to Isolated or grant elevated local access in Settings.';
const trustedDisclosure = 'Elevated networking additionally permits terminal access to host-local, private LAN, VPN and local development services, including authenticated endpoints using credentials available to the command, and removes the outgoing-destination restrictions of the standard tier. Dependency lifecycle scripts have this same authority. Filesystem and process restrictions remain, but do not prevent network-side effects. External IPv6 is unsupported. Workspace Write commands run autonomously inside the sandbox. Applies to all Workspace Write sessions.';
const isolatedDisclosure = 'Terminal internet access is disabled. Workspace commands can still operate on workspace files and locally installed dependencies.';

function normalize(value) {
  // Persisted receipts and decisions from earlier versions keep working.
  if (value?.version === 2 && value.policy === 'trusted_development') return TRUSTED;
  if (value?.version === 2 && value.policy === 'isolated') return ISOLATED;
  if (value?.version === 3 && enabledPolicies.includes(value.policy))
    return { version: 3, policy: value.policy };
  return STANDARD_OUTBOUND;
}function validate(value) {
  if (value?.version === 2 && value.policy === 'trusted_development')
    throw Object.assign(new Error('Invalid workspace networking policy.'), { code: 'WORKSPACE_NETWORK_POLICY_INVALID' });
  if (value?.version !== 3 || !enabledPolicies.includes(value.policy))
    throw Object.assign(new Error('Invalid workspace networking policy.'), { code: 'WORKSPACE_NETWORK_POLICY_INVALID' });
  return normalize(value);
}
function disclosureFor(policy) {
  return policy === 'trusted_development' ? trustedDisclosure
    : policy === 'isolated' ? isolatedDisclosure : outboundDisclosure;
}
function readiness() {
  const local = require('./localDevelopmentNetwork');
  const isLocal = local.active();
  const build = isLocal ? local.buildLabel() : 'Production';
  const buildKind = isLocal ? local.mode : 'production';
  try { require('./networkDependencies').resolveBundled(); }
  catch (error) {
    const friendly = error.code === 'NETWORK_RESOURCE_VALIDATION_FAILED'
      ? 'Pinned networking resources failed validation; rebuild with verified resources.' :
      isLocal && error.code === 'NETWORK_DEPENDENCIES_NOT_PACKAGED'
        ? 'Prepare the local networking resources first: npm run local:network:prepare.'
        : 'Networking resources or runtime prerequisites for this build are missing, unsupported or failed verification.';
    return { available: false, build, buildKind, localDevelopment: isLocal, resourcesAvailable: false,
      consentRequired: false, code: error.code, blockers: [error.message], message: friendly };
  }
  return { available: true, build, buildKind, localDevelopment: isLocal, resourcesAvailable: true,
    consentRequired: false, code: 'NETWORK_RESOURCES_READY', blockers: [],
    message: 'Standard outbound internet access is available for Workspace Write. Elevated private/host access can be enabled separately in Settings.' };
}
module.exports = { normalize, validate, readiness, disclosureFor, disclosures: Object.freeze({
  standard_outbound: outboundDisclosure, trusted_development: trustedDisclosure, isolated: isolatedDisclosure }) };

