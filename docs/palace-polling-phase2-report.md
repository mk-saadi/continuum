# Inactive-Tab Polling — Phase 2 Performance Report

**Scope:** stop Memory Palace periodic polling in inactive chat tabs. Three app files touched (one new), two test files added. No architecture change, no new dependencies, no model inference. Prior tree state preserved (HEAD `6c961b1`, no commits, no stashes, no resets). `/tmp/opencode/` untouched.

## 1. Confirmed root cause

Every mounted tab renders a full `TabPane` (`App.jsx:275`), hidden via `display:none` — never unmounted. Each owns a `useMemoryPalace` instance whose effect ran `setInterval(refresh, 2000)` unconditionally (`MemoryPalace.jsx:106`). Each tick fires 3 IPCs — `getContextUsage` (memories query + sessions query + full message-chain walk + summary read), `getCoreMemories` (SQLite read), `getEffectiveSettings` (sessions + profiles read) — and `setUsage(next)` stored an always-new object, re-rendering the pane subtree every 2s per tab. Cost scaled linearly with tab count for zero visible benefit.

## 2. Files changed and why

- **`src/lib/palacePolling.mjs` (new):** pure, unit-testable `PALACE_POLL_INTERVAL_MS` (2000), `shouldPollTick({isActive, hidden})`, `usageEqual(a, b)` (scalar fields + value-compared telemetry; unknown shapes fail open to unequal = extra render, never staleness), `isDocumentHidden()`.
- **`src/components/MemoryPalace.jsx`:** new `isActive = true` (default preserves existing callers) and `pollIntervalMs` options; polling effect returns early when inactive (no immediate refresh, no timer — cleanup still bumps generations to invalidate in-flight requests); ticks re-check the gate for hidden documents; `refresh` stores via `setUsage(prev => usageEqual(prev, next) ? prev : next)`. Event-driven paths (compression, settings-changed, MCP status, explicit `refresh`/`measure`/`toggle`) are ungated — only the periodic timer is.
- **`src/App.jsx` (1 line):** `TabPane` passes its canonical `active` flag (`tab.id === activeTabId`) as `isActive`. No new active-tab registry; `ChatInterface`'s `tabActive` (composer focus only) untouched.
- Deliberately **not** done: memoizing the `palace` return literal — verified it would buy nothing (no consumer is memoized; Header/ChatInterface re-render with their parent regardless), and consumer memoization is explicitly out of scope.

## 3. Reactivation, freshness, races

- Deactivation: effect cleanup clears the interval and bumps the generation, invalidating in-flight polls (existing `generation`/`requestId` guards discard them — proven by UI test 8).
- Activation: the effect re-runs (new `isActive` dep) → state reset + immediate `refresh()`/`measure()` + fresh interval. Rapid switching reuses the same cleanup path, so duplicates are impossible (proven: 10 flips → 1 interval).
- Stale display on return is bounded to one IPC round-trip; hidden panes keep last-known state (no blanking flash logic added).
- Hidden/minimized window: ticks skip while `document.hidden` (agent runtime, persistence, and explicit refreshes unaffected — none ride this timer).

## 4. Tests and results

- `node --test tests/palacePolling.test.cjs` → **5/5** (interval default, gate truth table, `usageEqual` units incl. fresh-but-identical, wiring pins: `isActive` default/guard/cleanup/guard-in-tick, canonical `active` source, `tabActive` confined to focus).
- Electron UI (real hook, fake `setInterval` registry, mocked IPC, 10 probes): `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/palacePolling.ui.cjs` → **pass** (`{"intervals":0,"usageCalls":27,"probes":10}`). Covers all 12 required cases: active polls (5 ticks → 5 polls), inactive creates no timers and zero IPC, switch transfers the single timer and refreshes, rapid switching, unmount silence, render-count stability across identical polls, stale-wins-newest (222 kept over late 111), compression/toggle/settings events on inactive panes, 10-pane scaling.
- Related: `contextTelemetry` 12/12 pass; `headerContext.ui` pass.
- Pre-existing failures, unchanged by this phase (verified by file attribution + earlier baseline): `contextPanel.test.cjs` (asserts a `RightSidebar.jsx` string predating the uncommitted cache-token props — file untouched here), `memorySettings.ui.cjs` ("nine tabs" vs prior-session settings rework — files untouched here).
- `npx vite build` → ✓ 7.85s. `git diff --check` → clean.

## 5. Measurements (mock-based, labeled)

UI fixture, 10 mounted probes, 1 active, 5 ticks → exactly 5 usage polls, all targeting the active session; inactive sessions queried zero times. Per poll = 3 IPC; per active minute ≈ 30 × 3 = **90 IPC + ~6 SQLite queries + 1 chain walk**; inactive panes = 0. Before: ×N tabs (≈900 IPC/min at 10 tabs). After: flat 90/min (**−90% at 10 tabs**, scales with inactive count). Reactivation costs one 3-IPC refresh + one `measureContext`. Production equivalence: identical code path; Chromium additionally throttles hidden-window timers. No production wall-clock numbers fabricated.

## 6. Unresolved / future work (not in scope)

Transcript virtualization, session-history query batching, subagent retention maps, `TabContext` refactor, right-sidebar `runtime` prop memo, bundle code-splitting, cold-scan hashing pipeline. Recovery guarantees and the Phase 1 scan optimization untouched (recovery suites not re-run: no shared files; `recoveryStore.js` unmodified).
