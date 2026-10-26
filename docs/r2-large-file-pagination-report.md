# R2 — Reliable large-file reading and pagination

Date: 2026-10-27. Scope stops at R2. No live conversation, app database, loaded model, commit, push, stash, reset, or clean was used. Tests created disposable databases and files in temporary directories.

## Baseline and audit

The authoritative starting tree contained substantial S1/E1/E2/W/C and notification work. The exact initial `git status --porcelain=v1`, including tracked and untracked paths, is recorded in the evidence JSON. Those changes were retained.

The native implementation is `read_project_file` in `src/main/tools/agentTools.js`. There is no separate native `read_file` or `read_multiple_files`; names appearing elsewhere include external tools and test fixtures. This change extends the existing native tool.

Already implemented: inclusive 1-based ranges, 200-line pages, 400-line maximum, 20,000 source-character maximum, SHA-256 byte revisions, conditional unchanged reads, expected-revision checks, bounded-memory 64 KiB scanning, full-file NUL detection, file-change detection with three bounded snapshot attempts, session/permission dispatch, and JSON result handling. Explicit ranges already retrieved lines 450–520 in one call. R2 does not claim that capability as new.

The default path instead loaded the entire file and returned the first 20,000 characters plus a truncation marker. It supplied no line navigation and could split a line or surrogate pair. Oversized ranged lines returned an error with no way to inspect the line using the native reader. Ordinary pagination lacked `relative_path` and `content_truncated`. Existing readablePath intentionally permitted accessible outside-workspace files, including symlink escapes; this conflicted with R2's explicit containment requirement.

## Contract and implementation

Text calls without ranges now use the same bounded scanner as ranged calls. Defaults are lines 1–200, up to 20,000 UTF-16 source code units, stopping at complete line boundaries. An explicit end may request up to 400 fulfilled lines per call. An omitted end requests 200 lines starting at start_line. No separate count parameter was necessary.

A successful page includes:

- `path` (legacy) and `relative_path`;
- `start_line`, `end_line`, legacy `actual_start_line` / `actual_end_line`, and `total_lines`;
- `has_more`, `next_start_line`, and `content_truncated`;
- `content_hash` (`sha256:<hex>`) and `size_bytes`;
- exact source `content` and an aligned `line_numbers` array.

Line numbers are separate from source text so existing consumers can copy exact indentation, CRLF/LF endings, tabs, Unicode, and final-newline behavior. There is no duplicate numbered source string. `line_numbers[i]` labels source line i in the returned page, excluding a phantom line after the final LF.

`has_more` means source remains after this page, including after an explicitly small requested range. `content_truncated` means a requested range was limited by the line/character budget, rather than simply having more source after the requested range. EOF clipping alone is not truncation. Ordinary default 200-line navigation is not truncation. `next_start_line` is the first undelivered line or null at EOF. Legacy truncation flags remain for capped line pages. Actual coverage never includes an undelivered line.

An empty default read succeeds with empty content, total_lines=0, start_line=end_line=0, no continuation, and no truncation. Explicit ranges on empty files, or starting beyond EOF, retain the existing `LINE_RANGE_OUT_OF_BOUNDS` error contract. Nonempty files without a trailing LF count the final line once.

### Long lines

A normal read never silently returns a partial line. `LINE_TOO_LONG` returns no source and end_line=null, with the line number, output limit, content_truncated=true, next_start_line pointing to that line, and next_char_start=0.

Inspect it using `{relative_path, start_line:N, end_line:N, char_start:0}`. char_start is a zero-based Unicode code-point offset, not a byte or UTF-16 offset. Windows contain at most 20,000 UTF-16 units, never split a surrogate pair, and preserve CR/LF terminators as part of the line. Follow next_char_start on the same single line and revision until it is null. Then next_start_line advances to the following line or null at EOF. `partial_line`, `total_chars`, and `char_start` make partial coverage explicit. A caller-supplied offset at/beyond the line length returns an empty terminal window; valid generated continuations always advance. Invalid offsets or multiline window requests reject.

The UTF-8 StringDecoder handles multibyte characters crossing the 64 KiB read boundary. Only the bounded window is retained, even for multi-megabyte lines.

### Revision consistency and E2

Both source and SHA-256 are calculated from the same observed byte stream. Identity, size, mtime and now ctime are compared across the scan and path checks. Repeated concurrent changes fail with `FILE_CHANGED_DURING_READ`; no fabricated mixed page is returned. A successful scan is an observed version, not a lock preventing later writes.

`expected_content_hash` remains optional. A mismatch returns no content, legacy `code:STALE_FILE`, explicit `reason:FILE_REVISION_CHANGED`, current_content_hash and expected_content_hash. Keeping the existing code preserves edit/read consumers. `if_content_hash` still skips unchanged content and cannot be combined with the expected hash.

The compact schema encourages reading E2's relevant range, copying exact source, making a narrow edit, and refreshing on a revision change. The regression performs a real failed native edit, uses its nearby_source range in one targeted read, then successfully applies a narrow hash-guarded edit. No automatic read or autonomous retry loop was added.

## Security and compatibility

Every page uses ordinary dispatcher permission and session checks, plus an authorization check after scanning before returning source or revisions. Cancellation is checked during scans. Binary files containing NUL anywhere, including beyond the selected range, reject. Text scans have no new file-size rejection: the preexisting text range reader imposed none. A multi-megabyte input test verifies bounded output rather than inventing a new restriction.

`read_project_file` now reuses scopedPath's lexical and symlink containment, followed by readablePath's existing missing-file normalization. Both project-relative and absolute paths inside the canonical workspace work. Traversal, outside absolute paths, and escaping symlinks reject in read_only, workspace_write and full_access. In-workspace symlinks remain readable. Snapshot scanning also rechecks resolved containment. No unauthorized source or revision is returned. Other tools' path policies, permission modes, and git protections were not redesigned.

This is an intentional compatibility restriction: previously permitted outside-workspace reads now fail, including attachments located outside the workspace. Copy authorized attachments into the workspace before reading them. Legacy tests that asserted outside reads succeed were strengthened to assert rejection. Existing in-workspace calls without new arguments retain exact small-file content and hashes, with additional metadata; large defaults are intentionally paginated.

Images and PDFs retain their existing non-line-oriented read formats and range rejection, now subject to workspace containment. PDF truncation remains the legacy document behavior; R2's pagination contract is for source text.

## Internal access, durable result, and context display

Every text page scans all bytes to compute the full-file hash, total lines, and binary check. This uses bounded retained memory but O(file size) I/O per page; it is not seek-only ranged I/O. The scanner does not serialize unrelated file text.

The 20,000-character policy applies to source content, as before; JSON metadata, escaping, and line number arrays add serialization overhead. JSON bytes and source characters are measured separately below. Existing UI formatting and display truncation remain separate from the native result. Native results continue through existing JSON handling; child agentLoop persists raw toolContent separately from trimToolResult's context projection. A context excerpt explicitly marks context_trimmed and original_result_chars; it is not a new source page, and raw coverage metadata describes the durable original result.

One small guard in trimToolResult prevents excerpt metadata from making a projection larger than the original page. No context-compaction algorithm, agent loop, persistence schema, or tool execution architecture changed. Tests check JSON round-trip, metadata preservation through projection, work-log formatting, and existing main/child agent behavior.

## Identical-fixture measurements

Fixture: 2,000 CRLF source lines, tabs, Greek text and emoji, 77,786 bytes. Measurements use the real native dispatcher, instrumenting FileHandle.read/readFile bytes. The pre-edit implementation was retained before edits and loaded in a separate disposable process for comparison. Run `node scripts/r2-reading-metrics.cjs` to reproduce current metrics.

| Measurement | Before | R2 |
| --- | ---: | ---: |
| Selected 450–520 tool calls | 1 | 1 |
| Selected source characters | 2,485 | 2,485 |
| Selected unrelated lines | 0 | 0 |
| Selected internal bytes read | 77,786 | 77,786 |
| Selected serialized result characters | 3,131 | 3,486 |
| Selected serialized UTF-8 bytes | 3,344 | 3,699 |
| Default source characters | 20,019 | 6,784 |
| Default serialized result characters | 23,080 | 8,834 |
| Default unrelated lines relative to 450–520 | 507 | 200 |
| Default next page | absent | 201 |
| Read schema JSON characters | 1,179 | 1,454 |

The old default happened to include all selected lines plus 507 unrelated lines on this fixture. The new default is the first 200 lines; request the selected range directly. Both old and new explicit ranges have correct next-page boundaries and equal hashes. Schema overhead is +275 JSON characters; actual tokenizer overhead and inference-token savings were not measured or claimed. E2 targeted recovery needs one read in both versions when diagnostics already identify a range; R2 improves defaults and makes cap/revision/long-line handling explicit.

## Verification

Initial focused baseline: 7 test files, 6 passed, 1 failed. Existing selective-reading baseline: 2 passed. Expanded comparison baseline: 9 files, 7 passed, 2 failed. Combined baseline: 18 files, 15 passed, 3 failed. Final selected regression run: 19 files, 16 passed, the same 3 failed; the additional R2 file contains 11 passing deterministic groups.

Exact preexisting failure identities, verified before/after:

1. `unifiedToolArchitecture.test.cjs` — “compaction preserves every structural field and validator compiles the complete registry”: assertion expects generic schema error, while existing E2 produces EDIT_ARGUMENT_INVALID.
2. `childAgentLoop.test.cjs` — “spawn_sub_agent with investigate=true runs the loop end to end through the real provider”: listen EPERM on 127.0.0.1 under this sandbox.
3. `filesystemToolLimits.test.cjs` — “MCP execution applies the cap before serialization”: Call initDatabase() before accessing the database.

The final passing-focused rerun confirms all 16 unaffected/new test files pass, including all 11 R2 groups. No new failing identity remains. Tests were not weakened to hide failures. Native read, selective-reading E2E, E1/E2 edit, context budget, permissions, authorization isolation, workspace-generation runtime, argument limit, result formatter, and execution-security suites were included. Full test command and outputs' summaries appear in the evidence JSON. `npm run build` passes (existing large-chunk warning). `git diff --check` passes.

Coverage combines the existing selective-reader suite (basic ranges, invalid values, EOF, binary, mid-scan change, missing files, child dispatch, schema and result formatting) with new exhaustive multi-page reconstruction at 100/1,000/10,000 lines, 71-line targeted reads, byte-preserved mixed text, Unicode windows, cap/EOF distinctions, read/edit/read, targeted E2 recovery, cross-mode containment, revocation after scanning, and multi-megabyte bounded output. Tests use the actual dispatcher rather than duplicating its implementation.

## Files changed by R2

- src/main/tools/agentTools.js
- src/main/subagents/contextRecovery.js (projection non-expansion guard only)
- tests/agentTools.test.cjs (retain prior changes; strengthen read containment assertions)
- tests/selectiveFileReading.test.cjs (new default metadata and containment expectations)
- tests/r2LargeFileReading.test.cjs
- scripts/r2-reading-metrics.cjs
- docs/r2-large-file-pagination-report.md
- docs/r2-large-file-pagination-evidence.json

## Known limits and real-model acceptance

No real model was invoked or loaded. Deterministic dispatch/request tests do not establish model compliance. Hashing/counting scans the full file each page; enormous files therefore remain I/O-expensive. Stat checks detect ordinary concurrent writes, not a transactional filesystem snapshot against a privileged malicious writer. Invalid UTF-8 retains Node's prior replacement-decoding behavior. Line numbers are structured alongside text rather than inline gutters. JSON overhead and downstream context excerpts are distinct from the source cap. Outside-workspace attachment reads intentionally require copying into the workspace. PDF/image behavior is outside source pagination.

To test a real model, create a disposable project with the fixture generated by scripts/r2-reading-metrics.cjs (or equivalent 2,000 numbered lines). Ask the configured model to inspect exactly lines 450–520; verify a single ranged native call, 71 lines, no unrelated text, and end_line=520. Ask it to continue with next_start_line and expected_content_hash. Change the disposable file externally and verify a no-content FILE_REVISION_CHANGED reason followed by a fresh inspection. Trigger an E2 target mismatch and verify one diagnostic range read followed by a small exact edit. Repeat with a >20,000-unit emoji line and inspect char_start continuations. Review durable raw results separately from context excerpts, verify full byte reconstruction, and attempt traversal/symlink escape in each permission mode. Do not use a live conversation/database or modify loaded model settings.
