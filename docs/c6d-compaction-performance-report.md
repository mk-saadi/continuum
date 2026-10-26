# C6-D — Compaction performance

2026-10-26, Asia/Dhaka. **Implemented with controlled verification; real-model acceptance remains unverified.** No live chat or settings were modified, no model was loaded or terminated, and no commit, push, stash, reset or clean was performed. Earlier tracked and untracked work remains in place. Starting status and complete tracked diff were saved in `/tmp/continuum-c6d` before editing. The initial C6-A measurement/structured-output, C6-B selection and generation-runtime baseline passed all four files. C5/C6-A/C6-B/C6-C and W7 reports were inspected alongside production implementations.

## Reported real observation and missing evidence

The supplied observation is 80,586 → 29,184 estimated input tokens, followed by a prepared request of 31,877 / 88,960 usable tokens, configured context 90,000 and verified per-request capacity 90,112. The reduction is approximately 63.8%; the subsequent count is 2,693 tokens larger. **The original serialized bodies, their hashes, measurement methods and stage timings were not supplied.** This repository's C6-C artifacts explicitly describe controlled inference, not that real run. No running llama-server was found in this execution environment.

Consequently the 2,693-token difference cannot honestly be assigned to a particular source. The post-activation boundary request and a subsequent prepared request can differ in retained turns, new outputs, tools, regenerated system sections, task state, sampling and estimation/template treatment. These are possible mechanisms, not measured causes. No comparison below treats those two snapshots as identical. The new diagnostics attach a SHA-256 hash and exact serialized byte count to each measured before/after boundary request, allowing a later real run to settle this question without logging its contents. A scalar regression records the supplied counts and verifies that exceeding the soft target does not request another generation; it does **not** recreate the missing real prompt.

## Changes and context floor

Added `compactionPerformance.requestComposition`: accounts for every serialized JSON byte across fixed instructions, tools, task briefs/constraints, recent turns, protected tool rounds, checkpoint, work log/task state, child state and other JSON overhead. It recognizes bounded brief/checkpoint blocks inside memoryChat's merged system message. Structured checkpoint subcounts expose evidence, task references, plan, pending state, research and requirements separately. Component token counts are UTF-8 bytes/3 estimates, not additive tokenizer counts; nested checkpoint counts use unescaped JSON and must not be added again. The complete request measurement and method remain authoritative. Unknown/legacy embedded sections remain charged to their containing system block; task briefs and persistent constraints are grouped because they may share a verbatim mixed brief. Independent exact tokenizer attribution to each semantic category is unavailable.

Removed only model-facing checkpoint integrity/activation bookkeeping: source version, task-reference digests/provenance label, reduction-source digests and live-run projection. Source coverage was already excluded. Full records remain durable for validation and atomic activation. Brief/message identities, semantic state, evidence observations/outcomes/diagnostics and retrieval instructions remain. Generator reuse also excludes obsolete activation metadata from its prior-checkpoint input. Existing C6-B digest-checked incremental history/evidence selection remains authoritative. No requirement, unknown lifecycle brief, evidence body or protected recent round was removed to hit a number. Work-log deduplication beyond existing bounds was deliberately not attempted: overlap alone does not prove that unresolved details are dispensable.

The full measured actual request now reports a configurable `softTargetTokens` option (default 17,000; preferred band 15,000–17,000), clamped to the actual usable capacity. This is a programmatic compaction option, not a new settings UI. Overshoot is reported as `retained-state-exceeds-soft-target`; it never causes a second generation, truncation or weaker capacity guard. No minimum context size is imposed.

## Identical-request comparison

The fixture runs actual disposable file reads/edits and failing/passing Node commands, with controlled checkpoint generation. At dispatch it captures complete serialized synthetic provider requests. An opt-in renderer probe records old/new renderings of each **same checkpoint**; comparison substitutes only that bookkeeping block inside the identical final request. It does not compare two model runs or changed tool schemas. Temporary captures contain synthetic fixture data only; production diagnostics contain counts/hashes, never raw prompts, outputs, reasoning text or credentials.

| Tools completed | Original rendering estimate | C6-D rendering estimate | Exact JSON bytes saved |
|---:|---:|---:|---:|
| 4 | 11,782 | 11,632 | 449 |
| 6 | 12,101 | 11,942 | 475 |
| 8 | 13,832 | 13,665 | 501 |

These are the production `approximateTokens` full-request estimates. They establish a modest, safe reduction, **not** a demonstrated reduction of the reported real 29K request into the target band.

First final request composition, UTF-8 component estimates:

| Component | Bytes | Estimated tokens |
|---|---:|---:|
| System/developer instructions, excluding extracted state blocks | 9,137 | 3,046 |
| Active tool schemas (four controlled schemas) | 556 | 186 |
| Active task and persistent constraints | 582 | 194 |
| Recent user/assistant text | 165 | 55 |
| Two protected tool rounds | 21,320 | 7,107 |
| Checkpoint including evidence/references | 2,332 | 778 |
| Separate work log/task-state and child sections | 0 | 0 |
| Other JSON overhead | 228 | 76 |

The checkpoint's nested evidence is 973 unescaped JSON bytes (~325 tokens), task references 67 (~23), pending state 102 (~34); these are already included above. Original tool results remain retrievable. Large system instructions/schema costs have separate controlled coverage. The fixture's essential fixed instructions, current requirements and two protected tool rounds already exceed roughly 10K estimated tokens before the checkpoint. The real essential-context floor is unknown without its exact body and tokenizer; neither 17K nor this fixture's floor is universal. Active schemas are counted without weakening discoverability or dropping tools.

## Reasoning integration

Ordinary chat resolves effective session/model intent through `reasoningRuntime.resolveChatReasoning`; Workspace parent inference uses that resolution through memoryChat. Children resolve their own model settings. These paths retain their behavior.

Added `resolveCompactionReasoning`, which never reads normal agent effort/budget settings. It requests off when existing model/provider capabilities support it; otherwise a supported numeric budget starting at 256 (respecting the provider minimum), otherwise the lowest advertised supported effort. Unknown controls remain unsupported/unverified. Existing local/cloud request mappers supply the wire contract; no provider-independent new parameter was invented. Workspace intermediate and final stages use the same dedicated resolution. Casual summary generation uses it too, receiving the loaded model metadata from main. Local W7 `chat_template_kwargs.enable_thinking=false` remains in place.

Template metadata is a capability hint, not proof that the selected backend honors it. Local stream diagnostics flag `disable-request-ignored-or-partial` if reasoning characters arrive despite the disable request. No reasoning text is retained and no inference is repeated for that condition. Absence of reasoning characters is reported `not-verified`, because it cannot establish absence of hidden reasoning. Small-budget fallback and unknown-capability behavior pass controlled tests. Actual Gemma/Qwen backend/template compliance is **not verified**. `max_tokens` retains the existing visible-plus-reasoning reservation; it is not represented as an independent hidden-reasoning cap.

## Timing and generation work

Workspace attempt diagnostics now include candidate input tokens/method, elapsed transport time, visible output estimate, provider completion tokens, provider reasoning tokens when supplied, reasoning character count, first-token time, backend prompt/generation timings and throughput when supplied. Backend timing fields are null when unavailable. Provider completion counts may include reasoning and are labeled separately from visible estimates. End-to-end provider-output throughput includes prefill/transport; backend generation throughput is a separate field. W3 records SQLite transaction duration, post-commit measurement duration, full before/after composition and overall compaction duration. Final validation duration, stage count and correction count are recorded. Intermediate validation remains included in its stage/overall elapsed time rather than separately timed.

Measured controlled coding fixture (milliseconds; **not real-model latency**):

| Cycle | Candidate input estimate | Final request estimate | Overall | SQLite | Post-commit measurement | Final validation |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2,088 | 11,632 | 128.12 | 11.97 | 3.18 | 0.55 |
| 2 | 2,317 | 11,942 | 112.35 | 12.97 | 0.40 | 0.25 |
| 3 | 2,436 | 13,665 | 121.83 | 8.31 | 0.27 | 0.99 |

Each uses one stage and zero corrections. Actual model prefill, first-token latency, hidden reasoning tokens and generation throughput are unavailable for this scripted provider. Controlled SSE tests verify timing capture and ignored-disable detection. There is no evidence supporting a claimed real latency improvement. Removing repeated historical metadata reduces input work modestly; C6-B's unchanged incremental selection provides the substantial repeated-history avoidance.

C6-A deterministic normalization and single bounded correction remain. W7 output exhaustion, complete finish/DONE requirements and output reservations remain. No retry was added for size or ignored reasoning controls. No W2–W7 evidence/activation guarantee was relaxed.

## Verification

Initial focused baseline: four suite files passed. Focused backend regression: 19 suites, with the coding subprocess fixture initially failing inside the sandbox; its authorized outside-sandbox rerun passed. Final reruns cover changed reasoning, Casual, W2/W3/W4, C6-A/B and runtime paths. Seven new C6-D cases pass. The coding fixture passes three atomic activations, same-run continuation, failure/success evidence retrieval, eight unique completed tool IDs and zero replay. Long-horizon parent tests pass, including repeated compaction and stored evidence. Existing W2/W3 tests cover false completion, source validation, cancellation/deletion, rollback and two protected rounds. Tests use disposable profiles/workspaces.

The broader checks reproduce the already documented C6-C nonpassing identities: `workspaceBudgetVerification` concurrent history measurement and `contextC3LiveProtection` status transition expect older error wording; `h1DeletionIpc` pending approval test is cancelled with an unresolved promise. These were not changed or relabeled as passing. No new failure was demonstrated in the focused set. The durable JSON records suite results and final reruns, including the sandbox failure and successful coding rerun.

Production build passes with the existing large-chunk advisory. `git diff --check` passes. No renderer/UI suite or real cloud call was run. Existing reasoning-contract suites pass; actual cloud compliance is limited to those contracts and fixtures.

## Files changed for C6-D

`main.js`, `src/main/casualSummary.js`, `src/main/compactionPerformance.js`, `src/main/reasoningRuntime.js`, `src/main/ipcHandlers.js`, `src/main/taskCheckpoints.js`, `src/main/workspaceCompactCandidate.js`, `src/main/workspaceCompaction.js`, `src/main/workspaceGenerationRuntime.js`, `tests/c6cAcceptance.test.cjs` (opt-in synthetic capture only), `tests/c6dPerformance.test.cjs`, `tests/fixtures/c6dRequestCapture.cjs`, and the two C6-D documents. Other dirty files predate this task.

Reproduce with `node tests/c6dPerformance.test.cjs`, the suite paths in the JSON, and `npm run build`. To capture the synthetic coding requests, set `C6C_EVIDENCE_OUTPUT`, `C6D_REQUEST_CAPTURE` and `C6D_RENDER_CAPTURE` to fresh temporary paths and run `node tests/fixtures/c6dRequestCapture.cjs` in an environment allowed to spawn Node subprocesses. Fresh paths avoid appending to an older capture.

Real-model acceptance remains outstanding: rerun in a disposable profile on an available independent server, collect the exact measured request fingerprints/composition and stage diagnostics, and verify template/backend reasoning behavior. Do not modify live chats or stop a user's model to obtain that evidence. C6-D ends here; no architecture redesign or unrelated feature was implemented.
