# Electron 44 — Linux support and clean release build (Phase 4A/B)

> Historical phase report: artifact hashes, Git state and conclusions below describe that phase only. See [renderer sandbox validation and final review](migration-electron44-renderer-sandbox.md) for the final migration state, corrected UI outcomes and remaining release limits.

Date: 2026-10-09 (Asia/Dhaka). Outcome: **clean locked installation, explicit verified Electron installation, native dependency workflow, production build and both Linux packages passed on the development host.** AppImage and the extracted Debian payload initialize SQLite and preserve data across clean restarts. No build/install failure occurred; no broader dependency upgrade or baseline fix was needed.

## Approved Linux support policy

The owner approved Continuum's minimum Linux baseline as **Ubuntu 22.04 LTS / Debian 12 or newer, x86_64**. This is now documented in README. Before Phase 4A the project had no documented minimum; `ubuntu-latest` CI did not define one.

The support policy does not claim those minimum distributions were tested here. Verified environment: Pop!_OS 24.04, x86_64, glibc 2.39. **Ubuntu 22.04 LTS and Debian 12 package execution remain unverified.** Other GNU/Linux distributions require equivalent libraries and separate validation; this policy does not promise arbitrary distro/architecture support.

## Derivation and minimal Debian metadata

Fresh `readelf`/`ldd` inspection includes the packaged Electron executable and helpers, FFmpeg/Vulkan/SwiftShader, SQLite, ONNX, sharp/libvips and GNU canvas modules. SQLite remains the limiting selected native binary:

| Component / requirement | Measured value |
|---|---|
| SQLite addon architecture | ELF64 x86-64, GNU/Linux |
| SQLite highest GLIBC | 2.34 |
| SQLite highest GLIBCXX / CXXABI | 3.4.29 / 1.3.9 |
| SQLite Node-API requirement | 10 |
| Electron executable highest direct GLIBC | 2.25 |
| Other selected shipped GNU x64 modules | lower direct glibc/C++ symbol requirements |
| Dynamic loading on this host | all selected GNU x64 libraries resolve |

The unused musl SQLite prebuild reports its expected absent musl libc under GNU-host ldd; the loader chooses `linux-x64.node` here. Standard libc, libm, libstdc++ and libgcc runtime libraries come from the host. GTK/NSS/X11/GBM/ALSA/D-Bus and other desktop libraries remain additional platform constraints; glibc alone is insufficient.

`dpkg-shlibdeps` on the actual SQLite addon produced **`libc6 (>= 2.34), libstdc++6 (>= 11)`**. Installed Debian-style symbol metadata independently maps GLIBC_2.34 to libc6 2.34 and GLIBCXX_3.4.29 to libstdc++6 11. The [GCC ABI table](https://gcc.gnu.org/onlinedocs/libstdc++/manual/abi.html) dates GLIBCXX_3.4.29 to GCC 11.1 and CXXABI_1.3.9 to GCC 5.1. The raw shlibdeps log retains usr-merge-diversion and unresolved Node-API-symbol warnings; Electron supplies the Node-API symbols at runtime. No system-library workaround was used.

[Ubuntu 22.04 libc6](https://packages.ubuntu.com/jammy/libc6) is 2.35 and its [libstdc++6](https://packages.ubuntu.com/jammy/libstdc++6) is a GCC 12 runtime; [Debian 12 libc6](https://packages.debian.org/bookworm/libc6) is 2.36 with [GCC 12.2 libstdc++6](https://packages.debian.org/bookworm/libstdc++6). These package versions exceed the measured symbols. Stock Ubuntu 20.04 / Debian 11 use glibc 2.31 and are outside the approved baseline; the published SQLite prebuild cannot load against that older glibc.

`package.json` changes only `build.deb.depends`, retaining all nine current desktop dependencies and appending the two derived bounds. Explicit depends replaces electron-builder defaults, so the existing list was preserved rather than replaced by only the new libraries. Maintainer, target names, icons, desktop settings and unrelated metadata were not changed. The final Debian package's actual Depends field is:

```text
libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0, libc6 (>= 2.34), libstdc++6 (>= 11)
```

The technical library bounds enforce the binary's requirements, while the owner-approved distribution policy is stricter. No arbitrary distro-specific patch-version requirement was substituted.

## Protected starting and final state

Original checkout: `/home/mk_saadi/projects/persona-projects/llm-electron`, `feat/json-web-fetch`, HEAD `576d56957739f446ebe60ae74b57fddf5b6ba04b`; clean before and after, only read.

Migration worktree: `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration`, `electron-44-migration`, same HEAD. At start it already had modified package.json/package-lock.json and three untracked migration reports. Those intentional migration changes were preserved. The lockfile and all prior reports remain byte-identical. Production and test source are unchanged, including `src/main/nodeHttpFetch.js`.

Phase 4 changes:

- `package.json`: only the approved Debian dependency list was added relative to the starting manifest. Electron stays exact 44.7.0, better-sqlite3 exact 13.0.3; all other dependency specifications are unchanged.
- `README.md`: approved x86_64 Linux baseline, actual build-host Node >=22.12 requirement, link to this report, and ordered locked install/Electron-install/rebuild instructions. The existing package engines declaration was not changed.
- `docs/migration-electron44-release-build.md`: this policy/build/validation report.

Generated outputs are ignored. The complete prior node_modules tree was moved intact to `.llm_workspace/phase4-linux-release/clean-build/node_modules-before-clean/`. Prior dist output was copied to `dist-before-clean/` before regeneration. The existing `release/` artifacts were not overwritten; their checksums still match the previous report. Fresh artifacts live in a separate output directory below.

No reset, clean, stash, unrelated source removal, dependency upgrade, full-suite run, commit, push or merge was performed. The normal npm clean-install operation acted only on the newly created dependency tree after the previous tree was preserved.

## Exact clean-install and build sequence

Host tools: Node 22.23.2, npm 10.9.8; installed Vite 6.4.3 and electron-builder 26.15.3 are the same locked versions.

Executed in the migration worktree, in order:

```sh
npm ci --ignore-scripts --no-audit --no-fund

electron_config_cache="$PWD/.llm_workspace/phase4-linux-release/clean-build/electron-cache"   DEBUG='@electron/get*' npm exec --no -- install-electron

npm rebuild --foreground-scripts

npm run dist -- --linux --publish never   -c.electronDist=node_modules/electron/dist   -c.directories.output=.llm_workspace/phase4-linux-release/clean-build/release
```

All commands exited 0. `npm ci` installed 720 packages from the unchanged lockfile into fresh node_modules, with lifecycle scripts deferred. Electron's binary was confirmed absent immediately afterward. [Electron 42+ installation behavior](https://www.electronjs.org/blog/electron-42-0) requires a separate/dynamic binary installation rather than the old package postinstall download; the locked local `install-electron` command was used explicitly.

The installer downloaded a fresh `electron-v44.7.0-linux-x64.zip` into a dedicated empty cache and validated it against the checksums shipped with Electron's locked npm package. An independent SHA256 check and runtime probe passed **before** any native lifecycle/rebuild:

```text
Electron archive SHA256:
3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a
```

`npm rebuild --foreground-scripts` ran dependency lifecycles and the project's existing `electron-builder install-app-deps` postinstall, which prepared better-sqlite3 and sharp successfully. Sharp's cached libvips archive passed its integrity check. The SQLite prebuild hash remained identical to upstream; no host-specific replacement was introduced.

`npm run dist` ran the production Vite build and both configured Linux targets. Native rebuilding remained enabled and completed again during packaging. The supported `electronDist` option selected the newly downloaded, verified clean Electron distribution, avoiding another download. Only the output directory was overridden to preserve prior artifacts. Native rebuilds were not bypassed with npmRebuild=false.

This verifies the clean locked build procedure and artifact provenance on this host. A second independent build or byte-for-byte reproducibility across machines was not tested. The existing CI workflow was inspected but not edited or executed; this report records the verified ordered local procedure.

## Actual package versions and contents

Both extracted target executables report **Electron 44.7.0, Node 24.21.0, Chromium 152.0.7977.130, ABI 149, Node-API 10, x64**. Both packages contain better-sqlite3 **13.0.3**; querying that addon returns SQLite **3.53.4**.

The actual native file in both targets is:

```text
resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node
```

ASAR metadata marks it unpacked. Live GUI process memory maps confirm it loads from that unpacked package location. Its SHA256 remains:

```text
6fd4292c6c5f352436cd85c9e1cb286978efa43c20ae350973f83414ced9991d
```

Extracted AppImage/Debian executable, ASAR and SQLite hashes match the clean common build payload. Packaged main/db/cancellation source and renderer index match the migration worktree. Measured native symbol floors remain compatible with the new dependency bounds.

## Final artifacts and checksums

Paths relative to the migration worktree:

| Target | Path | Bytes | SHA256 |
|---|---|---:|---|
| AppImage | `.llm_workspace/phase4-linux-release/clean-build/release/Continuum-1.0.0.AppImage` | 282678687 | `2ca161687ffbcdd511825703f1fb0340979a1471363d0a881e0eef6db6dea4fb` |
| Debian amd64 | `.llm_workspace/phase4-linux-release/clean-build/release/continuum_1.0.0_amd64.deb` | 210321376 | `160d7e5e748f15f9a34f24f7722661380a691605afc308b55f491bbe4e7ad32f` |

`SHA256SUMS` and `artifacts.json` in the clean-build evidence directory are computed from these exact final files. The previous release checksums belong to preserved earlier artifacts, not these new outputs.

## Packaged smoke results

| Check | AppImage | Debian |
|---|---|---|
| Actual launch route | direct FUSE-mounted AppImage | extracted package's /opt/Continuum/continuum |
| Main / SQLite initialization | PASS | PASS |
| Continuum renderer / mounted React root / IPC | PASS | PASS |
| Write via session IPC, normal close, restart and read | PASS | PASS |
| Actual unpacked SQLite path in live maps | PASS | PASS |
| Both GUI launches exit normally | 0 / 0 | 0 / 0 |
| Native/binding/shared-library/shutdown errors | none | none |
| Packaged SQLite API smoke | PASS | PASS |
| Orphaned children after normal exit | none | none |

Every target used a separate new HOME and XDG config/data/cache profile plus TMPDIR. No real user profile or database was opened. The persistence checks created an isolated message through real renderer/preload/main IPC, then verified it after reopening the package. Additional SQLite checks ran with each actual packaged executable and addon: memory CRUD, binding/iteration, transaction commit/rollback, WAL/checkpoint/integrity, temporary file close/reopen, readonly/fileMustExist and worker loading. Temporary API-smoke databases were closed and removed.

FUSE was available on the host, so AppImage mounted execution passed without an extraction fallback. It was also extracted via --appimage-extract for independent payload inspection. Debian was extracted with dpkg-deb, not installed; no maintainer scripts or system registration ran. GUI smoke used Xvfb and --no-sandbox, consistent with earlier validation. No full regression suite was rerun, and no baseline failure was fixed.

## Remaining unverified distribution checks

**Ubuntu 22.04 LTS and Debian 12 execution remain unverified**, including their complete system desktop-library combination. No suitable local container/VM was available in earlier inspection; no new OS, VM tool or system libraries were installed. Policy approval and symbol/package inspection do not substitute for package startup on the minimum supported distributions.

Also unverified here: Debian installation/maintainer scripts/desktop integration, ordinary sandboxed desktop launch, Wayland, and real model or live cloud inference. Those are separate release checks; the tested scope is the clean build and isolated packaged runtime/persistence on this host.

## Evidence and stop point

Evidence: `.llm_workspace/phase4-linux-release/clean-build/`, including protected snapshots/backups, exact commands, npm-ci/installer/rebuild/build logs, archive checksum/runtime verification, ASAR/ELF inventory, dependency field, artifact manifests/checksums, both target GUI/restart/API-smoke logs, and final Git/process checks. Phase 4A's proposal/symbol derivation remains in its parent evidence directory.

No build/install failure occurred. The approved metadata and documentation are in place; clean dependency installation and both Linux package smoke tests passed. No task processes or AppImage mounts remain. Stop after Phase 4A/B; nothing was committed, pushed or merged.
