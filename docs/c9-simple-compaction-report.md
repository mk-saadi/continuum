# C9 — Simple working-summary compaction

Date: 2026-10-28, Asia/Dhaka. Implementation and selected deterministic regression verification are complete. **Live Qwen inference and historical exact-tokenizer certification were not performed.** [Machine-readable evidence](c9-simple-compaction-evidence.json).

## Preservation and review

Initial HEAD was `cd36852ba229fbe445bfe6c50a27dff8ec3449f3`. Initial status contained only the two untracked C8-A artifacts, `docs/c8a-real-session-token-attribution.md` and `.json`; both remain untouched. There were no tracked changes to overwrite. No commit, push, stash, reset, clean, TaskFlow workspace edit, live SQLite access, model configuration change, model restart/unload, permission-policy change, trigger change, tool-schema change, or protected-round change occurred. No subsequent feature phase was started.

Reviewed W2–W7, C6-A/C6-C/C6-D/C6-E, C7, C8 and the C8-A real-session audit, alongside generation, validation, activation, rendering, prompt building, measurement, evidence retrieval and inspection code. Fresh pre-C9 tests ran from a disposable archive of HEAD with shared installed dependencies; no user files were restored. Baseline and final builds pass. All fixture databases/workspaces are disposable.

The existing ownership remains:

- `workspaceCompactCandidate.js`: incremental source selection, bounded generation, completion/schema/source validation, prior finding retention and inactive candidates.
- `workspaceCompaction.js`: owning-loop safe point, two protected tool-call batches, prospective complete-request measurement, atomic activation, postcommit verification/compensation and same-run dispatch.
- `taskCheckpoints.js` / `promptBuilder.js`: current checkpoint projection and injection; rolling summaries remain suppressed when a Workspace working state exists.
- `workspaceEvidence.js`: original message, brief and tool-result retrieval.
- `contextInspection.js`, `ContextPanel.jsx`, `CompactionActivity.jsx`: authorized, redacted inspection and durable activity presentation.

## Representation and durable storage

C8's saved projection was a JSON working-state document containing many structured fields plus a model-facing evidence catalog. C8-A found 18–35 durable evidence records, 12–16 previews of 256 characters, and saved states growing from 10,049 to 13,619 UTF-8 bytes. Their findings barely changed after v11. This was checkpoint presentation growth, not evidence that Qwen generated a 25K–29K summary.

New `compactionSummary.js` derives one Markdown document from validated structured state. It uses Objective, Requirements, Decisions, Progress, Bugs and Blockers, Next Steps and References, omitting empty sections. A short preface identifies observations as untrusted task data without execution authority. It does not append JSON, a ledger, hashes, source coverage counters or empty arrays. References contain at most four useful source identities and the existing retrieval contract.

The model still drafts the existing source-attributed internal JSON. There is **no additional free-form Markdown generation call**. Draft instructions now request concrete behavior, functions, missing tests, useful ranges and uncertainty, rather than activity lists. The Markdown is a deterministic projection of accepted findings, requirements and operation outcomes. No second unconstrained prose model can invent new completion claims after validation.

The existing checkpoint JSON now also stores `summaryFormat: "c9-markdown"`, the exact `savedWorkingState`, and `summaryMeasurement` with count, method, limits, envelope scope and SHA-256. Original messages/tool results, briefs, full evidence, coverage/digests, source bindings, revisions, activation ownership, permission guards and retrieval indexes remain in their existing durable tables/fields. There is no database migration or rewrite of historical checkpoints.

Relevant test commands have recorded outcomes and exit codes; earlier failures remain explicitly historical. Diagnostic examples are labelled examples with complete-result retrieval, rather than full logs. Other command records remain durable. Source findings are attributed conclusions, not a claim of independent semantic verification. Source inspection never establishes the current file revision or authorizes skipping a fresh read before an edit.

## Complete-summary token enforcement

`MAX_COMPACTION_SUMMARY_TOKENS = 4999`; `TARGET_COMPACTION_SUMMARY_TOKENS = 2000`.

The final JSON draft retains C8's bounded output allowance, at most 3,072 visible tokens, and the existing staged-generation resource limits. After source validation and assembly, the service passes the **entire saved Markdown** through the owning measurer, using the same `/apply-template` → `/tokenize` path as context guarding. The probe contains the full system summary, no tool schemas, and an empty user turn to support strict templates. The counted value includes that extra turn and template overhead; it is not merely the drafted prose, a JSON field estimate or the UI's character estimate.

Only `server-template-tokenizer` with a valid integer count at most 4,999 authorizes candidate persistence. The owning loop remeasures the saved document before activation. Prospective and committed requests use that exact immutable saved string and retain existing full-request hash/capacity checks. Summary counts are separate from isolated legacy checkpoint diagnostics and from full continuation counts; their different envelopes must not be added as an exact decomposition.

At 5,000 tokens or above, the existing single final correction slot regenerates the full structured draft under its bounded output contract, revalidates sources, reassembles Markdown and recounts. A second oversized result returns `compaction-summary-budget-exceeded`. No slicing of mandatory prose or token-4,999 truncation occurs. If counting is missing, approximate, invalid or unavailable, the service returns `compaction-summary-tokenizer-unavailable`; no tokenizer-independent bound was invented. Transport cancellation remains cancellation. Failed attempts do not activate or archive history.

The hard limit takes precedence over successful provider stop metadata. Existing checks independently reject output that exceeds the generation allowance, fabricated passing tests and unsupported completion/edit claims. Source validation remains operation-bound and does not prove arbitrary natural-language completeness.

**Compatibility consequence:** providers supplying estimates only, including the current cloud measurer, cannot certify a C9 checkpoint. They fail safely with original history preserved. Cloud serializer/continuation fixtures explicitly inject a synthetic test tokenizer for summary probes; this is not a new production cloud-tokenizer capability.

## Mandatory information and incremental replacement

Current selected briefs remain independently authoritative under C6-E's existing selection and retrieval policy. Requirements retained from prior validated state still match currently selected brief IDs. No blanket historical brief removal was introduced. Separately retained brief overhead is measured/reported separately below and in existing full-request composition diagnostics, with methods labelled honestly.

Previous completed work, decisions, source findings, file operations and evidence remain durable and source-bound. Old pending `inProgress` descriptions are replaced by the current validated draft; pending findings from newly processed intermediate stages are retained. Current blockers/next actions continue to describe current work, while failed original operations remain retrievable and represented as historical diagnostics. Only the latest summary is injected; the previous saved Markdown and its measurement metadata are excluded from generation input.

An earlier diagnostic failure no longer forces a current blocker if the **latest stored execution of the identical command has a successful outcome and exit code zero**. A read or edit is insufficient. This changes pending-state classification, not the failed evidence or the rules for claiming a bug fixed. Unsupported claims still fail the source validator. Older checkpoint versions preserve prior pending descriptions for inspection.

The existing incremental coverage and unchanged-evidence checks still prevent regenerating already covered operations. The original agent loop continues in the same run, with completed tools never replayed. Cancellation, deletion/tombstones, ownership, permission revisions, source changes, protected pairs, transactional rollback and final overflow guards remain active.

## Inspector and event cards

C9 checkpoints open as readable saved Markdown. Evidence and Technical details are closed by default. Evidence reveals existing source references/outcomes; Technical details reveals redacted internal state, source hashes, coverage and token metadata. Raw HTML, external images and links are disabled in summary rendering; tool evidence remains escaped text.

The inspector uses the saved string, never inference. Authorization, deletion checks and secret redaction stay in the existing backend. A redaction flag identifies displayed text differing from the saved string. Historical versions remain reachable. Pre-C9 records show a clear **Legacy structured checkpoint** label and retain their original representation. Inspection performs no promotion, restoration or activation.

Activity cards show runtime before/after complete-request counts, percentage reduction, measured working-summary tokens, version, continuation/failure state and **Inspect summary**. Summary count and method persist in the existing content-free activity metadata. Missing historical summary measurements are not fabricated. Approximate labels remain explicit. Full-request C8 target diagnostics and the 17K soft target remain separate and unchanged.

## TaskFlow comparison using C8-A evidence

Used only the existing private C8-A snapshot, disposable SQLite copy and reconstructed requests under `/tmp/c8a-audit`. The audit runner makes another disposable database copy; it never opens the live database, executes historical tools, calls inference or activates checkpoints. `tests/fixtures/c9TaskflowAudit.cjs` is reusable with `C9_AUDIT_SOURCE_DIR` pointing to those private fixtures; the private data is not included in the repository.

For each v10–v13 boundary, original eligible tool operations are restored only inside the copy. Saved historical draft fields pass through the production candidate/source validator; the original covered results are retrieved page by page and compared with their original result objects. Exactly one old saved checkpoint string is replaced in the existing C8-A reconstructed continuation. All other context is retained.

**All new counts in this table are estimates from the existing UTF-8 estimator, not exact Qwen tokenization.** Historical “after” counts are the real recorded whole-request tokenizer counts. The reconstruction is not an original historical request body.

| Version | Historical exact after | C8 summary estimate | C9 summary estimate | Reconstructed C8 full estimate | Reconstructed C9 full estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| v10 | 24,893 | 3,809 | 867 | 29,208 | 26,266 |
| v11 | 29,017 | 3,926 | 961 | 33,270 | 30,305 |
| v12 | 27,474 | 4,600 | 961 | 32,437 | 28,798 |
| v13 | 28,069 | 5,136 | 1,032 | 32,061 | 27,957 |

Saved UTF-8 bytes change 10,049 → 2,288; 10,426 → 2,563; 12,242 → 2,563; 13,619 → 2,773. All nine requirement entries survive each boundary, along with 2/3/3/3 completed-work entries and 2/3/3/3 research entries. All 18/21/27/35 eligible operations remain durable and every result is retrieved and compared successfully. These boundaries contain successful stored operations; no historical failing tests were invented. Separate real-subprocess C6-C fixtures verify failed and subsequently passing test evidence across three compactions.

The independently retained selected brief block is 4,344 UTF-8 bytes at each reconstructed boundary; its standalone estimated probe including template/message allowance is 1,578 tokens. That is outside the summary limit, explicitly retained for authority. The current user message also remains. This does not imply additive exact attribution: the full-request count remains the dispatch authority.

The historical drafts are generic, so faithfully projecting them cannot invent richer knowledge. A **separate analyst-curated source fixture**, checked against original source snapshots and passed through the production validator, adds three useful findings. Its summaries estimate 1,052 / 1,146 / 1,146 / 1,218 tokens. This demonstrates representational capacity, not Qwen's likelihood of producing those findings or a measured reduction in rereads. We do not pad short tasks to reach 1,500–2,500 tokens.

A sanitized before/after example illustrates those inspected findings without publishing private source content:

```markdown
Before: Inspected taskLogic.js, App.jsx and TaskItem.jsx.

# Working Summary

## Objective
Continue the authorized task-app review.

## Requirements
- Preserve existing changes and metadata. Do not publish.

## Progress
- taskLogic.js: restoreTask rejects invalid input and duplicate IDs,
  then inserts the original task by positionKey; metadata is retained.
- App.jsx: handleDelete saves a pending restore snapshot;
  handleUndo clears it and calls restoreTask. A newer deletion replaces it.
- TaskItem.jsx: saveEdit forwards edited tags and other task metadata.

## Bugs and Blockers
- Component DOM behavior and current file revisions remain unverified.

## Next Steps
1. Inspect the current revision before editing.
2. Verify the remaining behavior and tests.

## References
- Retrieve the original source observations through stored tool evidence.
```

This is a sanitized illustrative excerpt, not a claim that the historical model produced this summary. Cached findings can reduce forgetting of unchanged source behavior; no automatic read suppression or identical-model-behavior claim is made.

## Generation and timing evidence

All four reconstructed historical drafts use one final generation stage with scripted responses; no extra Markdown inference stage exists. Historical activities also recorded one stage each. Exact raw historical drafts, hidden reasoning usage and real compaction inference durations were not retained and cannot be reconstructed.

The matching fresh baseline safe-commit runtime reduces 66,320 → 14,053 estimated full-request tokens. The C9 disposable safe-commit runtime reduces 66,320 → 13,414 **estimated full-request tokens**, with 282 summary tokens under the explicit synthetic test tokenizer, one generation stage and no correction. Its recorded wall time is about 197 ms in this run, dominated by test/runtime work, **not Qwen inference speed**. The summary probe includes an empty user turn; the older isolated checkpoint component probe has a different envelope and must not be substituted for the hard-limit count. Exact measurements and methods are in the evidence JSON.

The TaskFlow continuation remains well above 17K after checkpoint simplification. Fixed instructions, schemas, mandatory briefs and two protected batches still dominate substantial context. C9 makes no 17K guarantee and does not change that policy.

## Regression results and coverage

Fresh enabled baseline: 23 selected suite files, 310/311 counted tests passing, plus the standalone Context panel wiring checks. Final: 24 selected suite files, **335/336 counted tests passing**, plus the standalone wiring checks. The 25 added tests are 21 focused C9 cases and four owning-loop C9 activation/telemetry cases. There are **no new failing test identities**.

The sole unchanged failure is:

`workspaceBudgetVerification.test.cjs :: concurrent history change during measurement invalidates without partial persistence`

It expects `/Session history changed during compression/`; Casual recovery reports “Conversation context changed during Casual recovery (history, attachments or runtime). Retry from saved history.” The original baseline and final run have the same assertion and actual error. Neither the unrelated implementation nor its assertion was changed.

Coverage includes W2–W7 candidate/generation/continuation suites, C6-A/B/C/D/E, C7, C8, H1 deletion, brief selection/budgeting, history retrieval, checkpoint persistence, worklogs and inspection. Complete file identities, inner failure names, counts and logs are in the evidence JSON. The broad unrelated repository suite was not run.

| Requested cases | Principal coverage |
| --- | --- |
| 1–10: format, useful findings, decisions, bugs, errors, constraints, unfinished work | `c9SimpleCompaction`, W2 golden/multi-step fixtures, C6-C coding acceptance |
| 11–20: <2K, near limit, 4,999 accepted, 5,000 rejected, output excess, correction, unavailable tokenizer, Unicode, no truncation | C9 whole-envelope/generation tests, W7 output-overflow tests |
| 21–30: originals, sources, unsupported claims, failed/passing tests, incremental state, requirements, atomic activation | C9 incremental test, W2/W3, C6-B/E, C6-C and source/transaction fault tests |
| 31–40: repeated same-run continuation, cancellation, deletion, permissions, large protected rounds, overflow, brief selection, full sizing | W3/W4, C7, H1, C6-E, C9 owning-loop gate and exact-string composition tests |
| 41–48: Markdown, evidence, collapsed technical state, exact saved content, legacy/history, redaction, inspection without activation | Context panel Electron fixture and W3 persisted inspection/redaction/scoping tests |

Five Electron UI suites pass: Context panel, compaction activity, Work Log panel, C6-A status and context header. New checks exercise Markdown headings, exact saved summary text, closed technical/evidence disclosures, available source evidence, legacy version labels, summary-token cards and the inspection action. Existing redaction and cross-session/deletion protections run through production inspection APIs.

Legacy fixture changes supply a clearly labelled synthetic tokenizer only for summary probes; their existing full-request estimates remain labelled estimates. Tests formerly asserting savings from C8's preview-removal refinement now assert zero additional savings for an already concise immutable C9 summary. The W7 oversized-candidate fixture targets the new complete-summary probe and explicit diagnostic. These are contract/fixture migrations; completion, failure, source and safety assertions were retained.

`npm run build` passes, with the existing >500 kB chunk warning. `git diff --check` passes. Test subprocesses and Electron/Xvfb were run with approved sandbox escalation because process/server restrictions otherwise affect fixtures. The ordinary `node --test tests/` invocation is not supported by this Node environment; selected files were run explicitly, and direct per-file logs retain inner failure identities.

## Limits and real-Qwen validation procedure

C9's code enforces exact-tokenizer verification, but deterministic fixture tokenizers do not certify a historical or live Qwen count. Semantic completeness of arbitrary model prose remains a model-quality limitation; the source validator verifies operation support, identities and known completion categories. Conservatively retained independent findings/requirements can still exhaust 4,999 tokens. The correct outcome is a bounded correction and safe failure, not silent data loss.

For live validation, use a separate disposable profile/database and workspace with an already available matching Qwen backend. Do not change the live TaskFlow workspace, loaded-model configuration or permission settings. Match the historical runtime/template and input/output/safety capacity contract where possible; capture identities rather than assuming model basename equivalence.

Run a scripted source inspection, source-backed edit, failing test, correction and passing test with enough completed output for several compactions. Include two large protected batches and a fixed/schema-heavy case. Capture the exact summary probe payload/count/method, saved Markdown/hash, full prospective/committed/dispatch bodies and counts, generation stages, output/reasoning usage and wall-clock timing. Require an authoritative summary count ≤4,999 before activation. If the tokenizer is unavailable, verify the explicit failure and intact history instead.

Verify active requirements, unresolved failures, concrete source findings, latest passing evidence, preserved originals and retrieval against their sources. Confirm the saved inspector matches the injected document except disclosed secret redaction, older versions do not reactivate, pending work is replaced, the same run continues and every completed tool executes exactly once. Repeat at 4,999/5,000 boundaries using controlled drafts, with cancellation, deletion and permission/runtime invalidation. Record exact real measurements separately from these deterministic and retrospective estimates. Stop after C9.
