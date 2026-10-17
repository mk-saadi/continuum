# Chat Transcript Pagination — Phase 2 Implementation & Performance Report

## 1. Objective and scope

Mount only the newest slice of the canonical conversation in the chat transcript,
reveal older messages automatically as the user scrolls toward the top, preserve
the viewport while revealing, and never truncate the canonical history. This is a
**rendering-only** change: inference/context, persistence, compaction, tool
history, exports, editing/regeneration and storage are untouched.

Constants: `INITIAL_VISIBLE_MESSAGES = 15`, `OLDER_MESSAGES_PAGE_SIZE = 15`
(`src/lib/transcriptWindow.mjs`).

## 2. What changed (files)

New:
- `src/lib/transcriptWindow.mjs` — pure windowing module (85 lines).
- `src/components/main-app/useTranscriptWindow.js` — React hook (114 lines).
- `tests/transcriptWindow.test.mjs` — 8 focused unit tests.
- `tests/chatPagination.ui.cjs` — Electron UI suite, 8 sections.
- `tests/fixtures/chatPagination.jsx`, `tests/fixtures/desktopChatStub.mjs` — fixtures.

Modified:
- `src/components/main-app/ChatInterface.jsx` (+24/−6) — wire the hook into the
  existing scroll handler and both transcript render paths.
- `src/components/chat/WorkspaceTimeline.jsx` (+7/−1) — `data-message-id` on the
  workspace row roots so the same anchor works for workspace chats.

No inference, persistence, IPC, schema, store or model-config file was touched.
Phase 1 (terminal-log isolation, commit `fab58bb`) and all other working-tree
changes are preserved.

## 3. Design: a *derived* window, never a truncation

`selectTranscriptWindow(all, visibleCount)` returns `{ start, messages, hasOlder }`
where `messages` is a `slice` of the canonical array — it references the **same
message objects**, never clones or rewrites them, and never mutates the input.
One pagination unit is one top-level `user`/`assistant` message; tool calls,
results, attachments and any interleaved non-conversation record travel with the
span they belong to. Non-conversation roles are neither counted nor used to decide
whether older messages remain.

The window size is stored per `sessionId` and resolved through
`effectiveVisibleCount(state, sessionId)`, so a session mismatch falls back to 15
**synchronously** — the first render of a freshly selected conversation can never
mount a previous chat's expanded window.

## 4. Scroll-triggered reveal and viewport anchoring

The reveal is folded into the existing `handleScroll` (no new listener, no
IntersectionObserver): when `scrollTop <= OLDER_SCROLL_THRESHOLD_PX` (120px),
`loadOlder()` is called. An `expandingRef` guard makes duplicate scroll callbacks
within one frame a no-op, so exactly one page is inserted per trigger.

Before the window grows, the hook captures the first message intersecting the top
edge (`data-message-id` + `getBoundingClientRect().top`). A `useLayoutEffect` keyed
on the window's message list restores that anchor — or falls back to the
scrollHeight delta if the anchor element is gone — **before paint**. The previously
visible message stays at the same screen position (verified to ±2px).

Termination is structural: once `hasOlder` is false, `loadOlder()` returns early.
There is no pagination button and no duplicate insertion (rows are keyed by
`msg.id`).

## 5. Auto-follow vs. reading history

Auto-scroll to the newest message is unchanged: it only runs when the user is not
scrolled up (`isUserScrolledUp.current === false`). While the user reads history
the window reveals older pages without yanking the viewport to the bottom, and new
output arriving during that time does not pull the viewport down either (UI suite
section 7).

## 6. Lifecycle: switching, streaming, edits, restoration

- **Switching conversations / tabs**: window is keyed by session id → resets to 15.
- **Streaming / new messages**: the window recomputes from the canonical array; the
  newest message stays inside the window and the reply persists normally.
- **Edits / retries / regeneration**: canonical `messages` is mutated by existing
  code; the window is derived, so it re-slices automatically. `isLast` uses the
  visible window for rendering while `lastMessageId` remains canonical.
- **Initial restoration**: `useState` seeds at 15, so no frame ever mounts the full
  history.
- **In-chat find**: its effect now depends on the visible window so marks scan what
  is mounted.

## 7. Boundaries deliberately not touched

Inference/context construction (built in the main process from the DB), compaction,
tool history, exports, search, persistence formats/schemas, IPC, the Phase 1
terminal-log store/IPC, engine/inference runtime, GPU/model config, and the
renderer architecture were not modified. `messages` is passed by reference to
`WorkspaceTimeline`/`displayMessages` as before; the full array remains the only
source of truth.

## 8. Tests added

`tests/transcriptWindow.test.mjs` (8): initial page + non-mutation + object identity,
progressive prepend is a strict superset with no duplicates, termination at the
oldest message, short/empty/exactly-one-page conversations, non-conversation roles
interleaved and not counted, `isConversationMessage`, per-session scoping, and
safe degradation on non-array/empty input.

`tests/chatPagination.ui.cjs` (8 sections, real `ChatInterface` in Electron):
initial window; scroll reveal + anchoring ±2px; repeated scroll to oldest then
stop; short and empty conversations; streaming send (window stays 15 while the
inference stub receives the full 101-message context); auto-follow; reading history
not yanked; conversation switch resets the window with no leak.

## 9. Verification results

| Check | Result |
| --- | --- |
| `node --test tests/transcriptWindow.test.mjs` | 8/8 pass |
| `tests/chatPagination.ui.cjs` (electron + xvfb) | exit 0, all 8 sections |
| `tests/chatHistory.ui.cjs` | exit 0 |
| `tests/terminalLogIsolation.ui.cjs` (Phase 1 guard) | exit 0 |
| `tests/chatInputPerformance.ui.cjs` | exit 0 |
| `tests/messageActionToolbar.ui.cjs` | exit 0 |
| `tests/workLogPanel.ui.cjs` | exit 0 |
| ChatInterface-importing unit tests (`leftSidebarModes`, `palacePolling`, `rightSidebarControls`, `skillProposalStepArgs`) | 12/12 pass |
| `npm run build` (vite) | built OK, 1801 modules |

Renderer console during the pagination suite shows only the standard React
DevTools / CSP dev notices — no warnings or errors.

Note on the full pure suite: `node --test tests/` fails on this machine's Node
22.23 (directory arg resolved as a module) — a pre-existing environment quirk; run
explicitly as `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"` it reports
966/1007 passing. The 41 failures all fail inside Electron-only/native paths
(`initDatabase`/`repairLegacyAttachmentPaths`, `notificationService`, jsdom
`Tooltip`) and none of those files import the changed modules, so they are
pre-existing and unrelated.

## 10. Measurements: before/after

Measured with the real component in Electron (820×760), initial paint vs. fully
expanded, counting mounted transcript rows and total DOM nodes:

| Canonical messages | Initial rows | Initial DOM nodes | Fully-expanded DOM nodes (≈ pre-Phase-2 first paint) | Reduction at first paint |
| --- | --- | --- | --- | --- |
| 100 | 15 | 638 | 2593 | ~75% |
| 300 | 15 | 638 | 7193 | ~91% |
| 600 | 15 | 638 | 14093 | ~95% |

First paint is now **constant** (15 rows / 638 nodes) regardless of conversation
length; the pre-change renderer mounted every message on mount. Canonical counts
stayed 100/300/600 and the inference stub still received the complete context
(`length === 101` in the streaming test) while only 15 rows were in the DOM.

## 11. Status, limitations, and stop-for-review

Phase 2 is implemented and verified; nothing was committed, pushed, stashed,
reset or cleaned. Known limitations / deliberately deferred: no virtualization
(by requirement), the anchor fallback to scrollHeight-delta when a row unmounts in
the same commit, and the workspace path shares the anchor via `data-message-id`
but is exercised by the existing workspace UI suites rather than a dedicated
pagination fixture. Stopping here for review before any further phase.
