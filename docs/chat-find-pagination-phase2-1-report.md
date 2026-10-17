# In-Chat Find over Paginated Transcripts — Phase 2.1 Report

## 1. The regression and how it was confirmed

Phase 2 mounts only the newest 15 top-level messages and reveals older ones on
scroll. The in-chat find bar (`Ctrl+F`) was **DOM-based**: `src/lib/chatFind.mjs`
walks the text nodes inside the transcript scroll container and wraps matches in
`<span data-chat-find>`. Any message not currently mounted therefore had no text
nodes to match, so older results silently disappeared from search.

Confirmed empirically before touching code with a throwaway Electron harness
(`/tmp/opencode/findRegression.ui.cjs`) against the Phase 2 build: a 100-message
conversation rendered 15 rows, and a query for a token that existed only in
message 5 produced:

```
{"counter":"0/0","marks":0,"rendered":15,"hasMsg5":false}
```

i.e. **0 results, 0 highlights, and the matching message was not even rendered**.

## 2. How complete-history search obtains its results

Matching no longer depends on the rendered slice. A new pure module,
`src/lib/chatSearch.mjs`, derives results from the **canonical message objects**
(the same array the transcript renders, and that inference/persistence use —
never a copy):

- `messageSearchText(message)` flattens a message to its searchable text: user
  and assistant `content`, the active reply variant's `thinking`/`thinkingText`,
  tool calls (`serverName`, `toolName`, `name`, `status`, `error`,
  arguments/args/result/output — string or object fields `text`/`path`/`url`/
  `query`/`command`, JSON fallback only when no named field is present), execution
  step fields (`toolName`, `content`, `text`, `summary`, `error`, args/result),
  and attachment names.
- `findMessageMatches(messages, query)` returns ordered matches
  `{ messageId, occurrence, index, length }`: **message order, then occurrence
  order within a message**, case-insensitive, capped at `MAX_FIND_MARKS` (500).
- `resolveActiveMatchIndex(matches, target, fallback)` resolves the active result
  by stable identity (`messageId` + `occurrence`), falling back to a clamped index
  if the tracked result no longer exists.

`ChatInterface` computes `findMatches` with `useMemo([findOpen, findQuery, messages])`,
so unrelated renders never rescan and edits/streaming correctly recompute.

## 3. Revealing an older match without mounting everything

The Phase 2 hook `useTranscriptWindow` was extended from a suffix-only window to
also support a **bounded target window**:

- `src/lib/transcriptWindow.mjs` adds `SEARCH_CONTEXT_MESSAGES = 8`,
  `selectTranscriptWindowAround(all, targetId, radius)`, `indexOfMessage`,
  `hasConversationInRange`, `countConversationMessages`.
- The hook holds `{ sessionId, mode: "suffix" | "target", count, targetId, start, end }`
  and exposes `showTarget(messageId)`, `followLatest()`, `loadNewer()`,
  `hasNewer`, `containsMessage()`, plus the existing `loadOlder()`.

When a result is selected and its message is not rendered, `showTarget` slices a
window of **8 messages on each side of the target** (≤ 17 rows) from the canonical
array. The rendered count is therefore independent of how far the hit is from the
newest reply — a hit at message 3 of 600 mounts ~11 rows, never 587.

Visual highlight reuses the existing DOM mark pipeline: `markIndexForMessage`
(localises the `occurrence`-th mark inside the target's `[data-message-id]` row),
`setActiveFindMark`, and `scrollMarkIntoView`. If the exact segment is not in the
DOM (e.g. collapsed content), the owning row is scrolled into view instead.

## 4. Next/previous navigation and returning to the newest messages

The result counter and `active` index are driven by the **canonical** match list,
so `n/total` is correct across the whole conversation. `stepFind(±1)` moves the
active identity and wraps around; if the new match is outside the rendered window,
the window re-centres on it (bounded). `Enter`/`Shift+Enter` and the bar's
next/prev buttons keep working.

Returning to the newest messages has three compatible paths:

- A **"Jump to latest"** button (mirroring `SubagentTranscriptModal`) appears
  whenever the window does not include the newest message (`transcript.hasNewer`);
  clicking it restores the normal suffix window and scrolls to the bottom.
- Scrolling down inside a target window reveals newer pages (`loadNewer`) and, on
  reaching the newest message, hands back to the suffix window.
- The active search result is **not** re-yanked into view after returning to
  latest: reveal only runs on navigation or when a data change moves the active
  result (`findRevealedRef`), not merely because the result is off-window.

## 5. Interaction with pagination, auto-follow, streaming, switching

- **Ordinary pagination**: scrolling to the top in a target window calls the same
  `loadOlder` (prepends a page, anchor-restores the viewport); older-history
  pagination keeps working after search navigation.
- **Auto-follow**: navigating to a result sets `isUserScrolledUp`, so streaming
  never steals focus from the selected result. At the bottom, auto-follow resumes.
- **Streaming/new message**: `messages` changes recompute `findMatches`; the
  active position is preserved by identity, new matches extend the list, and the
  viewport is not moved. Verified with a live send during an open search.
- **Conversation switching**: the window state is session-keyed (Phase 2) and the
  search reset key includes `palace.sessionId`. A new `loadedSessionRef` guard
  prevents navigation from acting on the previous session's `messages` during the
  one-commit gap before the new history resolves. Verified: switching to a chat
  with no match yields `0/0`, clears marks, and never applies the old target.

## 6. Canonical history and inference verified unchanged

Search navigation is read-only over `messages`. Verified three ways:

- `window.__canonical.length` stays 600 (and 120) before, during, and after
  navigating to old and new results, and after returning to latest.
- `window.sessionMessageCount(id)` is unchanged by search navigation (600/600);
  it only changes through the real message operations (a delete removed exactly
  one message: 120 → 119).
- The send flow that ran while a search target window was mounted handed the
  inference stub the **full canonical context** (`__inferenceMessages.length === 121`
  for 120 messages + 1) while the DOM mounted ≤ 30 rows — i.e. the message array
  passed to inference is untouched by what search reveals.

## 7. Files changed

New:

- `src/lib/chatSearch.mjs` — canonical-history matching, per-message searchable
  text, `findMessageMatches`, `resolveActiveMatchIndex`.
- `tests/chatSearch.test.mjs` — 10 pure unit tests.
- `tests/chatFindNavigation.ui.cjs` — Electron UI suite (13 scenarios).

Modified:

- `src/lib/transcriptWindow.mjs` — `SEARCH_CONTEXT_MESSAGES`,
  `selectTranscriptWindowAround`, `indexOfMessage`, `hasConversationInRange`,
  `countConversationMessages` (Phase 2 behavior kept intact).
- `src/lib/chatFind.mjs` — added `markIndexForMessage` (maps a canonical match to
  its DOM mark); existing mark helpers unchanged.
- `src/components/main-app/useTranscriptWindow.js` — target window mode,
  `showTarget`/`followLatest`/`loadNewer`/`hasNewer`/`containsMessage`, session-keyed
  reset preserved.
- `src/components/main-app/ChatInterface.jsx` — canonical search + navigation
  wiring, `loadedSessionRef` guard, scroll handler gains downward reveal,
  "Jump to latest" button, `FiArrowDown`/`useMemo` imports.
- `tests/fixtures/chatPagination.jsx` — fixture `api.deleteMessage` so the real
  delete flow can be exercised.

Preserved unchanged: `WorkspaceTimeline.jsx` (from Phase 2), Phase 1 files, the
Phase 2 report, persistence, compaction, tool history, engine/model config.

## 8. Tests, build, baseline

- `node --test tests/chatSearch.test.mjs` → **10/10 pass**.
- `node --test tests/chatSearch.test.mjs tests/transcriptWindow.test.mjs tests/messageIdentity.test.mjs tests/textSelection.test.mjs` → **29/29 pass**.
- `tests/chatFindNavigation.ui.cjs` (new) → **pass** (13 scenarios: initial window,
  out-of-window match, reveal + visible highlight, bounded rows, next/prev across
  far pages, wrapping, keyboard, ordinary pagination after search nav, session
  switch isolation, delete removes stale target, streaming/new message, return to
  latest, canonical/inference integrity).
- Regression guard suites (all exit 0): `chatPagination.ui.cjs`,
  `chatHistory.ui.cjs`, `terminalLogIsolation.ui.cjs` (Phase 1),
  `chatInputPerformance.ui.cjs`, `messageActionToolbar.ui.cjs`, `workLogPanel.ui.cjs`.
- Full unit glob `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"`:
  **976 pass / 41 fail** of 1017. Baseline was **966 pass / 41 fail** of 1007 —
  the +10 passes are exactly the new `chatSearch` tests; the 41 failures are the
  same pre-existing environmental ones (Electron-only/native/jsdom: `attachments`,
  `contextPanel`, `messageActions`, `rag`, `subAgentRunner`, etc.) and none import
  the changed modules.
- `npm run build` (Vite) → success, no warnings introduced.

## 9. Measurements (600-message conversation)

| Stage | Canonical | Rendered rows | DOM nodes under scroller | Target visible |
| --- | --- | --- | --- | --- |
| Initial (suffix window) | 600 | 15 | 351 | – |
| Search hit in message 3 (old) | 600 | 11 | 255 | yes |
| Search hit in message 590 (near newest) | 600 | 17 | – | yes |
| After "Jump to latest" | 600 | 15 | – | – |

Before Phase 2.1 (same harness, 100 messages): search for an out-of-window token
= `0/0`, 0 marks, 15 rows, target absent. For reference, fully expanding 600
messages mounted ≈ 14,093 nodes in the Phase 2 baseline, versus 351 initially and
255–~400 around a search target here. Opening the find bar does not change the row
count (15), and navigating never mounts the intervening history.

## 10. Limitations / edge cases

- Search now reads the message **model** text rather than the live DOM. This is a
  deliberate superset (per "do not silently narrow supported targets"): collapsed
  thinking and non-rendered tool arguments are searchable even though the previous
  DOM search could not see them. When such a match is selected, the owning message
  is revealed, but the exact segment may not be highlighted because it is not
  rendered. A match spanning raw Markdown syntax may match canonically where the
  single-text-node DOM scan would not (and vice versa).
- "Jump to latest" is a small new affordance (the app already uses this pattern in
  `SubagentTranscriptModal`); there was no pre-existing scroll-to-bottom control to
  reuse.
- Full re-scan is memoized against unrelated renders and against query/session
  changes; it still recomputes when `messages` changes (streaming), matching the
  pre-existing behavior where marks were re-applied on streaming frames.
- Matches are capped at 500 (`MAX_FIND_MARKS`), unchanged from Phase 2.

## 11. Working-tree confirmation

No commits or pushes were made. `HEAD` is still `fab58bb` (Phase 1). No
`git reset`/`git clean`/stash or any destructive command was run. All Phase 1 and
Phase 2 working-tree changes were preserved; this phase only added/changed the
files listed in §7.
