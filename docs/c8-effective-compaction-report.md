# C8 — Effective compaction and transparent checkpoints

Date: 2026-10-28. Scope: existing Workspace W2–W7/C6-E/C7 pipeline. No live database, model configuration, TaskFlow, normal agent reasoning, permission policy or unrelated execution subsystem was changed. Existing working-tree edits were preserved. Nothing was committed, pushed, stashed, reset or cleaned.

## Evidence boundary

The supplied observations are 33,571 → 28,341 and 32,968 → 27,923, with 34,176 usable input and a 30,758 trigger. Original serialized production requests and the original Qwen tokenizer traces were not supplied. Their exact composition cannot be recovered from these scalar totals. This report does **not** claim that Qwen generated a 28K summary, or that a particular component caused the original real-model result.

Before production edits, disposable fixtures reproduced both scalar reductions with the existing full-request estimator and frozen pre-C8 checkpoint renderer. The portable test fixture is `tests/fixtures/c8CheckpointBefore.cjs`; it preserves that renderer without requiring `/tmp` files. Final fixtures also pass their reconstructed bodies through the production normalized provider guard, including its `/apply-template` and `/tokenize` path. Those endpoints are deterministic test doubles using the existing estimator; they are **not real Qwen tokenization or inference**. Provider-body hashes, byte attribution, methods and component ablations are in the evidence JSON.

## Findings and root causes

Code and disposable measurements establish several mechanisms that can produce weak compaction:

1. The owning loop protects exactly two recent completed tool rounds and everything after them. Large arguments/results in those rounds remain verbatim. A checkpoint does not shrink those costs. This invariant and pairing validation are unchanged.
2. The prior acceptance rule required only a smaller request below the hard limit. It recorded a 17K soft-target overshoot but did not refine it.
3. A successful source-bound finding could be repeated as generated research, an evidence record, its raw observation preview and a duplicate output reference. C8 can replace the successful preview with compact evidence identity/outcome/path metadata when validated research cites that step. Failed, blocked and cancelled evidence and diagnostics remain explicit. Uncited successful observations remain available in the existing projection.
4. `retainPriorState` conservatively unions earlier source-bound state. Distinct valid findings can accumulate; C8 does not silently delete them to satisfy a target. Source validation cannot prove natural-language semantic completeness.
5. Incremental selection previously included covered messages merely because they were not archived. C8 excludes content-digest-verified covered messages independently of archival status. Current briefs remain supplied separately. The in-progress assistant message has no complete message-level coverage; its already represented tool records are deduplicated by source identity/digest.
6. Generation formerly requested up to 6,144 final tokens despite a much smaller prose target. C8 requests at most 3,072 final tokens, measures output externally, rejects a provider exceeding its allowance and permits only the existing one correction attempt. Intermediate stages also check their configured allowance externally. Optional compaction thinking remains disabled when supported, with the existing small-budget fallback.
7. Old checkpoints are selected as a single current working state, not as all historical versions. The newly persisted exact display representation is explicitly excluded from subsequent generation input, avoiding an additional duplicate checkpoint.
8. C6-E's selected current/persistent briefs and required dependencies remain authoritative. Historical briefs already covered by lifecycle/source evidence use its existing selection/retrieval policy. C8 does not blanket-remove them. Worklogs remain bounded and model-facing; their overlap with checkpoint findings is measured and remains a limitation.
9. Zero archived **messages** is valid for mid-run compaction: consumed operations belong to one still-in-progress assistant message, which cannot be archived. Its `projection.consumedToolIds` advances, while original steps stay durable. The inspector now separately reports covered tool operations and durable evidence records.

These are demonstrated mechanisms, not an attribution of every token in the original 28K requests.

## Token measurements

All counts below are deterministic fixture counts, not real-Qwen results. The supplied-pair fixtures retain a deliberately large fixed context to demonstrate why improving a checkpoint alone need not reach 17K.

| Fixture | Before | Pre-C8 continuation | C8 continuation | Overall reduction |
| --- | ---: | ---: | ---: | ---: |
| Calibrated reported pair 1 | 33,571 | 28,341 | 20,961 | 37.6% |
| Calibrated reported pair 2 | 32,968 | 27,923 | 20,543 | 37.7% |
| Target-capable history | 19,519 | — | 12,139 | 37.8% |
| Existing production-path safe-commit fixture | 66,320 | — | 14,053 | 78.8% |

The calibrated fixtures' refined working checkpoint is approximately 3,830 tokens including its isolated request envelope. This is below the 5K soft ceiling; preserved independent findings prevent a guarantee of 2K–3K in every fixture. Their final fixed context plus essential working state exceeds 17K. The target-capable fixture is no longer left above the target.

The safe-commit fixture generates approximately 155 visible-output request tokens under the 3,072 allowance; its rendered working checkpoint is approximately 947 request tokens. Deterministic retained state and generated output are separate measurements. The full continuation is 14,053, with 52,267 tokens saved and 20,910 tokens until its next trigger. Complete current measurements and methods are in `runtime` in the evidence JSON.

An example decomposition from the production rebuild fixture follows. Token ablations overlap and must **not** be summed. They remove one component from a complete request and remeasure it; normalization/template effects remain included.

| Component | Before | After | Why retained after compaction |
| --- | ---: | ---: | --- |
| Base system/developer instructions | 3,023 | 3,023 | Mandatory behavioral/safety instructions |
| Tool schemas | 40 | 40 | Enabled capability contracts |
| Current user instruction | 8 | 8 | Current authority |
| Task brief block | 220 | 226 | Active/persistent constraints and retrieval context |
| Working checkpoint | 0 | 834 | Validated continuation state |
| Protected tool rounds | 9,618 | 9,618 | Two-round protocol safety invariant |
| Older eligible tool rounds | 14,427 | 0 | Findings represented by validated checkpoint; originals durable |
| Raw tool arguments | 45 | 18 | Only protected calls remain verbatim |
| Tool-result content | 23,334 | 9,334 | Protected results stay paired |
| Worklogs / separate plan / attachments | 0 | 0 | Absent in this particular fixture, not assumed absent generally |

Active brief, persistent brief, historical brief and source-navigation ablations are reported separately in the JSON. Byte attribution covers remaining turns and JSON overhead. The schema-dominated fixture remains approximately 20.7K even without significant history. The protected-result fixture also remains approximately 20.8K. Neither authorizes removing instructions or tool pairs.

## Target-driven acceptance and repeated-compaction prevention

The pipeline validates references/requirements, builds the proposed full continuation, measures it and compares it with the target (17K by default, bounded by usable input). If oversized, it performs exactly one deterministic reference refinement. It rebuilds and measures again, accepting the refined representation only if smaller. This adds no target-refinement inference retries.

Diagnostics record before/after counts, saved tokens/percentage, trigger headroom, checkpoint and protected-context measurements, retained non-checkpoint cost, refinement savings, generation stages, elapsed time and target reason. `irreducibleContextTokens` means the measured non-checkpoint context retained under the current safety/selection policy; it is a conservative policy cost, not proof that every worklog sentence is intrinsically irreducible. Full-request checks still decide dispatch.

Already covered same-run tool identities with no newly archivable history return `no-reducible-history` and `unchanged-evidence-already-covered` before generation. Existing source digests and evidence identity checks prevent repeated unchanged evidence stages. The owning loop continues with the reduced tail; completed tools are never replayed. A nonreducing candidate fails closed. Genuine overflow still stops dispatch. There is no guard bypass or unlimited shrinking loop.

The working-state renderer retains objective, requirements, files, successful operations, source-bound research, failed/passing test evidence, unresolved issues, next actions and source IDs. File-read observations now preview the returned `content` field rather than spending the entire preview on JSON metadata preceding the source. Original complete outputs remain retrievable from durable records.

## Persisted content and UI

New activations save the exact model-facing working-state string inside the existing checkpoint JSON. There is no new database structure. Both prospective and committed request representations remain subject to the existing atomic activation/hash and capacity checks.

The existing inspector displays that saved representation as structured expandable fields and an optional raw working-state view. Legacy versions are explicitly labelled as reconstructed. UI descriptions distinguish model-drafted findings, deterministically retained prior constraints, deterministic plan/pending/evidence/retrieval fields and durable integrity metadata. Inspection does not invoke inference, promote or restore a checkpoint.

History lookup accepts a requested checkpoint ID in addition to its bounded recent page, scoped to the same session. This keeps older versions reachable from cards. Existing IPC access checks remain in force; deleted sessions return no display data. Checkpoint strings and source snippets use existing secret redaction. Raw outputs are not automatically loaded. Exact-display status is accompanied by a redaction flag where displayed content differs.

Cards show checkpoint version, complete before/after counts, percentage saved, target/status and generation stages. “Inspect checkpoint” opens the existing Context panel and focuses that version. UI tests cover historical focus and verify the card's session/version event. The card does not change checkpoint activation.

## Verification

25 relevant test files pass across the recorded runs, plus five Electron UI suites. Evidence JSON lists each identity and its log. Covered areas include W2 candidate/source validation, W3 atomic rollback and same-run continuation, W4 operations and repeated compaction, W5 durable telemetry, W6 cancellation/runtime, W7 bounded generation, C6-E selection, C7 request normalization/context header, persistence, H1 deletion, worklogs, checkpoint inspection and redaction.

Focused C8 coverage includes both reported scalar reconstructions, target-capable full provider requests, schema/protected dominance, exact saved-versus-inspected content, historical inspection without activation, unchanged evidence without generation, output overflow despite a successful provider stop, source/permission changes, cancellation, deletion, failed/passing evidence, no completed-tool replay and accurate full-request telemetry.

Commands used include:

```sh
C8_OUTPUT=/tmp/c8-after.json node --test tests/c8EffectiveCompaction.test.cjs tests/c6dPerformance.test.cjs
W3_EVIDENCE_OUTPUT=/tmp/c8-runtime.json node --test --test-name-pattern='W3 commits complete history|deterministic coding loop' tests/workspaceSafeCompaction.test.cjs
node --test --test-timeout=60000 tests/workspaceSafeCompaction.test.cjs tests/workspaceCompactCandidate.test.cjs tests/workspaceAdvancedCompaction.test.cjs tests/c7Reliability.test.cjs
node --test --test-timeout=30000 tests/h1DeletionIpc.test.cjs tests/c6cAcceptance.test.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/contextPanel.ui.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/compactionActivity.ui.cjs
npm run build
git diff --check
```

Build passes, with the existing >500kB chunk warning. Diff whitespace check passes. Electron and actual subprocess tests needed execution outside the process-restricted sandbox; they passed there.

**Remaining baseline failure:** `tests/workspaceBudgetVerification.test.cjs :: concurrent history change during measurement invalidates without partial persistence`. The test expects `/Session history changed during compression/`; unchanged Casual recovery returns code `casual-source-changed` and “Conversation context changed during Casual recovery (history, attachments or runtime). Retry from saved history.” The same failure was reproduced with the frozen pre-C8 checkpoint renderer. This unrelated assertion was left unchanged.

Stale fixture assumptions corrected during verification: C6-C's subprocess inherited `NODE_TEST_CONTEXT` and did not execute its child tests properly; it now clears that variable. H1's pending-approval case requested `full_access`, which does not require the expected approval; the fixture now requests `ask_approval` and closes its MCP client. UI checks now distinguish usage Refresh from compression Refresh, allow existing token labels, and follow C7's prepared-versus-live occupancy policy. Production permission and counter behavior were not changed.

## Limitations and real-Qwen validation procedure

No live Qwen inference was performed. The original request bodies remain unavailable, so the precise cause of those two production 15% reductions remains a measurement question. Tokenizer ablations can add latency; missing component measurements are labelled unavailable, and never replace the complete request guard. Semantic completeness and arbitrary unlabeled-secret detection remain limitations. Retained prior findings and worklogs can still keep valid requests above the preferred range.

For real-model validation, use a separate disposable profile/database and workspace, with an already available Qwen backend; do not modify the live profile, loaded-model configuration or TaskFlow. Match 34,176 usable input, 30,758 trigger and the original output/safety reserves. Run a scripted read/edit/failing-test/passing-test sequence with large completed results, including a case with two very large recent rounds. Capture normalized continuation bodies and the adapter's `server-template-tokenizer` measurements immediately before compaction, proposed refinement, committed rebuild and dispatch. Record generated output usage and externally measured output/checkpoint size separately. Verify all retained constraints, failures, source IDs and retrieval against originals; verify exact saved/inspected content, version focus, consumed operation coverage and no duplicate tool execution. Continue several more rounds to confirm new evidence alone reaches generation. Repeat with schema-heavy context. Compare actual target reasons/headroom and duration; never infer success from estimates alone.

C8 ends here. No subsequent compaction phase or unrelated feature was started.
