# E2 — reliable edits and localized recovery

## Outcome and scope

Implemented candidate-local CSS/JSX matching, precise batch validation, per-operation diagnostics, deterministic patch feedback, guarded patch writes and bounded negative matching memoization. No model inference was run. No commits, pushes, stashes, resets, cleans, permission-policy changes, compaction changes or subagent changes were made. The live conversation database was read only during the earlier audit; all replay databases, projects and files were disposable temporary copies.

The complete initial working-tree status is recorded in `e2-editing-reliability-evidence.json`. Existing tracked and untracked S1, E1, C5–C6, W2–W7, notification and other changes were retained. E2 patches were applied on top of those changes; a Git diff against HEAD also includes preexisting work and must not be attributed entirely to E2.

## Original evidence and reproduction

Session `fd3b2a89-8cce-4745-842a-82457980e2ad`, “DiffReviewModal color change,” contains 94 recorded tool calls: 79 complete and 15 failed. Eleven failures concern editing: four invalid argument shapes, five string target mismatches and two patch-context mismatches. The other failures concern a no-match grep, a diagnostic JavaScript interpolation error, a failing test run and an unavailable NVM path.

All eleven original failed requests were replayed independently against isolated historical source reconstructions. CSS was reconstructed from saved ranged reads of lines 1–1355. JSX used the available saved prefix and lines 440–560; an unavailable intervening range was explicitly marked. These are relevant-source reconstructions, not a full historical checkout or an end-to-end agent replay. Every original failed request still rejects, with no changed file bytes, under both implementations. This is intentional: incorrect arguments, missing declarations and malformed JSX punctuation must not become accepted edits.

Nine additional deterministic native-tool fixtures cover the required failure shapes: 22 edits, missing path, nonadjacent CSS variables, CSS indentation, JSX with an unrelated template, two bad-context patches, nine valid edits plus one invalid edit, and a repeated oversized attempt. Their before/after results and original request replay diagnostics are in the evidence file. `node scripts/e2-editing-replay.cjs` reruns the synthetic corpus without accessing user conversation data. The original implementation was captured before production edits and replayed with a temporary module loader preserving the original module filenames and dependencies.

## Root causes and dispatch audit

The model reconstructed source incorrectly: for example, it assumed `--error` and `--error-soft` were adjacent when `--shadow` intervened. Its JSX patch omitted significant existing declarations and a line-number child. Some requests exceeded the 20-entry schema maximum, omitted `relative_path`, or contained malformed generated text. These are argument/source-assumption failures; E2 does not guess what code they meant.

E1's matcher tried exact text and CRLF normalization, then refused CSS fallback entirely. Its JSX fallback could be disabled by syntax elsewhere in the file. Batch matching returned repeated paths without the failing index. Patch failures lacked actual nearby source. These host limitations made valid formatting differences fail and made genuine mistakes expensive to diagnose.

The native definitions and execution live in `agentTools.js`; the IPC dispatcher validates the advertised authoritative JSON schema before calling them. `toolSchemaValidation.js` now supplies the same compact batch-argument diagnostics at that earlier validation point. IPC preserves those structured native-edit validation details in both its returned tool result and tool card. It does not alter permission decisions or external-tool handling. The existing agent loop receives the native tool result; no automatic retry, source invention or system-prompt expansion was added.

## Changes

### Batch arguments

Maximum 20 remains authoritative. Oversized requests return `EDIT_BATCH_LIMIT_EXCEEDED`, submitted/maximum counts, zero-write status and splitting guidance before file access. Invalid entries identify zero-based `edit_index`, explicitly one-based `edit_number`, the offending field and required fields. Nested malformed values and unsupported entry keys reject. Missing paths are never inferred.

Tool descriptions now emphasize copying small unique `old_str` targets from actual source and correcting the reported operation before resubmitting an atomic batch. The three editing schemas grew from 2,615 to 2,729 UTF-8 serialized bytes: +114 bytes, approximately +28 tokens using bytes/4. This is an estimate, not a provider tokenizer count.

### Matching

Exact substring matching and unique CRLF matching remain first. CSS now supports safe complete-line indentation, tabs/spaces, trailing whitespace, blank lines, and whitespace before the colon in a custom-property declaration. It does not normalize custom-property values. Nonblank intervening declarations and rule boundaries cannot be skipped. Repeated themes remain ambiguous without unique context.

JSX/TSX fallback uses the existing runtime TypeScript parser to inspect sensitive spans overlapping the candidate. Unrelated template literals and block comments no longer disable editing. Meaningful JSX text, multiline strings/templates, comments within the candidate, and missing/reordered children are not normalized away. All normalized candidates are counted before safety filtering, so an unsafe second candidate cannot silently disambiguate a different location. Newly supplied multiline template/comment text is kept verbatim rather than reindented.

CSS quoted values, comments, URLs and escapes within a tolerant target remain exact-only. This is deliberate conservative behavior; exact small replacements remain available. Other language matching retains E1's conservative checks.

### Diagnostics and recovery

Batch failures return size, failing entry, one relative path, existence when known, category, attempted strategies, candidate ranges, bounded nearby source and zero-write status. Excerpts are at most 1,000 characters per nearby region, with at most five 240-character ambiguous-match excerpts. Nearby-source selection is diagnostic only; it never authorizes a replacement.

Patch matching remains unique and exact. Mismatches return file, hunk index/number, expected old header, bounded expected context, actual nearby lines, no-applied-files status and a fresh-read instruction. Ambiguous hunks return candidate ranges without choosing a target. Invalid patch syntax gets a separate argument error.

Correct the failing operation, then resubmit the corrected atomic batch if all its edits are still needed: a failed batch applied none of its valid entries. Alternatively perform one independently intended narrow edit. The host never silently retries or submits a partial batch.

A 32-entry negative matcher cache keys the complete current source bytes, path and search text. Repeated unchanged failures reuse diagnostic computation; different source bytes invalidate the key. Dispatch still authorizes and reads the current file before consulting this pure cache. There is no cached authorization, stale source cache, automatic edit retry or arbitrary candidate selection.

### Safety and transaction outcomes

Contained/symlink-aware paths, Git metadata protections, regular-file/UTF-8/binary/size checks, recovery capture and replacement hash guards remain. Patch modifications now use the same bounded editable-file reader and compare-before-rename guard. Patch creation requires the destination to remain absent. Failed multi-file patch writes roll back only their own unchanged output, preserving intervening external edits.

Write-failure results distinguish written paths, unresolved rollback paths, recovery checkpoint/status and whether any writes occurred. Successful rollback does not falsely claim that zero writes occurred. `net_modifications` is false after a completed rollback and unknown when external changes or rollback conflicts prevent that assertion. Unresolved paths are conservatively reported for review; their current bytes can belong to an external writer.

These are guarded, per-file writes with best-effort rollback, not a filesystem-wide atomic transaction. The compare/rename race window remains. Prior-read revision is explicitly unknown (`null`) unless an explicit supplied hash or a guarded-write conflict provides evidence; E2 does not invent prior-read tracking.

## Measurements

| Nine-fixture corpus | Before | After |
|---|---:|---:|
| Requests | 9 | 9 |
| Successful first attempts | 0 | 2 |
| Invalid-argument rejections | 3 | 3 |
| Target mismatch/unsafe rejection | 4 | 2 |
| Patch mismatches | 2 | 2 |
| Failures with recovery guidance | 4 generic | 7 localized |
| Serialized failure diagnostics | 2,056 bytes | 4,019 bytes |
| Source read calls during requests | 6 | 10 |
| Known wrong-location edits | 0 | 0 |
| Observed atomicity violations | 0 | 0 |

The extra source reads include recovery/post-state verification for the two newly successful writes. Failing operations preserved all fixture bytes. Larger diagnostics are intentional: they include the offending operation and local source instead of requiring broad rereads. The original eleven-request rejection replay has zero newly accepted malformed requests and localized updated feedback for all eleven.

Corrective agent retry counts and unnecessary read counts were not inferred. A separate regression explicitly verifies one failed batch followed by a successful corrected narrow edit. No claim is made that 94 calls, execution time, provider charges or processed tokens would become a particular smaller number. That requires actual agent behavior validation.

## Verification

- E2: 40/40 deterministic native regression checks.
- E1: 22/22 matcher checks and 7/7 native checks.
- Existing `agentTools` test script passes; fileVersion: 20/20.
- Broad comparison: baseline 5 passing/5 failing suite files; updated 6 passing/5 failing, including E2. Individual failing test identities match the fresh original baseline.
- `npm run build` passes, with the existing large-chunk advisory.
- `git diff --check` passes.

Unchanged individual failures:

- filesystemToolLimits: MCP execution cap fixture lacks initialized database.
- recoveryBoundary: Git metadata preservation fixture cannot spawn Git.
- recoveryStore: two Git preservation cases cannot spawn Git; existing mid-batch rollback fixture also fails in baseline because its error-string assertion expects a checkpoint label after an EACCES write failure. Structured checkpoint retention is tested separately.
- sandboxFilesystem: socket permission, unavailable Volta fixture runtime and Git-spawn setup failures.
- workspaceWritePhase2: four Git/sandbox-related cases fail identically before and after.

The evidence records exact failure names rather than hiding these failures. No assertions were weakened. Focused concurrency tests cover replacement races, guarded patch races and rollback conflicts with retained checkpoints; authorization tests cover read-only and symlink boundaries. E1 retains traversal, binary and oversized-input coverage.

## Files changed for E2

- `src/main/tools/editDiagnostics.js`: bounded local evidence and batch argument errors.
- `src/main/tools/fileEditMatcher.js`: candidate-local tolerance and pure negative-result memoization, layered on E1.
- `src/main/tools/agentTools.js`: compact contracts, indexed errors, patch diagnostics and guarded transaction outcomes.
- `src/main/toolSchemaValidation.js`: early native batch validation feedback.
- `src/main/ipcHandlers.js`: preserve structured native-edit schema errors in tool results/cards, layered on existing changes.
- `tests/e2EditingReliability.test.cjs`: disposable native regressions.
- `scripts/e2-editing-replay.cjs`: reproducible nine-fixture corpus.
- This report and `docs/e2-editing-reliability-evidence.json`.

## Real GLM/Qwen validation

Use a disposable workspace with representative CSS themes and a JSX component. Select the intended GLM or Qwen model and ask it to replace a few hardcoded colors with existing variables. Separately request an intentionally stale/nonadjacent edit, an ambiguous theme declaration and a structural patch with missing context. Confirm the model receives indexed/local diagnostics, reads the reported small range, corrects the actual source assumption and verifies the resulting diff. Compare attempted calls, corrective retries, read ranges, costs and elapsed time with a controlled baseline; verify bytes and permissions independently. Do not run this in the live user project or assert a cloud-model improvement from deterministic fixtures alone.

Work stops at E2. Remaining conservative limitations and environment failures are recorded above.
