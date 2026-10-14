# Workspace Recovery — Phase 1 Implementation Report

**Scope:** recovery engine, working restore API, native mutation capture (per `docs/workspace-recovery-architecture.md`). No UI, no shell/MCP step scanning, no retention settings. No model inference used at any point — all verification is deterministic Node scripts against temp dirs. `/tmp/opencode/` was not touched (observed empty; unrelated prior contents still unaccounted for, cause unknown).

## 1. Storage and recovery API (`src/main/recoveryStore.js`, new, ~600 lines, zero new deps)

- **Blobs:** `<appData>/recovery/blobs/<2-char shard>/<full sha256>`, written temp → fsync → rename; verified by rehash on every read (`readBlob` throws on missing/corrupt — never writes bad bytes).
- **Metadata** (same SQLite conventions as the app: WAL, `synchronous=FULL`, transactional): `recovery_sessions` (one row per project root), `recovery_checkpoints` (session, chat session, tool, kind `op|manual|pre-restore`, op JSON, manifest JSON, coverage JSON), `recovery_blobs` (hash, size — refcount source for future GC).
- **Manifest:** `{version, root, uncontained, op, parentsCreated[], paths: {rel: file{hash,size,mode} | dir{mode} | symlink{target,mode} | absent | unsupported}}`. `.git`/`.llm_workspace` never captured as content.
- **Key functions:** `captureOperation` (blobs-first, single-transaction commit; `required[]` paths make any skip throw), `createManualCheckpoint` (whole-workspace walk), `restoreCheckpoint(id, {paths, force, preRestore, uncontained})`, `readBlob`/`blobExists`, `getCheckpoint`/`listCheckpoints`, `gcRecoveryBlobs(retainIds?)` (mark-and-sweep + orphan-tmp sweep).
- **Restore semantics:** pre-restore checkpoint by default (restores are undoable); conflict = current differs from captured → skip unless `force`; created-after files removed only if regular files or empty dirs (report in `removed[]`); move checkpoints prefer atomic rename-back when the moved tree is untouched (`strategy:'move-back'`), else per-path fallback; result never reports `complete:true` with skips; uncontained manifests need explicit `{uncontained:true, force:true}`.

## 2. Native mutation paths and capture boundaries

All five hook into one wrapper, `withFileRecovery` (`agentTools.js`), placed **after validation, before the first write** — validation errors never create checkpoints:

| Tool | Captured | Notes |
|---|---|---|
| `write_project_file` | target + created parents | unchanged behavior otherwise |
| `str_replace_editor` | target | **atomicity fix:** bare `fs.writeFile` → `atomicWriteFile` (was the only non-atomic writer; verified §4) |
| `edit_project_files` | all validated targets post-Phase-1 | batch validation ≠ batch atomicity: see §3 |
| `apply_patch` | all parsed targets incl. `absent` for creations | deletion still refused; semantics unchanged |
| `move_project_file` | recursive source tree + dest-absent + created parents; `op:{kind:move}` | post-op verify (source gone + dest present) detects partial copy/unlink |

Capture failure **blocks the op** (`required` = about-to-mutate paths). Mutation failure triggers best-effort force rollback, and the error carries `[Recovery checkpoint #N …; rollback succeeded|incomplete|failed]`. Success results gain one additive field, `recoveryCheckpointId` (3 existing whole-object assertions in `tests/agentTools.test.cjs` updated to field checks + checkpoint-id checks). `git_stage`/`git_commit`, shell, MCP explicitly out of scope; child allowlist unchanged (still read-only).

## 3. Batch and directory-move behavior (the brief's hard questions)

- **Batch partial failure is now a tested guarantee, not a hope:** with real EACCES mid-sequence (read-only dir, no stubs), file 1 rolled back byte-identical, file 2 untouched, error names the checkpoint, and the checkpoint row is durable and restorable. Policy: **rollback immediately AND keep the durable point** — both, always.
- **Move partial failure (copy/unlink):** post-condition verification detects source-still-present/dest-missing states; rollback replays the checkpoint (verified with injected `unlink` failure).
- **Directory move:** rename-back fast path when untouched (atomic, no blob I/O); per-path fallback with conflict checks when changed. Created parents removed only when still empty.
- **`return await` correctness fix (found by failing tests):** bare `return promise` inside `try` does **not** route rejections to `catch` (confirmed on Node v22 — the `return await` distinction is real). The write path used bare `return`; fixed to `return await`. Other dispatches already awaited.

## 4. Atomic-write verification (brief §6.19)

Injected `rename` failure per tool: originals byte-identical, temp files cleaned up, op fails loudly — for `str_replace_editor` (post-fix), `write_project_file`, and via shared `atomicWriteFile` for batch/patch. Pre-fix, `str_replace_editor` would have torn the file; it now shares the atomic path. `atomicWriteFile` exported for tests.

## 5. Integrity, path-safety, failure guarantees

- Lstat-first everywhere (symlinks recorded, never followed); final-component links operated on, never through; intermediate escape links rejected at capture and restore; `..`/absolute rejected; uncontained restores need double opt-in.
- Corrupt/missing blob → path skipped, current bytes untouched (tested both).
- Crash order (blob → fsync → single transaction) means manifests never dangle; orphans swept by `gcRecoveryBlobs` without touching referenced blobs (tested).
- Real-git invariance tested: HEAD, branch, stash, index, no `index.lock` after capture/restore cycles.
- Oversized file (>2 MiB) on a required path blocks the op with a clear message; original untouched. Caps: 2 MiB/file, 1000 files / 100 MiB per op.

## 6. Exact tests and results

- `tests/recoveryStore.test.cjs` (new): **20/20 pass**, covering all 20 brief §6 items (overwrite, delete/create, selective, dedupe, dirty+untracked, non-git, capture-blocks, corrupt/missing blobs, torn-write atomicity ×2 tools, traversal/symlink ×4 sub-cases, modes, git invariance, no-row-on-failure + orphan sweep + ref survival, per-tool before-hashes, move parents cleanup, dir move-back + changed fallback, mid-batch EACCES rollback, patch pre-capture incl. creation, unlink-failure partial move, no-dup-blobs + checkpoint integrity).
- Regressions: `agentTools` (updated, 1/1), `toolPermissions`, `permissionPolicy`, `gitTools`, `subagentBudgets`, `subagentReliability`, `subagentDisplay`, `toolDisplay` — **150/153** across the focused set with the 3 failures confirmed pre-existing on clean HEAD `6c961b1` via worktree bisect (childAgentLoop stream assertion + live-provider test, filesystemToolLimits MCP db-init).
- `git diff --check`: clean.

## 7. Unsupported paths and Phase 2 handoff

- **Not recoverable yet:** shell/`execute_command` effects, MCP-hosted writes, `generate_image` output, anything outside the workspace, DB/network/process side effects, intra-command intermediate states. No claims otherwise exist in code or UI.
- **Deferred:** step-boundary scanning (hooks identified: `memoryChat.mjs:476-497` pre-inference, settle path post-tools), retention policy + scheduled GC (function ready, no scheduler), restore UI (service API is the integration surface: `listCheckpoints` → `restoreCheckpoint` with `paths` subset + `force`), capture-size telemetry to validate the 2 MiB / 1000-file / 100 MiB assumptions, optional commit-a-restore-point flow.
- **Known rough edges:** `coverage.complete=false` checkpoints from manual whole-workspace captures when unreadable files exist (reported, restorable for the rest); mode-only changes report `restored` (harmless rewrite); mtimes not preserved (documented).
- **No model needed:** the brief's LM Studio note applied only to agent-run tests; none were used — everything above is deterministic.
