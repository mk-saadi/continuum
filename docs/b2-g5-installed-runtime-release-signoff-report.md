# B2-G.5 — installed runtime acceptance and release sign-off

November 3–4, 2026 · Asia/Dhaka · Linux x86-64.

**Production Trusted Development remains disabled. Release authorization is pending.** This stage closes the normal FUSE-backed AppImage launch gap, demonstrates enabled packaged networking with real native consent, and fixes an actual packaged worker-start defect. Actual installed deb acceptance still requires a disposable full Linux system. The release checklist records required human decisions without supplying signatures or appointing a maintainer.

## Repository preservation and change

Git status was inspected before changes: 27 tracked modified files and 64 untracked status entries (91 entries total). The exact initial status and content hashes are preserved in `/tmp/continuum-b2g5/initial-status.txt` and `initial-sha256.json`, with the initial status embedded in the adjacent evidence JSON. Existing B2 implementation and unrelated UI/chart work were retained. All eleven requested handoff reports, relevant evidence and implementation were reviewed.

The only pre-existing application file changed is `src/main/networkExecution.js`. Its Python worker spawn previously used `path.dirname(__dirname)` as cwd. In packaged Electron that is a virtual path inside `app.asar`; the actual OS spawn failed with `ENOTDIR`. The worker now starts at `/`, using its existing absolute worker/resource paths. No authorization, sandbox, namespace, cgroup, consent or host-execution policy is weakened. The failing packaged request and successful rebuilt packaged DNS/TLS/npm/Vite requests supply regression evidence.

New engineering artifacts are the offline `scripts/qualify-workspace-network.cjs`, recipient `scripts/relink-workspace-network-helper.py`, normal-AppImage/qualification-boundary/workflow UI fixtures, qualification boundary unit tests, and the PID-matched native-dialog helper. The report, evidence and release checklist are new. Final preservation comparison and exact paths are in the evidence.

No commit, push, stash, reset, clean, primary-system installation, host firewall/sysctl change, live conversation/profile modification, unrelated MCP launch or unrelated process termination occurred. Test application homes/profiles, package outputs and workspaces are task-owned `/tmp` directories. Child HOME supplies that child's disposable home; the invoking shell's HOME is unchanged. Original G.4/release artifacts are preserved.

## Candidate and source/relink review

The exact G.4 candidate helper was rehashed as `dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980`; the review archive rehashed as `676fcef46f406b7511c64f638114a45dd9f38951899e3461e0d7e2c53e0e5225`. Both original package digests also match their G.4 record. All 91 material hashes were independently checked directly against the archive-contained SHA256SUMS. Active `src`/`scripts` paths contain no old upstream helper digest.

Inventory: slirp4netns 1.3.7/Parson; libslirp 4.9.7; GLib `2.72.4-0ubuntu2.10`; libseccomp `2.5.3-2ubuntu3~22.04.1`; glibc `2.35-0ubuntu3.15`; GCC runtime `11.4.0-1ubuntu1~22.04.3`. libcap `1:2.44-1ubuntu0.22.04.3` is a build/header input, not a linked static library. Eighteen actual link inputs are individually identified and hashed. Upstream archives, exact distro originals/patches/descriptors, generated trees, link map, application objects, static libraries, notices and license texts are present. Manifest, owner/audit helper pins and the independently pinned review archive agree.

A technical handoff omission was improved with a standalone recipient relink script. It verifies original inventory inputs, follows actual link-map order including startup objects and runtime groups, and accepts explicit replacement static archives without treating a replacement as a release-approved helper. Running it in the preserved matching Ubuntu build rootfs reproduced the exact selected stripped helper. The explicit replacement interface was exercised using the original GLib archive as a positive control; no modified-library functional result is claimed. Existing static glibc NSS warnings remain; this is not universal AppImage portability evidence.

The new script is a separate repository addendum, **not a modification of the pinned G.4 review archive**. Review and distribution must include that addendum if relying on it. Exact source provenance/build parameters remain in `b2-g4-helper-candidate.json`. Corresponding-source sufficiency/delivery, static LGPL relinking obligations, embedded per-file notices and GCC runtime exception treatment require responsible human review. No legal conclusion is asserted. The checklist explicitly leaves approver, date and accepted maintenance responsibility unfilled.

## Evidence levels and package identities

| Level | G.5 result |
| --- | --- |
| Source tree | Real networking/security/browser/lifecycle regression selection passed; separate from package results |
| Extracted resources/archive | Closed and qualification bundles pass pinned payload/material audits; no installed claim |
| Normally launched AppImage | Original G.4 and rebuilt G.5 closed-gate packages each passed two FUSE-backed GUI launches |
| Actually installed deb | Not run: no suitable disposable installed-system environment available |
| Enabled packaged networking | Separate NONRELEASE qualification AppImage passed native consent, protected restart, npm/Vite and native Chrome/HMR checks; detailed UI/fault status below/evidence |
| Production release approved | No: materials approval and maintenance acceptance absent; gate closed |

Artifacts (all NONRELEASE):

| Artifact | SHA-256 |
| --- | --- |
| Original G.4 AppImage | `ef47bff5d600cc9ca94d5493d90dbfc811c41f93fc4cde223ddd4c54c8bc3de0` |
| Original G.4 deb | `5aa4849b1d837d7d100d33c3bcf89138373ab0de2d093fe801e5ac85f26741a8` |
| Fixed G.5 closed AppImage | `292c007dac5f30e084ad168e022c6f869fa618396a62c13b739dd2423dd66b0f` |
| Fixed G.5 closed deb | `5780b4081baa528c587d9d0d0f64d43399cca4b38d5c74c319cb310bb010af65` |
| Earlier G.5 qualification timing fixture (superseded) | `13d2fa8fd5aaa7b00a386959ce338ed4811888f600a14f04ea54d486c7e4513d` |
| Final immutable-mount G.5 qualification AppImage | `5c781aecb7fddfdc222d992d7f9ae4545806023fcdc9a8599dac8bd5f2af8cd0` |

Full locations, byte sizes, ASAR identities and launch resource paths are in the evidence. The initial qualification package retained the ENOTDIR defect and is not the successful fixed artifact.

## Normal launch and disposable installed-system availability

Normal AppImage invocation now occurs directly, without the earlier mount wrapper. Each application gets a disposable user-data directory, child home and XDG directories. The real packaged main process, renderer/preload/native IPC, outside-ASAR worker/helper resolution, manifest checks, helper digest/mode, Isolated default, accurate unavailable status and rejected activation were observed. `/proc/self/mountinfo` identifies an actual `fuse.*AppImage` mount. Chromium sandbox was explicitly enabled; effective argv contains no `--no-sandbox`. Both restart launches shut down and their exact FUSE mount paths disappeared.

An initial attempt exposed Playwright's default addition of `--no-sandbox`; that run was rejected as acceptance, the harness was corrected with `chromiumSandbox:true`, and final launches passed. No host security workaround was used.

The real host has FUSE, TAP and KVM devices and a systemd user manager, but no available `qemu-system-x86_64`, libvirt/virsh, VirtualBox, machinectl/systemd-nspawn, Docker or Podman execution environment was found. QEMU package status is residual configuration only; systemd-container is not installed. KVM device presence alone supplies no disposable OS image, installed system, GUI login/session or qualified guest utilities. No suitable already provisioned VM/system was identified. The Ubuntu build rootfs is not an installed-system acceptance target. No missing packages were installed on the primary OS, and the deb was not installed there. A disposable full Pop!_OS/Ubuntu-compatible system with the declared tools, namespaces/TAP/nft, systemd user session, delegated cgroup v2 and display remains required.

## Non-distributable qualification mechanism

The offline derivation script copies a complete audited package into a fresh private `/tmp` directory. It verifies current selected application-source bytes against the source ASAR, helper/material pins, and only modifies the copied archive: the policy export calls a generated qualification module, and main adds a visible NONRELEASE banner/name. The actual singleton networking/preview services and resolver remain the packaged implementations. Normal source and build configuration do not import this script or contain the generated module.

Eligibility is hardwired to that one private root, exact disposable home/profile, exact helper/review pins and a 24-hour deadline. It requires a kernel-confirmed read-only FUSE mount. Full helper/review/material checks run once for that immutable mount; the real default backend independently revalidates its resource manifest and prerequisites at every owner startup. Expiry and the exact private profile/home boundary remain checked on each readiness call. This avoids repeated 124 MB hashes and seven synchronous probes on the 50 ms preview monitor. It reports `productionQualified:false` and `qualificationOnly:true`. There is no runtime environment/renderer/manifest switch to waive the production decision. A real wrong-profile launch rejects activation; deterministic expiry rejection is also checked. Native confirmation, safeStorage, command guard/approval, filesystem verification, launch permits and effective cgroups remain required.

Qualification archive identity and changed-file comparison are recorded in evidence. The original/fixed closed builds retain the exact source readiness gate and contain no generated qualification module. These temporary fixture artifacts must not be distributed. Their existence is not redistribution authorization or production entitlement. Early qualification timing fixtures performed the heavy audit on every readiness call and starved the main event loop; their timing/OOM claims are superseded. The final fixture corrects only this test-build behavior; the shipping gate is unchanged.

## Enabled packaged workflow and limits

The fixed qualification AppImage is normally FUSE-launched, with sandbox enabled and the actual packaged backend. Fresh Isolated default and accurate Trusted Development disclosure were verified. The real PID-matched native warning was cancelled, leaving Isolated; it was then accepted through native UI. No dialog result, readiness service or protected receipt was injected. Electron selected `gnome_libsecret` with encryption available, wrote its own protected receipt, and restored Trusted Development after application restart. Reverting to Isolated uses the actual trusted setter.

Native Workspace Write commands use the actual packaged `guardTool` and dispatcher. The harness supplies explicit trusted command-approval decisions through the normal approval callback; it does not drive an LLM turn or claim autonomous command approval UI coverage. No permissions are disabled and Full Access is never selected.

Real HTTPS/DNS with certificate validation passed. Real npm downloaded Vite 6.4.3 and is-number 7.0.0 into a disposable project, producing node_modules and package-lock. The enabled postinstall script asserted that a controlled host-home sentinel was inaccessible and wrote observed sandbox HOME `/sandbox-home` and npm cache `/tmp/continuum-cache/npm`. Workspace-local writes persisted.

Standard Vite ran as a B1 persistent command with a finite lifetime. A subsequent authorized command reached it; normal successful run completion retained it, and a later run reused authorized access. Effective kernel scope values were read as memory.max `1073741824`, memory.swap.max `0`, pids.max `128`, cpu.max `200000 100000`, memory.oom.group `1`.

The packaged authenticated gateway was created via real preview IPC. Native Open used the real shell/browser handoff, routed by disposable child browser configuration into a separate Chrome profile. JavaScript, CSS (`rgb(1,2,3)`), client route/reload, same-origin WebSocket connection and source-edit HMR all passed. Credential-free HTTP remained 403. Stop returned the network singleton to zero active owners and Isolated reversion passed. This core run is recorded independently of later visible-card/fault follow-ups; it does not by itself count as Background Commands button coverage.

Final visible-card, fault, active-shutdown/restart and cleanup results are enumerated in the adjacent evidence and final acceptance addendum below. Any condition not marked passed there remains unaccepted. Source-tree OOM/crash/lifecycle successes do not replace missing packaged results.

## Verification and release decision

The main serial regression selection passed 118 tests with zero failure/cancellation/skip. It covers B1, real B2-D dispatch/launch authority, B2-E dependencies, authenticated gateway/browser/IPC, real isolated Vite and package downloads, G.2 trust, G.3 runtime/package checks, G.4 assembly, W7/socket/filesystem/Git relay, native permissions/isolation and Casual Chat. Separate Python suites passed 5 owner/security, 4 policy and 2 resource groups. Existing Electron settings and Background Commands renderer fixtures passed. Focused qualification-boundary results and final validation are recorded in evidence; overlapping reruns are not added as distinct groups.

Production Vite build passed with its existing large-chunk warning. Complete fixed NONRELEASE AppImage and deb builds succeeded. A first restricted build could not resolve build downloads; the host retry succeeded. JS/Python/JSON and whitespace results are recorded in evidence.

The exercised candidate target is Pop!_OS 24.04 LTS x86-64, kernel `6.17.9-76061709-generic`, normal systemd 255 user manager and delegated unified cgroup memory/pids/cpu controls. Conservative tool floors remain those in networkRuntimePrerequisites.js. No production-supported platform is declared by this work. External IPv6 remains unsupported/blocked. Trusted Development may reach host-local/LAN/VPN/private IPv4 services as explicitly disclosed; the old public-only guarantee is not revived.

**Release decision: pending, activation disabled.** Required remaining decisions include exact-material redistribution/source-delivery approval, accepted helper/library/policy security ownership, actual installed deb acceptance, and any incomplete packaged matrix items named in the final addendum. The address-policy December 3, 2026 UTC deadline is unchanged. No human approval or success entitlement was encoded as true. Review `b2-g5-release-decision-checklist.md` together with the artifact-pinned evidence before any future release transition.

## Reproduction and review handoff

Verify the recorded artifact digests before using these temporary paths. A new session must not assume `/tmp` materials survive.

```sh
node tests/b2g5AppImage.ui.cjs /tmp/continuum-b2g5/fixed-packages/Continuum-B2G5-NONRELEASE-1.0.0-x86_64.AppImage
node scripts/qualify-workspace-network.cjs /tmp/continuum-b2g5/fixed-packages/linux-unpacked /tmp/NEW-PRIVATE-QUALIFICATION
node node_modules/electron-builder/cli.js --prepackaged /tmp/NEW-PRIVATE-QUALIFICATION/app --linux AppImage --x64 --config.directories.output=/tmp/NEW-QUALIFICATION-PACKAGES '--config.artifactName=Continuum-B2G5-NONRELEASE-QUALIFICATION-${version}-${arch}.${ext}'
node tests/b2g5Workflow.ui.cjs /tmp/NEW-QUALIFICATION-PACKAGES/CANDIDATE.AppImage /tmp/NEW-PRIVATE-QUALIFICATION/QUALIFICATION.json
node tests/b2g5Lifecycle.ui.cjs /tmp/NEW-QUALIFICATION-PACKAGES/CANDIDATE.AppImage /tmp/NEW-PRIVATE-QUALIFICATION/QUALIFICATION.json
```

Use explicitly NONRELEASE artifact names when invoking the builder (as in the G.5 build logs); the generated application also carries a visible NONRELEASE banner/name. Fresh-default tests require a newly derived profile; do not substitute a user's existing home/profile or reset any existing user data. The fixtures need the declared host facilities, an X11 display/libXtst for real native-dialog automation, OS-protected settings storage and installed Chrome. Native dialog input is restricted by exact title, mapped-window state and the owned main PID. Browser handler/mime configuration exists only in the disposable child environment; handoff tokens are not logged.

Inside the matching disposable build toolchain, recipient relinking is:

```sh
python3 relink-workspace-network-helper.py /review/materials /tmp/NEW-RELINKED-HELPER
python3 relink-workspace-network-helper.py /review/materials /tmp/NEW-RELINKED-HELPER-WITH-LIBRARY --replace libglib-2.0.a=/absolute/rebuilt/libglib-2.0.a
```

The script refuses existing outputs, verifies original saved-input hashes before replacement, preserves map order and prints the output digest. Replacement outputs are technical recipient artifacts, never automatically accepted by Continuum. The G.4 source-build recipe and inventory identify the matching GCC/binutils/rootfs; host compiler substitution is not claimed reproducible.


## Final acceptance addendum

The final qualification AppImage `5c781aec…f8cd0` passed the actual visible Workspace UI/Background Commands card flow. Native consent cancel/accept, protected restart, real npm installation, standard Vite, normal-completion survival/later access, Create Preview, native Open into disposable Chrome, JavaScript/CSS, route/reload, WebSocket HMR, and card Stop passed. Stop closed both credential-free and previously authenticated Chrome access. A host-side bind-only probe, without listening or contacting another service, confirmed raw host TCP 127.0.0.1:5173 was absent while guest Vite served that port. Packaged namespace-handle absence, denied nft mutation and a denied external IPv6 request were also checked; exhaustive policy negatives remain source-tree coverage.

The final same-artifact lifecycle matrix passed **10/10**: finite expiry, permission-mode revocation, session termination, session deletion, worker SIGKILL, helper SIGKILL, owner SIGKILL, controlled allocation exceeding the verified 1 GiB scope, live switch to Isolated, and active application shutdown/restart. Every injected fault required a still-running disposable server and resolved the actual packaged worker's cgroup. Captured scope PIDs exited, each scope directory disappeared, preview access closed and both registries emptied. The OOM scenario completed before the server lifetime; no kernel `oom_kill` counter value is claimed. Restart restored the protected choice but no server/preview authority, and the old preview command was rejected. The final choice returned to Isolated.

Earlier timing fixtures are not counted toward those final 10 cases. Source-tree fault tests, the earlier eight-case loop and final ten-case loop overlap; they are separate evidence levels and reruns, not additive unique-test totals. The final negative-profile launch and two expiry/output/profile boundary groups passed against the final generated archive. Closed resource audits, final qualification archive comparison and extracted fixed deb audit passed; the normal closed ASAR contains no qualification module. Only main.js, the policy export and the generated fixture module differ in the qualification ASAR.

**Remaining blockers are exactly installed deb qualification, responsible approval of redistribution/source/relink delivery, and accepted security maintenance ownership.** Overall engineering qualification remains incomplete because the deb was not installed in a disposable supported system. AppImage technical qualification is distinct from release authorization. No production release was activated. Initial file preservation found only the intended networkExecution.js change and no missing pre-existing tracked/untracked file. Detailed final cleanup/validation records and any non-goal limits are in the evidence JSON.
