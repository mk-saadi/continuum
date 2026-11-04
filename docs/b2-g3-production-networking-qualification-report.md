# B2-G.3 — production networking qualification remains blocked

November 3, 2026 · Asia/Dhaka.

**Production Trusted Development remains disabled. B2-G.3 is not complete.** This phase adds conservative system-tool version checks, structured resource failures, an offline resource audit, exact-helper provenance research, and actual packaged-GUI acceptance of the closed gate. It does not ship the helper, declare a supported production target, or qualify installed networking. The decisive redistribution blocker is an incomplete exact-build static dependency/source/notice inventory.

## Initial repository and preservation

Read the nine requested B2 handoffs, inspected their evidence JSON and current implementation/tests, and recorded `git status` before editing. Initial state: **18 modified tracked files and 44 untracked status entries**, including the prior B2 implementation and unrelated chart/UI work. The adjacent evidence JSON preserves that status. A SHA-256 snapshot of all initial tracked/untracked files was taken in `/tmp/continuum-b2g3/initial-sha256.json`. Final comparison found only the two intended existing-file changes below; all other initial files remained byte-identical. No existing file was deleted.

No commit, push, stash, reset, clean, system package install, primary-OS deb install, firewall/kernel change, live conversation database/settings edit, or unrelated MCP startup was performed. Builds and temporary profiles/workspaces went under `/tmp`. Previous `release/` artifacts were preserved. Package building used electron-builder's existing native-dependency rebuild and downloaded Electron/build tooling outside the outer network restriction; no networking helper was downloaded or added to PATH.

## Exact changes

Existing files changed:

- `src/main/networkDependencies.js`: require conservative fixed-tool version checks after resource integrity succeeds; reject null/invalid manifest hash maps; translate unexpected resource I/O errors into structured dependency failures.
- `tests/b2eDependencies.test.cjs`: retain resource-only fixtures separately from runtime probing; add malformed manifest shape rejection.

New files:

- `src/main/networkRuntimePrerequisites.js`: bounded absolute-path version probes with no shell, workspace cwd, Python environment inheritance or PATH discovery. Missing, timed-out, unknown and old versions produce named diagnostics. Version success explicitly does not establish runtime qualification.
- `scripts/audit-workspace-network.cjs`: offline final-payload/source/hash/ELF/execute-bit/pin audit, with explicit license/source/installed-acceptance blockers. No staging, helper execution, download, readiness override or production import. Exit 1 means unqualified; its JSON distinguishes payload integrity from release qualification.
- `tests/b2g3Runtime.test.cjs`, `tests/b2g3Packaging.test.cjs`: negative prerequisites, unsupported platform/architecture/source tree, substituted helper, stale source, symlink, malformed manifest, executable permission and incomplete-compliance checks.
- `tests/b2g3Packaged.ui.cjs`: actual packaged-app GUI test with no backend/readiness/storage substitution. Uses a fresh profile and a disposable bubblewrap home mount because MCP/skills also derive paths from `os.homedir()`. Does not repurpose HOME. Tests real preload/native IPC and UI rejection while gated.
- `docs/b2-g3-helper-provenance.json`: exact artifact, upstream build-input bytes/digests, partial inventory and unresolved redistribution requirements.
- This report and `docs/b2-g3-production-networking-qualification-evidence.json`.

No networking policy, mounts used by Workspace Write, process authority, B1 registry, consent mechanism, permission mode, preview implementation or renderer component was changed.

## Helper provenance and redistribution blocker

Rechecked `/tmp/continuum-b2-a-backend/slirp4netns`, not merely its name. It is a stripped, static, little-endian ELF64 x86-64 executable, mode 0700 in its original fixture location. SHA-256 is `1c177694fe6bf299debfd8ff601a2ee3c4f7554d9983acdf1f854a6b34d53e70`. The existing SHA256SUMS file hashes to `5174aaf82bce5adedcda870504e147fff967d8b5e3e8fcd5664f1de7f7591fb3`, matching the [upstream v1.3.7 release](https://github.com/rootless-containers/slirp4netns/releases/tag/v1.3.7). Version output reports commit `7ea080d8635bc85487e232ec178701c6864151c9`, libslirp 4.9.7 and libseccomp 2.5.3. This establishes release consistency, not independent reproduction or an attestation.

Retrieved the pinned [Dockerfile.artifact](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/Dockerfile.artifact) and [configure.ac](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/configure.ac). Their bytes/digests are recorded in provenance. The recipe uses Ubuntu jammy-20261020, static linking, distro development libraries, and libslirp v4.9.7. Configure directly requires GLib, libslirp, libcap and libseccomp. The version banner alone therefore omits relevant dependencies. Exact GLib/libcap/glibc/compiler runtime versions and static transitive objects are still unestablished; no complete link map, corresponding Ubuntu source-package set, or reproducible source bundle was assembled.

The pinned helper's [COPYING](https://raw.githubusercontent.com/rootless-containers/slirp4netns/v1.3.7/COPYING) is GPL v2 text (retrieved/hash recorded; the prior handoff identified GPL-2.0-or-later source headers). [libseccomp](https://github.com/seccomp/libseccomp) identifies LGPL-2.1; [GLib](https://gnome.pages.gitlab.gnome.org/gtk/glib/) identifies LGPL-2.1-or-later. These project-level identifications are **not** an exact-build per-file notice inventory or a legal compliance determination. libslirp/libcap, libc, compiler/static transitive components and their notices still need exact-source inspection. No claim that a single GPL notice covers the binary is made.

Required before redistribution: obtain exact source/build inputs for every included component; preserve copyright and license notices/texts; determine GPL corresponding-source and applicable static LGPL relinking/material requirements against that actual build; supply those materials with the release or obtain a legally reviewed compliant distribution mechanism. Source/build archive SHA-256 values must then accompany the binary pin. The recipe hashes here are not corresponding-source checksums. No source offer was invented and no binary-only payload was shipped.

Proposed maintenance procedure: the release maintainer must explicitly accept security ownership; watch slirp4netns/libslirp/libseccomp and the exact distro library advisories at each release and on security notifications; inventory affected embedded versions; rebuild or verify a patched upstream artifact; archive source, notices, build recipe and hashes; update both independent owner pin and build-time audit pin in review; regenerate final resource manifest; rerun security/runtime/browser/packaged acceptance; withdraw affected releases when required. Ownership and a response SLA remain unassigned, so this is a procedure, not an operating monitoring service.

## Packaging configuration and resources

Electron Builder still uses the existing AppImage/deb configuration. **No `extraResources` or mandatory deb networking dependencies were added**, because including the binary before resolving the inventory/source blocker would violate the requested distribution contract. These are development builds of a gated feature. The deb still declares the existing GUI/library dependencies; it does not declare python3, util-linux, bubblewrap, nftables, iproute2 or systemd for networking. It cannot be called a networking-ready package.

The resolver's required eventual outside-ASAR layout remains:

```text
resources/workspace-network/
  manifest.json
  networkExecutionWorker.py
  networkPreviewBridge.py
  workspaceNetworkAddressPolicy.json
  experimental/network_owner.py
  x64/slirp4netns
```

Manifest schema remains `{version:1, sha256:{"relative-path":"sha256"}}`, covering all five payloads. Required license/notices/source materials must accompany the eventual distribution. No workspace manifest is accepted. No runtime executable download or PATH-selected helper is introduced. The Python owner's independently pinned helper identity and mandatory sandbox/seccomp flags remain unchanged.

All three actual resource audits (staging, extracted AppImage, extracted deb) correctly returned **payloadIntegrity=false, productionQualified=false**: manifest and payloads are absent, and redistribution/installed acceptance are incomplete. The synthetic G.3 test verifies a complete current-source/real-helper resource tree **only in temporary test storage**, including hash, ELF, execute bit, stale/tampered source, symlink and manifest failures. That temporary tree is not included in either artifact and is not a licensed release bundle.

## Runtime scope and qualification

Only Linux x64 is a candidate. No distribution/architecture is newly production-qualified. Host observations: Pop!_OS 24.04 LTS, kernel 6.17.9-76061709-generic, unprivileged user session. Candidate version floors and observed versions:

| Fixed executable | Conservative floor | Observed |
| --- | --- | --- |
| `/usr/bin/python3` | 3.11.0 | 3.12.3 |
| `/usr/bin/bwrap` | 0.11.0 | 0.11.0 |
| `/usr/bin/unshare`, `/usr/bin/nsenter` | 2.39.3 | 2.39.3 |
| `/usr/sbin/nft` | 1.0.9 | 1.0.9 |
| `/usr/sbin/ip` | 6.1.0 | 6.1.0 |
| `/usr/bin/systemd-run` | 255 | 255 |

Python 3.11 is a code requirement for `hashlib.file_digest`; other floors conservatively admit no version below the exercised host. These are not proofs of compatibility for every later version or claims that older utilities cannot work. Lower floors and distro support require independent qualification. The worker uses Python stdlib modules plus the pinned owner; guest `/bin/sh`, Node/npm and other project tools remain subject to the existing filesystem planner and command authorization. Experimental Node planner calls are not additional production worker dependencies.

Actual host version probes passed 7/7. Under the outer sandbox, the real nft version probe failed with a precise fixed-path unavailable diagnostic because even that nft invocation initializes a prohibited netlink socket. Presence alone was not accepted. Test fixtures deliberately reject every missing/broken/timeout/unknown executable and every below-floor version; non-Linux, arm64 and source-tree resolution remain rejected.

Existing real source-tree suites exercised user namespaces, TAP, namespace-local nftables, slirp mount sandbox/seccomp, host netlink monitoring, pinned namespace descriptors, systemd user manager and effective unified cgroup controls. A separate bounded user-scope command also passed. Worker tests still verify MemoryMax 1 GiB, swap zero, TasksMax 128, CPU quota 200% and group OOM, with no resource fallback. Unsupported controllers/legacy/unbounded budgets fail closed. These results do not constitute an installed-app capability matrix. Version probes never open readiness; real worker startup and effective kernel checks remain mandatory for any future activation. No sudo, host executor, unrestricted network fallback or configuration repair is attempted.

## Actual package execution: separate evidence levels

Both new development artifacts built successfully in `/tmp/continuum-b2g3/packages`. Digests/sizes are in evidence. The initial restricted build failed GitHub DNS; the successful retry ran outside that restriction. Existing chunk/icon/desktop-name/duplicate-dependency warnings remain.

| Evidence level | AppImage | deb |
| --- | --- | --- |
| Build/archive source integrity | Passed | Passed |
| Extracted payload actual GUI | Passed | Passed from extracted `/opt/Continuum/continuum` |
| Fresh Isolated default, disabled trust, native IPC rejection | Passed | Passed |
| Normal launcher / installation | Normal launcher failed in disposable mount wrapper | Not installed |
| Native enable-confirmation and protected persistence after enable | Unverified; gate closed | Unverified; gate closed |
| Packaged helper / npm / Vite / browser / lifecycle workflow | Unverified; resources deliberately absent | Unverified; resources deliberately absent |

Staging also passed an actual GUI launch. Each GUI used the real packaged renderer, preload and native IPC, confirmed `app.isPackaged=true`, opened Settings → Engine & API, and verified the disabled option and rejected trusted setting without changing Isolated. Shutdown closed the application and the harness removed its disposable profile/home. No networking helper was launched by these blocked applications; packaged helper crash/cleanup acceptance remains unverified. Screenshots are in `/tmp/continuum-b2g3`.

Normal AppImage launch failed twice inside the home-isolation wrapper with `fusermount: mount failed: Operation not permitted`. A separate **host mount-only** command produced a FUSE mount successfully, then its bounded timeout ended it; the exact mount disappeared. Thus this is a limitation of this launch fixture, not proof that host FUSE is absent. No normal-launch GUI success is claimed. Extracted GUI success does not replace that result. A real installed deb VM/user-session environment was not provisioned; the primary OS was not modified.

## Source-tree workflow and security regression results

Final serial Node selection: **116 passed, 0 failed, 0 skipped**. Includes B1, real B2-D dispatcher, B2-E dependency checks, preview gateway/browser/IPC, real isolated Vite and registry downloads, protected trust/storage fixtures, W7/socket/filesystem/Git relay, native permission/isolation and Casual Chat. New focused final G.3/dependency selection: **7 passed, 0 failed, 0 skipped** (overlaps six groups from the broad run; includes an added unsupported-platform group). Do not add these counts together as distinct tests.

Separate Python: B2-C historical public-only owner **5/5**, B2-E policy **4/4**, B2-F resource prerequisites **2/2**, all zero failures/skips. The historical private-address denial tests retain their original fixture contract; production Trusted Development still intentionally permits potentially reachable host/private IPv4. External IPv6 denial and helper hardening remain enforced.

Real source-tree npm installed Vite 6.4.3 and is-number 7.0.0; pnpm, pip six 1.17.0 and shallow remote Git downloads passed. Yarn was unavailable: one optional package-manager workflow not run, not a passing test and not a TAP skip. Lockfile/node_modules and contained filesystem/cache behavior remain covered by the existing fixtures. Real standard Node/Vite ran under the verified cgroup budget. Chrome verified authenticated handoff, HTTP/assets, JavaScript, CSS, reload and WebSocket HMR. B1 normal completion survival, later authorized inspection, Stop, expiry, session/mode/rule revocation, shutdown, worker/owner/helper SIGKILL, parent death and OOM cleanup passed. These remain source-tree, explicitly injected fixture results; none is an installed-package workflow result.

Electron renderer fixtures: networking settings **1 passed**, Background Commands/preview **1 passed**, zero failures/skips. An initial GUI attempt inherited `ELECTRON_RUN_AS_NODE=1` and exited before launch; rerunning with that variable removed passed. Actual packaged blocked-GUI fixtures: staging, extracted AppImage and extracted deb **1 passed each**. Archive checks: **1 passed each** for staging/AppImage/deb; separate current runtime-module ASAR integrity/source comparisons passed. Normal AppImage GUI acceptance: **0 passed, 1 failed condition** (two launch attempts; same FUSE fixture condition). Installed deb acceptance was not run.

Production Vite build passed with existing large-chunk warnings. JavaScript syntax, Python AST, JSON and `git diff --check` passed. Exact commands, results, runtime diagnostics, hashes and logs are recorded in evidence. Logs stay under `/tmp/continuum-b2g3`.

## Activation decision and remaining work

Production readiness is still the existing explicit closed gate; no environment variable, renderer/settings value, CLI argument, manifest field or fixture opens it. Missing/legacy workspaces stay Isolated. Protected native consent/storage and stale-dialog cancellation/revocation tests passed as source fixtures; actual enabled packaged consent/restart persistence remains unverified. Four permission modes, Full Access and Casual Chat behavior were preserved. P3 was not implemented.

Release blockers, in order:

1. Complete the exact helper static-link inventory, per-component licenses/notices and corresponding-source/build/relink materials or legally reviewed distribution mechanism, with source and binary digests and an accepted maintenance owner.
2. Only then stage/package the full outside-ASAR payload and manifest, verify both packages' final bytes/permissions, and declare qualified distro dependencies. The current packages intentionally lack this tree.
3. Qualify a specific supported distro/kernel/user session for actual packaged namespace/TAP/nft/seccomp/netlink/cgroup behavior. Tool version success and this source-tree host are insufficient.
4. Complete normal AppImage and actually installed disposable deb GUI/native-consent/restart acceptance, real packaged npm/Vite/Chrome/HMR, B1/Stop/expiry/revocation and all crash/shutdown cleanup cases.
5. Review policy release maintenance/expiration and assign security update ownership; only then replace the release gate with evidence-backed resource/runtime/distribution eligibility. The retained address policy expires after December 3, 2026 UTC and was not extended.

The broader Trusted Development trust contract is unchanged and makes no atomic host-local/private-network exclusion claim. No critical blocker was waived to obtain a nominal milestone completion.
