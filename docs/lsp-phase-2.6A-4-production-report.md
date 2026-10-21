# Phase 2.6A-4 — LSP production hardening, packaging, stability and performance

## 1. Executive summary

Phase 2.6A-4 audited, hardened and verified the existing JavaScript/TypeScript LSP
integration. The Phase 2.6A-1/2/3 architecture was **kept**: one main-process
manager, a workspace-scoped server registry, a read-only adapter with immutable
pagination snapshots, and six native agent tools. No architecture was replaced.

Nine concrete defects were found, all with reproducible evidence, and all were
fixed inside the existing architecture. The two that would have broken ordinary
desktop use were:

* **The open-document budget had no eviction.** After 128 distinct files, every
  new file query failed with `DOCUMENT_LIMIT` for the remainder of the session.
* **A crashed language server poisoned its workspace permanently.** Every later
  query for that workspace failed with `SERVER_UNAVAILABLE`; no restart existed.

A third, **quitting the application while a server was still initializing
blocked for the full 20-second initialization timeout**, was also fixed.

The packaged Electron build was verified end to end: the bundled
`typescript-language-server` resolves out of `app.asar.unpacked`, starts under
the packaged Electron runtime, answers all six operations with real semantic
results, returns diagnostics, and shuts down with no surviving process.

**Status: implemented and verified on Linux (development and packaged runtime).
Windows and macOS packaged runtimes are not tested — this host cannot build or
execute them.** The JS/TS LSP implementation is ready for a real Continuum
benchmark on Linux, with the manual platform checklist in section 28 still
outstanding for Windows and macOS.

## 2. Repository baseline

| Item | Value |
| --- | --- |
| Commit | `f426392` (`feat: phase 3 of LSP completed`) |
| Branch | `main` |
| Working tree at entry | **clean** — no uncommitted work to preserve |
| Node / npm | v22.23.2 / 10.9.8 |
| Electron | 44.7.0 (bundled Node 24.21.0) |
| Host | Linux 6.17.9 x86_64, 8 CPUs, 16.58 GiB RAM, Xvfb for UI tests |

Baseline suite (`node --test tests/*.test.cjs tests/*.test.mjs`):

| Run | Tests | Pass | Fail |
| --- | ---: | ---: | ---: |
| A | 1483 | 1458 | 25 |
| B | 1483 | 1456 | 27 |

The two extra failures in run B are **pre-existing flakiness under parallel
load** (`tests/subagentModelSelection.test.cjs` — "7. interrupt and resume keep
the child on the model it started with" and "8. a cloud model still gets the
read-only child allowlist"). Both pass in isolation and both appeared in the
Phase 3 baseline as well. The **25 stable failure identities** are unchanged
and are listed in `docs/lsp-phase-2.6A-4-evidence.json`. No unrelated failure
was fixed and no unrelated change was made.

Dependencies and packaging configuration were **not** changed in this phase:
`typescript-language-server` 4.3.4, `typescript` 5.7.3, `vscode-jsonrpc` 8.2.1
(≈24.6 MiB installed) remain the production set.

## 3. Architecture audit

The Phase 1–3 structure was confirmed against the source, not the reports:

* `src/main/lspManager.js` — JSON-RPC transport, workspace server registry,
  document synchronization, diagnostics publications, lifecycle and shutdown.
  Main process only; no IPC surface and no renderer-controlled executable.
* `src/main/lspCodeIntelligence.js` — the read-only adapter: normalized
  locations, bounded results, immutable pagination snapshots, diagnostic
  freshness states.
* `src/main/lspExecutionContext.js` — trusted live authorization state for main
  runs and children.
* `src/main/tools/lspTools.js` — schemas, strict validation, dispatch glue.
* `src/main/tools/agentTools.js` — native registration and dispatch.
* `src/main/subagents/agentLoop.js`, `continuationManager.js` — child runtime,
  allowlist, budgets, deadlines, recovery.

Confirmed unchanged and correct:

* One Electron desktop application; no hosted infrastructure, no always-on
  daemon, no installation service, no runtime download.
* Language servers start on demand, only for an authorized workspace.
* Main process owns every child process; the LSP registry is shared per
  canonical workspace root.
* The request method set is a fixed allowlist (`textDocument/definition`,
  `references`, `documentSymbol`, `hover`, `workspace/symbol`). `workspace/executeCommand`,
  code actions and formatting are never reachable.
* The model cannot supply an executable, a method, a URI, a root or a
  permission object.

## 4. Packaging configuration

`package.json` → `build`:

| Setting | Value |
| --- | --- |
| `files` | `dist/**/*`, `assets/continuum-notification.png`, `main.js`, `src/main/**/*.js`, `src/preload.js`, `preload.js`, `src/lib/**/*.mjs`, `src/lib/**/*.cjs`, `src/lib/**/*.json` |
| `asarUnpack` | `node_modules/@playwright/**/*`, `node_modules/playwright*/**/*`, `node_modules/typescript-language-server/**/*`, `node_modules/typescript/**/*` |
| `linux.target` | `AppImage`, `deb` |

Verified in the produced artifact (`release/lsp4-linux/linux-unpacked`):

* `resources/app.asar.unpacked/node_modules/typescript-language-server/lib/cli.mjs` — present, executable.
* `resources/app.asar.unpacked/node_modules/typescript/lib/tsserver.js` — present.
* `resources/app.asar` — contains `main.js`, `src/main/**`, `src/lib/lspToolLabels.json`,
  `src/lib/permissionModes.json` and `node_modules/vscode-jsonrpc` (main process only).
* `node_modules` contains **production dependencies only** (`better-sqlite3`
  present, `electron-builder` absent).
* The packaged `continuum` binary's `RunAsNode` fuse is **enabled**
  (`@electron/fuses` wire value 49 → bit 0 set), so `ELECTRON_RUN_AS_NODE=1`
  works. Confirmed empirically, not assumed.

`require.resolve` is evaluated inside the packaged main process, so it resolves
through `app.asar/node_modules/...`; `runtimePath()` maps that to
`app.asar.unpacked/node_modules/...`, where the files really exist. An
asar-less build keeps its plain paths (covered by a deterministic test).

## 5. Dependency resolution

* No global npm package is used: the executable path is always
  `require.resolve('typescript-language-server/lib/cli.mjs')` inside the
  application's own dependency tree. A packaging test asserts that the resolved
  paths are under the repository `node_modules` and never a global prefix.
* `disableAutomaticTypingAcquisition: true` and an explicit
  `tsserver.path` are sent in `initializationOptions`, so the server never
  invokes npm to fetch a TypeScript release.
* The server is launched as `process.execPath` + the bundled CLI + `--stdio`
  with `ELECTRON_RUN_AS_NODE=1`, cleared `NODE_OPTIONS`/`NODE_PATH`, no shell,
  and a hidden console on Windows. In a packaged build `process.execPath` is
  the application binary, so the language server is the application's own
  runtime — the user never runs `npm install`.
* `maxTsServerMemory: 512` caps the tsserver heap per process.
* Paths containing spaces work: the packaged smoke fixture deliberately uses a
  workspace directory named `workspace with spaces`.
* A read-only installation directory is not written to by the launcher; the
  only writes are the server's own cancellation pipes in the system temp
  directory.

## 6. Packaged runtime results

`scripts/lsp-packaged-smoke.cjs` runs **the packaged Electron binary** as a
Node host and drives **the packaged application code inside `app.asar`**
against a temporary JS/TS workspace.

```
ELECTRON_RUN_AS_NODE=1 release/lsp4-linux/linux-unpacked/continuum \
  scripts/lsp-packaged-smoke.cjs release/lsp4-linux/linux-unpacked
```

Result: **pass**.

| Check | Result |
| --- | --- |
| Application code loaded from `app.asar` | yes |
| Server state after start | `ready` (106 ms) |
| Spawned CLI | `<app.asar.unpacked>/node_modules/typescript-language-server/lib/cli.mjs` `--stdio` |
| Spawned tsserver path | `<app.asar.unpacked>/node_modules/typescript/lib/tsserver.js` — exists on disk |
| Definition | 598 bytes, 283 ms |
| References (page 1 / page 2) | 1317 / 1335 bytes, 33 ms / 0.15 ms, same snapshot |
| Hover | 347 bytes, 20 ms |
| Document symbols | 948 bytes, 12 ms |
| Workspace symbols | 519 bytes, 5 ms |
| Diagnostics | 4801 bytes, 297 ms, state `stale`, **22 findings** |
| JS and TSX document symbols | 666 / 667 bytes |
| Shutdown | 7 ms, 0 instances, **server process gone** |
| Orphans | none |

The packaged Electron application itself was also launched under Xvfb from the
same artifact: it started, created its user-data directory and ran until it was
terminated, with no orphaned language server left behind.

## 7. Platform verification matrix

| Platform | Development | Packaged runtime | Notes |
| --- | --- | --- | --- |
| Linux x86_64 | **verified** | **verified** | Full suite, Electron UI tests, packaged smoke, benchmark |
| Windows x86_64 | **not tested** | **not tested** | No Windows host. Configuration inspected; `taskkill /T /F` cleanup path is unchanged code |
| macOS (arm64/x64) | **not tested** | **not tested** | No macOS host. `runAsNode` fuse is on by default but was not verified on a signed/notarised bundle |

A successful Vite or electron-builder run is **not** treated as proof that an
installed application launches its language server. Only the packaged smoke
harness above is counted as packaged-runtime evidence, and it is counted for
Linux only.

## 8. Startup and shutdown reliability

* **Lazy start.** No server process exists until the first authorized LSP
  query. Verified: a denied mode starts nothing (test *a denied mode never
  starts a language server*).
* **Concurrent startup suppression.** A second caller for the same root awaits
  the first entry's start promise; the server is launched once (asserted in the
  shared-server concurrency test).
* **Initialization timeout / failure.** A server that never answers `initialize`
  fails with `INITIALIZATION_FAILED` and its entry stays failed until it is
  closed. A missing executable fails the same way and leaves no child.
* **Shutdown handshake.** `shutdown` → `exit` → client terminate → wait for the
  child → forced group kill as a fallback.
* **Fixed defect D2.** `closeRoot()` used to await the pending `initialize`
  request, so quitting during initialization blocked for the full 20 s
  initialization timeout (`probe: closeRoot took 19961.6 ms`). The client is now
  terminated first when the entry never reached `ready`, which aborts the
  pending request. The regression test asserts the close completes in under
  2 s with a 20 s initialization timeout configured.
* **Application shutdown.** `main.js` `before-quit` already awaits
  `Promise.allSettled([mcpManager.close(), lspManager.manager.close()])`. With
  D2 fixed, that await is bounded by the shutdown timeout (1.5 s) and not by
  the initialization timeout.
* **No orphans.** After a normal close: 0 manager instances, 0 language-server
  processes, 0 tsserver processes (measured, section 19). This is asserted by
  the stress test, the language-coverage test, the agent test and the packaged
  smoke harness.
* **Rapid start/stop.** Eight consecutive acquire/close cycles leave no stale
  entry and no surviving child.

## 9. Crash recovery

* A server that exits unexpectedly marks its entry `failed`. Diagnostics are
  dropped; the failed entry never serves a result.
* **Fixed defect D3.** Before the fix, the workspace was poisoned permanently
  (`probe: reacquire FAILED code = SERVER_UNAVAILABLE`; no second server was
  ever spawned). Now a server that had reached `ready` is restarted **on
  demand** within a strictly bounded budget of **3 restarts per workspace
  root**; the budget is never reset, so there is no restart loop. A server that
  died *during* initialization is not restartable — a broken or missing
  executable will not fix itself, and repeated spawn attempts would be
  pointless process churn.
* The replacement is a **fresh entry**. That matters: reusing the old entry
  would have sent `didChange` for documents the new server never opened, so
  the new server would have had no content at all. The regression test asserts
  the restarted server receives exactly one `didOpen` and no `didChange`.
* No stale request is replayed. The next caller re-issues its own query; the
  previous request fails with `SERVER_UNAVAILABLE`.
* Snapshots that referenced the dead entry are invalidated: the cursor is
  reported as `STALE_CURSOR`, and the adapter prunes snapshots whose entry is
  no longer ready.

## 10. Workspace concurrency

Verified with two workspaces and several callers:

| Requirement | Result |
| --- | --- |
| No response crosses caller boundaries | Verified — every location is re-authorized against the caller's own workspace root |
| No incorrect request correlation | Verified — the JSON-RPC layer correlates by id; the duplicate-response filter was re-tested |
| No unauthorized workspace access | Verified — a file that exists only in the other workspace answers `LSP_FILE_NOT_FOUND`; a location in the other workspace is excluded and counted in `excludedCount` |
| No duplicate server launches for the same workspace | Verified — one instance and one process per canonical root |
| No accidental shutdown of a shared server | **Improved (D5)** — only a definite authorization failure retires the shared server now; a transient filesystem/database error fails one call only |
| No stale document updates applied out of order | Verified — document versions increase monotonically under concurrent edits, and the open document always matches the file on disk |

**Known, deliberate behaviour:** a permission *downgrade* closes the shared
workspace server conservatively. That is a deliberate revocation decision, not
an accident, and it does interrupt eligible peers; peers reacquire on demand
and the next query restarts the server. This was Phase 3's documented
behaviour and is preserved here deliberately.

Requests are **serialized per workspace** so that a document snapshot cannot
change under an operation. Distinct workspaces proceed concurrently. This is
visible in the measurements: with 12 concurrent calls against two workspaces
the per-call p95 is 390 ms because six calls queue behind each other in each
workspace, while a single caller's p95 is under 15 ms.

## 11. Subagent concurrency

| Case | Result |
| --- | --- |
| Authorized child receives the six tools | Verified — the child's model payload advertises all six |
| Definition, references and diagnostics in a child | Verified — three real tool results in the child's own transcript |
| Result returned to the parent | Verified — the parent receives the child's bounded answer |
| Activity attribution | Verified — the child's activity carries the three LSP tool results with durations; the parent's activity is untouched |
| Cancelling one child | Verified — the cancelled child fails, its peer completes normally |
| Surviving child continues | Verified — the shared server stays `ready` and the peer finishes |
| Child permissions independent | Verified — the child ceiling is Workspace Write even under a Full Access parent; Read Only and Ask for Permission children are denied |
| Deadlines and budgets | Unchanged — no Phase 4 change to budgets, deadlines or the scheduler |

No automatic subagent spawning was introduced for LSP queries.

## 12. Permission enforcement

The required matrix is enforced and was tested at every layer.

| Mode | Tool advertisement | Native dispatcher | Adapter | Manager / server startup | Query execution |
| --- | --- | --- | --- | --- | --- |
| Read Only | hidden | denied | denied | denied | denied |
| Ask for Permission | hidden | denied | denied | denied | denied |
| Workspace Write | advertised | allowed | allowed | allowed | allowed |
| Full Access | advertised | allowed | allowed | allowed | allowed |

* Advertisement: `promptBuilder.getToolContext` and the `agent:get-tools` IPC
  filter by the live permission mode and by workspace presence.
* Dispatcher: `executeLspTool` requires a **trusted** context object (weak-set
  membership, not a model argument), the current mode, and the canonical
  `guardTool` decision. A plain object with `permissionMode: 'full_access'`
  is denied.
* Adapter and manager: `LspCodeIntelligence.run` and `LspManager.identity`
  resolve the session → project → root independently, so a forged call cannot
  skip a layer.
* Server startup: the server is only launched from an authorized identity.
* Shared server access: authorization is per caller, re-checked before the
  request, every 25 ms during the request, and again afterwards.
* Continuation cursors: the cursor path re-runs `manager.check`, so a
  downgraded caller cannot continue a snapshot.
* Runtime transitions: `engine:set-permission-mode` updates the live policy;
  the downgrade cancels the pending query and denies later work (verified in
  both the agent path and the manager path).

**Revocation guarantees that actually hold:**

1. A downgrade denies the *downgraded caller* immediately — before, during and
   after any request. Nothing is delivered to it.
2. A downgrade also retires the shared workspace server, so the downgraded
   caller's open documents are closed on the server.
3. Other callers of the same workspace are interrupted by (2) and must
   reacquire; their own authorization is unchanged and is re-checked on the
   next request.
4. A cached or running server never grants access on its own: every request
   path re-authorizes the caller, and the server itself has no notion of
   identity.
5. A child never inherits more than its own approved ceiling, and a downgraded
   parent denies its children as well.

## 13. Recovered-child authorization

Phase 3 reported that a recovered child was denied LSP until trusted runtime
code authorized it again. The behaviour was safe but left recovery
permanently degraded.

**Fixed defect D9.** `recoverChild` now re-authorizes the recovered child with
exactly the rule a fresh spawn uses:

* the default child ceiling — **Workspace Write**, never Full Access;
* only when the owning parent is **currently** eligible;
* nothing is restored because a previous run had it.

A recovered child of a downgraded parent stays denied (verified). The child's
workspace is still the owning parent's project, never a model-supplied root.
Separately, **D8**: when a child's live record is removed, its LSP
authorization is revoked and any surviving reference to the context is
demoted to Read Only, so a stale handle cannot keep acting.

## 14. Document synchronization

The realistic workflow was exercised end to end against the real server:

1. read a TypeScript file — content hash and version 1 recorded;
2. modify it — the next query re-reads, re-hashes, and the version advances to
   2 with one `didChange`;
3. query its symbols — the current content is used;
4. introduce a type error — the next `lsp_diagnostics` reports it;
5. request diagnostics — bounded wait, findings returned with an honest state;
6. correct the error — the publication is invalidated and the file is
   re-synchronized;
7. request diagnostics again — the corrected file is reported;
8. rename through the existing authorized file tool — the old path closes, the
   new path opens;
9. delete a file — the document is closed and its diagnostics dropped;
10. restore a file — it is opened again with a fresh version;
11. modify a file externally — the next query picks up the new content;
12. query the changed file again — the current content is used.

Requirements confirmed:

* Queries use current file contents (the refresh pass precedes every query and
  the post-response pass rejects `STALE_RESULT` if anything changed during the
  request).
* Document versions progress correctly and monotonically.
* The hash-based unchanged check remains effective (an unchanged file does not
  advance the version or produce a notification).
* Removed files do not remain visible as current documents.
* Reopened files synchronize correctly (`didOpen`, fresh version).
* A server restart invalidates obsolete document state (the replacement entry
  starts with an empty document set).
* Concurrent updates are ordered safely (the per-workspace queue plus
  monotonic versions).

**Fixed defect D1 — bounded eviction.** The open-document set is now bounded
by evicting the **least recently queried** document (a `didClose` is sent), so
a long session can keep opening new files instead of failing every query from
the 129th file onwards. Only targeted queries count as use, so the bulk
refresh pass does not distort the eviction order.

## 15. Diagnostic freshness limitations

The four states `ready` / `pending` / `stale` / `unavailable` are preserved
exactly.

**Fixed defect D4 — the bounded wait.** The adapter used to read the
publication map immediately after opening the document, so it almost always
answered `pending` with zero findings. Measured in the packaged runtime before
the fix: `diagnosticState: pending, diagnosticCount: 0` for a file with a known
type error. After the fix: `diagnosticState: stale, diagnosticCount: 22`.

The wait is an **event wait with a deadline** on the manager's per-document
publication event. It is not a polling loop and not a fixed sleep; it ends on
the publication, on cancellation, or at the deadline (1500 ms by default,
internal and not model-controllable). It is performed outside the workspace
queue so it does not hold up other callers.

The honest limitations remain:

* The bundled server publishes **unversioned** diagnostics, so a publication
  cannot prove it corresponds to the newest content. Those results are
  reported as **`stale`**, never as `ready`. Only a version-matched
  publication is `ready`.
* `pending` means "no publication yet". It is never presented as a clean file.
* A failed analysis is never presented as zero errors: the state would be
  `unavailable` or the request would fail.
* **A clean file-level result never proves a clean project.** A page covers one
  file; the diagnostics state describes that file only.
* Documents that cannot be analyzed report `unavailable` (server not ready) or
  an explicit error.

## 16. Pagination consistency

| Property | Result |
| --- | --- |
| Stable ordering | Verified — results are sorted by path, then line, then column, then a stable JSON tiebreak |
| Accurate page counts | Verified — `totalCount`, `returnedCount`, `hasMore` |
| Correct continuation cursors | Verified — the cursor offset is exactly the number of returned rows; no row is skipped when a page is shortened by the output budget |
| Snapshot preservation | Verified — `snapshotId`, `observedAt`, `sourceVersion` and `provenance` are identical across pages |
| Expiration | Verified — an expired cursor answers `STALE_CURSOR`, distinct from `INVALID_CURSOR` |
| Memory limits | Verified — at most 16 snapshots, 2000 results and 4 MiB of snapshot bytes; the eviction is FIFO and the total is asserted |
| Cursor ownership | Verified — a cursor is bound to its operation, its workspace and its snapshot; a foreign cursor answers `INVALID_CURSOR` |
| Permission changes | Verified — the cursor path re-runs the authorization check; a downgraded caller is denied |
| Stale cursors | Verified — a cursor whose workspace server restarted answers `STALE_CURSOR` |
| Server restart | Verified — the new entry has a different identity, so old cursors are stale |
| Workspace closure | Verified — closing the root invalidates its cursors |
| Cross-workspace rejection | Verified — a cursor from workspace A is `INVALID_CURSOR` in workspace B |

**Historical snapshots are explicitly historical.** Every page carries
`provenance: "immutable-query-snapshot"` and `observedAt`, and the tool
description states that pages are historical snapshots. Old and new pages are
never mixed: a continuation always reads from the snapshot it belongs to, and a
snapshot is discarded as soon as its entry is no longer ready.

## 17. Result-size measurements

Measured with `scripts/lsp-benchmark.cjs` against the real bundled server.
Bytes are serialized UTF-8 lengths; tokens are a characters/4 estimate, **not**
a tokenizer measurement.

| Result | Raw protocol bytes | Model-facing bytes | Overhead | ≈ tokens |
| --- | ---: | ---: | ---: | ---: |
| Definition (1 result) | 123 | 615 | +492 | 154 |
| References (24 found, one page) | 7912 | 689 | **−7223** | 173 |
| Hover | 168 | 333 | +165 | 84 |
| Document symbols | 507 | 965 | +458 | 242 |
| Workspace symbols | 161 | 536 | +375 | 134 |
| Diagnostics (25 findings) | n/a (notification) | 5460 | n/a | 1365 |
| Six tool schemas | — | **3775** | — | 944 |

Findings:

* **References shrink by 91%** against the raw protocol payload, because the
  page is capped at 25 entries and each location is reduced to a
  workspace-relative path plus a 1-based range.
* Small results **grow** against the raw payload: the fixed envelope
  (`file`, `sourceVersion`, `positionEncoding`, `excludedCount`,
  `serverCompleteness`, `returnedCount`, `totalCount`, `hasMore`, `truncated`,
  `applicationTruncated`, `serverTruncated`, `incomplete`, `snapshotId`,
  `provenance`, `observedAt`) costs 165–492 bytes per page. That is the price
  of the freshness and provenance guarantees; the fields were kept because
  they are what make the freshness contract legible to the model.
* The `serverTruncated` / `incomplete` pair is deliberately an honest
  tri-state (`'unknown'`), not duplication: it records that the server did not
  say whether it truncated. It was **not** removed, because removing it would
  remove information rather than noise.
* No raw JSON-RPC envelope and no file body is ever returned. The native
  result is compact structured JSON with `untrusted: true`.
* Diagnostics messages are projected to 240 characters with
  `messageTruncated`, related messages to 120 characters and at most two
  related entries; a pathological result beyond 10 000 characters returns
  `LSP_OUTPUT_LIMIT` instead of leaking an unbounded body.
* Diagnostics are **not** injected into model prompts; they are only returned
  when the agent asks for them.

## 18. Request latency benchmarks

`scripts/lsp-benchmark.cjs`, Linux x86_64, Node 22.23.2, 8 CPUs.

**Scenario A — idle server.** Startup 108.49 ms; 1 language-server process;
process-tree RSS 419 434 496 bytes across 3 processes (the language server plus
two `tsserver.js` children with separate cancellation pipes — the language
server keeps one tsserver per project root).

**Scenario B — 360 mixed operations (60 × each of the six operations).**
Total 1507.69 ms.

| Operation | p50 | p95 | max | mean result bytes |
| --- | ---: | ---: | ---: | ---: |
| Definition | 2.24 ms | 3.55 ms | 22.89 ms | 598 |
| References | 8.21 ms | 12.09 ms | 38.94 ms | 2455 |
| Hover | 2.42 ms | 3.34 ms | 3.70 ms | 333 |
| Document symbols | 1.68 ms | 2.53 ms | 14.63 ms | 948 |
| Workspace symbols | 1.95 ms | 3.22 ms | 4.91 ms | 519 |
| Diagnostics | 0.55 ms | 0.89 ms | 359.54 ms | 5278 |

The diagnostics maximum is the **first** publication wait after the document
was opened; subsequent diagnostics answer in under a millisecond because the
publication is already cached.

**Scenario C — concurrent agents.** Four callers across two workspaces:
48 operations, 2 server processes for 2 workspaces (one each — no duplication),
per-caller p95 of 8.02 / 8.52 / 10.23 / **934.16** ms. The 934 ms caller is
the first to touch the second workspace and pays that workspace's cold server
start; the three warm callers are unaffected.

**Scenario D — workspace switch.** Releasing one workspace: 2 → 1 instances
and 1 process; activating the other workspace keeps 1 instance and 1 process.

**Scenario E — shutdown.** 6.89 ms; 0 instances; **0 survivors**; 0
language-server processes and 0 tsserver processes after the settle window.

**Long-running stress** (`tests/lspProduction.test.cjs`): 340 mixed
operations over two workspaces with three simulated callers, twelve concurrent
file edits during the run and a permission downgrade mid-run.

| Metric | Value |
| --- | ---: |
| Operations | 340 |
| Successful | 340 |
| Errors | 0 |
| Timeouts | 0 |
| p50 / p95 / max | 135.02 / 390.43 / 4570.87 ms |
| Server restarts | 0 |
| Pending requests after completion | 0 |
| Language-server processes | 1 per workspace |

The higher latency than Scenario B is the per-workspace serialization queue
(twelve concurrent calls against two workspaces) plus the concurrent file
edits forcing re-synchronization. It is measured, not a target.

## 19. Memory and process benchmarks

| Measurement | Value |
| --- | ---: |
| Idle server process-tree RSS | 419 434 496 bytes (3 processes) |
| RSS after 360 operations | 442 478 592 bytes (3 processes) |
| Growth over 360 operations | +23 044 096 bytes (≈+22 MiB, +5.5%) |
| Language-server processes, 1 workspace | 1 |
| Language-server processes, 2 workspaces | 2 |
| tsserver processes per server | 2 (configured project + inferred project) |
| Processes after shutdown | 0 |

Memory is read from `/proc/<pid>/status` (`VmRSS`) and is **unavailable on
non-Linux hosts**; the benchmark reports `null` there rather than inventing a
number. No arbitrary memory or latency target is asserted, because project
size and hardware differ.

## 20. Main-agent tool verification

`tests/lspProductionAgent.test.cjs` drives the **real** native pipeline
(`engine:chat` → `memoryChat` → `executeAgentTool` → adapter → manager → real
bundled server) with deterministic model stubs.

| Aspect | Result |
| --- | --- |
| Tool schema advertisement | All six tools present in the model payload on every request |
| Tool dispatch | All six executed through `executeAgentTool` |
| Result delivery | Every result delivered as a tool message; all `success: true` |
| Streaming compatibility | SSE streaming used; 31 `step-update` activity events emitted |
| Provider conversion | Cloud conversion is shared and unaffected; Phase 3's Anthropic/OpenRouter coverage still passes |
| Cancellation | A pending LSP call is cancelled and the run continues |
| Timeouts | Bounded structured errors, never a successful empty result |
| Permission changes | A downgrade removes the tools from the catalog and denies the pending call |
| Activity records | One execution step per tool with a finite duration |
| Context compaction | An LSP result survives projection as valid JSON with cursor, source version and freshness intact |
| Live Agent Steering | Steering submitted during the run was observed at the next checkpoint, with one minted run id |
| Single run | The run keeps one identity across all six tool calls |

The agent remains in the same run while performing LSP operations; no separate
execution loop was created.

## 21. Subagent tool verification

| Aspect | Result |
| --- | --- |
| Authorized child spawned | Yes, through the existing `spawn_sub_agent` path |
| Child receives LSP tools | All six advertised in the child's model payload |
| Definition, references, diagnostics in the child | Three real results in the child's own transcript |
| Result returned to the parent | The parent receives the child's bounded answer ("The answer function is defined in a.ts.") |
| Activity attribution | The child's activity holds the three LSP tool results with durations |
| Cancelling a separate child | The cancelled child fails; its peer completes normally |
| Surviving child requests continue | The shared server stays `ready` and the peer finishes |
| Parent run completes | Yes |
| Child permissions preserved | Workspace Write ceiling under a Full Access parent; Read Only / Ask children denied |
| Recovered child | Re-authorized at Workspace Write, never Full Access; denied while the parent is downgraded |

## 22. UI and Activity verification

The existing Activity surface was inspected and exercised; no UI change was
needed.

| Operation | Label |
| --- | --- |
| Definition | Find definition |
| References | Find references |
| Document symbols | Document symbols |
| Workspace symbols | Search workspace symbols |
| Hover | Inspect type information |
| Diagnostics | Check diagnostics |

`tests/lspActivity.ui.cjs` passed under Xvfb and asserts: all six labels, the
file/query information, the result count, the freshness state, the duration,
the expandable payload, and that untrusted server content is never executed
(an injected `<script>` in a hover result stays inert, collapsed and expanded).
`tests/permissionMode.ui.cjs` and `tests/liveSteering.ui.cjs` also passed.

No LSP dashboard, no settings redesign, and no layout change was made.

## 23. Failure-injection tests

`tests/lspProduction.test.cjs` and `tests/lspProductionAgent.test.cjs` cover
the twenty requested scenarios with deterministic fixtures and controlled
processes — no unexplained sleeps.

| # | Scenario | Test |
| --- | --- | --- |
| 1 | Missing language-server executable | *missing language-server executable fails cleanly…* |
| 2 | Invalid bundled resource path | *invalid bundled resource path is reported…* |
| 3 | Crash during initialization | *server crash during initialization…* |
| 4 | Crash during a definition request | *crash during a definition request…* |
| 5 | Timeout during a reference request | *timeout during a reference request…* |
| 6 | Cancellation during diagnostics | *cancellation during diagnostics…* |
| 7 | App shutdown during an active request | *application shutdown during an active request…* |
| 8 | Workspace closure during an active request | *workspace closure during an active request…* |
| 9 | Permission downgrade during a request | *permission downgrade during a request…* |
| 10 | Concurrent child cancellation | *cancelling one child leaves the shared server…* (agent file) |
| 11 | Stale document content | *stale document content is reported…* |
| 12 | Stale cursor | *a cursor is invalidated when its workspace server restarts* |
| 13 | Expired cursor | *expired and foreign cursors keep distinct categories* |
| 14 | Invalid server response | *an invalid server response is rejected…* |
| 15 | Server restart after failure | *a crashed server is restarted on demand…* + *the restart budget is bounded* |
| 16 | Incorrect file URI | *a result location outside the workspace is excluded* + *unsupported language* + *two workspaces never share…* |
| 17 | Unsupported language | *an unsupported language is refused without touching the server* |
| 18 | Partial diagnostics | *diagnostics freshness states stay honest across publications* |
| 19 | Multiple workspace isolation | *two workspaces never share a server, a document set or a cursor* |
| 20 | Rapid repeated startup/shutdown | *rapid repeated startup and shutdown leaves no orphan…* |

## 24. Full regression comparison

| | Tests | Pass | Fail | New failure identities |
| --- | ---: | ---: | ---: | ---: |
| Baseline (run A) | 1483 | 1458 | 25 | — |
| Baseline (run B) | 1483 | 1456 | 27 | — |
| **Final** | **1527** | **1502** | **25** | **0** |

The 25 failing identities are identical to the baseline. The two identities
that failed only under parallel load in the baseline did not fail in the final
run. **44 new tests** were added (35 production/packaging/failure-injection,
9 agent and subagent path).

Focused LSP suite: **73 / 73 passed** (29 from Phases 1–3, 44 new).

Unrelated suites explicitly re-checked: workspace permission tests, file
synchronization tests, agent-loop tests, subagent tests, live-steering tests,
tool-activity tests, recovery tests, context-compaction tests and the
Electron UI tests. All pass or fail exactly as at baseline.

## 25. Build status

| Step | Result |
| --- | --- |
| `vite build` (production renderer) | **passed** — existing >500 kB chunk warning only |
| `electron-builder --linux dir` | **passed** |
| Packaged runtime smoke (packaged binary + packaged asar) | **passed** |
| Packaged Electron application launch under Xvfb | **passed** |

No dependency, license or packaging-configuration change was made in this
phase, so the installed footprint is unchanged at ≈24.6 MiB for the three LSP
dependencies.

## 26. Files changed

Source:

* `src/main/lspManager.js` — bounded document eviction (D1); fast shutdown
  during initialization (D2); bounded crash restart with a fresh entry (D3);
  bounded event-driven diagnostics wait; shared-server teardown restricted to
  definite authorization failures (D5); non-overlapping authorization re-check
  (D6); bounded alias index (D7); `stats()` for verification.
* `src/main/lspCodeIntelligence.js` — bounded diagnostics wait with honest
  freshness (D4); severity validation moved ahead of the wait.
* `src/main/lspExecutionContext.js` — `forgetChild` revocation (D8).
* `src/main/tools/lspTools.js` — alias-aware failed-server filter (D7).
* `src/main/subagents/continuationManager.js` — recovered-child
  re-authorization at the default ceiling (D9).
* `src/main/subagents/sessionManager.js` — revoke a removed child's LSP
  authorization (D8).

Added:

* `scripts/lsp-packaged-smoke.cjs` — packaged-runtime smoke harness.
* `scripts/lsp-benchmark.cjs` — process/memory/latency/size benchmark.
* `tests/lspProduction.test.cjs` — 35 packaging, failure-injection,
  concurrency, synchronization, language-coverage and stress tests.
* `tests/lspProductionAgent.test.cjs` — 9 main-agent and subagent path tests.
* `docs/lsp-phase-2.6A-4-production-report.md`, `docs/lsp-phase-2.6A-4-evidence.json`.

**Not changed:** `package.json`, `package-lock.json`, the six tool schemas,
the tool labels, the Activity UI, the permission catalog, the file tools, the
agent loop, the provider layer, the task-plan system, the recovery system and
the Memory Palace.

## 27. Known limitations

1. **Windows and macOS are unverified.** The packaging configuration is
   inspected and the Linux binary is verified; the platform-specific paths
   (`taskkill /T /F`, drive letters, UNC paths, the macOS fuse) have not been
   executed.
2. **Unversioned diagnostics still cannot prove freshness.** The bundled server
   publishes without a document version, so its diagnostics are reported as
   `stale`. The bounded wait makes the answer *useful*, not *provably current*.
3. **A permission downgrade still interrupts peers** of the same workspace
   because the shared server is retired conservatively. Peers reacquire on
   demand. A finer-grained revocation (per-caller leases) would remove the
   interruption but is an architectural change, not a fix.
4. **Requests are serialized per workspace.** Correctness depends on it, but
   concurrent callers in one workspace queue behind each other.
5. **A clean file-level diagnostic result never proves a clean project.**
6. **The restart budget is 3 per workspace root for the process lifetime.**
   After three crashes the workspace needs an explicit close; there is no
   indefinite restart loop by design.
7. **The double document refresh per request** re-reads and re-hashes every
   open document before and after a query. This is the mechanism behind the
   `STALE_RESULT` guarantee. It was measured (section 18) and left unchanged,
   because weakening the hash comparison would weaken a stated correctness
   guarantee for a benefit that only appears with many large open documents.
8. **The real interactive TaskFlow manual session was not performed.** The
   automated agent path uses deterministic model stubs; no live or paid model
   was used.
9. **Installed AppImage / deb launch was not exercised**; only the unpacked
   Linux directory was built and run.
10. **`npm test` still does not work on this host** (`node --test tests/`
    treats the directory as a module). The script was not changed; explicit
    globs are used, as in the earlier phases.

## 28. Manual verification instructions

### 28.1 Linux packaged runtime (repeatable here)

```bash
npm run build
npx electron-builder --linux dir --config.directories.output=release/lsp4-linux
ELECTRON_RUN_AS_NODE=1 release/lsp4-linux/linux-unpacked/continuum \
  scripts/lsp-packaged-smoke.cjs release/lsp4-linux/linux-unpacked
```

Expect `LSP_PACKAGED_SMOKE {"ok":true,…}` with `noOrphan: true`.

### 28.2 Installed application (Linux, Windows, macOS)

1. Build and install the platform artifact (`npm run dist`).
2. Open a real JS/TS project as the Continuum workspace.
3. Set **Workspace Write**, ask: *"Use the LSP tools to find the definition and
   references of an exported function and check its diagnostics."*
4. Verify in Activity: the six labels, workspace-relative locations, a
   result count, a duration, and a diagnostics state that is `stale` or
   `ready` — never "clean" for an unversioned publication.
5. Switch to **Read Only** and **Ask for Permission** and confirm the LSP
   tools disappear from the next model checkpoint and that a forged call is
   denied.
6. Switch back to **Workspace Write** and confirm the tools return.
7. Quit the application and verify no `typescript-language-server` or
   `tsserver.js` process remains:
   * Linux/macOS: `pgrep -fa 'cli.mjs --stdio'` and `pgrep -fa tsserver.js`
   * Windows: `tasklist | findstr /I node.exe`
8. On Windows and macOS, additionally confirm the packaged `resources`
   directory contains `app.asar.unpacked/node_modules/typescript-language-server/lib/cli.mjs`
   and `app.asar.unpacked/node_modules/typescript/lib/tsserver.js`.

### 28.3 Windows / macOS specific

* Confirm the `RunAsNode` fuse is enabled in the shipped binary
  (`@electron/fuses` `getCurrentFuseWire`).
* Confirm a workspace path containing spaces and a non-ASCII path works.
* Confirm `taskkill /PID <pid> /T /F` removes the tsserver children.

## 29. Readiness assessment for the voxel pagoda benchmark

**Ready for a real Continuum benchmark on Linux, with reservations.**

*Ready:*

* The six tools work through the real agent pipeline, the real child runtime
  and the real bundled language server, with a single run identity, streaming,
  steering, activity records and compaction compatibility intact.
* The packaged runtime is proven to start the bundled server and to clean up
  after itself.
* Long sessions no longer fail on the 129th file, a crash no longer kills a
  workspace permanently, and quitting no longer blocks for 20 seconds.
* Permissions are enforced at every layer, children are independently
  bounded, and recovery is explicit rather than silent.

*Reservations for the benchmark run:*

1. **Diagnostic freshness stays conservative.** Expect `stale` rather than
   `ready`. Any conclusion in the benchmark report must preserve that
   qualifier; a `stale` result is not proof of a clean file.
2. **A permission downgrade interrupts same-workspace peers.** Keep the
   benchmark session in one stable mode.
3. **Windows and macOS remain unverified.** Do not present a cross-platform
   result from a Linux run.
4. **Concurrent callers in one workspace queue.** Budget for that in any
   timing claim.

Recommendation: run the benchmark on Linux with Workspace Write, keep the mode
stable, record the diagnostic state with every claim, and treat the
platform checklist in section 28 as a separate, still-open item.

## 30. Future custom-LSP integration considerations

Recorded for a later phase; **nothing in this phase implements any of it.**

* **A custom server registry** would need a different trust model. Today the
  executable is fixed in `launch()` and the initialization options are fixed.
  Supporting a user-chosen server would require: an allowlist or a
  user-consented path (never a model-supplied one), an explicit capability
  contract, and a per-server authorization policy — because the current
  policy assumes a read-only, in-workspace backend.
* **The sandbox boundary would have to be re-drawn.** The bundled TypeScript
  server runs unsandboxed in the workspace (it needs to read project
  configuration and dependency declarations). A third-party server would have
  to be granted the same, or run inside a real sandbox. Phase 1's report
  already documents this trust model honestly.
* **The permission matrix is per-capability, not per-server.** Adding a
  server that can write, format or execute would need new capabilities
  (`CAPABILITIES.LSP` is read-only by construction), a new approval path and
  a new result contract. Code actions, formatting and rename must remain out
  of scope until that exists.
* **Packaging** would need the new server's dependencies pinned, included and
  unpacked exactly as `typescript-language-server` is today, plus the same
  packaged-runtime smoke evidence.
* **The `languages` map, the method allowlist, the capability check and the
  result normalization** are all currently JS/TS-shaped. A generic adapter
  would need a per-language profile for language ids, position encodings and
  result shapes — the six tool names and their argument schemas would also
  have to become parameterized, which is a model-visible change and therefore
  a deliberate, separately authorized step.
* **Diagnostics freshness** would become per-server: another server may publish
  versioned diagnostics, in which case the current conservative `stale`
  default could be relaxed only after that server's behaviour is verified.
