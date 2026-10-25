# W3 — safe Workspace compaction and same-run continuation

Date: 2026-10-24 (Asia/Dhaka). Base revision: `3be8c9afc5fa946d5dec8e7ece5bae4b526ece50`. Detailed identities, source hashes and measurements: [evidence](w3-safe-compaction-commit-evidence.json).

## 1. Executive summary

Implemented local Workspace automatic compaction at the owning agent's existing inference boundary, including between completed tool rounds. The path is measure → safe-point capability → validated W2 generation → full prospective request → fit check → SQLite transaction → rebuild/measure → same-run continuation. Casual compression remains on its existing path. Cloud automatic compaction stays disabled. No real-model quality or capacity certification is claimed.

The coding fixture starts below pressure, automatically compacts after its test output, executes seven tools exactly once, and finishes the same run. It reduces the complete request from **35,988 to 23,444 estimated tokens**. All 30 W3 safety tests pass. Restricted regression failure identities match the fresh baseline exactly; enabled results introduce no identities relative to the explicitly reconstructed comparison.

## 2. Previous legacy-compaction defects

The legacy Workspace path could generate and archive using the older checkpoint callback rather than W2 completion/source validation. Its prospective projection omitted the actual live provider transcript and later retrieval additions; approximate over-budget counts could proceed. C3 protected the open assistant row, making its completed rounds irreducible. Recovery rebuilt only the historical prefix. Inactive W2 candidates alone fixed none of those commit/continuation defects.

## 3. Files changed

Production: `src/main/workspaceCompaction.js`, `src/main/workspaceCompactCandidate.js`, `src/main/ipcHandlers.js`, `src/lib/memoryChat.mjs`, `src/main/promptBuilder.js`, `src/main/promptMeasurement.js`, `src/main/taskCheckpoints.js`, `src/main/compressionEngine.js`. Added `tests/workspaceSafeCompaction.test.cjs` and a disposable owning-loop fixture adapter. Existing lifecycle, budget, plan, inspection and permission/provider fixtures were migrated to the new entry point. Test and source hashes are listed in JSON.

The initial tree already modified main.js, cloudProviders.js, compressionEngine.js, ipcHandlers.js and preload.js and supplied untracked W2 source/tests/reports. Those changes were preserved. W3 does not change main.js/cloudProviders.js/preload.js beyond their initial W2 state. No commit, push, stash, reset, clean or restoration of working files occurred.

## 4. Effective 90% trigger

Uses C1's `createPromptMeasurer`/`budgetContract` and `atCompactionPressure`, including effective runtime capacity, output reservation and safety reserve once. Every local Workspace send measures its complete prepared payload; no UI estimate triggers commit. C1's integer trigger is `floor(usableInputTokens * .90)`. Tests cover below, at, above and over-capacity requests.

## 5. Active-run safe-point detection

`runMemoryChat` owns the existing loop. The hook runs after tool execution/results and steering/completion injection, before advertisement and dispatch. IPC flushes the same assistant persistence row without completing it. An opaque WeakMap-backed capability binds the exact controller, run, session, durable row, selected tool IDs and live configuration. W2's general active-owner refusal remains intact.

Pair validation rejects unresolved/duplicate calls. Persisted pending/preparing/running steps, foreign open rows and active child/background streams reject the barrier. No second agent loop was introduced.

## 6. W2 candidate integration

Reuses W2 completion-envelope checks, required arrays, authoritative brief IDs, evidence binding, sensitive-metadata refusal and one corrective retry. The owning path requests `persist:false`: the validated candidate is kept inactive in memory until the single activation transaction. Manual W2 generation still produces inactive rows and still refuses arbitrary active owners.

The source hash covers complete durable history, attachments, briefs, plan, steering, background state, summary and checkpoint identity. Only eligible completed-step evidence and consumed assistant text from the live row enter generation. Previous consumed step IDs are carried forward, preventing evidence erosion across repeated same-run compactions. Original brief text stays independently authoritative.

## 7. Complete prospective request construction

The loop supplies a builder using `rebuildChatMessages` with a read-only checkpoint/archive projection, then the same sanitizer, image placement and request fields as inference. It retains retrieval excerpts already present in the run, the live suffix, all user/system instructions in the consumed interval, current schemas, output/reasoning fields and sampling parameters. The shared prefix includes base/persona/workspace instructions, verbatim briefs, losslessly rendered W2 state, work log and active plan.

A W3 checkpoint replaces the active rolling-summary representation; legacy summary records remain durable and are excluded in both preparation and rebuild. No summary-only estimator is used. Current images remain in the actual request and its conservative image allowance. Mock tokenizer tests exercise the supported counting path; image counts remain estimates.

## 8. Token-budget validation

Both prospective and rebuilt complete payloads must fit `usableInputTokens`; candidate-only size never proves fit. Both exact-method and approximate-method overages refuse commit. Before/prospective/actual budget identities are compared, including capacity and output/safety reservations. Fixed/schema/brief/retained-tail overflow fails explicitly without dropping content. Backend-reported smaller recovery ceilings are passed through to W3's measurer.

## 9. SQLite atomic commit design

A synchronous immediate transaction rechecks source identity, current owner, cancellation, live configuration and barrier. It supersedes the old current checkpoint, inserts the validated W3 checkpoint as current and archives only selected completed stored rows. Every archival UPDATE verifies unarchived state and excludes `in_progress`. Any failure rolls back the entire transition. The live row and all original content, steps, briefs and plans remain durable. Checkpoint JSON records run/source/projection identity; current/superseded status records activation history. Prepared-context caches are invalidated after commit.

## 10. Post-commit verification

Rebuilds through the actual prefix/sanitization path, measures again, checks pairing, source stability, full payload equality and capacity. Equality is strict; volatile content changes cause a refusal rather than being silently ignored. A mismatch stops dispatch. A separate compensating transaction restores archive flags and the previous current checkpoint only if the complete committed source is still unchanged. It never pretends a completed transaction can roll itself back. If concurrent state prevents compensation, dispatch stops and durable history stays available.

## 11. Same-run continuation

The loop replaces only its model-facing projection and updates its prefix boundary. Controller/run/session/workspace identity, selected model, tool permissions, tool-ID set, execution steps, counters, plan and pending work remain owned by the original loop. No tool executor is called by compaction. No user turn or fake tool result is synthesized by the W3 continuation. The next normal inference performs remaining work.

## 12. Protected tool tail

Keeps the two most recent complete tool rounds plus following live events. User/system messages from earlier consumed intervals also remain verbatim. The entire open durable assistant row stays unarchived; only completed round content leaves the in-memory model projection. Pending approvals and unresolved batches cannot pass the barrier. The scripted test verifies pairing on every dispatched request, current image preservation and cumulative evidence over repeated commits.

## 13. Steering and cancellation

Steering/background lifecycles remain with existing stores. New durable instructions, tool writes or brief revisions invalidate W2's snapshot. Owner abort propagates through measurement/generation and is rechecked before commit and dispatch. Configuration identity includes settings/sampling, project instructions, native activation, MCP schemas/mode/server configuration and permission revision. Runtime/model/port/configuration/capacity changes refuse stale fits. Identical concurrent requests share one promise; foreign overlapping attempts fail closed. Failed generation is bounded to W2's single corrective retry; failures stop the request rather than looping.

## 14. H1 deletion compatibility

Snapshot/current checks call the existing deletion availability guard. The owner signal cancels the pipeline, and H1 already cancels W2 generation and waits for run settlement before deleting. No compaction code creates sessions or recreates deleted rows. The disposable deletion injection and existing H1 storage/IPC tests verify no checkpoint or late history recreation.

## 15. U7 authorization compatibility

No command authorization, approval, dispatcher or grant-restoration code was changed. Checkpoint text is explicitly non-authoritative; `pending.authority` requires revalidation. Live permission revision invalidates a candidate. Current schemas come from trusted registries, never the checkpoint. Provider mocks now distinguish counting endpoints from inference so existing sender-binding, injected-command and MCP-revocation assertions still run. Final enabled U7 verification: 14 passed, zero failed/skipped.

## 16. Subagent behavior

Parent compaction does not rewrite child transcripts, approvals or budgets. Created/waiting/running child streams defer compaction while the next request fits; an over-capacity request fails recoverably without forcing the barrier; completed child observations remain source-bound W2 evidence. Tests verify child-owned transcript and permission isolation. Existing separate child compaction is unchanged. Advanced multiple-stream compaction remains future work.

## 17. Legacy automatic-compaction transition

All Workspace calls to the old archive engine return `workspace-safe-boundary-required`. Workspace forced recovery uses W3; it cannot fall back to the legacy archive path. Idle Workspace scheduling therefore refuses activation when there is no faithfully constructible owning request boundary. Casual idle/manual/overflow compression retains its original implementation. The obsolete 40% Workspace target is not a W3 contract.

Seven old checkpoint integration cases were replaced by explicit retirement coverage and new W3 safety cases; lifecycle/plan/inspection tests now call production W3 through a disposable adapter. The former test accepting an approximate over-budget candidate was replaced by mandatory refusal coverage. Counting mocks were corrected rather than weakening authorization assertions. Exact changed test files and final identities are in the evidence.

## 18. Local / Anthropic / OpenRouter support

Local automatic compaction is wired through the existing full-envelope candidate transport. Provider-independent validation and serialization mocks are covered by W2 and adapter regression tests. Anthropic/OpenRouter parent automatic generation remains explicitly disabled: no local transport is pretended to be cloud inference, and no cloud archive fallback is enabled. No paid requests or real cloud-model success are claimed. The complete suite's pre-existing provider/Electron-mock failures remain listed.

## 19. Context-overflow scenarios

Below pressure dispatches normally. At/above pressure attempts safe reduction when completed history exists. Over capacity attempts the same path before dispatch. No eligible history produces `irreducible-context-overflow`; an unfit candidate produces `prospective-context-overflow`; ineffective reduction produces `no-meaningful-reduction`. Disabled compaction cannot bypass the fit guard. Capacity changes, incomplete pairs, missing briefs, pending streams and stale state refuse activation. Large mandatory schemas/instructions and current images cannot be summarized away.

## 20. Token savings

Coding fixture measurements are **estimates over complete requests**, not a real tokenizer benchmark. Components overlap and must not be added as exact totals.

| Metric | Tokens / result |
| --- | ---: |
| Before next inference | 35,988 |
| Effective capacity | 40,000 |
| Output / safety reserve | 1,024 / 128 |
| Usable input | 38,848 |
| C1 90% trigger | 34,963 |
| Generation input / generated-output estimate | 1,604 / 149 |
| Scripted provider output count | 80 (fixture metadata) |
| Compact candidate / protected briefs | 1,179 / 80 |
| Native / MCP schema component estimate | 198 / 0 |
| Protected live-tail component estimate | 18,618 |
| Full prospective / rebuilt request | 23,444 / 23,444 |
| Reduction | 12,544 (34.9%) |
| Corrective retries | 0 |
| Fixture compaction elapsed | 51.76 ms |

The resumed request is permitted above 90% if it fits; zero reducible history prevents another generation on unchanged state. Full counts and dispatch sizes are recorded in JSON. Native/MCP schemas are measured independently of candidate text. The image/MCP test separately supplies activated external schema overhead.

## 21. Deterministic mid-run test results

A disposable project contains a deliberately incorrect bug.js. The scripted existing loop reads/searches, updates a plan, edits the fixture exactly once, verifies the edited contents before returning a long mocked test outcome, crosses the trigger, commits/rebuilds and performs remaining inspection before its final answer. Initial request is below pressure. The single mid-run compaction happens after test output. Seven tools execute with seven unique IDs; edit/test execution occurs once each. Every sent request fits the fixture budget and has paired tools/current schemas. Durable originals, authoritative briefs, current checkpoint, same run and final verified file contents are asserted. This is deterministic mocked-model evidence, not actual inference.

## 22. Failure-injection results

Passing cases cover generation start, truncated completion with bounded retry, source/brief changes, permission/model/schema invalidation, cancellation, deletion, pending tools/approvals, pending child streams, prospective-build/measurement failure, capacity changes, over-budget candidates, transaction start/promotion/archival/pre-commit throws, database-trigger failure, post-commit rebuild failure and semantic mismatch compensation. Existing W2 tests cover invalid schema/JSON/source claims and candidate persistence failures. Restart/lifecycle tests reopen committed disposable databases and verify checkpoint recovery. This does not claim process-kill/power-loss injection or every real provider interruption.

## 23. Casual non-regression

The hook is absent for Casual and is not awaited on its send path. No Casual trigger, summary format, rolling-summary persistence, prompt construction, tools or UI was changed. Existing Casual compaction/overflow/idle cases and memoryChat tests pass; the final supplemental Casual run passes all three file entries. Shared builder/checkpoint branches are gated on W3 Workspace state.

## 24. Focused test results

W3 direct: 30/30 passing. Final focused enabled suite: 466/466 passing, 0 failures, 0 skipped. The focused suite includes W2, briefs/checkpoints, plans/worklog, C1/C3, H1, U7/U6, native/MCP, steering/background, child compaction and provider serialization. Supplemental post-edit safety/recheck identities and outcomes are also in JSON. The full suites include the durable background-record correction. The subsequent narrow refinement that defers pending streams while a request still fits, and the strengthened durable-plan fixture, passed the final 30-case W3 run and five-file safety rerun. The 466-case focused run preceded those refinements. Earlier failing intermediate runs were corrected; only the recorded comparisons support regression claims.

## 25. Full regression comparison

Fresh **before-edit restricted baseline**: 231 file entries, 200 pass, 31 fail. Final restricted run: 232 file entries, 201 pass, 31 fail. **Zero new failures and zero removed failures by exact identity.** The extra file is the W3 suite.

Enabled comparison is explicitly **reconstructed after implementation**, using an isolated archive of the base revision plus the original dirty W2 sources, with W3-only edits reversed in that copy. It is not a fresh before-edit enabled baseline. It shares code dependencies only, never user-data stores. Reconstructed enabled baseline: 1817 entries/assertions, 1796 pass, 20 fail, 1 skipped. Final enabled run: 1840 entries/assertions, 1826 pass, 13 fail, 1 skipped. **Zero new failure identities relative to that comparison.** A copied-tree packaging path assertion and variable background/LSP/subagent failures absent from the final run are not claimed fixed by W3. Full-suite failures are pre-existing; a globally green project suite is not claimed.

## 26. Production build

`npm run build` passed (Vite production build), with the existing large-chunk warning. `git diff --check` passed. No Electron distribution packaging or real-model smoke success is claimed.

## 27. Remaining limitations

No actual loaded-GGUF tokenizer/inference or real cloud inference was exercised. Image allowances remain conservative estimates. Source/structural checks cannot prove natural-language completeness of generated state. Essential candidate evidence may exceed 5K or eventually exhaust generation capacity; the pipeline refuses rather than silently trimming. Large protected current results/fixed overhead cannot always be recovered. Idle Workspace activation and concurrent active parent/child/background-stream reduction are disabled without an adequate request barrier. Existing project regression failures remain. Strict canonical equality can safely refuse time-sensitive rebuilds across a temporal-anchor change.

## 28. W4 readiness

The owning-loop barrier, W2 validation, complete-request projection, transactional activation and same-run continuation are available for further model verification. Future scope can address provider-native parent-cloud generation, richer multiple-stream barriers, long-horizon candidate-input scaling and real-model quality/vision benchmarks. W3 does not implement scheduling, unrelated UI, W5 or W6.
