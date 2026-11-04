# B2-D — gated production execution integration

November 3, 2026 (Asia/Dhaka).

The application execution layer now has an internal network execution service, a private worker transport, an authoritative filesystem/argv construction protocol, and permission/B1/shutdown lifecycle integration. Disposable real tests exercised the **production native dispatcher**, not only the B2-C Python adapter.

**Development remains unavailable for activation.** Missing/legacy configuration stays isolated. Saving Development is rejected. There is no UI selection, environment override, model operation, preview URL or forwarding API. A manually inserted Development configuration also fails closed at the readiness gate; it cannot select Full Access. The host-address-change race is explicitly unresolved, not relabeled secure.

## Changes

| Files | Purpose |
| --- | --- |
| `src/main/workspaceNetworkPolicy.js`, `workspaceNetworkAddressPolicy.json` | Versioned isolated/development representation; hard readiness gate; reviewed restrictive IPv4 dataset and external IPv6 denial |
| `src/main/networkExecution.js` | Trusted session/workspace/revision ownership, shared leases, bounded output, cancellation, dependency transport and cleanup |
| `src/main/networkExecutionWorker.py` | Private inherited-pipe protocol; pins namespace authority and executes only controller-verified bubblewrap envelopes |
| `src/main/networkLaunchProtocol.js`, `sandboxFilesystem.js` | Single-use main-process permits and fresh authoritative filesystem/argv verification for isolated-network sharing |
| `src/main/networkDependencies.js` | Fixed application-resource manifest resolution; no workspace/PATH helper discovery |
| `src/main/tools/agentTools.js` | Branch behind the inactive Development policy within existing recovery, authorization, deadline and command execution flow |
| `src/main/configStore.js` | Safe policy normalization and rejection of premature activation |
| `src/main/lspExecutionContext.js`, `backgroundCommands.js`, `main.js` | Permission, session deletion/termination, B1 and application-shutdown cleanup |
| `src/main/foregroundCommand.js` | Reuse the existing bounded head/tail capture implementation |
| `src/main/experimental/network_owner.py` | Reused B2-C owner; finite safety cap extended from 120 to 1830 seconds to accommodate B1's existing 1800-second maximum plus setup margin |
| `tests/b2dNetworkExecution.test.cjs` | Verifier, default/gate, authority, failure and real production-dispatcher/B1 tests |

This report and `docs/b2-d-production-network-integration-evidence.json` record results. Initial untracked B2 prerequisite/B2-A/B2-C reports, evidence, probes and tests were preserved. The existing experimental owner's lifetime guard was deliberately extended; its egress enforcement and hardening were retained. No commits, system packages, host firewall/kernel changes, live database changes, or unrelated process termination occurred.

## Authoritative launch protocol

The existing offline shell verifier and its `--unshare-net` prefix remain unchanged. Full Access never enters this branch. The new service requires a process-local trusted execution context, main-session Workspace Write mode, a matching canonical project workspace and the current **persistent** permission revision. Child contexts and serialized lookalikes are rejected.

The main process issues an opaque, single-use five-second permit bound to trusted context, revision, canonical workspace, cwd, exact command and managed resolver. Consumption rechecks identity and authorization. The filesystem module requires its own WeakMap-backed plan, resolves it again for late sockets/masks, compares original mounts/environment, checks real cwd/workspace boundaries and validates the read-only synthetic resolver. It constructs and freezes the exact executable/argv/environment envelope. Cloned, modified, replayed or command-swapped plans cannot authorize a launch.

The envelope contains fresh bubblewrap filesystem/user/PID/IPC/UTS isolation, dropped capabilities, cleared environment plus the planner's approved environment, and a fixed isolated Python bootstrap that closes descriptors before exec of `/bin/sh -c` with the exact authorized command. The worker supplies its own pinned namespace handles; no model-supplied PID, namespace path or nsenter arguments enter the protocol. stdout/stderr from workspace processes are wrapped as data, not interpreted as control messages. The control channel is an inherited private pipe, absent from guest descriptors and filesystems.

As in B2-C, the network owner creates its own isolated namespace on demand. The trusted slirp translator alone retains host-side sockets for translating the filtered TAP; arbitrary application commands receive only the isolated owner network. Every command still receives a fresh filesystem and process sandbox. The new prefix omits *creation of another network namespace* only after the trusted worker joins the pinned isolated owner. This is not host network sharing. The production offline launch still includes `--unshare-net`.

## Lifecycle and B1

Owner keys include session, canonical workspace and persistent permission revision. At most two owners and four simultaneous operations per owner are admitted. Each operation holds a reference; the final operation releases and closes the worker/owner. A persistent B1 server keeps its lease until it actually ends. Ordinary new agent runs change ordinary approval revisions but preserve the persistent revision; they do not revoke that server.

Existing B1 remains the sole background-command registry. The network operation is awaited by the existing guarded/recoverable command operation. Background expiry, explicit Stop and run cancellation abort its control request; session termination/deletion invalidate the session's owners; mode/rule changes invalidate owners and live authority. Saving an Isolated policy invalidates all owners, and the shipping service also rechecks configured policy during live validation. Mode authorization is updated before awaiting resource teardown. Application shutdown closes owners alongside existing foreground/B1 cleanup. A worker/helper exit rejects pending operations and fails networking closed. Workers close application pipes and remove finished process records, avoiding per-command descriptor retention.

The worker has a finite 1830-second safety lifetime; B1's existing per-command maximum remains 1800000 ms, with its own deadline/cancellation unchanged. Existing output capture preserves bounded beginning/error tail. The namespace owner retains resource limits. There is no idle permanent namespace, second persistent-process registry, restart policy or host fallback.

## Egress readiness

The real transport retains namespace-local nftables actual-destination enforcement, explicit private/special/host-address rejection, approved resolver transport and guest-local networking. External IPv6 remains entirely rejected. Slirp's optional mount sandbox and seccomp remain mandatory in the owner setup.

The restrictive IPv4 dataset is now a versioned application resource. Its source is the [IANA special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry), whose published update remains 2025-10-09 when checked for this task. The dataset conservatively denies even globally reachable special-purpose assignments and adds multicast/reserved ranges. It records a 2026-11-03 review and a 2026-12-03 review deadline. Worker startup fails closed with `NETWORK_ADDRESS_POLICY_REVIEW_REQUIRED` after that date or for an unsupported policy version. No runtime network download can update or broaden the policy.

Maintenance contract: before each release and at least every 30 days, compare the IANA registry, conservatively update prefixes, review the diff for newly admitted destinations, update review dates, regenerate resource checksums, and rerun actual-destination tests. Address policy, helper pin and manifest updates must be reviewed together. This process is defined but is not yet release-qualified; the readiness gate remains closed.

The host-address monitor still observes link/address/route changes asynchronously. Between assignment of a new host-owned public address and monitor-driven shutdown, the namespace's snapshot can be stale. Snapshot refreshes or a shorter polling interval do not make that exclusion atomic. With no authorized host enforcement hook or verified equivalent, this task does **not** claim that race resolved. Tests assert the production readiness gate blocks activation; a simulated authority/host-epoch invalidation verifies cleanup, not kernel-level race elimination. No live host address was changed for testing.

## Dependency and packaging status

The shipping service resolves dependencies only from a packaged Linux x64 application resource set. Development source trees, unsupported architectures and missing manifests fail with `NETWORK_DEPENDENCIES_NOT_PACKAGED`. No helper is resolved through project settings or ambient/workspace PATH.

A future electron-builder `extraResources` set must contain, outside asar:

```text
workspace-network/
  manifest.json
  networkExecutionWorker.py
  workspaceNetworkAddressPolicy.json
  experimental/network_owner.py
  x64/slirp4netns
```

Manifest schema: `{ "version": 1, "sha256": { "<relative-file>": "<sha256>" } }`, covering all four payload files. Resolver code rejects missing files, symlinks and digest mismatches. The owner's existing pinned binary SHA256 independently checks the approved x86-64 slirp release. The Python interpreter and Linux utilities are fixed absolute system prerequisites: `/usr/bin/python3`, `/usr/bin/unshare`, `/usr/bin/nsenter`, `/usr/bin/bwrap`, `/usr/sbin/nft`, `/usr/sbin/ip`. Rootless user namespaces, namespace-local nftables, TAP, seccomp and netlink monitoring also remain required.

**No binaries, resource manifest, extraResources declaration or distro package dependency was shipped in this task.** Adding a partial payload would not qualify activation. Release work must decide supported Python/utilities versions or replace the Python worker, verify executable provenance/permissions and runtime libraries, include the helper/dependency license notices and required source material, and establish security updates. Other architectures need separate pins and real acceptance; they are currently rejected rather than assumed supported. AppImage/AppArmor/nft/user-namespace compatibility needs packaged testing on each supported distro. No system-wide installation was performed.

## Actual tests

The B2-D real integration fixture explicitly constructs a service using the trusted factory, approved /tmp helper and an isolated temporary database/settings directory. It substitutes that service only in the test process. It does not alter the shipping readiness function or live settings. Tests call the normal native `execute_command` dispatcher, which retains native grants, shell recovery, the existing filesystem planner and the new authoritative launch construction.

Verified on real Linux:

- Production dispatcher: public HTTPS 200, DNS resolution, controlled host-private access rejection, external IPv6 rejection, and hostile nft modification rejection.
- Persistent server: another authorized command reaches guest localhost while the server runs; `/tmp` files do not persist across commands despite shared networking.
- B1 persistence: normal response/run completion and ordinary new trusted context preserve the server's network lease; later Stop closes it.
- B1 finite expiry, permission mode revocation, remembered-rule revision invalidation, session termination/deletion and service shutdown release owners.
- Forged context, cross-workspace identity, replayed permits, command substitution, modified/cloned plans and late exposed sockets are rejected.
- Failed backend setup cannot create a host fallback marker; simulated invalidation closes a pending lease. These failure simulations are deterministic tests, not claims of real host configuration changes.

The B2-C real owner security suite was rerun after the safety-lifetime adjustment: controlled private-host before/after with nft counters, IPv4 representations, IPv6 counters, DNS changes/redirects, namespace authority, raw packet denial, helper hardening, helper/setup failure, parent death/control EOF and W7 protection all passed. Those tests exercise the underlying owner directly; DNS rebinding/redirect counter assertions are not claimed as separate end-to-end dispatcher tests.

Relevant existing regressions cover B1, W7/filesystem restrictions, permission/Casual Chat behavior, isolation reliability and runtime settings. One initial regression run exposed unnecessary context creation on an isolated Ask for Approval command; this was fixed so only the gated network path requests an existing context. Subsequent full regression runs passed. An earlier tool approval review timed out; its permitted retry completed. No approval rejection remains blocking work.

Final combined Node run: **117 passed, 0 failed, 0 skipped**, including five focused B2-D groups. Separate real B2-C owner suite: **5 groups passed**. See the evidence JSON for commands. Production Vite build passed with its existing chunk-size warning. `git diff --check`, JavaScript/Python syntax, JSON parsing and new-file whitespace checks passed. No Electron UI, packaged AppImage/deb, public preview, dependency-install workflow, long-duration/stress or atomic host-address-change test was performed.

## Activation decision

**Not ready for explicit Development activation.** The production-compatible execution and lifecycle integration is now exercised with explicitly authorized fixtures, while normal users retain isolated networking. The remaining release blockers are atomic host-local exclusion under address changes, release qualification of the maintained address policy, and pinned/qualified packaged dependencies. No preview functionality was added. Resolve those blockers before opening the readiness gate or adding a user-selectable Development setting.
