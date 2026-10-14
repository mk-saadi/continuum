# Continuum Workspace Recovery — Shadow Git vs. Content-Addressed Journal

**Status:** read-only architecture audit. No runtime code changed, no dependencies installed.
**Tree audited:** working tree on `main` at `6c961b1` **plus uncommitted changes** (subagent budget bump, limit badge, git tools incl. sandboxed `runGit` + fingerprint-gated commit approval). Line numbers below are working-tree numbers at audit time and will drift.
**Method:** direct source reads of the files listed in §2 plus three parallel read-only codebase explorations (mutation pathways, storage/packaging, checkpoints/permissions). Test suites consulted, not modified.

---

## 1. Recommendation

**Build the content-addressed journal as the single store, with two capture strategies: pre-mutation before-images for native file tools, plus model-step boundary scans to discover shell/MCP-made changes.** Reject a shadow-Git object store.

Reasons, in priority order:

1. **Availability.** Recovery must work where it is needed most: non-git projects, and machines without git. Git is not a dependency (`package.json` has no git library; `git` is not in `deb.depends`; availability is checked only at exec-time failure in `src/main/tools/agentTools.js:601`). A shadow-git store makes recovery unavailable on exactly the projects and platforms (Windows/macOS from-source runs, minimal Linux) that need it. The journal needs only `node:crypto` (already used for sha256 throughout) and the filesystem.
2. **Blast radius.** A shadow store must point git at the user's worktree (`--git-dir`/`--work-tree` or equivalent). Every such invocation is one environment-variable bug away from touching the user's real `.git` — the exact catastrophe being insured against. The journal never shells out to git for capture and never reads the user's `.git` at all.
3. **Proven local primitives.** The codebase already demonstrates every hard part of the journal: WAL + `synchronous=FULL` SQLite with transaction discipline (`src/main/db.js:284-287,288-403`), atomic temp+rename writes (`atomicWriteFile`, `src/main/tools/agentTools.js:767-777`), content hashing (`sha256` in `taskCheckpoints.js:232`, `agentTools.js:621`), single choke-point interception (`executeAgentTool` post-guard), and per-step changed-path attribution (OpenCode-style capture is independently validated by their docs).
4. **The hybrid is justified by one concrete failure case, not vibes.** Pre-mutation interception catches 100% of native-tool mutations but is blind to shell/MCP writes; boundary scans catch shell/MCP final states but miss intermediate states inside one 45-second shell invocation. Neither alone is honest. Together — one store, one manifest format, one restore engine — they cover all agent-reachable paths with explicitly disclosed gaps. This is a hybrid of *capture strategies*, not of *stores*; it does not double the maintenance burden.

What to borrow from git anyway: manifest-before/manifest-after diffing, content dedupe semantics, reachability-based retention (only GC what no retained checkpoint references), and OpenCode's scope rules (2 MiB/file cap, skip ignored/build output, refuse while running).

---

## 2. Decision matrix

| Criterion | A: Shadow Git store | B: Content-addressed journal (recommended) |
|---|---|---|
| Works without a project `.git` | Yes, *if* a git binary exists. No `.git` in project is fine (shadow repo is separate). Fails on git-less machines. | Yes, unconditionally. No external binary. |
| Preserves the user's real Git state | By `GIT_DIR`/`--git-dir` isolation + env scrubbing. Correct when perfect; a single env/arg bug can index, lock (`index.lock`), or run hooks/filters in the real repo. Must also exclude the nested `.git/` dir from capture and neutralize `core.hooksPath`, `GIT_CEILING_DIRECTORIES`-style discovery. High-stakes configuration surface. | Trivially: never invokes git for capture, never opens the user's `.git`. Only worktree files are ever written, and only during an explicit user-approved restore. |
| Captures native file-tool mutations | Via step-boundary `status`/`add` diffing, or pre-mutation `show HEAD:path`-style reads. Workable but indirect: attribution requires diffing after the fact. | Direct: single choke point in `executeAgentTool` after `guardDecision` (see §3.4). Before-image is exact, no diffing needed. |
| Captures shell-based modifications | Boundary `git status` + `add -A` on the shadow worktree. Misses intermediate states within one command; misses ignored files unless force-added (which then bloats). | Boundary manifest re-scan (hash walk of attributed + previously-seen paths). Same intermediate-state limitation, disclosed. No ignore-file semantics to fight: the journal defines its own scope. |
| Disk usage | Object-level dedupe (identical blobs stored once) — excellent. But: whole-worktree snapshots tempt over-capture; untracked large files need explicit force-add paths; `gc` tuning required. | Same dedupe via `sha256` blob filenames. Finer control: only attributed paths journaled, per-file/per-turn/total caps, no packfile unpredictability. |
| Snapshot speed | `status + add + write-tree/commit` per boundary. Fast on small repos; degrades on large worktrees unless scope is restricted (needs benchmarking per repo size — **do not assume**). Spawns a process per capture. | In-process: hash + copy only touched files (typically a handful per turn). No process spawn for native interception. Boundary scans cost one hash walk over attributed paths only, not the worktree. Scales with *agent activity*, not repo size. |
| Restore safety | `checkout <sha> -- <paths>` / `restore --source`. Strong, but pathspec and overlay semantics must be wrapped carefully; easy to restore too much. | Explicit per-path restore with pre-restore conflict check (mtime+hash vs manifest), atomic temp+rename per file, dry-run listing. Smaller semantic surface to get wrong. |
| Crash recovery | Git objects immutable; ref update atomic. Partial capture leaves unreachable objects (safe, collectible). Very good — if git is present. | Blob-first-then-manifest ordering + SQLite transactions give the same property with no dependency: unreferenced blobs are garbage, never dangling references (see §7). |
| Cross-platform | Needs a git binary + `bwrap`-equivalent thinking on each OS. Builder targets Linux only (`package.json:66-72`), but code retains win32 branches (`agentTools.js:435,587`, `pathUtils.js:10`); contained execution already refuses non-Linux. Shadow git would need its own platform story. | Pure Node (`crypto`, `fs`, `zlib` builtin, better-sqlite3 already shipped). Identical on all platforms. |
| Dependencies | System git (absent guarantee) or `isomorphic-git`/`simple-git` (new deps, perf/codecave questions, still need binary-file/mode semantics). | Zero new dependencies. Reuses better-sqlite3, `node:crypto`, `atomicWriteFile` pattern, `scopedPath` containment. |
| Security | Snapshot store would contain full file contents including secrets (same for both). Extra git-specific risks: smudged filters/drivers executing on capture/restore (`core.fsmonitor`, ext-diff, textconv — the current `runGit` already disables these, `agentTools.js:579-580,635,654`, proving the hazard is real), hooks in cloned configs. | Secrets in blobs: identical exposure, mitigated identically (app-data permissions, exclusion of secret-looking paths by policy, never sync blobs anywhere). No filter/driver/hook execution surface at all. Symlink capture policy still required (record-then-restore must not follow attacker links — reuse `lstat`-first discipline from `scopedPath`). |
| Complexity | Medium code, high *semantic* load: ignore-vs-capture rules, nested-`.git` exclusion, ref lifecycle, gc safety, git-version skew. | Medium code, low semantic load: blob put/get, manifest rows, refcount GC, restore-with-conflict-check. All patterns already exist in-tree. |
| Integration | New subsystem + process management + platform gaps. Model-step hooks shared with B. | Same hooks, plus one wrapper at the existing choke point. IPC/UI/test patterns mirror existing checkpoint display work. |

---

## 3. Repository findings (grounded)

### 3.1 Prior-audit claims — verified, with two discrepancies

| Prior claim | Verdict |
|---|---|
| Workspace checkpoints record task state/paths/evidence, not file bytes | **Confirmed.** Schema `db.js:222-236`; JSON shape `objective` + 11 arrays (`taskCheckpoints.js:46-51`); `filesChanged` entries are `{path, nature, verified, stepRef}` (`taskCheckpoints.js:544-573`); model-invented `diff/diffText/patch` keys are *stripped* (`UNTRUSTED_KEYS`, `taskCheckpoints.js:53-54,347-356`). `taskCheckpoints.js` imports no `fs`. |
| Child checkpoints preserve conversation context, not files | **Confirmed.** `contextRecovery.js:83-237`: summaries + evidence snippets (`resultSnippet` capped 800 chars), raw transcript preserved; no file bytes. |
| Execution-step persistence records what ran, not prior contents | **Confirmed.** `executionSteps.js:20-34` validates steps; persistence via `ipcHandlers.js:398-417` → `engineManager.js:342-387` (`UPDATE messages SET … execution_steps`). |
| No main-process restore/rollback handler | **Confirmed.** Grep for `backup|rollback|undo` in `src/main`: zero feature hits; `restore` hits are `window.restore()` and context-restore prose only. Checkpoint IPC (`ipcHandlers.js:931-936`) and `contextInspection.js:1-12` ("every query is a SELECT") are display-only; `ContextPanel.jsx` has only a Refresh button. |
| Model-facing git tools exist (read + stage/commit) | **Confirmed and stronger than described:** `runGit` sandboxes via `bwrap` on Linux (`--unshare-net`, `--ro-bind /`, rw mount only for declared writes, `agentTools.js:586-593`), scrubs `GIT_*` env, forces `core.hooksPath=/dev/null` + `--no-ext-diff --no-textconv` when contained (`agentTools.js:576-580`), and commit approval is fingerprint-gated (`prepareGitCommit`, `agentTools.js:616-623`; guard in `toolPermissions.js:452-457`). **Discrepancy 1:** this hardening landed via concurrent sessions after the original git-tools session — the tree is ahead of the session notes. |
| Sandboxed git has Linux/bubblewrap constraints | **Confirmed.** Non-Linux contained execution refuses (`agentTools.js:435,587`); git binary itself is unguranteed (not in deps, not in `deb.depends`, ENOENT-only detection at `agentTools.js:601`). |

**Discrepancy 2 — atomicity gap:** `write_project_file`/`edit_project_files`/`apply_patch` use `atomicWriteFile` (temp+rename, `agentTools.js:767-777`), but `str_replace_editor` uses bare `fs.writeFile` (`agentTools.js:754` region). A crash mid-`str_replace` can leave a torn file — worth fixing alongside recovery work (one-line change to reuse `atomicWriteFile`).

**Bonus finding — read-labeled mutation:** `take_screenshot` is `READ` capability yet appends to the project's `.gitignore` and creates `.llm_workspace/screenshots/` (`agentTools.js:372-404`). Recovery capture scope must exclude `.llm_workspace/` or screenshots will pollute every manifest.

### 3.2 Complete agent mutation surface (all paths verified in source)

1. **Native file tools** (`agentTools.js` dispatch `executeAgentTool`, ~line 987+): `write_project_file`, `str_replace_editor`, `edit_project_files` (1–20, transactional), `apply_patch` (no deletes by construction), `move_project_file` (refuses symlinks/existing dest; cross-filesystem copy+unlink is non-atomic), `git_stage`/`git_commit` (sandboxed, §3.1).
2. **Shell** (`executeCommand`, `agentTools.js:430-471`): 45 s timeout, 16 MB buffer. Contained (bwrap, workspace bind-mounted **writable**) or raw `exec` when uncontained (approval grant / `full_access`). `rm -rf .`, `rm <file>`, `mv`, `tee`, `python -c` all run **inside** the workspace when contained — only `isSystemAffecting` heuristics (`toolPermissions.js:328-372`) decide prompting, and they are documented prompt-only, "never relied on for containment."
3. **MCP-hosted tools** (`mcpManager.js:308-323`): filesystem MCP servers can write/delete **bypassing `scopedPath` and bwrap**; gated only by `EXTERNAL_MUTATION` approval + mutation backstop. Cannot be intercepted — boundary-scan only.
4. **Incidental writes:** screenshot `.gitignore` append (§3.1 bonus), `.llm_workspace/sandbox/{home,tmp}` mkdir, `generate_image` → `userData/generated_media/` (outside project — out of workspace-recovery scope).
5. **No other agent-reachable writers:** all other `writeFile/rename/mkdir` hits in `src/main` are user/IPC-initiated (config, skills, uploads, migrations). No `spawn` shell primitive exists for agents; no filesystem watchers exist (single `fs.watch` on the MCP config dir only, `mcpManager.js:117`).

### 3.3 Turn lifecycle and exact hook points

- Turn loop: `memoryChat.mjs:471` (`while running`), turn begins `472`, inference `476-497`, per-tool settle `settleEntry` (~`657`), results persisted via `onExecutionSteps` (`ipcHandlers.js:609-614`) → `UPDATE messages … execution_steps`.
- **Pre-mutation hook:** wrap `executeAgentTool` immediately after `guardDecision`/`uncontained` resolution (~`agentTools.js:1013-1025`). At this point mode, approval, containment, and final args are all known — the single choke point covering native tools. (Standalone `"agent:execute-tool"` path, `ipcHandlers.js:855-871`, funnels through the same function — covered automatically.)
- **Step-boundary hooks:** before-inference (`memoryChat.mjs:476-497`, after tool schemas resolve, before fetch) and after-tool-batch-settle (`settleEntry` + `publishSteps`, ~`657-692`). Boundary scans run here.
- **Child agents:** read-only by four independent layers (allowlist `agentLoop.js:62-73`, `rootPath`-honored-only-for-reads `agentTools.js:1044-1050`, `read_only` guard deny, system prompt). Children cannot mutate — no capture needed for child execution.

### 3.4 Permission/containment reuse

- Capabilities (`toolPermissions.js:33-40`), `writeTargets()` path exposure (`171-195`, incl. `git_stage → args.paths`), `guardTool` containment+approval (`447-536`), and identical `scopedPath`/`workspacePath` symlink-safe resolution (`agentTools.js:334-352`, `toolPermissions.js:203-216`) are directly reusable for a `snapshot:*` IPC family and a restore executor (restore = privileged write → `WORKSPACE_WRITE` containment + always-prompt like `git_commit`).
- `permissionModes.json` + renderer mirror pattern shows how to add user-facing settings (storage cap, enable/disable) consistently.

### 3.5 Storage substrate already proven

- DB lives under configured `appDataDirectory` (default `userData/App_Data`, `configStore.js:21-26`, `db.js:274-281`); WAL + `synchronous=FULL` + `foreign_keys=ON` + `busy_timeout=5000` (`db.js:284-287`); schema+migrations in one transaction (`db.js:288-403`); `db.transaction()` facade (`db.js:446-453`); crash-safe migration precedent (`dataMigration.js:51-121`, hash-verified copy).
- Builder ships Linux AppImage/deb only (`package.json:66-72`), no `extraResources`; `src/lib/**/*.mjs/.cjs/.json` included in files — a journal module needs no packaging changes.

---

## 4. Proposed storage and checkpoint lifecycle

**Location:** `<appDataDirectory>/recovery/<sessionId>/` for blobs; new tables in `memory_palace.db` for metadata. Outside the workspace (agent `rm` cannot reach it; workspace bwrap binds only the project root), alongside (never inside) the main DB.

**Records:**
- `recovery_blobs(hash PK, size, created_at)` — filename on disk = `hash[0:2]/hash`, written temp+rename+fsync, verified by rehash on read.
- `recovery_checkpoints(id, session_id, kind [run-start|turn|manual], turn_index, manifest_json, coverage_json, created_at)` — manifest: `{path: {hash|null-absent, mode, size, mtimeMs}}`; coverage: `{captured, skipped: [{path, reason}], complete: bool}`.
- Blobs referenced by hash; no foreign key from manifest JSON — GC by mark-and-sweep (see §7).

**Lifecycle:**
1. **Run start:** full-scope manifest walk (attributed scope, §6) → `run-start` checkpoint. Failure here **blocks the run** (cheap, once, highest-value point).
2. **Native mutation:** before-image blob for each target path (first-touch-per-turn; skip if blob for current content already stored). Recorded into the turn's pending manifest.
3. **Turn boundary:** commit turn manifest; boundary re-scan of previously-seen+attributed paths to discover shell/MCP changes (new blobs for changed content; deletions recorded as `hash: null` with prior hash retained in the previous manifest).
4. **Manual:** "Save restore point" button → named checkpoint (same format).
5. **Run end:** retain run-start + last N turn checkpoints (default N=5); older turn checkpoints drop to manifests-only-then-garbage per §8.

---

## 5. Non-git workspaces and real-git isolation

- **Non-git:** journal is git-independent — identical behavior. This is the core advantage over OpenCode snapshots (conversation-only rollback outside a repo) and must be a first-class test target, not a fallback.
- **Real-git isolation:** capture/restore never invokes git on the user repo; never reads `.git/`; capture scope excludes `.git/` and `.llm_workspace/` explicitly. Restore writes worktree files only — history, index, branches untouched. Committing a restored state remains a deliberate user action via the existing `git_stage`/`git_commit` tools. Regression test: assert `git status --porcelain` + `git stash list` + `HEAD` identical before/after capture cycles, and index hash unchanged after restores.
- **Full-access disclosure:** an approved/`full_access` shell can reach app-data and destroy snapshots. Recovery defends against *accidents*, not against a user telling the agent to nuke its own safety net. Document, don't chase.

---

## 6. Capture boundaries and recovery guarantees

| Boundary | Reliability | Cost | Verdict |
|---|---|---|---|
| 1. Before a write-capable run | Exact full-scope manifest; single latency hit at run start | One hash walk over scope (bounded, §8) | **Phase 1.** Blocking on failure. |
| 2. Before/after each model step | Discovers shell/MCP final states; misses intra-command intermediates | Hash walk over attributed paths each turn (small) | **Phase 2.** Non-blocking; gaps disclosed in coverage. |
| 3. Before each native mutation | Exact before-images; 100% of native paths | One hash+copy per first-touch file (KBs) | **Phase 1.** On failure for a path: record `skipped`, mark checkpoint partial (see §7 policy). |
| 4. Before/after shell boundaries | Same as (2) but per-command; still misses intra-command states | Per-command walks multiply cost; races with still-running processes | **Defer.** 45 s timeout bounds commands; no background-shell primitive exists (§3.2), so per-turn scanning loses little vs per-command. Revisit only with evidence. |

**Long-running-shell case:** no `spawn`/background shell exists for agents — every shell invocation completes (or times out at 45 s) inside one turn. Per-turn boundary scans therefore observe every *completed* shell effect. The residual gap is strictly *intermediate* states within a single command (e.g. `cmd1 && rm -rf x && cmd2` where only the final state is recoverable). The honest guarantee: **final-state recovery for shell effects, exact-state recovery for native mutations.** No OS-level file interception is warranted — the architecture bounds the gap to intra-command intermediates, and step scans close everything else.

**Strongest honest guarantees ( Phase 1+2 ):**
- Existing tracked/untracked files mutated via native tools: restorable to pre-turn and run-start states. ✅
- Files created by the agent: removed on restore (recorded absent-before). ✅
- Deletions via native paths (`move` has no delete; shell `rm`): restorable from boundary-scan blobs; deletions *inside* one shell command after earlier commands in the same invocation: final-absence recorded, content from last manifest — ✅ with disclosure.
- Large/binary files: subject to caps; skipped files listed per checkpoint, never silently omitted. ✅-with-report
- Symlinks/modes: manifest records `lstat` kind + mode bits; restore recreates symlink vs file faithfully, refuses to follow pre-existing symlinks on write (reuse `scopedPath` discipline). ✅
- User/concurrent edits: mtime+hash compare at restore; mismatch → per-path confirm-or-skip, never silent overwrite. ✅
- Outside-workspace files, DB rows, network/process/remote effects: explicitly **not** covered. ✅-by-exclusion

---

## 7. Storage, retention, integrity, concurrency

- **Dedupe:** blob filename = `sha256(content)`; identical content across turns/files stored once. Journal cost scales with *changed bytes*, not turns.
- **Crash-safe ordering:** blob bytes → fsync → manifest row in SQLite transaction. A crash leaves at most unreferenced blobs (swept later); a manifest can never reference a missing blob.
- **Integrity:** rehash-on-read for restores; periodic `integrity_check` precedent exists (`dataMigration.js:95`). Corrupt blob → path reported unrestorable, restore continues for healthy paths.
- **GC:** mark (hashes referenced by retained checkpoints, computed inside a transaction) then sweep (delete unreferenced blob files). Retained = run-start + last N turns + manual points + checkpoints of active runs.
- **Concurrency:** restores serialize per session (mirror the `screenshotWrites` promise-chain pattern, `agentTools.js:371,403`); capture refuses while a restore is in flight and vice versa; user edits during capture are handled by re-verifying hash at manifest-commit (mismatch → path marked `raced`, checkpoint partial).
- **Metadata in SQLite, bytes outside it** (not blobs-in-DB): keeps `memory_palace.db` lean, avoids WAL bloat and backup pain, and lets the OS page blobs independently. Precedent: attachments/media already live as files with DB metadata (`fileUploads.js:118-129`).

---

## 8. Resource policy

- **Defaults (assumptions, to validate against real workloads in Phase 1 telemetry):** per-file 2 MiB (OpenCode parity), per-turn 50 files, journal cap 256 MB per app-data dir. Rationale: source files are KBs; a 20-file heavy turn ≈ 1 MB; 256 MB ≈ hundreds of heavy turns before pressure. **These are starting assumptions, not measurements** — log capture sizes per turn and revisit after representative runs.
- **At pressure:** evict oldest non-pinned turn checkpoints first; run-start and manual points are pinned (never auto-evicted); surface "snapshots before turn N evicted" in the restore UI.
- **Cap ≠ guarantee:** a storage cap bounds disk, it cannot promise every checkpoint exists. Policy: run-start failure blocks the run; mid-run per-path capture failure marks the checkpoint `complete:false` with `skipped[]` reasons and continues with a visible reduced-safety banner; user can abort the run from the banner. A checkpoint must never render as complete when `skipped` is non-empty.

---

## 9. Hybrid assessment

Recommended hybrid = **one store (journal) + two capture strategies (interception + boundary scan)**. It is justified because each strategy covers a failure class the other cannot: interception gives exactness for native tools (which scans can only approximate after the fact, and cannot attribute reliably when shell and native edits mix in one turn); scans give coverage for shell/MCP writes (which interception cannot see at all — MCP filesystem tools bypass every in-process check, `mcpManager.js:308-323`). Merging them into one manifest/restore engine avoids two retention/GC/UI systems. A shadow-git *store* alongside the journal would add git-version skew, ignore-rule duality, and real-repo-touch risk for no additional failure class covered — rejected.

---

## 10. Phased implementation (complexity, no fabricated benchmarks)

- **Phase 0 — hygiene (S, hours):** make `str_replace_editor` use `atomicWriteFile` (closes torn-write gap, §3.1 D2); exclude `.llm_workspace/` + `.git/` from any future capture scope constant.
- **Phase 1 — native journal + run-start + restore (M, 1–2 weeks):** blob store, manifest tables, `executeAgentTool` pre-mutation hook, run-start capture (blocking), selective + full-turn restore with conflict checks, restore UI beside transcript/activity views, settings (enable, cap). Manual restore points included.
- **Phase 2 — boundary scans + coverage UI (M, 1–2 weeks):** before-inference/after-settle hooks, attributed-path re-hash, `complete:false` + `skipped[]` reporting, reduced-safety banner, eviction notices.
- **Phase 3 — hardening (S–M):** retention/GC service, per-session pruning on delete, capture-size telemetry to validate §8 defaults, `git_commit`-as-restore-point optional integration.
- Explicitly out of scope: per-command shell wrapping, OS file interception, remote/side-effect reversal, `push/pull` assistance.

Complexity scale: S = days, M = 1–2 weeks for one engineer familiar with the tree. No execution benchmarks are quoted — capture cost must be measured per workload in Phase 1 telemetry (files/turn, bytes/turn, walk ms).

---

## 11. Test matrix

| Area | Cases |
|---|---|
| Successful recovery | Edit → restore turn; run-start restore after 5 mixed turns; created-file removal; moved-file round-trip |
| Deleted/untracked files | Shell-`rm` tracked file → restore; delete untracked file → restore; delete-then-recreate with different content → restores original, flags conflict |
| Shell mutations | `sed -i`/`tee`/`python` edits discovered at boundary; multi-command one-liner intermediate-state disclosure; timeout-killed command (45 s) partial effects |
| Concurrent edits | User modifies file between capture and restore → per-path confirm/skip, no silent overwrite; user edit between pre-image and manifest-commit → `raced` marking |
| Interrupted writes | Kill mid-restore → per-file atomicity holds, resume/report; crash between blob write and manifest commit → GC sweeps orphan, no dangling refs |
| Storage exhaustion | T
...[truncated 1537 chars]