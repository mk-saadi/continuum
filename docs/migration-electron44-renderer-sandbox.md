# Electron 44 renderer sandbox validation

Date: 2026-10-10 (Asia/Dhaka).

## Scope and protected starting state

Migration worktree: `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration`, branch `electron-44-migration`, HEAD `576d56957739f446ebe60ae74b57fddf5b6ba04b`. Installed Electron 44.7.0, embedded Node 24.21.0, better-sqlite3 13.0.3; x86_64, glibc 2.39, real X11 DISPLAY=:0, UID 1000.

Starting modifications were README.md, package.json and package-lock.json. Starting untracked documents were migration-better-sqlite3-13-experiment.md, migration-electron44-regression-results.md, migration-electron44-release-build.md, migration-electron44-release-readiness.md and migration-packaged-electron44-validation.md under docs/. All are byte-identical to their starting snapshots. The Web Stream cancellation workaround in src/main/nodeHttpFetch.js is also byte-identical.

Original checkout: branch `feat/json-web-fetch`, same HEAD, clean before and after. No original-checkout writes, commits, pushes, merges, resets, stashes or dependency changes occurred.

## Files changed

- `main.js`: loads `src/preload.js` directly and sets `sandbox: true`; context isolation and disabled Node integration remain unchanged.
- `src/preload.js`: becomes the self-contained canonical preload, importing only Electron; the four former root namespaces follow its existing five namespaces.
- `preload.js`: documented legacy CommonJS shim, requiring the canonical file once, without additional registrations. Retained to preserve the old entry point and existing packaging file list; it is explicitly unsuitable as a sandboxed BrowserWindow preload.
- `tests/preloadSandbox.integration.cjs`: focused Linux/Electron integration test using the actual production preload and actual IPC, database, import and upload handlers, with isolated temporary data.
- `docs/migration-electron44-renderer-sandbox.md`: this task's results.

Before: BrowserWindow (sandbox false) → root preload → runtime local require of src/preload plus four root registrations. After: BrowserWindow (sandbox true) → src/preload alone → all nine registrations. Root preload is outside this launch path.

All namespaces are retained: windowAPI, terminalAPI, modelsAPI, engineAPI, electronAPI, memoryPalace, mcpAPI, chatAPI and api. A VM snapshot comparison against the saved original two-file chain verified exact function source equality for all 124 methods and exact namespace/method names. Thus argument order, defaults, return/Promise behavior, channels, callback payloads and cleanup code are unchanged. Representative contracts were additionally exercised in Electron. Renderer consumers were inspected and unchanged; file inputs are passed as File arrays, as in production.

Existing builder files already include src/preload.js and the legacy entry point. No packaging configuration or asarUnpack changes were needed. Native SQLite remains smart-unpacked. Application launch scripts and production main code contain no sandbox-disabling flags. Older --no-sandbox commands remain in historical test documentation; none were used for this validation. Electron documents why sandboxed preloads cannot load local CommonJS modules: [Electron sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox).

## Runtime sandbox and compatibility evidence

Integration command:

```sh
env -u ELECTRON_RUN_AS_NODE timeout 70s node_modules/electron/dist/electron tests/preloadSandbox.integration.cjs
```

Final run exits 0 with Electron 44.7.0 / Node 24.21.0. Uses production src/preload.js, sandbox true, contextIsolation true, nodeIntegration false; no preload-error events; all nine namespace shapes and representative methods available. Renderer globals require/process are absent.

Sandbox evidence uses the live renderer PID from webContents.getOSProcessId(): Linux /proc status reports NoNewPrivs=1 and Seccomp=2, its normalized command line includes --enable-sandbox and has no disabling flags. This is process evidence beyond the preference value. Full application/package tests independently obtain renderer PIDs through Chromium SystemInfo.getProcessInfo and confirm the same kernel state and absent disabling flags. All launches are ordinary UID 1000 on X11 without --no-sandbox.

The integration test verifies window-control send channels, model/engine status channels, actual MCP status/tool handlers, no-op cancellation invokes, all 12 subscription payload/cleanup contracts, and callbacks receiving exactly one application payload rather than raw IPC events. Window/model handlers in this focused fixture are controlled channel responders; actual application/package startup complements them with production terminal/engine/model status and clean closure via windowAPI.close.

Chromium DOM.setFileInputFiles creates a genuine disk-backed File in a temporary input. The unmodified production preload calls webUtils.getPathForFile; the real project import handler returns the correct absolute path and contents. Real uploads copy that file into managed attachments, and an optimized JPEG Data-URL round-trips byte-for-byte. JPEG decoding succeeds. Real SQLite-backed session creation/message persistence survives database close/reopen.

Early harness attempts were corrected: debugger Runtime.enable before first navigation stalled; process is scoped to preload execution and unavailable to a later isolated-world evaluation; Chromium rewrites Linux argv into one string, requiring whitespace normalization; FileList must be converted to the File-array shape used by existing consumers; active model status is {data: []}, not an array. These were harness corrections, with no production API changes or weakened sandbox settings.

## Focused regressions

Each Node test used `node_modules/electron/dist/electron --test tests/<file>` with ELECTRON_RUN_AS_NODE=1, no NODE_OPTIONS, isolated HOME/XDG/TMPDIR and a 90-second limit. Embedded Node was used, not system Node.

| File | Result |
|---|---|
| skillImportIpc.test.cjs | PASS 7/7 |
| skillProposalLegacyIpc.test.cjs | PASS 3/3 |
| skills.test.cjs | PASS 1/1 |
| projects.test.cjs | PASS 1/1 |
| incrementalPersistence.test.cjs | PASS 1/1 |
| sessionHistory.test.cjs | PASS 1/1 |
| tabPersistence.test.mjs | PASS 15/15 |
| desktopChat.test.mjs | PASS 13/13 |
| nodeHttpFetchCancel.test.cjs | PASS 5/5 |
| mediaProtocol.test.cjs | PASS 1/1 |
| attachments.test.cjs | Known FAIL 0/1: 9 !== 5, line 81 |
| mcpIpc.test.cjs | Known TIMEOUT at 90 seconds |

Totals: 10 passing files, 48 passing assertions/tests; one known failed file/test; one known timeout. The attachment assertion matches the prior Electron 30/44 comparison. Existing MCP diagnostic instrumentation confirms tools retrieval and unsupported-reasoning rejection complete, then the first mocked chat fetch to 127.0.0.1:12345 never completes; a 25-second diagnostic timeout matches the previously documented stage. Neither involves preload consolidation; production code outside the preload/main preference changes was unchanged.

The previous five-suite UI harness recorded only exit codes and incorrectly treated all five exit-0 runs as passes. Three suites can exit prematurely during window destruction, before their rejected assertion prints; their original logs have no success marker. Those runs do **not** demonstrate a pass.

Final review on 2026-10-10 reran only these five fixtures with isolated HOME/XDG/TMPDIR profiles on X11, without `--no-sandbox`. A temporary wrapper retains the application through `window-all-closed` and compiles the unchanged test under its original filename so its existing error handler can report the assertion. Passing suites require both exit 0 and their exact success marker.

| UI suite | Actual result | Electron 30 baseline evidence |
|---|---|---|
| `projects.ui.cjs` | FAIL, exit 1: `Cannot read properties of null (reading 'textContent')` | Same recorded error in the baseline and Phase 3 diagnostic |
| `chatHistory.ui.cjs` | FAIL, exit 1: `Escape restores focus` | Same baseline assertion, previously reproduced in three runs |
| `fileBrowser.ui.cjs` | FAIL, exit 1: `Actual local image loads through protocol and CSP` | Same recorded baseline assertion and Phase 3 diagnostic |
| `tabSavedFlag.ui.cjs` | PASS, exit 0 plus `Saved-flag wiring survives an unbound call and a full restart.` | Previously PASS |
| `skillImportDialog.ui.cjs` | PASS, exit 0 plus `Skill import UI: file/folder actions wired, busy/error handling intact, projectId preserved.` | Previously PASS |

All three failure signatures are confirmed historical Electron 30 failures in `docs/migration-baseline-electron30.md`; the pre-consolidation Electron 44 Phase 3 diagnostics also show them. **Controlled baseline equivalence under the current ordinary X11/sandbox launch conditions has not been demonstrated.** The historical baseline used Xvfb and `--no-sandbox`. Matching signatures support recording these as known failures, but do not prove identical causes or every later assertion. The original silent exit-0 sandbox runs alone establish neither passing coverage nor baseline equivalence. Project drop/navigation, later history/export actions and file-browser controls after the failed assertions remain unvalidated by these fixtures. Independent production file IPC and packaged media checks have their narrower evidence above and below.

The full production application from the migration checkout also passes initial launch, React root and chat/session IPC readiness, real SQLite initialization, writing a message, normal close, restart and persisted message recovery. Both stages exit 0 with no owned live subprocesses remaining and sandboxed renderer evidence. No full repository suite was run.

## Packages

Build command:

```sh
npm run dist -- --linux --publish never -c.npmRebuild=false -c.electronDist=node_modules/electron/dist
```

The current migration dependencies and builder configuration were used. npmRebuild=false preserves the already validated native addon; electronDist uses the installed Electron distribution. Build exits 0. Existing icon/desktop association and duplicate dependency warnings are unrelated and were not changed.

| Target | Validation |
|---|---|
| AppImage | PASS direct FUSE launch/restart, both exits 0 |
| Debian | PASS extracted /opt/Continuum payload launch/restart, both exits 0 |

Both use separate fresh HOME/XDG/TMPDIR profiles, initialize shipped SQLite, mount the React renderer, exercise real bridge status/cancellation/attachment calls, decode a managed JPEG through media:// at 2×2 pixels, write/read a message across restart, and shut down through windowAPI.close. Renderer kernel sandbox evidence passes in all four stages. Live mappings confirm the SQLite addon is loaded from each shipped app.asar.unpacked directory. No owned live subprocesses remain. The canonical src/preload.js, legacy shim, main.js and cancellation workaround extracted from each package archive exactly match the migration sources; both app.asar archives match the common linux-unpacked payload.

- `release/Continuum-1.0.0.AppImage`: 282678328 bytes; SHA256 `f69a88bb1a1cb93e79ea5c39dac28fd40702924bb44bcc93030a6a4213e6da73`.
- `release/continuum_1.0.0_amd64.deb`: 210321484 bytes; SHA256 `4f0b0efe9a663f280c9c32cd5eb404416ce2013dd0f115ad771eda5a310446f3`.


## Limits and remaining findings

No live model was started and no credentialed cloud/MCP inference request was attempted. Model launch, terminal spawn/kill, live streaming inference, interactive native picker UI, and every bridge method's backend behavior are not fully end-to-end validated. Engine/model status and IPC contracts are checked; cancellation event payloads/cleanup and the existing real transport cancellation regression pass. File selection was automated through Chromium's genuine disk-file input; the projects UI suite fails before its drop/navigation coverage completes.

Debian installation/maintainer scripts/system desktop registration, older Linux distributions and Wayland were not exercised. Existing terminal-launch capability, trusted sender/navigation policy, CSP and workspace shell sandbox were outside this task and unchanged. No new security refactor was performed.

## Final repository state and evidence

```text
 M README.md
 M main.js
 M package-lock.json
 M package.json
 M preload.js
 M src/preload.js
?? docs/migration-better-sqlite3-13-experiment.md
?? docs/migration-electron44-regression-results.md
?? docs/migration-electron44-release-build.md
?? docs/migration-electron44-release-readiness.md
?? docs/migration-electron44-renderer-sandbox.md
?? docs/migration-packaged-electron44-validation.md
?? tests/preloadSandbox.integration.cjs
```

README.md, package.json, package-lock.json and the five pre-existing documents above are preserved pre-task work, not new task modifications. Newly generated dist/ and release/ outputs are ignored.

Evidence is retained in `.llm_workspace/renderer-sandbox-validation/` (ignored): logs, before/after method comparison, runtime/package results, preservation hashes, and harnesses. Extracted package payloads and isolated profiles remain under `/tmp/continuum-sandbox-evidence/`. The original checkout remains clean. No commit or push was made.

## Final review before migration-branch commit (2026-10-10)

Verified repository root, branch, HEAD, empty index and the full tracked/untracked migration diff. The migration remains based on `576d56957739f446ebe60ae74b57fddf5b6ba04b`; `main`, the original checkout and `fix/context-overflow-guard` are at `aa50ed891b021d621ffe92f545e7af963c833530`. Both other worktrees were clean and only inspected with optional Git locks disabled. No context-overflow or main changes were integrated.

Reviewed exact Electron 44.7.0 and better-sqlite3 13.0.3 manifest/lock/installed versions, the native Node-API prebuild migration, Debian dependency bounds, direct canonical preload loading, unchanged bridge contracts, renderer sandbox preferences, integration test, historical regression/packaging logs and release-readiness limits. Manifest and lock dependency specifications match; lock changes are confined to the two migrated packages and their dependency changes. Syntax checks for main, both preload entries and the integration test pass. The VM comparison passes for nine namespaces and all 124 method bodies. The focused production preload integration rerun exits 0 and confirms `NoNewPrivs=1`, `Seccomp=2`, `--enable-sandbox`, absent disabling flags, representative IPC/event cleanup, genuine disk File import/upload, JPEG decode and SQLite reopen.

Final-review evidence is `/tmp/e44-final-review-ffh6mgix/`: five UI logs and the integration log with isolated profiles. An initial temporary runner used an incorrect absolute Electron import and stalled; its task-owned processes were stopped and the wrapper corrected before the reported runs. No production change was made for that harness error. No full suite, package rebuild, new packaged launch or minimum-distribution check was run during final review. Current release artifact sizes and SHA256 hashes were independently rechecked against the sandbox-stage artifact manifest and match; retained package logs establish only the previously measured host startup/persistence/media scope.

No significant migration-branch commit blocker was found. This is not release certification. Known UI/test failures and the MCP timeout remain. Ubuntu 22.04 / Debian 12, Wayland, complete installed-desktop integration and broad interactive/live inference coverage remain unverified for the final sandboxed artifacts. Phase 4C's local inference and private Debian-install evidence belongs to the older unsandboxed artifacts; it is not transferred to the final packages. The manifest's legacy Node `>=20.0.0` engine range remains broader than the actual development/tooling requirement; use the documented Node >=22.12 procedure. CI and non-Linux packaging were not executed. Only intended migration code, tests and documentation are eligible for staging; generated assets, logs and profiles remain excluded. No push or merge is authorized by this review.
