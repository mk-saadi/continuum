# Workspace Recovery — Phase 1 Performance Report: Scan Overhead

**Scope:** measure and reduce Workspace Recovery boundary-scan overhead (shell/MCP pre-scan → op → post-scan). One app source file changed (`src/main/recoveryStore.js`); no architecture change, no new dependencies, no model inference. Working tree was committed to `main` (`daffdfe`) before any edit; all prior reports and evidence intact. `/tmp/opencode/` untouched (benchmarks used `/tmp/rec-bench/` scratch + `os.tmpdir()` fixtures only).

## 1. Proven bottleneck and how it was measured

**Bottleneck: per-file ancestor re-validation — O(depth) `lstat`+`realpath` per file per scan.**

`recordPath` called `assertParentsContained` for every file, which ran `lstat` + `realpath` on every ancestor. Siblings re-validated the same ancestors: a depth-3 tree paid ~3 ancestor lstats + ~3 realpaths per file on top of the file's own lstat. Measured on the 4,504-file fixture, warm scan of an unchanged tree (fast path active, zero content reads):

| syscall (warm) | pre | post |
|---|---|---|
| `lstat` (workspace) | 18,525 | 4,878 |
| `realpath` (workspace) | 13,835 | 188 |
| `readdir` / entries | 188 / 4,691 | same |
| blob `stat` (fast-path checks) | 4,504 | same |
| content `readFile` | 0 | 0 |

Instrumentation: the benchmark wraps `node:fs/promises` methods before loading the store and classifies calls by path (workspace vs blob dir vs db); better-sqlite3 is synchronous and therefore absent from these counts — DB costs were split separately (see §3). `realpath` resolves symlinks component-by-component, making it the slowest call in the mix; event-loop per-await overhead multiplies across ~37k sequential awaits (the walk is fully sequential).

Second-order costs, measured by direct attribution probe (`/tmp/rec-bench/attr.cjs`, 1,500-file fixture):
- `commitScanResult` 40ms ≈ 23ms per-row `prepare()` of one repeated statement + 5ms index DELETE+reinsert + 1ms manifest stringify + ~11ms checkpoint INSERT.
- `finalizeBoundaryCheckpoint` 8–24ms ≈ full manifest re-parse + re-serialization + full-row UPDATE even when the manifest did not change.

## 2. Baseline vs post-change (2 runs each, separate fixtures per run)

Environment: Node v22.23.2, Linux, `/tmp` on ext4 (NVMe, not tmpfs). Harness: `/tmp/rec-bench/bench.cjs` (electron mock + isolated DB, same conventions as `tests/recovery*.test.cjs`). Pre-change runs used a pristine `git worktree` at the pre-edit commit `daffdfe`; the working tree was never stashed or modified for measurement.

Fixtures (deterministic content, `fs.writeFileSync`):
- **small:** 150 files / 153,600 B / depth 1.
- **medium:** 1,500 scanned files × ~2 KB + 200 scope-excluded `node_modules` files + 3 MiB over-cap `big.bin` (honest partial) / 6,145,728 B / depth 1. Mirrors boundary test 19.
- **large:** 4,504 files (4,500 in `a/b/c/` depth-3 tree, sizes 0.5–8.5 KB) + 4 × 1.5 MiB under-cap binaries / 26,542,902 B / depth 3.

| case (ms) | medium pre | medium post | large pre | large post |
|---|---|---|---|---|
| cold scan | 515, 575 | 495, 496 | 4144, 4494 | 4233, 3722 |
| warm scan | 162, 177 | 122, 117 | 962, 911 | 413, 396 |
| warm median (5×) | 167 | 136 | 838 | 433 |
| 5 modified files | 167, 169 | 144, 134 | 840, 881 | 487, 419 |
| 10 created + 5 deleted | 161, 175 | 153, 126 | 887, 891 | 433, 423 |
| shell boundary (`withShellRecovery`, real `sh` op) | 392, 415 | 319, 282 | 1833, 2009 | 852, 826 |
| mocked MCP boundary (`withMcpRecovery`) | 380, 401 | 289, 274 | 1828, 2051 | 837, 790 |
| split: pre / commit / post / finalize (large) | 863 / 118 / 927 / 20 and 962 / 132 / 951 / 24 | 465 / 16 / 472 / 6 and 371 / 13 / 393 / 34 | | |

Headline: **large shell/MCP boundary ~2.2–2.3× faster (1833→852ms); warm scan 2.3×; commit 8× (118→16ms).** Cold scans unchanged within noise (hashing + first-write I/O dominate, as expected). Small-fixture numbers are noise-dominated (±30ms) with no post-change regression.

One honest counter-note: `finalize` on large is ~10ms slower (20–24 → 28–34ms) because manifest records gained one field (`ctimeMs`, §4) — ~1% of the boundary, dwarfed by the scan/commit wins.

## 3. What changed and why (`src/main/recoveryStore.js`, +110/−34)

1. **Per-scan ancestor-validation cache** (`assertParentsContained(root, rel, validated?)`). Walks are top-down, so each ancestor is validated once per scan when its directory is entered; siblings reuse the verdict via a `Set` created fresh per `scanWorkspaceState`/`captureOperation` call. Every ancestor of every recorded path is still checked once per scan — deduplicated, never skipped. Restore-time checks (`resolveRestoreTarget`) omit the cache and re-validate fully, as before.
2. **Per-scan blob-shard `mkdir` skip** (`putBlob(bytes, {knownShards})`). `mkdir --recursive` on an existing shard is a wasted syscall per new blob (~4.5k on a cold large scan). Idempotent; single-path callers omit it and behave exactly as before.
3. **Skip identical index rewrites** (`indexRecordsEqual` + conditional `saveWorkspaceIndex`). The index is documented as a pure cache; skipping a content-identical DELETE+reinsert (measured 5ms/1.5k rows, scales linearly) is observably equivalent.
4. **Batched blob-row inserts** (`insertBlobRows`, 500/chunk, hoisted prepare). Measured 23ms → 1ms per 1,500 rows. `INSERT OR IGNORE` semantics kept, so crash-orphaned rows (blob file present, row missing) are still healed by the next commit — pinned by new test 11.
5. **Skip manifest rewrite in `finalizeBoundaryCheckpoint`** when no created/renamed entries were added (modify-only boundaries, the common shell case): `op_json`-only UPDATE instead of full manifest re-serialization + row rewrite. Pinned by new test 6 asserting byte-identical `manifest_json`.
6. **Duplicate `createManualCheckpoint` definition removed** (two byte-identical copies; one kept, verified single definition + all callers green).
7. **`ctimeMs` joins the index fast-path triple** (size, mtime, ctime) with an `ALTER TABLE … ADD COLUMN` migration in `ensureRecoverySchema` (same PRAGMA-guarded pattern as `pinned`). Pre-migration NULL rows always miss — safe direction.

## 4. Why recovery semantics remain intact

- Pre-state durability, failed-op retention, post-failure pre-state validity, required-path blocking, cap overflow→disclosed partial, skip-class honesty (`too_large`/`unreadable`/`unsupported`/`escape`/`cap_exceeded`), symlink containment, blob verification, GC mark-and-sweep, and restore conflict rules: **no logic touched**. The diff is caching, batching, and write-skipping only.
- Fast-path hits still require live `blobExists`; GC still deletes rowless blob files, and commits still re-insert every referenced hash (test 11).
- mtime-index hardening (§3.7) strictly *narrows* trust: previously `(size, mtime)` sufficed; now `(size, mtime, ctime)` is required. `ctime` cannot be set by writers — content changed under a preserved mtime (same size) now forces a rehash instead of trusting a stale entry (new test 4 proves detection + both-states restore). Residual: same-tick double writes with a forced mtime (documented, vanishingly rare).
- Ancestor cache: containment verdicts never outlive the scan; TOCTOU class unchanged (the readdir→lstat race already made checks point-in-time). Worst case of a mid-scan swap is identical in kind to pre-existing behavior, and plant-and-swap requires workspace write access the attacker could use directly.
- New `tests/recoveryScanPerf.test.cjs` (11/11): index reuse + byte-correct manifests, `indexRecordsEqual` units (incl. NULL-ctime legacy rows), same-size change, mtime-preserved change via ctime, create/delete + dir create/rename/remove with restore, finalize-manifest-untouched, skip-class honesty, escape rejection with a warm ancestor cache (test 8), boundary refusal without running the op, post-failure pre-state restore, blob-row healing.

## 5. Filesystem / cache assumptions

- `stat.ctimeMs` available with meaningful granularity (Linux ext4/tmpfs: yes; verified on the ext4 bench volume). A filesystem without ctime degrades to extra rehashes, never to false trust.
- `Math.floor` ms precision matches existing mtime handling.
- The per-scan `validated` set assumes a single scan walks a single realpath'd root (true for both entry points).
- Page cache was not dropped between runs; cold = first scan after fixture creation, warm = subsequent. Fixtures were regenerated per run, and pre/post runs interleaved identically, so cache effects apply equally to both sides.

## 6. Verification (exact)

- New: `node --test tests/recoveryScanPerf.test.cjs` → **11/11**.
- Recovery set post-change: store 20/20, boundary 20/20, postState 8/8, ipc 13/13, agentTools + scanPerf → **73/73**; same set on pristine pre-change worktree → **62/62** (62 = 73 − 11 new). Zero regressions.
- Broader: toolPermissions, permissionPolicy, subagent budgets/reliability/display, toolDisplay, mcpPermissions → **59/59**; agentTools, toolPermissions, mcpManager, gitTools → **32/32**.
- `npx vite build` → ✓ 8.95s. `git diff --check` → clean.
- Benchmarks: `/tmp/rec-bench/bench.cjs` (+`attr.cjs` probe); raw JSON runs kept at `/tmp/rec-bench/pre-run{1,2}.stdout.json`, `post-run{1,2}.stdout.json`. Machine-readable evidence: `docs/recovery-phase1-perf-evidence.json`.

## 7. Known limitations and deferred follow-ups (not addressed)

- Cold scans (~4.2s at 4.5k files / 26 MB) are hashing + first-write bound; further wins need pipelined hashing or fewer blob fsyncs — out of scope under durability guarantees.
- `finalize` +~10ms on large from the wider record (see §2).
- `diffStates` rename pairing stays O(deletes × creates) with a `findIndex` splice; negligible at observed sizes.
- The walk is still fully sequential awaits; bounded-concurrency traversal is future work (kept sequential deliberately: deterministic order, simple cap handling).
- Deferred per the phase brief (untouched): inactive-tab mounting, Memory Palace 2s polling, `TabContext` fan-out, subagent retention maps, session-history queries, attachment N+1, transcript virtualization/markdown costs, bundle code-splitting.
