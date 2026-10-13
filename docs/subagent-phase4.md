# Phase 4 — independent acceptance and final review

2026-10-13, Asia/Dhaka. **Decision: not yet accepted for full live operation.** Deterministic runtime checks and real Electron interaction passed after one small accounting fix. Required live compaction/summary-fidelity and provider-adherence acceptance remains blocked by the unavailable loaded backend. No model benchmark or performance improvement is claimed.

## Inspection and availability

Reviewed Phase 0–3 reports/evidence, current working-tree status/diffs and the actual parent spawn protocol, child loop/lifecycle/continuation, dispatch/token ledger, selected-provider transports, shared compaction/checkpoint adapter, persistence, Settings, transcript formatter and production preload/IPC paths. Existing user changes were preserved. Historical artifact hashes match their Phase 4 starting values; nothing was committed, pushed, reset, stashed or discarded.

Host inspection found running Continuum processes but no llama inference process or model listener. The default health probe `curl --noproxy '*' --max-time 3 http://127.0.0.1:8080/health` returned exit 7 (connection refused). Because startup assigns a free port, listeners were also inventoried rather than assuming 8080 was authoritative. The intended Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf file exists (11,771,546,784 bytes), but no active model/context/tokenizer/sampling configuration could be obtained. No costly backend startup was attempted.

Electron is available on DISPLAY `:0`. Its inherited `ELECTRON_RUN_AS_NODE` flag must be removed for GUI runs. The actual production renderer launched using a temporary isolated profile, rendered its root and returned Automatic settings through production preload and the default trusted IPC check. The temporary launcher/profile were removed. No installed user profile was modified.

A new repeatable Electron acceptance fixture renders the actual Settings and transcript components, uses production preload and IPC handlers with a sender restricted to the fixture window, and persists through real SQLite in a temporary profile. Child outcomes are produced by the actual runtime/scheduler/provider path using mocked model replies. It verifies settings saved values against the SQLite record, null fallback, retained Custom values, invalid-value rejection and remount. It exercises actual completed, partial, failed and cancelled transcripts, plus missing provider usage. This is browser interaction and storage acceptance, not live inference or packaged-distribution certification. [Captured partial-result UI](subagent-phase4-ui.png) was visually inspected after Electron painted it.

## Acceptance scenarios

| # | Scenario | Result and practical limit |
| --- | --- | --- |
| 1 | Short read-only investigation | Passed deterministic/runtime/Electron: one request, no tools or compactions, completed output. Model response mocked. |
| 2 | Long child crosses pressure, compacts, continues and recalls early findings | Passed existing execution fixture; early value retained, no read replay. Live semantic acceptance blocked. |
| 3 | Repeated compaction preserves essential findings | Passed repeated-pressure/continuation, prior-checkpoint retention and raw/active pairing tests. Real summary fidelity unverified. |
| 4 | Tool/model-request ceiling returns honest output | Passed request/tool gates, bounded reporting, empty/finalization-error cases; real UI shows partial/tool_limit and findings. |
| 5 | Multi-tool budget boundary | Passed after fix: three calls, one executed, two paired skips, two blocked attempts. |
| 6 | Multiple children share aggregate ceiling | Passed shared-scope, concurrent-slot and continuation/compaction accounting fixtures. Live parent-model behavior unverified. |
| 7 | Completed side effects do not replay | Passed supported read-only path and mocked dispatch-effect counters through overflow/compaction. Mutation/shell/MCP tools are forbidden to children; production side-effecting child tools do not exist to test. |
| 8 | Cancellation/provider failure propagate | Passed runtime settlement and Electron transcript: cancelled/cancelled versus failed/provider_error. Live transport behavior remains unverified. |
| 9 | Usage display agrees with accounting | Passed measured fixture values and estimated-input/reserved-output cases, effective limits and aggregate snapshot. Fixture-reported tokens are not actual model measurements. |
| 10 | Settings persist and outcomes display | Passed real controls/preload/IPC/SQLite, plus existing modal open/reopen/stream-follow interaction. Full app isolated smoke also passed. |

Oversized essential checkpoint state, failed/malformed compaction, bounded one-overflow retry, failed requests retaining reservations, tool-free reporting, continuation with no ledger refill, short-task compaction avoidance and shared Workspace/Casual paths passed the focused checks. The fixed local allowlist remains read-only. Parent instructions contain bounded/non-overlapping assignments, evidence-first output and partial-result reuse; model adherence and avoidance of redundant children cannot be certified without live parent traces.

## Demonstrated defect and fix

`P4-1`: A three-call response with room for one tool correctly executed one and paired two skipped results, but reported only one blocked attempt. The first denial entered `dispatchTool`; subsequent calls inherited the batch stop and bypassed its counter.

- `src/main/subagents/agentLoop.js`: increment blocked attempts for later calls inheriting `tool_limit` or `aggregate_tool_limit`. First denial is still counted once by the existing gate. Dispatch, model/request/token limits and compaction policy are unchanged.
- `tests/subagentReliability.test.cjs`: extend the existing boundary case to three requested calls and assert both skipped results and blockedCalls=2. Before fix: 21 passed, 1 failed; after fix: 22 passed, 0 failed.
- `tests/subagentAcceptance.ui.cjs`: new acceptance gap coverage; actual runtime partial result displays two blocked attempts through production IPC.
- This report, `subagent-phase4-evidence.json` and the UI PNG: new observations only. Existing docs and historical evidence were not rewritten.

The initial new UI harness needed corrections for focus-out in a hidden window and asynchronous mode/remount waits; those were fixture races, not demonstrated product defects. Its final run passed. Electron logs an expected rejected invalid-value IPC request during validation. No other runtime fix was made.

## Exact validation

Focused command, before and after the runtime fix:

```sh
node --test tests/subagentDisplay.test.mjs tests/subagentCompaction.test.cjs tests/subagentReliability.test.cjs tests/subagentBudgets.test.cjs tests/subagentRuntime.test.cjs tests/subagentTranscript.test.cjs tests/subagentStreaming.test.cjs tests/contextCompaction.test.cjs tests/contextOverflowRecovery.test.cjs tests/compressionLifecycle.test.cjs tests/contextDispatch.test.mjs
```

Both runs: **11 test-file entries passed, 0 failed**. Direct post-fix cases: `node tests/subagentReliability.test.cjs` **22/0**; `node tests/subagentCompaction.test.cjs` **26/0**. The reproduction command used the extended boundary assertion before applying the fix and reported **21/1**.

Fresh pre-edit host baseline and final host command:

```sh
node --test tests/*.test.cjs tests/*.test.mjs
```

Both: **689 tests, 657 passed, 32 failed, 8 suites, 0 cancelled/skipped**. All failure names match between these fresh runs and the historical Phase 0 and Phase 3 records (Phase 0 numeric TAP prefixes normalized). No new or resolved broader failures. This phase establishes a fresh socket-enabled pre-fix baseline, removing the Phase 3 sandbox comparison limitation.

Diagnostic inspection confirms obsolete stream=false expectations in the child/background tests; incomplete Electron/getPath mocks and sender.once mocks in IPC/model-selection setup; and the existing attachment/UI/message/MCP/RAG failures. All 32 were reproducible before this phase's fix, and every name already appears in Phase 0, before Phases 1–3. This does not certify unrelated app behavior or prove clean HEAD is green. Their current diagnostics and historical comparisons are in the evidence JSON; unrelated failures were left unchanged.

GUI commands (each fixture passed):

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron --no-sandbox tests/subagentModal.ui.cjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron --no-sandbox tests/subagentAcceptance.ui.cjs
```

The temporary full-app launcher also passed: `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron --no-sandbox .phase4-launch.cjs`. It set userData/sessionData to a new `/tmp` profile, required `main.js`, waited for `dist/index.html`, and called `window.api.getSubagentBudgets()` through the default trusted sender path. It did not load a model; the launcher was removed after this one-shot smoke check.

`npm run build`: **passed**, existing large-chunk warning. `git diff --check`: **passed**. These do not substitute for the Electron tests or live model acceptance.

## Live campaign and reproducible continuation

**Zero live runs executed.** All nine Phase 0 N/M/B runs and the real repeated-compaction/exhaustion campaign remain unexecuted. There are no observed live durations, requests, tools, token counts, overflow events or success rates to compare with OpenCode/DSH. No synthetic fixture is counted as a benchmark.

To finish acceptance:

1. Open Continuum and load the exact Qwen GGUF documented in Phase 0. Record the actual assigned endpoint and verify `/health`, `/v1/models` and `/props`; capture backend build, effective context, child follow-parent selection, sampling and tokenizer method. Keep load/warmup separate. Do not repeatedly reload between runs.
2. Run the twelve-file oracle fixture with the explicit prompt and Custom policy in `docs/subagents.md` (16,384 context; calls=40, requests=60, aggregate=40, input=1,000,000, output=100,000). Repeat with a fresh child. Require actual compaction followed by progress, correct early/late markers, paired raw/active history, unchanged fixture hashes and no repeated completed reads. A long task without a compaction event is not compaction acceptance.
3. Run the documented exhaustion fixture (calls=1, requests=3, aggregate=2) in fresh read-only Workspace tasks. Inspect paired skips, shared aggregate accounting, bounded reporting, useful partial findings and parent reuse. Include cancellation and a controlled real transport failure; compare UI with persisted records. Restore desired Settings afterward.
4. Record each run's identifier, exact task/configuration, oracle checklist, start/settlement duration, all requests (drafts/reporting/retries included), actual dispatches/blocked attempts, provider-measured versus estimated/reserved usage, compaction/overflow events, stop reasons/errors and repeated-call signatures. Label pass/partial/fail/could-not-execute honestly in new evidence.
5. If resources permit, run the nine fixed Phase 0 prompts in the specified N1/M1/B1 order and fresh contexts. Evaluate the 50-call candidate under a separately recorded sufficient request/token/aggregate policy; do not tune the unchanged 10/8/40 defaults from these mocks or unmatched observations.

Remaining limits: live summary fidelity, estimator/threshold confidence, provider adherence and delegation usefulness remain unverified; aggregate UI is a settlement snapshot; persistence is best-effort and active jobs do not recover after restart; essential checkpoint growth fails closed; separate child-profile instructions and unknown provider overflow shapes remain inherited limitations. Deterministic safety and isolated Electron acceptance are satisfactory, but full live acceptance must wait for the backend. Stop here for review.
