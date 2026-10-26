# E1 file editing reliability

## Scope and preservation

Implemented in native `str_replace_editor` and `edit_project_files`. There is no native tool named `edit_file`; the former is the single-file replacement tool. `apply_patch` is the existing separate unified-diff tool. No permission policies, execution, compaction, subagent or MCP authorization code changed. No commits, resets, stashes, cleans or pushes were performed.

Initial worktree modifications were recorded before editing: main.js; MemoryPalace.jsx; TabContext.jsx; compressionEngine.js; engineManager.js; ipcHandlers.js; localEngineFetch.js; promptMeasurement.js; sessionDeletion.js; localProvider.js; preload.js; engineLaunch.test.cjs; and untracked S1 lifecycle source, tests and documentation. Those changes were preserved.

## Pipeline and root cause

Native schemas and implementations live in `src/main/tools/agentTools.js`. Tool execution calls existing permission guards and workspace resolution before dispatch. Single-file replacement uses the resolved target; batches use `resolveWriteTarget`, symlink-aware `scopedPath`, and Git metadata protection. Existing recovery captures before-images before mutation. Writes use temporary files and rename.

Both replacement implementations previously split text into complete lines, removed every carriage return, trimmed each line and required identical line counts and normalized line contents. This already tolerated most indentation differences. It did not tolerate extra blank lines or partial-line search blocks. The duplicated matcher provided generic errors without ranges. Neither replacement path supplied the existing atomic writer's optional hash guard. Neither cached file content across tool calls: every invocation reads fresh disk content. Batches already apply sequential edits to a shared in-memory working copy. Thus the observed formatting failure primarily came from complete-line/blank-line constraints, not a stale file cache.

The patch tool separately parses bounded unified diffs, requires unique exact hunk context, validates all files before writing and uses recovery and atomic per-file rename. Its matching behavior is unchanged; it is deliberately not made fuzzy.

## Strategy order

1. Exact substring matching, including overlapping occurrence detection. Multiple exact occurrences reject immediately.
2. LF/CRLF normalization with original byte-position mapping. Only the selected span changes.
3. Complete-line matching with leading/trailing whitespace ignored, after conservative syntax checks.
4. The same matching with blank lines omitted from comparison. The selected span includes intervening blank lines.
5. Unchanged surrounding lines supplied in `old_str` are ordinary matching context and can disambiguate candidates. No similarity ranking or location hint authorizes a different block.

The first successful strategy must yield exactly one target. Matching never collapses internal spaces. Exact matching avoids constructing line-normalization data. Tolerant replacements use the selected region's line endings and rebase a provably consistent indentation prefix shift. They do not infer indentation units when two-space and four-space nesting differ. Exact replacements are written verbatim and preserve every byte outside the exact substring.

Examples now accepted include an extra blank line between a function header and its body, LF search text against CRLF content, nested JSX with differing indentation, and Python blocks with a consistent indentation shift. The native behavioral fixture succeeds without a read call, followed by sequential edits against its updated content.

## Deliberate rejection and diagnostics

Ambiguous exact or normalized matches reject with `category: ambiguous-match`, attempted strategies, file path, up to five candidate ranges and excerpts capped at 240 characters each, and a request for additional unchanged context. No match returns bounded exact-line anchor excerpts when available. `changed_since_read` is null when no revision is known; it does not falsely claim tracking a prior read.

Whitespace inside strings and regular expressions is never normalized. Tolerant matching conservatively rejects files containing backticks, triple quotes, block comments, escaped line continuations or unbalanced per-line quotes. It also rejects unsupported extensions and potentially meaningful JSX text-node whitespace. Exact matching remains available in those files. This is a conservative textual implementation, not a parser-backed equivalence engine. Some safe edits consequently require exact text or a patch. Internal token-spacing changes are intentionally unsupported.

## Versions, concurrency and write safety

`str_replace_editor` accepts optional `expected_content_hash`, using the reader's existing SHA-256 format. A mismatch rejects before recovery or mutation, even if the text still matches. Existing callers need not supply it. Replacement calls always read current content; there is no new session-wide read revision cache.

Both replacement tools now pass their original content hash to `atomicWriteFile`. It rechecks disk bytes after writing the temporary file and immediately before rename. A single-file stale-write failure bypasses recovery rollback so concurrent content is not overwritten by restoring a before-image. A deterministic injected race confirms this behavior and temporary-file cleanup.

The hash check is best effort, not atomic compare-and-swap: an external process can still write between final check and rename. Multi-file transactions are not globally atomic. On failure, completed replacement writes are restored only if their bytes still match this batch's output; intervening changes are preserved and rollback conflicts are reported with the recovery checkpoint retained. A second deterministic race test verifies that an earlier file is restored and the concurrently changed later file survives. Unified patches retain their existing concurrency behavior.

Replacement input is restricted to regular files up to 2 MiB, valid UTF-8, no NUL bytes, and replacements up to 2 MiB. UTF-8 BOMs are retained. Original path authorization, containment, permission modes, Git metadata checks, recovery capture and atomic per-file writes remain in place. New native tests confirm traversal and symlink escape rejection, binary rejection, failed-edit byte preservation and oversized replacement rejection.

## Changed files

- `src/main/tools/fileEditMatcher.js`: graduated conservative matcher, bounded diagnostics and replacement adaptation.
- `src/main/tools/agentTools.js`: shared integration, optional revision, guarded writes, UTF-8/file limits and compact tool instructions.
- `tests/e1FileEditing.test.cjs`: 22 deterministic matcher checks.
- `tests/e1FileEditingNative.test.cjs`: seven disposable native-tool integration checks.
- `tests/agentTools.test.cjs`: explicitly updated expectations for E1's intended behavior: exact substring boundaries, CRLF preservation, blank-line acceptance and rejection of embedded carriage-return normalization. Tests were not weakened to conceal failures.
- This report and `docs/e1-file-editing-reliability-evidence.json`.

## Verification and failures

Baseline ran before implementation: agentTools and fileVersion passed; filesystemToolLimits and workspaceWritePhase2 failed. Direct execution was also used because the outer Node test runner reports only file-level results in this environment.

Final focused checks: matcher 22/22; native integration 7/7; fileVersion 20/20; agentTools passed. `npm run build` passed with the existing large-chunk advisory. `git diff --check` passed.

Broader checks:

- workspaceWritePhase2: 16/20. Pre-existing failures: `Git real guard: fetch silent, pull once with cached incoming commits, push twice`; `clean switch runs without approval; dirty switch asks and still refuses to discard`; `commit message and staged diff are persisted in the actual IPC tool-call card`; `all six acceptance commands execute in the real sandbox with zero prompts`. All fail with `spawnSync git EPERM`.
- filesystemToolLimits: 3/4. Pre-existing `MCP execution applies the cap before serialization` fails with `Call initDatabase() before accessing the database.`
- recoveryBoundary: 19/20. `15. git index, branches, history untouched by boundaries` fails with `spawnSync git EPERM`.
- sandboxFilesystem: 8 passing, 3 failing, 2 skipped. `workspace socket refuses setup before any process launch` fails with socket `listen EPERM`; `Volta resolver binds actual image and leaves shim/home unmounted` fails because a fixture runtime path is unavailable; `shell metadata mounts follow workspace; native profile stays writable; init is discovered next time` fails with `spawnSync git EPERM`.
- workspaceAutonomy: file-level pass.

The additional boundary suites were first run after implementation, so their failures are not claimed to be proven pre-existing. They fail in unrelated environment setup, not matching assertions. No new failing matching assertion remains after the documented intentional expectation updates. A completely green authorization/boundary run is not established in this restricted environment.

## Fixed-corpus metrics

For eleven positive synthetic fixtures, the previous matcher accepts 10/11 (90.9%) on the first attempt; the new matcher accepts 11/11 (100%). Four use exact matching and seven use tolerant matching. The blank-line fixture previously needed a corrected request; it now needs zero retries. Before-retry execution was not simulated, so only that minimum recovery requirement is reported. Three deliberately ambiguous fixtures reject. There are zero known wrong-location edits and zero changes outside selected spans in this corpus. These are synthetic results, not evidence of a real-world success-rate increase.

## Remaining limitations and acceptance status

Core matching, bounded feedback, version preconditions, single-file race protection and the behavioral regression are implemented. Full E1 acceptance is not claimed: parser-backed normalization, automatic prior-read tracking, patch concurrency strengthening, atomic multi-file transactions, and a green run of every requested suite are not established. Location hints are not added; unchanged textual context remains the disambiguation mechanism. Syntax checks deliberately cause false-negative matches rather than guessing. Work stops at E1 scope.
