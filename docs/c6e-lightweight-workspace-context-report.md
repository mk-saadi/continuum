# C6-E — Lightweight Workspace Context

Date: 2026-10-27. Implemented in the existing working tree without commits, resets, live-database changes, or model unloads. Deterministic verification is complete with the baseline failures below; real-model validation remains outstanding.

## Root cause and request path

`session:prepare-messages` in `ipcHandlers.js` delegates to `promptBuilder.prepareChatMessages`. Both normal preparation and recovery/rebuild use `taskBriefs.buildTaskBriefSection`. C6-B selected every unknown brief and reselected all briefs when the latest request matched its backward-reference expression (including “continue”). It then indexed every on-branch assistant response, with an observation and tool-step identities. An index longer than 24,000 characters threw `ContextBudgetError` before actual provider-request budgeting. Thus a 40.4% request could be rejected for a dependency-navigation bound rather than model exhaustion.

Before changing production code, disposable 100-assistant-message fixtures reproduced the exact exception with an explicit older-feature reference; the self-contained request passed. The original module is retained as a test fixture. Final requests are captured from `runMemoryChat`'s serialized fetch body, not just intermediate arrays. A mocked runtime/tokenizer reproduction at 90,112 capacity and 35,972 input dispatches; 90,000 input is rejected without dispatch. The reported 88,960 usable input is reproduced by the reservation contract. No exact real tokenizer measurement is claimed.

## Selection and working state

Unknown is still unknown; C6-E does not write guessed completion or supersession facts. Before valid coverage, unknown requirements remain protected. After a validated W3 checkpoint covers an archived source, ordinary historical briefs are represented by working state rather than continually copied into the prompt. Coverage is checked against active-branch ownership, message content/step hashes, and immutable brief/attachment identities. Invalid coverage falls back to conservative selection. Projection uses the same policy before atomic activation, so preflight and the committed request agree.

The latest task, user-marked active/persistent briefs, explicit dependency sources, and applicable constraint clauses remain available. Deterministic extraction retains restriction/standing-language sentences and requirement/constraint/policy sections independently of model output; no LLM tool can revoke explicit lifecycle-persistent constraints. Quoted/fenced requirement contexts are preserved intact rather than promoting isolated clauses. Attachment-bearing unknown briefs stay intact because metadata does not prove their requirements are summarized. Explicit supersession still uses on-branch user facts. Historical actions do not confer permission for new Git or other consequential operations.

Checkpoint generation now explicitly requests current requirements and persistent constraints because originals will be retrieved rather than permanently injected. The model-facing projection contains objective, outstanding requirements, decisions, inspected/modified files, verified completed work, commands/tests, unresolved findings, blockers, risks, research, next actions, plan and pending state. It preserves referenced evidence, recent eight evidence records, and failed/blocked/cancelled diagnostics. Complete evidence, operation IDs, source hashes, source coverage, brief-index metadata, activation/projection identities, and reduction provenance remain durable. Source-specific retrieval instructions accompany the state.

Checkpoint size diagnostics measure working state separately from the durable integrity record. Small synthetic comparison checkpoints are about 324 character-estimated tokens; they do not need padding to 2–3K. An essential requirement fixture exceeding 5K remains intact and emits a size reason. There is no retry solely to shrink an otherwise valid checkpoint. Many real persistent constraints, attachments, accumulated essential commands/tests or unresolved failures can legitimately exceed the soft target.

## Dependencies and retrieval

Self-contained requests add no historical assistant source index. Backward references receive at most eight recent assistant candidates, with source IDs and 256-character observations. Explicit `source_message_id=...` references resolve on branch or raise `HISTORICAL_DEPENDENCY_UNAVAILABLE`, not `ContextBudgetError`. Candidates are navigation data, not authority or a guessed resolution. The prompt instructs the agent to retrieve the referenced plan before implementing and ask when ambiguous.

`get_recent_chat_history` retains original `source_message_id`, `source_step_id`, and `source_brief_id` retrieval, with the existing 8,000-character maximum and character pagination. New `source_history=true` lists eight current-branch candidates per page and accepts a bounded query. It exposes up to sixteen tool-step IDs per candidate; full original results remain in storage. This is how an older reference outside the recent candidate window is located. No lookup reruns a tool. The READ capability, authorized session argument, H1 availability checks, and active-branch filtering still apply. Direct cross-session source IDs and off-branch sources are rejected. Existing cross-chat recall behavior is not redesigned.

## Incremental generation and safety

First generation uses eligible source history. Subsequent generation validates prior source bindings, reuses the validated checkpoint, parses newly eligible tool evidence, and merges its durable records by message/step identity. Accumulated archived tool results no longer repeatedly enter parsing/generation or the per-generation evidence ceiling. An eleven-compaction fixture retains 132 distinct evidence records (over 90KB) while sending twelve new records per round; earliest output remains retrievable. Source validation still hashes covered ancestors deliberately: eliminating full-history generation does not eliminate integrity checks.

W2 source/evidence validation, W3 safe boundaries and transactional activation/rollback, W4 stages, W5 activity, W6 progress policy, W7 output reservations, C6-A correction, C6-D reasoning, active-run cancellation, permission revisions and H1 deletion guards remain in place. Recent ordinary tool rounds are unchanged below pressure. The final serialized provider request still goes through context guarding; optional navigation overflow is no longer mislabeled as context exhaustion. Durable original messages, briefs and checkpoints are never deleted by this change.

## Serialized request comparison

Exact bytes and approximate whole-request tokens, using identical 5/20/50/100-brief disposable fixtures. Before substitutes pre-C6-E brief selection and checkpoint projection; after uses production policy. Each fixture generates a real validated candidate with a deterministic model response and retains an early finding, TypeScript/ES2022 constraints, publication restriction and current task.

| Old briefs | Before bytes | After bytes | Before input estimate | After input estimate | Historical brief component estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5 | 16,589 | 12,925 | 5,594 | 4,373 | 845 → 0 |
| 20 | 28,169 | 12,927 | 9,454 | 4,373 | 3,388 → 0 |
| 50 | 51,299 | 12,927 | 17,164 | 4,373 | 8,473 → 0 |
| 100 | 90,199 | 12,929 | 30,131 | 4,374 | 16,991 → 0 |

These self-contained comparisons inject zero historical assistant source items, make zero model-initiated source retrievals, perform one checkpoint generation stage and execute no tools. One direct stored-source verification is performed per fixture. Protected recent-round cost is zero here because no tool rounds are present; separate C6-B twenty-round fixtures capture their actual provider payloads and verify early findings/failures, later success, and twenty unique executions. Historical index, checkpoint, tool schema, current task/constraints and brief component costs are in the JSON, along with full serialized request bodies. Component estimates use characters/4; whole requests use the application's conservative UTF-8 bytes/3 plus per-message overhead. Components are not additive exact tokenizer measurements.

## Regression coverage

The requested forty cases are covered by focused fixtures plus existing suites, with the following limits explicitly recorded:

| Requested cases | Evidence |
| --- | --- |
| 1–5, 11–14, 19, 23–24, 30–31 | C6-E 5/20/50/100 unknown covered brief captures, self-contained/backward overflow fixtures, missing explicit source, mocked 40.4% dispatch, persistent constraints and invalid coverage |
| 6–10, 32 | C6-B lifecycle, supersession, reopening, mixed constraints, dependency cycles and archived feature references; C6-E bounded ambiguous candidates/query navigation. C6-B's obsolete “reactivate all completed briefs on ambiguity” assertion was replaced with the new policy. |
| 15 | C6-E guarded overflow sends zero requests; contextBudget and contextOverflowRecovery suites |
| 16–18, 21–22 | C6-E first generation and eleven delta generations; C6-B eleven checkpoints; W4 three-successive-compaction fixtures |
| 20 | C6-E essential state above 5K remains untruncated with a reported reason |
| 25–29 | C6-B early file finding, failing diagnostic, later successful evidence, paginated retrieval and twenty unique tool executions; W2 source-bound completion validation |
| 33–40 | H1 history deletion, W2 candidate mutation/cancellation/permission/source validation, W3 atomic rollback/same-run continuation, W4 staged output and W6/W7 generation/output controls; permission isolation suites |

Final results: 30 selected suites/scripts executed; 26 exit successfully. C6-E: 13/13. W2 candidate: 55/55. C6-A structured output: 17/17. C6-B: 16/16. C6-D: 7/7. Existing W3 safe compaction, W4 advanced compaction, W5 activity, W6 generation runtime, context guards, evidence retrieval, memoryChat and permission isolation suites pass. Build and `git diff --check` pass. The build reports the existing large-chunk advisory. This is not a claim that all repository tests pass.

Four nonpassing identities match the controlled pre-C6-E policy baseline:

- `C6-C real coding operations preserve failing and passing evidence across three atomic same-run compactions`: expected command test exit records `[1, 0]`, observed `[]`. This fixture does not establish real-model success.
- `concurrent history change during measurement invalidates without partial persistence`: actual Casual recovery rejection wording differs from the asserted legacy wording.
- `H1 real tool approval pending at deletion is invalidated without command execution`: pending promise cancelled when the event loop resolves (one cancelled test).
- `status-only transition during summary generation rolls back all archival and summary writes`: same Casual recovery rejection wording mismatch.

An initial exploratory run during implementation showed additional failures; completed stable-source reruns removed those. The JSON includes final suite identities and controlled baseline identities; no new proven failure identity remains. Baseline reconstruction replaces the original task-brief policy and checkpoint rendering without altering the working tree, and is distinguished from an untouched full-repository baseline.

## Files and reproduction

Production changes: `taskBriefs.js`, `taskCheckpoints.js`, `promptBuilder.js`, `workspaceCompactCandidate.js`, `workspaceEvidence.js`, and `tools/agentTools.js`. Tests: `c6eLightweightContext.test.cjs`, one changed C6-B policy assertion, and three baseline fixtures. Deliverables: this report and `c6e-lightweight-workspace-context-evidence.json`. All pre-existing working-tree changes were preserved.

Reproduce measurements: `C6E_EVIDENCE_OUTPUT=/tmp/c6e-captures.json node tests/c6eLightweightContext.test.cjs`. Reproduce policy baseline identities with `node --require ./tests/fixtures/c6eBaselinePreload.cjs tests/<suite>.test.cjs`. The JSON stores source hashes and baseline/current results. No live database is used by these fixtures.

## Remaining limits and real-model validation

Natural-language semantic completeness is not proved by structural/source checks. Conservative standing-clause/section retention and explicit persistent lifecycle facts protect requirements independently of the summarizer, but unusual unmarked wording still requires semantic evaluation of the checkpoint. Legacy checkpoints without valid content coverage stay conservative. Unknown attachment requirements are retained rather than guessed away, so such histories may remain larger. Candidate navigation is bounded and requires extra read-only retrieval or clarification for remote/ambiguous references. Durable storage and integrity validation still scale with retained history.

To validate against a model, use a disposable Workspace/database and the already-loaded model without unloading or changing it. Record runtime per-request capacity and server-template tokenizer counts, capture the complete dispatched request with schemas, and run both independent and old-feature-reference tasks at 5/20/50/100 briefs. Confirm retrieval resolves an older source outside the eight-candidate window; ambiguous references produce clarification. Run first, third and eleventh compaction with an early file finding and an actual failing then passing test. Verify delta generation sources, unchanged originals, unique operation IDs, retained constraints and source-attributed findings. Inject deletion, cancellation, permission revision and concurrent mutation during generation; verify no activation/dispatch on failed guards. Record model, template, tokenizer, output/reasoning reservation, timings and exact counts separately from these deterministic estimates. This real-model work was not executed in this phase.

Stop at C6-E; no unrelated redesign was started.
