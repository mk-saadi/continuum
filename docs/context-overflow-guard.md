# Local context-overflow guard and recovery

Implemented on `fix/context-overflow-guard` in `/tmp/continuum-context-overflow-guard`, from baseline `576d569`, on 2026-10-10. The original checkout and Electron 44 migration worktree are separate and unchanged. Dependency specifications, lockfile and the Web Stream cancellation workaround are unchanged. The implementation phase did not commit or merge the patch.

## Dispatch boundary and coverage

`src/main/localEngineFetch.js` now routes local `/v1/chat/completions` requests with a messages array through `contextBudget.createContextGuardedFetch`. This receives the final wire payload, including system/skill instructions, schemas, expanded attachments, retrieval, history and live tool results. It checks every invocation, so tool/autonomous continuations cannot bypass the guard.

Production coverage includes main chat, retry/regeneration/edited branches, child investigation loops/continuations, legacy one-shot file/web child requests, model warmup, title generation and summarization. The common local provider forwards the effective context limit and recovery callback through its existing scheduler. Cloud transports are unchanged. Callers injecting a custom fetch replace transport behavior, as before; tests inject the real guard around their fake backend.

## Counting and capacity

The installed llama-server identifies itself as `0.4.0-dev`, build 10899, commit d7680c67b. Its already-running loopback server responded to read-only `/props`, `/apply-template` and `/tokenize` probes. A small template probe contained the supplied tool name, description and parameter schema; tokenization returned 307 tokens. No inference/model launch/context-setting change was performed. The current server reported 20224 context tokens; that existing setting is not the incident's 8192 context and was not changed by this task.

When available, `/apply-template` receives the complete final payload, and `/tokenize` counts the formatted prompt with special-token parsing/insertion. A template missing advertised tool names or descriptions is not accepted as a complete tool-bearing prompt count. Configured capacity is bounded by the server's reported slot context, then output/thinking capacity and a small safety margin are reserved. Explicit output limits reserve max_tokens; the default/unlimited setting reserves up to 1024 tokens (or one quarter of the context). Thinking is part of output rather than an additional duplicated reserve. Existing generation parameters/context sizes are not increased or rewritten.

A bounded 64-entry cache reuses counts only after fresh props verify the same model path/template/context, with a hash of the complete payload. Unsupported counting APIs or images use an explicitly approximate full-request UTF-8/role estimate and a conservative image allowance. This is not exact multimodal accounting or proof of model-specific tokenization correctness. Counting probes have a 2.5-second combined timeout; local inference retains its existing unlimited header/body deadlines and explicit cancellation. Backend rejection remains authoritative.

References: [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) documents `/props`, `/apply-template` and `/tokenize`. The actual installed server capability was probed independently. A generation-to-preflight token-count equality test with the incident model was not run.

## Recovery and preservation

Typed context overflow is distinct from AbortError, transport errors and unrelated HTTP 400 responses. A dispatch has one recovery allowance and at most one inference retry. Initial preflight can use that same allowance; if its rebuilt request still fails, no further compaction loop is started. Unchanged inputs are never resubmitted. A second backend overflow terminates with an actionable error.

Main chat's callback invokes `compressionEngine.recoverContextOverflow`: cancel the old pending timer, await actual in-flight background work with cancellable waiting, then explicitly force compaction without the inaccurate normal 75% trigger. Normal background timing/threshold remain unchanged. Forced recovery respects the latest ten protected messages, includes selected attachment expansion in the summary source, and refuses a summary that increases its recoverable source estimate. Original rows/files remain stored; transactional archive/summary writes and existing snapshot checks apply. A summary request has a 512-token recovery ceiling, cancellation signal and the same guard without recursive recovery.

After commit, the request rebuild reads current settings, instructions, project/skill context, attachments and summary; refreshes schemas/sampling/retrieval; retains this run's complete tool-call/result and continuation tail; normalizes again; and rechecks the budget before resubmission. Regeneration excludes its replaced assistant from the rebuilt input while preserving that assistant's original variant.

Child investigations own separate, deliberately ephemeral context. Recovery summarizes only eligible complete older rounds, retaining ten recent messages and consistent tool pairs. Original selected rounds are archived on the owning child session record; a completed summary is applied before retry. This archive has the same process-lifetime durability as the existing child context, not SQLite durability. One-shot children have no eligible historical transcript, so oversize mandatory task/file content fails safely rather than being truncated or retried unchanged. Child summaries execute within the already-owned scheduler slot; they do not enqueue a nested request that could deadlock that slot.

Assistant persistence is lazy: a request rejected before producing data does not create another empty interrupted row. Genuine partial text/thought/tool/usage data still persists. Existing empty failed rows remain in SQLite but are excluded from inference-only rebuilds. No user messages or attachments are deleted.

## Tests and results

Tests execute files directly, inspecting TAP counts or explicit script completion markers. `--test` parent file-level exit codes alone are not used as substantive evidence. No full repository suite or model inference was run.

| Focused file | Result on baseline Electron 30.5.1 |
|---|---|
| contextBudget.test.cjs | 13/13 |
| contextOverflowRecovery.test.cjs | 7/7 |
| contextDispatch.test.mjs | 4/4 |
| localEngineFetch.test.cjs | 3/3, including real loopback transport/count/retry |
| contextCompaction.test.cjs | explicit completion marker |
| memoryChat.test.mjs | 40/40 |
| settingsResolver.test.cjs | explicit completion marker |
| notifications.test.cjs | explicit completion marker |
| incrementalPersistence.test.cjs | explicit completion marker |
| desktopChat.test.mjs | 13/13 |
| subagentRuntime.test.cjs | 9/9 |
| subagentSession.test.cjs | 8/8 |
| subagentModelSelection.test.cjs | 13/13 |
| nodeHttpFetchCancel.test.cjs | 5/5 |

All 14 focused files pass. Three new guard/recovery suites cover 24 cases; the existing transport suite adds an actual HTTP guard/retry case. Coverage includes mandatory assembled context, output reserve, inaccurate normal usage, pending timer/in-flight summary, committed archives/rebuild, retry bound, unchanged retry refusal, tool/schema growth, protected-only failure, failed-summary error, lazy blank persistence, regeneration variants, cancellation, child recovery and atomic tool pairs, cache invalidation and unsupported template fallback.

The three new suites, existing compaction, memoryChat, persistence and notification checks also pass under Electron 44.7.0 / Node 24.21.0. Because this branch intentionally retains baseline Electron 30/better-sqlite3 11 metadata, those native tests use a temporary test-only Module loader to select the already-installed migration better-sqlite3 13 binary. No dependency installation, version edit or modification of that migration dependency tree occurs.

Initial loopback tests were denied by the execution sandbox (listen EPERM). They were rerun with authorized loopback access. One old child HTTP fixture treated tokenizer probes as completion requests; it now explicitly returns 404 for unsupported probe routes while retaining its original completion assertions. The notification test now distinguishes unrelated 400 from typed overflow. These are relevant fixture/expectation updates, not fixes to baseline application failures.

Logs are under `/tmp/continuum-context-guard-results/`; reproduction/test runners and the Electron 44 test-only native loader are outside the repositories.

## Final review validation (2026-10-10)

The final review inspected all pending source, tests, fixtures and this report. main.js contains only recovery-summarization signal/output-limit changes; dependency metadata, renderer/preload configuration and the Web Stream cancellation workaround remain at the baseline.

Executed files directly under Electron 30.5.1: contextBudget 13/13, contextOverflowRecovery 7/7, contextDispatch 4/4, memoryChat 40/40, localEngineFetch 3/3 and subagentSession 8/8. contextCompaction, notifications and incrementalPersistence each exited 0 with its explicit completion marker. Thus all nine selected files passed: 75 TAP cases plus three script checks. The three new suites also passed 24/24 under Electron 44.7.0 using the previously described test-only native dependency loader. The prior 14-file and seven-file runs above are implementation-phase evidence, not a claim that this final review repeated them all.

Final-review logs and results: `/tmp/continuum-context-final-review-j8zfe98g/`. No model, full suite, GUI or package build was launched. No application code changes were needed during final review. The original checkout and migration worktree were protected by Git-state and pending-file hash checks. This isolated patch is committed only after these checks; no push or merge is authorized by this review.

## Remaining risks

Fallback estimates may reject valid requests or miss backend-specific costs; image patch counts are not validated. The authoritative overflow path remains bounded and safe. Full compulsory instructions/schemas/current attachments or protected turns may be impossible to fit even after summarization. Oversized summary input stops safely without archiving instead of implementing a new chunking strategy. Summary quality is model-dependent; original database rows and child in-memory archives are retained.

No real-model retry, GUI end-to-end run or packaged build was performed for this isolated patch. Child context/archives remain ephemeral as before. Default output reservation is a planning margin, not a new generation cap. Deployment onto Electron 44 still requires reviewing/applying this separate fix branch; the migration worktree has not been changed.

## Files

Source: main.js; src/lib/memoryChat.mjs; src/main/contextBudget.js; src/main/localEngineFetch.js; src/main/compressionEngine.js; src/main/promptBuilder.js; src/main/ipcHandlers.js; src/main/engineManager.js; src/main/subagents/agentLoop.js; src/main/subagents/contextRecovery.js; src/main/subagents/inferenceScheduler.js; src/main/subagents/providers/localProvider.js.

Tests: tests/contextBudget.test.cjs; tests/contextOverflowRecovery.test.cjs; tests/contextDispatch.test.mjs; tests/fixtures/contextBackend.cjs; tests/localEngineFetch.test.cjs; tests/notifications.test.cjs; tests/subagentSession.test.cjs. Documentation: this file.
