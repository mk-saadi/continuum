# Auto-compaction audit: main chat and subagents

Audit date: November 8, 2026 (Asia/Dhaka).

Source baseline: `db248f464fe5ac29a431d2458359afb538e6cbad`, plus the existing working tree. Unrelated UI changes were present before this audit and were left untouched.

## Verdict

Local workspace and investigation-child compaction have substantial safety and continuity machinery, and their principal synthetic long-run tests pass. However, auto-compaction is not uniformly operational across the product. Main cloud chat has an incompatible compaction measurement contract and no corresponding transport recovery. Child compaction has an oversized-summary failure path and rejects some useful reductions. There are also budget-efficiency, retrieval, durability and test-maintenance gaps.

This is an end-to-end source and deterministic integration audit. It is not a claim of 100% defect detection or a live-model certification. No production conversation, saved credential, or live model was used. No production implementation was changed. Added artifacts are this report, a reproducible synthetic audit script, and its evidence file.

## Scope and evidence

The trace covered request construction, model/session settings, capacity discovery, token measurement, automatic thresholds, candidate selection, tool pairing, summary generation, checkpoint validation, generation budgets, concurrency/cancellation, database activation, post-commit request rebuilding, dispatch, overflow handling, history inspection, child accounting, continuation and restart recovery.

Primary modules:

- Main entry/transport: `main.js`, `ipcHandlers.js`, `localEngineFetch.js`, `cloudProviders.js`, `src/lib/memoryChat.mjs`.
- Measurement/policy: `contextBudget.js`, `promptMeasurement.js`, `compactionTrigger.js`.
- Workspace: `workspaceCompaction.js`, `workspaceCompactCandidate.js`, `compactionBudgetPlanner.js`, `compactionSummary.js`, `compactionOperationalCheckpoint.js`, `workspaceGenerationRuntime.js`.
- Casual: `compressionEngine.js`, `casualSummary.js`.
- History/state: `promptBuilder.js`, `sessionManager.js`, `taskBriefs.js`, `taskCheckpoints.js`, database schema/lifecycle and activity/inspection consumers.
- Children: `subagents/agentLoop.js`, `contextRecovery.js`, `executionBudget.js`, `budgets.js`, provider adapters, inference scheduler, persistence and continuation/recovery modules.

Ran 47 distinct relevant existing test files across three groups. After rerunning the localhost-dependent restart test outside the restricted sandbox, 41 files passed and six files still contained failures. These are file-level counts, not individual test-case counts. Eight additional audit probes reproduced specific observed behaviors; multiple probes concern the same finding.

Reproduction:

```sh
node scripts/audits/autoCompactionAudit.cjs docs/auto-compaction-audit-2026-11-08.evidence.json
```

The probe script asserts the observed current behavior, including defects. A successful probe run does not mean the product defects are fixed. It uses disposable SQLite storage and synthetic transports and removes its temporary database.

## Confirmed findings, ordered by impact

### F1 — P1: main cloud compaction cannot complete its measurement contract

`promptMeasurement.js:276–292` returns `provider-serialized-full-request-estimate` for cloud requests. Workspace generation requires `server-template-tokenizer` before dispatching candidate requests (`workspaceCompactCandidate.js:726–730`). Its fallback also calls `compactionSummary.verifySummaryBudget`, which accepts only `server-template-tokenizer` (`compactionSummary.js:66–81`). The final continuation gate repeats the exact-tokenizer requirement in `workspaceCompaction.js:164–167`.

Consequently, supplying valid provider context metadata does not make cloud workspace compaction usable. Our production-candidate probe failed with `compaction-summary-tokenizer-unavailable`, with zero model requests. This is a deterministic contract mismatch, not poor model summarization.

The fallback paths do not rescue this situation:

- Optional continuation after a failed candidate requires exact local measurement and `runtime-reported` capacity (`workspaceCompaction.js:266–273`). Cloud estimates cannot qualify.
- Main chat selects `createCloudFetch(target)` without an overflow callback (`ipcHandlers.js:589`). That transport does not execute the request's `contextRecovery` callback. Our synthetic provider overflow produced one request, zero recovery callbacks, then a generic HTTP 400 error.
- Casual chat recovery is explicitly local-only (`ipcHandlers.js:882`), and renderer idle scheduling excludes cloud models (`MemoryPalace.jsx:236`).

User-visible effect: local and cloud chats expose similar compaction settings, but cloud chats cannot obtain equivalent continuity. A cloud workspace can stop at compaction pressure while the original request might still fit. Unknown metadata follows a separate unsupported path; known metadata still encounters this mismatch.

Recommended change: introduce provider-aware measurement/admission contracts. Use provider counting where available, otherwise an explicitly estimated policy with conservative margin and one classified overflow recovery. Do not relabel an estimate as exact. Exercise the actual cloud serializer and transport in acceptance tests.

### F2 — P1: a child's summary request can overflow with no staged reduction

`compactionCore.js:137–139` forces selection of every eligible candidate in one pass. `subagents/contextRecovery.js:219–220` serializes that history into a single auxiliary summary request. `generate()` calls `stopBeforeRequest` before scheduling it (`contextRecovery.js:182–189`).

There is no auxiliary-input partitioning or shrink/retry protocol here. If the selected prefix plus summary instructions and JSON expansion is too large, the budget guard stops the summary. The child cannot reach checkpoint generation even when retaining only the recent tail would fit. Releasing the scheduler lane correctly avoids a deadlock, but does not solve this request-size problem.

The audit's escaping-heavy synthetic history reached exactly this path: the rejected request was the summary, the stop was `context_exhausted`, zero auxiliary inference requests were sent, and the compaction version remained zero. The fake tokenizer is deterministic; this is not a measured production tokenizer result.

Recommended change: measure the complete auxiliary request and partition complete historical rounds into bounded, disjoint stages. Preserve source coverage and account every stage against the same child ledger. Casual summarization already contains staged-input machinery that can inform the design.

### F3 — P2: forced child recovery rejects useful reductions below 10%

`compactionCore.js:148–149` requires a reduction of at least `max(128, ceil(before.tokens × 0.1))` regardless of whether compaction is proactive or forced after provider overflow.

Probe: an 8,000-token request became 7,600 tokens, with a 500-token output reservation in a 10,000-token window. The prospective request fit, but the reduction was rejected as `no-material-reduction` because 400 saved tokens was below the required 800. The child adapter turns a forced no-op into a context stop (`contextRecovery.js:295–297`).

This matters when a provider rejection proves the old estimate was insufficient: a smaller request might succeed, yet the recovery policy declines the only retry because the savings fail an efficiency target.

Recommended change: retain a meaningful-savings threshold for ordinary proactive compaction. For confirmed overflow, permit a verified fitting request with a strictly useful reduction, then allow only one retry. Fit remains an estimate on cloud children, so the retry must remain bounded.

### F4 — P2: rejected child candidates can consume the same generation budget repeatedly

When a candidate does not save enough tokens, `compactTranscript` returns without a commit. The child has no rejected-candidate fingerprint or backoff state. The next above-threshold preparation can run the same summary and checkpoint generations again.

Probe: two identical proactive preparations performed two summaries plus two checkpoint drafts, committed zero versions, and both returned `no-material-reduction`. In production, these are real ledger-charged requests and can consume the reporting allowance or task budget. Workspace compaction already has a rejected-boundary identity cache; the child path lacks an equivalent.

Recommended change: remember the rejected source fingerprint, reason and capacity identity. Retry when source history or capacity changes enough, or when a confirmed overflow requires a fresh forced attempt. Do not cache dispatch authorization.

### F5 — P2: retained child raw evidence is not retrievable by that child

Large child results are excerpted before entering active context. The complete original is preserved in `session.rawContext`; compaction also keeps that archive. However, the 17-name investigation allowlist (`subagents/agentLoop.js:70–86`) has no raw-history retrieval tool. The checkpoint's generic retrieval guidance does not establish a child-scoped tool implementation.

Our probe confirms that `get_recent_chat_history` is unavailable to the child. A child may re-read a current file or refetch a page, but that is a new observation and may differ from the stored result. It cannot recover an omitted historical result through the advertised tools. This is particularly consequential when older checkpoint entries are consolidated to stay within caps.

Recommended change: expose a bounded, read-only child-history retrieval capability scoped to the caller's own raw IDs. Do not expose the parent's session-history tool without strict isolation.

### F6 — P2: the current regression suites do not give a clean compaction verdict

Six existing test files fail. They have different causes and must not be treated as six independent runtime defects:

| File | Observed failure | Assessment |
|---|---|---|
| `contextC3LiveProtection.test.cjs` | Expects `Messages changed`; receives `casual-source-changed` | Earlier fail-closed guard now wins; obsolete error expectation |
| `workspaceBudgetVerification.test.cjs` | Expects the older history-change message; receives `casual-source-changed` | Same error-contract drift |
| `compressionLifecycle.test.cjs` | Two assertions still locate the old checkpoint marker/order | Does not recognize current C9 working-summary representation |
| `workspaceAdvancedCompaction.test.cjs` | Long-run assertion expects 11 requests but observes 16 | Request-count contract needs reconciliation with bounded extra compaction work; not proof of repeated tool execution |
| `subagentCompaction.test.cjs` | Four failures: two local overflow expectations, cloud overflow expectation, and request-count equation | Forced recovery can decline reduction; request counts also include unsuccessful generations, not just committed versions |
| `c6bContextSelection.test.cjs` | Lifecycle-race test expects `concurrent-state-change` but fails earlier with tokenizer unavailable | Fixture fails to reach the intended race; lifecycle coverage is not established by this test |

Recommended change: update assertions only after agreeing on behavior. For counters, count dispatched requests directly, including rejected/corrected candidates. For race tests, supply valid measurement so execution reaches the race. Keep tests of actual tool effects separate from inference-count assertions.

## Additional policy limits and risks

These are not all newly discovered defects. Some are deliberate, tested tradeoffs.

### Child compaction can continue without a durable checkpoint

`contextRecovery.js:164` discards the boolean returned by `persistChildRun`. Compaction first mutates active messages, increments the version and publishes activity, then calls persistence (`261–274`). The probe showed in-memory version 1 with two active messages while SQLite still held version 0 with twelve messages.

`persistChildRun` correctly marks the child not durably resumable on write failure. The existing hardening suite explicitly expects continued in-memory execution under this condition. Therefore this is a durability-policy gap, not evidence that successful persistence is falsely advertised.

Risk: if the process exits before a later successful write, recovery uses the last durable projection and ledger rather than the latest in-memory one. Decide whether continued volatile investigation is acceptable; if it is, expose that condition prominently and retry persistence. If crash-safe progress is required, gate continuation on a successful durable write.

### Casual main chat cannot compact the current run's completed tool prefix

Casual recovery rebuilds only the historical prefix. `memoryChat.mjs:786–813` preserves the complete current-run tail; `compressionEngine.js:403–416` protects the suffix from the first live/excluded row and the last ten messages. Proactive idle work is scheduled after a completed turn by the renderer and refuses in-progress rows.

This safely avoids breaking live protocol, but a long casual tool run can accumulate an irreducible current-run tail. It does not have the workspace path's capability to compact earlier closed tool rounds within that same run. This is an architectural boundary of current support, even with auto-compaction enabled.

### Workspace retained state can outgrow the hard summary cap

`workspaceCompactCandidate.js:331–349` unions prior decisions, completed work, files, commands, tests and findings into the fresh draft. Research has explicit supersession support; most other historical fields have no bounded consolidation rule. `compactionSummary.js` then enforces 4,999 measured tokens for the rendered summary.

Inference from source: sufficiently diverse long-running work can accumulate required retained entries until later drafts cannot pass the summary cap. Asking the model to be concise may not help because deterministic retention reintroduces the old entries. There is no demonstrated universal failure count; the passing scripted workload does not prove this can never happen.

Recommended change: separate a bounded current working state from retrievable historical facts and source coverage. Preserve outstanding requirements and uncertainty explicitly. Test many generations with distinct substantive findings rather than repeatedly returning a small stable fact set.

### Measurement and successful summarization are different guarantees

Local text requests can use `/props`, `/apply-template` and `/tokenize`. Multimodal requests deliberately fall back to estimates. Workspace generation and activation require exact-tokenizer evidence, so image-heavy sessions can hit an explicit unsupported-measurement boundary. Child cloud compaction uses approximate token measurement; it does not become exact because provider model metadata exists.

Source-reference checks protect against nonexistent references and unsupported operation categories. They do not prove that a paraphrase preserves every user requirement or that a quote semantically entails a claim. Live-model fidelity remains unverified by this audit.

## Main chat: complete lifecycle trace

| Stage | Workspace | Casual |
|---|---|---|
| Enablement | Effective session/model compaction setting | Same setting, rechecked before commit |
| Capacity | Runtime local measurement or cloud metadata adapter | Local runtime measurement for production recovery |
| Pressure | 90% of usable input, or projected-growth trigger | Idle gate at 90% of usable input; active recovery at hard overflow |
| Reserve | `max(output allowance, explicit reasoning budget)` plus safety | Same shared budget calculation |
| Safe boundary | Owning request after complete tool batches and persistence flush | Idle session, or rebuildable historical prefix during forced recovery |
| Retention | Latest user, two recent tool rounds, steering/runtime messages, authoritative task context | Last ten stored messages and live/excluded suffix; complete current-run tail |
| Generation | Source-bound JSON state, optional staged evidence batches and one correction per stage | Structured factual-memory JSON, bounded disjoint stages and one invalid-output correction |
| Auxiliary limits | 32,768 reserved output-token pool; bounded stage count; 4,999-token rendered summary cap | Up to sixteen stages; 1,024 output tokens per primary/correction request; schema/serialized-memory bounds |
| Validation | Tool outcomes, file/command/source bindings, required brief IDs, summary size, source revision and owner | Completion metadata, structured memory, exact prospective request fit on forced production path, source/runtime identity |
| Activation | Transaction persists checkpoint and archives covered complete messages | Transaction updates rolling summary and archives selected messages |
| Post-commit | Rebuild, measure, compare against prospective payload; compensate when safely possible; validate dispatch | Reuse prepared request, then transport remeasures it |
| Resume | Same owner/run; retained protocol tail; no replay of tool effects | Same run; historical prefix replaced; current tail retained |
| Overflow | Local guard allows one recovery invocation and one retry | Same local guard; protected content may make recovery impossible |
| Storage | Full original message content/tool evidence retained | Full original message rows retained |

Workspace concurrency controls include owner capability checks, permission revisions, source snapshots, tool-pair validation, pending approval/question barriers and background/child-operation identities. Changes can invalidate a candidate before activation or dispatch. A detached child is represented by identity/reference, not restarted by a parent checkpoint.

Casual state changes cancel archival rather than trying to merge a stale candidate. Stuck compression flags are cleared at restart; ordinary database-lock contention is deferred/retried. These checks passed in the relevant suites even where legacy error-text expectations failed.

## Subagent: complete lifecycle trace

1. Resolve the child's own model, capacity, reasoning policy and lifetime budgets. Session-specific parent overrides are not implicitly inherited.
2. Restore the child's own active context and raw archive, or seed a new child system prompt and delegated task. Reattach raw IDs after restart to avoid duplicated history.
3. Record full tool results separately and project large results to bounded task-focused excerpts.
4. Before ordinary inference, call `context.prepare`. Above roughly 60% approximate pressure, local children attempt exact template measurement. Cloud children remain estimated.
5. Trigger compaction at `(input + reserve) / window >= 0.78` for exact local measurement or `>= 0.75` for estimates. This differs from main chat's 90% usable-input policy.
6. Preserve all user and nonderived system messages plus the last two complete assistant rounds. Validate tool-call/result pairing.
7. Check the protected floor and reserve at least three remaining requests and 512 + 1,024 + 256 output tokens for summary, checkpoint and subsequent reporting/work.
8. Summarize every eligible older round in one request capped at 512 output tokens, then draft a structured checkpoint capped at 1,024. Both requests use the normal child scheduler and lifetime ledger.
9. Validate checkpoint references against raw child evidence, retain/consolidate bounded prior state and rebuild the prospective transcript.
10. Remeasure fit and require at least 10%/128-token reduction. Validate protocol, source fingerprint, owner, engine identity, raw length and version.
11. Replace the active projection, increment version, record the compaction event and persist raw context, active context, checkpoint and accounting together in the child row. Persistence failure currently permits volatile continuation as described above.
12. Recheck remaining budgets, dispatch normal inference and retain cumulative accounting. Compaction never refills the child's lifetime or shared tool allowance.
13. A classified provider overflow is recovered after the scheduler releases its lane; the loop allows one forced compaction/retry for that request. A second overflow stops truthfully. Other failures are not indiscriminately retried.
14. Continuation/restart restores the same child projection, raw archive, checkpoint and serialized budgets. Parent ownership and execution permissions are revalidated, rather than restored as grants from summary text.

The two-call summary/checkpoint pipeline applies to the multi-turn investigation child. The short file-analysis/web-extraction executions have separate bounded request policies; they are not equivalent long-running compaction loops.

## Verified strengths

- Local workspace prospective and committed requests are compared and measured before continuation.
- Source changes, cancellation and changed model/permission state invalidate work rather than silently activating stale state.
- Main workspace archival/activation is transactional; injected failures around commit and rebuild are exercised.
- Full source records survive projection/archival; tool results are not automatically replayed to reconstruct history.
- Parent and child contexts are isolated, including independent compaction versions and budgets.
- Child compaction generations count against the same lifetime request/output ledger. Finite shared tool budgets survive continuation and restart.
- Child cancellation during summary/checkpoint generation leaves the previous active version intact.
- The scripted 220-tool-call, 32K-window child workload passes repeated compaction, suspension, budget renewal and terminal completion checks.
- A child written in a separate OS process was successfully recovered and continued. Its first sandbox run could not bind localhost; the permitted localhost rerun passed.

These statements describe the exercised code paths and synthetic fixtures. They do not establish quality for arbitrary live model output.

## Recommended repair order and acceptance criteria

1. **Cloud main chat:** resolve measurement contracts and wire classified overflow recovery. Acceptance: real transport serializer plus synthetic provider, proactive pressure and overflow both recover without fabricated exact counts or duplicate tool effects.
2. **Child auxiliary input:** implement bounded staged compaction. Acceptance: oversized and escaping-heavy histories, old checkpoints and small windows can be reduced with every generation measured/accounted and no source truncation hidden as complete coverage.
3. **Child recovery/progress policy:** distinguish efficiency targets from emergency recovery and remember unchanged rejected candidates. Acceptance: a smaller fitting recovery gets one retry; repeating identical rejected evidence does not spend two more generations.
4. **Child retrieval and durability:** add isolated raw-evidence paging; decide whether failed persistence blocks continued execution. Acceptance: retrieve only the same child's original result, and restart behavior matches the declared durability policy under injected write failures.
5. **Long-run state bounds:** replace unbounded historical unions with bounded working state and durable references. Acceptance: varied substantive findings over many generations remain recoverable and do not permanently block all future compactions.
6. **Regression suite:** repair stale fixtures/assertions and add the above production-wiring scenarios. Acceptance: all relevant suites pass for the intended reasons, and race tests demonstrably reach their race instead of an earlier measurement guard.

No fixes were applied as part of this audit.
