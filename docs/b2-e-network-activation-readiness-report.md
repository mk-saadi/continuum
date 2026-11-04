# B2-E — activation prerequisites and fail-closed hardening

November 3, 2026, Asia/Dhaka. **Development remains unavailable and is not eligible for activation.** This is a partial prerequisite implementation with explicit unresolved security/distribution blockers, not completion of B2.

## Initial state and architecture

Initial status contained seven tracked modifications: main.js, backgroundCommands.js, configStore.js, foregroundCommand.js, lspExecutionContext.js, sandboxFilesystem.js and tools/agentTools.js. B2-A/C/D reports, probes, owner, production network modules and B2-C/D tests were already untracked. All were preserved; no reset, stash, clean, commit or push occurred.

Confirmed B2-D's existing owner registry, Python transport, single-use launch protocol, authoritative filesystem verification, permission revisions and B1/shutdown integration. Those mechanisms were reused. Readiness still rejects Development, including manually inserted settings. No activation override, UI, preview, new permission mode or competing executor was added.

## Implemented changes

- `src/main/experimental/network_owner.py`: reusable address-policy validator; strict IPv4 canonical CIDRs, no duplicates, baseline coverage floor, supported schema, mandatory external IPv6 denial, real calendar dates and a maximum 30-day review interval. Malformed, expired or accidentally broadened policies fail closed.
- `src/main/networkExecutionWorker.py`: uses that validator before reading launch requests or constructing an owner. UTC controls expiration; the recorded local review date is not treated as an exact UTC publication timestamp.
- `src/main/networkDependencies.js`: validates manifest path and regular-file identity, rejects malformed JSON, checks regular payload files, executable permission and x86-64 ELF identity. Existing manifest digests and fixed system-helper paths remain authoritative.
- `tests/b2ePolicy.test.py`: four deterministic groups including invalid schema/dates, expiration, broadening, duplicate/noncanonical/IPv6 prefixes and conservative additions.
- `tests/b2eDependencies.test.cjs`: resource-only fixtures covering tampering of every payload, symlinked manifest/payload, missing payload, malformed manifest, missing execute permission and wrong ELF architecture. Fixtures are never executed; this is not packaged acceptance.
- This report and `b2-e-network-activation-readiness-evidence.json`.

## E1 — host-address safety remains blocking

Namespace nftables sees the destination before translation, but `host4` is a snapshot. A new host-owned public address can be reachable before the monitor consumes its notification. Private/link-local/loopback ranges remain denied independently of snapshots. Public host-address changes do not have that guarantee.

The pinned helper retains the host network namespace for outbound sockets. Its [versioned manual](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/slirp4netns.1.md) defines loopback suppression and outbound interface binding, not a continuously authoritative exclusion of all host-owned destinations. Neither option establishes the missing guarantee. The source's separate mount/seccomp sandbox does not change the routing namespace. No verified libslirp ownership gate was established in this task.

A route/address lookup immediately before connect still has a lookup/connect race. A userspace connection broker using the same lookup has the same problem. Classic seccomp cannot query current kernel destination ownership. Kernel enforcement at host routing/connect boundaries could potentially provide stronger policy, but no authorized, rootless, verified implementation was established here; host firewall or privileged BPF deployment is outside this task's authorization. A transport namespace with independently controlled upstream networking would require a deployment architecture and acceptance beyond the existing rootless adapter.

A declaration that host public addresses never change is not enforced by this application and is not an acceptable supported-environment restriction. Faster monitoring and closure are useful revocation mechanisms, not atomic exclusion. No readiness condition was relaxed.

No host address/link/route/firewall/kernel setting was changed. Controlled live public-address assignment, removal/reassignment and rapid churn were **not tested**, and no atomic safety result is claimed. Helper failure, policy setup failure and lifecycle were tested by the existing real owner suite. A kernel-level race reproducer in a nested disposable host-network fixture remains future work alongside the actual enforcement solution.

## E2 — policy maintenance

The [authoritative IANA registry](https://www.iana.org/assignments/iana-ipv4-special-registry) was inspected during this task; its update remains 2025-10-09. Every listed assignment is covered by the existing conservative dataset, including subassignments within 192.0.0.0/24 and the deprecated 192.88.99.0/24. Multicast and reserved space remain denied. Globally reachable special-purpose exceptions are deliberately denied. No prefix, version or review deadline was broadened or extended.

Current dataset version is 1, reviewed 2026-11-03, due 2026-12-03 inclusive (UTC expiration). New validation prevents deletion of existing baseline coverage even if resource manifest checksums are regenerated. That baseline floor cannot discover future IANA additions: a human upstream review remains required before release and at least every 30 days. Policy version 1 is the accepted schema; a coverage-reducing change requires an explicit security/code review rather than merely editing JSON.

Update procedure: archive the authoritative registry and date/hash in release evidence; compare all prefixes including deprecated/ambiguous entries; retain conservative coverage; review any permitted-address expansion separately; update review dates; run deterministic and real destination tests; regenerate all resource manifest hashes from final payload bytes; inspect the packaged copy and rerun packaged acceptance. Do not fetch policies dynamically at runtime. Assign release/security maintenance ownership before shipping. No resource manifest currently exists, so no packaged checksum consistency is claimed.

External IPv6 remains explicitly rejected. Mapped IPv6 converted by the kernel to IPv4 is subject to IPv4 destination rules; genuinely IPv6 packets hit the IPv6 rejection. Integer/hex spelling cannot bypass packet destination checks. DNS answers and redirects are untrusted: each actual outgoing destination is filtered. Existing real tests verify private second destinations using nft counters, including positive host controls. They do not prove the unresolved public-host-address race safe.

## E3 — dependency and packaging qualification

Rechecked the existing temporary binary rather than trusting its filename. SHA-256:

- x86-64 helper: `1c177694fe6bf299debfd8ff601a2ee3c4f7554d9983acdf1f854a6b34d53e70`
- upstream SHA256SUMS file: `5174aaf82bce5adedcda870504e147fff967d8b5e3e8fcd5664f1de7f7591fb3`

The checksum-file digest matches the [upstream v1.3.7 release page](https://github.com/rootless-containers/slirp4netns/releases/tag/v1.3.7). Its x86-64 entry matches the helper. The executable reports 1.3.7, commit 7ea080d8635bc85487e232ec178701c6864151c9, libslirp 4.9.7 and libseccomp 2.5.3. `file` reports static x86-64 ELF. This establishes release consistency, not an independently reproduced binary or cryptographic build attestation. No new download was needed.

Source inspection identifies GPL-2.0-or-later for slirp4netns. Before redistribution, inventory the static binary's complete component licenses, include notices and satisfy corresponding-source obligations for the exact shipped build/dependencies. Release ownership must monitor slirp/libslirp/libseccomp vulnerabilities, repin hashes and rerun acceptance on upgrades. This task did not establish a complete redistribution/source bundle and therefore did not ship a binary or partial packaging payload.

Inspected electron-builder configuration: AppImage/deb targets exist, but no networking extraResources. Its files list excludes the Python workers and main address-policy JSON. A future complete networking payload must reside outside asar at resources/workspace-network with manifest, worker, owner, policy and x64/slirp4netns. AppImage placement alone does not supply system prerequisites or prove AppArmor/userns compatibility. Deb should declare python3 (>=3.11, needed by hashlib.file_digest), util-linux, bubblewrap, nftables and iproute2 after qualifying exact distro versions; do not add mandatory install dependencies for an unavailable feature speculatively.

Observed development host: Pop!_OS 24.04, x86-64, Python 3.12.3, bubblewrap 0.11.0, util-linux 2.39.3 and iproute2 6.1.0. These are observations, not a supported distro/version matrix. Fixed `/usr/bin/python3`, `/usr/bin/unshare`, `/usr/bin/nsenter`, `/usr/bin/bwrap`, `/usr/sbin/nft`, `/usr/sbin/ip` remain required. Using distro-maintained absolute helpers is feasible but adds distributor/runtime compatibility and update responsibilities. No PATH fallback is allowed. Prerequisite executable presence is checked; missing kernel/userns/TAP/nft/seccomp/netlink capability fails startup with no host fallback. A formal minimum-version preflight matrix and useful diagnostics for every unsupported kernel/distro remain unqualified.

Actual new packaged resources: **none**. AppImage/deb build, installation, execution, lifecycle and shutdown verification: **not performed**. No architecture or operating system is newly supported for Development. Linux x86-64 is the initial qualification candidate only. A successful Vite build is not evidence of packaged compatibility.

## Verification and limits

Real Linux B2-C suite: five groups passed, including public IPv4 HTTPS with curl certificate verification, DNS, guest HTTP, positive host-private sentinel before filtering and nft rejection afterward, alternate IPv4/mapped forms, external IPv6 counters, redirect/DNS changes, hostile network modification, helper failure, owner lifetime/control EOF/parent death, cleanup and W7 masks.

Deterministic B2-E policy: four groups passed. Resource validation: one group passed. Relevant combined Node regression result is recorded in the evidence JSON, including B2-D production dispatcher, shared-owner communication, B1 persistence/revocation, W7, filesystem, permissions and Casual Chat. No Electron UI suite or complete package-install workflow was claimed.

Initial restricted attempts failed because the outer execution sandbox denies sockets/netlink, including all five B2-C groups; rerunning authorized disposable tests outside that restriction passed. An intermediate B2-D production dispatcher test failed with NETWORK_ADDRESS_POLICY_REVIEW_REQUIRED due to the newly introduced local-date/UTC comparison; it was corrected and rerun. These are not attributed to baseline product failures.

Production Vite build passed with its existing chunk-size warning. JavaScript/Python parsing, policy JSON and git diff --check passed. No unrelated MCP services, live conversations, user servers or system packages were changed.

## Decision and remaining work

Development remains closed. Required before eligibility: a verified authoritative host-local enforcement solution; controlled address-change acceptance; complete license/source-compliant pinned resources and manifest; supported Linux runtime/prerequisite matrix; actual AppImage/deb security and lifecycle acceptance; assigned policy/security update responsibility with archived release evidence. B2-F previews, explicit user activation and P3 remain separate work.
