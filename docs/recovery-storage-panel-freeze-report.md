# Workspace Recovery — Storage Panel Freeze Fix

**Scope:** stop the Storage & Data panel from freezing the whole app. One new source file (`src/main/recoveryReferenceIndex.js`), one changed source file (`src/main/recoveryStore.js`), one new test file (`tests/recoveryReferenceIndex.test.cjs`), one startup hook (`main.js`). No architecture change, no new dependencies.

## 1. The bug

Opening Settings → Storage & Data called `recoveryStore.getRecoveryStats()`, which ran on the Electron **main** process and:

1. read every `recovery_checkpoints.manifest_json` row — **632 MB** across 1,164 rows,
2. `JSON.parse`d all of them and walked **2,819,815** path records,
3. built a map of the referenced blobs.

Measured on the live install: **5,058 ms** (1,546 ms read + 3,493 ms parse) of uninterrupted main-thread block, and 1.29 GB RSS. `JSON.parse` is synchronous, so the event loop never turned: the window stopped painting, IPC stopped being served, and the app looked dead for several seconds. Closing and reopening the panel repeated it, because the panel remounts and re-requests the stats.

`pruneRecovery` ("Clean up now") was worse: it called `getRecoveryStats()` up to 3× **and** ran `gcRecoveryBlobs`, which parsed every manifest again to mark the referenced set — roughly 20 s of main-thread block.

Every other Storage-tab IPC was cheap: `getConfig` 0 ms, `getAppSettings` 2 ms, `getTokenHistory` 22 ms, `listProjects` 1 ms.

## 2. The fix

**`recovery_blobs.refcount`** — how many checkpoints reference each blob — is maintained incrementally, so the panel's questions are answered from one aggregate query over the blob table instead of from the whole history.

- A checkpoint's referenced set is fixed at creation: `finalizeBoundaryCheckpoint` only appends `absent` records and `recordOpPostState` only rewrites `op_json`, so neither can add or remove a file record. The refcount therefore changes only when a checkpoint is created or deleted.
- Capture and scan-commit bump the refcounts **inside the same transaction** as the checkpoint row.
- `deleteCheckpoints` decrements them from the manifest of the checkpoint being removed, and only for checkpoints that were actually counted.
- The index's own state is `recovery_indexed_checkpoints` (a side table). It is a side table rather than a column on `recovery_checkpoints` because a checkpoint row carries its whole manifest: updating any column of such a row makes SQLite rewrite all of it — measured **4.7 s** for one install's history, against **3 ms** for the side table.

Existing installs have no index, so it is built once by walking the manifests. The build is time-boxed (a batch never holds the main thread longer than 20 ms), yields to the event loop between batches, and applies its counts in a single transaction at the end. Until it finishes, the panel falls back to a conservative reading — every known blob counts as referenced — so the numbers never understate the data at risk.

**What the refcount is trusted with, and what it is not:** the storage panel's numbers (referenced blobs, bytes of history). It is deliberately **not** trusted to decide which blob bytes to delete — cleanup still derives the referenced set from the manifests themselves, exactly as before. A counter that drifts can therefore cost a display error, never deleted recovery data. Test 10 locks the invariant: the refcounts always equal what the manifests say.

The old stats path also walked the blob store one `stat` at a time (10,604 sequential awaits). That walk is now bounded-concurrency, and its accumulator is read *after* each `await` — folding the `await` into the expression made parallel workers clobber each other's totals.

## 3. Before / after (live install: 1,164 checkpoints, 632 MB of manifests, 10,626 blobs)

| operation | before | after |
|---|---|---|
| `getRecoveryStats()` (panel open) | **5,058 ms**, main thread blocked | **10 ms**, no block over 3 ms |
| worst main-thread stall, panel open | 5,058 ms | 3 ms |
| `pruneRecovery` ("Clean up now") | ~20 s blocked | 12 s wall clock, worst stall **74 ms** |
| reference index build (once, at startup) | n/a | 5.4 s background, worst stall **38 ms** |

The numbers agree exactly: before and after report the same 10,626 referenced blobs and the same logical byte total (verified against a full manifest scan on the live data).

## 4. Verification

- `tests/recoveryReferenceIndex.test.cjs` (new, 10 tests): the stats path never parses a manifest (asserted by watching `JSON.parse`), shared blobs are counted once per checkpoint, capture/delete/prune keep the counts in step, a legacy checkpoint is indexed by the build and then matches a manifest scan, an incomplete index falls back conservatively, cleanup never collects a referenced blob, and the refcounts always match the manifests.
- `tests/recoveryStore.test.cjs`, `tests/recoveryIpc.test.cjs`, `tests/recoveryBoundary.test.cjs`: 58/58 pass unchanged.
- `tests/recoveryStorageSettings.ui.cjs` (Electron runtime): passes.
- Full suite: no new failures (12 pre-existing failures, unrelated — MCP/config/ipc test-isolation issues present before this change).

## 5. Notes for the next change

- `recovery_checkpoint_blobs` (an abandoned reference-table attempt) is dropped by the schema setup; it was empty and unread.
- The panel's `logicalBytes` and `physicalBytes` are equal on a store where every blob is referenced. That is correct, not a bug: `logicalBytes` counts each distinct referenced blob once.
- The build is not resumable across a restart (it restarts from the beginning). This is safe — until its final transaction runs, nothing is marked and no count is applied — but a user who quits the app within ~5 s of the update will repeat it next launch. The app is fully usable throughout.
- `index.build({ rebuild: true })` throws the index away and counts every checkpoint from its manifests again. That is the repair path for an index that was built by something else, or that drifted.
- `refcount` counts the **checkpoints** that reference a blob, not the path references: a blob referenced by three paths in one checkpoint counts once. The panel's totals are the same as before either way, because both count each distinct blob once.
