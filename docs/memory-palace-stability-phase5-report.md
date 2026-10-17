# Phase 5 — Memory Palace Stability and Derived-Data Optimization

Scope: stabilize `useMemoryPalace`'s returned object/callbacks, remove effect and
keyboard-listener churn caused by unstable identities, and memoize the expensive
transcript-derived `pendingSkillProposals` computation. Phase 6 (tab-persistence
writes) is intentionally untouched.

Base commit: `fab58bb`. Phases 1–3.2 and 4 remain uncommitted in the working tree;
the baseline was captured on that same tree before the Phase 5 edits (no
stash/reset/clean/commit was performed).

Machine-readable numbers: `docs/memory-palace-stability-phase5-evidence.json`.

---

## 1. Which earlier audit findings were confirmed

Confirmed in the current source and by measurement:

- **`useMemoryPalace()` returns a fresh object every render, and three returned
  closures were recreated every render.** The object literal was returned
  directly, and `prepareMessages`, `finishMessage`, and `toggle` were plain
  `function` declarations. The hooks' `useCallback`s (`setSessionId`, `refresh`,
  `schedule`, `measure`, `noteLivePhase`, `clearLiveTelemetry`) were already
  stable. Measured: across 8 forced rerenders with unchanged inputs the object
  and those three closures changed identity 8 times.
- **`ChatInterface` callbacks depend on the whole `palace` object.**
  `sendMessage`'s dependency array contains `palace`, so its identity changed
  whenever the object did. `generateReply` depends on `sendMessage`.
- **A keyboard listener re-registered on every rerender.** The Ctrl+R
  "generate reply" effect (`[generateReply, view]`) tore down and re-added its
  `keydown` listener once per forced rerender (8/8). The Ctrl+F find effect
  depends only on `findOpen` and never churned — the audit's concern was
  confirmed for the generate shortcut, not the find bar.
- **`pendingSkillProposals(messages, readSkillDecision)` ran on every render.**
  It walks every message and its nested `executionSteps`, calling
  `readSkillDecision` (a `localStorage.getItem`) once per `propose_skill` step.
  Measured: one call per render (8 over 8 rerenders).
- **Duplicate/derived lookups.** `activeModelName` performed a second
  `models.find(...)` identical to the `currentModel` lookup above it;
  `sessionRow` rebuilt `groups.flatMap(...).find(...)` every render.

Not reproduced / already addressed by earlier phases:

- **`chatModels` rebuilding:** already `useMemo`'d in Phase 4 — no change needed.
- **Inactive-tab polling:** already gated by `isActive` + document visibility
  (Phase 2); verified still correct by `palacePolling.ui.cjs` and
  `palacePolling.test.cjs`.
- **Memory-Palace event subscriptions** (`model-capabilities-changed`,
  `cloud-providers-changed`, MCP, generation settings, compression complete) are
  registered with primitive/stable dependencies and did not churn on unrelated
  renders. No lifecycle change was warranted.

## 2. How `useMemoryPalace` was stabilized

`src/components/MemoryPalace.jsx`:

- `prepareMessages`, `finishMessage`, and `toggle` are now `useCallback`s with
  complete reactive dependency arrays (behaviour unchanged):
  - `prepareMessages`: `[api, modelId, sessionId, enabled, refresh, measure]`
  - `finishMessage`: `[api, sessionId, refresh, measure, schedule]`
  - `toggle`: `[sessionId, modelId, enabled, refresh, measure]`
- The return value is now a single `useMemo`d object whose dependency list
  contains **every** returned value (`api, sessionId, setSessionId, enabled,
  limit, usage, error, toast, refresh, schedule, prepareMessages, finishMessage,
  toolTokens, pluginTokens, mcpStatus, setDraftTokens, measure, measuredValue,
  measureError, noteLivePhase, clearLiveTelemetry, liveTelemetry, turnTelemetry,
  contextTokens, contextMethod, contextConfidence, fallbackTokens, toggle`).
  `measured` and `turnTelemetry` are normalized into local consts so the list can
  reference plain values instead of recomputing ternaries.

This is a correctly dependency-tracked memo, not an empty-dependency object: a
new identity is produced exactly when a meaningful value changes (a real data,
setting, session, or operation change), so consumers always observe current
state — verified by the session-change scenario (below).

## 3. Which effects/subscriptions restarted unnecessarily, and verification

- **Generate-reply keydown effect** re-registered once per rerender purely because
  `generateReply → sendMessage → palace` identity changed. After stabilizing the
  hook the churn remained when a consumer still passed a *fresh* provider object,
  which exposed a second source: `TabPane` built `activeChatProvider` as a new
  object literal every render, and `sendMessage` depends on it. `TabPane` now
  memoizes `activeChatProvider` on `[isCloud, tab.modelId]`. With production
  wiring (stable palace + memoized provider) the keydown listener no longer
  re-registers on ordinary rerenders (8 → 0). This is measured directly by
  wrapping `window.addEventListener/removeEventListener` and counting `keydown`
  registrations in `tests/palaceStability.ui.cjs`.
- **Pending-send and queue effects** (`[… , sendMessage]`) re-ran on the same
  churn but were already guarded (`pendingSend.current`, `pendingQueue.length`),
  so they started no duplicate async work. With a stable `sendMessage` they no
  longer re-run on unrelated renders at all.
- The Ctrl+F find effect, the tool-approval subscription, and the upload-policy
  effect depend on primitives (`findOpen`, `palace.sessionId`, provider fields)
  and did not churn — no change made.

No effect restart that is genuinely required (configuration/input change) was
removed.

## 4. Which derived computations were optimized, and why

- **Skill proposals (`pendingSkillProposals`).** Now
  `useMemo(() => pendingSkillProposals(messages, readSkillDecision), [messages, skillDecisionVersion])`.
  `messages` is a new array on every edit/stream/persist (verified: all updates go
  through `setMessages(prev => …)`), and skill decisions bump the existing
  `skillDecisionVersion` counter that was already incremented from
  `PendingInteractions`' `onDecision`. The walk over every message/step and its
  per-step `localStorage` reads now run only when the transcript or a decision
  actually changes. Measured 8 → 0 recomputations over 8 unrelated rerenders.
- **Session row lookup.** `sessionRow = groups.flatMap(g => g.sessions).find(…)`
  is memoized on `[groups, palace.sessionId]`, so the grouped-session scan is not
  repeated on every transcript render.
- **Duplicate model lookup.** `activeModelName` now derives from the existing
  `currentModel` (`models.find(...)`) instead of scanning `models` a second time.

These were the only derived computations with a demonstrated repeated cost.
`chatModels` and the transcript window (`useTranscriptWindow`) were already
memoized; no further memoization was added.

## 5. How skill-decision invalidation and other state changes stay correct

- **Invariant checked:** the only interactive skill-decision path in the app is
  `PendingInteractions` (composer panel). Both transcript renderers pass
  `interactive={false}` (`ChatInterface` and `WorkspaceTimeline`), so the
  transcript only ever renders the read-only `SkillProposalRecord`; the
  interactive `SkillProposalCard` is never mounted through the chat UI. Therefore
  `onDecision → bumpSkillDecisions` is a complete invalidation signal for
  `skillProposals`. `readSkillDecision` (module-level) is stable, so it is
  correctly omitted from the dependency array; it is not a reactive input.
- **Measured behaviour:** the proposal panel is shown before a decision, a
  Decline triggers exactly one recomputation and hides it, and four subsequent
  unrelated rerenders neither resurrect the panel nor recompute (0 calls).
- **Messages immutability:** every transcript mutation (stream flush, steps,
  stats, finish, edit, retry, delete, session load) replaces `messages` with a
  new array, so the memo recomputes on every real change. Streaming text deltas
  intentionally do not change `messages` (they flow through `useStreamBuffer` to
  a live text node), so proposals are not recomputed per delta.
- **Session/meaningful changes:** a session change produces a new palace identity
  and a new `sessionRow`; the probe verifies the returned `sessionId` and object
  identity update correctly.

## 6. Files changed and purpose

- `src/components/MemoryPalace.jsx` — memoize `prepareMessages`/`finishMessage`/
  `toggle`; return a dependency-tracked `useMemo`d object; normalize
  `measured`/`turnTelemetry` locals. No polling, event, or state-semantics change.
- `src/components/main-app/ChatInterface.jsx` — memoize `skillProposals`
  (`[messages, skillDecisionVersion]`) and `sessionRow`; derive `activeModelName`
  from `currentModel` (removes a duplicate scan). `useMemo` import already
  present from Phase 2.
- `src/App.jsx` — memoize `TabPane`'s derived `activeChatProvider` on
  `[isCloud, tab.modelId]` so a fresh object no longer invalidates
  `ChatInterface`'s send/reply callbacks and their effects.
- `tests/palaceStability.ui.cjs` (new) — the Phase 5 suite.
- `tests/fixtures/palaceStability.jsx` (new) — hook probe + real-`ChatInterface`
  harness.
- `tests/fixtures/executionEventsProbe.mjs` (new) — counting re-export of
  `executionEvents.mjs` used only by the suite.
- `docs/memory-palace-stability-phase5-report.md`, `docs/memory-palace-stability-phase5-evidence.json` (new).

No instrumentation was left in production code (all counters live in the test
fixture/probe).

## 7. Focused tests, regression results, and build

Focused suite (asserts post-change, always prints `RESULTS`):

```
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/palaceStability.ui.cjs
```

Covers: hook object/callback identity stability; real data-change propagation;
keydown re-registration counts (fresh vs memoized provider); `pendingSkillProposals`
call counts; skill-decision visibility + invalidation; no recomputation after the
decision settles.

Regression suites run and **passing**: `palacePolling.ui.cjs`,
`palacePolling.test.cjs`, `chatPagination.ui.cjs`, `chatFindNavigation.ui.cjs`,
`terminalLogIsolation.ui.cjs`, `renderIsolation.ui.cjs` (Phase 4),
`sidebarAnimation.ui.cjs`, `sidebarAnimation.test.cjs`,
`chatInputPerformance.ui.cjs`, `skillProposalCard.ui.cjs`, `sessionDraft.ui.cjs`,
`engineSelection.ui.cjs`, `headerContext.ui.cjs`, `cloudContext.ui.cjs`,
`chatHistory.ui.cjs`, `projects.ui.cjs`, `rightSidebarSliders.ui.cjs`,
`permissionMode.ui.cjs`, `tabSavedFlag.ui.cjs`, `modelSelector.ui.cjs`,
`modelLoadSettings.ui.cjs`, `gpuOffload.ui.cjs`, `cloudSelection.ui.cjs`,
`messageMetadata.ui.cjs`, `messageActionToolbar.ui.cjs`, plus unit suites
`transcriptWindow`, `turnOutcomes`, `workspaceStages`, `skillProposalStepArgs`,
`chatSearch`, `replyVariants`, `variantStatus`, `messageBranches`,
`streamDispatcher`, `messageIdentity`, `memoryChat`.

Pre-existing failures (verified on a pristine HEAD worktree, not caused by
Phase 5): `messageStats.test.cjs`, `messageActions.test.cjs`,
`skillProposalProjectId.ui.cjs` (waits for the interactive skill card that
`ChatInterface` never renders — `interactive={false}`), `contextPanel.test.cjs`
(source-text assertion on `RightSidebar.jsx`, unchanged by Phase 5). Also
pre-existing per the Phase 4 report: `memorySettings.ui.cjs`, `contextPanel.ui.cjs`.

Build: `npx vite build` succeeds (only the pre-existing >500 kB chunk warning).
`git diff --check` clean.

## 8. Before/after measurements

Harness: `tests/palaceStability.ui.cjs` (real hook + real `ChatInterface`),
8 forced parent rerenders with unchanged inputs. Values are identity changes /
registrations / calls during those 8 rerenders.

| Metric | Baseline | Post-change |
| --- | --- | --- |
| Palace object identity changes | 8 | 0 |
| `prepareMessages`/`finishMessage`/`toggle` identity changes | 8 each | 0 each |
| Already-stable callbacks (`refresh`/`schedule`/`measure`/…) | 0 | 0 |
| Ctrl+R keydown re-registrations — fresh provider (pre-Phase-5 TabPane) | 8 | 8 (unchanged; shows provider is a separate cause) |
| Ctrl+R keydown re-registrations — memoized provider (production) | 8 | 0 |
| `pendingSkillProposals` recomputations | 8 | 0 |
| Recomputation after a skill decision settles (4 rerenders) | 4 | 0 |
| Skill decision still hides the proposal | yes (1 recompute) | yes (1 recompute) |
| Real session change → new identity | n/a | yes (`objDelta 2`) |

Structural improvements (not timed claims): the returned object is now stable
under unchanged inputs; `pendingSkillProposals` is skipped on unrelated renders;
the per-tab session-row scan is memoized; one duplicate `models.find` was removed;
the derived provider object is memoized so object-identity churn no longer
propagates into send/reply callbacks.

## 9. Unresolved issues / deferred

- **Phase 6 (not done, per instructions):** `TabContext` still serializes and
  writes tab state to `localStorage` inside its state updater; not touched.
- **Remaining tab-switch propagation:** `AppContent` intentionally re-renders when
  the active tab changes and subscribes to `TabContext`; this legitimate
  app-shell update is left in place (Phase 4 report).
- **`palace` identity still changes during real telemetry/streaming updates**
  (usage, live telemetry, draft tokens, mcp status). These are meaningful data
  changes, so that is expected and correct.
- **`WorkspaceTimeline`'s read-only `SkillRecord`** still calls
  `readSkillDecision` per rendered skill step; it is bounded by the rendered
  window and was not a measured hotspot, so it was left unchanged.
- **`sendMessage` still depends on the whole `palace` object** (now stable).
  Narrowing it to individual fields was unnecessary once the object is stable and
  the provider is memoized.

## 10. Safety

No commits or pushes were made; no `git reset`/`git clean`/stash was run. All
Phase 1–4 working-tree changes are preserved. The temporary HEAD worktrees used
to confirm pre-existing failures were removed with `git worktree remove`.
