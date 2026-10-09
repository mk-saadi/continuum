# Electron 44 packaged Linux validation

> Historical phase report: artifact hashes, Git state and conclusions below describe that phase only. See [renderer sandbox validation and final review](migration-electron44-renderer-sandbox.md) for the final migration state, corrected UI outcomes and remaining release limits. The support policy and Debian dependency gap below were subsequently addressed in [Phase 4A/B](migration-electron44-release-build.md). The release/ paths below now contain newer sandbox-stage artifacts with different hashes.

Date: 2026-10-09 (Asia/Dhaka). **Both Linux targets build and pass packaged startup/persistence checks on Pop!_OS 24.04 x86_64, glibc 2.39. Ready for broader migration validation on this host; older-distribution release support is not yet validated.**

## Repository protection and changes

Original checkout: `/home/mk_saadi/projects/persona-projects/llm-electron`, branch `feat/json-web-fetch`, HEAD `576d56957739f446ebe60ae74b57fddf5b6ba04b`, clean before and after. It was only read.

Migration checkout: `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration`, branch `electron-44-migration`, same HEAD. At start it already had modified `package.json`/`package-lock.json` and the untracked prior compatibility report. These files are byte-identical to the saved starting copies after validation. Dependency versions remain Electron 44.7.0 and better-sqlite3 13.0.3. No production source, tracked tests or CI/configuration were changed; the cancellation workaround remains intact.

The only new source-tree document from this task is `docs/migration-packaged-electron44-validation.md` (this report). Build outputs regenerated under ignored `dist/`, and new outputs were created under ignored `release/` and `.llm_workspace/packaged-electron44-validation/`. The generated-file inventory is `generated-files.txt` in that evidence directory. No reset, clean, stash, dependency operation, commit or push was performed.

## Build and artifact verification

Used the existing `dist` script and existing configured targets:

```sh
npm run dist -- --linux --publish never -c.npmRebuild=false -c.electronDist=node_modules/electron/dist
```

Build exit: 0. Vite 6.4.3 and electron-builder 26.15.3. `npmRebuild=false` preserves the already verified published native addon and avoids unrelated rebuilds. The supported `electronDist` option copies the existing validated Electron 44.7.0 distribution; an initial attempt to download another Electron copy was stopped only because of the slow redundant download. Both attempt logs are retained. No persistent build configuration was edited.

All following paths are relative to the migration worktree:

| Target | Path | Bytes | SHA256 |
|---|---|---:|---|
| AppImage | `release/Continuum-1.0.0.AppImage` | 282678685 | `49ff870931b19ea433f4aacdeeabb711439dbe81cfa354a0a6e0cad8ce2d668b` |
| Debian amd64 | `release/continuum_1.0.0_amd64.deb` | 210321160 | `d5e5663dd629926f3f7ea3829bd728d55d9a06efa6afd86f92de2ae3c0ccc189` |

The common build payload is `release/linux-unpacked/`. Extracted AppImage and Debian executables, ASAR archives and SQLite addon hashes match that payload. Packaged `main.js`, `src/main/db.js`, `src/main/nodeHttpFetch.js` and `dist/index.html` match the migration worktree. The archived manifest declares better-sqlite3 13.0.3; its own packaged metadata also reports 13.0.3. Runtime probes of both extracted target executables confirm Electron 44.7.0, Node 24.21.0, ABI 149, Node-API 10 and x64.

## Native SQLite packaging

Correct in both targets without adding an explicit `asarUnpack` pattern. The existing electron-builder smart-unpack detector recognizes `.node` files and unpacks the module. ASAR metadata marks the addon `unpacked: true`; its physical path is:

```text
resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node
```

The addon SHA256 is `6fd4292c6c5f352436cd85c9e1cb286978efa43c20ae350973f83414ced9991d`, identical to the upstream prebuild inspected in the prior experiment. Live process memory maps during AppImage and Debian launches confirm this actual unpacked path was loaded; there is no fallback to the checkout's addon.

## Native library requirements and supported Linux baseline

README, `docs/system-architecture-prerequisites.md`, migration/release documentation, `.github/workflows/build.yml` and `package.json` do **not** define a minimum supported Linux distribution or glibc version. Linux CI uses the moving `ubuntu-latest` image. A minimum support policy must be chosen by the owner.

`readelf`/`ldd` inspected the packaged x86-64 ELF executable, Electron helpers/libraries and supplementary native addons. The extracted AppImage was also inspected; its outer ELF launcher requires at most GLIBC 2.3.3 and its AppRun is a script.

| Component | Highest required GLIBC | Highest required GLIBCXX |
|---|---|---|
| SQLite Linux x64 prebuild (ELF64 x86-64) | 2.34 | 3.4.29 |
| Packaged Electron executable (`continuum`) | 2.25 | none |
| chrome_crashpad_handler | 2.17 | none |
| chrome-sandbox | 2.4 | none |
| libffmpeg / libvk_swiftshader | 2.17 | none |
| libvulkan | 2.16 | none |
| ONNX Runtime Linux x64 library/binding | 2.16 / 2.14 | 3.4.19 / 3.4.18 |
| sharp / bundled libvips | 2.2.5 / 2.17 | 3.4.18 |
| GNU Linux x64 canvas addon | 2.16 | none |

SQLite also requires CXXABI 1.3.9 and Node-API 10. Its direct system-library dependencies are libstdc++.so.6, libm.so.6, libc.so.6 and ld-linux-x86-64.so.2; libgcc_s.so.1 resolves transitively. These standard runtime libraries are supplied by the host, not bundled with the application. All selected GNU Linux x64 dependencies resolve on this host. The package also contains an unused musl SQLite prebuild; `ldd` reports its absent libc.musl-x86_64.so.1 here. The package loader selects the GNU/glibc prebuild, so that musl result is not a missing dependency in the tested runtime.

Electron does **not** introduce a higher direct bundled glibc symbol requirement than SQLite. The observed bundled GNU Linux x64 lower bound is glibc >=2.34 with libstdc++ exposing GLIBCXX_3.4.29 and CXXABI_1.3.9. This is the recommended technical support floor, pending an owner-selected oldest distribution and a real launch test. GTK3, NSS/NSPR, X11, GBM, ALSA, D-Bus and other system desktop libraries also need compatible versions; a glibc number alone is insufficient.

**Debian metadata gap:** the generated Depends field lists the existing desktop dependencies but does not declare `libc6` or `libstdc++6` minimums. It cannot enforce the newly observed SQLite floor at installation time. Review those constraints in the subsequent release task once the owner chooses the distribution baseline; no packaging change was made here.

## Packaged smoke tests

| Target | Result | What was exercised |
|---|---|---|
| AppImage | PASS, direct FUSE launch | Real mounted AppImage; main, SQLite, renderer and preload/main IPC; write through session IPC; normal window close; restart and read persisted message; both exits 0 |
| Debian | PASS, extracted payload launch | `dpkg-deb --extract`, then extracted `/opt/Continuum/continuum`; same checks and both exits 0 |
| Packaged SQLite API smoke | PASS | Packaged executable and packaged addon: memory CRUD, named/positional/number/null/blob binding, transactions/rollback, WAL/checkpoint/integrity, file close/reopen, readonly/fileMustExist and worker loading; temporary DB removed |

Each target had its own new profile, isolated HOME and XDG config/data/cache directories, plus TMPDIR. No real profile or database was used. Both renderers loaded `resources/app.asar/dist/index.html`, title Continuum, with a mounted UI. Live process maps verified the shipped native addon. Clean normal shutdown and absence of orphaned children were checked after each launch; final verification found no task processes or AppImage mounts remaining.

FUSE was hidden inside the restricted tool environment but available on the host, so direct AppImage mounting worked. The AppImage was additionally extracted with its documented `--appimage-extract` option for payload inspection. No FUSE installation or host change was necessary. Debian installation, maintainer scripts, desktop integration and system registration were not exercised; the package was deliberately not installed.

GUI checks use Xvfb and `--no-sandbox`, consistent with the baseline. Native/library/binding/shutdown errors were absent. One transient GPU command-buffer warning occurred under Xvfb. An initial AppImage diagnostic harness asserted the title before document load; it was corrected to wait for renderer readiness, then both clean launch/restart stages passed. This was a harness timing issue, with logs preserved and no production modification.

## Older Linux compatibility

NOT RUN. No documented oldest supported environment exists, and no local Docker/Podman, libvirt/virsh, QEMU, LXC/Incus, systemd-nspawn, distrobox or proot tooling was available. Although /dev/kvm exists, no ready VM/tooling was found. No system/container runtime or system libraries were installed or altered.

Binary inspection establishes the floor above; it does not prove startup on an older distribution or equivalence of that distribution's system desktop libraries. The owner should select the oldest supported GNU/Linux distribution satisfying the observed symbols, then validate both packages in that environment before promising portability. Wayland, ordinary sandboxed desktop launch and separately downloaded Playwright/browser/model runtimes are also outside this focused smoke.

## Focused regression comparison

Executed 16 focused Node-runner files as individual processes, each bounded by a 120-second timeout, using `release/linux-unpacked/continuum` with ELECTRON_RUN_AS_NODE=1. A test-only preload redirects better-sqlite3 imports (including persistence child processes) to the unpacked packaged module. Profiles/TMPDIR are isolated; tests and production source are unchanged. This tests current worktree code with the actual packaged runtime/addon, complementing the packaged-app IPC smoke.

| tests/ file | Electron 30 baseline | Packaged Electron 44 |
|---|---|---|
| `dataMigration.test.cjs` | PASS 1/1 | PASS 1/1 |
| `incrementalPersistence.test.cjs` | PASS 1/1 | PASS 1/1 |
| `sessionHistory.test.cjs` | PASS 1/1 | PASS 1/1 |
| `chatFtsRemoval.test.cjs` | PASS 1/1 | PASS 1/1 |
| `nodeHttpFetchCancel.test.cjs` | PASS 5/5 | PASS 5/5 |
| `webSearch.test.cjs` | PASS 13/13 | PASS 13/13 |
| `subAgentFetch.test.cjs` | PASS 1/1 | PASS 1/1 |
| `tabPersistence.test.mjs` | PASS 15/15 | PASS 15/15 |
| `desktopChat.test.mjs` | PASS 13/13 | PASS 13/13 |
| `chatHistorySearch.test.cjs` | PASS 1/1 | PASS 1/1 |
| `projects.test.cjs` | PASS 1/1 | PASS 1/1 |
| `messageBranches.test.cjs` | PASS 1/1 | PASS 1/1 |
| `replyVariants.test.cjs` | PASS 1/1 | PASS 1/1 |
| `tokenUsage.test.cjs` | PASS 1/1 | PASS 1/1 |
| `sampling.test.cjs` | PASS 1/1 | PASS 1/1 |
| `messageStats.test.cjs` | FAIL 0/1 | FAIL 0/1 |

Totals: **15 files pass, 1 known failure; 57/58 tests pass.** All seven originally requested critical files pass (23/23). All file results and counts match the Electron 30 baseline exactly. `messageStats` retains the same deepStrictEqual mismatch, missing expected `siblings: [2]`; it was not fixed. The prior `messageMetadata.ui` failure was not rerun in this packaging task. No new regression or timeout was observed; the full repository suite was not run.

## Readiness and evidence

Ready for the separately authorized broader migration comparison on this host. Not yet certified for an older Linux distribution or a final release. Remaining release work: choose/document the support floor, enforce appropriate Debian runtime dependency constraints, and run package startup on that oldest environment.

Evidence is under `.llm_workspace/packaged-electron44-validation/`: starting state and dependency snapshots; build logs; `artifacts.json`; `asar-inspection.json`; `payload-verification.json`; ELF inventories and raw readelf/ldd output; per-target runtime/GUI/restart logs and live-addon paths; SQLite smoke; `results.json` and per-file test logs; generated-file inventory and final process/Git verification. Stop after this packaged validation; no commit or push was made.
