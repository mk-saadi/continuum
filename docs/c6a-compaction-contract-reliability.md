# C6-A: compaction contract reliability

Implementation and fixture verification, 2026-10-26. No real Gemma or Qwen inference was run; no running llama-server process was available in the execution environment. This report does not certify semantic completeness of arbitrary model prose or real-model acceptance.

## Preservation and baseline

Before edits, `git status --porcelain=v1` and the exact tracked diff were recorded in `/tmp/c6a-baseline/status.txt` and `preexisting.diff`. The full initial file manifest is in the evidence JSON. The tree already contained C5, W7, S1, E1 and notification changes; those were retained. No commits, resets, stashes, live database changes, model unloads, or permission-policy changes were performed. Tests used disposable databases/workspaces and controlled providers.

The initial focused baseline passed all nine test files. To investigate later failures, the tracked pre-change tree was reconstructed under `/tmp/c6a-baseline/original` using HEAD plus the recorded initial diff. Existing untracked fixtures were copied into that disposable tree. Thus comparisons of the C3, Workspace-budget and renderer failures use original tracked production sources, rather than HEAD alone. The untracked Casual implementation was inspected before editing, but was not separately snapshotted before editing; the initial nine-file baseline remains its pre-change execution evidence.

## Pipelines and preserved invariants

Casual: main callback → `summarizeCasual` → exact generation-request measurement → disjoint C5 source stages → completed-envelope check → normalization/schema checks → optional single correction → existing `compressionEngine` prospective measurement and atomic source/version-checked activation. Generation failure never activates a partial memory.

Workspace: owning `memoryChat` boundary → durable current-row flush → `workspaceCompaction` capability → W2 snapshot/evidence → bounded W4 historical stages → final candidate → source validation → W3 prospective request → atomic activation → rebuilt-request comparison → final dispatch validation. The exceptional fallback operates before activation and keeps the entire live tail.

W2 candidates stay inactive; W3 source/owner/permission checks and transaction compensation remain; W4 independently owned operations and completed tool identities remain; W5 activity is observational; W6 runtime capacity remains distinct from configured capacity; W7 reasoning controls, renewable progress watchdog, output headroom, DONE/finish checks, and 32,768-token Workspace reservation ceiling remain. C5 preserves disjoint staged sources and atomic activation. H1 deletion tombstones/cancellation and S1 startup ownership remain in their existing modules.

## Four reproduced failure classes

| Class | Original behavior | Corrected behavior and evidence |
|---|---|---|
| A: imperfect Casual JSON | Direct JSON.parse and exact root-key count rejected fences, BOM, trailing commas and extras; no corrective generation. | Shared deterministic normalization accepts harmless wrappers without inference; documented metadata can be removed; substantive unknown fields and wrong reference types receive one correction. `c6aStructuredOutput` and C5 tests cover rejection and preserved durable history. |
| B: Workspace completion/evidence mismatch | Optional source step IDs in broad prompt guidance, strict successful-step completion validation; intermediate correction omitted completion errors; final feedback was just a code. | Prompt explicitly places failed diagnostics in research/tests, mandates completion step IDs, separates execution from task outcome, and prohibits read-as-implementation evidence. Both stages get bounded category/index/evidence feedback. W2 tests exercise truthful diagnostics, false passing claims, read-as-implementation, intermediate correction and persistent rejection. |
| C: optional compaction abort | Any failed candidate aborted the owning request. | A narrow candidate-failure allowlist permits an uncompressed rebuild and independent exact fit check. The reported 82,169 input / 88,960 usable / 80,064 trigger fixture continues with original pairs and no checkpoint. Oversize, estimated-only measurement, cancellation, deletion, source changes, owner changes and permission invalidation refuse dispatch. |
| D: counting/status | Estimated tokenizer entries had no expiry; unchanged idle attempts stayed deduplicated; owning-request-required rendered as failure. | Estimates expire after one second without sliding expiry on cache reads. Concurrent counts sharing cancellation ownership coalesce; verified counts remain cached. Idle deduplication expires after 30 seconds when another event schedules an attempt. Expected idle deferral clears the failure projection. New renderer fixture covers deferred, failed, recovered and continued states. |

These are controlled reproductions using representative Gemma fences/object fields and Qwen BOM/trailing-comma shapes, not recordings of fresh model inference.

## Structured output and normalization contract

`structuredOutput.normalizeJSON` accepts only a complete JSON document. It removes outer whitespace/BOM, one whole Markdown JSON fence, and trailing commas using a quoted-string/escape-aware scanner. It never extracts a JSON fragment, appends missing braces, invents values, rewrites quoted strings, or uses generic regex JSON repair. Invalid documents remain rejected. Provider completion metadata is checked before normalization; truncated output and incomplete streams cannot be repaired into acceptance.

Casual has six mandatory arrays of nonempty strings: instructions, facts, preferences, decisions, openQuestions, references. Empty individual arrays are allowed, but an entirely empty memory is rejected. Each array is capped at 200 items; serialized memory is capped at 12,000 characters. There are **no optional categories** to default. Object references remain invalid because their intended semantic mapping is not known. Only the explicit extra root metadata `schemaVersion: 1` may be discarded. Unknown substantive fields are not silently dropped. The overflow sentinel fails safely. The generator, exported schema and manual validation use the same field list and bounds.

Disposition diagnostics distinguish unchanged, repaired, corrected and rejected, without including candidate text. Casual gets at most one 1,024-token correction per source stage (16 stages maximum). Correction requests are measured again, require exact counting and unchanged capacity, and carry controlled invalid field names and schema requirements. Truncation is not retried as a schema error. The existing Workspace limit remains two generation attempts per segment/final stage with total output reservations capped at 32,768 tokens.

Local requests send llama.cpp `response_format: {type: 'json_object', schema: ...}` through the actual streaming transport. Casual includes the overflow alternative; Workspace constrains its structural envelope, with nested source validation still authoritative. The installed binary reports build 10899, commit d7680c67b, and exposes JSON-schema/grammar options in `--help`. The [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api) documents this response_format dialect. An explicit HTTP 400 schema/grammar incompatibility permits one prompt-only transport retry before generation, retaining the same output allowance, reasoning control and watchdog. Generic errors, partial streams and successful generated responses do not trigger this transport fallback. Cloud adapters receive no assumed llama schema dialect; their completed envelopes and deterministic validation remain supported.

## Evidence and correction semantics

Durable evidence continues to own tool outcome, command, exit code and path metadata. Execution status now distinguishes executed-successfully, executed-diagnostic-failure, rejected-or-cancelled and execution-unverified. Failed completed commands with recorded exit codes can support diagnostic research. Blocked/cancelled/unverified steps cannot support an assertion that an operation ran. Commands/tests retain recorded outcome fields rather than model-supplied outcomes.

CompletedWork still needs successful referenced evidence. Known verification claims additionally require a successful zero-exit command, and known implementation claims require a successful file-edit operation. Failed cited commands cannot be overridden by an unrelated successful citation for a verification claim. Successful reads support inspection, not implementation. Nonexistent IDs remain invalid. Claims remain labeled semantically unverified; natural-language evidence compatibility is conservative pattern checking, not a proof system.

Completion correction feedback includes controlled category, entry index, claim type, required evidence category, and a bounded list of available source/step IDs with kind/outcome. Reference failures include safe category/index information. No arbitrary tool output or private model reasoning is copied into feedback or logs. Intermediate and final validation use the same rules; failed diagnostics should be moved to research/tests rather than relabeled successful.

## Optional versus mandatory recovery

Only enumerated candidate generation/validation failures qualify for optional continuation, and forced overflow recovery cannot take that path. The fallback rebuilds with `projection=null` and the original paired tail at the same owning capability. It checks the captured source snapshot, run/owner, permission revision, operation identities, cancellation and current configuration both before and after measurement. It requires valid integer counts, server-template-tokenizer measurement, runtime-reported capacity, stable budget identity and a fitting final request. It repeats these checks through `validateDispatch`, and memoryChat adopts the exact rebuilt payload. Completed operations are not replayed.

An estimate, including the reported 82,169 estimate, never authorizes this exceptional dispatch. Oversize requests, unavailable authoritative counting, fatal state errors and forced mandatory recovery still stop safely. Cloud estimated measurements cannot authorize the exceptional fallback. Activity remains checking-fit until the owning loop marks continuation; final validation failure records failure/cancellation instead.

## Measurement and idle status

The existing route remains `/props` → merged-system `/apply-template` → `/tokenize`. Runtime/template/model/payload identity binds a bounded 64-entry cache. Probes share a 2.5-second timeout and caller cancellation. Verified results retain normal cache policy; estimates have a non-sliding one-second expiry. Same-payload concurrent calls coalesce only when they share cancellation ownership. Capacity is still freshly probed; unavailable capacity is never promoted from an estimate to runtime-reported capacity.

Measurement status explicitly reports verified, estimated, temporarily-unavailable or unsupported; unsupported endpoint results remain bounded estimates rather than exact measurements. Casual stage packing performs one delayed 1.1-second retry when exact counting fails, then emits the specific counting/capacity reason. It never generates or activates a summary on estimated-only stage measurements. Existing activation guards are preserved.

Workspace idle returns deferred owning-request-required without generation. The context panel no longer treats this as a failed attempt. Optional continuation has a distinct durable continued status and label. Idle retry suppression now expires; there is no autonomous busy retry loop. Idle exception diagnostics expose controlled reason codes, not raw exception text.

## Verification outcomes

The evidence JSON lists exact commands/files and test identities. Final direct execution of 36 relevant test files: 459 tests, 457 passed, two failures. Both failures reproduced against original tracked sources with the identical error mismatch:

- `contextC3LiveProtection`: status-only transition test expects “Messages changed”; existing C5 code returns casual-source-changed.
- `workspaceBudgetVerification`: concurrent history change test expects “Session history changed during compression”; existing C5 code returns casual-source-changed.

Separate H1 IPC execution passed its first test; the pending tool-approval test was cancelled with an unresolved promise in both sandboxed current/original runs. An unrestricted retry stalled waiting for its mock approval and was stopped. No H1 assertion was weakened. H1 history deletion and both S1 Node suites passed in the 36-file run.

Renderer: new C6-A status fixture, existing compaction activity fixture and S1 startup fixture passed in Electron/Xvfb. The existing ContextPanel fixture fails “no token-savings claims in status” in both original and changed trees. CloudContext fails “Cloud limit missing” in both. A mistaken initial Node-run of CloudContext is not counted as a valid renderer result. The cloud adapter suite passed 20/20 outside the sandbox; its loopback socket was blocked inside the sandbox. Electron required execution outside the sandbox. Compaction activity initially needed its expected `/tmp/continuum-w5` screenshot directory, then passed.

`npm run build` passed (existing large-chunk advisory); `git diff --check` passed. Subsequent focused runs after final evidence-status changes passed W2 55/55, safe-compaction 38/38 and structured-output 17/17; the complete 36-file run was repeated after these source edits. No new regression was established. This is not an assertion that every repository test passes.

## Correction counts and remaining limits

| Case | Before | After |
|---|---|---|
| Casual valid fence | one failed generation, zero corrections | one successful generation, zero corrections |
| Casual wrong required type | one rejected generation, zero corrections | at most two generations, one correction |
| Workspace intermediate unsupported completion | one rejected stage, zero corrections for this class | at most two generations, one targeted correction |
| Workspace final unsupported completion | at most two generations, one generic correction | at most two generations, one targeted correction |
| Explicit schema incompatibility | prompt-only generation | one rejected pre-generation request plus one prompt-only request; no generated output reused |
| Temporary tokenizer failure, unchanged payload | estimate could remain cached indefinitely | bounded estimate reuse, then tokenizer revalidation |

No universal semantic completeness checker was added. Structurally valid arbitrary prose can still omit or misstate information that cannot be detected deterministically; existing Workspace authoritative briefs and complete durable evidence remain separately retained. No source-verifiable requirement or tool ID is synthesized to make validation pass. Real-model factual retention, paraphrased completion claims, grammar/template compatibility and backend grammar-subset behavior require the validation below. Claims of unconditional acceptance-criteria completion would exceed the evidence available here.

## Real Gemma and Qwen validation procedure (not executed)

1. Use a disposable application profile/database and workspace, with a supported Gemma model already loaded or a separate test server; repeat with Qwen. Do not unload the user's existing model. Record binary build, exact model/quantization/template, context/slot settings and whether thinking is disabled.
2. Seed user instructions, preferences, references, contradictory assertions labeled as such, and a critical unresolved finding; force a multistage Casual source set. Confirm the serialized request contains the schema, 1,024-token allowance and enable_thinking=false. Inspect retained memory against every seeded fact/requirement, not just JSON validity.
3. Replay fenced/BOM/trailing-comma/object-reference/truncated responses through the controlled transport; confirm zero wrapper corrections, one structural correction maximum, and no activation after persistent invalid/incomplete output. Temporarily fail `/tokenize`; verify exact-count recovery or specific refusal with unchanged durable history.
4. In a disposable Workspace run, perform an actual file read, a narrow file edit, a failing test command and a passing verification command. Generate both intermediate and final candidates. Verify truthful failures remain diagnostic, nonexistent steps and read-as-implementation fail, and correction references available IDs without private output.
5. At approximately 90–100% input pressure, force an invalid candidate while the independently tokenized original request fits. Confirm exactly one ordinary dispatch, no checkpoint, unchanged completed tool IDs and a continued activity entry. Repeat over budget, during cancellation/deletion, source revision and permission invalidation; confirm no dispatch and preserved history.
6. Record safe counts, finish/DONE status, correction counts, source-fidelity review, generation mode and active checkpoint identity. Keep content-bearing samples only in the disposable test artifacts; promote no real-model success claim until both models pass these checks.

## Exact C6-A files

Production: src/main/structuredOutput.js; src/main/casualSummary.js; src/main/contextBudget.js; src/main/workspaceCompactCandidate.js; src/main/workspaceGenerationRuntime.js; src/main/workspaceCompaction.js; src/main/workspaceCompactionActivity.js; src/main/compressionEngine.js; src/main/ipcHandlers.js; src/lib/memoryChat.mjs; src/lib/compactionActivity.mjs; src/components/ContextPanel.jsx.

Tests: tests/c6aStructuredOutput.test.cjs; tests/c6aMeasurement.test.cjs; tests/c6aCompactionStatus.ui.cjs; tests/workspaceCompactCandidate.test.cjs; tests/workspaceSafeCompaction.test.cjs; tests/workspaceGenerationRuntime.test.cjs.

Deliverables: this report and docs/c6a-compaction-contract-evidence.json. C6-B retention/selection, subagent compaction and unrelated architecture were not redesigned.
