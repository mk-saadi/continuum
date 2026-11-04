# B2-G.4 — traceable helper and complete non-release packages

November 3, 2026 · Asia/Dhaka.

**Trusted Development remains disabled. B2-G.4 is not release-complete.** This task built and repinned a source-accounted replacement helper, assembled its sources/notices/relink review package, implemented deterministic resource assembly, built complete NONRELEASE AppImage/deb fixtures, and launched their extracted GUIs. Release approval and actual enabled installed-package acceptance remain outstanding. These fixtures must not be distributed as qualified releases.

## Repository preservation and exact changes

Read the ten handoffs in order, inspected relevant evidence, current worker/owner, resolver, policy, consent, B1, preview integration, tests and Electron Builder configuration. No applicable project AGENTS.md was found outside dependencies. Initial status: **27 modified tracked files, 66 untracked paths** with `-uall`. The complete initial status is in the adjacent evidence JSON. Initial content hashes are retained at `/tmp/continuum-b2g4/initial-sha256.json`.

Only three pre-existing files differ from that initial content snapshot:

- `src/main/experimental/network_owner.py`: replace the independent helper SHA-256 with the new candidate identity.
- `scripts/audit-workspace-network.cjs`: match that identity, check the independently pinned source/relink archive, expose review-material integrity separately from payload integrity and release qualification.
- `tests/b2g3Packaging.test.cjs`: update the helper-pin diagnostic assertion to describe the replacement rather than an upstream-built binary.

New files:

- `scripts/rebuild-workspace-network-helper.sh`: actual source-build recipe with final linker map, verbose link inputs, generated build trees and stripped/unstripped artifacts.
- `scripts/collect-workspace-network-build.py`: attribute actual linker inputs to exact distro packages/sources; copy link inputs and notices; request corresponding source versions.
- `scripts/assemble-workspace-network.cjs`: deterministic fresh-byte manifest assembly; independently pinned helper/review archive; nonsymlink regular input validation; executable/ELF checks; no overwrite; fixture output restricted to temporary storage. Release assembly always refuses until release qualification is reviewed.
- `scripts/workspace-network-staging.cjs`: separate Electron Builder NONRELEASE configuration with outside-ASAR resources, prerequisite deb metadata and a final afterPack integrity check. Normal `npm run dist` is unchanged.
- `tests/b2g4Assembly.test.cjs`: four focused assembly/material-integrity groups.
- `tests/b2g4Packaged.ui.cjs`: actual packaged GUI/default/restart/native rejection tests with complete resources and no backend, readiness, storage or IPC substitution.
- `docs/b2-g4-helper-candidate.json`: exact input/source/archive digests, package attribution, build parameters and review blockers.
- This report and `docs/b2-g4-networking-release-completion-evidence.json`.

Every other initial tracked/untracked file remained byte-identical; none disappeared. Existing `release/` outputs were preserved. No commit, push, stash, reset, clean, primary-system package install, host firewall/sysctl change, live conversation/settings edit, unrelated process termination or unrelated MCP launch occurred. Electron Builder rebuilt its existing project native dependencies as usual. Builds, rootfs, profiles and disposable projects used `/tmp/continuum-b2g4` or fixture-created temporary directories.

## Helper selection and actual build

Re-downloaded the [official v1.3.7 helper](https://github.com/rootless-containers/slirp4netns/releases/tag/v1.3.7) and SHA256SUMS. Their bytes match the historical binary `1c177694…d53e70` and checksum-file `5174aaf8…591fb3`. Retrieved pinned source, Docker recipe, reproducible-sources script and upstream job metadata. The GitHub Actions logs-download endpoint returned HTTP 403 without credentials. The upstream binary's complete exact static closure was not established; it is **not** the selected artifact for new builds.

Used the permitted fallback: an unprivileged bubblewrap user/PID/mount namespace containing Ubuntu Base 22.04.5 amd64. Installed build dependencies **only inside that disposable rootfs** from signed Ubuntu snapshot metadata at `https://snapshot.ubuntu.com/ubuntu/20261030T000000Z/`, suites jammy/jammy-updates/jammy-security, main/universe. Host root, Docker, global installs, sysctl changes and a custom compiler/toolchain were unnecessary. TLS validation remained enabled. A first apt attempt could not map `_apt` in the single-UID namespace; retry used apt's namespace-root download user, still the ordinary host UID.

Selected sources and exact distro inputs:

| Component | Exact identity | Evidence/material |
| --- | --- | --- |
| slirp4netns | 1.3.7, commit `7ea080d8635bc85487e232ec178701c6864151c9` | Pinned source archive, all source headers, COPYING, generated objects/configuration |
| vendored Parson | Bytes in that slirp4netns revision | `vendor/parson` source and MIT LICENSE; actual `libparson.a` link input |
| libslirp | 4.9.7, commit `ce12dcddf710a71dc0de6450ec95edbadf8e9f66` | [Upstream tag metadata](https://gitlab.freedesktop.org/slirp/libslirp/-/tags/v4.9.7), source, LICENSE/COPYRIGHT, built static archive |
| GLib | `2.72.4-0ubuntu2.10` | Exact glib2.0 source package and distro copyright notice; linked `libglib-2.0.a` |
| libseccomp | `2.5.3-2ubuntu3~22.04.1` | Exact source package/notice; linked static archive |
| glibc | `2.35-0ubuntu3.15` | Exact source/notice; libc, startup objects, pthread archive |
| GCC runtime/compiler | `11.4.0-1ubuntu1~22.04.3` | Exact gcc-11 sources/notice including runtime exception text; libgcc/libgcc_eh and compiler startup objects |
| libcap | `1:2.44-1ubuntu0.22.04.3` | Configure/header build dependency; source/notice included; **not linked** by this source's LDADD/final link map |

The actual final link map records 18 unique input paths with SHA-256, not just a version-banner inventory. Source archives for the five distro source packages, including patches and `.dsc` files, were downloaded. Every source file listed in those five `.dsc` SHA-256 sections matched its recorded size/digest. No additional static transitive archive appears in this candidate's recorded link map. Full per-file source notices remain available in the source archives; their legal treatment is for review.

Build dependencies and their installed versions are recorded in `materials/packages.tsv`. Compiler: GCC 11.4.0; binutils 2.38 distro build. libslirp used Meson `--default-library=both --prefix=/usr/local`. slirp used `--host=x86_64-linux-gnu`, static linking, final `--cref` map and `-t` linker trace. `SOURCE_DATE_EPOCH=1793371908`. Configure/build logs, Makefile/config.status/config.log and generated build trees are supplied.

Two clean source builds at the same logical `/build` path produced identical stripped **and** unstripped binaries. A separate link using the saved application objects/static libraries also reproduced the identical stripped binary. This is repeatability on one host/rootfs, **not independent reproduction of the original upstream ELF**.

| Artifact | SHA-256 |
| --- | --- |
| Selected stripped helper | `dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980` |
| Unstripped helper | `a7ac4c31440b085b6263ea8043878ef89f932fb37fd51846f129f549be8b760c` |
| slirp4netns source archive | `26337b2ab119f7e64855e4617e91cf1fa7faeacd50329b4f262033e18e2b083b` |
| libslirp source archive | `d2567fa06a6357c7755d61c67293b2c0bf069b3f2173bde6b76cf768529a1938` |
| Ubuntu Base archive | `242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a` |
| Source/notices/relink review archive | `676fcef46f406b7511c64f638114a45dd9f38951899e3461e0d7e2c53e0e5225` |

All distro source-file hashes and individual linker-input hashes are in the candidate JSON/evidence. The selected helper is a stripped static Linux x86-64 ELF, mode 0755. Its source revision banner is unchanged but its artifact identity is explicitly new in owner, audit and assembler pins. The old ELF is rejected by these new pins.

## Reviewable licensing/source/relink deliverable

Standalone package: `/tmp/continuum-b2g4/helper-review.tar.gz` (123,977,323 bytes). It contains 91 hashed material files plus SHA256SUMS: upstream source archives; exact distro originals/patches/descriptors; component copyright notices, Parson license, slirp COPYING, libslirp LICENSE/COPYRIGHT and common license texts; package/toolchain inventory; build scripts/logs; final link map; preserved objects and generated build trees; complete copied link inputs; stripped/unstripped binary; review-required statement.

This materially resolves the unknown-input problem for the **replacement candidate**. It is not a legal sufficiency determination or redistribution approval. Review must address GPL corresponding-source completeness and delivery, LGPL static relinking for GLib/libseccomp/glibc, applicable embedded-file notices and GCC runtime exception treatment. Saved-object relinking was demonstrated, but that technical success does not decide the legal questions. A security release owner for helper and policy updates has not been assigned.

The static link emits glibc NSS/getaddrinfo/getpwuid warnings about matching runtime shared libraries. Actual exercised DNS/network workflows passed on this host; universal AppImage portability is not claimed. Other runtime targets require independent testing.

## Resource assembly and packages

Final complete fixture layout, outside ASAR in staging and both extracted packages:

```text
resources/workspace-network/
  manifest.json
  NONRELEASE.json
  networkExecutionWorker.py
  networkPreviewBridge.py
  workspaceNetworkAddressPolicy.json
  experimental/network_owner.py
  x64/slirp4netns
  review/helper-review.tar.gz
```

Manifest v1 retains the existing `sha256` map and hashes the five required payloads plus review archive. All final bytes/hashes and helper mode passed verification in all three layouts. The review archive has its own independent code-selected provenance digest; changing its manifest digest cannot hide substituted material. Missing material is flagged separately. The audit always reports `productionQualified:false`. No manifest field, environment setting or fixture marker can activate production readiness.

Assembly rejects modified/substituted helper identity, symlinked input/output parents, missing execute permission, wrong ELF architecture, old output reuse, malformed/missing/modified packaged resources and stale source bytes. G.3/B2-E negatives retain malformed manifests, missing resources, architecture/executable/symlink checks. A rehashed stale Python source still fails the source comparison. A rehashed modified review archive fails the independent archive pin.

Reproduce new fixture assembly/build with the already verified artifacts:

```sh
node scripts/assemble-workspace-network.cjs --fixture \
  /tmp/continuum-b2g4/slirp4netns-candidate \
  /tmp/continuum-b2g4/new-resources \
  /tmp/continuum-b2g4/helper-review.tar.gz
mkdir /tmp/continuum-b2g4/new-packages
B2G4_STAGING_RESOURCES=/tmp/continuum-b2g4/new-resources \
B2G4_STAGING_OUTPUT=/tmp/continuum-b2g4/new-packages \
  node node_modules/electron-builder/cli.js --linux AppImage deb --x64 \
  --config scripts/workspace-network-staging.cjs
```

Both destination directories must be fresh/explicit temporary locations; assembly refuses existing output. These build-time variables are consumed solely by the NONRELEASE builder configuration, never production readiness. Normal packaging has no helper extraResources until review/qualification is complete. No runtime helper download or workspace/PATH helper discovery exists.

Final artifacts under `/tmp/continuum-b2g4/candidate-packages/`:

- `Continuum-B2G4-NONRELEASE-1.0.0-x86_64.AppImage`: 422,026,106 bytes; SHA-256 `ef47bff5d600cc9ca94d5493d90dbfc811c41f93fc4cde223ddd4c54c8bc3de0`.
- `Continuum-B2G4-NONRELEASE-1.0.0-amd64.deb`: 415,854,252 bytes; SHA-256 `5aa4849b1d837d7d100d33c3bcf89138373ab0de2d093fe801e5ac85f26741a8`.

An earlier old-helper fixture build is preserved separately at `/tmp/continuum-b2g4/packages`; it is not final candidate evidence. No prior user release artifact was overwritten.

## Runtime contract and dependency declarations

Initial qualification **candidate**: Pop!_OS 24.04 LTS, Linux x86-64, observed kernel `6.17.9-76061709-generic`, a normal systemd user session with effective delegated unified cgroup memory/pids/cpu controllers. No production-supported target is declared yet; later versions/distributions are not qualified by minimum-version comparison alone.

Fixed-path host probes passed 7/7: Python 3.12.3, bubblewrap 0.11.0, unshare/nsenter util-linux 2.39.3, nftables 1.0.9, iproute2 6.1.0, systemd 255. Fixture deb metadata declares `python3 (>=3.11)`, `util-linux (>=2.39.3)`, `bubblewrap (>=0.11.0)`, `nftables (>=1.0.9)`, `iproute2 (>=6.1.0)`, `systemd (>=255)`, `libpam-systemd (>=255)`, alongside existing GUI dependencies. These declarations were read back from the actual deb control file. Stock distro repositories may not supply the tested bwrap floor; package installation must not silently waive it.

AppImage still requires those absolute host tools and libraries, usable unprivileged user namespaces, `/dev/net/tun`/TAP, namespace-local nftables, helper seccomp/mount sandbox, host netlink monitoring and a working systemd user manager/cgroup-v2 delegation. FUSE is required for the normal mount launcher; extraction is a separate path. No runtime sudo/install/sysctl/firewall repair is introduced. Diagnostics name missing/broken/version prerequisites; feature startup retains actual kernel/cgroup checks and no fallback.

The replacement's real tests verified namespace/TAP/DNS/TLS, namespace-local filter protection, no inherited namespace authority, external IPv6 rejection, mandatory helper sandbox/seccomp and W7 protections. Real worker tests verified MemoryMax 1 GiB, swap 0, TasksMax 128, CPU quota 200% and group OOM. These remain source-tree runtime evidence, not an installed-distribution declaration. Address-policy review expiration remains December 3, 2026 UTC; it was not extended. Trusted Development still permits reachable private/host/LAN/VPN IPv4. The historical public-only host-address limitation was not repaired or reintroduced as a claim.

## Actual packaged acceptance: separate evidence levels

| Check | Staging app | Extracted AppImage | Extracted deb |
| --- | --- | --- | --- |
| Full outside-ASAR payload/material integrity | Passed | Passed | Passed |
| Actual packaged main JS archive integrity/source comparison | Passed | Passed | Passed |
| Actual GUI, two launches with same disposable fresh profile | Passed | Passed | Passed |
| Real packaged dependency resolver, no substituted backend/readiness | Passed | Passed | Passed |
| Isolated default, trust disabled, native activation rejected | Passed | Passed | Passed |
| Enabled native consent/persistence/network workflow | Not run | Not run | Not run |

Each GUI resolved actual `process.resourcesPath/workspace-network` worker/helper paths, opened existing networking settings, rejected the trust setter, restarted, and remained Isolated. Shutdown closed each app; the harness removed its owned disposable home/profile. These are three GUI cases with two launches each, not six independent installed acceptance cases.

Normal AppImage GUI launch in the disposable mount/home wrapper failed before GUI. A matching mount-only wrapper returned `fusermount: mount failed: Operation not permitted`. A separate five-second host mount-only probe succeeded and its exact temporary mount disappeared after timeout (exit 124 expected). This distinguishes wrapper restrictions from host FUSE support; **normal AppImage GUI acceptance is absent**.

The deb was extracted, never installed. No disposable supported installed system with the required systemd user/kernel/cgroup features was provisioned. The Ubuntu build rootfs is not such a system and is not claimed as installation evidence. The primary Continuum installation was untouched.

The release gate correctly prevents packaged native confirmation cancel/accept, protected persistence after enable and real packaged npm/Vite/Chrome/HMR/lifecycle execution. No production readiness injection was used to manufacture those results. Source-tree trusted fixtures are explicitly separate.

## Tests, build and cleanup

- Replacement-helper broad serial Node selection: **120 passed, 0 failed/cancelled/skipped**.
- Final focused integrity/runtime/assembly selection: **11 passed, 0 failed/cancelled/skipped**; ten overlap the broad set, one adds the pinned review-archive group. **121 unique Node groups**, not 131. The four assembly groups are included in the focused 11. An earlier historical-helper 120 run is overlapping baseline evidence, not additional unique coverage.
- Replacement-helper real Python owner security: **5/5**; deterministic policy: **4/4**; resource prerequisites: **2/2**, no failures/skips.
- Existing Electron settings renderer fixture **1/1** and Background Commands/preview fixture **1/1**.
- Actual packaged GUI cases **3/3**, all resource-complete but release-gated. Resource/archive checks **3/3**. Normal AppImage GUI condition failed; installed deb acceptance was not run.
- `npm run build` passed with existing large-chunk warnings. Final JS syntax, Python AST, JSON, shell syntax and `git diff --check` passed. Full logs, digests and detailed counts are in adjacent evidence and `/tmp/continuum-b2g4`.

Broad source-tree tests cover B1, native dispatcher, protected consent/storage, B2 policy/integrity, authenticated gateway/browser/IPC, cgroups, W7/socket/filesystem/Git relay, native modes, Casual Chat and command containment. The replacement installed real Vite 6.4.3 and is-number 7.0.0 through the native Workspace Write dispatcher, plus pnpm, pip six and remote Git fixtures. DNS/TLS, workspace-local package/lockfile writes, isolated caches and lifecycle-script containment passed. Yarn was unavailable and was not tested or counted as supported.

Real source-tree Vite/Chrome checks covered HTTP/assets/CSS/JS/reload/HMR source edit, authenticated handoff, unauthenticated denial and no raw/LAN upstream listener. Persistent commands survived successful completion, supported later authorized inspection and stopped cleanly. Expiry, permission/rule/session revocation, shutdown, worker/owner/helper SIGKILL, parent death and aggregate OOM cleanup passed. These are not packaged user-workflow results.

Intermediate fixture failures are recorded, not counted as passes: initial single-UID apt mapping; an unavailable `require` global in the first GUI harness (corrected using main-process builtin module access); normal AppImage launch restriction. No product validation was disabled to pass a test.

## Exact remaining release blockers and next actions

1. Review and approve the supplied replacement source/notices/relink materials, with a concrete decision on static LGPL/glibc and GCC runtime treatment. Assign helper/policy security update ownership. The materials now exist; do not restart artifact-inventory research from the old upstream binary unless selecting it again.
2. After approval, promote the reviewed assembly into normal release packaging. Keep the new helper digest and source-material digest pinned; verify final bytes/modes again. The existing staging packages remain NONRELEASE.
3. Provision a disposable supported system/VM with the actual user session, kernel features, tools and cgroup delegation. Install the deb there. Exercise normal AppImage GUI launch in a supported environment without the mount wrapper's FUSE restriction and without accessing the primary user's settings.
4. On qualifying packages, complete native consent cancel/accept, protected selection persistence/restart, actual native npm install, Vite/authenticated Chrome/HMR, B1 persistence/Stop/expiry/revocation/shutdown/crash/OOM and stale-authority restart checks. Source-tree passes cannot replace these.
5. Only then implement evidence-backed packaged/runtime/material eligibility in the existing readiness flow. A boolean, manifest assertion, environment override or plain preference remains insufficient.

The current explicit gate is unchanged, so unsupported environments, legacy/missing policy and declined consent remain Isolated. Read Only, Ask for Approval, Full Access and Casual Chat authority are unchanged. No privileged broker, new registry, public tunnel, LAN preview, permission profile or P3 UI was added. **No production build was enabled for Trusted Development.**
