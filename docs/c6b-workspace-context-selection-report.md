# C6-B — Workspace context selection

2026-10-26. Implemented and tested with disposable SQLite databases, workspaces and controlled providers. No live conversation, user workspace file, permission policy, Casual compression implementation, notification sound, child compaction implementation or loaded model was changed. Existing tracked and untracked development work was preserved. No commit, push, reset, stash or clean was performed.

## Findings from actual serialized requests

The pre-change implementation injected **every task brief on the active branch**, including archived anchors, as an authoritative instruction on every Workspace request. `taskBriefs.getApplicableBriefs` walks ancestry without consulting archival flags; `buildTaskBriefSection` rendered that entire set. Normal preparation, recovery rebuild and branch preparation all used it. Consequently archived task text could survive both in a checkpoint/summary and in the protected brief block; unarchived user text also appeared in dialogue.

`workspaceCompactCandidate.snapshot` deliberately included archived ancestors. Generation received all captured messages (text capped at 4,000 characters), all evidence and the prior checkpoint, whose evidence overlapped the new bundle. The snapshot also included summaries, work digests, attachments, steering, background handles and child state for integrity checks, although not all of those collections were directly serialized to the generator.

Tool findings had a separate problem: `evidenceFor` discarded read/MCP result bodies and child excerpts, retaining operation metadata, digests and references. Command diagnostics survived selectively. During ordinary inference, `memoryChat` retains previous tool rounds; `engineManager.truncateToolOutput` truncates large results and `rewindFailedTurnRange` removes failed tool pairs. Neither truncation nor rewind previously supplied a model-callable, source-scoped recovery contract.

The report's JSON contains an actual before/after **provider JSON body** for the 20-brief fixture, captured at `runMemoryChat.fetchImpl`, rather than an intermediate message array. Both trees used the same durable fixture. The before tree was reconstructed from HEAD plus the complete initial working diff and initial untracked files; it includes C5/C6-A/W2–W7/S1/E1/notification work. Before and after use their respective real tool schemas. A separate frozen pre-change brief module supports the isolated selection regression test.

No real tokenizer or model was invoked. Byte counts and serialized contents are exact; **all token numbers below are estimates from the existing `contextBudget.approximateTokens` path**. Component estimates are not additive tokenizer measurements. The evidence separates system/developer text, schemas, active task, historical briefs, persistent constraints, checkpoint, archived dialogue, recent dialogue, evidence, work log and child-report categories. Absent components are explicitly zero in this brief fixture; separate incremental and child regressions exercise checkpoint/tool/child state. Active task and persistent constraint duplication in dialogue and the brief block is charged to those categories.

| Historical briefs | Before total estimate | After total estimate | Before historical-brief estimate | After historical-brief estimate |
|---:|---:|---:|---:|---:|
| 1 | 4,413 | 4,347 | 335 | 0 |
| 5 | 5,689 | 4,449 | 1,673 | 0 |
| 20 | 10,505 | 4,843 | 6,710 | 0 |
| 50 | 20,125 | 5,623 | 16,780 | 0 |

Every fixture still contains the current inspection task, the original “never publish” constraint, and `CRITICAL_C6B_FACT`, which lists offline export, retry queue and audit view. The 50-brief fixture retains all 52 original brief rows. The remaining cost grows partly because the fixture's current instruction explicitly lists every lifecycle directive; the optimization does not remove the current user's text. These results do not imply a universal token reduction for unknown legacy sessions.

## Storage and execution path

User save → `sessionManager.saveMessage` transaction → original `workspace_task_briefs` row → optional explicit lifecycle fact → durable message/execution steps and terminal work digest → normal/recovery/branch context selection → selected brief block and relevant assistant source index → current checkpoint, recent messages, bounded work log and plan → existing provider serialization → final inference dispatch.

The original brief store remains append-only. Existing edit/branch/H1 deletion semantics remain authoritative. The new lifecycle table references the brief, owning session and user source message; foreign-key deletion cascades remove dependent lifecycle facts. This is not permission or execution authorization storage.

## Lifecycle rules and user controls

`workspace_brief_lifecycle` stores explicit `active`, `persistent`, `completed` and `superseded` facts plus validated dependency brief IDs. Missing metadata means **unknown**, not completed. The latest brief is always selected. Unknown and persistent requirements remain protected. Completion is not treated as revocation of recognized constraint language: mixed briefs containing “do not”, “never”, “must”, “preserve”, “always”, “constraint” or “required” remain selected with a constraints-only historical label. Superseded/completed material brought back as a dependency is labeled historical data with no execution authority. A past Git commit request never becomes standing authorization.

An explicit user control is available without an LLM classification step. Put directives on the **leading lines** of a Workspace user message, followed by the new task:

```text
[workspace-brief #444 state=completed]
[workspace-brief #445 state=persistent]
Inspect the current implementation.
```

Supported states are `active`, `persistent`, `completed`, `superseded`. IDs must belong to the same active conversation branch. Prose containing an embedded example does not apply a directive; parsing stops at the first non-directive line. Invalid directives fail the user-message transaction without deleting existing history. There is intentionally no model tool to mark tasks completed or revoke requirements. The host API `recordLifecycle` requires the matching original user directive and validates dependency ownership.

Selection is shared by ordinary preparation, recovery rebuild and branch preparation. Completed unrelated briefs are omitted from the protected block; any unarchived corresponding user message becomes a source reference, while its original stays stored. Lifecycle facts are included in candidate snapshot/version validation and brief identity so concurrent changes cannot silently activate an outdated selection. Older checkpoint identities remain compatible when no lifecycle metadata exists.

This conservative implementation does **not** infer that an ordinary assistant answer or completed tool call finished the user's task. Legacy conversations and newly created tasks without explicit lifecycle facts can therefore retain all unknown briefs. Branch copies without lifecycle facts also fall back conservatively. General natural-language interpretation of persistent constraints is not proven; users should explicitly keep applicable requirement briefs persistent when marking older tasks completed.

## Dependencies and missing evidence

Validated dependency brief IDs are traversed transitively with cycle-safe selection; unavailable dependencies fail instead of synthesizing requirements. Backward-reference wording such as “earlier”, “previous”, “remaining”, “you listed”, “those tests”, “last change” and “continue” conservatively retains earlier briefs. The protected section additionally exposes on-branch historical assistant source IDs, 256-character observations, partial flags and recorded tool IDs, including archived sources. This preserves access to an assistant feature list rather than only the user's earlier question.

The dependency source index is capped at 24,000 characters and fails safely when exceeded. Long observations require explicit retrieval. Missing plans or results must be reported, not invented. The tests include an archived feature list, nested brief dependencies, supersession, legacy state and reopening. Historical data is never an instruction to rerun an operation.

## Incremental compaction and bounds

The first validated candidate records content-bound source coverage with message IDs, SHA-256 bindings, presented text length and partial-text flags. Mutable in-progress message rows are excluded from immutable coverage; existing W3 consumed tool IDs continue to bind their completed rounds. Coverage binds original storage, but does not assert that text beyond the supplied excerpt was read by the model.

Subsequent candidates validate every existing coverage reference against the owning active branch before generation. Invalid IDs, duplicate coverage identities, changed source content, incompatible lifecycle or a bad digest reject the candidate. A legacy checkpoint with no coverage uses the conservative full-source path.

Generation gets the previous validated task state and newly eligible messages; unchanged archived covered messages are excluded. Previously supplied evidence is compared by source identity and complete deterministic record hash, so unchanged records are not supplied again as new evidence. The prior checkpoint's duplicate evidence, source bindings and task-reference catalog are omitted from generator input. Final validation still resolves claims against the complete durable evidence. Previous source-bound decisions, completed work, research, tests, commands, file observations and **unresolved in-progress state** are retained even if the next draft omits them. Distinct contradictory observations remain distinct; failures are not replaced by later successes.

Model-facing checkpoint rendering omits internal coverage hashes and redundant evidence metadata, while preserving observations, source IDs, outcomes, diagnostics, file paths and child references. Durable checkpoint JSON retains the full validation data. Evidence has a **48,000-character hard ceiling** and partial observations of at most 256 characters. Over-budget evidence fails with `evidence-budget-exceeded`, without generation, archival or checkpoint activation. It is not silently trimmed. Existing final candidate/prospective-request budgets remain enforced. A run may need explicit retrieval or a narrower task when essential state exceeds these bounds.

| Identical 11-compaction fixture | Before | After |
|---|---:|---:|
| Original message presentations to generation | 77 | 12 |
| Generation stages | 11 | 11 |
| Eleventh generation input estimate | 8,368 | 2,233 |
| Seeded file finding present in checkpoint body | no | yes |
| Repeated tool executions | 0 | 0 |

The first after-generation is slightly larger (1,920 versus 1,886 estimated tokens) because it retains an actual file observation. Subsequent input remains approximately 2,231–2,233 tokens. Source hashes, branch ownership and complete durable state are **still read/validated**; the presentation counts do not claim fewer SQLite reads. The existing full parent-loop long-horizon regression still completes exactly 11 successful atomic compactions, with unique tool IDs and same-run continuation. Existing W3 prospective measurement, source/version/permission/owner checks, atomic activation and rejection compensation remain in place.

## Original evidence retrieval and mid-run continuity

The existing Context inspection API resolves checkpoint sources for the renderer, but was not an exposed model tool. The existing recent-history tool searched dialogue across sessions and did not retrieve original execution-step bodies. C6-B extends **`get_recent_chat_history`** instead of adding a new permission capability:

- `source_message_id`: original message content in the current Workspace conversation.
- `source_step_id`: original recorded tool result/status/arguments, optionally narrowed by message ID.
- `source_brief_id`: immutable original brief text.
- `offset`, `length`: bounded character pages; maximum length 8,000, default 4,000, with total size and next offset.

The source-specific path never searches other sessions, traverses child sessions, opens project files, runs commands or executes a previous tool. It checks H1 tombstones, Workspace ownership, active branch membership and unique source resolution. Foreign IDs, ambiguous step IDs and deleted/off-branch sources fail. Existing read permissions and permission revisions continue to be enforced by the dispatcher; no policy mapping was changed. The original recent-history behavior remains available when source selectors are absent. Normal tool formatting/redaction still applies to model-visible results.

Checkpoint evidence exposes a shared retrieval contract and exact source IDs. Truncated ordinary tool results get a retrieval notice after the existing guard; intact structured JSON remains intact. Failed-tool rewind retains all removed call IDs and the retrieval contract in its diagnostic summary. These changes do not rerun completed operations. Media image bytes already removed by the formatter are not recreated by this feature.

Deterministic below-threshold tests execute 20 unique rounds and inspect the actual serialized requests after rounds 5, 10, 15 and 20. An ordinary round-1 critical fact remains directly visible. A critical fact deliberately placed beyond the 20,000-character guard remains available through paged stored-result retrieval. An earlier `E_QUEUE` diagnostic survives a later success. Separate tests retrieve original MCP bodies and parent-recorded child reports with source identity, test output bounds and foreign-session rejection, and reject H1 tombstones. The full parent/child regressions retain their isolation and pending-operation checks.

## Verification and reproducibility

The full initial working status and SHA-256 manifest, before/after production file hashes, exact request pair, component estimates, incremental per-stage counts and exact failed test identities are in `c6b-workspace-context-selection-evidence.json`. Initial working diff/status and reconstructed baseline remain under `/tmp/continuum-c6b` for this session. No test uses a live application profile.

Commands:

```sh
node tests/c6bContextSelection.test.cjs
C6B_REQUEST_OUTPUT=/tmp/requests-after.json node tests/fixtures/c6bRequestCapture.cjs
C6B_INCREMENTAL_OUTPUT=/tmp/incremental-after.json node tests/fixtures/c6bIncrementalCapture.cjs
# Set C6B_SOURCE_ROOT to the reconstructed initial source tree for before captures.
npm run build
git diff --check
```

Forty existing suites were run **directly**, in both reconstructed baseline and final tree: 519 tests, 516 passing, two failures and one cancellation in each. Exact identities are unchanged:

1. `contextC3LiveProtection`: status-only transition test expects “Messages changed”; existing Casual recovery returns its context-changed error.
2. `workspaceBudgetVerification`: concurrent measurement test expects “Session history changed during compression”; same existing Casual error mismatch.
3. `h1DeletionIpc`: pending real tool-approval test is cancelled with an unresolved promise in both trees. Its first H1 IPC test passes. The separate H1 history-deletion suite passes.

The 16 new C6-B tests pass. W2–W7 generation/recovery/activity, safe/advanced compaction, briefs, checkpoint persistence, work logs, context budgets/measurement/recovery, agent-loop continuation, steering, permission modes/isolation, subagent continuation/budgets/retention and relevant file-tool suites are included in the machine-readable regression list. No assertion or baseline failure was hidden or relaxed. `npm run build` passes with the existing large-chunk advisory; `git diff --check` passes. This is a focused regression result, not a claim that every repository or renderer test passes.

## Source changes

- `db.js`: additive lifecycle table/index only.
- `taskBriefs.js`: explicit user facts, conservative selection, dependency sources and selected history projection.
- `promptBuilder.js`, `engineManager.js`: shared ordinary/rebuild/branch projection; failed rewind retrieval IDs.
- `workspaceCompactCandidate.js`: observations, bounded evidence, incremental generation selection, source coverage, unresolved-state retention and lifecycle snapshot binding.
- `taskCheckpoints.js`: compact model-facing evidence projection; full durable validation retained.
- `tools/agentTools.js`, new `workspaceEvidence.js`: source-selective, bounded, current-conversation stored-evidence retrieval through the existing guarded history tool.
- `memoryChat.mjs`: retrieval notices only for truncated Workspace results; existing output, permission and compaction protocols remain.
- New regression/capture fixtures and the two requested deliverables.

## Remaining limits and real-model validation

No general semantic completeness theorem, automatic natural-language completion classifier, or automatic revocation of unknown requirements is claimed. Dependency heuristics deliberately overretain; long source indexes and evidence can fail safely. Lifecycle controls currently use explicit leading directives/host calls rather than a new renderer UI. Source verification still scales with durable history. Candidate outcomes remain structurally/source-validated assertions; stored evidence is the recovery authority. Broad redesign of the separate truncation/rewind policies, Casual compression, child self-compaction and unrelated systems remains outside C6-B.

For real Gemma and Qwen validation, use separate disposable application profiles/workspaces and an already loaded supported model or separate test server; do not unload the user's model. Record model/quantization/template, llama-server build and context/slot settings. Repeat the 1/5/20/50 fixtures with exact leading lifecycle directives and one persistent constraint. Capture the final request body and measure through the existing `/props` → `/apply-template` → `/tokenize` path, preserving verified-versus-estimated status. Check the current task, constraint and actual feature-list finding, not only JSON validity.

Perform 20 real tool rounds with a unique early file fact, a failing diagnostic, a later passing test, an MCP body and a child report. Verify direct retention or a real `get_recent_chat_history` source page after rounds 5/10/15/20, including a fact beyond the truncation boundary. Force three and then eleven Workspace compactions; inspect newly presented source IDs, truthful failures, unresolved work and all coverage bindings. Repeat with cancellation, H1 deletion, permission revocation, concurrent source edits, invalid coverage and incomplete model output; require rejection and unchanged durable history. Verify atomic activation and no duplicate command/tool IDs on continuation. Record actual tokenizer counts and observed model behavior separately from these controlled estimates. No real-model latency improvement is certified here.
