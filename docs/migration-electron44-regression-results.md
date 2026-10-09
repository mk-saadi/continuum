# Electron 44 migration — Phase 3 regression comparison

> Historical phase report: artifact hashes, Git state and conclusions below describe that phase only. See [renderer sandbox validation and final review](migration-electron44-renderer-sandbox.md) for the final migration state, corrected UI outcomes and remaining release limits.

Date: 2026-10-09 (Asia/Dhaka). **No new migration-related regression was observed in this inventory on the development host.** All 118 file outcomes match Electron 30: 100 PASS, 17 FAIL, 1 TIMEOUT. The 17 failures reproduce their prior substantive signatures; the timeout occurs at the same first MCP chat request. Existing failures were recorded, not fixed. Phase 3 stops here; no merge or Phase 4 work was started.

## Exact state and runner

| Item | Verified value |
|---|---|
| Migration worktree | `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration` |
| Branch | `electron-44-migration` |
| HEAD | `576d56957739f446ebe60ae74b57fddf5b6ba04b` |
| Electron manifest / lock / installed / runtime | 44.7.0 |
| Embedded Node / Chromium / V8 | 24.21.0 / 152.0.7977.130 / 15.2.124.28-electron.0 |
| Native ABI / Node-API | 149 / 10 |
| better-sqlite3 manifest / lock / installed | 13.0.3 |
| Host | Pop!_OS 24.04, Linux x86_64, glibc 2.39, X11; UI fixtures use Xvfb |
| Actual runtime binary | `node_modules/electron/dist/electron`, resolved within the migration worktree |
| Primary sweep time | 2026-10-09 20:54:52–20:59:33 +06:00 |

At start, `package.json` and `package-lock.json` already held the prior migration dependency changes; the two previous migration reports were untracked. All of those files were preserved byte-for-byte. SHA256 snapshots of every pre-existing tracked file and those reports were checked after each test and again at completion. No production code, tests, dependency versions or existing reports changed.

The original checkout `/home/mk_saadi/projects/persona-projects/llm-electron` remains clean on `feat/json-web-fetch` at the same HEAD. It was only read to recover baseline logs. The baseline document was added in commit 576d569; the actual baseline measurements are at `7f4c24dd6428f798929d80791119e83e71b23247`. Git confirms that 7f4c24d → 576d569 changed only the baseline document, so the test/production source is equivalent for this comparison.

Baseline sources: `docs/migration-baseline-electron30.md` and the original checkout's ignored `.llm_workspace/migration-baselines/electron30-7f4c24d/`, especially `results.tsv`, `run-baseline.sh`, raw logs and diagnostic copies.

Each file ran individually and sequentially:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test --test-reporter=tap tests/<file>.test.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test --test-reporter=tap tests/<file>.test.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/<file>.ui.cjs
```

TAP was selected explicitly because Node 24 otherwise defaults to a different reporter. Tests ran under Electron's embedded Node, not system Node. System Node was used only to drive the CDP startup smoke. The primary limit was 120 seconds per file; timeout cleanup sent TERM, allowed a short grace period, then KILL if needed. Only recorded task-owned descendants were cleaned, with PID birth-time checks. Failures did not stop later tests.

Each primary/diagnostic run used a fresh HOME, XDG config/data/cache and TMPDIR beneath the ignored evidence directory; inherited PATH retained the installed llama-server used by the existing model-load-settings test. NODE_OPTIONS was removed. UI lifecycle diagnostics preserve the original test filename and source, adding only an ignored wrapper that prevents premature window-all-closed exit so errors can print. No assertions or production behavior were modified.

## Inventory and totals

118 runnable files: 71 `*.test.cjs`, 24 `*.test.mjs`, 23 `*.ui.cjs`. All paths match the baseline exactly: **0 added, 0 removed, 0 renamed**. The 17 fixture/support files under `tests/fixtures/` remain excluded from independent execution. Recently introduced Skills, UI, subagent, permission and model-load-settings tests already existed in Phase 1 and are included here.

| Status | Electron 30 | Electron 44 |
|---|---:|---:|
| PASS | 100 | 100 |
| FAIL | 17 | 17 |
| TIMEOUT | 1 | 1 |
| INFRASTRUCTURE ERROR | 0 | 0 |
| NOT RUN | 0 | 0 |
| Total | 118 | 118 |

Node-runner breakdown: 87 PASS, 7 FAIL, 1 TIMEOUT across 95 files. TAP totals from completed files: **425 tests, 418 pass, 7 fail, 0 skipped, 0 cancelled**, matching the baseline. The timed-out MCP file produces no completed TAP summary and is accounted for separately. UI breakdown: 13 PASS, 10 FAIL across 23 files.

| Comparison category | Files |
|---|---:|
| PASS → PASS | 100 |
| Previously failing → PASS | 0 |
| Previously passing → FAIL | 0 |
| New test with no baseline | 0 |
| Existing failure with the same substantive signature | 18 (17 FAIL + 1 TIMEOUT) |
| Existing failure with a changed substantive signature | 0 |
| Environment/infrastructure mismatch | 0 |

UI PASS requires its exact baseline success marker plus exit 0. Eight failing primary UI harnesses exited 0 without that marker; two exited 1. Diagnostic copies recovered all 10 actual failure signatures. Baseline `FAIL-SILENT-EXIT0` entries are normalized to FAIL for the comparison.

## Existing failures and timeout, revisited

| File | Electron 44 evidence | Baseline comparison |
|---|---|---|
| `attachments.test.cjs` | 9 !== 5 at line 81 | Same strictEqual assertion |
| `messageActions.test.cjs` | 0 !== 2 at line 54 | Same strictEqual assertion |
| `messageStats.test.cjs` | expected `siblings: [2]` missing, line 80 | Same deepStrictEqual mismatch |
| `subAgentRunner.test.cjs` | line 189 rejects MAIN HISTORY SECRET in child request; then timer accesses uninitialized DB | Same assertion and secondary initDatabase error |
| `rag.test.cjs` | fetch failed → ECONNREFUSED 127.0.0.1:8080; notification mock lacks isSupported | Same environment-sensitive failure and secondary warning |
| `cloudIpc.test.cjs` | openai request failed, HTTP 401; notification mock warning | Same Phase 1 failure; cloud path still does not succeed in this test environment |
| `filesystemToolLimits.test.cjs` | subtest 4, MCP cap before serialization: DB not initialized | Same error; first 3 subtests pass |
| `chatHistory.ui.cjs` | Escape restores focus | Same failed focus restoration assertion |
| `cloudSelection.ui.cjs` | null textContent | Same error |
| `engineSelection.ui.cjs` | LastNot loaded versus /Active.*Ready/ | Same assertion |
| `fileBrowser.ui.cjs` | Actual local image loads through protocol and CSP | Same page assertion |
| `memorySettings.ui.cjs` | cannot resolve ../../src/components/MemorySettings | Same missing import |
| `messageMetadata.ui.cjs` | Thought for 0.00s versus /Recorded thinking/ | Same assertion, before the harness's later close/reopen stage |
| `projects.ui.cjs` | null textContent | Same error |
| `reasoningSettings.ui.cjs` | stub ChatMessage lacks MessageContextStatus export | Same esbuild error in raw baseline log |
| `subAgentBadge.ui.cjs` | Failure status and reason | Same page assertion |
| `thinkingBudget.ui.cjs` | ChatInputBar lacks ThinkingBudgetSelector export | Same esbuild error |
| `mcpIpc.test.cjs` | first engine:chat never completes; primary timeout after 120.23 s | Same hang stage, confirmed below |

`agentTools.test.cjs` passes 1/1, as it did in the reliable Electron 30 baseline. Older reports calling it a known failure are not used to classify this migration.

For `mcpIpc`, a separate 30-second logging-only diagnostic reused the baseline stage instrumentation and compiled it with the current migration test filename. It records test 1 entering, mcp:get-tools succeeding, unsupported reasoning effort rejection succeeding, exactly one mocked fetch to 127.0.0.1:12345/v1/chat/completions, and no marker after the first engine:chat await. Test 2 never enters. This matches the documented Electron 30 hang; the second diagnostic timeout is supporting evidence, not an extra inventory file.

**Raw presentation changes are documented, not hidden:** the timeout wrapper records Electron's actual exit 1 after TERM instead of GNU timeout's baseline synthetic 124, and Node 24 prints an “Interrupted while running” line. `reasoningSettings.ui` and `thinkingBudget.ui` now exit 1 rather than silently exiting 0, but their exact esbuild errors are unchanged. Stack frames, absolute worktree paths and reporter formatting also vary with Node/runtime and diagnostic wrapper location. No substantive failing assertion or hang signature changed.

## Critical regression coverage

| Critical coverage | Electron 44 result |
|---|---|
| nodeHttpFetchCancel.test.cjs | PASS 5/5; no ERR_INVALID_STATE / Controller is already closed |
| webSearch.test.cjs | PASS 13/13, including JSON responses and cancellation behavior |
| subAgentFetch.test.cjs | PASS 1/1 |
| dataMigration / incrementalPersistence / sessionHistory / chatFtsRemoval | PASS 1/1 each |
| legacyDataMigration / chatHistorySearch / recentChatHistory | PASS 1/1 each |
| tabPersistence.test.mjs / desktopChat.test.mjs | PASS 15/15 and 13/13 |
| Skills Node tests | skills 1/1; import IPC 7/7; proposal IPC 3/3; legacy proposal IPC 3/3; step args 5/5 |
| Skills UI | skillImportDialog, skillProposalCard, skillProposalProjectId all PASS with markers |
| Subagents | spawn 5/5; failure diagnostics 5/5; model selection 13/13; runtime 9/9; session 8/8; dispatch concurrency 11/11; payload/fetch PASS; known runner/badge failures remain |
| Permissions | nativePermissions 1/1; permissionPolicy 1/1; toolPermissions 10/10; permissionSelector 11/11; permissionMode UI PASS |
| Model-load settings | Node 1/1 and UI PASS; installed llama-server CLI flag checks executed |
| UI initialization/rendering | 13 UI harnesses PASS, including imageDecode, headerContext, directorySettings, modelLoadSettings, sessionDraft and tabSavedFlag; 10 known failures remain |
| Actual application startup | PASS in fresh isolated profile; main/SQLite initialization, loaded renderer/React root, preload/main IPC and clean exit 0 |

The actual startup smoke launched the existing worktree `electron .` under Xvfb with production NODE_ENV. It used existing dist output from the packaged-validation phase, created a fresh Continuum/App_Data/memory_palace.db, confirmed the Continuum renderer and empty session-list IPC, and closed the window normally. No build or release cycle was rerun. This verifies startup; it does not claim model inference or live cloud service success. The UI fixtures bundle current source as in the baseline; dist CSS/index.html was regenerated during the earlier authorized packaging phase, whereas the original Phase 1 dist predated its HEAD. No result or signature mismatch was observed from that artifact difference.

`src/main/nodeHttpFetch.js` is byte-identical to its starting snapshot. No broad performance benchmark was conducted; per-file durations serve only execution/timeout evidence. The existing chatInputPerformance UI test was run because it is part of the required inventory, without adding any benchmark.

## Full per-file outcomes

Detailed commands, start/end times, durations, actual exits, TAP counts, markers and cleanup PIDs are saved in `results.json`, `comparison.json`, `results.tsv` and `logs/` under the ignored evidence directory. S means an existing failure/timeout with the same substantive signature; P means PASS → PASS.

| tests/ file | Electron 30 | Electron 44 | Comparison |
|---|---|---|---|
| `agentTools.test.cjs` | PASS | PASS | P |
| `agents.test.cjs` | PASS | PASS | P |
| `apiServerPort.test.cjs` | PASS | PASS | P |
| `attachments.test.cjs` | FAIL | FAIL | S |
| `backgroundExecution.test.cjs` | PASS | PASS | P |
| `chatExport.test.cjs` | PASS | PASS | P |
| `chatFtsRemoval.test.cjs` | PASS | PASS | P |
| `chatHistorySearch.test.cjs` | PASS | PASS | P |
| `childAgentLoop.test.cjs` | PASS | PASS | P |
| `childMessaging.test.cjs` | PASS | PASS | P |
| `cloudIpc.test.cjs` | FAIL | FAIL | S |
| `cloudProviders.test.cjs` | PASS | PASS | P |
| `compactionBadge.test.cjs` | PASS | PASS | P |
| `contextCompaction.test.cjs` | PASS | PASS | P |
| `dataMigration.test.cjs` | PASS | PASS | P |
| `engineIdle.test.cjs` | PASS | PASS | P |
| `engineLaunch.test.cjs` | PASS | PASS | P |
| `engineSettings.test.cjs` | PASS | PASS | P |
| `engineWarmup.test.cjs` | PASS | PASS | P |
| `filesystemToolLimits.test.cjs` | FAIL | FAIL | S |
| `generateTitleIpc.test.cjs` | PASS | PASS | P |
| `generatedTitle.test.cjs` | PASS | PASS | P |
| `ggufMetadata.test.cjs` | PASS | PASS | P |
| `incrementalPersistence.test.cjs` | PASS | PASS | P |
| `inferenceScheduler.test.cjs` | PASS | PASS | P |
| `legacyDataMigration.test.cjs` | PASS | PASS | P |
| `localEngineFetch.test.cjs` | PASS | PASS | P |
| `markdownCode.test.cjs` | PASS | PASS | P |
| `mcpConfig.test.cjs` | PASS | PASS | P |
| `mcpFilesystemDirectories.test.cjs` | PASS | PASS | P |
| `mcpHotReload.test.cjs` | PASS | PASS | P |
| `mcpIpc.test.cjs` | TIMEOUT | TIMEOUT | S |
| `mcpManager.test.cjs` | PASS | PASS | P |
| `mcpPermissions.test.cjs` | PASS | PASS | P |
| `mcpSse.test.cjs` | PASS | PASS | P |
| `mediaProtocol.test.cjs` | PASS | PASS | P |
| `memoryNormalization.test.cjs` | PASS | PASS | P |
| `messageActions.test.cjs` | FAIL | FAIL | S |
| `messageBranches.test.cjs` | PASS | PASS | P |
| `messageStats.test.cjs` | FAIL | FAIL | S |
| `midRunQuestions.test.cjs` | PASS | PASS | P |
| `modelLoadSettings.test.cjs` | PASS | PASS | P |
| `modelScanner.test.cjs` | PASS | PASS | P |
| `nativePermissions.test.cjs` | PASS | PASS | P |
| `nativePlaywright.test.cjs` | PASS | PASS | P |
| `nodeHttpFetchCancel.test.cjs` | PASS | PASS | P |
| `notifications.test.cjs` | PASS | PASS | P |
| `permissionPolicy.test.cjs` | PASS | PASS | P |
| `projects.test.cjs` | PASS | PASS | P |
| `rag.test.cjs` | FAIL | FAIL | S |
| `recentChatHistory.test.cjs` | PASS | PASS | P |
| `replyVariants.test.cjs` | PASS | PASS | P |
| `sampling.test.cjs` | PASS | PASS | P |
| `sessionHistory.test.cjs` | PASS | PASS | P |
| `settingsResolver.test.cjs` | PASS | PASS | P |
| `skillImportIpc.test.cjs` | PASS | PASS | P |
| `skillProposalIpc.test.cjs` | PASS | PASS | P |
| `skillProposalLegacyIpc.test.cjs` | PASS | PASS | P |
| `skills.test.cjs` | PASS | PASS | P |
| `spawnSubagent.test.cjs` | PASS | PASS | P |
| `streamDispatcher.test.cjs` | PASS | PASS | P |
| `subAgentFetch.test.cjs` | PASS | PASS | P |
| `subAgentPayload.test.cjs` | PASS | PASS | P |
| `subAgentRunner.test.cjs` | FAIL | FAIL | S |
| `subagentFailureDiagnostics.test.cjs` | PASS | PASS | P |
| `subagentModelSelection.test.cjs` | PASS | PASS | P |
| `subagentRuntime.test.cjs` | PASS | PASS | P |
| `subagentSession.test.cjs` | PASS | PASS | P |
| `tokenUsage.test.cjs` | PASS | PASS | P |
| `toolPermissions.test.cjs` | PASS | PASS | P |
| `webSearch.test.cjs` | PASS | PASS | P |
| `autonomyLoop.test.mjs` | PASS | PASS | P |
| `chatTitle.test.mjs` | PASS | PASS | P |
| `desktopChat.test.mjs` | PASS | PASS | P |
| `directoryListing.test.mjs` | PASS | PASS | P |
| `headerWorkspace.test.mjs` | PASS | PASS | P |
| `historyRewind.test.mjs` | PASS | PASS | P |
| `imageUtils.test.mjs` | PASS | PASS | P |
| `imageValidation.test.mjs` | PASS | PASS | P |
| `markdownMedia.test.mjs` | PASS | PASS | P |
| `memoryChat.test.mjs` | PASS | PASS | P |
| `messageIdentity.test.mjs` | PASS | PASS | P |
| `permissionSelector.test.mjs` | PASS | PASS | P |
| `projectToolLoopGuard.test.mjs` | PASS | PASS | P |
| `repetitionDetector.test.mjs` | PASS | PASS | P |
| `skillProposalStepArgs.test.mjs` | PASS | PASS | P |
| `subagentDispatchConcurrency.test.mjs` | PASS | PASS | P |
| `tabIcons.test.mjs` | PASS | PASS | P |
| `tabPersistence.test.mjs` | PASS | PASS | P |
| `tabShortcuts.test.mjs` | PASS | PASS | P |
| `toolArgumentLimit.test.mjs` | PASS | PASS | P |
| `toolDisplay.test.mjs` | PASS | PASS | P |
| `toolFailureCircuitBreaker.test.mjs` | PASS | PASS | P |
| `toolResultFormatter.test.mjs` | PASS | PASS | P |
| `xmlToolStreaming.test.mjs` | PASS | PASS | P |
| `chatHistory.ui.cjs` | FAIL | FAIL | S |
| `chatInputPerformance.ui.cjs` | PASS | PASS | P |
| `cloudSelection.ui.cjs` | FAIL | FAIL | S |
| `directorySettings.ui.cjs` | PASS | PASS | P |
| `engineSelection.ui.cjs` | FAIL | FAIL | S |
| `fileBrowser.ui.cjs` | FAIL | FAIL | S |
| `headerContext.ui.cjs` | PASS | PASS | P |
| `imageDecode.ui.cjs` | PASS | PASS | P |
| `markdownCode.ui.cjs` | PASS | PASS | P |
| `memorySettings.ui.cjs` | FAIL | FAIL | S |
| `messageMetadata.ui.cjs` | FAIL | FAIL | S |
| `modelLoadSettings.ui.cjs` | PASS | PASS | P |
| `permissionMode.ui.cjs` | PASS | PASS | P |
| `projects.ui.cjs` | FAIL | FAIL | S |
| `reasoningSettings.ui.cjs` | FAIL | FAIL | S |
| `sessionDraft.ui.cjs` | PASS | PASS | P |
| `skillImportDialog.ui.cjs` | PASS | PASS | P |
| `skillProposalCard.ui.cjs` | PASS | PASS | P |
| `skillProposalProjectId.ui.cjs` | PASS | PASS | P |
| `subAgentBadge.ui.cjs` | FAIL | FAIL | S |
| `tabSavedFlag.ui.cjs` | PASS | PASS | P |
| `thinkingBudget.ui.cjs` | FAIL | FAIL | S |
| `tokenHistory.ui.cjs` | PASS | PASS | P |

## Limitations, evidence and completion

No inventory file was NOT RUN or blocked by infrastructure. The MCP file's later subtests remain unexecuted because the first hangs; a file timeout is not a pass. Likewise the known UI failures prevent later assertions in those harnesses from running. Independent persistence and startup checks pass, but messageMetadata's failed earlier assertion does not prove its later close/reopen rendering stage.

The existing cloud/localhost-dependent failures and fixture/import/assertion failures remain unresolved; this assessment does not establish every feature's correctness. Older Linux portability, packaged desktop installation, Wayland, real model inference and live cloud validation remain outside Phase 3. Refer to the previous compatibility and packaged-validation reports for their measured scope and remaining release gaps.

Raw evidence: `.llm_workspace/phase3-electron44-regression/` in the migration worktree. It was created fresh and verified ignored; no existing evidence was overwritten. It contains source/dependency snapshots, original baseline result copy, runtime/environment/inventory, runner and UI-marker definitions, all 118 primary logs, 10 UI diagnostic logs/wrappers, the MCP stage diagnostic, isolated startup evidence, full comparison and final process/file checks. Temporary profiles and databases remain confined to ignored evidence; none were added to Git.

Only `docs/migration-electron44-regression-results.md` is a new source-tree documentation change from Phase 3. Existing migration modifications and reports are unchanged, original checkout remains clean, and no production/test/dependency file changed. No task-created test/application/background process remains. No dependency operation, fix, refactor, full build/release, commit, push or merge was performed.

Conclusion: all 118 outcome transitions and substantive failure/timeout signatures match the Electron 30 baseline. **No new migration-related regressions were found in the tested inventory on this host.** This preserves the baseline's known deficiencies rather than certifying them as correct. Stop after Phase 3.
