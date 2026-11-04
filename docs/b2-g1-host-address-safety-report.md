# B2-G.1 — host-address exclusion: reproduced blocker and concrete replacement boundary

November 3, 2026 · Asia/Dhaka · Linux x86-64 source tree.

**Atomic host-local exclusion is not verified. Development remains disabled.** This handoff takes the mission's permitted blocker/alternative-design outcome. It supplies a real-kernel counterexample for the current backend, not an implemented production fix. B2-F.1 source-tree acceptance remains accepted; no preview, resource, dispatcher, permission or owner code was rebuilt or weakened.

## 1. Initial repository state and files changed

Read all seven required reports, C/D/E/F/F.1 evidence, the owner, policy/readiness, worker, dependency resolver, dispatcher integration and relevant security tests. There was no applicable project AGENTS.md (only dependency copies). Initial git status contained 16 modified tracked files and the existing untracked B2 work. The exact initial status is preserved in `b2-g1-host-address-safety-evidence.json`.

Tracked modifications already present: main.js; src/components/InteractiveChart.jsx; src/components/chat/BackgroundCommandCard.jsx; src/index.css; src/main/backgroundCommands.js, configStore.js, executionCapabilities.js, foregroundCommand.js, ipcHandlers.js, lspExecutionContext.js, promptBuilder.js, sandboxFilesystem.js, tools/agentTools.js; src/preload.js; tests/backgroundCommandIpc.test.cjs; tests/backgroundCommands.ui.cjs. Existing untracked reports/evidence, investigations, experimental owner, network/preview modules, tests and chart artifacts were retained.

This task adds only:

- `tests/b2g1HostAddress.test.py`: opt-in, bounded, real nested Linux reproducer.
- This report and `docs/b2-g1-host-address-safety-evidence.json`.

Production files are unchanged by this task. No commit/push/reset/stash/clean, package installation, real-host address/route/firewall/sysctl modification, live database edit or unrelated process termination occurred. The existing pinned helper was reused. Namespace tests ran outside the tool's restrictive outer sandbox, with approval, as unprivileged user-namespace fixtures.

## 2. Confirmed packet and socket lifecycle

1. Workspace code runs in the B2-D verified filesystem/PID/user sandbox inside the pinned owner network namespace. Launch permits, trusted context/revision checks and B1 remain authoritative.
2. Guest packets pass owner-local nft OUTPUT. Special IPv4, snapshot host4, external IPv6 and DNS/guest-local rules apply to the actual guest destination.
3. TAP delivers admitted packets to slirp. Its mount sandbox/seccomp and user namespace do not move its outbound sockets out of the host network namespace.
4. libslirp opens host-side TCP/UDP sockets; the host kernel independently looks up routes and delivers traffic. Guest nft has neither the host's local routing table nor authority over these sockets.
5. Host-local delivery passes host INPUT. This is the relevant final boundary: protection must reject delivery there (or provide an equivalent enforced topology), rather than predict future ownership before connect.

The [versioned slirp manual](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/slirp4netns.1.md) documents loopback suppression and outbound binding, not atomic exclusion of every host-owned address. [Netfilter's hook documentation](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks) places local delivery in INPUT and routed traffic in FORWARD. The routing/enforcement conclusion here combines those semantics with the actual nested-kernel results below.

## 3. Narrow impossibility argument for the current backend

Consider a public destination P absent from host4. The guest filter must admit P to preserve ordinary public networking. After that verdict or any transport-side address lookup, another authorized host actor can assign P before connect/routing. The helper is still able to open a host socket. Until the monitor runs, both the guest rules and any userspace ownership cache represent the previous state. Real netlink notification can already be queued while the helper connects to a host service.

The reproducer realizes this ordering using the actual owner, hardened helper, guest nft rules, real routing, real public-numbered address assignment and real TCP/UDP services. A bounded scheduling barrier delays only the monitor thread; it does not fabricate notifications or mock packet verdicts. This is a deterministic counterexample to an all-schedules guarantee, **not** a measurement of the natural race window or its frequency on an unloaded desktop.

For this backend, these requirements cannot all hold: unrestricted permitted public IPv4 destinations, arbitrary concurrent host ownership changes, enforcement solely in the private guest namespace/asynchronous userspace observations, and no access to unauthorized host-local services. The argument is limited to this socket topology and enforcement model, not a theorem ruling out every future unprivileged Linux API/backend. No available verified rootless mechanism was identified that supplies the missing local-delivery authority.

## 4. Candidate mechanisms evaluated

| Mechanism | Finding |
| --- | --- |
| Refresh host4, subscribe before snapshot, poll faster, monitor teardown | Useful defense retained; cannot serialize notification handling with host packet delivery. Real queued-notification bypass reproduced. |
| Lookup immediately before connect; userspace proxy/seccomp-notification broker | Lookup and connect remain separate. Post-connect inspection cannot retract a handshake or application data; UDP may reroute later. Real route-lookup/assignment/connect counterexample reproduced. |
| Guest nft `fib ... type local` | Queries the guest namespace's FIB, not host ownership; moving the query to an unprivileged auxiliary namespace has the same limitation. |
| Slirp loopback disabling, source/interface binding, alternate rootless socket helper | None supplies a supported contract excluding all host-local delivery under ownership changes. A helper replacement alone is unjustified. Binding is not a local-delivery ACL. No replacement installed. |
| cgroup/connect BPF only | Privileged deployment outside authorization, and connect-time classification alone is insufficient for later UDP routing/ownership changes. No BPF deployed. |
| Remote proxy/tunnel/VM with ordinary host-socket uplink | Merely moves the question. Remote egress can reach the desktop's public address too; authenticated tunnel transport does not prove arbitrary tunneled destinations are safe. No tunnel/VM deployed. |
| Dedicated routed transport namespace + host INPUT denial on its trusted veth ingress | Concrete candidate: enforce at actual host delivery rather than a snapshot. Requires narrowly scoped privileged host provisioning and independent lifecycle enforcement, outside current authorization. Selected alternative design below. |

## 5. Selected alternative architecture (design, not deployed)

Retain the existing main/worker/NetworkOwner/B1 ownership and all namespace-local filtering, filesystem plans, launch permits, cgroups and pipe-only previews. Move **only the trusted slirp transport's socket network namespace** into a dedicated egress namespace provisioned by a small, separately audited privileged broker. Its only uplink is a dedicated veth peer on the host; no host-network sockets or caller-selected namespace descriptors are returned to workspace code. Existing owner retains the lifecycle reference; the broker is not another background-command registry.

The broker must provide the following closed contract:

1. Authenticate a main-process peer via kernel credentials and bind a finite lease to its pinned owner identity. Accept fixed operations create/release only, with opaque handles. Do not accept commands, firewall text, routes, addresses, arbitrary paths or caller-selected host interfaces from the renderer/model/workspace. Broker provisioning requires explicit administrator authorization in a future task.
2. Provision veth/namespace with link down. Install an atomic host-owned table whose INPUT chain unconditionally drops **all** packets arriving from that specific peer interface, before any established-flow shortcut. Interface identity must be pinned; names alone cannot permit reuse/confusion. Host-local IPv4/IPv6 is never an exception for DNS, established traffic or previews.
3. Host FORWARD applies an independently owned default-deny policy for that ingress: only reviewed public IPv4 egress to explicitly qualified external interfaces, restricted destinations denied after DNAT as well, external IPv6 denied. Disable/exclude flowtable/hardware bypass for these flows. Permit return traffic only to the leased peer. NAT only scoped forwarded IPv4. DNS must use a designated public resolver or a separately bounded pipe resolver; never grant host INPUT access to a host resolver. Keep guest DNS alias behavior and verify it end to end.
4. Only after all checks succeed bring up the peer and return private transport authority to the trusted worker. The transport can still attach the existing guest TAP; its host-side sockets now mean egress-namespace sockets. Workspace code still joins only the original guest owner namespace, never the egress namespace.
5. Every packet actually routed to a host-local socket from this veth must pass INPUT and be dropped, even if P was just assigned or a local route was just installed. No userspace host-address update is needed for this verdict. A packet routed externally before assignment may finish external delivery; that is distinct from delivering to a local host service. Later packets rerouted locally encounter INPUT. This is a design argument from the final-delivery hook, not complete architecture acceptance.
6. Crash-safe lease expiry must administratively disable/delete the peer; final release deletes link/namespace first and then scoped rules. Broker restart must reconcile orphaned peers **before** admitting work. Policy-update failure leaves a drop-only/quarantined link, never a temporary allow. An independent privileged supervisor must couple enforcement loss with peer removal. Polling a missing firewall table is insufficient: arbitrary deletion by another privileged firewall manager cannot satisfy a fail-closed guarantee without a qualified ownership/coexistence contract. Unsupported hosts fail preflight.

This is intentionally an architecture change requiring new authorization, not silently introduced host privilege. A future implementation must prove rule coexistence, exact peer classification, crash/lease ordering, NAT/routing/flow-offload behavior and fail-closed enforcement loss in the disposable topology first. The current test's narrow surrogate INPUT guard validates only that hook's effectiveness against its controlled TCP service. It does **not** validate this broker, veth classification, NAT, DNS or the full alternative.

## 6. Threat-model distinctions

Private/special numerical addresses remain rejected independently of host ownership. Public numerical addresses assigned initially are rejected by host4; newly assigned addresses are not. A host local-route entry without an interface address can also make a public destination local; this was reproduced. Route monitoring is useful revocation but remains asynchronous.

DNS, redirects, integer/hex and mapped forms ultimately select packet destinations and remain subject to existing guest rules; no hostname allow decision grants authority. They cannot repair missing dynamic host-local classification. The local-delivery alternative would classify the resulting routed packet regardless of address spelling.

The lookup/connect interval was exercised with assignment after a real route lookup and before a real guest connect. Assignment precisely between SYN and handshake completion was **not** synchronized/tested. Existing guest UDP mapping/socket changed REMOTE → HOST; an established TCP stream observed ConnectionResetError in this topology. TCP is not claimed always to reset safely or always to migrate. No established-flow exemption can be used as protection.

A globally numbered service reached through VPN/private routing is not necessarily host-owned. The current guest policy does not identify administrative ownership, remote DNAT targets or all VPN paths. The proposed broker must restrict external egress interfaces and evaluate post-DNAT destinations; unknown routing/tunnel configurations must be rejected or separately qualified. Remote hairpin/NAT returning traffic through a different host interface also requires a dedicated acceptance case and preserved ingress/flow provenance. The proposed INPUT-on-veth rule alone does not establish protection against every external hairpin path. Do not activate with that limitation unresolved.

## 7. Actual address-change evidence

The fixture creates a new user/network/PID namespace with a private proc mount. It refuses mutation unless the network namespace differs from its launching namespace and initially has only lo. It has **no real-host or internet uplink**. A sibling remote namespace connected by veth owns public-numbered P=11.22.33.44; the surrogate host routes P there initially. Separate controlled services on TCP/UDP 43129 return REMOTE and HOST. The real pinned slirp adapter serves a nested guest. Public numbering here is synthetic and never contacts that internet address.

| Case | Result |
| --- | --- |
| Initially owned P | Guest rejected; denied4 counter increased. |
| New P assignment while guest active | REMOTE before; HOST after; guest denied4 unchanged; real netlink notification queued; releasing monitor closes owner with host_network_changed. |
| Repeated add/remove/reassign | Eight cycles, each REMOTE → HOST; guest stays active under bounded monitor delay. This is controlled churn, not a high-rate stress claim. |
| Route-only change | `local P/32 dev lo` reaches HOST without assigning P to an interface. |
| Ownership change between route lookup and connect | Real lookup selected uplink, then assignment, then real guest connection reached HOST. |
| Existing UDP socket | Same guest socket/mapping received REMOTE then HOST after assignment. |
| Existing TCP socket | Initial REMOTE; after assignment ConnectionResetError observed. |
| Surrogate local-delivery guard | INPUT rejection counter increased; guest could not connect; controlled HOST service remained reachable by independent positive control after guard removal. |
| Actual monitor fd loss | Owner closed with authorization_or_monitor_failed; later launch denied. |
| Helper termination, owner death, parent death, control EOF, startup policy failure | Existing real B2-C suite passed; no automatic helper restart exists. No dynamic policy update is attempted by the current backend. |

There is no production before/after fix: the snapshot counterexample still applies. The INPUT guard is a fixture-only contrast demonstrating a distinct enforcement boundary. No safe native-frequency race percentage, zero-race claim or packaged qualification follows from these results.

Initial fixture iterations exposed two test defects: wildcard UDP responses selected the wrong source address for a connected receiver (fixed with a fixture-only IP_FREEBIND public address bind), and reusing the rejected slirp path for the guard-removal positive control timed out (replaced with an independent direct controlled-service check). These were new-fixture findings, not product fixes or counted successes.

## 8. Validation and compatibility

Final exact results are recorded in the adjacent evidence JSON:

- New real-kernel host-address suite: **8 passed, 0 failed, 0 skipped**. Passing means the counterexample/behavior assertions passed, not that production host-local exclusion passed.
- B2-C real Linux namespace/egress security: **5 passed, 0 failed, 0 skipped**.
- Combined serial Node acceptance/regressions: **149 passed, 0 failed, 0 skipped**.
- B2-E deterministic address policy: **4 passed, 0 failed, 0 skipped**.
- B2-F.1 deterministic resource profile: **2 passed, 0 failed, 0 skipped**.
- Production Vite build passed; existing large-chunk warning. JS/Python syntax, JSON and whitespace checks passed.

The Node set includes real B2-D dispatcher public IPv4 HTTPS/DNS, B1 persistence/Stop/expiry and revocation, launch-authority rejection, W7 filesystem/socket masks, permission/Casual Chat regressions, resource-integrity tests, preview IPC/authentication/faults, actual worker/helper/owner crashes and aggregate resource OOM. Standard isolated Node/Vite and installed Chrome verify assets, JS, CSS, authenticated browser access and HMR. No preview implementation changes were needed. Historical Electron renderer acceptance from B2-F.1 was not repeated; no renderer code changed. No AppImage/deb or system package build/installation was performed.

Reproduce new tests (requires Linux namespace/TAP/nft support, outside an outer sandbox denying them):

```sh
B2G1_HELPER=/tmp/continuum-b2-a-backend/slirp4netns python3 tests/b2g1HostAddress.test.py
```

The wrapper has a 120-second total deadline, kill-child PID containment, bounded operation deadlines and owner limits. Teardown closes owned processes/descriptors and removes fixture topology; PID-namespace exit also destroys descendants on abnormal exit. No helper download or activation override is included.

## 9. Readiness and next B2-G.2 requirements

`workspaceNetworkPolicy.readiness()` remains unmodified and unavailable. Config/environment/model input cannot waive its blockers. Ordinary Workspace Write stays offline/isolated. Host-local exclusion is **not verified**; closure success criterion is unmet for the existing backend. The mission's fallback deliverable is the bounded counterexample and actionable alternative above.

Before packaging can qualify activation, a separately authorized security implementation must deliver the missing boundary and pass real newly assigned/local-route/SYN-race/established TCP+UDP/churn/NAT/hairpin/VPN/failure tests with controlled positives and counters. Do not relabel this as packaging-only remaining work.

Exact B2-G.2 packaging requirements after that boundary is selected:

1. Freeze the backend architecture and explicit privilege/support contract. If the broker design is chosen, independently review its tiny credential-checked protocol, installation/removal, privilege separation, crash reconciliation and enforcement ownership; explicit administrator authorization is mandatory. A rootless-only release remains blocked unless an equivalent verified boundary is found.
2. Provide the complete pinned outside-asar `resources/workspace-network` payload: manifest v1 covering networkPreviewBridge.py, networkExecutionWorker.py, experimental/network_owner.py, workspaceNetworkAddressPolicy.json and per-qualified-architecture helper; include any selected broker artifacts in a reviewed manifest/schema evolution. Hash final bytes; reject missing/tampered/symlink/wrong-architecture/nonexecutable resources. Never discover helpers via workspace PATH.
3. Inventory slirp/libslirp/libseccomp and all shipped components; supply exact-build licenses/notices and corresponding-source obligations, provenance and an assigned vulnerability/repin response owner. No partial binary-only distribution.
4. Qualify Linux distro/kernel/userns/AppArmor/TAP/nft/seccomp/netlink and systemd user cgroup-v2 prerequisites. Qualify fixed Python >=3.11, bwrap, util-linux, nft, iproute2 and systemd-run versions/paths. Require MemoryMax 1 GiB, swap 0, TasksMax 128, CPUQuota 200%, group OOM and existing bounded address-space profiles. Unsupported prerequisites fail closed; no host fallback.
5. Assign release/security ownership for the restrictive IANA policy, archive registry/date/hash, retain coverage floor and external IPv6 denial, review at release and within the 30-day window, and regenerate manifest checksums from final resources.
6. Build actual AppImage/deb; inspect installed payload/permissions, dependency declarations and license/source distribution. On clean qualified systems run all security/dispatcher/B1/preview/browser/resource/W7/permission suites from installed artifacts, including cold launch, shutdown, SIGKILL, expiry/revocation, parent/broker/helper failure and restart with no restored authority. Test firewall-manager coexistence and arbitrary enforcement loss for any privileged design.
7. Keep Development gated until all security, resource, packaging and runtime evidence passes. This task authorizes no user-facing activation, new settings tab, P3 profiles, LAN exposure or public tunnels.
