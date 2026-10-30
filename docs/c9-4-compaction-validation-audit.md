# C9.4 — Compaction validation audit and rejected-candidate diagnostics

2026-10-29, Asia/Dhaka. No live-model inference, tokenizer endpoint, model lifecycle action, dependency installation, live database write or TaskFlow change occurred. Existing tracked/untracked work was preserved. No commit, push, stash, reset or clean occurred.

## Historical incident

Direct Python SQLite `mode=ro` access, without application initialization or migrations, verified session `421ac69f-be7d-4e41-961d-5a7f6b4020b1`, title `rio`, project `b62f8ed9-c325-4858-bdba-58f507f1e389`. Sequences 46 and 47 belong to parent run `8041d529-12c6-4862-9d14-32a4f0ba27e0`, assistant 4012. Attempt identities are `fa8d359c-6208-4d14-8b4b-68e22a44b8d4` and `121dce00-5adc-46a8-a722-32c91bb6f2d6`. They record unsupported finding/completion respectively, 49,568/52,933 request tokens, capacity 54,400, trigger 48,960, tokenizer method and continued status. There are no checkpoint or summary rows for this session. Full retained activity rows are in the evidence JSON.

Read-only identity queries also verify project name, original user request 3973 (10,955 characters), and brief 619 linked to it. The C9.3 report establishes their task context and the premature-stop investigation. Those task contents were not recopied into this diagnostic report. Original rejected candidate unavailable: neither its text, source citations, exact failed field, correction feedback nor correction outcome can be recovered. Generation-stage count zero is a default, not evidence of no generation. Neither historical rejection can honestly be classified as a model error or validator false positive.

## Production pipeline and architecture

`taskCheckpoints.collectEvidence` derives operation kinds/outcomes from durable execution steps. `workspaceCompactCandidate.snapshot` reads the active branch, authoritative briefs, plan, checkpoint identity, pending state and content-bound source version. `incrementalInput` checks prior source coverage. `evidenceFor` retains observations, provenance, source references, operation status, paths and diagnostic counts. Command previews are limited to 256 characters; sensitive observations are withheld. Tool text is untrusted data.

`generationEvidence` encodes long repeated text for generation only. `reduceHistoricalInput` splits large observations into 8,000-character pages, packs bounded evidence batches, and uses the same PROMPT/schema and `validateDraft` in each batch. Source records can have multiple pages with the same operation identity. Intermediate validation sees only its selected messages/pages. Final validation sees original evidence and prior findings. A quote crossing page boundaries can therefore fail intermediate validation even when present in a full original observation; this is a source-supported contract risk, not an explanation proven for the historical Qwen drafts.

`parseCompletion` checks provider completion metadata and normalizes whole-document JSON. `retainPriorState` strips derived fields from prior structured state, retains distinct facts and merges intermediate findings. Final `validateDraft` checks that merged document against durable evidence. An error's entry index consequently addresses the merged validation input, which can differ from the raw final model array order. Diagnostics capture the actual validation input.

`compactionSummary.renderWorkingSummary` creates deterministic Markdown; `verifySummaryBudget` enforces an authoritative measurement below 5,000 tokens. `workspaceCompaction.perform` rebuilds and measures the complete provider request, performs existing bounded target refinement, and activates atomically with source/ownership/permission/pending-operation checks. Two recent tool rounds remain protected. Optional rejected generation can use C9.2's guarded original-request continuation, never checkpoint activation. Forced overflow still fails closed. C9.3 parent-loop behavior is unchanged.

Before C9.4 failed parsed drafts disappeared in catch blocks. Errors retained code and structured feedback transiently; fixed console telemetry excludes drafts. Activity SQLite metadata retained counts/status/code but not rejected claims. Candidate/checkpoint diagnostics were available only for successful generation.

## Exact rejection conditions

Finding rejection occurs when supplied `evidenceQuote` is empty or absent from every observation page belonging to a cited executed operation. A success or recorded diagnostic execution failure can support a quote. The operation must first resolve through a message in the captured session and the evidence index; invalid/missing/foreign identities produce `invalid-reference`. Literal matching is case/Unicode/whitespace sensitive, with no paraphrase normalization. Another operation's identical-looking citation cannot borrow its text. Supersession additionally requires a known prior finding with exact text/source identity and newer successful same-path evidence containing the quote.

Unquoted research is accepted as an attributed, semantically unverified conclusion. Unknown current file revisions do not invalidate historical observations. Partial reads do not mechanically prove negative findings, but there is no general prose entailment/absence classifier. An injected imperative can remain quoted historical data; it gains no brief authority. Citation validity alone does not establish the conclusion's truth.

Completion requires at least one cited successful operation. Recognized edit verbs require file-edit evidence. Recognized verification phrases require successful exit-zero command evidence; completedWork also rejects verification citing a failed command. Recognized “build passed” requires a command containing build/vite/tsc. Research “ran/executed” requires executed evidence, and passing/build claims have corresponding command guards. FilesChanged independently requires matching path, nature and operation kind. Commands/tests require exact command equality and derive outcomes deterministically, discarding generated outcome fields. A plan checkbox alone cannot prove implementation.

These are phrase/type checks, not a semantic proof system. A successful edit proves an applied operation, not correct functionality or every file's current state. A scoped test can currently support an overbroad all-tests phrase. Arbitrary synonyms can evade phrase recognition. Historical successful operations remain historical facts after later failures; cited mixed failure/success verification is rejected. Prior completion is retained and revalidated, not independently granted authority by checkpoint membership. Atomic edit correctness is inherited from existing durable tool outcomes, not reimplemented here.

## Generator versus validator contract

| Claim | Model instruction/output | Validator expectation | Mismatch or limit |
|---|---|---|---|
| Source finding | Research conclusion, optional exact evidenceQuote and sources | Literal excerpt in cited executed observation | Page-local matching; quote is not semantic entailment |
| Completed edit | completedWork text with mandatory step IDs | Successful operation; edit verbs need file-edit | Finite verb recognition; successful edit is not task correctness |
| Passing test | Exact command in tests, accurate outcome in prose | Exit-zero successful command for recognized prose | Test-command identity/scope is not semantically matched to prose |
| Failed command | Research/tests, never completedWork | Diagnostic execution status; durable outcome wins | Corrections may still use unsupported passing phrasing |
| Hypothesis | Unquoted attributed research, unknowns/risks | Sources resolve; semanticVerification stays unverified | No automatic truth certification |
| Current work | inProgress with sources | Valid source identity, structural checks | Does not establish completion |
| Next action | Nonempty strings | Structural validation | Not execution or new authority |

PROMPT explicitly requires actual citations, limits read evidence to inspection, distinguishes failed executions from passing verification, forbids embedded tool instructions and warns against whole-file absence from partial reads. It requests useful concrete behavior and concision, with optional exact quotes. Reducers and final generation share the contract. Corrections request entire JSON and preservation of useful/essential findings, potentially causing repeated invalid paraphrases/quotes. No prompt change is made on that hypothesis. Unknowns remain uncertain rather than being forced into verified findings.

## New diagnostic schema and access

`compactionRejectionDiagnostics.js` captures errors at the `validateDraft` boundary and records generation failures in existing bounded loops. Schema v1 contains candidate UUID, timestamp, code/category, exact array-entry path, bounded text/quote, required evidence, source message/step IDs, existence, partial status and durable outcomes. Generation stage, batch index and correction attempt distinguish intermediate/final versions. Original and corrected UUIDs link correction outcome/rejection code and whether the redacted claim changed. Null means unavailable, not unchanged. Safe structured correction feedback retains category/index/required evidence or code; the full private prompt and feedback's available-operation catalog are deliberately excluded.

The existing activity row supplies session, parent run, compaction attempt ID, timestamps, checkpoint ID, status, continuation, summary measurement where available and full-request boundary measurement. Interpretation requires joining these enclosing fields; do not mistake a validated correction for atomic activation. If generation ends before a correction validates, its rejection code remains recorded. The retry policy remains two attempts per stage, with existing token/time/stage limits.

The new `rejectionDiagnostics` activity metadata survives failed and successful corrected generation, including forced rejection and optional continuation. It is not an execution-step/tool result. No new database table or migration is required. The existing inspector exposes details on expansion, and historical unsupported attempts explicitly state “Original rejected candidate unavailable.” Normal broadcasts strip confidential diagnostic metadata; the existing trusted activity-list/polling path supplies it for inspection. The renderer hydrates diagnostics at the same revision as a content-free broadcast, without allowing a later content-free duplicate to erase them. Counts/reasons remain visible normally. Existing statuses distinguish completed, continued, failed, deferred and cancelled; codes distinguish validation, generation, context and summary-budget failure.

Storage policy: at most 24 diagnostic entries per compaction generation, 512 characters each for claim and quote, at most 16 citations per entry, bounded operation outcome sets. No entire raw draft, source file, environment or tool arguments are copied. Known labeled credentials, bearer tokens, sk-style tokens and PEM private keys are redacted before truncation. This is best-effort text redaction; arbitrary unlabeled sensitive prose cannot be recognized. Treat all retained excerpts as confidential conversation data. Existing local database protection/data-access gate applies; no new public endpoint or notification content is introduced.

Retention follows activity/conversation lifetime, with session foreign-key cascade and tombstone insertion guard. No independent indefinite intermediate-candidate archive is created. Total across many conversations follows existing activity retention, not a new global quota. Trusted local IPC uses `isTrustedSender` and `withDataAccess`; the application has no independent per-tab user principal. A different session list cannot return these rows, but a trusted local owner can inspect their own other sessions. Do not claim a new multi-user authorization boundary.

## Deterministic outcomes and scope

| Rejection case | Expected | Actual | Classification | Recommended action |
|---|---|---|---|---|
| Genuine unsupported finding | Reject | Reject | Correct | Retain guard |
| Supported excerpt | Accept | Accept, including partial page | Correct | Retain attribution |
| Source citation mismatch | Reject | Reject | Correct | Correct model citation |
| Unverified working hypothesis | Preserve uncertain | Accepted without source-backed promotion | Correct | Preserve uncertainty |
| Unsupported completion | Reject | Reject | Correct | Cite correct operation |
| Verified successful edit | Accept accurately scoped | Accept | Correct for recorded edit | Do not infer correctness |
| Passed test claim | Matching successful test evidence/scope | Successful command gate, broad scope accepted | Policy gap | Separate focused semantic repair |
| Partial inspection absence | Preserve limited uncertainty | Broad negative prose with valid quote accepted | Policy gap | Separate scope-aware repair |
| Whole-source quote spanning pages | Source-backed if actually supplied | Page-local substring rule may reject | Contract risk, historical cause unknown | Reproduce boundary before repair |

The new 21-case matrix covers exact/paged/wrong/fabricated quotes, historical revision, uncertain inference, partial negative findings, missing/foreign sources, injection text, successful/failed edit/test/build, unrelated build command, plan-only implementation, historical completion, later failed verification and mixed outcomes. Existing C9.1 tests exercise supersession, page segmentation, source authority and normalization. New scripted generation tests check bounded rejection, two linked rejected versions, successful changed correction, no rejected activation, secret redaction, oversize bounds and session cascade/isolation. Existing safe-compaction suites cover valid correction activation, failed activation, guarded fit/overflow, cancellation, deletion and permission changes; runtime tests cover generation exhaustion.

No false-rejection defect explaining the original Qwen incidents is proven. Source-supported acceptance gaps above are not grounds to weaken rejection checks. No semantic validator correction is made. Recommended smallest next investigation: use the new failed field/source/page diagnostics to reproduce one exact incident, then fix only the demonstrated attribution/parsing/phrase issue. In particular test cross-page excerpts and distinguish command scope from whole-project verification before proposing policy changes.

## Safeguards, validation and limits

No changes to P2 discovery/full profiles/specialized activation, T1 24-call limit, T1.1 read batching, tool argument contracts, MCP permissions, execution persistence, C9.3 recovery, model configuration, base system prompt, generation budget or correction count. The 4,999-token summary limit, full-request guard, atomic activation, source identity/version checks, cancellation/deletion/permission guards and no replay remain intact.

Initial focused baseline: 9/9 test files passed. Final focused regression: 14/14 files pass. The final hydration rerun passes both diagnostic and activity suites, including six new tests and the 21-case matrix. Exact results and intermediate failures are in JSON. An introduced empty-diagnostics broadcast mismatch caused the existing W5 “real producer broadcasts actual progress only after durable writes” assertion to fail; avoiding empty diagnostic writes corrected it. No existing test was weakened. Production build passes with the existing chunk-size advisory; whitespace check passes.

All generated responses and tokenizer counts in tests are scripted/synthetic. Estimates remain labeled; no exact real-Qwen tokenizer result or inference was obtained. UI JSX is compiled by the production build; a live Electron visual inspector run was not performed. The 30 requested fixture categories are covered by the new cases plus existing suites, with multi-user authorization and exact historical drafts explicitly unavailable rather than simulated as recovered facts.

For later real-Qwen acceptance, obtain separate authorization, use a disposable profile/project with fixed evidence and existing model settings, replay one failing boundary, inspect bounded stage/field/source diagnostics and correction linkage, retrieve original durable sources privately, and measure the actual Markdown and full request using the matching tokenizer. Require <5,000 summary tokens, guarded fit, atomic activation only for validated candidates, no replay and unchanged P2/T1.1 behavior. Exercise one fitting rejection, one overflow and one valid correction. Record actual model/tokenizer results separately from scripted tests. Do not resume the historical run or mutate its checkpoint history. Work stops at C9.4.
