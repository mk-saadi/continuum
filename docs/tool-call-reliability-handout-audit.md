# Tool-call reliability: “this is a handout”

Investigated November 6, 2026. Workspace: `llm desktop assistant`.
Session: `69194225-bf17-4376-88c6-f23b119bbce6`.

## Findings and evidence

Read the original Continuum SQLite database in read-only mode. The session is
available, including execution steps, reasoning, model identity, generation
metrics and failure-rewind records. Counts agree with the audit: 77 tool calls,
54 complete, 23 errors. The model was `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`.
No live session, model settings, permissions or user roadmap files were changed
by this investigation.

The initial failures were invalid model-generated arguments, but application
error propagation contributed to the poor recovery and unsupported explanation.
It was incorrect to conclude that saving specific errors proved the model
continued to see them.

| Message | Recorded failure | Count | Initial result constructed for the model |
| --- | --- | ---: | --- |
| 5099 | Edit target absent from current source | 1 | `EDIT_TARGET_NOT_FOUND`, no-match explanation, recovery guidance, zero writes |
| 5099 | Read without file identifier | 1 | `INVALID_READ_SOURCE`, choose exactly one of `relative_path` or `attachment_id` |
| 5099 | `edits` was a JSON string | 1 | `EDIT_ARGUMENT_INVALID`, array required, zero writes |
| 5107 | Reads without file identifiers | 9 | `INVALID_READ_SOURCE`, same explicit source requirement |
| 5107 | Identical-call interception | 1 | Explicit repetition warning |
| 5107 | Remaining call skipped after warning | 1 | Explicit not-executed result |
| 5109 | File path only in subagent task text | 1 | Untyped but explicit instruction to supply `url`, `target_file`, or investigation mode |
| 5109 | Plan update without any changes | 7 | `EMPTY_UPDATE`, supply steps, removal IDs, or objective |
| 5109 | Identical-call interception | 1 | Explicit repetition warning |

The current saved failure caps are 10 consecutive and 25 total errors (these
settings are not a historical settings snapshot). The chat loop checks the cap
after settling a batch, so a multi-call batch can overshoot a cap. Those caps
are unchanged; semantic validation interception now prevents the observed
changed-argument retries from reaching the executor.

The file was readable throughout successful earlier calls. A later edit and its
verification succeeded. There is no evidence of a transient file-read outage or
a broken plan tracker in these results.

## What reached the model

There are two different paths:

1. Within a run, `runMemoryChat` formats the executor's output, applies secret
   redaction and the output bound, appends a matching `role: tool` result, then
   sanitizes messages at the completion request boundary. The generic
   `step.error` banner does **not** normally replace this tool result. These
   short validation errors survive that normal path. Calls in one batch finish
   before the model receives the next completion request.
2. Failure recovery and resumed turns can replace those details:
   - `rewindFailedTurnRange` previously removed completed failed call/result
     pairs after a failure streak or strategy switch. Its summary used
     `failedToolReason`, which collapsed these validation errors to
     “A tool call failed.”
   - Persisted work-log digests preferred `step.error` (the generic classified
     banner) over `step.result.error`. A new user turn could therefore show
     generic history instead of the specific saved validation error.
   - The circuit breaker's `failed=true` path also discarded a more informative
     classified reason.

The original database contains three concrete failure-rewind records:

| Record | Message | Removed result pairs | Persisted primary error |
| --- | --- | --- | --- |
| 219 | 5099 | Missing read source; invalid edit array | A tool call failed. |
| 220 | 5107 | Four missing-source reads | A tool call failed. |
| 221 | 5109 | Two empty plan updates | A tool call failed. |

Other failed results could still coexist in active history; these records do
not prove that every detailed error was hidden. In particular, the agent did
receive actionable feedback on some attempts and corrected the subagent call.
Its retry behavior and unsupported diagnosis remain model errors, alongside the
application's loss of diagnostics.

No original HTTP request-body capture was found in the inspected session
records; generation `stats.raw` stores usage/timings, not request messages.
Consequently, the exact historical provider prompt for each individual request
cannot be asserted byte-for-byte. The normal and rewind paths above were
reproduced with captured outgoing request bodies in deterministic tests, rather
than inferred solely from saved execution steps. Evaluating the pre-change
classifier and rewind helper from the repository baseline also reproduced the
generic summary, matching the original saved rewind records.

## Changes

- Added a small allowlist of application-owned validation diagnostics in
  `src/lib/toolValidation.cjs`. Known errors retain their original result and
  code, and gain validation classification, field guidance and a repair action.
  No input values, source excerpts, paths, URLs or arbitrary error text are
  interpolated into new system summaries or banners.
- File-source selection is represented as schema alternatives and explained
  prominently in the read description, including paginated/hashed reads. The
  existing runtime exactly-one-source validation remains authoritative.
- Put the empty-plan-update rule at the beginning of the plan description so
  the compact advertisement's 320-character description bound retains it.
  Added explicit array guidance/examples for edits and clarified that a local
  path in subagent task text does not select a file.
- Missing subagent sources now have a stable `SUBAGENT_TARGET_REQUIRED` code.
  Legacy saved results with the exact old error prefix are also recognized.
- The classifier, failure-rewind summary, circuit-breaker reason, and resumed
  work-log digest retain known validation causes. Rewind summaries preserve up
  to four distinct safe diagnostics, including repair guidance. This changes
  **failure-recovery diagnostics**, not automatic context compaction, thresholds,
  or the failure-rewind trigger/removal behavior.
- The project retry guard records settled validation outcomes. After two
  consecutive matching invalid shapes, another attempt of that shape is
  intercepted even if irrelevant hashes, line ranges or revisions differ.
  The candidate must still be provably invalid: a code alone never blocks a
  corrected request. Distinct work and corrected calls in the same batch remain
  executable. Successful or different outcomes reset the validation streak.
  Existing identical-argument guard behavior and overall failure caps remain.
- Workspace guidance now tells the agent to follow returned codes/fields and
  repair actions, and to distinguish validation rejection from an outage.

Permissions, approval checks, all-or-nothing edit behavior, read bounds, source
hash checks, subagent source selection, and automatic context compaction were
not relaxed or changed. No filename is guessed and no malformed edit string is
silently coerced into a mutation.

## Verification

`tests/toolValidationReliability.test.mjs` adds six focused tests covering:

- Real dispatcher results for missing file identifiers, empty plan updates,
  string edit arrays, and missing subagent targets.
- Model-facing formatting/sanitization and actionable typed feedback.
- File-source alternatives and guidance surviving compact advertisement.
- Repeated underlying validation errors with changed irrelevant arguments,
  corrected requests, and distinct work.
- Wire-level replay through `runMemoryChat`, real validation/dispatch and failure
  rewind: causes survive into the next HTTP body; the third invalid shape is
  blocked; a corrected read, non-empty plan update, edit, and subagent request each succeeds.
  Only child inference is stubbed; the subagent selector/validation is real.
- No-match edit remains zero-write; restored work logs and circuit-breaker
  reasons preserve causes; summaries do not copy sensitive/untrusted error text.

The six tests pass directly. Nineteen relevant test files passed together across
these runs: the new reliability suite; failure rewind; project loop guard;
failure circuit breaker; selective reads; large-file reads; workspace plans;
compact plan results; edit whitespace guards; subagent failure diagnostics;
subagent dispatch concurrency; turn digests; work logs; workspace autonomy;
chat loop; result formatting; native permissions; permission isolation; and
permission policy. Production `npm run build` passes (Vite reports its existing
large-chunk advisory). `git diff --check` passes.

## Limitations

The original model file and llama-server executable are present. A live rerun
of the original model/workflow was not performed: `nvidia-smi` cannot access a
working NVIDIA driver in this execution environment, and approximately 5.8 GB
of available RAM is well below the 12 GB model file, before inference overhead.
Loading it on CPU would risk heavy paging and would not reproduce the original
runtime. Deterministic transport replay verifies application behavior, not the
model's probability of choosing valid calls or giving an accurate explanation.

The new semantic guard intentionally covers the observed, statically provable
argument-shape failures. It does not infer a missing filename, compare arbitrary
edit source content, block unrelated operations merely for sharing a code, or
prevent every possible tool-use loop. Guidance reduces unsupported explanations
but cannot guarantee model compliance. Existing historical rows are not migrated;
work-log rebuilding recognizes known codes from their saved results.
