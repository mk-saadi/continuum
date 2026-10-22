# Selective File Reading, Bounded Pagination & File-Version Consistency (Phase 2.5A)

Status: implemented, tested, benchmarked, and stopped for review. No commit,
push, stash, reset, or destructive cleanup was performed. Pre-existing
working-tree changes (including unrelated settings, UI, and docs edits present
before this phase) were preserved untouched.

Evidence file: `docs/selective-file-reading-pagination-evidence.json`.

## 1. Objective and scope

Extend the **existing** `read_project_file` tool so an agent can read one bounded
page of a file instead of always retransmitting the whole thing, and so a
multi-page read can be tied to a specific file version. Concretely:

- Selective 1-based inclusive line ranges (`start_line` / `end_line`).
- A bounded default page and a hard page cap.
- The existing 20,000-character output ceiling, with explicit truncation
  metadata.
- SHA-256 file-version consistency so a continuation read either matches the
  version it started from or refuses to mix versions.
- No new file-reading tool and no architecture rewrite.

This phase intentionally stops after Phase 2.5A and does not implement Phase
2.5B or later.

## 2. Constraints and non-goals

- No new read tool: range reads are a new argument set on `read_project_file`.
- The prior Phase 2.0F contract (conditional reads via `if_content_hash`,
  verified writes, expected-hash writes, recovery checkpoints) is unchanged.
- Path-only calls (`{ relative_path }`) must remain byte-for-byte compatible.
- Existing whole-file truncation, conditional reads, permissions, approvals,
  recovery, work-log digests, and the read-only child allowlist are unchanged.
- Range reads reuse the exact same path authorization as the existing reader and
  introduce no new authorization surface.
- No file cache, watcher, database table, persistent version index, or memory
  subsystem was added. All version state is derived from file bytes at call time.
- A range read must never fabricate a mixed-version snapshot.

## 3. Original reader behavior

Before this phase, `read_project_file` in `src/main/tools/agentTools.js`:

- Resolved the path through `readablePath` (project-relative reads resolve from
  the workspace; absolute and outside reads are intentionally allowed because
  reads may target app attachments and temp files).
- Rejected non-regular files and NUL-containing text as binary.
- Returned images as base64 vision payloads and parsed PDFs to text.
- Truncated text at 20,000 characters with a trailing `[Output truncated]`.
- Supported `if_content_hash` for a compact `not_modified` response.
- Returned `{ success, path, content_hash, size_bytes, content }`.

The full-file read path is byte-for-byte unchanged after this phase, including
the 20,000-character bound and its `[Output truncated]` marker.

## 4. Confirmed inefficiencies

1. Any verification or spot check retransmitted the whole file up to the
   20,000-character bound, even when the agent only needed a few lines.
2. There was no way to request a specific region, so an agent inspecting one
   symbol still paid for the entire (bounded) file.
3. There was no bound on how much a single read could return relative to a
   requested region, so there was no pagination contract.
4. A multi-page read had no version gate, so an external edit between pages
   could silently pair one version's hash with another version's lines.

## 5. New range-read contract (arguments)

`read_project_file` now accepts, in addition to `relative_path`:

| Argument | Type | Meaning |
| --- | --- | --- |
| `start_line` | integer ≥ 1 | Optional 1-based first line. Supplying either line argument opts into ranged mode. |
| `end_line` | integer ≥ 1 | Optional 1-based inclusive last line; must be ≥ `start_line`. |
| `if_content_hash` | `sha256:<hex>` | Skip unchanged content: a match returns `not_modified` plus metadata and no content. |
| `expected_content_hash` | `sha256:<hex>` | Version gate for continuation: if the file no longer matches, return a version mismatch instead of content. |

Only `relative_path` is required. `start_line` and `end_line` are clamped to the
range `1 … 1,000,000,000`; non-integers, zero, negatives, and out-of-range values
are rejected before any file I/O.

## 6. Required range semantics

- Supplying either `start_line` or `end_line` enables ranged mode; omitting both
  keeps the legacy whole-file read.
- Missing `start_line` defaults to 1. Missing `end_line` defaults to one page:
  `start_line + 200 - 1`.
- **Default page = 200 lines. Maximum page = 400 lines.** A requested range
  longer than 400 lines is capped at `start_line + 399` and marked truncated with
  `truncation_reason: "page_limit"`.
- The 20,000-character output ceiling still applies inside ranged mode.
- Range reads are rejected for image and PDF targets with
  `LINE_RANGE_UNSUPPORTED`.
- `end_line < start_line` (when both are supplied) is `INVALID_LINE_RANGE`.

Successful ranged responses report both the requested and the actual coverage:

```json
{
  "success": true,
  "path": "src/target.js",
  "content_hash": "sha256:<hex>",
  "size_bytes": 152340,
  "start_line": 800,
  "end_line": 900,
  "actual_start_line": 800,
  "actual_end_line": 900,
  "total_lines": 4000,
  "has_more": true,
  "next_start_line": 901,
  "content": "..."
}
```

`requested_end_line` is added only when an explicit `end_line` differed from the
delivered `actual_end_line`.

## 7. Hash-mode semantics: `if_content_hash` vs `expected_content_hash`

The two hash arguments are deliberately distinct operations, not aliases:

- **`if_content_hash` — "return nothing if unchanged".** On a match the tool
  returns `not_modified: true`, the version metadata, and line coverage, but no
  `content`. On a mismatch it returns the current content and the new hash with
  `not_modified: false`. This preserves the exact Phase 2.0F conditional-read
  behavior, now extended to ranges.
- **`expected_content_hash` — "deliver the range only if the version matches".**
  If the current file hash differs, the tool returns `success: false`,
  `code: "STALE_FILE"`, `outcome: "version_mismatch"`, both the expected and
  current hashes, the current size, the requested coverage, and `total_lines` —
  and **no content**.

Supplying both arguments at once is rejected with
`INVALID_CONTENT_HASH_MODE` before any read. A hash used with an image/PDF target
still follows the existing conditional-read semantics.

## 8. Stability guarantee and mid-read change handling

A range read must not pair one version's hash with another version's bytes.
`readTextRangeOnce` records `dev`, `ino`, `size`, and `mtimeMs` for the path
before opening, for the open file descriptor before scanning, and again for both
the descriptor and the path after scanning. If any identity, size, or mtime
value changes, the scan is discarded.

`readTextRangeStable` retries a bounded **3** times (yielding between attempts so
a competing writer can finish, with no global lock or retained handle). If the
file keeps changing, the tool throws `FILE_CHANGED_DURING_READ` with no content.
The hash and the page bytes are produced from the same stream, so a response can
never describe a different version than the one it returned. This is a bounded
pre/post stat check with retry — **not** an atomic snapshot guarantee (see
§22).

## 9. Path authorization and permission policy parity

Range reads call the same `readablePath` resolver used by the existing reader
and the same `validateAuthorization()` permission gate. Therefore:

- Project-relative paths resolve from the workspace.
- The reader's intentionally broader outside-read behavior is unchanged; no new
  path surface is introduced.
- `read_only` sessions can range-read but still cannot write.
- Authorized child dispatch (`childCall`) uses the identical implementation and
  remains read-only (`write_project_file` is not in `CHILD_TOOL_NAMES`).
- A read never mutates the file: size and `mtimeMs` are identical before and
  after a read.

## 10. Output truncation metadata

Ranged reads never silently drop bytes. When a page is capped or the character
ceiling is hit, the response is explicit:

- `truncated: true` with `truncation_reason: "page_limit"` when the 400-line cap
  applies.
- `truncated: true` with `truncation_reason: "output_limit"` plus
  `overflow_line_number`, `overflow_line_bytes` (and `overflow_line_chars` when
  known) and, when a later line exists, `suggested_next_start_line` when the
  20,000-character ceiling is reached. Only complete lines are included.
- A single line that cannot fit within the ceiling (e.g. a 1 MB line) yields
  `code: "LINE_TOO_LONG"`, `outcome: "line_too_long"`, `line_number`,
  `line_bytes`, `max_output_chars`, and `suggested_next_start_line` — with **no
  content**.

## 11. Error and outcome taxonomy

| Code | Outcome | Meaning |
| --- | --- | --- |
| `INVALID_LINE_RANGE` | — | `start_line`/`end_line` not a positive integer ≤ 1e9, or `end_line < start_line`. |
| `LINE_RANGE_OUT_OF_BOUNDS` | `line_range_out_of_bounds` | `start_line` beyond the last line (including empty files, `total_lines: 0`). |
| `LINE_RANGE_UNSUPPORTED` | — | Line range requested for an image or PDF. |
| `LINE_TOO_LONG` | `line_too_long` | One line exceeds the 20,000-character ceiling; no content returned. |
| `FILE_CHANGED_DURING_READ` | — | The file kept changing across the bounded retries; no snapshot fabricated. |
| `INVALID_CONTENT_HASH_MODE` | — | Both `if_content_hash` and `expected_content_hash` were supplied. |
| `STALE_FILE` | `version_mismatch` | `expected_content_hash` did not match; no content returned. |

## 12. Streaming reader design and memory bounds

`readTextRangeOnce` streams the file in **64 KiB** chunks. It hashes every byte
(the full-file SHA-256 is required) and counts newlines for `total_lines`, but
retains only the requested page — plus at most one bounded oversized-line probe.
Memory is therefore bounded by the chunk plus one page, and the whole file is
never materialized. A single line above `maxChars * 4 + 4` bytes is known to be
unrepresentable and is handled without buffering the whole line.

Honest note: ranged reads still scan the entire file because the full-byte
SHA-256 and `total_lines` are required. The design reduces the bytes *returned to
the model*, not the bytes *read from disk* (§22).

## 13. Work-log digest, activity, and UI compatibility

- `src/main/turnDigest.js` renders ranged reads as
  `read <path> lines <start>–<end> of <total>` (with ` (truncated)` when
  applicable) and never leaks line content into the digest.
- `src/lib/executionEvents.mjs` exposes a `Lines` activity field (`820–900`) for
  ranged read calls.
- `src/components/chat/ToolEventCard.jsx` shows the actual line coverage and an
  explicit truncation marker for ranged reads.
- Child context recovery (`trimToolResult`) still produces a bounded projection
  that includes the path and stays smaller than the raw result.

## 14. Child-agent isolation and context recovery

`read_project_file` remains in `CHILD_TOOL_NAMES`; `write_project_file` does not.
Authorized child dispatch reaches the same dispatcher and returns the same
range metadata, while a child write attempt is refused and leaves the file
unchanged. Child context recovery still bounds the projection.

## 15. Files and functions modified

- `src/main/tools/agentTools.js` — main implementation: schema/description
  updates, `resolveReadRange`, `parseOptionalReadLine`, `readTextRangeOnce`,
  `readTextRangeStable`, `versionMismatchResult`, `typedReadError`, and the
  `read_project_file` dispatcher branch; new `READ_DEFAULT_PAGE_LINES`,
  `READ_MAX_PAGE_LINES`, `READ_MAX_OUTPUT_CHARS`, `READ_MAX_LINE_NUMBER`.
- `src/main/turnDigest.js` — ranged-read digest wording.
- `src/lib/executionEvents.mjs` — `Lines` activity argument field.
- `src/components/chat/ToolEventCard.jsx` — range/truncation display.
- `tests/selectiveFileReading.test.cjs` — new focused suite.
- `tests/selectiveFileReading.e2e.test.cjs` — new real agent-loop test.
- `tests/fileVersion.test.cjs` — updated a stale schema assertion for the new
  range arguments.
- `scripts/selective-file-reading-benchmark.cjs` — disposable-fixture benchmark.
- `docs/selective-file-reading-pagination-evidence.json` — measured evidence.
- `docs/selective-file-reading-pagination-report.md` — this report.

## 16. Focused test results

`tests/selectiveFileReading.test.cjs` groups 45 numbered checks into six tests,
all passing against the real `executeAgentTool` dispatcher with disposable
temporary fixtures:

1. **1–7. Schema, compatibility, defaults, page cap, and existing limits.**
   `relative_path` remains the only required argument; range args exist with
   `minimum: 1`; whole-file and conditional reads are unchanged; default page is
   200; the 400-line cap marks `page_limit` with `next_start_line: 401`.
2. **8–20. Line accuracy, EOF, line endings, blank lines, Unicode, invalid
   input.** First/middle/last lines, missing final newline, CRLF, blank lines,
   Unicode, EOF clamping, out-of-bounds start, empty files, and eight invalid
   input shapes (`INVALID_LINE_RANGE`).
3. **21–27. Version-aware continuation, mismatch, conditional reads, concurrency,
   mid-read changes.** One hash across pages, compact conditional range reads,
   12 concurrent readers with no shared state, `STALE_FILE` version mismatch with
   no content, fresh content on a changed conditional read, and a deterministic
   mid-read mutation forced on every attempt → `FILE_CHANGED_DURING_READ` with
   ≥ 3 opens and no content.
4. **28–34. Path policy, permissions, child isolation, no write side effects.**
   Same `readablePath` behavior, `read_only` can read but not write, child reads
   work and child writes are refused, and a read leaves size/`mtimeMs` unchanged.
5. **35–41. Main-agent schema, work log, activity fields, compaction.**
   Exposed model schema includes the new args; digest reads
   `read agent.js lines 820–900 of 900` without content; the `Lines` activity
   field is `820–900`; child projection stays bounded; LSP `line` stays 1-based.
6. **42–45. Large-file bounds, output reduction, latency, descriptor cleanup.**
   A 100-line range is smaller than the full read and under 20,000 chars; a
   50,000-line range returns 200 lines under 20,000 chars; heap growth < 50 MB;
   40 sequential ranged reads leak ≤ 2 descriptors (Linux `/proc/self/fd`).

Combined focused run (`fileVersion` + `selectiveFileReading` + E2E):
**27/27 passing**.

## 17. End-to-end agent-loop test

`tests/selectiveFileReading.e2e.test.cjs` drives the **real** agent loop
(`runMemoryChat`), tool schema, permission guard, dispatcher, result formatting,
steering injection, and context recovery. Only the model transport is a
deterministic stub; no inference provider is contacted.

The scenario is a realistic loop over a 4,000-line file where line 820 contains
`targetFunction`:

1. `search_project_content` finds `targetFunction` at line 820.
2. The model range-reads lines 800–900 and receives `has_more: true`,
   `next_start_line: 901`, and the file hash.
3. It continues lines 901–1000 with `expected_content_hash` set to the first
   hash and succeeds.
4. An external append then changes the file; a third continuation with the
   original hash returns `STALE_FILE` / `version_mismatch` with no content.
5. The model refreshes using the mismatch's `current_content_hash` and receives
   the correct lines.
6. The run finishes.

Assertions confirm exactly six deterministic model requests, one tool call per
round in order, search→read line association, the correct hash/coverage on every
page, no content on the mismatch, exactly-once steering delivery present in a
real request body, no unrelated file mutation, no write to `target.js`, and a
digest that reports `read src/target.js lines 800–900 of 4000` without leaking
source. Result: **1/1 passing** (TAP `# pass 1`, `# fail 0`).

## 18. Benchmark methodology

`scripts/selective-file-reading-benchmark.cjs` builds disposable temporary
fixtures, calls the real native dispatcher (no provider/inference call), and
records:

- Full-read vs range-read JSON character counts and latency.
- Estimated tokens as `JSON characters / 4` (an estimate, not billed tokens).
- Event-loop responsiveness via a timer probe (`max_timer_delay_ms`).
- Process high-water `maxRSS` delta in KiB.

Fixtures: `small_100` (100 lines), `medium_4000` (4,000 lines), `large_50000`
(50,000 lines), and `very_long_line` (one ~1 MB line).

## 19. Benchmark results

Measured on Node v22.23.2 / linux x64 (8 CPUs), recorded in
`docs/selective-file-reading-pagination-evidence.json`:

| Fixture | Full read (chars) | Range read (chars) | Reduction |
| --- | --- | --- | --- |
| `small_100` (100 lines) | 2,942 | 1,747 (lines 50–100) | 40.62% |
| `medium_4000` (4,000 lines) | 20,896 (truncated) | 3,502 (100 lines) | **83.24%** |
| `large_50000` (50,000 lines) | 20,897 (truncated) | 7,109 (200 lines) | 65.98% |
| `very_long_line` (~1 MB line) | 20,203 (truncated) | 506 (`LINE_TOO_LONG`) | 97.50% |

- Estimated tokens, medium fixture: whole file ≈ 5,224 vs 100-line range ≈ 876.
- Latency: large range read ≈ 22 ms end-to-end at the dispatcher.
- Responsiveness: large range read `max_timer_delay_ms` ≈ 0.7 ms; large full read
  ≈ 0 ms — the event loop stays responsive.
- Memory: `maxRSS` delta ≈ 128 KiB across the memory probe.
- Native `read_project_file` schema: 1,148 characters (1,043 before this phase;
  the three new optional arguments add 105 characters after tightening the
  descriptions). The schema is intentionally terse because it is part of every
  request's prompt; see §22 on prompt-size sensitivity.

## 20. Full-suite comparison vs baseline

Baseline (before this phase) full suite via
`node --test tests/*.test.cjs tests/*.test.mjs`:
**1,632 tests, 1,617 pass, 14 fail, 1 skipped.**

Baseline failing identities (14), all pre-existing and unrelated to this phase:
`attachments`, `backgroundCommands:49`, `cloudIpc:22`, `engineSettings`,
`filesystemToolLimits:45`, `lspCodeIntelligence:200`, `mcpIpc:22`, `mcpIpc:273`,
`messageActions`, `messageStats`, `rag`, `skillImportIpc`, `skillProposalIpc`,
`subAgentRunner`.

Final full-suite run after this phase (run alone, nothing concurrent):

**1,639 tests, 1,626 pass, 12 fail, 1 skipped** (`/tmp/opencode/final-full2.txt`).

The test count grew by exactly the 7 new tests (6 focused + 1 end-to-end), and
the failure count dropped from 14 to 12. The 12 final failing identities are a
strict subset of the 14 baseline failures; nothing new fails:

`attachments`, `cloudIpc:22`, `engineSettings`, `filesystemToolLimits:45`,
`mcpIpc:22`, `mcpIpc:273`, `messageActions`, `messageStats`, `rag`,
`skillImportIpc`, `skillProposalIpc`, `subAgentRunner`.

Two baseline failures are absent from the final run:
`backgroundCommands:49` ("real dispatcher returns promptly…") and
`lspCodeIntelligence:200` ("stale source during request…"). Both are
timing-sensitive integration tests and both pass in the final run, so the
remaining 12 failures are all pre-existing, unrelated to this phase, and no
worse than baseline.

One important near-miss worth recording: an earlier full-suite attempt that ran
concurrently with the production build, plus a schema that was ~1.1 KB larger,
caused 6 child-context-budget tests to fail (`subagentCompaction` ×4,
`subagentModelSelection` ×3, `subagentTranscript` ×1, overlap across files).
Reproducing that state and probing with pure description padding on an otherwise
unmodified baseline proved the failures were purely prompt-size artifacts —
every sized probe that crossed a context-pressure threshold reproduced them, and
padding with meaningless filler was as damaging as real documentation. The
descriptions were tightened (schema +105 characters) and the failures
disappeared both in isolation (61/61) and in the clean full suite.

## 21. Production build result

`npm run build` completed successfully (`✓ built in ~8.2s`), producing the
renderer bundles (`dist/assets/index-*.js`, `all-*.js`, CSS, and fonts) with only
the pre-existing chunk-size advisory. No build error was introduced by this
phase.

## 22. Honesty, limitations, and remaining gaps

- **Range reads still read the whole file.** The full-byte SHA-256 and
  `total_lines` metadata require scanning every byte; the reader streams in
  64 KiB chunks and retains only the requested page. The benefit is fewer bytes
  returned to the model, not fewer bytes read from disk.
- **No atomic snapshot.** Stability is a bounded pre/post `stat` check with up
  to 3 retries, not a filesystem-level snapshot. A file that keeps changing is
  reported as `FILE_CHANGED_DURING_READ` rather than silently mixed.
- **Token figures are estimates** (`JSON chars / 4`), not provider-billed tokens.
- **No claim** that pagination improves model reasoning quality.
- **Tool schemas are part of every prompt.** Adding three optional arguments
  grows the `read_project_file` definition by 105 characters. Several
  pre-existing subagent tests sit exactly on a context-pressure threshold, so
  the descriptions were kept deliberately terse to avoid shifting child-budget
  decisions. A larger description (tested at +1,120 characters) reproducibly
  changed those child outcomes; the shipped schema does not. This is a prompt
  budget constraint, not a functional limit.
- The reader retains its intentionally broader path policy; range reads add no
  new authorization surface but also do not tighten the existing one.
- Phase 2.5A is a stopping point; later phases are not implemented here.

## 23. Verification summary and stop point

- Focused range/version tests: **27/27 pass** (`selectiveFileReading` +
  `selectiveFileReading.e2e` + `fileVersion`).
- Focused regression set (agent tools, permissions, child loop, compaction,
  recovery, LSP, steering, digest, work-log): **156/156 pass**.
- End-to-end real agent-loop test: **1/1 pass**.
- Benchmark: medium-file range read reduces returned characters by **83.24%**
  (20,896 → 3,502) while staying responsive (large-range timer delay ≈ 0.7 ms).
- Production build: **pass** (`✓ built in ~8.2s`).
- Full suite: **1,639 tests, 1,626 pass, 12 fail, 1 skipped** — all 12 failures
  are pre-existing baseline identities; no new failures (§20).
- Work stopped after Phase 2.5A. No commit, push, stash, reset, or destructive
  cleanup was performed; pre-existing working-tree changes were preserved.
