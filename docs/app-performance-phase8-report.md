# Phase 8 — True variable-height transcript virtualization

## Objective

Keep the number of mounted transcript rows bounded by the viewport plus a small
overscan, instead of growing with the number of history pages the user has
revealed. The canonical conversation remains the single source of truth; the
initial latest-15 logical window, automatic older-page loading, chronological
order, ±2 px prepend anchor, auto-follow versus reading-history, jump-to-latest,
streaming, edit/retry/regenerate/delete, expand/collapse, attachments and
full-history search all keep their Phase 1–7 behavior.

No database schema, inference/context, compaction or permanent-memory change was
made. No CSS-hidden full transcript is used. No commit or push was performed.

## What was built

| Concern | Implementation |
|---|---|
| Geometry | `src/lib/transcriptVirtual.mjs` — pure prefix-sum/spacer math, no DOM. |
| Virtualizer | `src/components/main-app/useTranscriptVirtual.js` — measurement, range, anchoring, pinning. |
| Integration | `src/components/main-app/ChatInterface.jsx` — spacers + mounted rows; `data-window-count`, `data-vt-first/last/mounted` attributes. |
| Row UI state | `src/lib/rowUiState.mjs` + `src/hooks/useRowUiState.js` — bounded, identity-keyed, session-scoped. |
| Tests | `tests/transcriptVirtual.test.mjs` (pure) and `tests/transcriptVirtual.ui.cjs` (Electron UI). |

### Layout model

The transcript stays a centered flex column with `gap: 28px`. Children are
`[topSpacer?, …contiguous mounted rows…, bottomSpacer?]`:

- `prefix[i] = Σ_{j<i}(size_j + gap)` — the top offset of row `i`.
- `topSpacer = first > 0 ? prefix[first] − gap : 0`.
- `bottomSpacer = last < count−1 ? prefix[count] − prefix[last+1] − gap : 0`.
- `totalHeight = prefix[count] − gap`.

The spacers reconstruct the full content height exactly (`tests/transcriptVirtual.test.mjs`
asserts `rebuiltHeight === contentHeight` for many scroll positions), so the
scrollbar, scroll-to-row offsets and the existing flex/gap styling are unchanged.

Constants: `DEFAULT_OVERSCAN_PX = 480`, `DEFAULT_ROW_ESTIMATE_PX = 120` (median
of measured heights once ≥ 3 rows are measured), `MAX_CACHED_MEASUREMENTS = 1500`,
`MAX_PIN_EXPANSION = 60`.

### Why a custom virtualizer instead of `@tanstack/react-virtual`

No virtualization dependency existed in `package.json`. The custom module was
chosen because:

1. The spacer model reproduces the exact content height while preserving the
   existing flex/gap DOM contract, so nothing else in the transcript had to
   change.
2. Phase 2's logical window already owns pagination, anchoring intent and
   session reset; the virtualizer only maps that window to a mounted sub-range,
   which is a smaller surface than a full table/`measureElement` abstraction.
3. The geometry is pure and unit-testable in Node without a DOM.

Trade-off accepted: the team owns measurement/anchoring correctness. That is
only justified because the tests below pin the exact invariants; a maintained
library remains the safer default for a larger surface.

### Anchoring ownership

The virtualizer owns scroll anchoring; `useTranscriptWindow` is called with
`anchoring:false` to avoid double correction (the original source of page-1
jump-to-bottom drift). Prepend restore is analytic (`prefix[newIndex] − contentTop`),
falling back to a mounted-DOM delta and then a `scrollHeight` diff. Continuous
height changes (streaming Markdown, image loads, sidebar reflow) are delegated to
the browser's native scroll anchoring, which is more accurate than a JS
correction for width-driven reflow.

## Measurements

Same fixture (`tests/fixtures/chatPagination.jsx`) and CDP methodology as Phase 7
(`NODE_ENV=production`, no engine, hardware acceleration disabled, 820×760
window). The only change: the expand loop drives the logical window through
`data-window-count` and observes mounted rows through `data-vt-mounted` instead
of waiting for every revealed message to be in the DOM. DOM is
`querySelectorAll('*')`; heap is `JSHeapUsedSize` after forced GC; times are
medians of three repetitions. Raw values are in
`docs/app-performance-phase8-evidence.json`.

| Content | Count | DOM (P7 → P8) | Retained heap MiB | Older-page reveal ms | Initial render ms |
|---|---:|:---:|---|---|---|
| plain | 100 | 2,594 → 613 | 9.28 → 6.86 | 33.7 → 49.8 | 46.2 → — |
| plain | 300 | 7,194 → 613 | 15.97 → 7.66 | 48.9 → 49.7 | 46.2 → — |
| plain | 600 | 14,094 → 613 | 25.99 → 7.77 | 89.3 → 49.8 | 54.6 → — |
| complex | 100 | 9,544 → 827 | 16.30 → 10.56 | 175.6 → 98.0 | 209.2 → — |
| complex | 300 | 28,044 → 823 | 30.08 → 10.84 | 218.0 → 85.8 | 192.4 → — |
| complex | 600 | 55,794 → 823 | 50.10 → 10.98 | 287.4 → 83.2 | 355.3 → 76.8 |

Headline at 600 complex messages:

- fully-explored DOM: **55,794 → 823 peak** (661 steady), and roughly constant
  across 100/300/600 — the DOM no longer scales with history.
- retained heap after GC: **50.10 → 10.98 MiB**.
- older-page reveal median: **287.4 → 83.2 ms**, and flat with history length.
- mounted rows: **600 → 4–5**.
- initial render median: **355.3 → 76.8 ms** (measured in the extra 6-rep run).

Mount counts stay inside the viewport+overscan bound: `mounted ≤ 14` for plain,
`≤ 5` for the taller complex rows.

### Scroll-frame trade-off (reported honestly)

Phase 7's complex-600 scroll sweep was p95 24.3 ms with 0/360 frames over 50 ms.
The virtualized 120-frame sinusoidal sweep keeps only 5 rows and 823 nodes
mounted, but over 6 repetitions some frames exceed 50 ms (p95 ≈ 46 ms, 19/720
frames). Each fast programmatic jump mounts, parses and measures complex rows.
This is the cost of virtualization and is bounded; real user scrolling (small
deltas, native scroll anchoring) is gentler than the harness's large sinusoidal
jumps.

## Verification

Focused unit command (the Phase 7 ten files plus the Phase 8 module):
`node --test tests/terminalLogStore.test.mjs tests/transcriptWindow.test.mjs
tests/transcriptVirtual.test.mjs tests/chatSearch.test.mjs
tests/sidebarAnimation.test.cjs tests/backgroundGifBounding.test.cjs
tests/backgroundSettings.test.cjs tests/uiLayerOpacity.test.cjs
tests/tabPersistence.test.mjs tests/palacePolling.test.cjs
tests/messageIdentity.test.mjs` → **91 tests, 0 failures**.

UI command pattern:
`env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/<name>.ui.cjs`.

| Check | Result |
|---|---|
| focused unit (11 files) | **PASS** (91 tests) |
| transcriptVirtual (new) | **PASS** |
| chatPagination | **PASS** |
| chatFindNavigation | **PASS** |
| sidebarAnimation | **PASS** |
| terminalLogIsolation | **PASS** |
| renderIsolation | **PASS** |
| palaceStability | **PASS** |
| tabContextPersistence | **PASS** |
| tabSwitchIsolation | **PASS** |
| chatInputPerformance | **PASS** |
| palacePolling | **PASS** |
| messageMetadata | **PASS** |
| backgroundLayer | **FLAKY — pre-existing, unrelated** (5/6) |
| production build | **PASS** (pre-existing >500 kB chunk warning) |
| full unit suite | 1002/1042 pass — 40 pre-existing failures, not Phase 8 |

The new `tests/transcriptVirtual.ui.cjs` asserts: bounded DOM independent of
history length at 100/300/600 complex messages; a genuinely tall row is measured
(>400 px) and mountable without breaking the bound; scroll-to-identity lands on
messages 61/301/541 in a fully revealed 600-message history; an expanded thinking
section survives the row leaving and re-entering the mounted range; and the row
UI state resets on a session switch.

The full unit suite still has 40 pre-existing failures (cloud `getPath` mocks,
subagent model selection, MCP `initDatabase`, RAG network `ECONNREFUSED`,
token-budget assertions). No failing suite imports a Phase 8 module; per the
brief they were left untouched. `backgroundLayer.ui.cjs` is a pre-existing
Phase 3.2 flake (a Settings-preview timing race in a suite Phase 8 never
touched); it passed on 5 of 6 runs.

## Preservation and safety

No `git reset/clean/stash/revert` and no commit/push. Phase 8 only added files
and extended existing ones; no pre-existing file was deleted or replaced. All
earlier working-tree changes for Phases 1–7 are intact. Canonical history is
never truncated: the fixture asserts canonical/store counts remain 100/300/600
after full reveal and after sends, and inference still receives the complete
conversation.

## Limitations

- No live model inference, no real streamed tool/cancellation trace, no
  multi-real-tab expanded-history timing, no long soak.
- The scroll sweep is harsher than real scrolling; treat scroll results as an
  upper-ish bound.
- CDP retained heap is not RSS or GPU memory; native image memory was not
  measured.
- Synthetic complexity is reproducible, not the user's real histories.
- The user requested model `spark2_5 (by Hf_Format)`; this assistant runs as
  `opencode/deepseek-v4.1-flash-free` and cannot switch its own model.

## Decision

Phase 8 virtualization is implemented and keeps the mounted DOM, heap and reveal
cost bounded and independent of revealed history length, while all focused
Phase 1–7 suites and the production build pass. Keep the custom virtualizer. Stop
here for review; no commit or push.
