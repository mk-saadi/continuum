# Phase C3 — live-run protection preparations

Date: 2026-10-22 (Asia/Dhaka).

**C3 is not complete. The explicit C2 dependency gate failed.** This change implements only independently safe message-protection hardening and regression coverage. Completed current-run tool-round compaction is not enabled. No C4 work was started.

## Prerequisite verification

Inspected the October 22 compaction audit and evidence, C1 report and evidence, context-budget-recovery reliability report, permission/subagent isolation report, parent recovery, child transcript adapter, streaming persistence, steering, background notifications, prompt reconstruction, checkpoint validation and relevant tests. No C2 implementation report/evidence was found among repository context documents. Existing implementation is the deciding evidence, rather than document naming alone.

| C2 guarantee | Current implementation | Gate result |
| --- | --- | --- |
| Complete summary/checkpoint response validation | `main.js` callbacks extract content/JSON without validating finish reason or unexpected tool output | Missing |
| Reject truncated or reasoning-only incomplete output | Empty visible checkpoint content is rejected; summary nonempty checking exists; `finish_reason=length` is not rejected by parent transport | Incomplete |
| Preserve requirements and prior decisions | `taskCheckpoints.ARRAY_CAPS.outstandingRequirements=50`; generic trimming can remove requirements; size fitting can clear decisions. Parent `generateCheckpoint` does not pass `retainPrior` | Missing |
| Prospective resumed-request fit | Forced path builds a prospective prefix, but excludes actual current-run tail and later reconstruction additions. Only exact tokenizer overage vetoes measurement | Incomplete |
| Atomic compaction commit | Existing transaction covers archival, summary and checkpoint, with brief/evidence guards | Present, subject to incomplete candidate validation |
| Specific failure classification | Several reasons exist, but checkpoint exceptions collapse to generation failure; validation collapses to checkpoint-invalid | Incomplete |

These are C2 responsibilities. Extending live-run compaction over these gaps would make more execution history depend on unvalidated continuity. This phase does not absorb their redesign.

## Original failures and existing architecture

F04: idle archival of a partial assistant row could hide its final content. C1 already added idle snapshot and commit guards for any persisted `in_progress` row. The historical idle defect does not reproduce against this starting tree; the new end-to-end persistence test verifies that guard independently.

F09: `memoryChat.mjs` preserves `history.slice(prefixLength)` when rebuilding the historical prefix. Tool calls are not executed again by this recovery path, but its growing live tail remains irreducible. F09 remains unresolved under the dependency gate.

Parent streaming uses `engineManager.createMessagePersistence`, one assistant row with execution steps and variant updates, plus a trusted main-process controller/run ID in IPC. Completed raw tool rounds in memory are not independently persisted as parent chat message pairs. The child adapter has its own raw transcript and active projection, complete-round selection, two-round recent floor, provider-pair validation and separate ownership/version checks. Copying that adapter would bypass parent persistence semantics.

The smallest reusable boundary here is the existing compression candidate-prefix selector and atomic archive predicate. No new state registry, runtime, compaction lock or execution source of truth was added.

## Protection boundary and changes

1. Both forced and idle selection stop at the first caller-excluded **or persisted `in_progress`** row. The complete suffix stays active. Forced callers no longer have to remember every open row for this protection to hold.
2. The transactional archival UPDATE independently refuses `in_progress` rows. A status-only transition during asynchronous generation therefore fails the existing row-change check and rolls back all preceding archive updates and summary writes.
3. Existing idle guards still refuse compaction entirely while any active persisted row is open. Quiet streaming and selected-tab state are not treated as completion.

This is a conservative row boundary, not a completed-round selector. It does not claim that every completed-status row has verified complete tool batches. Pending calls, approvals and child results attached to the open assistant row remain protected as that row's suffix; a full trusted pending-operation boundary before row creation remains future C3 work.

Original message contents and execution evidence are retained. The new tests check raw content equality after successful prefix archival. The original shared lock/in-flight promise is reused, including deduplication of concurrent same-session calls and session-independent state. No permissions, commands or tool dispatch behavior changed.

## Deferred completed-round design and continuity

The eventual adapter must verify complete provider-compatible concurrent batches before selecting old rounds, retain a small recent complete-round floor under actual pressure, and compact only the active projection. Raw execution identities/results must remain durably attributable to the same run/message/step. This design is a handoff requirement, not implemented behavior.

Current authoritative briefs, task plans, checkpoints and work logs remain in their existing stores and reconstruction paths. This patch does not alter their content or introduce a competing plan. Evidence fidelity, more than 50 requirements, long instructions, image observations, prior decisions and bounded repeated-compaction continuity require the missing C2 preservation contract before current-run reduction can ship.

No tool dispatcher is invoked by the added code. Existing same-run recovery still rebuilds only the historical prefix and retains its in-memory tail; this patch does not create user messages, change run IDs, replay commands or restart writes. There is no new long-run exactly-once execution result to report.

## Idle, forced recovery and prospective validation

Idle retains its existing active-row refusal. Forced recovery may still compact earlier eligible stored history, but now stops independently at an open row. A live first row returns the existing `protected-context-too-large` classification without generation. No new taxonomy or UI events were introduced.

Existing snapshot/evidence checks, locks and transactions remain. The status predicate adds a final atomic guard, including when content and token estimate are unchanged. Actual resumed-wire fit validation remains incomplete for the parent path; this patch does not claim shorter summaries imply fit. C1's **90% of usable input** trigger is unchanged, and its tests pass.

## Steering, background work, isolation and authorization

IPC owns run identity/controller and the steering-run map. `runSteering` separately persists queued/claimed/delivered/undelivered states; request-boundary claiming and transport delivery acknowledgment remain authoritative. `backgroundCommands` owns stable command IDs and queued/included/delivered completion states scoped to run/session/workspace. Compaction does not rewrite either lifecycle.

The new code neither takes nor acknowledges notifications, cancels children, changes child compaction, retrieves command results nor interprets checkpoint text as authorization. Current permission context, schemas, workspace ownership, pending approvals and subagent limits remain with existing execution code. Their existing focused/full test results are recorded in the evidence. Races between notification arrival and a newly compacted current-run projection were not tested because that projection is not implemented.

## Cancellation, deadlines and irreducible state

Existing signal propagation, finally-based lock release and transaction rollback remain. A status change during generation now rolls back atomically; the focused test verifies no archive flags or summary survive and the lock clears. Comprehensive cancellation during candidate reconstruction/measurement/commit/continuation and renewable-budget behavior for live-round reduction remain deferred. No unlimited retries were introduced.

The existing protected-context failure remains explicit. There is no attempt to drop unresolved work, oversized mandatory instructions or protected output to make a request fit. Detailed measured-category irreducibility diagnostics remain a C2/C3 prerequisite.

## Fresh baseline and verification

Before production edits, ran:

- `node --test tests/*.test.cjs tests/*.test.mjs`: **218 file entries, 187 pass, 31 fail, 0 skipped**, 40,413.516 ms.
- `npm run build`: passed, 16.20 seconds, existing large-chunk warning.

After edits, the identical restricted suite command produced **219 file entries, 188 pass, the same 31 failures, 0 skipped**, 39,720.796 ms. Exact passing/failing identities and the empty new-failure set are in `context-c3-live-run-compaction-evidence.json`. These are file-level results, not inflated counts of individual assertions.

The full restricted run includes environment-sensitive HTTP, Git and LSP fixtures as well as pre-existing fixture/assertion failures. Examples include local transport/listening suites, LSP integration suites, legacy Electron mocks, attachments and message variants. No claim is made that all 31 are environmental. No unrelated failing test was edited. A fresh enabled-environment baseline or enabled full-suite comparison was not performed; this limitation must not be confused with an enabled suite pass.

Focused regression command selected 17 files: C3 protection; C1 budget/integration/UI rendering; parent compaction/overflow/idle projection; child compaction/hardening/long horizon; steering storage/IPC/loop; background commands/IPC; workspace plans; permission policy. **17/17 file entries pass**, 22,309.294 ms. LSP/MCP suites also ran in the full restricted suite; their existing failures remain. Electron interaction `.ui.cjs` fixtures were not executed in this gated preparation.

Production build after changes: passed in 13.32 seconds, same large-chunk warning. This is `vite build`, not an Electron distribution/package build.

## Focused tests and defect reproduction

`tests/contextC3LiveProtection.test.cjs` uses only a fresh OS-temporary application directory and SQLite database, with mocked Electron paths and no inference. It removes its own fixture on completion. No symlinks or live stores are used.

Five individual tests pass:

1. Production assistant persistence writes partial content; idle refuses it; final persistence update remains in rebuilt model history.
2. Forced compaction without exclusions archives exactly 11 earlier records and retains the live row plus its entire later suffix and every original content record.
3. Status-only transition during summary generation causes atomic rollback, no summary, no archival and no stranded lock.
4. A live first row refuses generation as protected context.
5. Concurrent same-session compression shares one operation; another live session remains unchanged.

A supplemental loader compiled the saved **pre-edit working-tree** compression engine in memory with the same new tests, without restoring or overwriting repository files. Tests 2, 3 and 4 failed there; tests 1 and 5 passed. All five pass with the patch (236.831 ms in the recorded direct run). This distinguishes existing C1 protection from actual defects fixed here.

## Simulation, real model and performance limitations

The requested 500-tool/20-compaction deterministic main-agent simulation was **not implemented or run**, because it would require the unsafe live-round reduction explicitly prohibited by the dependency gate. No claim of repeated preservation, bounded checkpoint growth, same-run 500-call completion or exactly-once mutation verification is made.

No real local-model inference smoke test was attempted. Availability of a compatible model was not established for this gated preparation. No paid inference or live session writes occurred. A real resumed-current-run smoke test must follow the missing implementation and safe-commit contract.

Request reduction, completed rounds replaced, protected-tail token size, summary overhead, generation/reconstruction/commit timing, recovered overflows and failure rates are **not measured** for a new live-run compactor. Test/build durations above are actual harness timings, not inference or token-efficiency benchmarks.

## Files changed and remaining handoff

C3-specific changes only:

- `src/main/compressionEngine.js`: open-row selection boundary and atomic status guard (existing uncommitted changes retained).
- `tests/contextC3LiveProtection.test.cjs`: five isolated deterministic protection/race tests.
- This report and `docs/context-c3-live-run-compaction-evidence.json`.

No commits, pushes, stashes, resets, cleans or HEAD restores were performed. All pre-existing working changes remain.

Before completing C3: implement and verify the missing C2 response/preservation/full-resumed-request guarantees; then build the parent-specific complete-round adapter, trusted pending-operation boundary, evidence continuity, current authorization reconstruction and race/cancellation tests. Run the requested long simulation and available real-model smoke test, then a fresh enabled baseline/final suite and relevant Electron fixtures.

C4 handoff: this report is **not** authorization to begin C4. Future timeline events should consume specific bounded attempt outcomes from the completed safe contract, without private conversation contents. Do not present this preparation as successful current-run compaction in UI or release notes.
