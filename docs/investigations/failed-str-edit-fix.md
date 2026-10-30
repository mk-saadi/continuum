# Fix for “failed str” editing failures

## Result

Native-tool replays now accept 13 of the 14 previously failed edit requests in the recorded Tooltip task. The remaining request omits a source closing tag and still rejects without writes. This is deterministic request replay, not an end-to-end model run or a prediction of future failure rates. A successful edit can still contain incorrect replacement code supplied by the model.

## Changes

- JSX/TSX tolerant matching compares text using TypeScript's JSX emission whitespace rules. Multiline indentation and blank lines can differ when they leave rendered text unchanged. Significant inline spaces, expression strings, template contents and comments remain protected. Exact and CRLF matching still run first, and ambiguous normalized matches still reject.
- Replacement content overlapping sensitive text remains verbatim, avoiding accidental reindentation of literal bytes.
- Unified patches accept numbered and bare `@@` hunks. If exact complete-line context fails, patch execution uses the same unique, protected matcher as string editing. All hunks still preflight before writes. Missing nonblank source lines cannot be skipped.
- Unsafe-normalization diagnostics return the actual rejected candidate, its line range, the protected syntax kind, and differing source/requested whitespace where available. Source excerpts no longer use a random shared span tag for these rejections.
- Nearby-source ranking considers a window of distinctive lines rather than the first generic tag. A skipped-source diagnostic identifies the missing `</span>` at line 508 in the real failed request.
- Batch failures label excerpts as on-disk or staged-batch; patch failures likewise identify staged-patch context. No-write results remain explicit.

## Verification

Eight test files passed together: agentTools, e1FileEditing, e1FileEditingNative, e2EditingReliability, editWhitespaceGuards, failedStrEditingReplay, permissionPolicy and toolApprovalPolicy. After adding compiler crosschecks, the two updated focused files passed again.

The session replay file contains 14 recorded failures plus checks for protected template whitespace, atomic multifile failure, ambiguous normalized patches and staged batch diagnostics. The whitespace tests include a 20-case comparison against actual TypeScript emission. Existing tests that required rejection of render-insignificant JSX indentation now require acceptance; significant-whitespace counterexamples remain rejecting.

The live session database and recovery blobs were read only. Replays wrote only disposable temporary projects. The user's ModelSelectorModal working-tree changes were not modified by this fix.

Evidence: `failed-str-edit-fix-evidence.json`. Reusable source/request fixture: `tests/fixtures/failedStrEdits.json`.
