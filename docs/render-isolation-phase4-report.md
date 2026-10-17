# Render Isolation — Phase 4 Performance Report

**Scope:** stop React from re-rendering every mounted chat tab when unrelated global UI state changes (modals, theme, sidebars) and when the active tab switches. The fix isolates chrome state in its own contexts and gives the expensive tab subtree stable props via `React.memo`. Five app files touched (one new file), two test files added. No architecture change, no new dependencies. Working tree preserved (no commits/stashes/resets); all prior-phase changes left as-is. `/tmp/opencode/` untouched (test scratch uses `os.tmpdir()`).

## 1. Confirmed root cause (verified in current source, before the change)

`AppContent` (in `src/App.jsx`) owned **all** shell state: modal visibility (`settingsOpen`, `modelSelectorOpen`, `projectModalOpen`), theme, and both sidebar flags. Every one of those `useState` setters triggered an `AppContent` render, and `AppContent` mapped `tabs` to non-memoized `TabPane` elements whose JSX (including the `palace`/callback props) was recreated on each render. React therefore re-rendered **every mounted `TabPane` and every `ChatInterface`** — including the inactive, `display:none` tabs — for actions that had nothing to do with their content:

- opening/closing settings or the model selector,
- any theme change,
- every left/right sidebar toggle,
- each tab switch (the active-tab state also lived in `AppContent`).

`useAvatarSettings` also returned a fresh `{ settings, update, error }` object (and a fresh `update` closure) on every render, so even a memoized `TabPane` would have been invalidated whenever `AppContent` re-rendered for any reason.

## 2. What changed and why

1. **New `src/context/UIStateContext.jsx` — chrome state, split by concern.** One `UIStateProvider` holds left-sidebar, right-sidebar, theme, and the three modal flags, exposing **five separate contexts** (`LeftSidebar`, `RightSidebar`, `Theme`, `ModalActions`, `ModalState`) and matching hooks. Each context value is `useMemo`'d, so changing one (e.g. the right sidebar) cannot invalidate consumers of another (e.g. the theme picker). Persistence (`sidebarOpen`, `rightSidebarOpen`, `theme` in `localStorage`) and the `data-theme` attribute write moved here unchanged. Hooks return `null` without a provider so standalone prop-driven fixtures keep working.
2. **Modal actions split from modal state.** `ModalActionsContext` (open/close callbacks) is built once with `useMemo(…, [])` — state setters are stable for the provider's lifetime, so the object identity never changes. `AppContent`, `Header`, and `TabPane` can open a modal without subscribing to modal *visibility*. Only `GlobalModals` and `SettingsModalSlot` consume `ModalStateContext`, so opening/closing a modal re-renders just those subscribers.
3. **`src/App.jsx` rewritten around the provider.** `App` now renders `<TabProvider><UIStateProvider><AppContent/></UIStateProvider></TabProvider>`. `GlobalModals` (model selector + project modal) and `SettingsModalSlot` (per-active-tab `MemorySettings`) are the only modal-state subscribers. `AppContent` no longer holds any chrome state, and the dead `activeModelName` state plus duplicate theme effects were removed.
4. **`TabPane` memoized with stable props.** `const TabPane = memo(function TabPane(…))`. Every prop is now either a primitive, a `useMemo` array (`chatModels`), a `useCallback` handler (`refreshProjects`, `updateProject`, `setSelectedModel`, `setActiveChatProvider`, `onLoadedModel`, `handleCreateProject`), the stabilized `avatars` object, or the `tab` object — whose identity `TabContext` only changes when that tab actually changes. `onCreateProject` is `modalActions.openProjectModal` (the stable action), while the real create handler is passed only to `GlobalModals`. Result: a `TabPane` re-renders only when its own `tab`/props change.
5. **`src/components/main-app/ChatInterface.jsx` — sidebar chrome isolated in render-prop subscribers.** `LeftSidebarState`/`RightSidebarState` are tiny components that call `useLeftSidebar()`/`useRightSidebar()` and pass the value into a render prop. The transcript subtree inside `ChatInterface` therefore does **not** re-render when a sidebar toggles; only the panel wrappers do. Both still accept explicit props (`isSidebarOpen ?? sidebar?.open ?? false`), preserving the standalone sidebar fixtures and the existing source-string tests.
6. **`src/components/main-app/Header.jsx` — consumes chrome contexts with prop fallbacks.** `isSidebarOpen`/`onToggleSidebar`/`isRightSidebarOpen`/`onToggleRightSidebar`/`onOpenModels`/`onOpenSettings` fall back to the context values when not supplied, so `Header` is unchanged for tests that pass props (`headerContext.ui.cjs`) and context-driven in the real app.
7. **`src/hooks/useAvatarSettings.js` — stable identity.** `update` is now `useCallback(…, [])` (it only touches refs and state setters) and the returned `{ settings, update, error }` is `useMemo`'d, so an unrelated `AppContent` render no longer hands every `TabPane` a “new” `avatars` object.

## 3. Before/after (deterministic fixture, same suite both runs)

`tests/renderIsolation.ui.cjs` renders the **real `App` shell** with the heavy leaves stubbed to counters (see `tests/fixtures/renderIsolation.jsx`): the stub `ChatInterface` logs `palace.sessionId` on every render (`chatTotal` = total leaf renders, `tabsRendered` = distinct tabs that rendered), the stub `Titlebar` counts `AppContent` renders, and `MemorySettings`/`ModelSelectorModal` count mounts. Baselines were captured with the same suite against the pre-change working tree (all Phase 1–3.2 changes present, before the Phase 4 edits); the suite always prints `RESULTS {…}` so it is re-runnable on either tree.

| action | pre: chatTotal / tabsRendered / app | post: chatTotal / tabsRendered / app |
|---|---|---|
| open settings | 3 / 3 / 1 | **0 / 0 / 0** |
| change theme (settings open) | 3 / 3 / 1 | **0 / 0 / 0** |
| close settings | 3 / 3 / 1 | **0 / 0 / 0** |
| open model selector | 3 / 3 / 1 | **0 / 0 / 0** |
| close model selector | 3 / 3 / 1 | **0 / 0 / 0** |
| toggle left sidebar (open/close) | 3 / 3 / 1 | **0 / 0 / 0** |
| toggle right sidebar (open/close) | 3 / 3 / 1 | **0 / 0 / 0** |
| switch to first tab | 3 / 3 / 1 | 2 / **2** / 1 |
| switch to third tab | 3 / 3 / 1 | 2 / **2** / 1 |
| stream status for one tab | not measured | 1 / **1** / 1 |

Modal mounts stay correct: opening settings mounts exactly **one** `MemorySettings` (the active tab) and closing it unmounts without remount; opening the model selector mounts exactly one. Theme is applied (`data-theme` = `light`) while zero chat tabs render.

The `app:1` on tab switches and stream status is expected and out of scope: `AppContent` subscribes to `TabContext` (active tab id / tab list), so it re-renders when tab state changes — that is the Phase 5 `TabContext` fan-out target, not a chrome leak. The Phase 4 win is that only **2** (switch) or **1** (stream) of the 3 mounted `TabPane`s render, instead of all 3.

## 4. Why propagation stays correct (no behavior frozen)

- `React.memo` compares props shallowly; nothing is frozen or suppressed. Real changes still flow: tab switches, messages, streaming status, model/session changes all change the relevant `tab` object or a genuinely-changed prop and re-render exactly the affected tab (proven by `streamStatus.tabsRendered === 1`).
- Modal/sidebar open-close behavior, keyboard shortcuts and dismissal, focus/accessibility, and persistence are unchanged: the same setters and the same `localStorage` keys/`data-theme` write now live in `UIStateProvider`, and the panels still render the same DOM.
- Cross-tab/session ownership is preserved: `SettingsModalSlot` gates on `modals.settingsOpen && active`, so a per-tab settings panel only appears on the active tab (unchanged single source of truth).
- No duplicate sources of truth: `AppContent` no longer holds any chrome state; `Header` and `ChatInterface` read the context and fall back to props only for standalone tests.

## 5. Tests and verification

- New `tests/renderIsolation.ui.cjs` (+ `tests/fixtures/renderIsolation.jsx`): mounts the real `App`, opens two extra tabs, and asserts the post-change numbers above (`EXIT=0`), including no re-render on modals/theme/sidebars, exactly one settings panel mount, two tabs on switch, and one tab on stream status.
- Passing regression tests (unaffected): `sidebarAnimation.test.cjs`, `palacePolling.test.cjs`, `sidebarAnimation.ui.cjs`, `headerContext.ui.cjs`, `terminalLogIsolation.ui.cjs`, `engineSelection.ui.cjs`, `chatPagination.ui.cjs`, `projects.ui.cjs`, `messageMetadata.ui.cjs`, `chatFindNavigation.ui.cjs`, `chatHistory.ui.cjs`, `cloudSelection.ui.cjs`, `rightSidebarSliders.ui.cjs`, `sessionDraft.ui.cjs`, `permissionMode.ui.cjs`, `tabSavedFlag.ui.cjs`, `modelSelector.ui.cjs`, `modelLoadSettings.ui.cjs`, `gpuOffload.ui.cjs`, plus 73 targeted unit tests.
- `npx vite build` ✓ (pre-existing large-chunk warning only). `git diff --check` clean. No profiling instrumentation left in production code.
- Pre-existing failures, unrelated to Phase 4 (reference `App.jsx`/`ChatInterface.jsx`/`Header.jsx`/`useAvatarSettings`/`UIStateContext` in none of them): `memorySettings.ui.cjs` (fixture lacks `window.api.getSubagentBudgets`), `contextPanel.ui.cjs`, and 40 full-suite failures (sqlite ABI / source-text assertions).

## 6. Known limitations and deferred follow-ups (not addressed)

- **Phase 5:** `useMemoryPalace` still returns a fresh `palace` object per `TabPane` render (identity instability) and the pending-skill-proposal path — explicitly out of scope here. `palace` is passed to `Header`, `SettingsModalSlot`, `ChatInterface`; stabilizing it is the next win.
- **Phase 5:** `TabContext` still fans out (one `useTabs()` value for all consumers), so `AppContent` re-renders on tab list/active changes — that is why `app:1` remains on switches/stream. Splitting `TabContext` is deferred.
- **Phase 6:** synchronous `localStorage` writes inside the `TabContext` updater are untouched.
- `ChatInterface` is intentionally **not** memoized this phase (its props include the unstable `palace` and render-prop children); it becomes worthwhile once `palace` is stabilized.
