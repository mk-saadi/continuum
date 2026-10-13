# Phase 3 — integration and polish

Implemented 2026-10-13 (Asia/Dhaka). Runtime budgets, scheduling, compaction and model/provider selection were preserved. Existing user changes and historical evidence remain in place. No commit, push, reset, stash, model loading or live benchmarking was performed.

## Changed files and behavior

| File | Phase 3 change and rationale |
| --- | --- |
| `src/main/promptBuilder.js` | Parent guidance for bounded assignments, non-overlapping siblings, evidence-first results, partial-result reuse and the serialized local GPU caveat. Both Casual and Workspace use this shared core. |
| `src/main/tools/subagent.js` | Task and expected-output schema descriptions reinforce concrete scope, evidence and unfinished work. Execution contracts remain unchanged. |
| `src/components/SubagentBudgetSettings.jsx` | Explain total requests, reporting reserve, retry/compaction charges and where to inspect usage. Remove misleading source comment claiming providers can never exceed limits. |
| `src/lib/subagentDisplay.mjs` | Small pure formatter for existing accounting and output titles; explicitly distinguishes missing usage, coverage, reservations, effective limits and shared snapshots. |
| `src/components/chat/SubagentTranscriptModal.jsx` | Use formatter; show child tool/request/token limits and consumption, blocked calls and parent aggregate snapshot; label partial findings accurately. Rename attempt count to Executions, distinct from model requests. |
| `tests/subagentDisplay.test.mjs` | Four cases for absent/zero/legacy usage, coverage/reservations, child versus parent limits and result labels. |
| `tests/subagentReliability.test.cjs` | Extend real parent partial-result test to verify findings, stop reason, finalization accounting and display agree. |
| `tests/subagentCompaction.test.cjs` | Extend multi-compaction fixture through a continuation; assert no repeated reads, retained shared scope/request counts and correct display. |
| `docs/subagents.md` | Update current-phase description and document delegation/display semantics, uncertainty and unchanged tuning decisions. Retain detailed runtime and live-validation instructions. |
| `docs/subagent-phase3.md`, `docs/subagent-phase3-evidence.json` | Review handoff and exact validation evidence. |

The UI no longer substitutes measured zero for absent reported token sides. Input coverage stays measured/estimated/mixed/unavailable; output shows measured and reserved quantities separately. Lifecycle status and stop reason remain directly sourced from runtime; display does not reclassify cancellation or failure as success. Returned findings remain visible alongside the typed stop reason.

No correctness defect justified changing 10 investigation tool calls, eight total requests (last reserved for reporting), or the 40 shared tool-call ceiling. Compaction drafts and retry still compete for those existing request/token allowances. These defaults are defensible bounds, not empirically optimal settings. Guidance improves the parent's instructions; deterministic tests cannot prove that a model follows them or that delegation gets faster.

## Validation

Exact broad command: `node --test tests/*.test.cjs tests/*.test.mjs`.

- Fresh pre-edit sandbox run: 130 test-file entries, 105 passed, 25 failed.
- Final sandbox run: 131 entries, 106 passed, 25 failed. Failure names unchanged; the new display file adds one file-level entry in this environment.
- First socket-enabled host run, after initial guidance/display edits: 689 tests, 657 passed, 32 failed.
- Final socket-enabled host run, after integration assertions: 689 tests, 657 passed, 32 failed. All 32 names match Phase 2 historical failures and the first Phase 3 host run; no new or resolved failures.

Caveat: the fresh pre-edit run was sandboxed, not a fresh host baseline. Sandbox socket restrictions cause suites to fail before expanding subtests. Host failure comparison uses historical Phase 2 plus the first Phase 3 host run after initial edits; it is not represented as a pre-edit host measurement. Existing failing names are retained in the evidence JSON. Unrelated failures were not fixed.

Focused command:

```sh
node --test tests/subagentDisplay.test.mjs tests/subagentCompaction.test.cjs tests/subagentReliability.test.cjs tests/subagentBudgets.test.cjs tests/subagentRuntime.test.cjs tests/subagentTranscript.test.cjs tests/subagentStreaming.test.cjs tests/contextCompaction.test.cjs tests/contextOverflowRecovery.test.cjs tests/compressionLifecycle.test.cjs tests/contextDispatch.test.mjs
```

Result: 11 test-file entries passed, zero failed. This checks child continuation, compaction, finalization, aggregate enforcement, cancellation, provider errors, short-task compaction avoidance, shared Workspace compaction and existing chat context dispatch.

Direct commands make case counts explicit:

- `node tests/subagentDisplay.test.mjs`: 4 passed, 0 failed.
- `node tests/subagentCompaction.test.cjs`: 26 passed, 0 failed (existing case extended).
- `node tests/subagentReliability.test.cjs`: 22 passed, 0 failed (existing case extended).
- `npm run build`: passed; existing large-chunk warning.
- `git diff --check`: passed.

Browser interaction was not tested; formatter tests and compilation do not certify the rendered layout. No new live inference evidence was generated or backend availability re-probed. Historical missing runs remain missing.

## Phase 4 handoff for Muse Spark

Start with `docs/subagents.md`, Phase 0 fixed prompts/oracles, and all Phase 1–3 evidence. Load the exact saved Qwen model from Phase 0 in Continuum, then record actual endpoint, `/health`, `/props`, backend build, context window, tokenizer method, child selection and sampling. Do not assume port 8080. Record load/warmup separately and use the same serialized local GPU conditions for comparisons.

Run these acceptance checks, preserving new traces separately from historical artifacts:

1. Inspect Automatic/Custom mode toggling, blank fallback and frozen limits in actual Settings and activity modal; compare UI with persisted accounting. Verify unavailable/mixed/reserved usage and partial/cancelled/failed output labels.
2. Run the small shared-budget fixture documented in `docs/subagents.md` (calls=1, requests=3, aggregate=2): verify per-child and aggregate ceilings, paired skips, partial findings and parent reuse. Include cancellation and actual provider failures; distinguish them from exhaustion.
3. Run the twelve-file long-context fixture in `docs/subagents.md` using its explicit Custom policy and oracle. Require recorded compaction, subsequent progress, retained early/late marker values, raw/active paired history, continued accounting, unchanged files and no completed-tool replay. Confirm oversized essential checkpoint state fails closed.
4. Run the nine fixed Phase 0 tasks with recorded policy. Evaluate the 50-call candidate separately with sufficient independent request/token/aggregate allowances. Measure durations, parent-visible evidence usefulness, duplicate reads and actual provider usage before tuning the 10/8/40 defaults or reporting reserve.
5. Repeat focused deterministic checks and relevant Workspace/Casual checks after any Phase 4 changes. Keep existing 32 failure names separate from regressions. Restore desired user settings after fixtures.

Remaining risks: model adherence to prompt guidance, real summary fidelity and provider token-limit adherence remain unverified. Aggregate display is a settlement snapshot that may lag siblings; live accounting may be unavailable or reflect a previous settlement. Persistence is best-effort and active jobs do not recover after restart. Separate agent-profile instructions, unknown cloud overflow shapes, checkpoint growth and threshold tuning remain inherited limitations. Phase 3 stops here for review.
