# File-Write Verification & Conditional File Reads (Phase 2.0F)

Status: implemented, tested, benchmarked, and stopped for review. No commit or
push was made. Pre-existing working-tree changes (including the in-progress
web-search removal and unrelated settings/docs edits present before this phase)
were preserved untouched.

## 1. Original file-tool behavior

Before this phase, `read_project_file` and `write_project_file` lived in
`src/main/tools/agentTools.js` and had deliberately small contracts:

- `read_project_file` resolved the path through `readablePath` (absolute and
  project-relative reads are allowed; reads may access app attachments and
  temp files by design), rejected non-regular files, rejected NUL-containing
  text as binary, returned images as base64 vision payloads, parsed PDFs to
  text, and truncated text at 20,000 characters with
  `[Output truncated]`. It returned only `{ content }` (or an image payload).
- `write_project_file` required `relative_path` + `content`, captured the
  pre-image through the existing recovery store, wrote through
  `atomicWriteFile` (temp file + rename), and returned only
  `{ success: true, recoveryCheckpointId }`.
- `str_replace_editor`, `edit_project_files`, and `apply_patch` validated all
  matches first and then wrote atomically per file. They did not accept an
  expected content version.
- `delete_project_file` already had a content fingerprint plus an optional
  `expected_hash`, but that guard was scoped to deletion only.
- Permissions, approvals, workspace containment, symlink checks, recovery,
  work-log digests, Git tools, and the read-only child-agent allowlist were
  already in place and are unchanged.

The TaskFlow audit's repeated reads were therefore structurally expected: a
write returned no version evidence, and a read had no conditional form, so the
only way to verify a file after a write was another full-content read.

## 2. Confirmed inefficiencies

The current checkout (not just the historical audit) still had these gaps:

1. A successful write returned no committed hash or byte size, so an agent
   could not prove which bytes were committed.
2. `read_project_file` had no opt-in conditional mode. Any verification read
   retransmitted the whole file, up to the existing 20,000-character bound
   (roughly 19.8k characters for a near-limit file).
3. A write had no expected-version guard, so a stale overwrite was only
   detectable by the agent remembering to re-read first. Deletion was the only
   native tool with an expected-hash check.
4. The write path had no compact change evidence, although the recovery store
   already had a bounded line-diff helper.

No file cache, watcher, database, or memory subsystem was added. All version
state is derived from the file bytes at the moment of the tool call.

## 3. New file-version contract

The authoritative version is SHA-256 over the actual file bytes:

```json
{
  "path": "src/App.jsx",
  "content_hash": "sha256:<64 lowercase hex characters>",
  "size_bytes": 5842
}
```

- Hashing uses raw bytes, never normalized text. CRLF, BOM, UTF-8, and Unicode
  changes all affect the hash.
- The canonical wire form is `sha256:<lowercase hex>`. A bare 64-character hex
  value is accepted on input and normalized.
- `size_bytes` is the byte length (`Buffer.byteLength` semantics), not the
  JavaScript string length.
- Paths inside the workspace are returned relative to the workspace root with
  `/` separators. A requested outside path is echoed as supplied rather than
  rewritten into a new absolute filesystem path.
- File size and modification time are supplementary only; correctness uses
  content bytes.
- No per-file version table or persistent cache was introduced.

## 4. Post-write metadata

A successful `write_project_file` now returns:

```json
{
  "success": true,
  "path": "src/App.jsx",
  "created": false,
  "content_hash": "sha256:...",
  "size_bytes": 5842,
  "verified": true,
  "content_matches_input": true,
  "recoveryCheckpointId": 42
}
```

- `created` is determined from the pre-write `lstat`; it is reliable in the
  ordinary case and is intentionally supplementary under a race.
- After the atomic rename, the committed file is read back through the same
  trusted filesystem path and hashed. The hash is therefore of observed
  committed bytes, not merely the proposed input.
- `content_matches_input` compares the read-back hash with the hash of the
  submitted UTF-8 content. If another process wins immediately after the
  rename, the response can show `content_matches_input: false` instead of
  claiming the submitted bytes are still current.
- If read-back fails or the file disappears, the response is `success: true`
  with `verified: false` and a `verification_error`; it never fabricates a
  hash.
- Error semantics, recovery capture, atomic writes, Git integration, and work
  logging are unchanged.

## 5. Conditional-read behavior

`read_project_file` accepts an optional `if_content_hash`.

### Behavior A — matching hash

```json
{
  "success": true,
  "path": "src/App.jsx",
  "not_modified": true,
  "content_hash": "sha256:...",
  "size_bytes": 5842
}
```

No `content` field is returned. No hidden model-specific cache is consulted;
the current file is read and hashed at call time.

### Behavior B — changed hash

The response includes `not_modified: false`, the current content (subject to
the existing 20,000-character truncation and `[Output truncated]` marker), the
current hash, the current byte size, and `truncated: true` when applicable.

### Behavior C — no conditional argument

Ordinary reads still return the requested current content. The response now
also carries `success`, `path`, `content_hash`, and `size_bytes`; existing
consumers that read `content` or `image_url` are unaffected.

Validation and preserved behavior:

- Malformed, non-string, or `null` hash inputs fail with
  `Invalid if_content_hash: expected sha256:<64 hex characters>.`
- Line ranges are not supported by this tool today, so there is no line-range
  conditional mode to preserve; `start_line`/`end_line` remain absent.
- Image reads are still vision payloads; a matching conditional hash returns
  compact metadata instead of the base64 payload.
- PDFs still parse to text; binary NUL-containing files still fail with
  `Unsupported binary file`, including when the supplied hash matches.
- Workspace boundaries, symlink handling, read permissions, and existing
  not-found errors are unchanged.

## 6. Conditional-write behavior and limitations

`write_project_file` accepts an optional `expected_content_hash`.

- If the current bytes match, the write proceeds through the existing atomic
  temp-file + rename path and the existing recovery capture.
- If they differ, the tool returns a version conflict without modifying the
  file:

```json
{
  "success": false,
  "code": "STALE_FILE",
  "outcome": "version_conflict",
  "path": "src/App.jsx",
  "expected_content_hash": "sha256:...",
  "current_content_hash": "sha256:...",
  "size_bytes": 5842,
  "error": "File changed since it was read; refusing to overwrite ... Re-read the file before retrying."
}
```

- A missing file with an expected hash is also a conflict; creation does not
  silently satisfy an expected existing version.
- The check runs once before recovery capture (avoiding a useless checkpoint)
  and again immediately before the atomic rename (narrowing the race window).
- This is a best-effort stale-write guard, **not** an atomic
  compare-and-swap. Node's filesystem API does not expose a portable atomic
  compare-and-rename. Another writer can still win between the final check and
  the rename. No distributed lock is introduced.
- `expected_content_hash` only guards freshness. It is checked after the
  existing permission/approval guard and never substitutes for authorization.
- `str_replace_editor`, `edit_project_files`, and `apply_patch` do not yet
  accept an expected hash. They keep their existing validate-all-then-write
  and atomic per-file behavior; `write_project_file` was the smallest safe
  place to add the guard.

## 7. Hash/content consistency guarantees

- Reads take one `fs.readFile` byte snapshot and derive both the hash and the
  returned content from that same buffer. A conditional response cannot
  describe a different version than the content it sends or omits.
- Writes stream-hash the current target for the stale check and stream-hash the
  committed target for the response. No full-file copy is retained.
- Read limits and memory behavior are unchanged: the existing read path
  already loaded the file bytes, and hashing adds no second content transfer.
- Large files keep the 20,000-character response bound while the hash still
  covers the full byte content.
- A hash describes the observed version at verification time. It does not
  claim the file will remain stable afterward, and it does not prove the
  content is logically correct. Tests and builds remain necessary.

## 8. Permissions and security

- `read_project_file` remains a READ capability; `write_project_file` remains
  WORKSPACE_WRITE. Approval and visibility decisions are unchanged.
- Workspace writes still use `scopedPath`/`resolveWriteTarget`; lexical
  traversal, absolute escapes, and ancestor symlink escapes are still
  rejected. Reads keep their existing intentionally broader read access.
- Condition hashes are data, not authorization. A matching hash cannot bypass
  a Read Only denial, an approval prompt, or workspace containment.
- Child agents remain read-only and still only receive the existing
  `CHILD_TOOL_NAMES` allowlist, which includes `read_project_file` but not
  `write_project_file`.
- Error and metadata responses contain no file content beyond what the normal
  read/write contract already returned. Version conflicts disclose only hashes
  and byte sizes.

## 9. Recovery compatibility

- Writes still run inside `withFileRecovery`; the pre-image capture, post-state
  recording, automatic rollback on mutation failure, and checkpoint id are
  unchanged.
- A stale-write preflight rejection happens before capture, so it creates no
  misleading checkpoint.
- The optional diff summary reuses `recoveryStore.diffTextLines`; it does not
  add a second diff engine, does not duplicate full file contents, and reports
  `available: false` with `file_too_large`, `binary_file`, or
  `not_a_regular_file` when it cannot produce a bounded summary.
- Deletion, restoration, Git and non-Git recovery, and snapshot retention were
  not changed.

## 10. Concurrent-agent safety

- Two sessions editing the same workspace can observe different versions. A
  write with `expected_content_hash` rejects a stale version instead of
  silently overwriting the other agent's change.
- Rejected writes are not retried automatically; the agent must re-read and
  decide.
- External editors are treated exactly like another workspace agent: the hash
  is computed from the current bytes, not from modification time or a cached
  record.
- The remaining race window is documented above. The implementation does not
  claim stronger guarantees than it provides.

## 11. Files and functions modified

- `src/main/tools/agentTools.js`
  - `read_project_file` / `write_project_file` JSON schemas and descriptions.
  - `atomicWriteFile(target, content, { expectedHash, displayPath })` — optional
    pre-rename stale check, temp cleanup preserved.
  - New helpers: `formatContentHash`, `contentHashOfBytes`,
    `normalizeContentHash`, `currentFileState`, `relativeDisplayPath`,
    `boundedTextForDiff`, `compactDiffSummary`, `staleWriteConflict`.
  - Read handler: one-snapshot hash/content consistency, conditional compact
    responses, image conditional support, metadata on ordinary reads.
  - Write handler: preflight expected-hash check, created/replaced detection,
    committed read-back hash/size, `content_matches_input`, optional bounded
    diff.
  - Error dispatcher: preserves `STALE_FILE` plus current-version evidence.
- `src/main/turnDigest.js`
  - Conditional reads summarize as `verified <path> unchanged` instead of
    implying content was re-read.
- `tests/fileVersion.test.cjs` (new)
  - 20 test cases (some groups cover multiple checklist items) over the real
    dispatcher/permission path.
- `scripts/file-tool-benchmark.cjs` (new)
  - Deterministic efficiency benchmark using the real tools.
- `docs/file-write-conditional-read-report.md` (this report) and
  `docs/file-write-conditional-read-evidence.json`.

## 12. Benchmark results

Command: `node scripts/file-tool-benchmark.cjs`

Environment: Node v22.23.2, temporary SQLite database and workspace, no model,
provider, network, or paid inference call. Character counts are
`JSON.stringify` lengths; token figures are a `chars / 4` approximation, not
billed provider tokens.

Each case runs this cycle: initial read → write → committed metadata →
conditional unchanged read → fixed 180-character test output → external edit →
conditional changed read. "Previous" reconstructs the pre-phase shapes
`{ content }` and `{ success, recoveryCheckpointId }` for the same calls.

| Case | Bytes | Previous write | New write | Write overhead | Previous reread | New unchanged read | Unchanged reduction | Changed read delta | Workflow reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tiny | 8 | 41 | 228 | +187 | 35 | 162 | −362.86% | −162 | −183.33% |
| small | 200 | 41 | 230 | +189 | 213 | 164 | +23.00% | −164 | −50.45% |
| medium | 10,000 | 41 | 232 | +191 | 10,157 | 166 | +98.37% | −167 | +30.88% |
| near read limit | 19,500 | 41 | 242 | +201 | 19,797 | 176 | +99.11% | −176 | +32.01% |
| over read limit | 25,000 | 42 | 243 | +201 | 25,378 | 176 | +99.31% | +4,880 | +41.65% |

Negative deltas mean the new response is larger. This is expected when content
changed (fresh content must still be returned) or when the file is smaller than
the metadata.

Cumulative results:

- All five workflows: **162,908 → 105,686 characters**, **57,222 saved
  (35.13%)**, approximately **40,727 → 26,422 tokens** by the chars/4
  heuristic.
- Ten repeated medium-file edit/verify cycles: **112,971 → 14,359
  characters**, **98,612 saved (87.29%)**, approximately **28,243 → 3,590
  tokens**.
- Write metadata overhead is about 187–201 characters per write (including
  `content_matches_input`).
- The `over read limit` case confirms the existing 20,000-character read bound
  is preserved; the unchanged conditional response is still compact.

These are character reductions, not measured cloud-token savings. Conditional
reads are not assumed to always help; the tiny and small cases show the
opposite.

## 13. Focused test results

- `node --test tests/fileVersion.test.cjs` → **20/20 pass**.
- Focused regression batch (`fileVersion`, `agentTools`, `deleteProjectFile`,
  `gitTools`, five recovery suites, `turnDigest`, two work-log suites,
  `toolPermissions`, `filesystemToolLimits`) → **213 tests, 212 pass, 1 fail**.
  The single failure is the pre-existing `filesystemToolLimits` MCP test that
  calls `initDatabase()`-dependent code without initializing the database; the
  same failure exists in the baseline and is unrelated.
- Relevant Electron UI suites: `fileBrowser`, `toolErrorDetail`,
  `workLogPanel`, `recoveryCard`, and `recoveryDiffReview` all exited 0.
- `git diff --check` on the modified source/test/benchmark files passed.

Coverage includes creation and replacement metadata, SHA-256 and byte-size
correctness, CRLF/Unicode/empty/large files, unconditional and conditional
reads, missing files, malformed hashes, binary restrictions, traversal and
symlink escapes, read/write permissions and approvals, expected-hash success
and rejection, concurrent workspace sessions, external edits, fresh-content
guarantees, recovery checkpoint restoration, Git and non-Git workspaces,
work-log digests, main/child dispatch, and bounded diff summaries.

## 14. Full-suite comparison

Command used on this Node 22 host:

`node --test tests/*.test.cjs tests/*.test.mjs`

The configured `npm test` script (`node --test tests/`) fails before discovery
on this runtime with `Cannot find module .../tests`; that harness limitation
predates this phase.

| Run | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Baseline before edits | 1,381 | 1,354 | 27 | 0 |
| After Phase 2.0F (final sequential run) | 1,401 | 1,374 | 27 | 0 |

The 20-test increase is exactly the new file-version suite. The final
post-change run reproduced the baseline's 27 failing identities exactly (an
extracted sorted diff of failing test names is empty), so no new regression
identities were introduced. Intermediate verification runs showed the known
flakiness of `subagentModelSelection.test.cjs` under load: one sequential run
had 25 failures because two of its baseline failures passed, and a run
performed in parallel with the production build produced two additional
timing-sensitive failures in that same file. The final sequential run returned
to the exact baseline set. The historical Phase 2.0E count
(1,418 / 1,392 / 25 / 1) was treated as reference only; the current checkout
and environment produce the baseline above.

## 15. Production build result

`npm run build` succeeded: 1,819 modules transformed, final run built in
29.49 s (a prior run took 9.47 s; duration varies with host load). The existing
Vite chunk-size warning remains; no build failure or new warning related to
this phase.

## 16. Remaining limitations

1. Conditional writes are best-effort, not atomic compare-and-swap. A
   non-cooperating writer can still win between the final pre-rename check and
   the rename.
2. `expected_content_hash` is implemented only for `write_project_file`.
   Surgical edit tools keep their existing validate-then-write behavior and do
   not yet offer per-file expected hashes.
3. Conditional reads are opt-in by design. Nothing automatically suppresses a
   verification read, and agents can always request full content.
4. Hashes prove observed byte equality, not code correctness, test success, or
   permanent stability.
5. `include_diff` is available only on `write_project_file`. It uses the
   existing prefix/suffix-trimmed recovery diff, bounded to 200 changed lines
   and 200 KB, and deliberately omits line text. It is not a full patch.
6. No line-range read mode exists, so there is no line-range conditional
   behavior.
7. Very large files are still fully read before truncation, exactly as before
   this phase; hashing does not add a second full read, but it also does not
   introduce streaming reads to the tool contract.
8. No new cache, watcher, database, lock, memory subsystem, provider API,
   token accounting, compaction behavior, or hosted infrastructure was added.
   No paid inference requests were made.

Do not begin Phase 2.1 or unrelated improvements; this phase stops for review.
