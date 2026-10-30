# Automatic compaction architecture repair

2026-10-30, Asia/Dhaka. Companion: [machine-readable evidence](automatic-compaction-architecture-repair-evidence.json).

## Result and acceptance scope

Implemented budget preflight, conservative dispatch accounting, derived evidence reduction, complete message-text paging, historical message-prefix and current-run operation-prefix checkpoints, exact deterministic degraded checkpoints, adaptive early triggering and outcome diagnostics. All activation paths retain the existing owning-loop transaction, permission, source-version, cancellation and continuation guards.

Deterministic full, partial, degraded and repeated-checkpoint activation are demonstrated. This is **not** a claim that the whole repository is green, that every failure becomes a checkpoint, or that real Qwen/Gemma acceptance has been performed. Exact unavailable historical prompts, real-provider quality and Electron-rendered outcome labels remain unverified. Further limitations are listed below.

## 1. Preservation and historical findings

The initial working tree already contained extensive tracked and untracked C7–C9.5, P2, T1/T1.1 and editing work. The evidence file records that complete initial status. Those changes were retained. No commit, push, stash, reset, clean, dependency installation, model configuration/lifecycle change, live database access or TaskFlow project modification was performed. Test projects, profiles, repositories and databases were disposable.

The earlier reports establish distinct failures, not a single shared cause. C9.4's unsupported finding/completion incidents have no retained original drafts; this repair does not declare those rejections incorrect. C9.5's fixed 12-stage preflight can reject twelve intermediate batches plus a merge before any generation. Its separate 32,768-token pool can exhaust after eight 4,096-token dispatches even when outputs are short. Corrections and the merge were not guaranteed by the segmentation preflight.

The original candidate and activation files were frozen before production edits. A sanitized structural replay reproduced `generation-stage-budget` with zero generation calls against that source. Separate frozen-source cases reproduced `generation-token-budget` after eight calls, `unsupported-completion-claim` after two calls, and context infeasibility before any call. The same-run 207-operation variant also exposes an old individual evidence/request-fit failure; that different failure is identified separately in the evidence, not relabeled as the historical stage incident.

## 2. Architecture before and after

Before: snapshot → repetition encoding → fixed-size pages/batches → 12-stage preflight → output reservations charged at dispatch → intermediate candidates → final merge → validation → Markdown → continuation measurement → atomic activation.

After: snapshot and verified prior coverage → compact source-derived presentation → complete text/observation pages → packing with primary **and correction** request measurements → variable output caps and worst-case pool preflight → feasible full or older-prefix selection → source validation against originals → final merge with its held allowance → strict Markdown measurement → coverage-aware continuation projection → existing atomic activation. Infeasible planning can select an exact operational fallback with no generation. Cancellation, provider interruption, invalid measurements and unsafe continuation remain explicit non-successes.

Generation and owning-agent requests remain independent. The former excludes tools and the agent catalog; the latter still includes its actual tools, instructions, protected history and output/safety reservations.

## 3. Implementation files

Production changes:

- `src/main/compactionBudgetPlanner.js`: variable output caps, reservation-plan approval, request-fit checks and candidate-local ledger.
- `src/main/compactionOperationalCheckpoint.js`: exact deterministic prefix representation and verified summary.
- `src/main/compactionTrigger.js`: measured headroom/growth decision.
- `src/main/workspaceCompactCandidate.js`: reduction, complete message paging, preflight, prefix selection, original-source validation, fallback and planning diagnostics.
- `src/main/workspaceCompaction.js`: coverage-aware archival/tool-round projection, adaptive trigger, measurement validation and existing activation integration.
- `src/main/workspaceCompactionActivity.js`, `src/lib/compactionActivity.mjs`, `src/components/chat/CompactionActivity.jsx`: bounded outcome/coverage metadata and labels, including truthful wording when coverage progresses while the request grows.

The evidence file lists every test/fixture file changed and hashes the implementation. No T1/T1.1, P2 discovery, native tool execution policy, editing implementation or C9.3 continuation implementation was changed by this repair.

## 4. Authoritative planning and stage accounting

The generation pool remains 32,768 tokens. Each intermediate stage reserves its primary output cap and one correction at the same cap. The final primary and correction allowance are held before any intermediate dispatch. Caps respond to serialized evidence complexity, with a normal 1,536-token floor, 4,096-token ceiling and capacity bound. Final output remains at most 3,072 tokens. Every dispatched generation request must independently fit input + output + 128 safety tokens.

The old 12-stage feasibility rule is removed. A separate 64-stage planning safety ceiling bounds work; reaching it selects a feasible prefix rather than terminating with the old error. Variable caps are summed, not substituted into an unjustified uniform-stage formula. Corrections do not acquire a larger cap merely because feedback enlarged the prompt.

Packing measures both the primary request and a bounded correction envelope. Actual corrections are measured again before dispatch and retain diagnostic feedback separately from the bounded transport feedback. The final merge's input depends on generated intermediate content; its actual complete input is independently measured when available. An oversized merge cannot dispatch and may use a deterministic fallback or report safe non-success. This is not a formal promise that arbitrary maximum semantic outputs always admit a full merge.

## 5. Dispatch ledger and provider usage

The existing activity record now persists one bounded planning summary, including per-batch measurements, reservation/usage counters, coverage, activation outcome and sanitized failure/fallback reason. No private prompts or source contents are included. Each dispatch has a unique candidate-owned reservation identity. Duplicate reservation and settlement are rejected. Known usage is recorded; unknown, failed and truncated responses retain their configured-output charge. The existing pool is treated conservatively as a configured-reservation allowance: **no refunds are enabled**. Consequently no double refund or fabricated usage can make a mandatory plan fit. Adaptive generation extensions using refunds are not implemented.

Planned worst-case reservations, actual dispatched reservations and reported output usage are separate counters. Adapter calls are not claimed to equal all low-level HTTP attempts: existing explicit provider schema compatibility handling remains outside this planner. Rejected provider content never becomes completed checkpoint evidence.

## 6. Evidence reduction and authoritative originals

Original messages, tool results, task briefs, plans, operation histories and previous checkpoints remain durable. Derived representations retain every operation identity, outcome, path, available revision, range, digest and retrieval reference.

Identical observations use content references without equating operation identities or revisions. Overlap references require matching known revision/path and an exact matching byte sequence; unknown revisions never gain path-based equivalence. Explicit identical-run counts compact repetitive text. Command views preserve exact command/outcome/exit metadata, bounded beginning/end output, parsed counts and recognized diagnostic lines even when failures occur in the middle. Full output remains retrievable; arbitrary diagnostic semantics are not inferred from a pattern matcher.

Shared message text is no longer silently truncated at character 4,000. Complete text is repetition-encoded or paged with offsets. Pages of an indivisible historical message cannot be marked fully covered unless all its pages are included. Tests verify a required final clause beyond the old truncation point.

Intermediate citation validation resolves the cited operation against original evidence. A derived page boundary can no longer reject an exact quote actually present in that original operation. Other-step, nonexistent, fabricated and unsupported-completion claims remain rejected. This targeted page-boundary change is independently reproduced by its regression case; it is not a semantic-claim bypass.

## 7. Outcome selection and coverage

Full generation has priority when the complete reservation plan fits. Otherwise bounded selection retains the oldest feasible prefix. For completed historical messages, the prefix respects whole-message boundaries and complete operation pages.

For the owning in-progress assistant message, a partial checkpoint can cover complete execution-step prefixes. Operations split across observation/diagnostic pages cannot be partially covered. Original operation digests and identities remain in the evidence ledger; subsequent attempts compare them to durable records and process uncovered or changed evidence. Complete-message digests remain independent of archival flags.

The live projection removes only the largest covered **paired protocol prefix**. A multi-call round cannot leave the tail until all its calls are represented. Two recent rounds remain protected. Prior consumed identities are retained, no tool executor is called by compaction, and no task-plan status is advanced. The next checkpoint monotonically adds message/operation coverage.

Partial Markdown explicitly identifies the covered message/operation boundary and warns that uncovered later failures or changes may supersede historical findings. Activity metadata reports both covered messages and operations, so current-run progress remains visible even when the completed-message count stays constant.

## 8. Deterministic degraded checkpoint

This fallback generates no semantic claims and requires no model-generation call. It preserves authoritative task text, the durable plan/steering state, prior working state, and exact complete older message text plus execution-step records. Its operational Markdown explicitly states degraded fidelity, known record outcomes, pending-plan authority, coverage and uncertainty. Exact tool records do not imply that an edited feature works or that scoped passing tests prove all tests pass.

A byte ceiling bounds construction work; the authoritative 4,999-token summary gate is still mandatory. Only complete messages actually included in the exact representation advance coverage. Earlier exact sources/task context survive chaining and remain available to later model generation. If no lossless prefix fits, the fallback explicitly reports no safe progress instead of truncating evidence or advancing a cursor.

Tests demonstrate zero-call degraded **activation** through the production owning-loop transaction and cancellation during degraded summary measurement without activation. Large briefs, nested prior exact state, a huge indivisible operation or protected context can still prevent safe fallback.

## 9. Activation, ownership and persistence

The candidate source version, branch/session owner, applicable briefs, permission revision, pending questions/approvals, background/child operations, cancellation and deletion remain guarded by existing snapshot/safe-point checks. Invalid counts and capacities cannot authorize generation or owning continuation.

Only covered complete historical messages can be archived. Uncovered current-run tool rounds remain paired in the continuation. A partial or degraded checkpoint may increase a small sliding request while making genuine durable coverage progress; activation then requires newly covered archived messages or newly removable tool rounds **and** a continuation that fits. A full checkpoint retains the existing meaningful-reduction requirement.

Summary verification, prospective/committed rebuild equality, budget identity, transaction guards, post-commit verification and compensating rollback are retained. An inactive candidate is not presented as an activated checkpoint. No model-granted approval or authorization is restored.

## 10. Adaptive trigger and suppression

Existing 90% pressure remains a compatibility backstop. Earlier measured triggering uses:

`growth = min(ceil(usableInput × 0.15), projected recent growth)`

`recovery = min(3072, ceil(usableInput × 0.12))`

`margin = growth + recovery + 128`

Meaningful new work means at least 24 uncovered operations or uncovered request growth of at least `min(12000, usableInput / 3)`. The early trigger fires when headroom is at most that margin. Projected recent growth is explicitly estimated from recent tail serialization; the current complete request measurement remains separate. Checkpoints store the measured continuation size for subsequent growth comparisons.

Existing identical-rejection suppression remeasures dispatch rather than regenerating at the same unchanged boundary. Already-covered/no-reducible-history checks suppress repeated successful-boundary work. These are bounded policies, not a claim that every workload has an optimal trigger. Tests cover 8,192, 41,984, 55,000 and 131,072-token capacities and explicit automatic parent-loop scenarios.

## 11. Summarizer isolation and measurements

Candidate requests contain the compaction prompt, required structured-output schema, necessary task state and selected source data. They do not inherit native schemas, MCP catalogs, agent commands or the coding conversation prefix. The owning continuation is independently rebuilt and measured with its applicable instruction/tool envelope.

Generation dispatch and complete continuation activation now require valid authoritative request measurement provenance. Continuation capacity must also be runtime-reported or provider-advertised. The prospective request, committed rebuild and pre-dispatch request are checked independently; loss of authoritative measurement blocks continuation and triggers rollback when activation has not been verified. Estimates remain labeled in diagnostics and cannot substitute for these gates. Existing estimate-only cloud adapters therefore have a real deployment limitation: exact degraded fallback may work, otherwise a safe explicit failure/guarded continuation is required. Cloud regression fixtures explicitly supply synthetic authoritative complete-request counts over the production serialization path. They do not certify real provider estimates as authoritative. This does not prove a production cloud tokenizer exists.

All replay counts are from explicitly synthetic tokenizer/usage adapters, not real Qwen tokenization. Summary measurements include the existing system/empty-user template envelope. The hard ceiling remains strictly below 5,000 tokens.

## 12. Deterministic 207-operation replay

The fixture has 174 reads, 19 commands and 14 successful edit-operation records. It describes a 1,057-line synthetic test file, overlapping/repeated pages and two revisions, buried failures, exact operation provenance and a durable pending/in-progress plan. It contains no historical private source. Canonical fixture identity and numeric results are in the evidence file.

Frozen C9.5 planning discovers twelve batches and rejects before generation; the complete number it would have required is unknown because that preflight stopped. New planning measures all candidate batches, selects a fitting prefix, reserves primary/correction/merge costs, validates against originals and activates through the owning guard. The 41K fixture chains a larger partial prefix into full coverage; the 8K fixtures produce partial coverage. Repeated current-run checkpoints advance operation coverage without replay.

The tables and exact measured values are generated below from the final evidence; candidate, generation and owning-request counts must not be conflated. The historical owning fixture uses the existing sliding prompt and forced compaction. Its small synthetic continuation counts do not demonstrate real Qwen pressure or throughput. One useful partial checkpoint increases that request slightly while advancing coverage; the live-tail replay actually reduces its continuation.

<!-- REPLAY_RESULTS_START -->

| Candidate replay at 8K | Frozen C9.5 | Repaired |
| --- | ---: | ---: |
| Durable source characters | 3,637,181 | 3,637,181 |
| Presented evidence characters | 1,570,566 | 233,192 |
| Batches | 12 discovered before rejection | 27 candidates; 8 selected |
| Stages | at least 13 required | 9 approved including merge |
| Worst-case output reservation | not approved | 30,720 |
| Dispatched reservation | 0 (no provider requests) | 15,360 |
| Provider adapter calls | 0 | 9 |
| Reported simulated output tokens | unavailable; zero calls | 1071 |
| Outcome | generation-stage-budget | validated partial candidate |
| Summary tokens | none | 597 |

The current derived ledger is 1,606,383 characters and its presentation is 233,192: 85.48% smaller. Compared with the old presented input, the reduction is 85.15%. Token estimates are 547,307 → 84,009; these are estimates, not real-model counts. The canonical operation fixture is 1,705,646 characters, SHA-256 `2fcc2653eaf3d24bff2dab13defa3be4b7813302fb658a5cc165fd6413f6fb83`.

| Owning-loop replay | Outcomes across two checkpoints | Completed-message coverage | Operation coverage | First continuation, before → after | First worst-case reservation | Calls across both checkpoints |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 8K historical messages | partial → partial | 10 → 20 | 9 → 19 | 214 → 225 | 30,720 | 18 |
| 41,984 historical messages | partial → full | 148 → 208 | 147 → 207 | 214 → 142 | 27,506 | 9 |
| 8K one in-progress message | partial → partial | 1 → 1 | 8 → 18 | 1,668 → 1,621 | 30,720 | 18 |

All three owning scenarios commit and pass the post-commit dispatch guard. The 41K second checkpoint covers all 207 operations. The historical 8K first request grows slightly; only explicit coverage progress plus a fitting continuation authorizes this. Counts refer to the synthetic owning template described above. No real-model performance conclusion follows.

<!-- REPLAY_RESULTS_END -->

## 13. Property and regression evidence

Seeded planner/accounting tests exercise 2,000 parameterizations: seeds 1–500 at each of the four context capacities. They vary stage count, input sizes, output reservations, correction overhead, usage availability and measurement provenance. Approved worst-case reservations fit without refunds; requests fit their windows; ledger balances stay nonnegative; duplicate reservations/settlements fail.

Evidence-reduction seeds 1–100 vary source count, duplicate ratio, revisions, outcomes, diagnostics and untrusted source text while checking identity and original immutability. Operational-prefix seeds 1–50 vary prior coverage, source sizes and protected tails while checking monotonic contiguous coverage, summary bounds and unchanged plan/source state. There are no failing seeds in these runs.

Session ownership, cancellation/deletion, provider errors, claim rejection, permissions, tool pairing, activation races and replay prevention also have explicit deterministic regression cases. This is not an exhaustive randomized proof of every application/provider interleaving or of natural-language entailment.

Final core regressions: 36/39 files pass. The remaining six failing case identities also fail against the frozen pre-change source: four `workspaceWritePhase2` Git/sandbox cases, one `liveSteeringLoop` recovery case and one `workspaceBudgetVerification` concurrent-history measurement case. The final evidence contains exact names. Additional permission/provider/prompt comparisons pass 11/15 files on both sources: two named baseline failures plus two UI runner precondition failures. These groups overlap in one file; they are not 54 distinct files or a whole-repository green result.

Candidate and safe-activation suites pass 60/60 and 62/62. The advanced parent-loop suite passes 26/26. Existing C7–C9.5, P2, T1/T1.1, R2, E1/E2, MCP permissions, plan, steering, checkpoint and generation-runtime cases are included in the core comparison. Activity unit tests pass 26/26.

## 14. Explicit test expectation changes

Fixed-stage/reservation-size assertions now test worst-case pool feasibility and contiguous partial progress. Legacy C9.5 recovery tests inject its retired error at the adapter boundary; the frozen original planner separately proves the historical zero-dispatch emitter.

Synthetic generation and owning-continuation adapters now declare their counting contract explicitly. Three dedicated cases reject tokenizer loss at prospective build, post-commit rebuild and dispatch; rollback and immutable-history assertions remain. Estimate-only owning-request rejection tests still use estimates. A page-boundary quote case now expects original-source resolution while foreign/absent quote guards remain. Tests that require intermediate generation use distinct text, since explicit repetition encoding legitimately makes repeated filler fit directly. Automatic-loop tests permit the measured earlier trigger and require a live operation handle only after that operation exists and while it remains running. Pairing, immutable history, same-run identity and no-replay assertions remain.

## 15. Build, whitespace and UI verification

`npm run build` passes with the existing large-chunk advisory. `git diff --check` passes. No dependencies were installed.

Outcome-label unit tests distinguish full, partial and degraded results. Real Electron rendering remains unverified: Node is not an Electron UI runner, and both the pre-change and repaired Electron/Xvfb attempts were blocked by `sandbox_host_linux` shutdown `Operation not permitted`, using isolated `/tmp` profiles. This environmental block is not presented as a passing UI test or a newly proven rendering regression.

## 16. Milestone gates

1. **Planner/fallback:** frozen-source stage/pool/validation/context reproductions, worst-case reservation tests, zero-generation operational activation, summary/continuation guards and cancellation tests pass within the stated deterministic scope.
2. **Evidence/partial chaining:** measured derived-input reduction, original-source quote checks, complete message paging, unchanged originals, historical prefix chaining and same-run execution-prefix chaining pass.
3. **Trigger/isolation/acceptance:** adaptive-trigger tests, automatic parent-loop regressions, isolated request construction, outcome labels, baseline comparisons, production build and whitespace checks pass within the stated environment limits.

No additional prompt was required between milestones.

## 17. Remaining limitations

- Original rejected drafts and exact historical generation inputs are unavailable. Structural replay proves mechanisms, not exact incident content.
- Real model quality, latency and tokenizer behavior remain untested. Some providers offer estimates only.
- Generated merge/correction content is data-dependent. Runtime fit refusal and fallback remain necessary; arbitrary maximum semantic outputs are not guaranteed a full checkpoint.
- Completed historical messages still compact at whole-message boundaries. Current-run operation prefixes can advance within the owning message, but a protocol round is indivisible for tail removal.
- An exact degraded checkpoint may be unable to fit a large brief, prior exact state or indivisible source. It must not advance over omitted facts.
- Diagnostic extraction is structural and pattern-based. Original command output remains necessary for details outside the recognized diagnostics and boundary segments.
- Natural-language completeness, semantic duplicate findings and arbitrary claim entailment are not deterministically proven.
- The seed suites do not exhaustively explore all eighteen requested properties under every provider/state interleaving. Targeted deterministic safety tests supplement them; universal proof is not claimed.
- Existing baseline failures and blocked renderer acceptance remain. No claim of a completely green repository is made.

## 18. Manual real-Qwen acceptance procedure

Use an already configured Qwen in a disposable profile/project; do not change model/context/GPU settings or touch TaskFlow. Run harmless reads, paginated synthetic source inspections, scoped passing/failing tests and disposable edits with durable plan steps. Accumulate approximately 207 operations, including many in a single owning assistant run, allowing ordinary automatic compaction.

Inspect each activity's outcome, planned caps/corrections/merge reservations, tokenizer provenance and real continuation measurement. Confirm full coverage where feasible, contiguous partial source/operation boundaries otherwise, protected recent pairing and monotonic subsequent coverage. Check that every working summary is below 5,000 tokens and a scoped pass never becomes a blanket success. Verify completed tool IDs/edits are not executed again.

In separate disposable cases, cancel during candidate/fallback measurement and invalidate permissions/ownership before commit. Confirm no activation or dispatch occurs. Exercise estimate-only/unavailable counting and an irreducible protected tail; require explicit non-success rather than an unsafe fit claim. Inspect C9.4 rejected-field and C9.5 budget diagnostics without exporting private prompts/results. Collect real measurements separately; none were generated in this task.

## 19. Final acceptance statement

Demonstrated: full/partial/degraded selection and activation in deterministic fixtures; reservation feasibility without refunds; original evidence retention; complete text paging; source-bound validation; historical and current-run prefix progression; protected pairing; no tool replay or plan completion; bounded fallback; explicit failure categories; adaptive early triggering; reduced evidence presentation; isolated summarizer requests; production build and whitespace checks; no additional failing identity in the compared core regression set.

Unverified or limited: exact historical replay, real-Qwen/Gemma and production cloud tokenizer/quality acceptance, actual Electron rendering of the new labels, exhaustive randomized coverage of all application interleavings, universal semantic completeness, and the unrelated existing repository failures. These limits prevent an unconditional claim that every final acceptance criterion has been proven in production.
