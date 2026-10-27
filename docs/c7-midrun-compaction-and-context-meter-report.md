# C7 — Mid-run evidence overflow and live context meter

Date: 2026-10-28, Asia/Dhaka. Implementation and deterministic verification completed; real Qwen/GLM acceptance remains manual. [Evidence and captured final provider request](c7-midrun-compaction-and-context-meter-evidence.json).

## Preservation and baseline

Initial HEAD: `bd379ceacdc3fb6977d5ed825b61adc0bf66d9b0`. Git status contained only the three untracked A1 artifacts; all remain intact. No commit, push, stash, reset, clean, live-database access or mutation, model restart/unload, context-setting change, user-permission change or TaskFlow repository edit was performed. Tests used disposable profiles/projects/databases. Existing coding acceptance tests use their own temporary synthetic TaskFlow project. A temporary comparison tree copies source/tests and replaces changed tracked files with `git show HEAD:path`; it does not alter the working tree.

Reviewed A1, C6-B/C/D/E, W2–W7 and the current candidate, evidence retrieval, activation, checkpoint, brief, prompt, budgeting, measurement, parent-loop, durable execution and worklog paths. Initial focused baseline: candidate, advanced/safe compaction, C6-E and telemetry suite files all passed. Broader baseline identities and later verification are recorded below.

## Failure identity and path

`workspaceCompaction.compactAtBoundary` → `perform` → persisted completed-round/safe-point capture → `generateWorkspaceCompactCandidate` → `evidenceFor(incremental.messages)` → new-evidence hash filtering → `JSON.stringify(newEvidence).length > 48000` → `fail('evidence-budget-exceeded')`. The caller treats this as a noneligible generation failure, throws the reported “Workspace compaction” error and terminates the parent request. It occurs before any model generation or checkpoint activation.

The bound is on the **new deterministic evidence collection**, after prior-coverage/source filtering and unchanged-record exclusion. It is not the raw tool-result byte count or the 74,112-token request capacity. Full tool outputs already become 256-character observations with source IDs, output length/digest and durable retrieval references. A single large raw file read therefore need not overflow it. Operation metadata, exact commands, paths, and command diagnostic arrays can still be large; one command with many diagnostic lines can exceed it. Repeated tool metadata and observations across 175 operations also exceed it even when no single raw result does.

The 175-read reproduction rejects before generation with exactly `evidence-budget-exceeded` on the original generator. All 175 persisted originals remain retrievable and zero checkpoint rows activate. This establishes the reported error's source branch. No live failing conversation was inspected in C7, so its exact offending step IDs, character count and unpublished crash-time state are **not independently established**. The supplied historical error identifies this branch, not a particular private source record.

C6-E already excluded covered archived sources from generation and stripped the prior checkpoint's evidence/integrity catalog. Mid-run safe-point validation still checks durable source integrity; it does not feed the entire prior ledger back as new evidence. The previous stage reducer was unreachable for evidence above 48K, grouped by whole message (a parent round can contain hundreds of steps), and copied raw `input.evidence` into the final merge alongside its summaries.

## Bounded processing and source guarantees

C7 reuses W4's reducer. The former global rejection now triggers source-attributed stages. Batches split between tool steps inside one message, stay at or below 48,000 evidence characters, and must fit the measured complete generation request with its output and safety allowances. Oversized diagnostic lists are presented in 8,000-character pages alongside source metadata and offsets. Every page reaches a stage; none is silently dropped. Unrepresentable exact metadata fails specifically with `evidence-item-budget-exceeded`, budget and original source identity.

Only validated stage states enter the final merge; raw staged evidence is absent from that merge prompt. Distinct validated source-bound stage findings and unresolved notices are retained even if the final draft omits them. The final validator still resolves against the complete original evidence ledger. Stage digests bind supplied segments, and the durable candidate retains all records and original source coverage. Historical output retrieval uses existing `get_recent_chat_history` and never executes the old operation.

Large diagnostic lists in the *model-facing working-state projection* now use an explicitly partial first/tail preview with count and retrieval reference when their serialized diagnostics exceed 4,000 characters. The generator has already processed all diagnostic pages; the complete diagnostic ledger and raw result remain durable. This avoids reinjecting a giant command log into every subsequent request. A synthetic 800-failure result retains all 800 durable diagnostics and its final failure identity while its working state is below 5K. The mixed-operation fixture can still exceed the soft target because many distinct failed operations remain represented. Targets never authorize deletion of essential state.

The existing 12-stage, 32,768 generated/reserved-token budget, per-stage output limits, one correction attempt and final request-fit guard remain. These bounded execution budgets can still reject a genuinely unmanageable task. C7 does not add an unbounded retry or recursive summarization system.

## Atomicity and continuation

Existing W3/W4 ownership, completed-round flush, protected last two rounds, complete protocol pairing, branch/source hashes, cancellation/deletion, permission revision and operation barriers remain authoritative. Intermediate states never activate. Only a completely validated candidate whose prospective full request fits can activate in the existing transaction. Postcommit verification retains the existing rollback behavior. No source history is removed before successful activation.

The new 175-operation owning-boundary fixture stages 173 eligible operations, retains two recent operations verbatim, activates a run-bound checkpoint, verifies dispatch fit and captures the continued serialized request. All 175 originals are retrievable; replay count is zero. The existing full parent-loop fixtures verify continuation in the actual running loop, repeated compactions and cloud paths. The new boundary fixture additionally dispatches the rebuilt payload through `runMemoryChat`; it does not simulate a real model's semantic decision-making.

Generation failures now retain stage/batch/source/budget diagnostics and explicit history-preserved, checkpoint-not-activated and generation-retry status. The owning error includes the safe diagnostic context. Cancellation or source changes require fresh ownership/state validation; “retry” never means replaying completed tools. Existing guarded optional continuation remains restricted to its eligible generation/validation errors, a nonforced boundary, independent exact local measurement, unchanged ownership/capacity and a request that fits. Evidence/metadata budget failures are not newly authorized to bypass pressure or the fit guard.

## Context meter

Before: `MemoryPalace.contextTokens` chose the prepared next-turn projection (plus draft estimate). `Header` used it for both text and progress; completed-request telemetry was separate. The compaction-success callback could also store a resumed live count as a prepared measurement.

After: local final context guarding publishes its normalized measured request just before dispatch, using the same template/tokenizer or honest fallback used for guarding. Cloud adapters publish a labeled estimate of the actual provider-native serialized body, including system/tools; provider-reported completion usage supersedes an estimate when available. The parent forwards run/model/session identity, dispatch sequence, method/confidence, timestamp and local budget contract. These display events do not enter cumulative token accounting.

`MemoryPalace` selects the current run's last request for live occupancy. `Header` uses that same value and capacity for text, percentage and progress. Pending dispatch remains labeled Prepared. After completion/cancellation it clears live occupancy, retains last/peak in details and refreshes the prepared next request. Compaction success refreshes the prepared projection; it no longer stores resumed live-tail input under the prepared field. The next dispatch supplies the lowered live value.

The detailed panel shows prepared, last dispatched and peak separately, with existing output/reasoning reservation, safety, capacity and trigger details. The tooltip retains the same distinction. Cumulative processed input/output/reasoning remains message usage, never context occupancy. Provider usage is labeled provider-reported rather than incorrectly claiming the model tokenizer.

IPC checks the current controller and abort state; the desktop bridge filters request IDs, and the renderer checks the active run. Hook selection checks session/model/deletion and rejects incompatible capacity. Out-of-order request sequences cannot overwrite a newer request. Session/configuration effects clear live state; idle views cannot retain a live bar. Raw tool-count growth is never used.

Screenshot regression: prepared **31,247**, dispatched/peak **66,125**, usable **74,112**, trigger **66,700**. The rendered Header shows **66.1k / 74.1k · Live**, progress **89%**, and a separate **31,247** prepared tooltip. Idle rendering shows **31.2k / 74.1k · Prepared**, progress **42%**. These are injected regression values; no real tokenizer measurement is claimed for this screenshot fixture.

## Identical-fixture measurements

All whole-request token counts below are production UTF-8 serialization estimates, **not actual Qwen/GLM tokenizer counts**. Working-state tokens use characters/4 and are not additive to whole-request estimates. Batch counts exclude final merge; zero means direct generation. Generation input is the final *checkpoint-generation* provider request, not the continued agent request.

| Fixture | Evidence characters | Before | Evidence batches | Attempts | Working-state tokens (estimate) | Final generation input (estimate) | Represented / retrieved / replayed |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- |
| 3 reads | 1,609 | success | direct | 1 | 540 | 2,136 | 3/3/0 |
| 55 reads | 37,646 | success | direct | 1 | 1,265 | 15,050 | 55/55/0 |
| 70 reads | 47,921 | success | direct | 1 | 1,265 | 18,735 | 70/70/0 |
| 71 reads | 48,606 | evidence-budget-exceeded | 2 + merge | 3 | 1,308 | 1,828 | 71/71/0 |
| 175 reads | 120,421 | evidence-budget-exceeded | 3 + merge | 4 | 1,564 | 1,998 | 175/175/0 |
| 175 mixed | 112,161 | evidence-budget-exceeded | 3 + merge | 4 | 7,570 | 2,043 | 175/175/0 |
| 250 reads | 172,421 | evidence-budget-exceeded | 4 + merge | 5 | 1,710 | 2,168 | 250/250/0 |
| 1 reads | 687 | success | direct | 1 | 446 | 1,795 | 1/1/0 |
| 1 800 failure diagnostics | 126,234 | evidence-budget-exceeded | 4 + merge | 5 | 682 | 2,225 | 1/1/0 |

The owning-boundary fixture's continued provider request is **14,600 estimated input tokens**; its checkpoint is **1,104 character-estimated tokens**. Its actual full payload, prospective/actual measurements, source-stage sizes, attempts and duration are in the JSON. Candidate-only fixtures do not activate or dispatch a continued agent request; no such measurement is invented for them. Evidence retains per-fixture wall-clock timing with mocked generation. These are not real inference latency or guaranteed speedup measurements.

## Verification and baseline failures

The evidence lists 51 relevant directly executed suite files, with exact test counts, initial sandbox outcomes and targeted final reruns. It covers W2–W7; C6-A–E; budgets, serialization and measurement; safe/advanced/parent continuation; durable tool history/worklogs; H1; permission revisions/isolation; telemetry aggregation; header and details wiring. The final C7 reliability fixture passes 15/15; rendered Header assertions also pass. Affected display and safety suite reruns pass and are recorded separately. The original A1 175-operation fixture passes: 175/175 originals retrieved, zero missing, zero replay.

New tests cover below/above the former 48K boundary, 175/250 operations, realistic reads/commands, failed edits, failing/passing commands, an oversized raw result, 800 diagnostic lines, bounded stages, source preservation/retrieval, explicit metadata failure, local final normalization/schema/reservations, fallback/cancellation, provider-native OpenAI/Anthropic estimates, live/idle Header rendering, last/peak/stale sequence/chat/model/capacity separation. Existing suites retain cancellation, permission changes, deletion, concurrent source mutation, prior coverage, atomic rollback and genuine over-budget rejection assertions.

Intentional test-contract updates: C6-B's old mandatory evidence-ceiling failure now requires successful bounded stages, all 100 evidence records and unchanged history; W2's mock generator reads source IDs from validated stage states for the merge; the ContextPanel exact wiring assertion additionally requires live/run telemetry props. No safety assertion was removed to obtain a pass.

Remaining preexisting identities:

- `contextC3LiveProtection`: **status-only transition during summary generation rolls back all archival and summary writes** — old `/Messages changed/` expectation versus `casual-source-changed` wording, identical on HEAD.
- `workspaceBudgetVerification`: **concurrent history change during measurement invalidates without partial persistence** — old `/Session history changed during compression/` expectation versus the same newer wording, identical on HEAD.
- `h1DeletionIpc`: **H1 real tool approval pending at deletion is invalidated without command execution** — unresolved promise / `cancelledByParent`, identical on HEAD.
- `c6cAcceptance`: **C6-C real coding operations preserve failing and passing evidence across three atomic same-run compactions** — sandbox execution cannot produce expected command outcomes. Outside the sandbox, both HEAD and patch instead fail line 106's `/C6C_CRITICAL/` expectation in the bounded evidence preview. This does not establish loss of the original stored result.
- `contextPanel.ui`: **no token-savings claims in status** — the assertion scans the entire panel prefix containing token diagnostics, identical on HEAD and patch.

Sandbox-only provider localhost and four write/Git subprocess failures were rerun outside the sandbox in disposable fixtures: provider **20/20** and write-permission **20/20** pass. Electron header context/navigation passes outside the sandbox. C7 rendered Header test passes. Production build passes with the existing >500 kB chunk advisory; `git diff --check` passes.

## Files changed

- `src/components/ContextPanel.jsx`
- `src/components/MemoryPalace.jsx`
- `src/components/RightSidebar.jsx`
- `src/components/main-app/ChatInterface.jsx`
- `src/components/main-app/Header.jsx`
- `src/lib/contextDisplay.mjs`
- `src/lib/memoryChat.mjs`
- `src/main/cloudProviders.js`
- `src/main/contextBudget.js`
- `src/main/ipcHandlers.js`
- `src/main/taskCheckpoints.js`
- `src/main/workspaceCompactCandidate.js`
- `src/main/workspaceCompaction.js`
- `tests/c6bContextSelection.test.cjs`
- `tests/contextPanel.test.cjs`
- `tests/workspaceAdvancedCompaction.test.cjs`
- `tests/workspaceCompactCandidate.test.cjs`
- `tests/c7Reliability.test.cjs`
- `tests/c7Header.test.cjs`
- `docs/c7-midrun-compaction-and-context-meter-report.md`
- `docs/c7-midrun-compaction-and-context-meter-evidence.json`

## Remaining limits and real-model acceptance

Structural/source validation does not prove natural-language semantic completeness or independent verification of model conclusions. Source-backed previews require actual retrieval when missing details matter. Numerous essential failures/constraints can still make a checkpoint exceed the preferred 2–3K / soft 5K target, and the complete protected next request can still exceed capacity. In those cases fail explicitly, keep originals and do not replay tools. No actual model was contacted or tokenizer runtime changed in this work.

For real acceptance, use a **new disposable Workspace project/chat** with the user's already-loaded Qwen or GLM and existing context settings. Do not use the real TaskFlow repository. Run at least 175 mixed read/edit/test rounds with large source files, long command output, an early unique finding, a failed edit, a failing test and a later passing test. Let compaction occur at a completed-round boundary. Record the live run ID/sequence, exact-or-estimated method, output/safety reservations, evidence-stage sizes, full serialized next-request measurement and checkpoint size. Require one atomic activation, unchanged original retrieval hashes, protected pairing and zero duplicate completed tool IDs; verify that the same owning loop continues. Repeat compaction with valid prior coverage.

Verify the running Header against the final dispatch measurement, including a prepared projection much smaller than the active loop, compaction lowering live occupancy, completion returning to Prepared, retained last/peak, cancellation, chat switching, model capacity change and stale events. Repeat with cloud adapters and confirm estimates remain labeled estimates unless provider usage is available. Cancel or revoke permissions during an intermediate generation in a disposable fixture; require no activation and safe originals. Do not force continued dispatch beyond a verified limit or automatically replay consequential commands. Record real-model acceptance separately from deterministic mocks.

C7 stops here. F1 historical search, F2 interrupted-turn recovery, F3 plan lifecycle, scheduling, background execution and subagent redesign are unchanged.
