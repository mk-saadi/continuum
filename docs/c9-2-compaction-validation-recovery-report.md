# C9.2 — Compaction validation and guarded recovery

2026-10-29, Asia/Dhaka. Recovery defects are fixed and reproduced deterministically. The original rejected Qwen finding is **not recoverable from persisted records**; no false-positive validator defect has been established or bypassed. [Evidence JSON](c9-2-compaction-validation-recovery-evidence.json).

## Preservation and baseline

Initial tracked and untracked changes are recorded in the evidence JSON. All preexisting C9.1/P2 and other work remains. C9.2 modifies only `workspaceCompaction.js`, `workspaceCompactionActivity.js`, and two existing test files, plus these reports/evidence. No commits, stash, resets, dependency installation, permission/tool profile/context changes, live data writes, historical checkpoint activation or model lifecycle actions occurred.

Live inspection used Python `sqlite3.connect('file:…/memory_palace.db?mode=ro', uri=True)` directly, never application initialization or migration. Disposable synthetic databases implement reproductions. Original TaskFlow records were only read; source files in TaskFlow were not touched.

Read C9.1 report/evidence and relevant C7, C8, C9 and P2 reports; traced current source rather than assuming report state. The initial seven-file focused C7/C8/C9/C9.1/candidate/safe-activation/P2 baseline passed 7/7. Additional direct-file baselines and final results are recorded independently.

## Actual incident identity

| Field | Stored value |
|---|---|
| Conversation | `421ac69f-be7d-4e41-961d-5a7f6b4020b1` |
| Current displayed title | `rio` |
| Project | `b62f8ed9-c325-4858-bdba-58f507f1e389`, `testing new workspace update` |
| Parent run | `50a002c9-196b-4ed5-bef9-1c59beddf7d7` |
| Assistant message | `3974`, created `2026-10-28 21:07:25`, status `interrupted`, archived `0` |
| Failed activity / sequence | `420281f7-7ee7-42f5-9618-79e712a1f664` / `45` |
| Started / last updated | `2026-10-28T21:12:56.392Z` / `2026-10-28T21:15:24.021Z` |
| Anchor | `dO3TwSTUZCeLH1bCOFo4RYjNPyFZokxO`, completed read of `src/components/TaskInput.jsx` |
| Last valid checkpoint | None: no checkpoint rows for this session |
| Stored activity code | `compaction-error` |
| Next-request measurement | 44,128, `server-template-tokenizer` |
| Usable input / trigger | 44,160 / 39,744 |
| Last dispatched provider prompt | 40,908; 13 parent prompt requests recorded |

The last dispatched prompt and the next rebuilt request are different measurements. Only 32 input tokens remained at the failed boundary. That historical measurement does not itself authorize a future dispatch.

Activity 44 in the same parent run began `21:09:06.125Z` and ended `21:11:46.432Z` with `continued`, code `output-truncated`, and beforeTokens 40,506. This proves the earlier guarded fallback path was used. It does not prove a checkpoint activated. Full history and completed tool records remain stored.

## What can and cannot be reproduced

The user captured `unsupported-finding-claim`, stage `intermediate-generation`, 40,205 evidence characters under a 48,000-character ceiling, capacity 45,312 and generated budget 32,768. These details are labeled user-reported because durable activity metadata does not retain them.

Candidate generation with `persist:false` keeps rejected drafts in memory only. Its console diagnostics contain completion metadata and rejection codes, not candidate content. The durable activity schema stores neither rejected JSON nor validator feedback. No saved console/allocation log was found in the inspected app location. Therefore the original rejected finding, exact quote, exact stage source membership, correction responses, completion status and intermediate tokenizer measurements are unavailable. They have not been reconstructed or invented.

The evidence JSON lists all 18 durable parent tool operations, source paths, IDs, stored hashes and excerpt sizes. These are available originals, not a claim that every operation belonged to the failed intermediate segment. The last source contains `export default function TaskInput({ onAdd }) {` and `onAdd(trimmed, {`; the preceding TaskItem read contains `export default function TaskItem({ task, onToggle, onUpdate, onDelete, onAnnounce }) {`. Both returned complete excerpts. Earlier taskLogic/App/test reads include partial or repeated results. Original segment boundaries and cited operation are unknown.

A disposable source/test copy with only C9.2 production changes reversed reproduces four failures in the new recovery assertions: 50/54 pass before, 54/54 after. The rejection comes from production finding validation against a deliberately fabricated quote, not a stubbed failure result. This reproduces the terminal propagation mechanism; it does not recreate Qwen's unknown prose.

## Validation chain and hypothesis audit

Current execution is stored step → `collectEvidence` → `evidenceFor` → generation encoding/paging → intermediate `validateDraft` → merge/final validation → summary measurement → prospective request validation → atomic activation → dispatch validation.

File-read content is retained as observation; commands use bounded previews plus parsed diagnostics. Oversized records are paged into 8,000-character units, with original step identity, offsets and partial flags. Intermediate validation resolves only supplied segment evidence. `evidenceIndex` may select a later page for operation metadata, but quote matching explicitly searches all supplied parts with the same message/step identity. It does not join separate page text or borrow another operation's quote.

| Hypothesis | Evidence and conclusion |
|---|---|
| Genuinely unsupported quote | Production validator rejects fabricated text; possible original cause, unknown without draft. |
| Wrong/nonexistent/stale source ID | Wrong operation rejected; absent segment reference rejects as `invalid-reference`. Original citation unavailable. |
| Lost excerpt / paging / multiple segments | Existing large-source fixture reconstructs all paged observations and retains tail findings. Segment-missing quotes fail closed. No demonstrated original data loss. A quote spanning separate pages is not accepted as one exact supplied excerpt. |
| Normalization mismatch | Matching is literal `includes`. Exact Unicode/CRLF accepted; altered NFC/newline representations rejected. Original quote unavailable; no normalization relaxation justified. |
| Partial read / whole-file absence | Partial metadata is retained and the prompt forbids whole-file absence from partial reads. Semantic entailment remains unverified; arbitrary natural-language absence is not mechanically proven. |
| Intermediate treated as final | Intermediate uses the shared structural/source validator, its own output budget, then final merge is revalidated. No 4,999-token gate at the reported finding-rejection point. |
| Completion vs historical finding | Read cannot certify edit/build/test success. Historical source support does not certify current revision. Existing failed-test and unrun-build negatives pass. |
| Bounded correction not reached | Code permits one correction for this code at intermediate and final stages. Scripted correction succeeds; repeated rejection fails. Original correction count/completion metadata were not persisted. |
| Summary/evidence length | Reported rejection is finding validation, not the summary gate; evidence was below the displayed ceiling. No evidence justifies raising either bound. |

Exact quote validation establishes an observation, not semantic proof. Supported findings remain attributed assistant conclusions with `semanticVerification: unverified`. Interpretations without a quote remain uncertain. Completed work needs an appropriate successful operation; user instructions derive from authoritative briefs. Source comments and tool text remain untrusted. C9.1's semantic renderer, ownership checks, original evidence and summary ceiling are unchanged.

## Proven root causes and changes

1. `perform` allowed `unsupported-completion-claim` and `unsupported-file-claim` into optional recovery but omitted `unsupported-finding-claim`. Consequently a source-finding rejection threw before the existing authoritative rebuild/fit/ownership checks could run.
2. Activity `safeCode` omitted the same code, replacing the diagnostic with `compaction-error`.
3. Optional failures had no identical-boundary generation suppression.

The production patch adds the missing code to those two allowlists. It stores at most one rejection per owner in a WeakMap, bound to session/model, captured source version, complete request payload, permission revision, operation identity and budget identity. An identical boundary reuses the rejection and reruns recovery checks; it never reuses permission to dispatch. Changed evidence/request/ownership does not inherit that cached identity. Forced overflow recovery still fails closed and does not enter optional continuation.

No finding-validation rule is weakened. No optional finding is silently dropped or promoted to verified. No new persistence schema or engine changes were introduced.

## Recovery behavior

After bounded candidate rejection, ordinary pressure-triggered compaction rebuilds the original request, retaining the previous checkpoint and complete paired tail. It verifies unchanged snapshot/owner, cancellation, deletion, permission revision, independent operations, paired tools and budget identity. Only nonnegative integer measurements from `server-template-tokenizer` with runtime-reported capacity can authorize fallback, and only within the usable input budget. These checks run again immediately before dispatch.

A changed request/snapshot or permission, cancellation or deleted session blocks continuation. Missing model/tokenizer measurement cannot certify fit. Oversized requests return recoverable `prospective-context-overflow`; forced compaction errors remain recoverable failures with preserved history. No rejected candidate is persisted/activated. A same-run retry of identical evidence skips generation but rebuilds and measures again. No general ignore-errors mode exists.

The original 44,128 measurement suggests a possible fit, not proof that the repaired original run would have continued: runtime changes or a different authoritative rebuild could consume the 32-token margin. No historical run was resumed.

## Verification

Final direct selection: **23/28 files pass**. TAP suites account for **348/351 assertions passing**; standalone scripts add both passes and two failures not represented in that count. New C9.2 coverage adds seven semantic tests and eight recovery tests. Semantic suite 16/16, safe-compaction 54/54, candidate 55/55, C7 15/15, C8 5/5, C9 21/21, advanced 26/26, activity 26/26, generation runtime 15/15, P2 8/8. Exact per-file results and baseline identities are in JSON.

Existing tests cover valid/rejected quotes, paged sources, unknown current revision, failed tests, unsupported completion, bounded corrections, previous checkpoint retention, original history, same-run tool continuity, P2 activation, cancellation/deletion/permissions, authoritative context limits and atomic activation. New tests cover wrong/missing-stage sources, exact Unicode versus altered normalization, source authority, partial-source uncertainty, multi-part attribution, intermediate missing excerpts, rejected-finding recovery, identical-boundary suppression and changed requests. Source semantic entailment, including arbitrary whole-file absence language, remains a limitation rather than a falsely claimed mechanical guarantee.

Five unchanged failures were confirmed against pre-C9.2 source:

- `c6cAcceptance`: real coding operations across three compactions; expected sandbox command outcome is not produced.
- `workspaceBudgetVerification`: concurrent-history test expects “Session history changed during compression”; actual existing error is “Conversation context changed during Casual recovery…”.
- `sessionPromptWording`: stale Workspace continuity wording expectation.
- `recentChatHistory`: stale “For recall, retrieve evidence” expectation.
- `engineSettings`: expected defaults omit existing notificationSounds/recovery retention/storage fields. Reproduced against disposable pre-C9.2 source.

`npm run build` passes with the existing chunk-size advisory. `git diff --check` passes. No unrelated assertions were edited. Model launch/lifecycle/GPU/offload tests passed apart from the baseline settings-expectation failure.

All candidate models and tokenizer endpoints in tests are scripted doubles. The 4,999 acceptance / 5,000 correction-or-rejection boundaries use synthetic tokenizer counts through production guards; no real tokenizer certification or real-model inference occurred. No active model was loaded, unloaded or restarted.

## Real-Qwen acceptance procedure

1. After separately authorized model availability, use an isolated disposable profile/project and copied/sanitized task evidence. Keep original settings, P2 profile and tool contracts. Never activate a historical checkpoint.
2. Capture candidate requests/responses in a private disposable harness, stage memberships, exact quotes, completion reasons and correction feedback. Avoid another long stress run; replay one failing evidence boundary first if original console output becomes available.
3. Measure the complete summary through the matching runtime template/tokenizer; require fewer than 5,000 tokens. Independently measure the complete continued request with schemas and briefs.
4. Exercise one unsupported quote with a fitting request and one over-budget request. Confirm rejection, original history/prior checkpoint retention, exact pre-dispatch remeasurement and no generation retry on an identical boundary.
5. Then exercise one valid source-backed candidate and a short legitimate continuation. Verify atomic activation, retained source findings, paired same-run tools and P2 specialized activation. Stop on completion; record actual inference/tokenizer results separately.

Work stops at C9.2 and M1. Original Qwen quote attribution remains unresolved because the evidence was never persisted.
