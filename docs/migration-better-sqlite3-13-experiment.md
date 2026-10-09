# Electron 44 — better-sqlite3 13.0.3 compatibility experiment

> Historical phase report: artifact hashes, Git state and conclusions below describe that phase only. See [renderer sandbox validation and final review](migration-electron44-renderer-sandbox.md) for the final migration state, corrected UI outcomes and remaining release limits.

Date: 2026-10-09 (Asia/Dhaka). Outcome: **viable on this Linux x64 / glibc 2.39 host**, using the published prebuilt addon. No new failures found in the focused checks. This is not approval of a full migration or packaged release.

## Worktree protection and exact changes

Both worktrees started at `576d56957739f446ebe60ae74b57fddf5b6ba04b`.
The original `/home/mk_saadi/projects/persona-projects/llm-electron` on `feat/json-web-fetch` was clean before and after, and was only read. Its dependencies are in a separate physical directory.
The migration `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration` on `electron-44-migration` already had modified `package.json` and `package-lock.json` from the Electron probe. These changes were preserved. Starting status, manifest, lockfile and complete diff are captured in `.llm_workspace/better-sqlite3-13-experiment/start-*` and `start.diff`.

Changes made by this experiment, relative to that starting state:

- `package.json`: only `better-sqlite3` changed from `^11.10.0` to exact `13.0.3`. Electron remains exact `44.7.0`.
- `package-lock.json`: only the root dependency spec and better-sqlite3 dependency subtree changed. Added its nested `node-addon-api` 8.9.2; removed the now-unused `bindings` 1.5.0 and `file-uri-to-path` 1.0.0. No other existing package entry changed, including Electron.
- `docs/migration-better-sqlite3-13-experiment.md`: this report.

Installed files changed only in the migration's `node_modules`. New scripts, snapshots, raw logs, binary evidence, results and fresh application profiles are under the ignored `.llm_workspace/better-sqlite3-13-experiment/`. Nothing was committed or pushed. Application logic, tracked tests and `src/main/nodeHttpFetch.js` are unchanged. No reset, clean or full-suite run occurred.

## API review and upstream findings

Actual production usage was inspected in `src/main/db.js`, its consumers, `dataMigration.js`, `messageSearch.js`, and `memorySearchWorker.js`:

| Continuum usage | Assessment |
|---|---|
| File connection with default options; worker connection with `readonly` and `fileMustExist` | Supported |
| `prepare`, positional `?` and named object parameters; `run`, `get`, `all`, `iterate`; `changes` and `lastInsertRowid` | Supported |
| Synchronous `transaction(callback)()` and `.immediate()` | Supported; commit/exception rollback checked |
| `exec` schema/ALTER/trigger/index migrations; pragma row arrays and `{ simple: true }` | Supported |
| WAL, `synchronous=FULL`, foreign keys, busy timeout and `wal_checkpoint(TRUNCATE)` | Supported and exercised |
| `.open`, `.name`, close/reopen; stable application facade; checkpoint then copy, integrity verification and reference relocation | Supported and exercised by migration/persistence checks |

No production code hardcodes the old addon path, V8 ABI or `bindings` loader. Worker threads require the standard package entrypoint. No custom nativeBinding, extension, backup, aggregate or table API is used in production. No demonstrated API incompatibility requires an application fix.

Official [v12.0.0 notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.0.0) remove old runtimes; [v13.0.0 notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) introduce Node-API and embedded prebuilds. [v13.0.1](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.1) repairs cross-realm object binding; [v13.0.2](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2) includes a worker-termination fix and SQLite 3.53.4; [v13.0.3](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3) changes the ARM build runner. The [tagged API](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v13.0.3/docs/api.md) retains the used methods/options.

The [published metadata](https://registry.npmjs.org/better-sqlite3/13.0.3) requires Node >=22 and `node-addon-api ^8.0.0`. Continuum's existing host-engine declaration >=20 is therefore broader than this dependency's support; this experiment did not change it. The Electron target's embedded Node satisfies the requirement.

## Installation, runtime and Linux binary

Used `npm install --save-exact better-sqlite3@13.0.3 --ignore-scripts --no-audit --no-fund` (exit 0; one package added, two removed, one changed). Lifecycle scripts were deliberately skipped to avoid the application's broad `electron-builder install-app-deps` postinstall rebuilding unrelated native modules. This published package has no install script and sets `gypfile: false`; its Linux x64 prebuild is already in the npm tarball. No compiler or native rebuild was needed or invoked, and no platform workaround was used.

The loaded module was `node_modules/better-sqlite3/prebuilds/linux-x64.node`; its SHA256 equals the inspected published tarball's binary:
`6fd4292c6c5f352436cd85c9e1cb286978efa43c20ae350973f83414ced9991d`.

| Measured item | Value |
|---|---|
| Electron / embedded Node | 44.7.0 / 24.21.0 |
| Electron native ABI / available Node-API | 149 / 10 |
| Addon Node-API requirement | 10, confirmed by tagged binding.gyp and disassembly of `node_api_module_get_api_version_v1` returning 10 |
| Architecture | ELF64 x86-64, Linux x64 |
| Host glibc | 2.39 |
| Addon versioned requirements | Highest GLIBC 2.34, GLIBCXX 3.4.29, CXXABI 1.3.9 |
| Dynamic linking | All libraries resolved by `ldd`; runtime load succeeded |
| Addon's SQLite | 3.53.4, queried through better-sqlite3 |

This confirms compatibility here, not on every Linux distribution. Node-API removes the Electron-specific V8 ABI build dependency; it does not supply missing OS/C++ library versions. Binary inspection is saved in `binary-evidence.txt`. [Upstream build workflow](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v13.0.3/.github/workflows/build.yml) builds Linux x64 on Ubuntu 22.04.

## SQLite smoke checks

All passed under `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron`: in-memory CRUD; positional/named binding including number/null/blob; iteration; transaction commit and rollback; temporary file database; WAL/FULL/foreign-key/busy-timeout pragmas; integrity check; TRUNCATE checkpoint; close/reopen persistence; readonly/fileMustExist; worker-thread addon loading. The temporary smoke database was closed and its directory removed in `finally`. No real application database was opened.

## Focused tests versus Electron 30

Each Node-runner file ran as its own Electron process, with a 120-second timeout. Results were compared to the raw Electron 30 baseline records as well as `docs/migration-baseline-electron30.md`. Node 24 defaults to the spec reporter here; counts below are parsed from that output. No full suite was run.

| File in tests/ | Electron 30 | Electron 44 + v13.0.3 |
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
| `messageMetadata.ui.cjs` | FAIL, missing Recorded thinking | Same FAIL, confirmed diagnostic |

**Node-runner totals: 16 files, 15 passing and 1 failing; 58 tests, 57 passing and 1 failing.** All seven requested files pass (23/23 tests). The additional files directly exercise initialization, migration, persistence and statement iteration.

`messageStats` reproduces the baseline deepStrictEqual mismatch: actual object lacks expected `siblings: [2]`. `messageMetadata.ui.cjs` reproduces `/Recorded thinking/` versus `Thought for 0.00s` at line 41. Its original harness exits 0 without its success marker, as documented in the baseline. An ignored diagnostic wrapper suppresses premature window-all-closed exit and compiles the same test source with its original filename, allowing the failure to print and exit 1. Tracked test source is untouched. The assertion occurs before the close/reopen stage, so this UI harness does not prove that later stage; separate smoke and persistence tests do. No new regression was observed. Cancellation checks pass and the workaround remains intact.

## Minimal application startup

Launched the actual worktree app (`electron .`, NODE_ENV=production) under Xvfb, using a newly created profile with isolated HOME and XDG config/data/cache directories. Existing migration dist/index.html was used; no build or packaging was needed.

CDP verified the renderer at this worktree's `dist/index.html`, title `Continuum`, with a mounted React root. Renderer/preload/main IPC returned unloaded engine status and an empty Uncategorized session folder. Exactly one fresh `Continuum/App_Data/memory_palace.db` was created. After normal `window.close()`, the application and Xvfb exited with code 0 and no shutdown/fatal errors. A readonly check of that isolated database subsequently confirmed schema, system-date initialization and integrity `ok`; the WAL after that inspection is zero bytes. No experiment processes remain. These checks prove minimal startup, not model inference or a populated real-profile upgrade.

Evidence: `app-smoke.log`, `app-startup.log`, `startup-result.json`, `startup-db-check.log`, `sqlite-smoke.log`, `results.json`, and per-file logs under the ignored experiment directory.

## Blocker and next smallest action

No blocker for this isolated compatibility experiment. The two observed failures match Electron 30 and were not fixed. Stop here as requested.

Before a Linux release, the next smallest check is an isolated packaged-launch smoke on the oldest supported distribution: verify the new `prebuilds/linux-x64.node` is included and unpacked from ASAR, check the entire Electron/package library floor (including libstdc++), and verify database load and clean shutdown. The [upstream Electron troubleshooting guidance](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v13.0.3/docs/troubleshooting.md) specifically requires unpacked native libraries. Retain the shipped prebuild and its measured glibc floor; do not silently replace it with a host-specific rebuild. Review the host Node engine declaration when authorizing the full migration.
