# Sidebar Open/Close Performance — Phase 3 Implementation & Performance Report

## 1. Objective and scope

Remove the UI jank caused by opening and closing the left and right sidebars,
without changing the visual design, the interactions, or any Phase 1 / Phase 2 /
Phase 2.1 behaviour.

Root cause (measured): both sidebars animated a **layout dimension**. The panel
element carried `transition-all duration-300` and toggled between `w-0` and its
expanded width, so the transcript — a flex sibling — was re-laid-out on *every*
animation frame. A single toggle produced ~18–19 distinct transcript widths and
tens of milliseconds of layout work (see §10).

The fix is deliberately narrow: only the two sidebar animations and the directly
necessary layout containers changed. No `React.memo`, no state refactors, no
virtualization, no new dependencies, no redesign, no change to the transcript's
expansion/contraction behaviour.

## 2. Strategy: a layout spacer with a transform-only panel

Each sidebar is now two elements:

- **Spacer** — owns the transcript's available width and toggles it *instantly*
  (`w-0` ⇄ expanded). Because the width changes in one commit, the transcript is
  laid out exactly once per toggle.
- **Panel** — absolutely positioned inside the spacer and animated with
  `transition-[translate,opacity]` only. `translate`/`opacity` are compositor
  properties and never trigger layout, so the transcript is not re-laid-out
  during the transition.

Net effect per toggle: **one** layout instead of one-per-frame, while the panel
still slides and fades exactly as before.

Implementation detail that mattered: Tailwind v4's `translate-x-*` utilities set
the CSS `translate` property (not `transform`). The transition property is
therefore `transition-[translate,opacity]`, which compiles to
`transition-property: translate, opacity` (verified in `dist/assets/*.css` and in
computed styles at runtime). Using `transform` would silently not animate.

## 3. What changed (files)

Modified:

- `src/components/main-app/ChatInterface.jsx` — left sidebar converted to
  spacer + animated panel (`#chat-sidebar`).
- `src/components/RightSidebar.jsx` — right sidebar `<aside>` converted to a
  spacer with an animated inner panel (`#right-sidebar`).

New (tests only):

- `tests/sidebarAnimation.test.cjs` — 77-line structural guard.
- `tests/sidebarAnimation.ui.cjs` — 344-line Electron behavioural suite (12
  scenarios).
- `tests/fixtures/sidebarAnimation.jsx` — 165-line fixture rendering the real
  `ChatInterface`.

No other file was touched by Phase 3. Phase 1 (terminal-log isolation, commit
`fab58bb`), Phase 2 (transcript pagination) and Phase 2.1 (in-chat find over
canonical history) are unchanged.

## 4. Left sidebar implementation

The former single animating `<div id="chat-sidebar" class="transition-all …">`
became:

- Spacer: `id="chat-sidebar"`, `relative z-20 h-full shrink-0`,
  `w-[272px] max-[650px]:w-[220px]` when open and `w-0` when closed. It keeps
  `aria-hidden={!isSidebarOpen}` and `inert={isSidebarOpen ? undefined : ""}`.
- Panel: `absolute inset-y-0 left-0 w-[272px] max-[650px]:w-[220px]
  overflow-hidden transition-[translate,opacity] duration-300 ease-in-out
  motion-reduce:transition-none`, holding the unchanged `<Sidebar>` element.
  Closed ⇒ `-translate-x-full opacity-0`; open ⇒ `translate-x-0 opacity-100`.

The `[&>aside]:h-full` workaround is no longer needed: the panel is
`inset-y-0` inside a full-height spacer, so the `Sidebar`'s `h-full` aside
resolves against a definite height.

## 5. Right sidebar implementation

The `<aside id="right-sidebar">` is now the spacer:

`relative z-30 h-full shrink-0 max-[900px]:absolute max-[900px]:top-0
max-[900px]:right-0 max-[900px]:z-40` plus `w-80` / `w-0`. It keeps
`aria-label`, `aria-hidden={!open}` and `inert={open ? undefined : ""}`. Below
900px it remains an absolute overlay (unchanged behaviour), with `z-40` so the
panel stays above the transcript.

The existing content wrapper is now the panel:

`absolute inset-y-0 right-0 flex h-full w-80 flex-col overflow-hidden border-l
border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)]
transition-[translate,opacity] duration-300 ease-in-out
motion-reduce:transition-none max-[900px]:shadow-xl`, closed ⇒ `translate-x-full
opacity-0`, open ⇒ `translate-x-0 opacity-100`. The header, tabs and every
control are byte-for-byte unchanged.

## 6. Behavior, interaction and accessibility preserved

- **Closed sidebars do not intercept input or focus.** The spacer collapses to
  `w-0` and carries `inert` + `aria-hidden="true"`; the off-canvas panel cannot
  receive pointer events or keyboard focus (`inert` blocks focus even while the
  panel is still painted during the fade).
- **Open state mirrors `aria-hidden`/`inert`** on both sidebars (`aria-hidden`
  is `false`, `inert` removed).
- **Rapid toggling never sticks**: an even number of toggles lands closed, an odd
  number lands open, and a single toggle always closes — covered explicitly by
  the UI suite.
- **Reduced motion**: both panels keep `motion-reduce:transition-none`.
- **Transcript expansion/contraction is unchanged**: the transcript narrows by
  272px (left) or 320px (right) and returns exactly as before — it just snaps in
  one step instead of animating.
- **Scroll preservation, pagination, search navigation, streaming/auto-follow**
  all behave as before while a sidebar is toggled (see §8).

## 7. Boundaries deliberately not touched

Phase 1 terminal-log store/IPC, Phase 2 pagination semantics
(`transcriptWindow.mjs` / `useTranscriptWindow.js`), Phase 2.1 in-chat-find
behaviour (`chatSearch.mjs` / `chatFind.mjs`), inference/context construction,
persistence and schemas, exports, engine/model config, and the renderer
architecture were not modified. No new dependency, `React.memo`, state
refactor, virtualization or sidebar redesign was introduced.

## 8. Tests added

`tests/sidebarAnimation.test.cjs` (structural, pure Node): asserts the spacers
exist with the exact collapsed/expanded geometry, that neither spacer uses
`transition-all` or transitions `width`, that each animated panel transitions
`translate,opacity` exactly once, that the off-canvas translates and
`motion-reduce` handling are present, that `aria-hidden`/`inert` remain bound to
the open flag, and that the transcript keeps its flexible `min-h-0 flex-1`
scroll container.

`tests/sidebarAnimation.ui.cjs` (Electron, real `ChatInterface`, 12 scenarios):
open/close geometry and computed styles for both sidebars; rapid toggling
(parity + single-toggle); both panels in sequence; exact transcript widths
(`none`, `left`, `right`, `both`); a closed sidebar does not intercept
`elementFromPoint` hits while an open one occupies the edge; existing navigation
and close controls still work; reading history survives a toggle (the message
being read stays in view, the reader is not sent to top or bottom); pagination
still reveals older messages; in-chat find still navigates after a toggle;
streaming + auto-follow + full-context inference with a sidebar open; and
accessibility (an open control is focusable, a closed one is not, `inert`/
`aria-hidden` hold).

The fixture renders the **real** `ChatInterface` with both sidebars and exposes
open/closed/toggle controls plus a `window.__scenarioKey` marker so a test can
never drive the previous (still unmounting) scenario. The suite runs in a
visible window (`show: true`, `backgroundThrottling: false`) because CSS
transitions do not advance in a hidden (`show: false`) window.

## 9. Verification results

| Check | Result |
| --- | --- |
| `tests/sidebarAnimation.test.cjs` (structural) | pass |
| `tests/sidebarAnimation.ui.cjs` (real component, 12 scenarios) | pass ×3 consecutive runs |
| `tests/transcriptWindow.test.mjs` (Phase 2) | pass |
| `tests/chatSearch.test.mjs` (Phase 2.1) | pass |
| `tests/leftSidebarModes.test.cjs` | pass |
| `tests/rightSidebarControls.test.cjs`, `tests/sidebarModes.test.mjs`, `tests/sidebarHistory.test.mjs` | pass |
| `tests/chatPagination.ui.cjs` (Phase 2) | pass |
| `tests/chatFindNavigation.ui.cjs` (Phase 2.1) | pass |
| `tests/chatHistory.ui.cjs` | pass |
| `tests/terminalLogIsolation.ui.cjs` (Phase 1 guard) | pass |
| `tests/chatInputPerformance.ui.cjs` | pass |
| `tests/messageActionToolbar.ui.cjs` | pass |
| `tests/workLogPanel.ui.cjs` | pass |
| `tests/rightSidebarSliders.ui.cjs` | pass |
| `npm run build` (vite) | built OK in ~7.4s |
| `tests/contextPanel.ui.cjs` | **fail — pre-existing** |
| `tests/messageActions.test.cjs` | **fail — pre-existing** |

The two failures are unrelated to Phase 3 and reproduce identically on a clean
`HEAD` (`fab58bb`) worktree: `messageActions.test.cjs:54` (archived-message
deletion returns `[]`) and `contextPanel.ui.cjs:137`
("no token-savings claims in status"). Neither file imports any Phase 3 module,
and neither component was modified.

Note on the full pure suite: `node --test tests/` fails on this machine's Node
22.23 (directory argument resolved as a module) — a pre-existing environment
quirk; suites were run as explicit file lists.

## 10. Measurements: before/after

Measured with the real component in Electron via CDP
(`Performance.getMetrics` + per-frame `getBoundingClientRect` sampling), same
build, same fixture, 420 ms sample window. "Before" is reproduced in-build by
forcing the width-bearing spacer to animate `width` (exactly what
`transition-all` did), so the two columns are a like-for-like A/B rather than
across builds. `distinctTranscriptWidths` = number of distinct transcript widths
observed across the frames of one toggle — i.e. how many times the transcript
was re-laid-out.

**1000×760 (both sidebars in-flow flex items):**

| Scenario | Distinct transcript widths (before → after) | Layout time ms (before → after) | Reduction |
| --- | --- | --- | --- |
| left open (100 msg) | 19 → 1 | 16.55 → 2.07 | −87% |
| left close (100 msg) | 19 → 1 | 17.86 → 2.14 | −88% |
| right open (100 msg) | 19 → 1 | 15.74 → 3.79 | −76% |
| right close (100 msg) | 19 → 1 | 23.67 → 3.28 | −86% |
| left open (300 msg) | 19 → 1 | 30.20 → 1.39 | −95% |
| left close (300 msg) | 19 → 1 | 13.26 → 1.52 | −89% |
| right open (300 msg) | 19 → 1 | 14.71 → 2.39 | −84% |
| both open (300 msg) | 19 → 1 | 15.63 → 2.74 | −82% |
| both close (300 msg) | 19 → 1 | 20.25 → 3.86 | −81% |

**820×760 (right sidebar is an absolute overlay, as before):**

| Scenario | Distinct transcript widths (before → after) | Layout time ms (before → after) |
| --- | --- | --- |
| left open (100 msg) | 19 → 1 | 21.27 → 1.42 |
| left close (100 msg) | 19 → 1 | 14.65 → 1.48 |
| left open (300 msg) | 19 → 1 | 19.26 → 4.65 |
| both open (300 msg) | 19 → 1 | 22.46 → 3.35 |
| right open/close (overlay) | 1 → 1 | ~3 → ~3 (no transcript reflow, unchanged) |

The transcript now has exactly **one** width per toggle (it snaps to its final
size) instead of ~19 animated intermediate widths, and total in-toggle layout
time drops from ~13–30 ms to ~1.4–4.7 ms (≈ 76–95% less). At 820px the right
sidebar is an overlay in both modes, so its transcript width is unchanged — this
confirms the sub-900px behaviour was preserved, not altered.

Raw layout *event* counts stay ~20 in both modes because the harness itself reads
`getBoundingClientRect` once per animation frame and the panel's own subtree is
still dirtied by the transition; the metric that matters — the transcript's
layout dimension — went from 19 animated widths to 1, and the layout *time* fell
by 80–95%.

## Status

Phase 3 is implemented and verified. Nothing was committed, pushed, stashed,
reset or cleaned; all pre-existing working-tree changes (Phase 1/2/2.1 and the
unrelated `main.jsx`/`WorkspaceTimeline.jsx` edits) are preserved, and temporary
measurement harnesses outside the repo were removed. Stopping here for review
before any later phase.
