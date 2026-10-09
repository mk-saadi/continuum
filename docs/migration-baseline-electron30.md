# Electron 30 Migration Baseline (Phase 1)

## 1. Purpose and scope

This document records the pre-migration baseline of Continuum on **Electron 30.5.1** at
commit `7f4c24d`, produced on 2026-10-09. It is the reference against which Phase 3
(post-upgrade to Electron 44) results will be compared.

**Phase 1 was measurement only.** No application code, tests, or dependencies were
changed to make anything pass. Electron remains on **30.5.1**; no native module was
rebuilt for any other ABI.

## 2. Exact branch and commit

| Item | Value |
|---|---|
| Branch | `feat/json-web-fetch` |
| HEAD | `7f4c24dd6428f798929d80791119e83e71b23247` (`feat: read JSON API responses in the web content tools`) |
| Upstream | `origin/feat/json-web-fetch` at the same commit (in sync) |
| `main` | `bb02c99` (`fix: harden subagent execution and memory chat flow`) |
| Working tree at start | clean; no stashes; single worktree |
| Stashes / other worktrees | none |

## 3. Confirmed environment and runtime

| Item | Value | How verified |
|---|---|---|
| OS | Pop!_OS 24.04 LTS (Ubuntu-based) | `/etc/os-release` |
| Arch / glibc | x86_64 / glibc 2.39-0ubuntu8.7 | `uname -m`, `ldd --version` |
| Display session | **X11** (`XDG_SESSION_TYPE=x11`, `DISPLAY=:0`); no active Wayland session | env |
| Host Node.js (not used for tests) | v22.23.2, npm 10.9.8 | `node --version` |
| Electron package | **30.5.1** (`node_modules/electron`, lockfile agrees) | `package.json` / lockfile |
| Embedded Node.js | **20.16.0** | `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p process.versions.node` |
| Chromium / V8 | Chrome 124.0.6367.243 / V8 12.4.254.20-electron.0 | embedded `process.versions` |
| Native module ABI (Electron 30) | **123** (`process.versions.modules` under `ELECTRON_RUN_AS_NODE=1`) | embedded runtime |
| better-sqlite3 | 11.10.0, addon loads under the embedded runtime (in-memory + file-backed) | load probes (see §9) |
| Build tools | vite 6.4.3, electron-builder 26.15.3, esbuild 0.25.12, playwright 1.64.0-alpha | binaries / lockfile |
| `dist/` at test time | built 2026-10-08 09:27 (predates HEAD; UI harnesses consume only its CSS + `index.html`; fixtures bundle current `src/` with esbuild) | file timestamps |

Full capture: `.llm_workspace/migration-baselines/electron30-7f4c24d/environment.txt`.

## 4. Test inventory and summary counts

118 runnable test files discovered in the current checkout:

* 71 × `tests/*.test.cjs`
* 24 × `tests/*.test.mjs`
* 23 × `tests/*.ui.cjs`

**Excluded (not independently runnable):** the 17 files under `tests/fixtures/`
(13 `.jsx` fixtures, `fetchCancelChild.cjs`, `mcpServer.cjs`, `transformers.mjs`,
`visionImages.mjs`) — support scripts loaded by the harnesses. No test files exist
outside `tests/`. The previous audit's count of 118 matches the current checkout.

Runners (README conventions, verified against `package.json` — `npm test` was **not**
used because it invokes system Node 22, which cannot load the Electron-ABI-123
better-sqlite3):

* Node-runner suites: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test <file>`
* UI harnesses: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox <file>`
* Per-file `timeout -k 10 120`; every file ran as its own process; sequential.

| Status | Count | Files |
|---|---:|---|
| **PASS** | **100** | 87 Node-runner + 13 UI |
| **FAIL** | **17** | 7 Node-runner + 10 UI |
| **TIMEOUT** | **1** | `tests/mcpIpc.test.cjs` (124 s) |
| **INFRASTRUCTURE ERROR** | **0** | — |
| **NOT RUN** | **0** | all 118 discovered files were executed |
| **Total** | **118** | |

Node-runner TAP totals across files: **425 tests, 418 pass, 7 fail** (files that crash
before registering tests are counted as 1 file-level failure by the parent TAP).
Wall time: 18:43:28 → 18:46:59 (+06:00), ~208 s summed.

**UI harness caveat (important for Phase 3 reproducibility):** several `*.ui.cjs`
harnesses call `window.destroy()` in a `finally` and then `app.exit(...)`. Destroying
the last window triggers Electron's default *quit-when-all-windows-closed*, which can
exit **0 before the `.catch()` reports an assertion failure** — i.e. a failing UI test
can print nothing and exit 0. The baseline therefore classifies UI tests by each
harness's exact success marker (present ⇒ PASS), not by exit code alone. Where a
marker was missing, the failure reason was extracted using **instrumented copies of
the harness in the ignored log directory** (tracked test files were not modified).
`headerContext.ui.cjs` documents this same quirk in its source.

## 5. Per-file results

Full per-file table (file, runner, exit code, status, TAP counts, duration):
`.llm_workspace/migration-baselines/electron30-7f4c24d/per-file-results.md`
(generated; raw data in `results.tsv` alongside it).

## 6. Observed failures and timeouts (with signatures)

### Node-runner FAIL (7)

| File | Signature | Classification |
|---|---|---|
| `tests/attachments.test.cjs` | `AssertionError` at `attachments.test.cjs:81`: `9 !== 5` (strictEqual) | previously known |
| `tests/messageActions.test.cjs` | `AssertionError` at `messageActions.test.cjs:54`: `0 !== 2` | previously known |
| `tests/messageStats.test.cjs` | `deepStrictEqual` diff: expected object has `siblings: [2]`, actual lacks it | previously known |
| `tests/subAgentRunner.test.cjs` | assertion `false == true`, then unhandled `Error: Call initDatabase() before accessing the database.` thrown from `engineManager.update` timer (`ipcHandlers.js:363`) kills the process | previously known |
| `tests/rag.test.cjs` | `TypeError: fetch failed` → `ECONNREFUSED 127.0.0.1:8080` at `src/lib/memoryChat.mjs:504`, plus `Desktop notification failed: ... reading 'isSupported'` (`notificationService.js:33`) | previously known |
| `tests/cloudIpc.test.cjs` | `openai request failed (HTTP 401). Check your API key and model access.` | **newly observed** — environment-dependent (no cloud credentials configured) |
| `tests/filesystemToolLimits.test.cjs` | subtest 4 "MCP execution applies the cap before serialization": `Call initDatabase() before accessing the database.` (`mcpManager.getMcpMode` → `configManager.getAppSettings` → `db.js:353`) | **newly observed** |

Note: `tests/agentTools.test.cjs`, listed as a known failure in the previous audit,
**passes** at this commit (1/1).

### TIMEOUT (1)

| File | Signature | Classification |
|---|---|---|
| `tests/mcpIpc.test.cjs` | 124 s timeout; log contains only `TAP version 13` — no subtest ever completes. Stage-marker diagnosis (instrumented copy): test 1 starts, `mcp:get-tools` succeeds, the "unsupported reasoning effort" check succeeds, the mocked `POST http://127.0.0.1:12345/v1/chat/completions` is invoked **exactly once**, then the first `engine:chat` (request1) never resolves inside `runMemoryChat`. Deterministic across 3 runs; nothing listens on :12345 (instant refusal, not a stuck connection). `--test-timeout=30000` classifies it as `testTimeoutFailure`. | previously known **file** (prior signature: `engine:chat` deep-equality + `event.sender.once is not a function`); **manifestation changed to a hang** — same subsystem, current result recorded as TIMEOUT |

### UI harness FAIL (10)

All are genuine failures at this commit (confirmed with instrumented copies that let
the harness report the error; the unmodified harnesses exited 0 silently):

| File | Signature |
|---|---|
| `tests/chatHistory.ui.cjs` | page assertion `Escape restores focus` (menu closes but focus restoration check fails) — reproduced in 3 separate runs |
| `tests/cloudSelection.ui.cjs` | `TypeError: Cannot read properties of null (reading 'textContent')` |
| `tests/engineSelection.ui.cjs` | `AssertionError` at line 55: input `'LastNot loaded'` did not match `/Active.*Ready/` |
| `tests/fileBrowser.ui.cjs` | page error `Actual local image loads through protocol and CSP` |
| `tests/memorySettings.ui.cjs` | esbuild: `Could not resolve "../../src/components/MemorySettings"` — `src/components/MemorySettings.jsx` **does not exist** at this commit |
| `tests/messageMetadata.ui.cjs` | `AssertionError`: input did not match `/Recorded thinking/` (this is the SQLite close/reopen UI test — see §8) |
| `tests/projects.ui.cjs` | `TypeError: Cannot read properties of null (reading 'textContent')` |
| `tests/reasoningSettings.ui.cjs` | esbuild: `No matching export ... ChatInterface.jsx for import "MessageContextStatus"` |
| `tests/subAgentBadge.ui.cjs` | page error `Failure status and reason` |
| `tests/thinkingBudget.ui.cjs` | esbuild: `No matching export ... ChatInputBar.jsx for import "ThinkingBudgetSelector"` |

These 10 are classified **newly observed**: the October 5 reports are stale (obsolete
checkout, system Node 22, 72/118 files) and contain no reliable record for them.

## 7. Previously known vs. newly observed

* **Previously known, still failing (5):** `attachments`, `messageActions`,
  `messageStats`, `subAgentRunner`, `rag`.
* **Previously known file, changed manifestation (1):** `mcpIpc` — known assertion
  failures before, now hangs (TIMEOUT). The baseline records the current behavior;
  root cause is not investigated in Phase 1.
* **Previously known, now passing (1):** `agentTools`.
* **Newly observed (12):** `cloudIpc`, `filesystemToolLimits`, and the 10 UI harness
  failures above. `cloudIpc` is very likely credentials/environment-related.
* Every failure listed here exists **before** any migration work: the tree was
  unmodified during Phase 1.

## 8. Focused results — stream cancellation, JSON web fetching, SQLite

| Suite | Result | Detail |
|---|---|---|
| `tests/nodeHttpFetchCancel.test.cjs` | **PASS 5/5** (10 s) | The guarded adapter workaround is intact and untouched; zero occurrences of `ERR_INVALID_STATE` / `Controller is already closed` in the log. |
| `tests/webSearch.test.cjs` | **PASS 13/13** | Includes all JSON-specific cases: #5 readable/pretty-printed JSON, #7 invalid JSON degrades recoverably, #8 size limits, #9 HTTP/redirect/cancel semantics unchanged, #13 extractor answers a JSON API question. *Note:* the previous session reported 14 tests; the current TAP summary reports 13 — all pass, no JSON case is missing. |
| `tests/subAgentFetch.test.cjs` | **PASS 1/1** | Subagent fetch path. |
| `tests/dataMigration.test.cjs` | PASS 1/1 | DB migration. |
| `tests/incrementalPersistence.test.cjs` | PASS 1/1 | Incremental persistence. |
| `tests/sessionHistory.test.cjs` | PASS 1/1 | Session history. |
| `tests/chatFtsRemoval.test.cjs` | PASS 1/1 | FTS removal migration. |
| `tests/tabPersistence.test.mjs` | PASS 15/15 | Tab persistence. |
| `tests/desktopChat.test.mjs` | PASS 13/13 | Desktop chat flow. |
| `tests/messageMetadata.ui.cjs` | **FAIL** | The UI harness that closes/reopens SQLite and re-renders stats fails on `/Recorded thinking/` (see §6). SQLite itself initializes and persists in it — the failing assertion is a rendering expectation. |

better-sqlite3 probes: in-memory load OK under the embedded runtime; file-backed
create → write → close → reopen → read returned `ROUNDTRIP_OK {"row":{"v":"electron30-baseline"},"count":2}`.

## 9. Smoke-test outcomes

**A. Application startup and window — PASS (isolated profile).**
Launched `NODE_ENV=production electron .` under Xvfb with `HOME` and
`XDG_CONFIG_HOME` redirected to the ignored workspace (no user profile touched; no
pre-existing user instance existed or was touched). Evidence: alive after 15 s;
CDP target `title=Continuum`, `url=file://.../dist/index.html` (renderer loaded);
zero fatal/uncaught/module errors in the log (only software-rendering GPU/ANGLE
warnings typical under Xvfb); isolated `App_Data/memory_palace.db` created;
clean shutdown; no processes left behind.

**B. SQLite and persistence — PASS.** better-sqlite3 11.10.0 loads under
`ELECTRON_RUN_AS_NODE=1` (ABI 123); temp-file roundtrip OK (§8); app startup
created its schema in the isolated profile. The user's production database was
never opened.

**C. Chat and session behavior — PARTIAL.**
Automated: renderer → preload → main IPC round-trips verified end-to-end over CDP
(`electronAPI.getEngineStatus()` → `{"isLoaded":false,...}`,
`memoryPalace.getAllSessions()` → `[{"folder_name":"Uncategorized","sessions":[]}]`);
"✦ New chat" button located and clickable; app restart over CDP works; restart of the
empty profile restores cleanly with working IPC and no fatal lines.
**NOT RUN:** sending an actual message and restoring a non-empty conversation — the
Send button is correctly disabled with tooltip *"Select a cloud model or load a local
model"*; the model directory is empty (`~/Desktop/LLM_Models` does not exist) and no
cloud credentials are configured (corroborated by `cloudIpc` HTTP 401). This requires
a local model file or cloud credentials and must be exercised manually before Phase 2.

**D. Stream cancellation and web fetching — PASS.** See §8; the guarded adapter
workaround was not modified.

**E. Existing capabilities — automated evidence (this baseline) vs. end-to-end:**

| Area | Automated evidence at this commit | End-to-end |
|---|---|---|
| Tabs / session restore | `tabPersistence` 15/15, `sessionHistory` 1/1, `desktopChat` 13/13, `chatHistorySearch` PASS | real populated-profile restore NOT RUN (see C) |
| Local engine lifecycle | `engineLaunch`, `engineWarmup`, `engineIdle`, `localEngineFetch`, `sampling`, `ggufMetadata`, `modelLoadSettings` PASS | real `llama-server` + model NOT RUN (no models installed) |
| Cloud streaming | `cloudProviders` PASS; `cloudIpc` FAIL (HTTP 401, no credentials) | live cloud stream NOT RUN |
| Subagents | `spawnSubagent`, `subagentDispatchConcurrency`, `subagentRuntime`, `subagentSession`, `subagentModelSelection`, `subAgentPayload`, `subAgentFetch` PASS | `subAgentRunner` FAIL, `subAgentBadge.ui` FAIL (see §6) |
| MCP | `mcpManager`, `mcpConfig`, `mcpPermissions`, `mcpSse`, `mcpHotReload`, `mcpFilesystemDirectories` PASS | `mcpIpc` TIMEOUT, `filesystemToolLimits` FAIL (see §6) |
| Notifications | `notifications.test.cjs` PASS | desktop notification E2E NOT RUN (no DE integration test) |
| Playwright / screenshots | `nativePlaywright` PASS | platform-dependent screenshot behavior NOT RUN (X11 only) |
| Filesystem/shell permissions | `nativePermissions` PASS | `filesystemToolLimits` FAIL (see §6) |
| RAG / parsing | `rag` FAIL (see §6); `imageUtils`, `imageValidation`, `ggufMetadata` PASS | embedding run NOT RUN (no embedding server) |
| Media / image | `mediaProtocol`, `imageDecode.ui` PASS | image generation E2E NOT RUN (no model) |
| Clipboard | no dedicated automated test discovered | NOT RUN |

**F. Linux environment.** Baseline produced under the active **X11** session.
Wayland, GTK behavior, and platform-dependent screenshot differences were **not
tested** and are marked as future migration checks; no Wayland session was active to
safely switch to during this phase.

**G. AppImage / Debian packages — BUILT from current HEAD.**
`release/` and `dist/` are gitignored; the previous artifacts (Oct 8) predated HEAD
and were replaced. Sequence, with no dependency changes:

1. `npm run build` (vite 6.4.3, exit 0, 2026-10-09 19:11) — `dist/` regenerated from HEAD.
2. `node_modules/.bin/electron-builder --linux --publish never -c.npmRebuild=false`
   (exit 0, 19:12–19:14) — explicitly **skipped native rebuild** (`reason=npmRebuild is set to false`),
   packaged Electron 30.5.1 as-is.

| Artifact | SHA256 |
|---|---|
| `release/Continuum-1.0.0.AppImage` | `6f4d82d60eb7d2869769c1381a000153ba926de5ac23796bf9ba03fc80f2e0c0` |
| `release/continuum_1.0.0_amd64.deb` | `ab111e7f35a3fea7f7b2cb92fe943930ac8f49065137b2daa628a90c4cfc1d45` |

Packaged-launch smoke (isolated profile): AppImage runs, CDP shows
`title=Continuum` loading `file:///tmp/.mount_.../resources/app.asar/dist/index.html`,
zero fatal lines, isolated DB created, cleanly stopped. The stale Oct 8 artifacts are
not used as baseline; these fresh ones are the Phase 4 comparison reference.

## 10. Checks not run, and why

* **End-to-end conversation (create → generate → persist → restore across restart):**
  requires a local model file or cloud credentials — neither available; Send is
  intentionally disabled without a model. *Manual step before Phase 2.*
* **Local model server with a real model / llama-server inference:** no models in the
  model directory (only the `llama-server` binary exists).
* **Live cloud streaming:** no API keys configured (401 observed).
* **Real MCP server execution beyond fixtures:** fixture-based MCP tests pass;
  `mcpIpc` hangs — recorded, not fixed.
* **Wayland / GTK / platform screenshot behavior:** environment is X11-only today.
* **Windows x64 and macOS x64/arm64 builds:** CI-only targets, out of scope here.
* **Clipboard interaction:** no dedicated automated test exists in the suite; not
  manually exercised.

## 11. Raw logs and reproduction

All raw artifacts are gitignored under
`.llm_workspace/migration-baselines/electron30-7f4c24d/` (verified `.gitignore:49`
`.llm_workspace/`, directory created fresh for commit `7f4c24d`, no prior artifacts
overwritten):

* `environment.txt` — full environment capture.
* `results.tsv` / `per-file-results.md` — per-file machine-readable and rendered results.
* `progress.log` — run start/end, per-file timings.
* `logs/<test-file>.log` — raw output of every run (136 logs, ~12 MB total).
* `logs/ui-diag-*.log`, `ui-diag/`, `mcp-diag/` — instrumented-copy diagnostics
  (copies only; tracked tests untouched).
* `smoke*/`, `logs/smoke-*` — smoke-test profiles and logs.
* `run-baseline.sh`, `capture-environment.sh`, `run-smoke.sh`, `run-cdp-smoke*.sh`,
  `diagnose-ui.sh` — exact scripts used.
* `artifacts-sha256.txt` — packaged-build hashes.

Reproduce a single suite:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/<suite>.test.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/<suite>.ui.cjs
```

Reproduce the full sweep: `.llm_workspace/migration-baselines/electron30-7f4c24d/run-baseline.sh`

## 12. Change statement

During Phase 1, **Electron remains 30.5.1** (embedded Node 20.16.0, ABI 123) and
**better-sqlite3 remains 11.10.0**. No tracked source, test, configuration, or
dependency file was modified; the only tracked change is this document. No dependency
was installed, updated, or removed; no native module was rebuilt for Electron 44; the
Web Stream cancellation workaround is untouched; no test failure was fixed. All
processes started for this baseline (tests, Xvfb, smoke instances) were terminated,
and session-created `/tmp` test directories were removed.
