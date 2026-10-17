# Phase 6 — TabContext Persistence and Tab-Switch Update Isolation

Scope: make `TabContext` state updaters pure (remove the synchronous
`localStorage.setItem` from inside the `setState` updater), avoid redundant
serialization/writes of unchanged tab state, keep persistence/restoration
semantics identical, and investigate the remaining tab-switch render
propagation. Phases 1–5 remain untouched in the working tree.

Base commit: `fab58bb` (HEAD). Phases 1–3.2, 4 and 5 are uncommitted in the
working tree; the persistence baseline was captured on that same tree **before**
the Phase 6 source edits, using the suite added here (it always prints
`RESULTS`). No stash/reset/clean/commit/worktree-remove was performed.

Machine-readable numbers: `docs/tab-persistence-phase6-evidence.json`.

---

## 1. The persistence side effect found

`src/context/TabContext.jsx` persisted from inside the `setState` updater:

```js
const commit = useCallback(updater => {
  setState(current => {
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (next === current) return current;
    stateRef.current = next;                                   // ref mutation
    localStorage.setItem(TAB_STORAGE_KEY, serializeTabState(next)); // I/O
    return next;
  });
}, []);
```

Confirmed consequences in the current tree (measured, see §7):

- The updater is **not pure**: it performs a ref write and a synchronous
  `localStorage.setItem` (`JSON.stringify` of the whole tab list).
- **Redundant writes.** `status` is runtime-only and stripped by
  `serializeTabState`, so approval/streaming status changes serialized and
  rewrote the byte-identical payload on every event (`statusOnly`: 1 write).
- **No coalescing.** Several mutations in one tick each ran their own updater
  and their own write (`rapidUpdates`: 3 writes + 3 serializations for a
  3-step title change).
- **Rewrites unchanged data at startup.** The hydration pass always returns a
  fresh object from `dropOrphanTabs`, so a normal launch with nothing to drop
  rewrote the restored payload (`startup`: 1 write).
- React was allowed to re-run the updater (StrictMode/queued updates) while a
  disk write lived inside it.

## 2. How updaters were made pure

- `commit` now only computes and returns state:
  `setState(current => (typeof updater === 'function' ? updater(current) : updater))`.
  No ref writes, no storage, no side effects.
- The two inline mappers became pure, exported reducers in
  `src/lib/tabState.mjs`: `updateTabState(state, id, patch)` and
  `updateTabsBySessionState(state, sessionId, patch)`. `updateTab`,
  `markTabSaved` and the stream/approval subscriptions route through them.
- Functional-update semantics are preserved: every mutation is still a
  function of `current` (no captured `state` closure), so rapid successive
  updates compose instead of overwriting.
- Both reducers return the **same** state object when nothing changes (unknown
  id, empty/no-op patch), so a redundant update neither re-renders subscribers
  nor touches disk. `activateTab` likewise returns `current` when the tab is
  already active.
- `stateRef` (used by `closeTab`/`closeAllTabs` to cancel sessions and by the
  unload backstop) is now updated in the persistence effect, not in the
  updater.

## 3. How persistence is scheduled; avoiding redundant work

A dedicated effect owns the write:

```js
useEffect(() => {
  stateRef.current = state;
  if (state === persistedStateRef.current) return;   // mount: adopted below
  persistedStateRef.current = state;
  const serialized = serializeTabState(state);
  if (serialized === persistedRef.current) return;    // durable repr unchanged
  try {
    localStorage.setItem(TAB_STORAGE_KEY, serialized);
    persistedRef.current = serialized;                // only on success
  } catch { /* retried on the next change */ }
}, [state]);
```

- **Effect, not framework.** One narrow effect keyed on the actual state, no
  generalized persistence layer.
- **Coalescing via React batching.** Several mutations in one tick commit once,
  so the effect runs once and writes the latest complete state (a first-write
  architecture where the newest pending state is always the one persisted).
- **Skip unchanged payloads.** The last successfully written serialization is
  cached in `persistedRef`; a `status`-only change serializes identically and
  is not written. The effect still serializes once per committed change to
  perform that comparison (cheap: ~0.3 KB for 2 tabs, ~1.4 KB at the 50-tab
  cap); the expensive synchronous storage write is what is eliminated.
- **No lost updates.** Because the effect always observes the latest committed
  state and `persistedRef` only advances on success, no intermediate or stale
  snapshot can win. Durability is not deferred by a timer, so there is no
  window in which a close/reload can drop a change that the baseline would
  have written.
- **Mount does not rewrite.** `persistedRef` is seeded with the state
  serialized during initialization; the first effect pass is skipped by
  identity, so a normal launch writes nothing (`startup`: 0 writes).

## 4. Restoration, rapid mutations, shutdown, storage errors

- **Restoration** is unchanged and still synchronous in the state initializer
  (no empty-shell flash), followed by the same best-effort orphan validation.
  Because the restored state is adopted as already-durable, startup never
  overwrites valid stored state with a default/incomplete value.
- **Rapid mutations** compose through functional updates and persist as one
  latest-state write.
- **Shutdown:** the `pagehide`/`beforeunload` backstop is retained but now
  deduped the same way (it writes `stateRef.current` only if it differs from
  `persistedRef`, and advances `persistedRef` only on success). It is a
  best-effort extra, not the primary path — the effect already persisted every
  committed change.
- **Storage errors** are still caught and non-fatal. A failed write does **not**
  update `persistedRef`, so the *same* payload is retried on the next state
  change rather than being assumed durable (`failedWrite`: title stayed old
  after the failure, and the value was persisted on the next change).
- **StrictMode/instrumentation:** persistence no longer depends on how often
  React invokes the updater. A focused probe showed React 18.3 invokes a
  `useState` updater once per update here (mount body double-rendered, updater
  not re-invoked), but the design is correct regardless because there is no
  side effect to duplicate (`strictMode`: exactly 1 write).

## 5. Remaining tab-switch render propagation

Baseline and post-change use the Phase 4 harness (`tests/renderIsolation.ui.cjs`,
3 mounted tabs) and the new `tests/tabSwitchIsolation.ui.cjs`.

**Necessary (preserved).**

- **`AppContent` renders once (app:1) on a switch.** `AppContent` consumes
  `tabs`, `activeTab` and `activeTabId`: it derives the active tab's
  `modelId`/`activeChatProvider` for `GlobalModals` and binds
  `active={tab.id === activeTabId}` for each `TabPane`. Selecting a different
  conversation genuinely changes that data, so the render is required. It is
  also cheap: all effects have stable deps, `chatModels` is memoized, and no
  modal/sidebar state flows through it.
- **Exactly two `TabPane`s (and their `ChatInterface`s) render on a switch** —
  the outgoing tab (which must hide its pane / drop `isActive`) and the
  incoming tab (which must show it). The untouched tabs receive identical
  props and are skipped by `React.memo`, confirmed by the render log (the
  third tab's session is absent from the switch deltas).

No additional avoidable render was found in the switch path: the only two
`useTabs()` subscribers are `AppContent` and `TabBar`, and both legitimately
depend on the active tab. Splitting `TabContext` was explicitly deferred in
Phases 4/5 and would move the same work into per-consumer subscriptions, so it
was **not** done here.

**Optimized (measured).** A per-tab update that does not change the durable or
visible value is now collapsed instead of fanning out. Emitting the same
stream status twice for one tab:

| scenario | pre-change | post-change |
|---|---|---|
| `statusDuplicate` (same status re-emitted) | chatTotal 1, tabsRendered 1, app 1 | **0 / 0 / 0** |
| `statusChanged` (real status change) | 1 / 1 / 1 | 1 / 1 / 1 |
| `streamInactive` (status for a non-active tab) | 1 tab | 1 tab, routed to the correct session |

This comes from the same-object no-op return in the reducers/`activateTab`;
a genuine change still propagates (`statusChanged`), so nothing is frozen.
Re-selecting the already-active tab is likewise a no-op (`reactivate`: 0
writes, 0 propagation).

## 6. Files changed and purpose

- `src/context/TabContext.jsx` — pure `commit`; persistence moved to a deduped
  effect that advances `persistedRef` only on success; `stateRef` updated in
  the effect; `updateTab`/`markTabSaved`/status routing use pure reducers;
  `activateTab` no-op; deduped unload backstop. No key/schema change.
- `src/lib/tabState.mjs` — new pure `updateTabState` and
  `updateTabsBySessionState` reducers that return the same state for a no-op.
- `tests/tabPersistence.test.mjs` — unit tests for the reducers, no-op
  collapsing, and proof the mutators never touch `localStorage`.
- `tests/tabContextPersistence.ui.cjs` + `tests/fixtures/tabContextPersistence.jsx`
  (new) — real-`TabProvider` persistence suite with instrumented
  `setItem`/`JSON.stringify`.
- `tests/tabSwitchIsolation.ui.cjs` (new) — tab-switch render/isolation suite.
- `tests/fixtures/renderIsolationStubs.cjs` (new) — the shared stub plugin,
  extracted so `renderIsolation.ui.cjs` and `tabSwitchIsolation.ui.cjs` drive
  the identical harness (`renderIsolation.ui.cjs` updated to require it; same
  behavior, re-verified).
- `docs/tab-persistence-phase6-report.md`, `docs/tab-persistence-phase6-evidence.json` (new).

No temporary profiling instrumentation was left in production code; the only
instrumentation lives in the test fixture.

## 7. Before/after measurements

Persistence harness, 2 seeded saved tabs, real `TabProvider` (counters reset
between scenarios). `writes` = `localStorage.setItem` for
`continuum_open_tabs`; `serializes` = `JSON.stringify` of a tab-state payload;
payload size 311 bytes for 2 tabs.

| scenario | pre: writes / serializes | post: writes / serializes |
|---|---|---|
| startup (restore, nothing to drop) | 1 / 1 | **0 / 2** |
| rapidUpdates (3 same-tick title edits) | 3 / 3 | **1 / 1** |
| statusOnly (status change) | 1 / — | **0 / —** |
| modelChange | 1 / — | 1 / — |
| createClose (open + close) | 2 / — | 2 / — |
| activate | 1 / — | 1 / — |
| reactivate (already active) | — | **0** |
| failedWrite → retry | n/a (wrote every commit) | retried; value durable |
| strictMode (one update) | 1 | 1 |

Final persisted state is correct in every case (final title wins, closed tab
purged, active tab and model durable). The extra startup serialization is the
init-time seed plus one comparison; the write it replaces is gone.

Render harness (3 tabs):

| scenario | pre-change | post-change |
|---|---|---|
| Phase 4 `switchToFirst` / `switchToThird` | 2 tabs / app 1 | 2 tabs / app 1 (unchanged) |
| Phase 4 `streamStatus` | 1 tab / app 1 | 1 tab / app 1 (unchanged) |
| `statusDuplicate` | 1 tab / app 1 | **0 tabs / app 0** |
| `statusChanged` | 1 tab / app 1 | 1 tab / app 1 |
| `streamInactive` | 1 tab | 1 tab, correct session |
| rapid switch | — | final tab active, one pane visible, 2 tabs |
| sidebar toggle / modal open | 0 tabs / app 0 | 0 tabs / app 0 |

Direct measurements are the render counts and the `setItem`/`serialize`
counts; the required/avoidable classification in §5 is structural reasoning
tied to those counts. Tab-switch wall-clock duration was not used as a claim:
the change alters *how many* writes/serializations happen, not the synchronous
render cost of the transition, which is identical.

## 8. Focused tests, regression results, build

Focused (all pass):

```
node --test tests/tabPersistence.test.mjs tests/tabShortcuts.test.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/tabContextPersistence.ui.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/tabSwitchIsolation.ui.cjs
```

`tabContextPersistence.ui.cjs` covers: no startup rewrite; rapid functional
updates coalesce to the latest; status-only changes are not persisted; model
changes are durable; create+close purges; active-tab persistence and the
already-active no-op; a failed write is retried, not marked durable; StrictMode
persists once; restoration/format compatibility (via the unchanged
`tabPersistence.test.mjs` round-trip/migration tests). `tabSwitchIsolation.ui.cjs`
covers: correct pane/conversation activates; only the two transition tabs
render; the untouched tab keeps its state; streaming binds to its own tab;
redundant updates collapse; genuine changes still propagate; Phase 4
modal/sidebar isolation intact.

Regression suites run and **passing**: `renderIsolation.ui.cjs` (Phase 4),
`palaceStability.ui.cjs` (Phase 5), `terminalLogIsolation.ui.cjs`,
`chatPagination.ui.cjs`, `chatFindNavigation.ui.cjs`, `sidebarAnimation.ui.cjs`,
`chatHistory.ui.cjs`, `chatInputPerformance.ui.cjs`,
`messageActionToolbar.ui.cjs`, `headerContext.ui.cjs`, `cloudContext.ui.cjs`,
`sessionDraft.ui.cjs`, `permissionMode.ui.cjs`, `modelSelector.ui.cjs`,
`tabSavedFlag.ui.cjs`, `projects.ui.cjs`, plus the unit suites.

Full unit run: `1033` tests, `993` pass, `40` fail. All 40 failures are the
pre-existing set documented in the Phase 4/5 reports (Electron/`app.getPath`,
network `ECONNREFUSED`, source-text/budget assertions in
`attachments`, `compactionBadge`, `contextPanel`, `engineSettings`,
`messageActions`, `messageStats`, `rag`, `skillImportIpc`, `skillProposalIpc`,
`subAgentRunner`, `tokenUsage`, `childAgentLoop`); none import the tab modules,
and `npm test`'s `node --test tests/` invocation is itself broken in this
environment (it tries to require the directory), so the glob form was used.

Build: `npx vite build` succeeds (only the pre-existing >500 kB chunk warning).
`git diff --check` clean.

## 9. Remaining concerns

- **`AppContent` still re-renders on every tab mutation**, including discrete
  status changes, because it subscribes to the single `TabContext` value. On
  switches this is required (§5); on status changes it is bounded and
  discrete, and removing it would require splitting `TabContext`, which
  Phases 4/5 deferred and which would relocate the same work. Left as-is.
- **One serialization per committed change** remains even when the payload is
  unchanged (only the `setItem` is skipped). Avoiding it entirely would need a
  structural diff or an out-of-band dirty flag; not justified at ~0.3–1.4 KB.
- **`dropOrphanTabs` returns a new state object even when nothing is dropped**,
  causing one startup re-render (pre-existing; the write it used to cause is
  now gone). Out of scope.
- `TabBar` and `AppContent` are the only `useTabs()` consumers; no other
  subscriber was found, so no additional narrowing was warranted.

## 10. Safety

No commits or pushes were made; no `git reset`/`git clean`/stash/worktree
operations were run. All Phase 1–5 working-tree changes and untracked files are
preserved exactly as found; only `src/context/TabContext.jsx`,
`src/lib/tabState.mjs`, `tests/tabPersistence.test.mjs` (tracked) and the new
Phase 6 test/doc files were added or edited.
