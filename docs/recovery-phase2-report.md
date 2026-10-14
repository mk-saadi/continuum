# Workspace Recovery — Phase 2 Implementation Report

**Scope:** shell/MCP/indirect-change coverage on the Phase 1 content-addressed store. No UI, no retention configuration, no permission-semantic changes. No model inference used — all verification deterministic. `/tmp/opencode/` untouched. Phase 1 evidence intact; nothing committed.

## 1. Paths actually covered (verified in source, not assumed)

- **Shell** (`execute_command`): single choke in `executeAgentTool` (`agentTools.js`). Contained (bwrap, workspace bind-mounted writable) and uncontained (raw `exec`) both covered — scans run in the main process either way. 45 s timeout bounds every invocation; **no background-shell primitive exists** (only `exec`/`execFile` in `agentTools.js`; `nativePlaywright` uses `execFile` for browser plumbing, not workspace writes).
- **MCP** (`mcpManager.callTool`, sole caller `ipcHandlers.js:683`): external processes with full FS access. No `readOnlyHint`/annotations are consumed anywhere in-tree; `requiresConfirmation` matches DB verbs only, so MCP file writes carry no content signature. Boundary discriminator (`recoveryBoundary.shouldScanMcpCall`): skip 4 known-read names (`list_directory`, `list_directory_with_size`, `search_files`, `read_text_file`); scan on mutating-verb names **or** workspace-resident/sniffed-path arguments. Safe direction is over-scan (costs time, never safety); fetch/DB prose almost never matches.
- **Placement guarantees:** shell boundary sits after guard/sandbox resolution; MCP boundary sits after the mutation-approval gate (denied calls throw before any scan — tested). Recovery never authorizes anything.

## 2. Boundaries and store reuse (`recoveryBoundary.js` new; `recoveryStore.js` extended, same tables + 1 index table)

- `withExternalRecovery`: commit pre-scan checkpoint → run op → post-scan → `finalizeBoundaryCheckpoint` merges created-entries + `changed[]` + post-honesty flags into the **same row**. Op throws (abort/timeout/failure) still post-scans, then rethrows with the checkpoint id — a failed `exit 3` keeps its point and is never auto-restored.
- Pre-capture hard failure (unreadable root, unwritable blob dir) **blocks the op unlaunched** (verified: marker file absent). Cap overflow degrades to disclosed partial, never silent.
- Post-scan failure leaves the durable pre-state valid (`op.postFailed`, tested via deleted-root restore).
- Shell results gain additive fields (`recoveryCheckpointId`, `recoveryChangedTotal`, `recoveryChanged[]`, `recoveryComplete`); MCP string results pass through byte-identical (checkpoint via `listCheckpoints`).
- New store capabilities: depth-wide scope excludes (`.git`, `.llm_workspace`, `node_modules`, `dist`, `build` — explicit tool paths bypass), `uncaptured` records (a failed read is never `absent`), `mtimeMs` + `volatile` flags, `recovery_workspace_index` (mtime/size fast path with blob-existence revalidation, so correctness never depends on it), scan caps (20k files / 1 GiB, truncate-with-disclosure), pure `diffStates` (modify/delete/create/type-change + hash-paired renames), restore processes deeper paths first (created-file removal precedes created-dir removal — found by failing test).

## 3. Failures, races, detached writers

- Crash between pre-commit and post-scan: pre-checkpoint restores alone (tested).
- Concurrent edits: stat→read→restat race flags `volatile`; youth (<2 s) flags too (unified after a failing test caught two definitions disagreeing).
- Detached writers: bwrap `--die-with-parent` contains sandboxed children; raw `exec` waits on inherited stdio (partial natural containment — a bare `&` job delays the tool result itself); fully detached (`setsid`+redirected stdio) and MCP servers escape post-scan by design. Guarantee is honestly scan-time: demonstrated by a detached writer missing `changed[]` then appearing at the next boundary. Every later op re-scans, so drift is always eventually detected.
- Restore conflicts unchanged from Phase 1 (no-force never overwrites; pre-restore capture default).

## 4. Defects found and fixed (all via failing tests)

1. `withExternalRecovery` took `mutate` inside options while callers passed it positionally — every boundary test failed; fixed signature.
2. `return promise` (no `await`) in the shell dispatch let boundary errors escape `executeAgentTool`'s catch — same Node-22 `return await` lesson as Phase 1; fixed (MCP path was already `await`ed).
3. Move-back fast path skipped created-parent cleanup — extracted shared helper, both paths use it.
4. Volatile defined twice (age heuristic vs restat check) disagreeing — unified to `young || !settled`.
5. Restore order: parent dir removal raced child-file removal — depth-first ordering.
6. Blob files are shard/full-hash named (not remainder-named) — test helper corrected; GC's dead `shard+file` clause is harmless.

Phase 1 code changed only additively (excludes depth, `uncaptured` records, mtime/volatile fields, depth-first restore): Phase 1 suite still **20/20** unmodified.

## 5. Exclusions and coverage semantics

`coverage = {complete, skipped[{path,reason}], excluded[{path}], volatile[]}`. `complete` means everything in scope captured; scope itself is explicit per checkpoint. Reasons: `too_large`, `unreadable`, `unsupported`, `escape`, `cap_exceeded`, `scope-excluded`. States stay distinct: absent (removable) vs captured (restorable) vs uncaptured (refused, never deleted) vs unknown (refused). Failed post-scan flips `op.postComplete=false` without touching the pre-manifest.

## 6. Verification

- `tests/recoveryBoundary.test.cjs` (new): **20/20** — create/overwrite/delete/multi-file/rename shell cases with byte-exact restores; no scans on reads; native precision (single-target manifests, kind `op`); block-on-pre-failure with unlaunched proof; failed-command retention without auto-restore; root-deleted and subdir-unreadable post failures; coverage honesty (all four skip classes + volatile + excluded); detached-writer gap + next-boundary detection; interruption durability; conflict silence check; git HEAD/index/branch/stash invariance + no `.git` capture; permission matrix (denied shell/MCP leave no rows; discriminator unit cases); MCP string-shape preservation with single dispatch; blob reuse across scans; **1500-file/200-dep-file fixture: cold 1499 ms / warm 209 ms** (2.9 MiB hashed), exact skip/exclusion lists.
- Regressions: recoveryStore 20/20, agentTools, toolPermissions, permissionPolicy, gitTools, subagent budgets/reliability/display, toolDisplay, mcpManager, mcpPermissions, compaction, transcript — **167/168** total; the one failure (`filesystemToolLimits` MCP db-init) reconfirmed pre-existing on clean HEAD `6c961b1` via worktree bisect.
- `git diff --check`: clean.

## 7. Remaining for Phase 3 (explicitly not claimed)

Shell/MCP *intermediate* states within one invocation; out-of-workspace MCP effects (unobserved by design); long-lived-server writes between boundaries (detected late, never prevented); retention scheduler + storage settings UI; restore UI (service API `listCheckpoints`/`restoreCheckpoint({paths,force})` is the integration surface); capture-telemetry to validate the 2 MiB / 20k-file / 1 GiB assumptions; live acceptance (real MCP filesystem server round-trip, Windows/macOS runs where containment degrades to approval-gated exec).
