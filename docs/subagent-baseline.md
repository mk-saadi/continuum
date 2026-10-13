# Continuum subagent baseline — Phase 0

Audit date: 2026-10-13 (Asia/Dhaka). Phase 0 only. No runtime, settings, model-load configuration, or existing tests were changed. No reset, commit, or push was performed.

## Outcome and evidence boundaries

The architecture audit and deterministic baseline are complete. **The requested nine model benchmark runs were not executed:** the saved Qwen3.8 27B model exists, but no accessible loaded inference backend was found. All nine remain explicitly pending below. This is not a zero-percent measured success rate. No simulated completion or historical run is counted as a benchmark run.

The audited base is HEAD `31865ff5627538bb29cce2bd64b7115d38914f82` plus the existing working tree. There were 90 modified/untracked entries before this report, including 60 modified tracked files (4,083 insertions, 1,037 deletions). The budget modules, persistence module, streaming completion reader, Settings component, and budget/transcript tests were already untracked; orchestration, providers, database, IPC, preload, and many UI/tests were already modified. These are the current implementation, not changes made by this audit. No applicable repository AGENTS.md was found. `subagent-baseline-evidence.json` records source SHA-256 hashes, the pre-report status, and individual test failures to make this dirty-tree baseline identifiable.

Evidence types in this report are explicitly separate: source inspection, executed deterministic tests, saved configuration, old execution-history observations, and unexecuted benchmark plans. Source-derived policy numbers are not measured model usage.

## Environment and model configuration

- Repository: `/home/mk_saadi/projects/persona-projects/llm-electron`; Continuum 1.0.0; Node v22.23.2; package specifies Electron 44.7.0.
- Existing data directory: `/home/mk_saadi/.config/Continuum`; history read with Python SQLite URI `mode=ro`, without initializing/migrating the live database or printing task, thought, answer, or credential contents.
- Saved `subagentBudgets`: `{ "mode": "auto", "maxInputTokens": 200000, "maxOutputTokens": 16000 }`. The numeric custom fields are dormant in Automatic mode.
- Saved `subagentModel`: `null`, meaning follow the parent model. No separate child agent profile is selected by the exposed spawn interface. Investigation uses its fixed read-only system instructions.
- Saved intended local model identifier: `/home/mk_saadi/all-llm-related/llm-folder/extra_llms/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf`. File exists (11,771,546,784 bytes).
- Saved load settings for that exact path: contextLength 102400, gpuOffload auto, threads 4, evalBatch 1024, physicalBatch 512, parallel 1, mlock false, flashAttention auto, cacheTypeK q4_0, cacheTypeV q4_0, chatTemplate auto, reasoningFormat auto, kvCacheOffload gpu, loadMode auto, moeExpertCount null. These are persisted values, **not verified active backend properties**.
- Active endpoint/model/context: unavailable. `main.js` initializes port 8080 but startup uses `getFreePort`, so 8080 is not proof of a current endpoint. Host-side `curl --noproxy '*' --max-time 3 http://127.0.0.1:8080/health` failed with exit 7: `Failed to connect to 127.0.0.1 port 8080 ... Couldn't connect to server`. Host process/listening-port inspection showed Continuum processes but no llama model process or model listener. The Python listener on 8085 returned an authentication-completion page, not model health, and disappeared before `/v1/models`. No live model was substituted or separately launched with guessed settings.
- Startup time: not observed. Model turns/requests/usage/cache/pressure for the fixed battery: unavailable because no run began.

## Fixed benchmark protocol

Run the following exact parent prompts in three fresh Workspace tasks each, rooted at this repository. Keep the parent and inherited child on the Qwen path above, Automatic budgets, the same permissions/tool configuration, sampling settings and backend build throughout all nine runs. Record effective parent instructions, enabled tool schemas, sampling settings and backend `/props` before execution; these live values are not known in this session. Use read-only permissions. Do not let parent inspection replace mandatory child work.

Keep the server/model loaded for all nine; perform one excluded warmup before N1. Record warmup and model startup separately, then use the fixed order N1, M1, B1, N2, M2, B2, N3, M3, B3. Create a new parent task and new child identities each time; no resume, inbox, prior task history or previous findings. Backend prompt-cache behavior may persist: keep it consistent and report it, rather than claiming cache-free conditions. Do not clear/reload the model between runs. Save wall-clock start/settlement timestamps and bounded existing telemetry without full private prompts or credentials.

Success requires all correctness criteria and mandatory delegation. Partial requires a useful, accurate subset and explicit missing criteria. Failure includes no useful answer, false claims, or missing actual delegation; report limit failures even if partial evidence exists. Judge correctness against the pinned audited source, not rhetorical quality. If a future runtime phase changes a numeric policy, update the oracle's versioned expected values, not the task prompts or their substantive criteria. Run the baseline before tuning implementation.

### Narrow — exact parent prompt

```text
In this repository, perform a read-only investigation. Launch exactly one child with spawn_sub_agent and investigate=true to inspect src/main/subagents/budgetSettings.js. Ask it to report the persisted settings key, default settings shape, accepted modes, numeric input/output bounds, and how a partial settings patch is merged and saved. Require the child to read the source. Return a concise answer naming the responsible functions and source evidence. Do not answer from your own inspection, edit files, run commands, or use a file-analysis shortcut.
```

Correctness checklist N (all required):

1. Exactly one real investigation child linked to this parent; child tool results show a source read of the specified file.
2. Key `subagentBudgets`; default `{mode:'auto', maxInputTokens:null, maxOutputTokens:null}`; modes auto/custom.
3. Input bounds 512–1,000,000; output bounds 256–500,000; values must be safe integers or unset/null.
4. Names `normalizeBudgetSettings`, `getBudgetSettings`, `saveBudgetSettings`; merge with current saved record, validate, then upsert `app_settings.value_json`.
5. Useful accurate visible final answer; no writes or unrelated claims.

### Medium — exact parent prompt

```text
In this repository, perform a read-only comparison. Launch exactly one child with spawn_sub_agent and investigate=true to inspect both src/main/subagents/budgets.js and src/main/subagents/agentLoop.js. Ask it to explain how Automatic/Custom token budgets relate to investigation turn and tool-call limits, how usage is accounted, what retry is allowed, and how each exhaustion path ends. Require actual reads of both files and identify any mismatch between claimed hard limits and request construction. Return a concise evidence-based comparison naming functions. Do not replace delegation with your own inspection, edit files, run commands, or use a file-analysis shortcut.
```

Correctness checklist M:

1. Exactly one actual investigation child; tools read both files.
2. Automatic investigation output 8×2048=16384; input 4×child context; Custom overrides each non-null side independently; fallback context 32768.
3. `runInvestigationExecution` defaults eight turns/ten tools; per-call gate means no executed multi-tool overshoot; limits throw and no finalization request is added.
4. `recordTurn` separates measured/estimated input and unknown output; output unknown is not zero actual usage. `canAffordNext` only reserves 256; normal `max_tokens:ceiling` is not clamped to remaining output.
5. One escalation for length-truncated unusable content/no tools, bounded by remaining output/window; reasoning-only stop can yield placeholder completion.
6. Budget stop text/`budgetExhausted` differs from thrown limits; runtime settlement drops that extra flag. Useful accurate visible final answer and no mutations.

### Broad — exact parent prompt

```text
Perform a read-only architecture investigation of this repository using actual delegation. Launch exactly four distinct investigation children with spawn_sub_agent and investigate=true, one per area: (A) src/main/subagents/agentLoop.js and budgets.js: execution limits, usage and incomplete-response handling; (B) src/main/subagents/index.js, sessionManager.js and persistence.js: lifecycle, parent results and transcript durability; (C) src/main/subagents/modelSelection.js and providers/localProvider.js and cloudProvider.js: child model routing and context handling; (D) src/main/compressionEngine.js, taskCheckpoints.js and subagents/contextRecovery.js: Workspace versus child compaction. Give each child only its area's assignment and require actual source reads. Wait for their individual outcomes, then synthesize an evidence-based table of current behavior, failure risks and reusable components. Report partial findings and each failed child explicitly. Do not perform all four areas yourself, launch replacement children, edit files, or run commands. Delegation is mandatory; mentioning subagents is not completion.
```

Correctness checklist B:

1. Four distinct actual investigation children linked to the same parent, with matching areas and source reads; no replacement children or parent-only completion. All four outcomes accounted for.
2. A: execution-level 8/10 limits, separate cumulative token ledger, no parent aggregate child-call ledger, output-clamping/accounting gaps, bounded truncation retry.
3. B: shared foreground/background paths, completed/failed/cancelled/interrupted states, safe committed context; 1800-character parent result cap; persisted previews are not raw resumable history; budget exhaustion can look completed.
4. C: null follows parent, local/cloud setting resolved once before spawn; continuations retain engine; cloud metadata/fallback differs from local context guard; fixed child instructions/read-only allowlist.
5. D: existing child-local recovery exists; Workspace engine is DB/session coupled, not directly safe on a child transcript; preserves briefs/evidence and validates checkpoint; pressure-based adapter needed.
6. Synthesis correctly connects limits, lifecycle, persistence and compaction with source functions; useful accurate visible final answer, explicit missing evidence, no edits.

### Individual runs and aggregates

`U` below means **unexecuted**, not failure or partial success. Blocker E is the unavailable loaded inference backend described above.

| Run | Outcome | Checks passed/failed | Final answer present/useful/accurate | Stop/error | Children/outcomes | Turns/tools/unique/repeated | Duration | Input/output/requests/timing | Cache/retries/context/compactions/ceiling |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| M1 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| B1 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| N2 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| M2 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| B2 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| N3 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| M3 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |
| B3 | U | Not evaluated | N/A | E, no task started | 0 / N/A | N/A | N/A | N/A | N/A |

| Task | Planned | Executed | Missing | Success/partial/failure | Measured duration/usage |
| --- | --- | --- | --- | --- | --- |
| Narrow | 3 | 0 | 3 | Not evaluated | Unavailable |
| Medium | 3 | 0 | 3 | Not evaluated | Unavailable |
| Broad | 3 | 0 | 3 | Not evaluated | Unavailable |

For later runs, record provider-reported prompt/completion usage separately from `estimatePromptTokens`; never infer output usage from visible length. Count attempted model requests separately from successful turns, including summaries, overflow retries, and failed requests. Unique calls should be canonical `(tool name, parsed arguments)` signatures; report rejected attempts separately from actual executions. Only label a cached execution when the runtime/backend actually reports it. Include per-child and parent wall time and each passed/failed checklist item. Current observability cannot populate every field retrospectively (see below).

## Existing history: supporting evidence, not the battery

Read-only query of `subagent_runs` found 14 old rows: file-analysis completed 1, failed 8, cancelled 1; investigation failed 4. The four Qwen-path investigation rows all contain the ten-tool-call-limit error. Recorded durations were 112541, 119837, 135680 and 42897 ms; stored message counts 15, 14, 15 and 16; `total_tokens` was NULL in all four. Eight Spark-X2.5 file-analysis failures contain “generated no output tokens”; no committed messages were stored. These observations support the failure mechanisms below, but their prompts/startup/measurement conditions were not matched to the fixed tasks, so they are not controlled comparisons or substitute runs. Historical OpenCode 23/31/37-call figures are user-provided context only; no matching-prompt comparison is claimed.

## Actual call paths and failure semantics

| Behavior | Actual source/functions | Findings |
| --- | --- | --- |
| Exposed delegation | `src/main/tools/agentTools.js:executeAgentTool`; `tools/subagent.js:executeSpawnSubagent` | investigate=true selects loop; target_file selects file analysis; explicit/inferred single URL selects web extraction. Conflicting investigation/file/URL shapes fail validation. Parent task max 2000 chars; combined instruction up to child 8000. No nested spawning in child allowlist. |
| Legacy paths | `src/main/subAgentRunner.js:runSubAgent,extractWebPageData`; `agentTools.js:executeAgentTool` | Facade forwards to same runtime file/web functions. Legacy “strict 4000” description is stale relative to implementation's dynamic file budget; audit actual code before changing behavior. |
| Foreground/background | `subagents/index.js:runInSession,startInBackground,executionFor,openRun,settleFirstTurn` | Same per-kind execution functions and scheduler. Model resolved before child creation. Foreground returns output or throws; background returns identity immediately and records completion event later. |
| Investigation | `subagents/agentLoop.js:runInvestigationExecution,executeChildTool,normalizeToolCalls` | Own system/task/assistant/tool messages; fixed temperature .2; 2048 request output, 6000-character final cap, 12000-character tool-result cap. Four allowlisted native reads/fetches with independent read_only execution permission. Errors fed back as tool results; aborts rethrown. |
| Counting | `agentLoop.js:runInvestigationExecution` | Default maxTurns=8, maxToolCalls=10; explicit internal options require safe integers 1–100. Settings/IPC do not expose these options. Turn guard is checked before inference. Each tool is counted before validation/execution, including forbidden or malformed calls. A reply may advertise more than ten, but no eleventh execution occurs. |
| Multi-tool exhaustion | same function, tool loop and commit closure | If limit is reached midway through batch, earlier tools may already have executed; loop throws before committing whole batch. `session.context` retains only preceding fully paired round. Activity may show executed calls absent from committed transcript. Read-only current tools constrain replay consequences. |
| Finalization | same loop | No extra final model request after tool/turn exhaustion. Ten executed tools may still be followed by a final no-tool answer if within turn/token allowance; another requested tool throws. Eight completed tool-bearing turns end with turn-limit throw. |
| Truncation/incomplete answers | same loop; `budgets.js:escalatedCeiling` | Exactly one escalation when finish_reason=length and no usable visible content/tool calls, doubling ceiling and clamping to remaining output/context. Retry consumes a turn; unusable reasoning isn't appended. Non-length reasoning-only with positive accumulated completion usage returns “Child agent generated tokens but returned no visible answer.” as ordinary output. Without usage/tokens it throws. After escalation another unusable length response may take this same placeholder path. Nonempty truncated content is accepted as final; completion isn't proven by finish reason. |
| File analysis | `executionManager.js:runFileAnalysisExecution,resolveTargetFiles,targetFileBudget` | No tools/continuation; source read upfront; directory expansion, dedup, UTF-8/binary checks, symlink/path safety; up to 32 supplied paths, 8 MiB read and 512 KiB request byte guards, dynamic character truncation. Default file payload calculations use descriptor context (cloud metadata isn't fed into this early calculation). Normally one request, at most two empty-answer attempts, changed retry temperature .2→.5; length case escalates if affordable. Visible answer returns immediately. Empty positive-token final attempt returns placeholder completed output. |
| Web extraction | `executionManager.js:runWebExtractionExecution,relevantPageText`; `tools/webSearch.js:getSingleWebPageContent` | One page fetched once, public-host/DNS/SSRF restrictions and capped output; relevant excerpt max 8000 chars. No search discovery. Up to two empty attempts, temperature 0→.4, 1024 request ceiling, final text max 1800. Empty positive-token answer throws descriptive diagnostics instead of file/investigation placeholder. Fetch, empty page, model HTTP, forbidden tools, and empty completion have separate error text. |
| Lifecycle/result propagation | `subagents/sessionManager.js:completeSession,failSession,cancelSession,interruptSession`; `executionStore.js`; `index.js` | Distinguishes failed/cancelled/interrupted from completed, but no typed stop reason for limits/partial completion. Budget stop returns budgetExhausted=true, then index destructures only output/usage and records completed. Failures retain error and prior context but discard local ledger/usage accumulated before throw. Parent receives tool error through normal parent tool settlement. |
| Parent text cap | `tools/subagent.js:boundResultForParent` | 1800 characters with truncation notice; full bounded child answer remains in-memory. Important evidence can be omitted from parent synthesis even if child succeeded. Legacy facade does not use this same helper. |
| Continuations | `continuationManager.js:registerChild,sendMessage,interrupt,resume,drive`; `index.js` | Only investigation continuable. Single driver owns context; inbox FIFO; original engine/root/fetch/tools limits retained. Ledger/tool/turn counters are created fresh for every execution; budget settings are re-read. “Per-task cumulative” is therefore per execution, not lifetime child task. Completed child can be messaged; failed/cancelled terminal. Restart does not restore jobs/context/inbox. |
| Selection | `modelSelection.js:getSubagentModel,normalizeSubagentModel,resolveChildEngine,buildChatEngine`; IPC/model Settings | null follows parent; explicit local uses running engine; explicit saved cloud validated; selection fixed across continuation. `agentId` is stored but not used to load separate agent instructions in actual execution. Persisted agent name resolves parent agent, not a selected child profile. |
| Scheduling/provider | `inferenceScheduler.js:scheduleInference,createInferenceScheduler`; `providers/localProvider.js:chatCompletion,capability`; cloud equivalents | Each turn occupies its provider/model lane; tools outside scheduler. Local default capacity 1, cloud 4, descriptor can override. Streaming enabled when session progress observer supplied; no stream_options include_usage in child payload. JSON fallback supported by streamCompletion.js. Cloud builds saved-provider transport and ignores local fetchImpl/recoverContext. |

### Existing duplicate/no-progress protections and aggregate limits

The investigation loop has **no semantic duplicate-call detector or tool-result cache**; repeated reads consume the cap. Its “adapt rather than repeat” instruction is advisory. Normalization supplies fallback call IDs but does not enforce global uniqueness like the parent does. Child streaming reader does not install the parent's reasoning/content repetition detectors. A reasoning loop is bounded by request output cap, not by the parent's detector.

The parent does have safeguards: `src/main/engineManager.js:createProjectToolLoopGuard` intercepts the third consecutive same-name and JSON-stringified-argument-hash attempt, resets its three-entry window, and returns a loop warning. It is Workspace-gated; it does not cache results, canonicalize key order, distinguish stale state, or prove progress. `src/lib/memoryChat.mjs:runMemoryChat` skips remaining batch calls after that warning, creates paired error results and adds a system notice. Missing/repeated call IDs are rejected before dispatch. Parent `createToolFailureCircuitBreaker` defaults to five consecutive/ten total failures; successful results reset consecutive streak. `rewindFailedTurnRange` removes only complete paired failed ranges without user messages; raw parent execution records survive. The parent streaming path uses `createRepetitionDetector` for reasoning/content. These are not called by `agentLoop.js`.

No aggregate parent-run ledger for child internal tool calls exists on the inspected paths. Parent `runMemoryChat` has turn/tool-round pause limits (batch finishes before pause), and Casual Chat has five tool executions per allowance with +5 approvals and a final-response-only path on denial. They count parent tools/rounds, not children’s internal calls or tokens. Successful parent writes reset turn/tool-round counters. A capacity-limited scheduler is not a cost ceiling. Preserve these guards when adding aggregate accounting.

## Budget semantics and verified gaps

`subagents/budgetSettings.js` stores app-wide settings separately in `app_settings`, not configManager's fixed setting keys. `normalizeBudgetSettings` accepts auto/custom, input 512–1000000, output 256–500000; null/unset fields inherit Automatic. Switching mode preserves custom numbers. Invalid saved JSON fails loudly; unavailable database falls back to Automatic. `ipcHandlers.js` registers subagent:get-budgets/save-budgets; `src/preload.js` exposes getSubagentBudgets/saveSubagentBudgets; `src/components/SubagentBudgetSettings.jsx` fetches, validates whole numbers and commits mode/on-blur fields; `settings/GeneralSettingsTab.jsx` mounts it beside model selection. `describeAutoPolicy` supplies displayed derived values. There are no Settings tool/turn or aggregate-budget fields today.

Automatic values from `budgets.js`:

| Kind | Request ceiling | Nominal turns/attempts | Cumulative output | Cumulative input |
| --- | --- | --- | --- | --- |
| investigation | 2048 | 8 | 16384 | 4×resolved child context |
| file-analysis | 3072 | 2 | 6144 | 4×resolved child context |
| web-extraction | 1024 | 2 | 2048 | 4×resolved child context |

At saved Qwen context 102400, Automatic input is 409600. Default unknown context 32768 gives 131072. `resolveEngineContextLength` prefers descriptor context, then cached matching cloud provider/model metadata, then labeled fallback. Execution callers retain only the length, losing its source-confidence field. Input accounting counts every re-sent prompt, including tool schemas; context capacity is a separate per-request constraint.

`createLedger/recordTurn/ledgerTotals` record input measured or byte-based estimated, output measured or unknown turns. `canAffordNext` checks estimated prompt plus 256 against remaining input and 256 against remaining output; this unnecessarily includes completion reserve on the input side while insufficiently constraining output dispatch. **Normal `max_tokens` remains the full request ceiling even when custom remaining output is only 256.** Unknown output turns debit no output tokens. Thus the code/UI claim “hard limits never exceeded” is not guaranteed. Exact input measurement can also disagree with estimate, and overflow summary/retry requests aren't charged to this ledger. `escalatedCeiling` clamps an escalation but not subsequent normal requests to remaining budget. File/web return only last attempt usage, dropping earlier retry usage; investigation sums recognized standard usage fields but alias coverage differs and failures lose usage. Token ledgers aren't persisted. These are source-verified gaps, not newly introduced test failures.

## Transcript durability versus active model context

`session.context` is the model-facing investigation conversation, committed after seed, full tool rounds and final answer. It is restored on continuation; database turns_json is never read into inference. One-shot file/web request messages are not committed into session.context.

`persistence.js:persistChildRun` upserts one history row per child at settlement, not per request or per execution. `mapContextTurns` keeps only last 60 messages and up to 3000 characters per content/argument; omits tool-call/result IDs. `summarizeToolsUsed` counts committed calls and activity calls again, so the same execution is double-counted; counts grouped by tool name cannot establish unique calls. `sessionManager.pushActivity` retains only 80 events and truncates text/errors/arguments to 600 characters. `index.js:getChildTranscript` serves live context/activity or `readPersistedTranscript` fallback for inspection. After restart this is a preview, not a replayable transcript. No per-request timing, usage coverage, ledger ceiling or durable compaction events are stored. `total_tokens` requires standard prompt/completion values. `contextArchive` isn't serialized.

Consequences: old stored history cannot reliably recover raw rounds, tool identity pairing, executed partial batches, repeated-call signatures, failed request usage, exact request counts, or recovery summaries. Use existing activity/stream/request telemetry first for future live measurements, but mark unavailable fields honestly. Preserving raw child execution history in Phase 2 will require a separate append-only record, not treating turns_json previews as raw storage.

## Workspace compaction audit and adapter design

### Current primary-session engine

`compressionEngine.js:scheduleIdleCompression` debounces 10 seconds and invokes `checkAndCompressContext`. `compressContext` checks effective compactionEnabled and stored `getContextUsage.totalTokens > .75×contextWindowLimit` unless force=true. This stored estimate sums active message rows, summary and recent memories; it does not represent full request instructions/briefs/checkpoint/tools/output reserve. Candidates are active rows except last ten protected rows; selection targets .65×window and may summarize additional candidates if summary grows. It refuses no saving, oversize task brief, missing/invalid checkpoint, or excessive forced floor. Casual Chat shares rolling summary/archival but skips Workspace checkpoint.

Workspace adds `taskBriefs` and `taskCheckpoints`: applicable branch-aware briefs retain original requirements/attachments; structured checkpoints preserve evidence-backed completed work, decisions, in-progress work, files, commands/tests, blockers/risks/unknowns/next actions. `collectEvidence/evidenceIndex` consume persisted parent execution steps, not raw child OpenAI message pairs. `validateCheckpoint` ties verified claims to evidence, repairs missing brief coverage/untrusted entries, enforces structural/size bounds and checks message existence via DB. Summary/checkpoint generation callbacks are registered in `main.js` and send through the primary local engine/port; they are not generic selected-child-provider callbacks.

Snapshot captures summary, briefs, active leaf and evidence fingerprint. Transaction acquires is_compressing flag; model generation happens outside transaction. Commit verifies summary/brief identity and Workspace evidence; forced recovery also verifies leaf/tail. Atomic archival plus summary/checkpoint persistence protects against concurrent state changes. Locks, busy retries and inFlight map are session-specific. Archived rows remain saved.

`recoverContextOverflow` waits for any current compression, cancels idle timer, forces compression, and propagates refusal. `ipcHandlers.js` supplies tools, output/thinking reserve, prospective measurer, exclusion of in-flight parent assistant rows, and checkpoint callback. `promptBuilder.js:rebuildChatMessages` restores summary/brief/checkpoint/session prompt/active rows. `memoryChat.mjs:runMemoryChat` appends its current fully paired execution tail to rebuilt historical prefix; it does not re-execute completed tools. `contextBudget.js:createContextGuardedFetch` measures before every local model request, uses `/props`, `/apply-template`, `/tokenize` when valid, otherwise labeled approximation; reserves output+margin; one changed-context recovery per request for preflight overflow or confirmed 400 exceed_context_size_error. It remeasures and fails closed if still over. No unconditional four-turn compaction occurs.

Tool boundaries differ by representation: parent tool events live within an assistant row's execution_steps, while active in-flight rounds live in the caller's protected tail. Compression selects whole DB rows, not arbitrary child protocol messages. **Its last-ten-row trimming cannot be applied directly to child messages without a pairing-aware cutoff.** Sanitization additionally rejects unmatched parent call/results.

### Child compaction already present

`subagents/contextRecovery.js:childContextRecovery` is wired from investigation→scheduler→localProvider→localEngineFetch. Preflight-over-budget and confirmed backend overflow invoke it, not a proactive 75–80% child threshold. It preserves leading system messages and last ten messages, finds an earlier cutoff only when pending call-ID set is empty, summarizes selected complete rounds into a 512-token system summary, archives selected rounds in-memory on contextArchive, splices active messages and commits, then returns rebuilt payload for the guarded retry.

It never touches parent DB/session. However, original user task may be summarized away (no permanently pinned task brief); previous leading summary remains in prefix and is filtered out after generation, while `prior:messages.slice(1,start)` assumes one permanent leading system instruction. No evidence-validated checkpoint; no guaranteed net reduction before commit; no durable raw archive; no ledger/scheduler accounting of direct summary fetch; cloud provider doesn't use this callback; file/web have no recovery adapter. A summary that itself exceeds context fails without recursion. The guard's one retry bounds overflow recovery but not arbitrary repeated compactions over child lifetime. Resume keeps selected engine and read-only configuration, but failure state remains terminal on thrown overflow. Current read-only partial-round replay still needs explicit attention before any future side-effect tools are allowed.

### Explicit integration answer

**No: the advanced Workspace engine cannot presently operate on a separate child transcript through its public API without session/DB coupling.** Passing the parent's sessionId would compact/change the parent. A child UUID is not a primary sessions row. The existing simpler child recovery is parent-independent but does not reuse advanced Workspace checkpoints.

Smallest safe extraction: separate compaction planning/validation from primary-session storage and transport, retaining the current primary adapter. Do not create fake parent-linked chat rows just to reuse the entrypoint. Proposed interfaces, planning only:

1. A transcript adapter `snapshot()` returns version, immutable original task/permanent instructions, prior summary/checkpoint, completed protocol rounds, protected recent tail, evidence index and exact selected engine/tools/output reserve. Parent adapter builds this from current DB rows/briefs/steps; child adapter builds it from its own context and append-only evidence. Stable child message/tool event IDs are required; do not pretend preview rows are evidence.
2. Pure `planCompaction(snapshot, requestBudget)` selects eligible complete rounds, preserves original task and unresolved requirements, reduces oversized model-facing results with an explicit notice, and builds prospective request. Never cross pending calls, lose original instructions, or drop result-ID pairing. Reuse reserveTokens, approximateTokens, createPromptMeasurer and checkpoint rendering/evidence concepts; inject message/source lookup into validator rather than hardwiring DB messageExists.
3. Provider/scheduler adapter drafts summary/checkpoint on the same selected child model. Debit summary/retry input/output and request/turn ceilings; suppress recursive compaction of the summary request; enforce bounded summary output and cancellation. Do not reuse main.js's engineConfig transport for independently selected cloud child.
4. `commit(expectedVersion, candidate)` atomically updates only child active context after net-reduction, valid pairing, requirement/evidence and full prospective-fit checks. Archive original completed rounds durably before replacing active context. Concurrent inbox/interrupt changes invalidate version. Child state never uses parent's lock/briefs/memories/checkpoints.
5. Invoke before each request based on full request pressure: instructions+task+history+tools+output reserve+uncertainty. Test .75–.80 threshold with hysteresis; target usable lower pressure, not a fixed interval. Prefer confirmed local tokenizer count; metadata/fallback estimates carry confidence flags. If protected floor cannot fit, explicit context_exhausted with partial findings, no repeated archival attempts.
6. On confirmed overflow, use existing one-recovery guard contract through provider-specific adapter, no completed-tool replay. Commit only safe transcript boundaries. Same child identity/model/instructions/root/permissions/tool schemas resume. Record compaction reason, before/after count/method, summary request usage and recovery count separately.

Reusable as-is: contextBudget measurement/reserve/classification/bounded retry primitives, public pure checkpoint rendering and evidence-index helpers where input shape matches. Reusable after parameterization: checkpoint validator's source existence checks, evidence collection, summary prompt/candidate selection, prospective-fit gates. Coupled and retained in primary adapter: DB locks/transactions/row archival, session settings/memory, task briefs/active branches, checkpoint persistence/staleness, promptBuilder's primary system prompt and main.js local transport. Extraction must preserve current Workspace/casual behavior and atomicity tests.

## Staged implementation proposal — not executed

### Phase 1: reliability and configurable execution budgets

- Extend existing `subagentBudgets` record with nullable `maxToolCalls`, `maxTurns`, `maxAggregateToolCalls`; preserve mode and token fields. Missing fields normalize to null so old saved records remain valid. Automatic uses explicit per-kind policy; Custom overrides only non-null fields. Retain stored custom values when toggling modes. Proposed validation: child calls/turns safe integers 1–100 (matching present internal guard), aggregate 1–10000. Aggregate counts actual child internal tool dispatches across all children/continuations for one parent invocation, not unrelated chats; denied attempts tracked separately. Default numeric aggregate needs benchmark evidence, not an invented measured optimum.
- Initially preserve Automatic investigation 10 calls/8 turns and file/web two-attempt behavior for backward compatibility. Evaluate Custom investigation 50 calls with an explicitly documented turn/token allowance sufficient to exercise it; 50 calls alone cannot defeat eight-turn exhaustion. Do not promote it to default before fixed-task results. Automatic output should derive from resolved investigation turn limit×kind ceiling; input remains independent 4×resolved child context unless evidence justifies a separately reviewed change. File/web limits stay kind-specific rather than acquiring autonomous tool loops.
- Resolve and freeze effective policy at child creation; retain a child-task ledger across continuation executions. Parent-invocation aggregate broker must atomically reserve immediately before actual tool dispatch, including concurrently started background children; define attribution of later parent messages explicitly. Persist effective ceilings/sources, usage coverage and typed reasons. Reuse parent guards, not parent DB context.
- Clamp **every** request max_tokens to remaining output, request ceiling and context capacity after reserve. Measure/reserve input independently; unknown provider output needs conservative dispatch reservations reconciled with reported usage and labeled uncertainty. Include failed requests, retries and summarization accounting; do not count unknown as free. Preserve separate input/output enforcement, not interchangeable pools.
- Replace placeholders with structured partial outcomes: completed, tool_limit, turn_limit, input_budget, output_budget, context_exhausted, no_progress, empty_response, provider_error, cancelled, interrupted. Propagate through index/background/continuation/persistence/parent result, preserving usage on failure. Do not mark empty or budget-stopped outputs as normal success.
- Add bounded reasoning-only continuation only when evidence indicates genuinely incomplete generation; total attempts, turns and usage remain charged. Preserve existing one-shot diagnostics/temperature retry. Warn near thresholds. Stop before dispatch and complete protocol envelopes with explicit skipped results when a batch exceeds allowance.
- Reserve at most one tools-disabled finalization request when token/context resources remain, charging it to an explicit total-request allowance; otherwise return deterministic partial findings/error with history references. Avoid hidden extra unlimited generation. Define whether configured maxTurns includes this request (recommended: yes, reserve its slot ahead of exhaustion).
- Reuse/parameterize semantic repetition safeguards with canonical arguments and progress/outcome checks; intercept unproductive repeats without blanket caching. Never cache/replay side-effect or changing-state results. Current children are read-only; preserve that boundary. Keep parent's failure breaker, reasoning detector, pairing checks and permission controls intact.
- Extend settings normalization/persistence, IPC/preload, existing budget UI/policy display and deterministic budget/runtime tests. Test 9/10/11 calls, multi-call crossing, eighth-turn finalization, tiny budgets below request ceiling, missing/alias usage, failed retries, resumed ledger, aggregate concurrency, distinct stop reasons and side-effect prevention. Fix or quarantine established unrelated failures separately, without hiding them.

### Phase 2: child context compaction

Implement the adapter/extraction described above; pressure check every request, oversized result reduction, provider-aware bounded overflow recovery, immutable task/identity/tool permissions, durable raw versus compacted active transcript separation, evidence validation and atomic safe-boundary commits. Test long investigations across several compactions, follow-up recall of early requirements/findings, missing summary budget, unchanged parent DB, no duplicated completed tools and failed/concurrent commits. Run fixed battery and investigate regressions before proceeding.

### Phase 3: integration and polish

Evaluate guidance that decomposes broad audits into focused child assignments. Surface individual and aggregate usage/coverage/ceilings in existing budget UI; document Automatic policy, Custom overrides, lifecycle and partial-result semantics. Run fixed baseline after each phase; do not proceed through unexplained regressions. No Phase 1–3 work is authorized by this report.

## Executed tests and known pre-existing failures

1. `npm test` failed before suite discovery: package runs `node --test tests/`, Node v22.23.2 reports `Cannot find module '.../tests'`, MODULE_NOT_FOUND; one harness failure, zero useful suite results. No package script was edited.
2. Explicit sandbox `node --test tests/*.test.cjs tests/*.test.mjs`: 128 top-level test entries, 103 pass, 25 fail, duration 11198.606285 ms. Many server tests fail sandbox binding; e.g. isolated child-loop integration reports `listen EPERM: operation not permitted 127.0.0.1`. Counts differ from host run because some child scripts fail before expanding subtests.
3. Same explicit command on host (socket restrictions removed): **637 tests, 8 suites, 605 pass, 32 fail, 0 skipped/cancelled**, duration 16235.348257 ms. Individual failing names/locations are in `subagent-baseline-evidence.json`. These are pre-existing current-dirty-tree failures, not proven failures on clean HEAD.
4. Focused existing tests: `node --test tests/subagentBudgets.test.cjs tests/subagentRuntime.test.cjs tests/subagentTranscript.test.cjs tests/subagentStreaming.test.cjs tests/contextCompaction.test.cjs tests/contextOverflowRecovery.test.cjs tests/compressionLifecycle.test.cjs`: seven file-level entries passed, zero failed, duration 898.895318 ms. Some files internally run additional assertions; do not confuse seven files with assertion count.
5. Isolated sandbox childAgentLoop: 16 subtests, 14 pass, two fail: obsolete stream=false expectation (actual true with current progress observer), and socket EPERM. Host integration still includes obsolete stream expectations. Host suite confirms context-overflow/compaction and budget/stream/transcript tests pass despite broader failures.

Failure categories already present before report: background/child/legacy runner assertions expect stream=false although session observer enables streaming; database/IPC/model-selection tests mock Electron incompletely and hit `legacyDataMigration.js:repairLegacyAttachmentPaths` with `Cannot read properties of undefined (reading 'getPath')` (all 13 model-selection subtests fail setup); changed UI expectations for compaction badge/context panel/message actions; other attachment/background settings/MCP serialization/message stats/reply variants failures; RAG dependency fetch failure. Full names and locations retained in evidence JSON; no failures were fixed here. UI browser scripts (`*.ui.cjs`) and preload integration outside glob were not executed, so UI behavior is inspected, not certified. No live local/cloud inference, model benchmark, or warm-start timing was executed.

## Unresolved blockers and design decisions

Loaded model endpoint/active sampling/parent tool context are still unavailable; all nine fixed runs need an accessible running Qwen backend before empirical success/duration/usage conclusions. Dirty-tree hashes pin this report but subsequent edits require a new versioned baseline. Separate child agent-profile instructions are not wired in the inspected execution path despite agentId metadata; clarify desired profile inheritance before later implementation. Choose aggregate lifetime/Automatic cap and finalization reserve through review and benchmark evidence. Cloud overflow classification/measurement must be provider-specific; current recovery is local-only. Durable raw history/evidence IDs and summarization charging are necessary for safe long-running compaction. Stop after Phase 0; this report proposes changes only.
