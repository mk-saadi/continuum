# R3 — File revision, attachment and LSP reliability

## Result and scope

R3 is implemented. Trusted native file revisions survive model formatting, ordinary reads remain simple, user attachments have session-owned read references in every permission mode, and LSP failures carry useful lifecycle diagnostics. The production build and whitespace check pass.

The final new regression suite passes **25/25**. The matched broad offline comparison found **no failure identities unique to R3**. The repository is not fully green: the broad verification run had 35 failures already represented in the baseline. Counts, failure identities, source digests and the mapping to the 45 requested checks are in `r3-file-attachment-lsp-reliability-evidence.json`.

Existing tracked and untracked UI, editing, batching, and compaction work was preserved. R3 did not change compaction implementations, T1/T1.1 policy, edit matching algorithms, command sandbox mounts, model settings, or dependencies. No commit, push, stash, reset, or clean was performed. Historical conversation databases were opened only through SQLite read-only URIs; implementation tests used disposable databases.

## Historical session and verified classification

- Workspace: **llm desktop assistant**, `/home/mk_saadi/projects/persona-projects/llm-electron`.
- Session: **Hello - glm**, `9c7e863a-27ae-480b-959f-6bafe6a523f3`.
- Stored model: `cloud:1737e141-7c59-451b-b9cd-0659dafd863a:z-ai/glm-5.3-flash`.
- Coding request: October 30, 2026, **18:00:04 Asia/Dhaka** (`12:00:04 UTC`).
- Evidence: assistant message 4129, original ordered `execution_steps`.

There were exactly **36 tool calls, 11 failures**:

| Call ordinals | Failures | Classification |
|---|---:|---|
| 1–2 | 2 | Tried reading/copying the internal screenshot path; workspace containment rejected the read and the command sandbox could not see app storage. |
| 3 | 1 | `lsp_workspace_symbols`, query `ModelSelectorModal`, returned generic `LSP_SERVER_UNAVAILABLE`. |
| 14, 16, 18, 20, 23 | 5 | `read_project_file` supplied both hash parameters. |
| 15, 17, 19 | 3 | Revision-gated reads supplied incorrect hashes and returned `STALE_FILE`. |

The real `FormControls.jsx` hash stayed constant through the repeated failures. These observations do not establish concurrent edits. The stored reasoning later explicitly recognizes `sha256:[redacted token]`. Original execution-step results retain the valid hashes and mark model-output redaction. The original model-visible wire requests were not saved, so the historical prompt cannot be reconstructed byte-for-byte.

The agent eventually applied the UI edit and completed its build. R3 does not redo or modify that UI work.

## Production hash path and repair

The audited production path is:

```text
executeAgentTool / read_project_file
  -> native result with computed content_hash
  -> runMemoryChat result settlement
  -> formatToolResult
  -> redactModelContent / secretRedaction
  -> output cap and history
  -> sanitizeChatMessages
  -> local or cloud provider request
```

The generic long-token regex in `secretRedaction.cjs` treated a 64-character hexadecimal digest as a credential-like token. The child dispatcher had a separate whole-result string redactor with the same effect.

The repair is deliberately structured and provenance-aware:

- Only native `read_project_file`, `write_project_file`, and `str_replace_editor` formatting can preserve valid canonical `content_hash` and `current_content_hash` fields at the result root.
- The main loop uses its dispatcher-resolved `serverName`, not a field supplied by the model or tool payload. A runtime-only Symbol preserves that provenance through repeated wire formatting; JSON cannot forge it.
- The child dispatcher uses the same formatter after its native allowlist and read-only execution checks.
- Hashes in file content, nested objects, arbitrary MCP results, malformed fields, and echoed `expected_content_hash` input receive ordinary filtering. The general secret filter is unchanged.
- Provider conversion consumes the already sanitized tool message. A mocked Anthropic conversion and a subsequent revision-constrained native read are tested.

A second production edge case was fixed: the existing 20,000-character output cap can cut a large JSON result mid-string. For a trusted native file page, settlement now retains valid bounded JSON, preserves its revision, marks source text as an excerpt, and keeps the stored-evidence notice inside the envelope. It reuses the existing output guard and its ceiling; it does not raise the cap or change compaction. The next sanitizer can therefore still recognize the structured hash.

Deterministic proofs cover a real native read, repeated unchanged reads, model-visible hash equality, successful reuse of that hash, large-page truncation, child formatting, provider conversion, and continued secret redaction.

## Revision arguments and error recovery

Both existing parameters have distinct supported behavior and remain available in the shared compact/full schema:

| Parameter | Matching revision | Different revision |
|---|---|---|
| `if_content_hash` | Returns `not_modified`, without source text. | Returns the fresh source page. |
| `expected_content_hash` | Returns the requested source page. | Rejects with `STALE_FILE` / `FILE_REVISION_CHANGED`, without source text. |

Neither was treated as a redundant alias. The conditional-read optimization cannot replace a revision gate for reading the next page. Existing bare 64-character hash inputs remain supported and normalize to canonical `sha256:` form.

The requested concise ordinary-read / never-invent / never-both / refresh-after-stale instruction appears once in native reader guidance. Other reader wording was shortened to avoid increasing child-agent prompt pressure: the reader schema is **1,415 bytes**, compared with **1,454 bytes** before R3. Both profiles use the same definition.

Ordinary workspace reads still need only `relative_path`. Attachment reads use `attachment_id` instead. Exactly one source is enforced by the executor. The schema's formerly unconditional `relative_path` requirement was updated to accommodate the alternative; tests now check both source conflicts and missing sources.

Diagnostics distinguish conflicting hashes (`INVALID_CONTENT_HASH_MODE`), malformed hashes (`INVALID_CONTENT_HASH`), stale revisions, missing files (`FILE_NOT_FOUND`, or underlying `ENOENT`), workspace escapes (`UNAUTHORIZED_PATH`), and permission denials. Attachment errors have separate typed codes. A stale read tells the model to refresh without either hash argument. No code substitutes a hash or bypasses optimistic concurrency on writes.

Invalid GLM-style calls intentionally still fail. The deterministic replay verifies the five conflicting-argument and three incorrect-hash classifications, followed by a successful ordinary refresh and revision-constrained read. The corrected supported workflow does not reproduce the retry loop.

## Attachment architecture and authorization

Existing ingestion accepts declared extensions, enforces 10 files, 20 MB per file and 50 MB per batch, copies into managed attachment storage, and extracts supported document text. `message_attachments` associates each copy with its user message. Existing internal `file_path` metadata remains available to the UI and media protocol.

R3 extends **the existing `read_project_file` tool**; it adds no attachment tool and no shell access:

```json
{"attachment_id":"att_<32 hexadecimal characters>"}
```

Model context and workspace briefs advertise this reference and the correct tool argument instead of an inaccessible storage path. Text attachments retain their inline text as well as a reference. Media still use the existing original-user-media context pathways where supported.

An additive `attachment_read_refs` table persists a random 128-bit reference for one attachment row. Its foreign key cascades on attachment deletion. This prevents SQLite row-ID reuse from resurrecting an old reference, even when an identical file is reattached to the same message. References survive application restarts while the attachment association remains valid. No live database was migrated during implementation; this schema was exercised only in disposable databases.

Resolution requires the current conversation's persisted **user** attachment, its still-existing session, a valid managed file, the correct MIME type, and existing size bounds. It does not infer authority from a workspace match, filename, guessed ID, or arbitrary path. Reads use a read-only descriptor with no-follow protection, validate file stability, and recheck authorization. If model-capability lookup is asynchronous, ownership is checked again before reading.

| Mode | Read an authorized attachment | Workspace mutation |
|---|---|---|
| Read Only | Allowed, no additional approval | Denied by existing policy. |
| Ask | Allowed, no additional approval | Existing contained-write and approval behavior. |
| Workspace Write | Allowed, no additional approval | Existing workspace policy. |
| Full Access | Allowed, no additional approval | Existing ordinary file/command policy. |

Tests cover the same reference across mode changes and casual conversations without a workspace. Reading an attachment grants no write/delete capability and does not alter the original. Mutation tools reject `attachment_id` as an unexpected argument.

Foreign-session references, removed associations, deleted sessions, changed ownership, stale references after row reuse, symlink replacement, path traversal, and arbitrary app-data paths are rejected. A child must have the existing trusted parent delegation and live child ownership record; fabricated contexts and deleted delegations fail. A branch receives its own attachment association/reference through the existing authorized branch action.

The command sandbox still masks application data. Attachments are not public, storage cannot be enumerated through this capability, and no application-data mount or blanket filesystem exception was added.

## Format and model support

| Content | Supported inspection | Limits / truthful fallback |
|---|---|---|
| PNG, JPEG, WebP | Existing validated tool-image pathway; original bytes retained. | The existing selected-model attachment policy gates known runtime reads. Unsupported/unverified models receive metadata and a capability diagnostic. Text-only child agents receive metadata. Retrieving bytes does not establish visual understanding. |
| GIF | Read-only file metadata. | Existing tool-image validator does not support GIF; the diagnostic says so. No new animation decoder or conversion was added. |
| Audio | Read-only file metadata; existing original-user-audio pathway where model/provider support exists. | No new transcription or audio decoder. |
| Video | Read-only file metadata; existing original-user-video pathway where model/provider support exists. | No existing general bounded frame-extraction helper was found to reuse. No new decoder or dependency was installed; metadata is not claimed to be video understanding. |
| PDF | Existing `pdf-parse` extracted text. | Scanned PDFs need OCR; missing extraction yields a capability diagnostic. |
| XLSX | Existing ExcelJS worksheet/cell/formula-result extraction. | Existing extraction limit retained; missing extraction yields metadata/limitation. |
| Text, Markdown, CSV, JSON, source files | UTF-8 text pages. | 200 lines by default, at most 400 lines and 20,000 returned characters. Binary/null-containing or invalid UTF-8 content is not silently treated as text. |
| Other Office / binary formats | Only existing accepted formats are admitted. | DOCX and other unsupported formats were not newly advertised as readable. |

The reference reader retains the 20 MB file bound, document extraction limits and original filename/provenance. It does not add dependencies or unrestricted external processing.

## LSP investigation, limits and corrections

The historical request was a JS/TS workspace-symbol query for a JSX component under the recorded project root. The bundled configuration resolves `typescript-language-server/lib/cli.mjs` and `typescript/lib/tsserver.js` through the existing lifecycle. Both executables resolve in the current installation. Real bundled-server fixture tests exercise initialization, readiness, reuse, diagnostics and shutdown.

**The underlying historical failure reason is not recoverable.** Before R3, both the tool authorization catch and the adapter's startup/connection error mapping could produce the same saved result. No historical initialization, exit, timeout, ownership or activation-phase diagnostic accompanies that call. No persisted LSP lifecycle table or relevant historical log was found. An earlier progress note attributing the failure specifically to authorization was too strong; the stored record does not establish that.

Later in the same session, two diagnostic calls succeeded, with explicitly stale/unversioned results. Thus permanent global LSP unavailability, a missing installation, a readiness race, or compact-profile causation should not be inferred from the first error. The exact historical tool profile was not durably recorded.

The existing manager already waits for shared initialization, uses bounded timeouts, checks live authorization, reuses servers and has a bounded crash restart budget. R3 preserves those mechanisms and makes focused corrections:

- Authorization, launch, initialization and request failures now carry safe phase/reason information and file/search/test fallback guidance.
- Missing bundled modules, missing executables, execution denial, initialization timeout, protocol/connection termination and observed process exit are distinguished where evidence exists. Private launch messages/stderr are not forwarded to the model.
- Permission revocation is classified as a permission failure rather than generic server unavailability.
- Manager status retains failure information. Cleanup no longer overwrites the initialization-timeout reason with its induced exit.
- A ready server that crashes remains discoverable only while its existing restart budget permits recovery. Permanently failed startup and exhausted budgets stay unavailable.
- Request errors with uncertain dispatch outcomes say `operation_executed: "unknown"`; failures known to occur before dispatch say false. No successful result is fabricated.

No language server is downloaded or installed. LSP does not grant command execution. One optional LSP failure remains a tool failure: a mocked agent completes after switching to native reads. Existing cancellation, repetition and failure bounds remain in force.

## Verification and baseline comparison

A pre-edit restricted test attempt was inspected, but that sandbox blocks child Node processes and loopback sockets. Those failures were not used to claim application regressions. A matched baseline was then reconstructed in `/tmp` by reversing only R3 source changes while retaining the user's pre-existing working-tree changes; live files were never reverted. Both comparison runs used the same local fixture harness.

The offline harness redirects the default MCP singleton to empty disposable configuration, excludes `tests/rag.test.cjs`, and applies a 60-second per-test deadline. No real-model inference was run.

| Verification | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Matched baseline, 2,474 tests | 2,430 | 43 | 1 |
| Broad integration verification, 2,497 tests | 2,461 | 35 | 1 |
| Final native/read/redaction/LSP/batching/continuation focus, 383 tests | 381 | 2 | 0 |
| Final new R3 regressions | 25 | 0 | 0 |
| Final brief/context/document focus | 24 | 0 | 0 |
| Final E1/E2 editing and task-plan focus | 140 | 0 | 0 |
| Isolated model-selection recheck | 14 | 0 | 0 |

The broad comparison has no R3-only failure identities. The two focused failures are the baseline's legacy large-file assertion in `fileVersion.test.cjs` and hardcoded LSP-schema-byte assertion in `lspProductionAgent.test.cjs`; neither was weakened. Some unrelated baseline failures vary between runs. Baseline-only improvements are not attributed to R3. An unmatched model-selection failure in an intermediate run passed its isolated recheck and did not recur in the verified broad run.

The broad run includes an earlier 23-group version of the new R3 suite. Final focused checks cover the subsequent bounded-JSON edge case, casual attachment access, and final source changes; the final R3 suite has 25 groups. This is not a claim that the entire repository passes.

Relevant exercised suites include native tools/revisions, R2 pagination, E1/E2 edits, result/media serialization, secret redaction, permissions, ingestion and extraction, session deletion/history, child access and continuation, real/fake LSP lifecycle, P2 compact/full profiles, T1/T1.1 batching, context measurement, task plans, and existing compaction compatibility suites. No compaction implementation was changed.

`npm run build` passed, with the existing Vite chunk-size advisory. `git diff --check` passed. Evidence includes source hashes, exact historical call classification, test identities and log hashes.

### Test-harness incident

An initial broad run exposed an unsafe existing RAG fixture: its default manager started the host-configured Gmail MCP subprocess. The specifically test-owned RAG and MCP processes were stopped. No MCP operation was intentionally issued; possible external activity during that subprocess's startup was not verified. Subsequent runs redirected host MCP configuration and excluded that test. This incident is disclosed rather than describing the initial run as fully isolated.

## Suggested short real-GLM acceptance check

This check is recommended for the user after review and was **not executed**:

1. Create a disposable workspace/session with the same GLM selection. Attach a small PNG, text file and text-bearing PDF.
2. Ask the agent to inspect the attachments, locate a known component, read a second source page using its returned revision, and perform one small change in the disposable copy.
3. Confirm the model sees `attachment_id`, not app-storage paths; valid native hashes arrive intact and are copied exactly when needed.
4. Repeat attachment reading under Read Only, Ask, Workspace Write and Full Access. There should be no read-approval prompt; mutation behavior should follow each existing mode.
5. If the model lacks image/video support, confirm an accurate capability limitation rather than a path error or a claim to have seen pixels.
6. If LSP is unavailable, confirm phase/reason diagnostics and continuation through file search/reads. Inspect actual failed-call counts; do not expect invalid calls or real infrastructure failures to be reported as successes.

R3 implementation, verification, report and evidence are complete. No R4 or unrelated follow-up work was started.
