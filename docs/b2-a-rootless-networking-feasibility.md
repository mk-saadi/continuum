# B2-A — verified transport, public-only policy still blocked

November 3, 2026 · Linux x86-64 · feasibility only.

**Recommend slirp4netns 1.3.7 as the transport to carry forward, conditional on an independently enforced egress policy. Do not enable it in Workspace Write yet.** A real bubblewrap namespace resolved DNS, fetched public HTTPS with certificate verification, hosted a persistent server, accepted a subsequent filesystem-sandboxed command, and supported a selected host-loopback forward. A controlled private-host sentinel was also reachable: the required public-only restriction is absent. This is a reproduced security gap, not an inference from a successful HTTPS request.

Continuum production code, existing sandbox enforcement, permission modes, defaults, database contents and packaging were not changed. The pre-existing untracked `docs/b2-networking-prerequisite-report.md` was preserved. Only these feasibility documents, scripts and evidence were added. No system packages, firewall rules, kernel settings, or unrelated processes were changed. The user explicitly approved the disposable /tmp slirp download before it happened.

## 1. Host and installation findings

| Prerequisite | Observed result |
| --- | --- |
| Host | Pop!_OS 24.04 LTS, Ubuntu noble base, x86-64, kernel 6.17.9-76061709-generic |
| User | UID/GID 1000; probes ran unprivileged, without sudo |
| bubblewrap | 0.11.0; real `--unshare-user --unshare-net` probe passed outside the tool's outer restriction |
| User namespaces | `/proc/sys/user/max_user_namespaces` = 62313; actual namespace creation and joining passed; `kernel/unprivileged_userns_clone` file absent, not treated as a failure |
| TAP device | `/dev/net/tun` exists on host, mode 0666; actual TAP creation passed |
| Tool outer sandbox | Hides /dev/net/tun and restricts networking; do not mistake that view for host prerequisites. Namespace tests used approved execution outside it |
| Existing helpers | slirp4netns, pasta, passt, rootlesskit, podman and docker absent from checked host PATH; no matching helper found in checked /tmp, /opt or local-bin locations |
| Utilities | bwrap, nsenter, unshare, curl, Python 3, apt-cache, dpkg-deb available |
| DNS | Host resolver points to a loopback IPv4 resolver through a systemd-resolved symlink; guest used a separate read-only resolv.conf with `nameserver 10.0.2.3` |
| Host libraries | libc6 2.39, libglib2.0 2.80, libseccomp2 2.5.5 installed; libslirp0 not installed |

Current local apt metadata (not refreshed or installed):

| Package | Candidate | Source | Dependencies |
| --- | --- | --- | --- |
| slirp4netns | 1.2.1-1build2 amd64 | configured Pop Ubuntu noble/universe mirror | libc6 >=2.38, libglib2.0-0t64, libseccomp2, libslirp0 >=4.1 |
| passt (also supplies pasta) | 0.0~git20240220.1e6f92b-1 amd64 | same mirror | libc6 >=2.38 |

Installing either with apt would require administrative authorization. Neither package was installed. Extracting distro packages into /tmp is another option, but slirp would also need its missing libslirp dependency. No such extraction was necessary: the approved upstream static release avoided system dependency changes.

Downloaded only to `/tmp/continuum-b2-a-backend/`:

- [Official slirp4netns v1.3.7 release](https://github.com/rootless-containers/slirp4netns/releases/tag/v1.3.7), asset `slirp4netns-x86_64`, plus its `SHA256SUMS`.
- Manifest SHA256 checked against the release page: `5174aaf82bce5adedcda870504e147fff967d8b5e3e8fcd5664f1de7f7591fb3`.
- Binary SHA256 checked against that verified manifest: `1c177694fe6bf299debfd8ff601a2ee3c4f7554d9983acdf1f854a6b34d53e70`.
- `--version`: slirp4netns 1.3.7, commit `7ea080d8635bc85487e232ec178701c6864151c9`, libslirp 4.9.7, libseccomp 2.5.3. `file` confirmed a statically linked x86-64 ELF. This verifies release consistency, not an independent build attestation.

## 2. Candidate comparison

| Consideration | slirp4netns | pasta |
| --- | --- | --- |
| Actual execution here | Verified with upstream static binary | Not installed or executed; evaluated from host package metadata and upstream documentation |
| bubblewrap attachment | Real attachment through pinned network and owning-user-namespace handles passed | Upstream supports existing namespace/user-namespace paths; exact noble package compatibility remains untested |
| Dependencies | Static release worked without host libslirp | Noble package depends only on libc6; package name is passt |
| Preview | Tested dynamic add/remove forwarding API, explicit 127.0.0.1, collision rejection | Explicit address/port mapping documented; automatic forwarding must be disabled in both directions |
| Host loopback | `--disable-host-loopback` tested for specified destinations | `--no-map-gw` / version-dependent mapping controls; disable `-t/-u/-T/-U` auto behavior explicitly |
| Public-only destinations | Not supplied by the tested configuration; own private-host service returned 200 | Gateway controls and forwarding controls are not evidence of a public-only destination ACL |
| Fit for smallest next step | Selected: tested dynamic forwarding, readiness/exit descriptors and static artifact | Reasonable fallback; adds another version/behavior matrix without resolving the egress-policy gap |

The [pasta manual](https://passt.top/builds/latest/web/passt.1.html) describes attaching to existing namespaces, gateway mappings and automatic port behavior; options vary across releases. Do not apply the current manual's complete flag set blindly to the 2024 noble package. [Upstream passt](https://passt.top/passt/about/) describes its standard-C-library dependency and built-in hardening. Neither is a claim that pasta blocks private destinations. Pasta installation was not covered by the user's slirp-only download approval and was not attempted.

## 3. Independent reproduction

Artifacts:

- `docs/investigations/b2-a/slirp_probe.py` — accepts an already verified binary path; contains no download/install logic.
- `docs/investigations/b2-a/results.json` — final real backend run.
- `docs/investigations/b2-a/namespace_preview_probe.py` — separate backend-free isolated networking/preview proof.
- `docs/investigations/b2-a/namespace-preview.json` — final independent preview run.

With the approved binary still in /tmp and namespace/socket creation available:

```sh
python3 docs/investigations/b2-a/slirp_probe.py /tmp/continuum-b2-a-backend/slirp4netns
python3 docs/investigations/b2-a/namespace_preview_probe.py
```

The backend probe has a 60-second outer deadline, 30 CPU-second child limits, 256 child file-descriptor limits, no core dumps, bounded curl output/download sizes, per-operation deadlines, bounded sentinel count and finally-based cleanup. The independent preview probe has a 25-second deadline. Helpers and owner processes were reaped, listeners closed, and namespace handles released. No permanent namespace, daemon, installed binary, or mount was left behind. The downloaded files remain in the named /tmp directory for reproduction; nothing was added to PATH.

The fixture filesystem starts from an empty root with read-only system/runtime/certificate mounts, a read-only synthetic resolver, private scratch, private PID/IPC/UTS namespaces, `--unshare-net`, and dropped application capabilities. Fresh subsequent-command sandboxes inherit only the explicitly joined isolated network. These are disposable fixture mount plans, **not** production sandboxFilesystem verifier coverage. The host-home assertion checks one known hidden path; it is not a complete filesystem audit.

## 4. Actual results and limits

| Test | Real result |
| --- | --- |
| Slirp readiness/TAP with seccomp and IPv6 enabled | Passed |
| DNS in a fresh filesystem-sandboxed subsequent command | getaddrinfo(example.com) succeeded |
| Public HTTPS from that command | https://example.com returned 200, normal certificate validation, no ambient proxy |
| Persistent sandbox server | Started inside bubblewrap at guest TCP 43119 |
| Subsequent separately launched filesystem sandbox | Reached the same server through its isolated namespace loopback, HTTP 200 |
| Host home hidden in fixture | Assertion passed |
| Native selected forward | Verified server-specific random marker through explicit host 127.0.0.1 endpoint |
| Port collision | API rejected a port held by our own listener |
| Forward after subsequent command completion | Still returned the expected marker |
| remove_hostfwd | URL became unreachable |
| Owner termination alone | Helper remained alive: explicit cleanup is required |
| Helper exit descriptor | Closing controlling pipe writer terminated and reaped helper; forward became unreachable |
| Independent authenticated prototype | Correct token returned marker; wrong token 403; closed on explicit teardown |

No npm installation, B1 run-completion integration, Electron UI, packaged-app test, HMR/WebSocket test, expiry/revocation integration or production authorization test was performed. No production build was needed for document/prototype-only changes. Earlier B2 regression/build results remain historical evidence, not fresh B2-A results.

### Address-isolation findings

All local sentinels had a positive control from the host before the namespace attempt. They served only a fixed non-sensitive test string, on ephemeral ports, for the bounded probe. No existing private/admin service or third-party private destination was contacted.

| Destination from guest | Outcome |
| --- | --- |
| 127.0.0.1 host sentinel port | Failed to connect |
| 10.0.2.2 gateway alias to that host sentinel | Failed to connect |
| ::ffff:127.0.0.1 at that port | Failed to connect |
| 10.0.2.3 DNS alias at our non-DNS sentinel port bound to 127.0.0.53 | Failed to connect |
| ::1 host sentinel port | Failed to connect |
| fd00::2 gateway alias at that port | Failed to connect |
| fd00::3 DNS alias at that port | Failed to connect |
| This host's own private IPv4 interface address | **HTTP 200: private-host access allowed** |
| IPv4-mapped IPv6 spelling of that private address | **HTTP 200: private-host access allowed** |

Connection failures describe these exact cases; they do not establish a comprehensive deny policy. IPv4-mapped IPv6 syntax may be normalized by the client/kernel, so the 200 is not proof that traffic traversed the IPv6 transport. Public IPv6 HTTPS, private IPv6 ULA/link-local services, the complete loopback ranges, RFC1918 ranges beyond our controlled host address, CGNAT, metadata/link-local, multicast, unspecified/reserved ranges, IPv6 transition/NAT64 forms, DNS rebinding and redirects are **not verified**. Other than our own sentinel, private ranges were deliberately not probed. Lack of reachable targets must not be interpreted as enforcement.

The [slirp manual](https://github.com/rootless-containers/slirp4netns/blob/master/slirp4netns.1.md) warns about loopback aliases, including DNS handling. Our negative non-DNS alias result with this release does not remove the need for version-specific DNS policy. A future policy must enforce the actual destination for every connection, including redirects and DNS changes, distinguish guest-local communication from host-local aliases, restrict host-owned public addresses as well as private ones, and cover IPv6 before enabling it. Neither transport flag set currently meets that requirement.

## 5. Stable ownership and development previews

An initial join through `/proc/<bwrap-child-pid>/ns/user` succeeded immediately after startup but later failed at network setns with EPERM. Pinning `/proc/<child>/ns/net` and deriving its actual owning user namespace with `NS_GET_USERNS` (`ioctl` 0xb701) solved the race in the fixture. The final probes inherit those descriptors into short-lived trusted nsenter processes; they do not resolve a caller-selected PID at every request.

Recommended integration ownership: a lazy main-process object keyed by authorized session + canonical workspace, holding namespace descriptors, a helper exit pipe, helper handle and bounded command references. Namespace authority must be created by the trusted executor, never a model PID/path. Keep handles out of renderer/tool responses and guest inheritance. Recheck authorization before joining, and make every command create a fresh filesystem/PID/capability sandbox after entering only the intended network context. Retain `--unshare-net` on namespace creation; no production launch flag was removed here.

Joining through a trusted helper is not permission to expose a general `nsenter` tool. Production needs a checked descriptor-launch mechanism and the existing filesystem-plan verifier updated narrowly for it. Validate hostile child attempts to obtain the owning user namespace or alter its routes/filter before accepting this design as a boundary.

Slirp's native forward API works for a server on the guest interface address; the tested server bound 0.0.0.0 **inside its isolated namespace**. The host listener explicitly bound 127.0.0.1. No port was automatically forwarded. A server binding only guest 127.0.0.1 needs a namespace-local relay or trusted namespace request bridge; the separate prototype demonstrates the latter for bounded HTTP GET only.

The native forward itself is unauthenticated. The separate Python token gate demonstrates feasibility, not browser security or production proxy quality. It starts a fresh nsenter/curl per request and does not implement streaming, HMR, WebSockets, cookies, origin checks, concurrency control or secret-safe URL handling. Do not ship it. A production gateway must own its listening socket, authenticate local clients and protect the upstream against direct local bypass. A raw loopback upstream port behind an authenticated gateway is still accessible to other local processes. Cross-session/workspace access and stale authority need explicit rejection, not just random ports.

## 6. Helper lifecycle and hardening

The helper's `--enable-sandbox` failed with `setegid(0)` / `parent failed` against this bubblewrap namespace setup. Changing the fixture's requested application UID/GID to 0 did not resolve it. The successful run deliberately omitted that optional helper mount sandbox and retained `--enable-seccomp`. Bubblewrap application containment remained enabled. The precise helper user-mapping fix needs verification; do not silently drop helper hardening in production or report this configuration as fully hardened.

Closing the exit pipe worked; writing a byte without closing it did not terminate the helper in an earlier attempt. Owner termination alone did not stop it because pinned descriptors and TAP ownership can keep the namespace alive. Production must close previews, signal/close the helper exit channel, wait/reap with bounded TERM/KILL fallback, release handles and cancel member commands on expiry, revocation, Stop, session termination and application shutdown. Parent crash, aborted setup and helper crash need separate tests. Losing a helper must fail networking closed and invalidate preview URLs. Process/cgroup/memory limits and connection budgets need production ownership; the fixture's small workload is not a denial-of-service assessment.

## 7. Packaged supply strategy

For a deb, an explicit supported system slirp dependency is possible, but noble's candidate is older than the tested release and requires libslirp. Validate the exact distro version plus security updates; do not treat any executable named slirp4netns on user/workspace PATH as trusted.

For AppImage and consistent deb behavior, prefer a pinned per-architecture static helper in electron-builder `extraResources`, outside asar, selected by trusted application resource path. The current package.json does not package this helper. The tested x86-64 binary removes dynamic libslirp requirements; aarch64 and other targets require separate artifact checks and acceptance runs. Preserve executable mode, verify artifact provenance/checksums at build time, include relevant GPL-2.0-or-later and dependency notices/source obligations, track security updates, and test AppImage confinement/AppArmor/user namespaces and `/dev/net/tun` on supported distributions. No setuid, sudo at runtime, host firewall modification or silent package installation should be required. If prerequisites fail, keep Development unavailable with a precise error.

## 8. Actionable next task and decision gate

The missing-helper blocker is resolved for feasibility. The immediate blocker is now **reproduced private-host reachability**, plus the unresolved optional helper sandbox mapping. Switching to pasta does not by itself resolve either the destination-policy requirement or authenticated preview ownership.

Smallest next production task: add a disabled-by-default, independently tested network-owner adapter with trusted namespace descriptors and bounded helper cleanup, callable only from internal test fixtures. Keep all user Workspace Write commands on their existing isolated path until the adapter has a verified egress gate. Do not add settings, model tools or preview UI yet.

Before wiring Development execution, establish the gate in a disposable namespace: evaluate a fail-closed namespace-local packet filter owned by a trusted parent user namespace (or a helper-level destination filter), with application children unable to modify it. This is a candidate, not a verified solution. If using a namespace filter, never mutate host rules; derive public/special-address handling from maintained address data, allow only the intended DNS path and guest-local services, block host-address aliases, and test IPv6/mapped/redirect/rebinding cases. Kill networking on any filter setup/update failure. Host network changes require separate authorization and are not an acceptable dependency for this task.

Acceptance for that next slice: public HTTPS/DNS still work; this exact private-host sentinel changes from 200 to denied; IPv4 and IPv6 special-address and DNS/redirect tests pass; hostile commands cannot remove/bypass the policy; helper setup/teardown is repeatable without leaks. Until those pass, the candidate is a working rootless transport, **not a controlled Workspace Write backend ready for production**.
