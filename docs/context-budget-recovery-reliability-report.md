# Context budget and recovery reliability

Date: 2026-10-21. Scope: investigation and minimal corrections to existing context budgeting and recovery. No commits, paid inference, model launches, permission/isolation repairs, MCP subprocess changes, or UI changes. Existing working-tree patches were preserved.

## Outcome and limits

Three production defects were reproduced and corrected: empty usage callbacks created blank interrupted replies after pre-dispatch failure; forced recovery incorrectly counted the replaceable old summary as immutable overhead; and template validation could label a token count exact while parameter schemas were missing. Existing IPC fixtures and presentation assertions also needed corrections. The context architecture was retained.

The restricted full-suite baseline was **167 passing / 36 failing file entries**. Final comparison: **172 passing / 32 failing out of 204**, including the added reliability file. Four original failures resolved; no new failing identities. These are file entries, not individual assertions. Direct execution was used to inspect assertions because this environment's `node --test` parent output suppresses child detail.

This is not certification of every requested production scenario. In particular, main cloud chat does not have the local chat's dispatch guard/recovery callback, and main chat's current-run tail remains protected. Deterministic coverage of child cloud recovery and protected-context termination does not establish unlimited main/cloud task recovery. No live-model, GUI, or packaged application inference was performed.

## Original failures and reproduction

Fresh baseline command, before edits: `node --test tests/*.test.cjs tests/*.test.mjs`. Its 203 entries, 167 passes, 36 failures exactly matched `playwright-mcp-connection-repair-evidence.json`. Full identity lists and measurements are in [the structured evidence](context-budget-recovery-reliability-evidence.json). Logs remain in `/tmp/context-evidence`.

Direct original context IPC results: 2/7 passed, five failed. Original brief-budget results: 4/6 passed, two failed. The guard itself passed 13/13 before changes. Existing compaction, child compaction, long-horizon, steering, and MCP activation fixtures passed before the production corrections.

| Original test identity | Actual original error / behavior | Classification and evidence |
|---|---|---|
| `contextOverflowRecovery`: real main IPC forces compaction below normal threshold, applies archives, rebuilds and succeeds | 8,245 synthetic tokenizer input tokens against 7,086 usable tokens; no fitting recovery | Outdated fixture capacity: the assembled current tools/instructions outgrew its 8K window. A 32K fitting fixture now exercises the same backend rejection and two-request recovery assertions. |
| `contextOverflowRecovery`: mandatory overflow fails without dispatch or accumulation of blank interrupted replies | Two empty assistant rows instead of zero; no inference dispatch | Confirmed production defect: error handler emitted empty statistics without any accepted inference phase, which activated lazy persistence. Corrected at the emitter. |
| `contextOverflowRecovery`: scheduled compression is explicitly run; pending background compaction is awaited before forced work | `false !== true` | Fixture capacity plus cascading profile state. In isolation the original test fails at the post-background forced-result assertion (original line 85); its protected tail/fixed overhead no longer fits 8K. The repaired fixture uses 32K and scales growth to actually cross its background threshold. Cancellation/wait ordering assertions remain. |
| `contextOverflowRecovery`: regeneration recovery excludes the replaced assistant and preserves its original variant | ContextBudgetError after backend overflow | Cascading fixture contamination: the failed mandatory test left its 32K-character system prompt set. Original regeneration fixture passes when executed alone against current runtime. Added `beforeEach` isolation and a fitting recovery capacity. Original variant and exclusion assertions remain. |
| `contextOverflowRecovery`: forced compaction includes expanded older attachment text and preserves its managed file | `false !== true` | Cascading fixture contamination; the original attachment test passes alone. Attachment expansion and managed-file byte equality assertions remain. |
| `workspaceBriefBudget`: workspace normal send retains the brief in the dispatched payload | 9,013 synthetic input tokens versus 7,086 budget | Outdated fitting-send fixture. Its 8K refusal tests remain 8K; only IPC fitting/retry requests use 32K. |
| `workspaceBriefBudget`: casual forced recovery creates no briefs and dispatches no brief section | 8,246 synthetic input tokens versus 7,086 budget | Same outdated 8K fitting-send fixture; brief-absence assertions retained. |
| `compactionBadge` script | Expected native `title`, actual accessible `aria-label` with unchanged explanation | Outdated UI assertion. Assert the actual accessible label; no component change. |
| `contextPanel` script | Expected one-line component with no `modelId`; later expected an exception for missing sessions | Outdated source assertions. Current component is multiline and receives `modelId`; current read-only inspection returns `{found:false}`. Existing executable inspection suite covers missing/deleted sessions. |

Original source was also loaded from Git without replacing working files to isolate scheduled, attachment, and regeneration fixtures. These isolation probes ran after the production corrections and are supplemental evidence, not an untouched-production baseline.

### Related historical failures left scoped

- `localEngineFetch`: 1/3 under restriction; failures are `listen EPERM 127.0.0.1`. With loopback access, **3/3** pass, including actual HTTP count/retry/cancellation.
- `cloudProviders`: 18/19 under restriction; GET-only-fetch shim test cannot listen. With loopback access **19/19** pass. No real provider calls.
- `subagentSession`: 7/8 restricted, **8/8** with loopback. `subagentOutOfProcessRecovery`: 0/1 restricted, **1/1** with loopback. Environment restrictions, not reproduced context defects.
- `childAgentLoop`: 14/16 in both settings. One assertion expects `stream:false` while the observed runtime legitimately streams with a progress observer. The HTTP fixture also attempts to JSON-parse a GET tokenizer probe's empty body. These are outdated expectation / fixture defects. Left unchanged because this investigation does not repair the broader child execution suite.
- `subAgentRunner`: expects `stream:false`, observes true at line 73. Outdated transport expectation, left unchanged.
- `cloudIpc`: fails in database initialization before chat: `legacyDataMigration.repairLegacyAttachmentPaths` captures an Electron mock without `app.getPath`. Confirmed harness initialization defect, left unchanged.
- LSP production suites fail under the historical restricted run; direct loopback-enabled runs pass **35 assertions and 9 assertions**. No LSP changes made here.
- The remaining historical failures are not declared harmless. Their complete identities are recorded; unrelated permission, filesystem, recovery-storage, and MCP process repairs were not undertaken.

## Existing architecture and budget calculations

`sessionManager.getContextUsage` builds an approximate active stored-context total from active, unsummarized messages, the current summary, bounded memory/work-log/plan sections. It is not a complete wire-prompt measurement and is not cumulative inference usage.

`promptBuilder` constructs system/project context, attachments, briefs, checkpoints, memories, plans and retrieval. `memoryChat` refreshes live tool schemas before each eligible request and injects steering before the payload snapshot. Local `localEngineFetch` guards the final assembled request, including complete tool schemas and the live tool/continuation tail.

For local counting, `contextBudget` probes `/props`, renders `/apply-template`, and counts `/tokenize`. Effective capacity is the smaller positive configured limit and reported server slot capacity. System messages are merged identically for measurement and dispatch. The tokenizer cache holds at most 64 entries keyed by endpoint, model/template/context identity and complete payload. Fresh props checks precede cache reuse.

Usable input budget is `effective window - reserveTokens(payload, window)`. Reservation is `max(output allowance, reasoning allowance) + min(128, ceil(window/100))`. Positive explicit `max_tokens` wins; otherwise the planning allowance is `min(1024, floor(window/4))`. Reasoning is inside generated output, not a second added allowance. Default/unlimited generation retains its existing semantics: this is a planning reserve, not a new generation cap.

| Deterministic local capacity | Explicit output | Margin | Usable input | Tested input boundaries |
|---|---:|---:|---:|---|
| 32,768 | 1,024 | 128 | 31,616 | 31,615 and 31,616 accepted; 31,617 refused |
| 50,000 | 1,024 | 128 | 48,848 | 48,847 and 48,848 accepted; 48,849 refused |
| 100,000 | 1,024 | 128 | 98,848 | 98,847 and 98,848 accepted; 98,849 refused |

All counts above are controlled fixture counts. No large real model window was allocated. Unknown templates/images fall back to labeled full-request UTF-8/3 estimation, per-message allowance and image allowance; that estimate is not authoritative provider tokenization.

## Triggers, overhead, and schema changes

Workspace background compaction uses the existing stored-usage trigger above 75%, then projects fixed prompt costs toward existing targets. Forced recovery bypasses that incomplete stored-usage trigger. Child shared-core pressure is `(input + reserve) / limit`, at 75% for approximate measurement or 78% for server tokenizer measurement. New tests cover one token below, exactly at, and one token above those shared-core thresholds. Existing workspace tests preserve its distinct threshold contract.

Tool schemas, system instructions, attachments, retrieval, summary/checkpoint sections, live steering, tool-call arguments/results, and reserved output enter final local dispatch measurement. Dynamic tools are re-read on the next request, during recovery, and on subsequent iterations. Expansion can force a recovery/refusal; removal produces a fresh smaller payload. Native tools are preserved by existing activation tests. No MCP initialization or subprocess code changed.

Previously, template checks validated tool names and descriptions but ignored parameter schemas. A new reproducer supplies an enormous parameter enum while the fake template emits only `read tool schema`: previously an exact count of one token admitted it. Now missing schema keys/string/scalar material invalidates that claim, falls back to the complete request estimate and rejects before inference. Two old exact-count mocks were corrected to render the schemas they purport to count. This presence check remains conservative; transformed templates may fall back even when valid, and text presence is not a formal template-equivalence proof.

## Compaction preservation and transactions

Workspace compaction snapshots branch/brief/evidence state, retains ten recent stored messages and generates a rolling summary. Workspace checkpoints bind verified evidence and verbatim briefs to that summary. The current plan and bounded work-log sections are independently rebuilt. Model calls are outside database transactions; archive, summary, and checkpoint persistence are transactional with snapshot revalidation. Original messages/files remain available for retrieval.

The corrected pre-generation floor excludes the old summary because summarization replaces it. The new summary still passes the existing size/reduction checks, post-generation floor and prospective measurement. The regression starts with a **122,000-character / 30,500 estimated-token** old summary, passes that exact old text to summarization, and replaces it with **56 characters / 14 estimated tokens**. Previously recovery refused without calling the summarizer. This does not guarantee that every oversized summary input itself fits a real summarization request; guarded summarization can still fail safely.

An unchanged replacement summary is tested to remain one stored/prompt summary while newly selected history is archived. A SQLite trigger injects a summary insert failure: archival rolls back, original rows remain equal, the summary stays absent, `is_compressing` clears, and a later recovery succeeds. Existing suites cover summary/provider/checkpoint generation failures, malformed checkpoints, stale snapshots, failed child persistence, and cancellation during summary/checkpoint generation. Child persistence failure truthfully marks durable continuation unavailable while retaining its valid in-memory projection.

Child compaction selects complete assistant/tool rounds, keeps the last two rounds and pinned system/user instructions, retains raw evidence, and validates call/result ordering before commit. In-flight or unmatched pairs are refused. No missing tool result is fabricated. Summary/checkpoint generations share the normal selected model, request/token ledger, deadlines and cancellation.

## Overflow, retries, and continuation

The local guard distinguishes estimated preflight overflow from typed provider rejection. One dispatch gets **one recovery allowance and at most one inference retry**. Preflight recovery consumes the same allowance. Rebuilt payloads are measured again; unchanged payloads are not resent; a second context error terminates. Aborts, unrelated 400s, network failures and provider throttling are not context-retried. `ContextBudgetError` carries `CONTEXT_BUDGET_EXCEEDED` and an explanation of irreducible instructions/tools/attachments/protected turns.

Main IPC recovery cancels scheduled idle work, cancellably awaits in-flight compaction, forces existing compaction, refreshes settings/schemas/attachments/retrieval and rebuilds the prefix. Its live run tail remains intact, so completed tools are not repeated. Regeneration excludes the replaced assistant while retaining its original variant. If that protected tail itself dominates the window, the run fails explicitly rather than silently discarding it.

Children recover after their inference scheduler lane is released, avoiding recursive scheduler acquisition. Summary/checkpoint calls consume existing lifetime budget; recovery does not reset it. A second confirmed overflow returns a truthful context stop. Cancellation and deadlines remain authoritative. Existing child continuation, timeout, recovery, parent/child isolation and sibling adapter tests passed; no execution budgets/deadlines were widened.

The blank-row fix emits failure statistics only if an accepted/partial phase exists. Rejected preflight and no-data transport failures therefore cannot activate persistence via a meaningless stats object. Partial text, tool execution, accepted-phase usage and interrupted streaming still persist. The reply-variant test now requires a no-data failed regeneration to preserve the complete original conversation, rather than expecting the former blank row. No measured usage or cost record is discarded by this change.

## Active usage, cache, and costs

Active prompt occupancy is measured per request. Cumulative ledgers sum processing across requests and compaction generations. Cached tokens remain a subset of gross input and still consume context; cache hits never increase usable capacity. The new schema-growth test reports two million synthetic prompt tokens and 1.9 million cached tokens, then verifies that only the next payload determines admission.

Existing prompt telemetry distinguishes current estimate, last actual prompt, peak prompt and cumulative inference work. Cache read/write/reasoning subsets, provider normalization and costs remain separate. Cache and cost suites passed; no pricing or Usage & Costs dashboard changes were made.

## Local and cloud differences

Local llama.cpp requests have final-wire counting plus bounded transport recovery. Anthropic direct converts system/messages/tool-use/tool-results and cache-control blocks; OpenRouter-compatible requests whitelist portable fields and retain their provider cache behavior. Cloud child adapters use approximate complete-request measurements and selected-model context metadata; actual provider overflow is authoritative and typed known errors trigger one adapter recovery. Provider errors unrelated to context are not retried. Existing cloud provider/caching mocks and new classification fixtures cover Anthropic prompt-too-long, OpenAI/OpenRouter typed errors and llama.cpp overflow.

Main cloud chat currently calls `createCloudFetch` without the local-style context guard/recovery callback (`ipcHandlers` supplies `loadedContextSize` and `recoverContext` only for local chat). It therefore does not satisfy a universal main-cloud bounded-recovery guarantee. This is documented as an unresolved coverage/behavior gap, not claimed fixed by cloud child tests. No provider adapter rewrite or speculative paid retry path was introduced.

## Subagent isolation and steering

Child budgets derive from the effective selected child engine; provider metadata resolves cloud windows when no descriptor window exists. Unknown metadata uses the existing explicitly lower-confidence fallback. Child windows do not silently inherit a different parent's capacity after independent selection. Model-budget, compaction, concurrent adapter, continuation and timeout suites cover independent windows, cancellation and parent result delivery. Existing large-result projection preserves metadata and task/error excerpts while keeping raw history. No permission/child-isolation repairs were made.

Steering remains persisted/claimed for its owning run at eligible request boundaries, confirmed after transport acceptance and marked undelivered after failure. A new actual `runMemoryChat` plus guarded-fetch test injects high-context steering after a tool, forces recovery, retains one steering message plus the valid pair, confirms one delivery and observes one tool execution. Existing tests cover queued order, final-answer continuation caps, persistence and cancelled runs.

## Long-running deterministic workloads and measurements

**Real child loop:** strengthened the existing benchmark from a 131,072-token window and 176 calls to a **32,768-token window and 220 unique tool calls**. It uses the real loop, ledger, compaction/checkpoint machinery, finite suspension at 150 tools and authorized renewal to 250, then continuation of the same child to completion. Original budget consumption never resets. It dispatched **294 model requests**, accumulated **6,468,000 synthetic input tokens**, and completed **36 compactions**. Every dispatched payload fits its approximate input-plus-output budget. Every original tool result remains raw, pairs validate, and no operation repeats.

| Child measurement | Observed approximate input tokens |
|---|---:|
| Before compactions | 22,441–23,260 |
| After compactions | 7,910–8,338 |
| Reserved generated output plus margin at those checkpoints | 2,176 |
| Effective window | 32,768 |

The replacing prose summary remains under 512 characters. Checkpoint overhead increases initially as bounded entries fill, then stabilizes near the schema cap. No savings percentage or quality claim is inferred.

**Workspace shared-core simulation:** a controlled transcript adapter drives the production shared compaction core through **660 mock tools, 220 unique file writes, plan updates, 221 ordinary requests, 144 summary/checkpoint generations, and 72 compactions in a 4,096-token window**. An instruction at turn 75 changes subsequent mock files to blue roofs. Same simulation run ID, completed plan, unchanged operation identities, retrievable earliest `EARLY_VALUE=17`, paired tool results and one steering message survive. First compaction: **2,961 → 1,536** estimated input tokens; last: **3,321 → 1,610**, with **297** reserve. This is a core/adapter simulation, not proof of the complete desktop main-agent path.

Separate real-main-loop high-context steering and SQLite-backed plan/brief/checkpoint suites fill specific integration coverage. They do not turn the synthetic core workload into a live four-hour pagoda benchmark.

## Workspace observation

Read-only inspection found `pagoda test 2` with one session, eight messages, stored message estimates totaling 4,968 tokens, no stored rolling summary and `is_compressing=0`. That stored estimate excludes complete request overhead and any live unsaved run tail. No prompt text was logged, no workspace state was modified, and this snapshot does not reproduce the historical long-running benchmark or diagnose a live overflow.

## Files changed in this task

Production: `src/main/contextBudget.js`, `src/main/compressionEngine.js`, `src/lib/memoryChat.mjs`.

Tests: `contextBudget.test.cjs`, `contextRecoveryReliability.test.cjs` (new), `contextDispatch.test.mjs`, `contextMeasure.test.cjs`, `contextTelemetry.test.cjs`, `contextOverflowRecovery.test.cjs`, `workspaceBriefBudget.test.cjs`, `compactionBadge.test.cjs`, `contextPanel.test.cjs`, `replyVariants.test.cjs`, `subagentLongHorizonCompaction.test.cjs`.

Documentation: this report and `context-budget-recovery-reliability-evidence.json`. Other pre-existing changed/untracked files were left intact.

## Verification and remaining limitations

Focused direct runs cover budget boundaries, schemas, compaction, continuation, task briefs/checkpoints/plans, work logs/retrieval, steering, usage/cache/cost accounting, child recovery/timeouts, dynamic MCP and local/cloud transport fixtures. **42 focused files passed: 510 TAP assertions plus seven explicit script checks.** Final per-file results are in the evidence artifact. Loopback-enabled fixture runs are identified separately from restricted full-suite counts. Electron `ELECTRON_RUN_AS_NODE=1` runs pass the 14 guard and 10 IPC recovery cases, with mocked Electron services; this is not a GUI test.

`npm run build` passed in 13.36 seconds with the existing bundle chunk-size warning. `git diff --check` passed. No new failing file identities appeared in the restricted full-suite comparison. The 32 remaining baseline failures are not fixed or certified harmless by this work.

Remaining limits: main cloud chat recovery gap; irreducible main-run tails; approximate/multimodal token uncertainty; model-dependent summary fidelity; possible conservative schema-template fallback; no exhaustive parent-compacts-while-children-live desktop scenario; no real provider output-limit/transport exercise; no packaged GUI run. Full safety/permission isolation and unrelated roadmap items remain outside scope.

## Manual Continuum verification

1. In `pagoda test 2`, inspect the sole chat's context, task brief, plan and checkpoint state before running anything. Preserve its existing transcript.
2. Use an already loaded local model at its configured window. Perform ordinary file work, add steering at a request boundary, and activate a tool set through existing MCP controls. Observe current versus cumulative prompt telemetry.
3. Allow natural pressure to trigger compaction. Check that the objective, latest instructions, plan and recent tool outcomes survive; retrieve an earlier archived fact. Confirm repeated compactions replace the summary rather than append copies.
4. Exercise cancellation during an observed recovery. Confirm no duplicate completed file write and no new blank interrupted assistant row when rejection occurs before generated data.
5. On a disposable test chat, deliberately select excessive required context and confirm an actionable context error with original history retained and no repeated identical requests.
6. Separately verify main-cloud overflow handling before claiming cloud parity; the limitation above remains. Do not use a paid provider merely to reproduce the deterministic fixtures.
