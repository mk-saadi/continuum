# W2 — Workspace compact task-state candidates

Date: 2026-10-24, Asia/Dhaka. Evidence: [W2 evidence](w2-workspace-compact-state-generation-evidence.json).

## 1. Executive summary

Implemented an explicit Workspace-only prepare operation: durable active-branch history → structured task state → completion/schema/source validation → inactive row in the existing checkpoint table. It never archives messages, updates rolling summaries, supersedes the active checkpoint, changes a plan, rebuilds active prompts, or grants execution authority. Stop at W2; no W3–W6 implementation.

The initial working tree was clean. No commits, pushes, stashes, resets, cleans, migrations, live conversation deletions, paid inference or external-account mutations occurred. Fixtures mock Electron storage into temporary directories. The disposable baseline tree uses the recorded clean HEAD, not restored workspace files; dependency links point only to installed dependencies, never app/recovery storage.

## 2. Existing architecture and source review

Reviewed the W1 audit, 2026-10-22 context audit, H1 report/evidence, U7 report/evidence and U6 report/evidence, plus W1/context associated evidence. Reports are historical context, not proof of current behavior.

Actual source ownership:

- `sessionManager.saveMessage`, `activePath`, `getActiveMessages`: transactional messages, active-leaf branch walk, tool steps and attachments. Archived branch ancestors remain durable.
- `taskBriefs.captureBriefForUserMessage`, `captureRevisionBrief`, `getApplicableBriefs`, `getBriefIdentity`: append-only original/instruction/revision rows and active-branch applicability. `db.branchUserMessage` captures revision lineage.
- `taskCheckpoints.collectEvidence`, `evidenceIndex`, `buildCheckpointInput`, `validateCheckpoint`, `persistCheckpointRow`: legacy drafting/evidence validation and immediately-current persistence.
- `compactionCore.summarizeCandidates`, `generateCheckpoint`, `compactTranscript`: provider-independent legacy generation and child adapter protocol; existing parent callbacks in `main.js` discard completion metadata.
- `compressionEngine.checkAndCompressContext`/internal compression: existing summary/checkpoint/archival transaction, locks and live-row boundary. Idle and forced paths remain legacy compaction, not W2 prepare calls.
- `subagents/contextRecovery`: independent child rounds, pairing, summary/checkpoint generation, retention and scheduler budgets. Existing child generation rejects length/tool-bearing responses; its legacy validator remains unchanged.
- `cloudProviders.createCloudFetch`/`anthropicPayload`: nonstream Anthropic normalization and OpenAI-compatible/OpenRouter transport. Anthropic formerly mapped all non-max-token/non-tool reasons to stop; W2 now receives original stop metadata as well.
- `contextBudget.createPromptMeasurer`, `approximateTokens`, `createRuntimeBudget`: existing shared tokenizer/fallback and effective usable capacity. C1 trigger and reservations are unchanged.
- `workLog.buildWorkLogSection`, durable `workspace_turn_digests`, `workspacePlan.getPlan`, `promptBuilder.rebuildChatMessages`: historical execution digests and intended work in active prompts. W2 reads source state, never updates it.
- `engineManager.activeStreams`, assistant `run_id`, `run_steering_messages`: live-run ownership and steering. W2 refuses active owners/live tool steps rather than summarize an unsafe round.
- `sessionDeletion.assertAvailable`/`deleteConversation`, `compressionEngine.cancelSessionCompression`, `sessionManager.deleteSession`, DB cascade/tombstone triggers: H1 cancellation and late-write rejection. W2 joins cancellation without changing deletion policy.

## 3. Files changed

- `src/main/workspaceCompactCandidate.js`: new candidate service, strict provider completion parsing, contract, deterministic evidence, snapshot consistency, budgets, retry diagnostics and inactive persistence.
- `src/main/compressionEngine.js`: exported candidate entry point and cancellation participation.
- `main.js`: candidate-only raw local completion-envelope transport; legacy callbacks preserved.
- `src/main/ipcHandlers.js`: trusted `session:generate-compact-candidate` local prepare API with current model/runtime checks and shared measurement.
- `src/preload.js`: explicit `generateCompactCandidate(sessionId, modelId)` bridge. No UI auto-trigger added.
- `src/main/cloudProviders.js`: additive original Anthropic stop metadata; existing message/finish mapping unchanged.
- `tests/workspaceCompactCandidate.test.cjs`: isolated deterministic contract, golden quality, provider and race tests.
- This report and companion evidence JSON.

## 4. W1 defects addressed and boundaries

For the W2 candidate path, F03 incomplete/truncated/empty generation acceptance is closed by checking completion metadata before parsing. F07 silent array/text loss and 51→50 coverage loss are avoided by a strict contract with no trimming or per-array count caps. F08 gains deterministic operation/outcome references and full-output failure-identity extraction. F11 gains structured returned diagnostics and successful-candidate diagnostics in existing storage.

These fixes apply to the new prepare API. The legacy automatic compression callbacks/validator and their archive transaction are deliberately not replaced or invoked by W2. They retain their previously audited limits; this report does not certify them. Replacing the active context or wiring automatic safe commits belongs to W3. F01/F02/F05/F06 capacity/vision/prospective-prompt questions and F09 live-tail recovery remain separate. Parent-cloud automatic compaction remains unsupported.

## 5. Structured contract

Version 2 extends existing flat task-state concepts: objective, all brief IDs, outstandingRequirements, decisions, completedWork, inProgress, filesChanged, commands, tests, blockers, risks, unknowns, nextActions and research. All fields/arrays are required. Entries have typed source references; unknown top-level fields and unexpected authority-bearing nested fields are rejected. The service attaches task-reference provenance, immutable source bindings, deterministic tool evidence, the durable plan, pending-state references, limitations and lifecycle `validated-candidate`.

No essential array is sliced and no low-priority section is cleared to meet a target. Empty failed-command follow-up state is rejected. Structural/source validity does not prove natural-language semantic completeness.

## 6. Authoritative requirements

Every applicable brief ID must be returned in the exact source order. The service independently creates every brief reference, message anchor, original/instruction/revision kind, supersedes ID and content/attachment-metadata digest. All verbatim originals remain in existing `workspace_task_briefs`; no model paraphrase can overwrite them. Off-branch instructions do not become applicable. A revision retains its superseded original as durable provenance, not as an applicable instruction from an abandoned branch.

One brief can itself contain 51 or more requirements; its full text remains authoritative. The 51-record fixture also preserves all 51 references. Large protected briefs fail the input/continuation capacity check explicitly, without altering originals.

## 7. Tool history and evidence

Each tool record retains message/step identity, tool name, kind, deterministic outcome, paths, exact command when applicable, source-result reference, source-output digest/length and partial-observation label. Command exit codes come from persisted results. Full stdout/stderr is scanned for exact `not ok`, `FAIL`, `Error:`, `error:` and TAP count lines before repetitive raw output is omitted. Count parsing uses the existing checkpoint parser and stays labeled parsed. Tests/commands cannot substitute model-invented exit codes. Successful file reads cannot validate edits; recorded file operations do not prove current file contents.

Arbitrary raw child reports, approval payloads and result objects are not duplicated. Reported child IDs are labeled parent-result references to independent history. This does not certify a child's assertions as verified parent work. Diagnostics that do not match the deterministic recognizers remain retrievable through the durable result reference; exhaustive test-runner parsing is not claimed.

## 8. Generation reliability

Only completed final content is parsed. OpenAI-compatible/local/OpenRouter require `stop`; raw Anthropic requires `end_turn`. Length/max-token responses are rejected even if the content is valid JSON. Empty/reasoning-only, tool-bearing, unknown/missing-finish, malformed JSON, missing-section and invalid-source output fail. JSON fences are accepted only around the entire response, never by extracting a valid-looking fragment from incomplete prose.

## 9. Provider behavior

The local main-process branch returns the entire nonstream response to W2. The actual cloud adapter is tested with synthetic HTTP responses for both OpenAI-compatible and Anthropic serialization, output reservation and tool-free generation. Anthropic raw stop metadata prevents `pause_turn`/unknown reasons normalized to legacy `stop` from being accepted by W2. The additive metadata does not change legacy consumer finish semantics.

The renderer prepare route intentionally supports the existing loaded-local-model path only. The provider-neutral service accepts an existing adapter transport; mocks demonstrate its contract. No parent-cloud automatic compaction, new inference architecture, live cloud account, paid request or real-GGUF fidelity claim is made.

## 10. Retry/failure policy

At most two generation requests: one initial attempt and one corrective retry containing the previous validation error code and an instruction to regenerate the whole document. Truncation/empty/JSON/schema/reference defects are recoverable; uncertain completion, provider failure, context overflow, cancellation, deletion, stale snapshots and capacity failure are not blindly retried. Requests remain bounded by the same output/context checks on both attempts.

Failure codes include model-unavailable, context-overflow, output-truncated, empty-response, incomplete-response, invalid-json, missing-required-data, schema-invalid, invalid-reference, missing-task-brief-reference, unsupported-completion-claim, unsupported-file-claim, stale-task-brief, deleted-conversation, cancelled-run, provider-error, budget-exceeded, concurrent-state-change, candidate-busy, invalid-source-evidence, sensitive-candidate-data and not-safe-to-compact-yet. Error bodies/private prompts are not logged.

## 11. Validation limits

Completion, field types, exact brief coverage, same-branch references, operation kinds, exit outcomes and source consistency are deterministic. Completed-work prose needs successful-step evidence but remains explicitly an assistant claim with unverified semantic meaning. Decisions/research remain attributed conclusions, never independent facts. The service cannot determine that an arbitrary sentence accurately captures an entire source document; golden fixture facts are asserted individually instead of declaring JSON validity equivalent to perfect preservation.

## 12. Size and output budgets

The generation input is measured through the existing exact tokenizer/template path where supplied; otherwise through shared conservative full-request estimation. Output is bounded by `min(6144, floor(capacity * .4), capacity - input - 128)` and must have at least 1024 tokens available. A retry is remeasured. Reasoning consumes the same generated allowance; an empty or incomplete final still fails. No 512-token prose summary is required by W2.

Validated state is measured independently of generation output. Shared candidate estimates use serialized UTF-8 full-request accounting, not a new estimator. Provider usage, generated-content estimate, validated tokens, method and protected-brief estimate are distinct diagnostics. Exact-measurement injection is tested with a deterministic measurer; no real tokenizer is claimed for the golden measurements below.

| Golden fixture | Candidate tokens (estimate) | Protected briefs (estimate) | Combined | Under 5K candidate |
| --- | ---: | ---: | ---: | --- |
| small Workspace | 1,717 | 59 | 1,776 | yes |
| 51 authoritative requirements | 4,450 | 1,551 | 6,001 | yes |
| long coding tool output | 1,725 | 59 | 1,784 | yes |
| essential state over target | 8,934 | 59 | 8,993 | no; all entries retained |


The 5K goal concerns the reducible candidate. Protected authoritative briefs are measured separately and also shown in the combined estimate; referencing a brief does not make its content free. Base instructions, advertised native/MCP schemas and fresh/live context are absent from this candidate-size metric. W3 must measure the complete actual resumed request, including their true overhead.

## 13. Protected-content and source limitations

The service fails rather than trim essential state when candidate plus protected briefs cannot fit declared capacity. Source assistant/user prose sent for drafting is explicitly partial above 4000 characters per message. Full briefs are supplied separately; tool results stay durable and are represented by metadata/references. Very large many-message inputs may require a later bounded hierarchical generation strategy; W2 currently returns budget-exceeded. No silent claim of complete semantic coverage is made for omitted prose. Attachment identity binds stored metadata, not externally modified file bytes; callers must revalidate external source content before using it.

## 14. Pending/live state

Active run owners, in-progress assistant rows, pending/running/preparing tools and retained background-command records return not-safe-to-compact-yet before inference. Completed snapshots carry pending fields and steering references, not approvals usable as grants. The conservative background-record refusal also includes completed retained handles. W2 does not rewrite tool pairs or current-run tails. W4 owns that capability.

## 15. Snapshot consistency

The SHA-256 source binding covers all persisted active-branch message columns (including same-length text changes, tool result/status and run identity), applicable brief contents, summaries, plan, turn digests, attachment records, steering rows, background records, active leaf and checkpoint head. The temporary compression lock is normalized out. Live owner identity is compared separately. Snapshot checks run before each attempt, after generation, after measurement and inside the SQLite insertion transaction. New instructions yield stale-task-brief; other source mutations yield concurrent-state-change. A newer candidate/checkpoint head cannot be overwritten.

This is a prepare-time consistency binding. W3 must implement its own safe-commit ownership and prospective-fit contract and account for the candidate's own newly inserted row when checking checkpoint-head identity.

## 16. H1 compatibility

Candidates use existing session foreign keys and deletion cascade; no upsert or get-or-create is used. H1's availability/tombstone guard is checked at snapshots and persistence. Cancellation aborts candidate generation and awaits its settlement before H1 proceeds with deletion. Non-cooperative providers can delay settlement, matching the existing deletion safety boundary; late returned output cannot persist after cancellation. Tests cover actual H1 service deletion during generation, independent DB deletion/late result, post-validation saved-candidate deletion, cancellation, stale saves and close/reopen after deletion. No live deletion occurred.

## 17. U7 compatibility

No authorization policy or tool implementation changed. Candidate content has no execution authority. Native/MCP schemas and approval tokens are not serialized as grants. Raw result objects are not copied. Known labeled credential/approval strings in candidate metadata cause refusal rather than changing exact commands through redaction. Unlabeled secrets in arbitrary prose cannot be reliably recognized; this is a documented limitation, not a credential-classification proof. Tool-output injection cannot become an authoritative brief: references are built independently from user-owned durable brief rows. The malicious-output test is deterministic, not a real-model prompt-injection resistance certification.

## 18. Casual non-regression

The candidate entry point rejects Casual before generation or storage. A golden fixture compares its full durable history and rebuilt active prompt before/after the rejected operation. Casual has no briefs or checkpoints. Existing compression/core/summary paths, thresholds, Casual prompt format and summary format remain unchanged. H1 cancellation loads the candidate service but creates no candidate overhead in Casual prompts. Shared cloud metadata is additive only.

## 19. Golden quality evaluation

Known fixture facts are asserted for brief/revision coverage, decisions, multiple changed files, exact failed test name, nonzero exit, open work, next action, source provenance and independent child ID. Hallucinated source/completion/file claims are rejected or explicitly unverified. Golden results and all new test identities are in JSON. Fixtures demonstrate selected facts, not universal natural-language recall. All model outputs are scripted.

## 20. Focused verification

Final localhost-enabled focused run: **378 passed, 0 failed**. Latest independent W2 module: **44 passed, 0 failed**. Focused restricted baseline retained its five environment-sensitive failed file identities; exact inventories and direct assertions are in evidence. The newest engine-final-measurement assertion is additionally covered by the independent W2 run.

The fresh baseline ran Workspace briefs/checkpoints, current summary/child compaction, provider adapters, C1/C3 and recovery/security suites before production edits. Direct pre-edit checkpoint/brief/budget runs also retained individual assertion output. The package's literal `node --test tests/` command fails under this installed Node version because it treats the directory as a module; the full runs use explicit `tests/*.test.cjs tests/*.test.mjs` instead. This invocation failure is recorded, not counted as an application regression.

## 21. Regression comparison

| Run | Tests/entries | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| baseline-full | 230 | 199 | 31 | 0 |
| final-full-stable | 231 | 200 | 31 | 0 |
| baseline-enabled | 1773 | 1759 | 13 | 1 |
| final-enabled-stable | 1817 | 1804 | 12 | 1 |

Restricted exact `(file, test name)` comparison: 0 new identities, 0 absent in final, 31 unchanged. Absence in a later run is not automatically a fix.

Enabled exact `(file, test name)` comparison: 0 new identities, 1 absent in final, 12 unchanged. Absence in a later run is not automatically a fix.

Prior concurrent full runs exposed an additional restricted subagent-dispatch file failure and an enabled LSP stale-result failure. Independent final subagent-dispatch checks pass 11/11; independent final LSP/background checks pass 28/28. A baseline independent LSP/background rerun itself failed another real-server LSP assertion. These are recorded as observed run-dependent failures, not silently waived by matching totals or claimed as W2 repairs. Final inventories above use separately repeated runs.


The first disposable enabled baseline had an extra packaging-path assertion because a root dependency symlink resolved TypeScript outside its expected baseline-tree prefix. The baseline layout was corrected by copying the three pinned TypeScript/runtime packages into its own dependency directory, then rerun. No application source or test assertion was changed. Initial layout/timing anomalies remain in evidence rather than being classified as product fixes.

## 22. Production build

Fresh baseline and final `npm run build` pass with the existing Vite chunk-size warning. `git diff --check` and syntax verification pass. No packaging/deployment was performed.

## 23. Real-model limitations

No real local/GGUF or paid cloud generation was performed. Finish handling, payload serialization, retries, races, persisted references and golden facts are deterministic/mock verified. Reasoning-model final-answer quality and real tokenizer accuracy remain unverified. The new prepare API has no mounted Electron interaction test.

## 24. Remaining W3/W4 dependencies

W3 must review candidate lifecycle, measure the full reconstructed prompt (including protected brief, fixed instructions, native/advertised MCP schemas, work log/plan, fresh input and protocol tail), atomically commit against live ownership, and decide how inactive candidate rows are promoted. No candidate is activated automatically. W4 owns complete-round live-run recovery; this service deliberately refuses unsafe live state. W5 events and W6 are untouched.

## 25. W3 readiness decision

The explicit W2 candidate service is available for safe-commit evaluation, with structural/source checks and documented quality limits. It is not approval to enable automatic compaction or a certification of all project acceptance criteria. Existing regressions, incomplete semantic guarantees, real-model verification, very large source-input handling, and unsupported parent-cloud automatic recovery remain open. Keep the legacy automatic compaction path's audited defects visible until W3 integration explicitly addresses its commit boundary. Work stops after W2.
