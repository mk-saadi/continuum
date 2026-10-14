# Workspace Recovery — Phase 3 Implementation Report

**Scope:** recovery UI (Activity card + history modal + global Settings), retention/GC, IPC, activity integration, tests, live-app acceptance. No model inference used. Nothing committed. `/tmp/opencode/` untouched.

## 1. Changed files and rationale

**Storage engine (`src/main/recoveryStore.js`, extended — no rewrite):**
- `pinned` column on `recovery_checkpoints` with `PRAGMA table_info` + `ALTER TABLE` migration (existing `CREATE TABLE IF NOT EXISTS` can't migrate).
- Active-restore tracking (`activeRestores` map, registered/unregistered in `restoreCheckpoint`'s `finally`); `gcRecoveryBlobsForRows` unions in-flight restores' blobs into the referenced set — cleanup can never delete bytes a restore is reading.
- `dryRun` mode through `restoreCheckpoint`/`restoreOne` (identical action vocabulary, zero writes, blob-existence still verified so a dry run can't promise what isn't there). Missing-blob reason sharpened from `restore_failed` to `skip:blob_missing`.
- `diffTextLines` (bounded prefix/suffix line diff for the compare view; text-only, caller-gated size).
- `pruneRecovery({retentionDays, storageCapMB, latestPerSession, recentHours})`: keeps pinned + age<retention + latest-N per session + earliest-per-chat-run within 2× window + active restores; cap phase evicts oldest-first among the remainder only (never pinned/latest-5/recent); anything still over cap returns `capShortfallMB` instead of forcing.
- `getRecoveryStats` (physical deduplicated bytes vs logical referenced bytes, counts), `setCheckpointPinned`, and chat-scoped service reads: `getWorkspaceRecoveryOverview` (protected **only** on complete coverage + post-ok + bounded blob-existence recheck ≤50 stats), `getRecoveryHistory` (mine/other split with origin labels), `getCheckpointDetail` (per-path current-vs-recorded statuses + capped line diffs, metadata only), `assertCheckpointInRoot` (ownership gate).
- `getWorkspaceRecoveryOverview` never fabricates: no session → `empty/no-history`; chat without captures → `empty/no-chat-history` with other-chat counts.

**Policy (`src/main/configManager.js`):** `recoveryRetentionDays` (30, 1–365), `recoveryStorageCapMB` (512, 64–8192) via the standard `normalizeAppSettings` + SELECT + save path. No schema change.

**IPC (`src/main/ipcHandlers.js` + new `src/main/recoveryIpc.js` + `src/preload.js`):** 8 channels (`recovery:overview|history|detail|preview|restore|pin|stats|prune`). Every mutating/view call resolves chat → project root, then gates checkpoint ids to that root. Restore additionally refuses when `activeStreams` (or standalone delegation) marks the chat running. Preload mirrors existing `window.api` conventions.

**Renderer (`src/components/chat/RecoveryCard.jsx`, `RecoveryHistoryModal.jsx`, `RightSidebar.jsx`, `src/components/settings/RecoveryStorageSettings.jsx`, `src/components/main-app/MemorySettings.jsx`):** exactly the brief's layout — compact card in the Activity tab (status dot, latest-change summary, run-start presence, skipped/blob warnings, other-chat count, one entry button; honest empty/loading/error states), 860px modal (history mine/other → detail with statuses + diff excerpts → preview → force checkbox → confirm dialog → result; pin toggle; restore disabled while running/busy/invalid), global policy only in Settings → Storage & Data (two NumberFields + physical/logical usage + Clean-up-now with report). No new sidebar tab; chat switching re-fetches (no leaks).

**Activity integration:** the card lives in the Activity tab and shows the latest recovery event/state — deliberately no synthetic chat messages, which would corrupt the evidence fingerprints `taskCheckpoints` validates.

## 2. Safety review outcomes (§1.1–5 of the brief)

1. **MCP classification:** verified as specified (4 read names skip; verb regex + workspace-arg sniff; over-scan direction). Residual: a mutating server with pathless args on workspace defaults could miss — documented, name-heuristic covers conventional tools.
2. **mtime index:** fast path revalidates `blobExists` (correctness never rides the index); same-size changes rehash (mtime always bumps on write); disappearing files linger harmlessly until index replace; races flagged volatile.
3. **Coverage honesty:** `absent` (removable) vs `file` vs `uncaptured` (refused) vs unknown (refused) stay distinct end-to-end into the modal's status pills; partial checkpoints render amber everywhere, never green.
4. **Restore/conflicts:** unchanged from Phases 1–2, now surfaced in preview + modal; pre-restore capture precedes every destructive restore.
5. **Retention/GC:** active-restore union (new), pinned/latest/recent immunity (tested), shared blobs survive (tested).

## 3. Restore preview/confirm behavior

Preview = dry-run (no writes, no pre-restore row): would-restore / would-remove (+empty-parent pruning with wouldRemove flags) / would-skip with reasons. Confirm = inline `role="alertdialog"` (Cancel + Confirm restore), busy-locked, Escape/backdrop disabled while busy. Invalid/unloadable checkpoint disables restore with explanation. Selective restore = `paths` subset; run-start = earliest-checkpoint restore (same engine, no special-case undo command — the brief's "no misleading Undo" rule).

## 4. Retention/GC guarantees

Pinned + latest-per-session + <24h checkpoints are never pruned or cap-evicted; run-start proxy = earliest per chat within 2× retention. Blobs die only when unreferenced by retained checkpoints AND no active restore. Cap shortfall is reported, never forced. Storage exhaustion surfaces as capture failure (op blocked, original untouched) — tested via read-only blob dir. Physical vs logical bytes shown separately in Settings.

## 5. Ownership/IPC security

Root resolved server-side from chat session; checkpoint manifest root must equal it (`assertCheckpointInRoot`) for detail/preview/restore/pin — cross-workspace ids, traversal paths, and symlink escapes rejected (tested). Blob paths never cross IPC (hashes only, and only inside manifests the UI already holds). Restore refuses while running. No unrestricted filesystem-restore API exists.

## 6. Verification (exact)

- `tests/recoveryStore.test.cjs` 20/20, `tests/recoveryBoundary.test.cjs` 20/20 (unchanged, still green after additive store changes).
- `tests/recoveryIpc.test.cjs` (new) 13/13: overview states, cross-chat scoping + conflict guard, history/detail/preview dry-run safety, pre-restore + undo-of-undo, selective, incomplete-never-complete, cross-workspace/traversal rejection, pin/prune immunity, oldest-first cap order + shortfall honesty, physical-vs-logical, exhaustion visibility, active-run refusal (service flag + real handler wiring via `activeStreams`), channel registration + round-trips.
- UI (real Electron windows under xvfb): `recoveryCard` (protected/partial/empty, counts, chat-switch no-leak, entry point), `recoveryHistoryModal` (list/detail/preview/confirm-once/pin), `recoveryStorageSettings` (fields, validation with real messages, usage split, cleanup dispatch+report) — all pass.
- Regression set (131 tests: agentTools, toolPermissions, permissionPolicy, gitTools, subagent budgets/reliability/display, toolDisplay, mcpManager, mcpPermissions): **131/131**. Known pre-existing failures unchanged (childAgentLoop ×2 stream/live-provider, mcpIpc ×2 mocks, filesystemToolLimits MCP db-init — all verified on clean HEAD in earlier phases).
- `vite build`: ✓ 11.05s. `git diff --check`: clean.
- **Live-app acceptance (real, CDP-driven):** full dev app booted under Xvfb with isolated user-data; screenshot shows main UI rendered; app log clean (only headless-WebGL noise); via CDP clicked Settings gear → Storage & Data tab → **"Workspace recovery storage" section visible with 30-day / 512 MB defaults** (screenshot kept as evidence reference `/tmp` scratch, since removed). Component behaviors (restore click-through with live engine, visual conflict copy, live chat-switch) remain for human hands — the same flows are covered by the Electron UI suites above.

## 8. Post-acceptance fix: post-operation state for honest conflicts (after Phase 3)

Live testing with Qwen found a real design bug the suites had baked in as correct: **a no-force restore immediately after the very operation that created the checkpoint reported `conflict`**, so default restores could never be complete — the engine couldn't tell the operation's own effects from later user edits.

Fix (no rewrite, no new store): checkpoints now persist post-operation state (`op.postState`, per-path kind+hash).
- Native ops snapshot affected targets after success (best-effort inside `withFileRecovery`; snapshot failure never fails the op).
- Shell/MCP finalize persists the post-scan state map.
- Conflict rule: reverting the operation's own effect (current matches post-state) needs no force; genuinely later edits conflict unless forced; checkpoints without post-state (old rows, manual points, pre-restore points) stay conservative.
- Verified live shape: op → no-force restore complete; user edit → no-force conflict preserving the edit → force overwrites.
- Modal preview/result now separate `unchanged` from would-restore/restored counts.
- Regression: `tests/recoveryPostState.test.cjs` 8/8 new; full set 145/146 (sole failure the known pre-existing MCP db-init case).
- Note: checkpoints created before this fix carry no post-state and keep legacy strictness — re-running the mutation (or one forced restore, safe when nothing changed after) moves to the new behavior. Requires an app restart (main-process change).

## 7. Remaining limitations and risks

- Live restore click-through with a running engine not performed by an agent (no input driver; CDP evaluation was read/click-only on inert UI). Final human pass should: run an agent edit, open the card, preview + force-restore a conflict, prune from Settings.
- MCP discriminator remains heuristic (documented; safe direction).
- `latestPerSession`/`recentHours`/index policy are constants, not settings (kept the settings surface to the brief's two knobs + pin).
- Volatile heuristic (2 s) is untuned against real workloads; capture telemetry still to come.
- The `.ui.cjs` headless lesson (documented in evidence JSON): focus/blur don't fire in hidden windows — tests must use native-setter + `input` + `focusout` events; `$?` after a pipe measures the pager, not Electron.
