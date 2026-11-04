# B2-C — disabled network owner with namespace-local egress enforcement

November 3, 2026 (Asia/Dhaka).

The internal foundation now demonstrates public IPv4 HTTPS/DNS and enforcement against the B2-A private-host bypass. **The same controlled service returned HTTP 200 before the filter, then was rejected with an nftables counter increment after the filter.** External IPv6 is deliberately rejected in its entirety; guest-local IPv6 remains functional. This is a narrower, fail-closed transport policy, not a claim of public IPv6 support.

Production Workspace Write remains unchanged. No JavaScript production module imports this adapter. There is no model tool, IPC, renderer control, settings flag, host-network fallback, package authorization change, Full Access change, or production preview endpoint. The Python experimental module is not included by the current Electron `src/main/**/*.js` packaging rule. Do not enable it through an environment flag or ship these test entry points as tools.

## Files added and preserved

- `src/main/experimental/network_owner.py`: internal, explicitly constructed test adapter; namespace owner, policy installation, hardened helper, authorized command joining, bounded output and cleanup.
- `tests/b2cNetworkOwner.test.py`: opt-in real Linux security and lifecycle suite. It requires an explicitly supplied, previously approved helper and is not registered in ordinary npm test discovery.
- `docs/b2-c-network-owner-evidence.json`: final focused results and regression/build summary.
- This report.

The initial working tree contained the untracked B2 prerequisite report, B2-A report, and `docs/investigations/b2-a/`. Those files were preserved without modification. No commit, push, reset, stash, clean, system package installation, host firewall change, sysctl change, live database edit, unrelated service launch or unrelated process termination occurred. Tests used disposable workspaces and the already authorized `/tmp/continuum-b2-a-backend/slirp4netns` binary, rechecked against SHA256 `1c177694fe6bf299debfd8ff601a2ee3c4f7554d9983acdf1f854a6b34d53e70`.

## Owner and launch architecture

The trusted adapter starts `unshare --user --map-root-user --net` with a fixed, non-workspace Python owner program. Namespace UID/GID 0 maps to the normal host user, not host root. An initial bubblewrap nft probe failed because of its default capability set; a real root-mapped unshare namespace could list and install its own nft rules. No host nft command was used.

Only the freshly spawned owner supplies its startup PID. The adapter immediately opens its network namespace and derives the actual owning user namespace through `NS_GET_USERNS`. Thereafter namespace authority uses pinned descriptors, not caller-selected PIDs. Owner identity includes session, canonical workspace and workspace device/inode; caller validation runs before operations and every 50ms. Replacement of the workspace or lost authorization invalidates the owner. A limit of two owners, four live commands per owner, finite 1–120 second experimental lifetimes and bounded command history prevent unbounded retention.

The filter is installed atomically before the TAP/helper starts and before the launch API becomes ready. Setup failure closes the owner and never selects host execution. The helper executable is hashed through a pinned file descriptor and executed through that descriptor. The trusted transport uses host-side sockets only to translate filtered TAP traffic; arbitrary workspace code never runs in its host network context.

Each command joins the authorized isolated network, creates fresh bubblewrap user/PID/IPC/UTS/mount isolation, drops application capabilities and uses the unchanged production `sandboxFilesystem.resolveFilesystem` planner with explicit disposable configuration. Workspace files remain writable only through that plan; internal masks and socket rejection remain active. The experimental resolver is added read-only before the root remount. The adapter does not call the production shell argv verifier with a fictional launch: its different trusted launch sequence remains experimental, and production integration will require an explicit verifier extension.

A real descriptor test found that namespace descriptors survived the initial nsenter/bwrap chain. The final adapter executes a fixed `/usr/bin/python3 -I` bootstrap from read-only system files to close every descriptor above stderr before exec of workspace code. Guest stdin is /dev/null. Final tests confirmed no network/user namespace descriptors were inherited and obtaining the owning user namespace through ioctl failed with EPERM. Only the trusted adapter retains these authorities.

## Destination enforcement

An `inet` nftables OUTPUT chain in the **isolated owner network namespace** enforces policy on the kernel's actual IP destination, after client address parsing. It does not trust a hostname verdict or HTTP proxy environment variables.

Rule order:

1. Allow traffic routed over guest loopback. This authorizes communication among processes in the same isolated owner, not the host loopback.
2. Allow TCP/UDP port 53 only to slirp's configured DNS alias `10.0.2.3`.
3. Reject a conservative superset of the [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry), plus multicast/reserved space. This includes private, CGNAT, loopback aliases, link-local/metadata, documentation, benchmarking and special-purpose assignments, even some globally reachable special assignments.
4. Reject all host-owned IPv4 addresses captured from trusted `ip -j address`, including any public host interface addresses.
5. Reject all non-loopback IPv6. No NAT64/6to4 exception, public IPv6 or IPv6 DNS alias is enabled.
6. Allow other IPv4 destinations. Default policy is drop.

There is no established-connection exception that could preserve a blocked destination after policy setup. DNS may return private addresses, and redirects may point to them, but the next actual connection still encounters the filter. DNS queries sent to the authorized resolver are an explicit limited exception, not permission to contact arbitrary ports on the DNS alias. Ordinary public-address DNS transport is also within public IPv4 access; there is no arbitrary private DNS destination exception.

Before snapshotting host addresses, the adapter subscribes to host link/address/route netlink changes. A queued startup change aborts setup; later changes or monitor errors close the owner rather than silently retain stale host-address authority. No live host configuration change was performed to test notification delivery. This monitor is asynchronous and does not claim atomic revocation against a concurrently changing host network. That race needs resolution or an explicit supported-environment contract before production enablement.

The registry snapshot is documented in source (IANA update 2025-10-09). It is deliberately restrictive but not an automatically maintained address database. Before release, add a maintained snapshot/update policy and security review. Public addresses routed into private infrastructure by unusual routing/VPN/NAT cannot be classified from IP syntax alone; this prototype is not a promise to identify every administrative service at a globally numbered address.

## Actual security results

Focused suite: five real Linux test groups passed, including the following cases. Their assertions distinguish actual filter verdicts from unavailable destinations.

| Case | Result and evidence |
| --- | --- |
| Controlled host-private sentinel, host positive control | HTTP 200 and expected marker |
| Same sentinel in sandbox without policy, fixture-only B2-A baseline | HTTP 200 |
| Same sentinel after policy | Connection rejected; denied4 counter increased |
| Public HTTPS | example.com returned 200 with normal certificate verification and no ambient proxy |
| DNS | getaddrinfo(example.com) succeeded using the synthetic resolver |
| Integer, hexadecimal, IPv4-mapped IPv6 URL forms of private host | Rejected; actual-destination denied4 counter increased |
| Selected private/CGNAT/metadata/documentation/benchmarking destinations | Rejected; denied4 counter increased before packets could contact a remote service |
| Gateway alias and DNS alias on unauthorized non-DNS port | Rejected; denied4 counter increased |
| Controlled host loopback sentinel | Host positive control succeeded; guest's separate loopback could not reach it; gateway attempt hit filter rejection |
| ULA, link-local with scope, IPv6 gateway/DNS aliases and documentation IPv6 | Rejected; denied6 counter increased, with a namespace IPv6 route installed so route absence was not the evidence |
| Authorized guest HTTP | IPv4 loopback and IPv6 ::1 both returned 200 from a separate sandbox command |
| Controlled guest HTTP redirect to private address | Followed redirect failed; denied4 counter increased |
| Controlled guest DNS answer changing public → private | Client consumed both real UDP DNS responses; connecting to the private second answer failed and denied4 counter increased |
| nft flush, route addition, interface down | EPERM inside application sandbox |
| Nested user namespace attempting to flush owning-network rules | EPERM |
| AF_PACKET/raw IP sockets | EPERM; cannot inject L2 packets around OUTPUT filtering |
| Inherited namespace handles / reacquiring owner userns | No handle inherited; ioctl EPERM |
| Wrong session/workspace | Authorization rejected before launch |
| Enter peer owner's namespace using host PID path | Failed inside fresh PID/proc sandbox |
| W7 exposed socket fixture | Filesystem planner rejected setup |
| W7 masked internal socket fixture | Command succeeded with socket preserved |

Only controlled sentinels were contacted successfully. Tests against representative restricted addresses use the local nft counter increment as positive policy evidence; they do not depend on an unrelated private service being reachable, and rejected packets do not leave the namespace. They are not an exhaustive probe of every address in every range. The DNS-change test uses a controlled guest resolver, not a public DNS provider or a real user's resolver configuration.

## Helper hardening root cause and fix

The [slirp 1.3.7 parent launch code](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/main.c) attempts namespace-local GID/UID 0 before creating its optional sandbox when invoked as a non-root user. In B2-A's namespace-path launch, that parent path did not enter the supplied owning user namespace as expected; namespace root was not established for the parent and `setegid(0)` failed. Changing only the application UID/GID did not fix the parent launch sequence.

B2-C starts the trusted helper through nsenter into the pinned **root-mapped owner user namespace**, while retaining its host-side transport network. Its TAP setup child joins the isolated network. The helper parent now observes namespace UID 0, and both `--enable-sandbox` and `--enable-seccomp` work. Neither flag is silently removed on failure.

Tests verified a distinct helper root filesystem, `NoNewPrivs: 1`, `Seccomp: 2`, and an effective capability set of only CAP_NET_BIND_SERVICE (no NET_ADMIN). This is verification of upstream hardening activation, not a complete audit of libslirp, seccomp rules, or every mounted file. The upstream helper sandbox still has its documented read-only /etc and /run exposure. Workspace commands cannot control its argv, binary, namespace descriptors or configuration.

## Lifecycle and cleanup results

- Repeated successful creation and teardown: passed; all tracked processes exited and all retained namespace/control descriptors were released.
- Failed helper identity, injected nft setup failure, and helper crash during startup: passed; no ready owner or host fallback. A policy setup failure starts no transport.
- Helper crash during operation: monitor closed the owner and future commands were rejected. With the TAP transport gone there is no route into host networking.
- Owner stdin/control EOF and lost helper exit-pipe writer: passed; processes stopped and the owner was invalidated.
- Parent process killed: its owner received control EOF and its helper received exit-pipe HUP; both were observed exited. The fixture removed only the exact temporary directory created by that parent.
- Finite expiry, caller authorization revocation, explicit session cancellation, explicit application-shutdown close: passed as adapter-level operations/callbacks. They are not wired to live app session events.
- Output flood: bounded capture rejected it and terminated the command. Child file descriptors, address space, CPU and core dumps are limited. Commands have deadlines; unexpected descendant teardown uses bubblewrap PID isolation and process-group TERM/KILL escalation.

This slice intentionally creates **no host forwarding/control API socket or preview endpoint**. Therefore no forwarding resource can outlive this adapter, but forwarding lifecycle integration itself is not claimed tested here. B2-A's independent native-forward cleanup result remains historical evidence only. A later preview slice must authorize selected processes/ports, authenticate local clients and close resources with B1 lifecycle events. Do not reuse a raw unauthenticated native forward as a production preview.

## Verification commands and scope

```sh
B2C_HELPER=/tmp/continuum-b2-a-backend/slirp4netns PYTHONDONTWRITEBYTECODE=1 python3 tests/b2cNetworkOwner.test.py
node --test tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/sandboxFilesystem.test.cjs tests/w7SandboxSockets.test.cjs tests/permissionPolicy.test.cjs tests/casualToolAuthorization.test.cjs
npm run build
git diff --check
```

Real namespace and existing socket tests ran outside the tool's outer restriction, as the outer restriction hides TAP and prohibits required operations. No sudo/root host privileges were used. Focused owner suite: **5 passed**. Existing B1/sandbox/W7/permission/Casual Chat suite: **50 passed, 0 failed, 0 skipped**. Production Vite build: **passed**, with the existing large-chunk warning. New Python and JSON files were syntax checked; new-file whitespace checks supplement `git diff --check` because these files are untracked.

No Electron UI or packaged-app verification, dependency installation workflow, production B1 attachment, authenticated preview, memory/cgroup stress assessment or full supported-distribution matrix was performed. The production argv verifier and all existing execution-mode paths remain untouched.

## Readiness and next boundary

The reproduced private-host bypass now has a demonstrated namespace-local enforcement fix, and the disabled owner provides reusable ownership and cleanup behavior. It is suitable for continuing internal integration work under the tested IPv4-only external policy. It is **not ready to enable for production Workspace Write**.

Before enablement: settle asynchronous host-address-change revocation, maintain and review the address policy, integrate the checked descriptor launch with the production filesystem/argv verifier, replace or explicitly package the experimental Python/utility dependencies, bind lifecycle to B1 and trusted permission revisions, and implement separately authenticated previews. Public IPv6 support requires its own full destination-policy and transport test matrix; until then external IPv6 must remain rejected. Unprivileged user namespaces, namespace-local nftables, TAP, slirp sandbox/seccomp and host netlink monitoring must all fail closed on unsupported systems.
