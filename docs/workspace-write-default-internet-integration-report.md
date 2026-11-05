# Workspace Write default internet integration report

Date: 2026-11-05
Scope: make standard outbound internet access a default, supported Workspace Write capability in development and production builds, while keeping private/host networking a separately consented boundary.

## Root cause of the previous production restriction

The pre-change stack (`git` state before this task) enabled terminal networking through a single
opt-in tier, `trusted_development`:

- `src/main/workspaceNetworkPolicy.js` exposed exactly two policies, `isolated` (default) and
  `trusted_development`, and its `readiness()` returned
  `code: 'NETWORK_RELEASE_APPROVAL_PENDING'` with `available: false` for every build that was not
  a code-owned local development build (`source` or `packaged-local`).
- `src/main/localDevelopmentNetwork.js` made eligibility build-identity based: unpackaged source
  launches and the `dist:local` developer AppImage (whose packaged `main` is
  `src/main/localDevelopmentEntry.js`) were eligible; a normal production AppImage was not.
- `src/main/configStore.js` required a native consent dialog plus an OS-protected storage receipt
  before the tier could be stored, and `src/main/executionCapabilities.js` reported
  "downloads require separately consented operational Trusted Development networking".
- Normal production packaging (`npm run dist`) shipped no networking resources at all:
  `networkDependencies.resolveBundled()` threw `NETWORK_DEPENDENCIES_NOT_PACKAGED` because the
  verified `workspace-network` payload only existed under `.continuum-local/resources`
  (git-ignored local material) or in separate staging fixtures.

The restriction was therefore threefold: a code-owned release-approval gate in `readiness()`, a
build-identity gate in the packaging, and a hard-coded single high-trust tier. None of it was
technically required for ordinary outbound access: the sandbox already had a stricter, fully
implemented ruleset (`public_only_fixture` in `experimental/network_owner.py`) that permits public
IPv4 egress while rejecting loopback/private/special-purpose destinations, and the same pinned
helper and integrity pipeline serves both rulesets.

## Architecture changes (no new networking stack)

The existing stack is reused end to end: `bwrap_workspace` sandbox, `networkExecution` service,
`networkExecutionWorker.py`, `experimental/network_owner.py` (user namespace + pinned `slirp4netns`
+ nftables), preview bridge, launch permits, and the resource manifest verification. The changes
are:

1. **Three-tier policy with a new default** (`src/main/workspaceNetworkPolicy.js`)
   - `standard_outbound` (version 3, **default**): ordinary outbound internet inside the existing
     sandbox. Decided by code; no consent dialog, no Trusted Development.
   - `trusted_development` (kept, renamed in the UI to elevated networking): additionally permits
     host-local, private LAN, VPN and authenticated local services by using the permissive nft
     ruleset. Still requires the native consent dialog and OS-protected storage receipt.
   - `isolated` (kept as explicit opt-out): no terminal internet access.
   - Version 2 persisted decisions keep their meaning across the upgrade (a v2
     `trusted_development` receipt still activates the elevated tier; a v2 `isolated` choice stays
     isolated; anything else maps to the new default).
   - `readiness()` now verifies the same resources and runtime prerequisites for every build,
     including production, and reports plain resource/prerequisite failures instead of a release
     approval blocker.
2. **Tier-aware transport** (`src/main/networkExecution.js`, `networkExecutionWorker.py`,
   `experimental/network_owner.py`)
   - The main process passes the selected tier in the trusted `start` envelope; the worker accepts
     only `standard_outbound` or `trusted_development` and fails closed otherwise. The owner
     installs either the public-only ruleset (default: host loopback, private LAN, VPN and all
     IANA special-purpose IPv4 rejected; external IPv6 rejected) or the permissive elevated
     ruleset.
   - The owner key includes the tier and a selected-tier change replaces (closes) a live owner
     instead of letting it keep filtering under stale authority; the periodic revalidation now
     rejects a tier mismatch (`NETWORK_POLICY_REVOKED`).
3. **Command routing** (`src/main/tools/agentTools.js`)
   - Workspace Write commands route through the networked transport whenever the tier is
     operational (standard outbound by default), falling back to the offline sandbox with an
     actionable stderr hint when resources are unavailable or Isolated is selected.
4. **Production packaging** (`electron-builder.release.cjs`, `package.json`)
   - `npm run dist` now uses `electron-builder.release.cjs`, which stages the verified networking
     payload (`manifest.json`, the four source payloads, `x64/slirp4netns`) outside ASAR at
     `process.resourcesPath/workspace-network`, verifies the payload against `src/main` and the
     independent helper pin before packing (`beforePack`) and inside the packed resources after
     packing (`afterPack`). No review archive, no `.continuum-local` path and no local-only entry
     is shipped or required. Integrity verification was not weakened: runtime verification
     (`networkDependencies.resolveBundled`) is unchanged and runs on every owner startup.
   - `dist:local` and the B2G4 staging fixtures are unchanged.
5. **User experience** (`src/components/WorkspaceNetworkSettings.jsx`, disclosures)
   - Default "Standard outbound internet (default)"; "Isolated — no terminal internet access";
     "Elevated networking — may also reach host and private services" (disabled until resources
     verify and OS-protected storage is available). The consent dialog is only shown when
     selecting the elevated tier. All "networking release approval pending" strings were removed
     (`localDevelopmentNetwork.buildLabel`, local entry banner, readiness messages).

## Files modified

- `src/main/workspaceNetworkPolicy.js` — three tiers, versioned migration, per-tier disclosures, build-agnostic readiness.
- `src/main/configStore.js` — tier-aware decision storage/receipt handling, elevated-only consent, status fields (`consentRequired`, `operational`, per-tier disclosure).
- `src/main/networkExecution.js` — tier threading to the backend, tier in the owner key, owner replacement on tier change, `validatePolicy(ownerPolicy)`.
- `src/main/networkExecutionWorker.py` — accepts and forwards the main-process-selected tier; fails closed on anything else.
- `src/main/experimental/network_owner.py` — `standard_outbound` accepted as a production ruleset alias of the public-only rules.
- `src/main/executionCapabilities.js` — network state/descriptions for all tiers; Ask-for-Approval wording updated.
- `src/main/tools/agentTools.js` — routing condition, stderr guidance, tool description.
- `src/main/localDevelopmentNetwork.js`, `src/main/localDevelopmentEntry.js` — removed misleading "release approval pending" labels.
- `src/components/WorkspaceNetworkSettings.jsx` — redesigned settings UI.
- `package.json` — `dist` uses `electron-builder.release.cjs`.
- `electron-builder.release.cjs` (new), `scripts/verify-release-networking.cjs` (new) — production packaging + runtime-equivalent resource verification.
- `.continuum-local/resources` — regenerated pinned resources (Python payloads changed, manifest re-assembled through `scripts/assemble-workspace-network.cjs`; helper and review-archive pins unchanged; previous tree preserved as `.continuum-local/resources-previous-*`).
- Tests: `tests/workspaceNetworkDefaultInternet.test.cjs` (new), `tests/workspaceNetworkProductionAcceptance.ui.cjs` (new), `tests/workspaceNetworkSourceAcceptance.ui.cjs` (new), `tests/b2dNetworkExecution.test.cjs`, `tests/b2g2Trust.test.cjs`, `tests/b2g2Settings.ui.cjs` updated to the new tier model.

## Final networking policy

| Tier | Default | Consent | Destinations | Ruleset |
|---|---|---|---|---|
| `standard_outbound` | yes (Workspace Write, all builds) | none | public IPv4 registries/endpoints, DNS via synthetic resolver | nft: reject IANA special-purpose IPv4 (loopback, private, CGNAT, link-local, multicast…), reject all IPv6, allow public IPv4 |
| `trusted_development` (elevated) | no | native dialog + OS-protected receipt | additionally host-local, private LAN, VPN | nft: allow IPv4 (loopback aliases remain transport-restricted), reject IPv6 |
| `isolated` | no | none (explicit opt-out) | none (`--unshare-net`) | offline sandbox unchanged |

Applies to Workspace Write only; Ask for Approval, Read Only, Casual Chat and Full Access
semantics are unchanged. Filesystem containment, process isolation, cgroup limits, command
ownership/cancellation, launch-permit single use, and resource/helper integrity verification are
unchanged and re-verified below.

## Security boundaries retained

- Workspace filesystem containment, host filesystem protection (sentinel checks), process/PID/IPC
  namespace isolation, `RLIMIT`/cgroup bounds (1G memory, 0 swap, 128 tasks, 200% CPU, group OOM),
  command ownership and cancellation, single-use launch permits, stale-grant rejection.
- Standard outbound never grants host loopback or private LAN: the kernel ruleset rejects them
  (verified with real nft counters), and elevation is a separate, consented selection that cannot
  be reached by ordinary commands.
- Production builds still verify bundled payloads against the manifest, the independent helper
  pin, ELF shape, executable bit, runtime prerequisite versions, and fail closed otherwise.
- Accepted residual risks (documented, not eliminated): malicious packages and dependency
  lifecycle scripts can use the outbound channel (data exfiltration, downloads of hostile
  content, contacting attacker-controlled endpoints); compromised upstream endpoints can serve
  malicious payloads. These are inherent to normal development networking and are accepted by this
  design; they are not mitigated by sandboxing and are not hidden from the user (disclosure text
  in Settings states them).

## Test results and exact commands

Final consolidated run (all green):

- `node --test tests/workspaceNetworkDefaultInternet.test.cjs tests/b2dNetworkExecution.test.cjs tests/b2eDependencies.test.cjs tests/b2g2Trust.test.cjs tests/b2g2Packaged.test.cjs tests/b2g3Packaging.test.cjs tests/b2g3Runtime.test.cjs tests/b2g4Assembly.test.cjs tests/b2g5Qualification.test.cjs tests/localDevelopmentNetwork.test.cjs tests/workspaceWritePhase2.test.cjs tests/b2fPreviews.test.cjs tests/b2fGateway.test.cjs` → **58 pass / 0 fail** (of 70 reported tests; 12 skipped real-kernel/helper-gated). Covers: default tier semantics, v2 migration, readiness honesty (no release-approval strings), nft rulesets deny loopback/private/VPN and allow public egress, service tier threading + owner replacement on tier change + Isolated refusal, routing fallback wording, previews, gateways, launch-permit forgery, assembly/qualification boundaries.
- `B2D_HELPER=$PWD/.continuum-local/resources/workspace-network/x64/slirp4netns node --test tests/b2dNetworkExecution.test.cjs` → **5/5 pass**, including the full real transport: worker → owner → pinned helper → public HTTPS 200, elevated host-service reachability, DNS, IPv6/nft denials, background dev server, scratch isolation, session/workspace revocation.
- `B2C_HELPER=$PWD/.continuum-local/resources/workspace-network/x64/slirp4netns python3 tests/b2cNetworkOwner.test.py` → **5/5 OK** with real-kernel evidence: `public_https: 200`, `dns: true`, `private_host` nft rejection with counter increments, `host_loopback` guest/host separation, `external_ipv6` all denied, namespace FDs unavailable to guests, helper hardening, lifecycle/revocation/cancel/shutdown.
- `python3 tests/b2ePolicy.test.py` → 4/4 OK.
- `node scripts/verify-release-networking.cjs release/linux-unpacked/resources` → no blockers; packaged payloads byte-identical to `src/main`, helper pin matched; every packaged main-process file byte-identical to the working tree.
- Isolation regression batch `node --test tests/u7ExecutionSecurity.test.cjs tests/commandExecutionReliability.test.cjs tests/permissionPolicy.test.cjs tests/toolPermissions.test.cjs tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/backgroundExecution.test.cjs tests/sandboxFilesystem.test.cjs tests/r5Execution.test.cjs` → 101 pass / 8 fail; all 8 reproduced on a baseline copy with this task's changes reverted (see below).

Pre-existing failures (not introduced by this task; reproduced on a baseline copy with this
task's changes reverted): the 8 failures above — `tests/u7ExecutionSecurity.test.cjs`
expectations of the removed package-publication approval prompt (`npm publish` marker test, git
remote approval message, sandbox env-key assertion, one 60 s IPC-invalidation timeout) plus one
cross-file interference case. They stem from uncommitted in-tree changes to
`src/main/toolApprovalPolicy.js`/`toolPermissions.js` that removed the package-operation approval
gate — consistent with this task's "no additional confirmation dialogs" direction — but their
expectations were not updated here because that approval-policy work is unrelated uncommitted
user work.

## Production packaging changes

- `npm run dist` → `npm run build && electron-builder --config electron-builder.release.cjs`.
- `extraResources` stages the verified `workspace-network` payload (≈2.4 MB helper + text
  payloads; no 124 MB review archive) outside ASAR.
- `beforePack` verifies the source resource set; `afterPack` re-verifies the packed resources.
- The packaged `main` remains `main.js`; no developer-only entry, no `.continuum-local` resource
  and no local-development identity is involved in production.

## Actual production AppImage acceptance evidence

Artifact: `release/Continuum-1.0.0.AppImage`
sha256 `14844194e84285f9da8b89d2a83b512d26fb626394650e3ae05fe3ea33f2c88a`
launched via Playwright `_electron.launch` from its FUSE mount
(`/tmp/.mount_ContinCLLsQB/resources`) with a disposable `--user-data-dir` and child-only
`HOME`/XDG directories (the user's primary profile untouched).

Harness and exact command: `node tests/workspaceNetworkProductionAcceptance.ui.cjs release/Continuum-1.0.0.AppImage`
— result `passed: true` (full JSON in `docs/workspace-write-production-acceptance-evidence.json`).

Recorded checks against the real packaged app:

| Check | Result |
|---|---|
| Production identity (`app.isPackaged`, FUSE mount, `--user-data-dir` honored) | pass |
| Bundled resources resolve + helper pin `dceac41d…b980` at `resources/workspace-network/x64/slirp4netns` | pass |
| Default tier `standard_outbound`, `available: true`, `consentRequired: false`, no release-approval strings | pass |
| DNS resolution (`getent hosts example.com`) | pass |
| Public HTTPS (`curl https://example.com` → `200`) | pass |
| `nft flush ruleset` denied inside sandbox | pass |
| External IPv6 request denied | pass |
| No inherited namespace handles (`net:`/`user:` FDs) | pass |
| Host home sentinel inaccessible | pass |
| Real host loopback listener unreachable from guest (with positive host-side control) | pass |
| Private LAN address (10.11.12.13) unreachable | pass |
| Real `npm install` (vite 6.4.3, `is-number@7.0.0`, lockfile) with lifecycle-script containment (`HOME=/sandbox-home`, cache under `/tmp/continuum-cache`) | pass |
| Project build command | pass |
| Persistent Vite dev server started as a background command | pass |
| Workspace chat UI navigation | pass |
| Authenticated preview: `ready`, credential-free fetch → `403` | pass |
| Stop/cancellation terminates the owned command; preview refuses afterwards; `service.active() === 0` | pass |
| Confirmation prompts for ordinary networking | 0 |
| Isolated opt-out revokes internet access; default tier restorable | pass |

## Local developer AppImage acceptance evidence

Artifact: `release-local/Continuum-1.0.0.AppImage`
sha256 `789d213647788d2d5a3e108c1cd83615facea54eb48495d10c16606531adc55a`
(`npm run dist:local`). The same full acceptance harness passed end to end
(`passed: true`, FUSE mount, local identity banner, identical check matrix).

## Source development acceptance evidence

Harness: `node tests/workspaceNetworkSourceAcceptance.ui.cjs` — starts the real Vite dev server
and the real Electron main process with `NODE_ENV=development` and
`CONTINUUM_NATIVE_TOOL_PROFILE=compact` (the exact environment `npm run dev` sets) and a
disposable profile. Result `passed: true`
(`docs/workspace-write-source-acceptance-evidence.json`): source build label
"Local development · source · NON-DISTRIBUTABLE", resources from `.continuum-local/resources`,
default outbound tier without consent, DNS, HTTPS 200, private LAN denied, real npm installs,
persistent dev server reachable from the sandbox, zero prompts.

## Remaining limitations

- External IPv6 is unsupported (rejected by ruleset), as before.
- Standard outbound cannot reach host loopback/private services by design; workflows needing them
  must use the elevated tier (one-time consent dialog) — e.g. developing against a database on
  the host.
- The historical B2G2–B2G6 UI harnesses pin old candidate artifacts and encode the old
  release-gate expectations; they fail fast on the artifact pin if run against new builds and were
  intentionally left as historical records. The new acceptance harnesses replace them for current
  verification.
- The pre-existing `u7ExecutionSecurity.test.cjs` failures described above belong to the
  uncommitted approval-policy work and need either updated expectations or a policy decision on
  `npm publish` specifically.
- DNS depends on the synthetic resolver (10.0.2.3) provided by the owner; commands must not
  replace it (the launch plan binds it read-only).

## Implemented / tested / real-AppImage-verified summary

- **Implemented (code, all builds):** three-tier policy with `standard_outbound` as the Workspace
  Write default; tier-aware worker/owner transport with fail-closed tier validation; owner
  replacement on tier change; production packaging of verified networking resources
  (`electron-builder.release.cjs` + runtime-equivalent `verify-release-networking.cjs`);
  redesigned Settings UI and disclosures; removal of every "networking release approval pending"
  surface; consent reserved for the elevated tier only.
- **Tested (deterministic + real-kernel):** 58/58 unit/deterministic networking tests; 5/5 full
  real-transport suite (B2D helper); 5/5 real-kernel owner suite (B2C) including public HTTPS,
  DNS, private/host-loopback rejection counters, namespace-handle denial and lifecycle; policy
  validation; release-resource verification; sandbox/isolation regression batch green except the
  documented pre-existing failures owned by unrelated uncommitted work.
- **Real-AppImage-verified:** production `npm run dist` AppImage (sha256
  `14844194…f2c88a`) and local developer `npm run dist:local` AppImage (sha256
  `789d2136…dc55a`) each passed the complete live acceptance battery — production identity and
  FUSE-mounted resource verification, default outbound with zero consent dialogs, real DNS and
  HTTPS, nft/IPv6/loopback/LAN denials, host-home inaccessibility, real npm installs with
  lifecycle containment, project build, persistent dev server, authenticated preview (403
  unauthenticated), cancellation with zero prompts, and Isolated opt-out. Source `npm run dev`
  environment passed the same battery in its dedicated harness.
