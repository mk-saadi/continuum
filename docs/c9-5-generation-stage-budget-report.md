# C9.5 — Generation stage budget audit and targeted repair

2026-10-30, Asia/Dhaka. No real-model inference, model changes, dependency installation, live database writes, TaskFlow modifications, commit, push, stash, reset or clean. Existing user changes were preserved. Database inspection used Python SQLite URI `mode=ro`, without loading the application's database initializer. All test databases are disposable.

## Finding and repair

The diagnostic is a genuine **evidence segmentation preflight limit**, not a rejected claim, timeout or exhausted model output. The run-ending defect is that C9.2 excluded this candidate-generation failure from its guarded optional continuation path. The repair adds only `generation-stage-budget` to that eligibility allowlist. It still requires an independently rebuilt, paired original request, an authoritative runtime tokenizer measurement, unchanged budget identity, source/owner/permission/operation guards, and another measurement immediately before dispatch. Forced compaction continues to fail closed. No budget was increased and no validation or checkpoint ceiling was relaxed.

The original stage-count check is correct. An initial suspicion of an off-by-one defect was disproved by counting the pending batch and final merge, and no change to that check was made. Large evidence can legitimately exceed this limit; the repair does not promise a checkpoint for arbitrarily large inputs.

## Exact source path and ownership

`src/main/workspaceCompactCandidate.js`, `reduceHistoricalInput` (limits at line 327; exhaustion at line 390), contains the sole explicit production throw of `generation-stage-budget`. Activity code allowlists and error propagation can retain the code but do not independently produce this local failure.

Each invocation initializes `limits = { stages: 12, generatedTokens: 32768, intermediateTokens: 4096 }` and a fresh local `segments = []`. There is no decrementing stage counter: `segments.push(current)` consumes one planned intermediate slot. After a batch overflows, `segments.length >= limits.stages - 1` fails. At that point eleven completed planned batches, one pending nonempty batch, and one final merge would require thirteen slots. Eleven intermediate batches plus the final merge fit the twelve-stage allowance. Corrections are bounded independently to two attempts per intermediate/final stage; stage planning does not count correction attempts.

Batch splitting checks both serialized evidence at most 48,000 characters and the complete candidate request: input + configured output + 128 safety tokens must fit the smaller configured/measured capacity. Individual large observations and diagnostics are paged in 8,000-character units; message text can accompany multiple evidence pages. These generation inputs differ from the owning coding request. A coding request below its trigger or usable input ceiling does not imply its separately assembled historical evidence fits twelve generation stages.

Planning of **all** segments occurs before the first intermediate provider call. Consequently this explicit throw has zero candidate generation attempts and zero completed candidate generations. Tokenizer measurement requests may already have occurred; they are not generation requests. Earlier coding requests and completed tools are separate operations.

`diagnostics.stage` originally remained its initializer, `snapshot`, until the generation wrapper ran. It did not mean the database snapshot itself exhausted a budget. The catch assigned `evidenceFailure ??= evidenceStage ?? null`; `evidenceStage` was only set inside the later generation loop. Thus `evidence: null` meant no per-batch generation evidence diagnostic had been assigned, not absent source evidence. New records identify `evidence-planning` explicitly and retain content-free budget counters.

`reservedGenerationTokens` is a separate candidate-owned allowance shared by all intermediate/final attempts, including corrections and failed provider calls. Each dispatch reserves its full `max_tokens`, conservatively bounded by 32,768. Intermediate requests reserve at most 4,096, final requests at most 3,072. Successful estimated output totals and measured/provider output ceilings are separately checked. Eight 4,096-token reservations exhaust the allowance even if actual output is shorter. A ninth reservation is rejected before dispatch. The small shared reservation helper now records before/after balances and rejects without recording a nonexistent reservation; accepted work and enforcement are unchanged. No previous candidate invocation contributes to a new candidate's allowance. C9.2 may reuse a rejected result at an identical boundary, but does not generate again or reuse dispatch authorization.

Inactivity aborts originate in `workspaceGenerationRuntime.js` and report `generation-inactivity-timeout`; cancellation reports its mapped abort code. Provider failure, incomplete/truncated output, request context overflow, intermediate size and token reservation exhaustion have distinct diagnostics. They cannot reach this explicit stage preflight throw. The generation runtime has no overall wall-clock stage deadline; the old `generation-time-budget` activity allowlist entry is not a current emitter.

## Historical evidence

Read-only activity rows 48 and 49 belong to session `468493ba-b5f9-4320-800e-818d7ccd2d1d`. Both are `failed`, with corresponding owning messages `interrupted`. No checkpoint row matches either failed snapshot version. Existing later/prior checkpoints in the session must not be mistaken for activation by these failures.

| Evidence | Gemma 4 (message 4058) | Qwen3.8-27B (message 4060) |
|---|---:|---:|
| Last dispatched prompt tokens, owning message stats | 27,437 | 38,327 |
| Prior owning provider request count | 15 | 4 |
| Projected next request, activity `beforeTokens` | 41,480 | 40,627 |
| Measurement method | approximate-full-request | server-template-tokenizer |
| Compaction trigger | 39,974 | 39,744 |
| Usable owning request input | 44,416 | 44,160 |
| Projected headroom to usable input | 2,936 | 3,533 |
| Candidate generations before stage preflight throw (source-path deduction) | 0 | 0 |

The last dispatched counts describe earlier coding requests. The larger `beforeTokens` describes the next assembled request after completed work, and triggers optional compaction. Neither number is the generation stage allowance or its 32,768-token output reservation limit. The Gemma estimate alone could never authorize exceptional continuation. Even for Qwen, a past measurement does not substitute for C9.2's fresh unchanged-request verification.

Stored activity timestamps are `2026-10-29T21:10:30.315Z` and `2026-10-29T21:17:37.922Z`, ending about 7.94 and 6.56 seconds later. Interpreted as UTC, these are **2026-10-30 03:10:30 and 03:17:37 Asia/Dhaka**. The supplied incident description labels the same clock values Asia/Dhaka on October 29. Both forms are retained as an unresolved provenance discrepancy; the database timestamps were not relabeled or changed.

The activity records did not retain the original failed input, complete candidate diagnostics, exact batch/page membership, candidate tokenizer calls, or explicit `force` flag. The failure location and zero candidate generation requests follow from the audited source path, not an invented historical attempt log. Full original token-by-token batching cannot be reconstructed authoritatively from today's changed session. No private source text was copied into this report or its evidence JSON.

## Why the run stopped

In `workspaceCompaction.js` C9.2's candidate rejection allowlist included malformed/unsupported claims and provider failure but omitted stage budget exhaustion. The code threw immediately before attempting original-request rebuild/fit verification. The owning `memoryChat.mjs` send path calls `compactWorkspace()` with `force=false`; provider context recovery uses `force=true`. IPC propagates unhandled compaction errors into the owning chat failure path, explaining `engine:chat` interruption. Historical pressure was below the recorded usable ceiling and above the trigger, consistent with optional proactive compaction; the exact historical force flag was not persisted.

After repair, optional stage-budget failure uses that existing continuation path and identical-boundary suppression. An oversized rebuilt request reports `prospective-context-overflow`; an estimate-only fallback reports `optional-fallback-measurement-unavailable`; forced failure retains `generation-stage-budget`. All leave the checkpoint inactive and durable history intact. No tool executor, replay, or automatic edit retry is introduced.

## Bounded instrumentation

The fixed-shape `generationBudget` object contains stage/index, budget type, initial/remaining before/after/requested consumption, attempted/completed generation adapter calls, reported generation tokens when available, elapsed stage/candidate time, evidence batch/page counts, last estimated/measured request input and method/capacity/output reservation, exhaustion reason and before/after-provider failure position. Counts refer to application generation adapter calls; a provider transport's explicit schema incompatibility fallback can make more than one HTTP call per adapter call. `actualGenerationTokens` is the sum of available provider usage, null when unavailable, not proof that unreported calls generated zero tokens. Context values retain their measurement method; an approximate measurement is not called authoritative.

Stage count is planned slots, not completed generations. At stage preflight failure: initial 12, remaining before/after 1, requested 2 (pending intermediate plus final), index 11, twelve required intermediate batches discovered. The rejected operation consumes no slot. A later token reservation failure uses its own 32,768-token initial balance. Only the latest operation is stored, so diagnostics do not grow with evidence size.

Activity records now retain this object plus continuation eligibility/reason, including a late pre-dispatch refusal. Existing activity storage/access, retention and session deletion cascade apply; there is no new table, endpoint or artifact store. Only numeric counters and fixed program-generated codes/stages/methods are added. No prompts, source excerpts, tool arguments, paths, drafts or secrets are added. Existing C9.4 confidential rejection handling and broadcast stripping are unchanged.

## Deterministic reproduction and safety coverage

New tests exercise real candidate planning with a scripted tokenizer that permits one message per batch, without inference. Twelve batches reproduce pre-provider `generation-stage-budget` on both old and repaired source. Eleven batches pass stage preflight and demonstrate genuine shared token exhaustion after eight dispatched requests. Two intermediate batches plus final generation succeed, and repeating the invocation starts with a fresh allowance. Provider failure remains distinct. A snapshot-time generation availability rejection confirms untouched initialization.

The before/after continuation reproduction uses the real planner, complete paired owning tail and durable completed reads. Before: optional stage failure throws without rebuilding. After: exact-fit optional continuation returns the original paired tail, preserves byte-identical durable messages, creates no checkpoint, and suppresses redundant generation while remeasuring each dispatch. Overflow, estimated measurement, forced compaction and late permission change refuse continuation and accurately record failure/status. Existing suites cover prior checkpoint preservation, atomic activation, durable tool history, edits/reads without replay, cancellation/deletion, context guards, output/summary limits, and C9.4 claim diagnostics.

Validation results and exact baseline identities are recorded in the companion JSON. Final candidate suite: 60/60. Final safe compaction suite: 59/59. Focused regressions cover semantic compaction, C9 summaries, C9.4, advanced compaction, activity, generation runtime, C7/C8, C9.3, P2 and T1/T1.1. The pre-existing `workspaceBudgetVerification` case `concurrent history change during measurement invalidates without partial persistence` fails unchanged against both source versions. No unrelated expectations were edited.

`npm run build` passes (existing bundle-size advisory). `git diff --check` passes. The environment's `node --test tests/` invocation fails to resolve the directory; expanded `tests/*.test.cjs tests/*.test.mjs` runs and direct per-file TAP runs were used instead. Broad expanded-glob runs: baseline 223 passed/56 failed files; repaired 222 passed/57 failed files (279 total). All 57 affected files were rerun directly on both sources to recover exact case identities. The additional background-command failure passes both direct reruns (17 passed, two skipped). No new failing case identity remains. A disposable-tree LSP packaging assertion was traced to dependency symlink canonicalization; rerunning baseline with `--preserve-symlinks` yields the same three failing LSP identities as repaired source. Broad suite results are not presented as a clean pass; exact comparison is in the JSON.

## Remaining unknowns and short Qwen acceptance

Historical exact evidence partitioning and authoritative replay of the original Gemma context are unavailable. The repair preserves genuine exhaustion and does not make forced overlarge candidates compact successfully. Semantic model quality remains outside deterministic source checks. No inference acceptance was performed.

With the user's chosen Qwen already available, use a disposable profile/project and sanitized completed tool history large enough to hit the stage cap. Confirm `evidence-planning`, zero candidate generations, explicit stage exhaustion and authoritative original-request remeasurement. A fitting optional request must continue once without redoing tools or activating a checkpoint; an over-budget or forced request must stop with preserved history. Check the 4,999-token summary cap on a separate small successful compaction, then stop. Do not replay historical edits or modify the original TaskFlow project.
