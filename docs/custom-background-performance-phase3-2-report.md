# Phase 3.2 — Custom image/GIF background performance fixes

Scope: implement the highest-confidence improvement from
`docs/custom-background-performance-audit.md` (Phase 3.1), verify it with
controlled measurements and tests, and fix only the additional
source-confirmed issues. No production work was committed or pushed.

---

## 1. Confirmed bottlenecks and which audit findings were addressed

The audit's findings were re-checked against the current code before editing.
The measured bottleneck is **animated-GIF frame decoding**, not file size, not
raster count, and not React rendering.

| # | Audit finding | Status | Evidence |
|---|---|---|---|
| 1 | Animated GIFs force continuous full-resolution frame decoding | **Addressed** (primary fix) | 3840×2160×12f GIF decoded 296–415 ms per 3 s sample at 1280×800 (two runs) and 350 ms at 1920×1080; no background and static images decoded 0 ms. |
| 2 | No dimension limit on import; sources are copied verbatim at native resolution | **Addressed** | `adoptBackgroundImage` used `fs.copyFileSync` with no dimension cap; now an oversized animated GIF gets a 1920-long-edge derivative. |
| 3 | The Settings preview starts a *second* full-resolution animation | **Addressed** | Measured: adding a 320×128 GIF thumbnail doubled image-decode tasks (74→144/150) and added 349–464 ms decode per 3 s. The static poster costs 1–2 ms. |
| 4 | Opacity changes re-probe and re-apply the image | **Addressed** (small) | Source-confirmed: `changeOpacity` re-triggered `getBackgroundSettings` + a `new Image()` probe + a `background-image` re-set. Now an opacity-only path. |
| 5 | `dialog::backdrop { backdrop-filter: blur(2px) }` adds per-frame work while GIFs animate | **Addressed**, narrowly | Measured at both window sizes: p50 frame time 39.7–56.4 ms with the blur vs 16.5–16.8 ms with the identical dialog and the filter neutralised. Gated off only for animated backgrounds. |
| 6 | Decode cost scales with native pixel dimensions, not file size | **Confirmed and reinforced** | 66 KB / 104 KB / 114 KB GIFs decoded 82 / 222 / 415 ms. The pre-fix import limit (40 MiB) allowed arbitrarily large GIFs. |
| 7 | Scrolling with a GIF active increases raster work / long frames | **Confirmed** | Raster tasks 2429 → ~3990 during scroll; long frames up to 116–126 ms. Bounding reduced re-decode during scroll (374 → 81 ms). |
| 8 | An isolated overlay layer might be cheaper than `<html>` background + `<body>` opacity | **Not a regression, not adopted** | Re-measured in the same software-rendered environment: no measurable advantage. Architecture left unchanged (Step 4). |

### One audit claim that the new measurements qualify

The 3.1 audit attributed GIF cost partly to "repeated paint/raster of a large
surface". In this environment the **raster-task count is ~1800 per 3 s for every
GIF regardless of resolution** (1280 vs 1920 vs 3840 all ~1800), because the
painted layer is viewport-sized and `background-size: cover` scales at raster
time. The dimension-dependent cost is in **decode**, which is what the bounded
derivative targets. Bounding therefore reduces decode CPU, decoded-byte volume
and file size — not raster-task count. This is stated plainly rather than
over-claimed.

---

## 2. GIF dimension policy and how derivatives are created, reused, cleaned up

### Policy

```js
// src/main/backgroundSettings.js
const MAX_RENDER_DIMENSION = 1920; // longest edge of a rendered animated GIF
const PREVIEW_DIMENSION = 512;     // longest edge of the Settings thumbnail
const DERIVED_DIRNAME = "derived";
```

- The cap applies to the **longer edge**, aspect ratio preserved, never
  upscaled (`targetSize()` returns `scaled: false` when already within bounds).
- It applies to **animated GIFs only**. Static images (any format) and
  single-frame GIFs are never processed, matching the instruction not to change
  static-image behaviour without evidence.
- 1920 is an initial engineering trade-off, centralised in one constant with a
  comment, so it can be adjusted later.

### Creation

`src/main/gifProcessor.js` wraps `sharp` (libvips):

- `readGifInfo()` — header-only metadata (dimensions, `pages`, animation flag).
- `boundGif()` — `.resize({ width, height, fit: "fill", withoutEnlargement: true })`
  then `.gif({ effort: 7 })`. Animation is preserved by libvips; the code never
  draws a single visible frame to a canvas.
- `writePosterFrame()` — first frame to a small static PNG for the preview.

Verified against real multi-frame fixtures that frame count, per-frame delays,
loop count, transparency, partial-frame/disposal compositing, dimensions and
aspect ratio all survive; measured quality loss is **0.009 / 255 mean absolute
RGB difference** versus a box-filtered reference.

### Reuse and cleanup

- A derivative is stored at a deterministic path derived from the source name:
  `backgrounds/derived/<source-base>.bounded.gif` and
  `<source-base>.poster.png`.
- Reuse gate: `isFreshArtifact()` requires the derivative to exist, be non-empty,
  and be at least as new as its source (`mtimeMs >=`). Managed originals are
  immutable (a fresh UUID per adoption), so this is a conservative, cheap check —
  no content hashing, no repeated processing.
- Generation is **atomic**: write to `<output>.<uuid>.tmp`, then `rename` onto the
  final path; on failure the temp file is removed and the caller falls back to
  the original.
- Concurrent requests for the same output share one in-flight run (a
  module-level `Map`), so a double read at startup cannot double-process.
- `pruneDerivedForActiveSource()` removes derived files that do not belong to the
  *currently stored* source. It never touches `backgrounds/` originals or
  unrelated data, and skips in-flight `*.tmp` files.
- Replacement/removal deletes the previous original **and** its derivatives
  immediately, so the derived directory stays bounded to ~2 files.

### Guarantees

- Preserves animation, frame delays, loop behaviour, transparency, disposal
  semantics, and aspect ratio; never crops; never collapses to a single frame.
- Invalid/corrupt files do not throw into the app: `readGifInfo` failure is
  caught and the original is rendered instead.
- `MAX_FILE_BYTES` remains 40 MiB (unchanged). Only the *displayed* label was
  corrected (see §5).

---

## 3. How existing stored oversized GIFs are handled

No re-import required.

`getBackgroundSettings()` is now async and calls `ensureArtifacts()` for the
resolved stored image. On the first read after the update, a previously stored
animated GIF larger than the cap gets its derivative generated and cached; the
next launches are instant (freshness check). The original file is never modified.

Covered by the test *"a previously stored oversized GIF is optimized on load
without re-import"*, which places a 3840-class GIF directly in the managed
directory, inserts the settings row, and asserts a bounded derivative appears
while the original's size is unchanged.

---

## 4. Secondary improvements

### A. Settings preview — implemented

The preview `<img>` used `mediaSource(imagePath)` — the full-resolution source.
For a GIF that is a second continuous animation, decoded at native resolution
even though it is displayed at 128 px tall.

Now `getBackgroundSettings()` returns `previewPath` (the static poster PNG) and
`BackgroundSettings.jsx` uses `previewPath || imagePath`. The poster is a
single-frame PNG, so the thumbnail cannot animate.

Measured (1280×800 / 1920×1080, 3 s):

| Preview source | decode tasks | decode time |
|---|---|---|
| full-resolution GIF (old) | 144 / 150 | 464 ms / 349 ms |
| static poster (new) | 75 / 76 | 1.1 ms / 2.0 ms |

The background's own animation is untouched.

### B. Opacity changes — implemented

Source-confirmed redundancy: the opacity commit re-triggered the full
`background-changed` path (IPC re-read, `new Image()` probe, `background-image`
re-set, style invalidation).

Now:
- `uiLayerOpacity.mjs` exposes `applyUiOpacity(doc, opacity)` (factor only); 
  `applyUiLayer` delegates its opacity half to it (identical behaviour).
- A new `BACKGROUND_OPACITY_EVENT` carries the value; the hook applies the factor
  only, reusing the already-verified URL.
- `setBackgroundOpacity` remains synchronous and never processes the image.

Preserved exactly: opacity is still UI *surface* opacity (higher = more solid),
clamped 40–100, applied to `<body>`, and mirrored as `--bg-ui-opacity` for
top-layer dialogs.

Measured effect is small in this environment (raster 359–503 ms vs 407–556 ms
over ~46 changes), because the probe hits a warm decode cache. The real,
source-verifiable benefit is the removed re-read + re-probe + image re-set. The
renderer test asserts the strong property directly: **0 source reads and 0 image
probes per opacity change.**

### C. Modal backdrop blur — implemented, narrowly

Measured with the identical `<dialog>` and only the `backdrop-filter`
neutralised (1280×800 / 1920×1080, 3 s, GIF animating behind it):

| Variant | p50 frame time | p95 | frames >50 ms | Paint events |
|---|---|---|---|---|
| production `blur(2px)` | 39.7 ms / 56.4 ms | 47.8 / 75.0 | 2 / 50 | 4 |
| blur neutralised | 16.6 ms / 16.7 ms | 17.6 / 18.5 | 0 / 0 | 2 |
| **animated-gated (the fix)** | **16.6 ms / 16.6 ms** | 17.5 / 18.9 | 0 / 0 | 2 |

The blur is therefore dropped **only while an animated background is active**:

```css
html[data-bg-image="true"][data-bg-animated="true"] dialog::backdrop {
	backdrop-filter: none;
}
```

- The `data-bg-animated` attribute is set from the main process's authoritative
  `animated` flag, not guessed from a file extension.
- Static backgrounds and the no-background case keep the production look exactly.
- This removes a visual effect for animated-background users, so it is documented
  as a targeted trade; see §9 for the GPU caveat.

---

## 5. Files changed

| File | Purpose |
|---|---|
| `src/main/gifProcessor.js` **(new)** | `sharp` wrapper: header inspection, bounded animated-GIF resize, static poster frame, availability probe. |
| `src/main/backgroundSettings.js` | Dimension policy constants; `derived/` layout; freshness/invalidations; atomic + de-duplicated generation; `ensureArtifacts`; active-source pruning; async `getBackgroundSettings`/`adoptBackgroundImage`; `animated` in the payload; accurate file-size label. |
| `src/hooks/useBackgroundSettings.js` | Consume `renderPath`/`previewPath`/`animated`; opacity-only event path; monotonic request token so a stale resolve cannot override a newer selection. |
| `src/utils/uiLayerOpacity.mjs` | Extract `applyUiOpacity` (factor only); `applyUiLayer` unchanged in behaviour. |
| `src/components/settings/BackgroundSettings.jsx` | Preview uses the static poster; opacity commit notifies via the opacity-only event. |
| `src/index.css` | Gate the modal backdrop blur off for animated backgrounds. |
| `src/main/ipcHandlers.js` | **Not changed** — the `background:*` handlers already returned the module results (now promises). |
| `package.json`, `package-lock.json` | Declare `sharp@^0.32.6` explicitly. |
| `tests/backgroundSettings.test.cjs` | Updated for the async contract and artifact fields; corrected the file-size assertion. |
| `tests/uiLayerOpacity.test.cjs` | Added coverage for the opacity-only helper. |
| `tests/backgroundGifBounding.test.cjs` **(new)** | 9 tests: bounding, animation/timing/loop/transparency fidelity, legacy GIFs, single-processing, replacement race, invalidation, cleanup. |
| `tests/backgroundLayer.ui.cjs` **(new)** | Renderer suite: opacity path does no re-read/re-probe, animated flag, poster preview. |
| `tests/fixtures/backgroundLayer.jsx` **(new)** | Fixture for the renderer suite. |
| `tests/fixtures/gifFixtures.cjs` **(new)** | Real multi-frame GIF/PNG fixtures (base64, Pillow-produced) with known dimensions, frames, delays and loop counts. |

### Dependency change

`sharp` was already installed and working (a transitive dependency of the
production dependency `@xenova/transformers`), but it was not declared. It is now
an explicit `dependencies` entry at the same version (`^0.32.6`) so it cannot
disappear silently via hoisting or an upstream change. `package-lock.json` was
updated surgically and verified: running `npm install --package-lock-only
--ignore-scripts --offline` leaves the file byte-identical. No new package was
downloaded and no version moved. The wrapper loads `sharp` lazily and degrades
gracefully (renders the original) if it is ever unavailable.

No other dependency change was needed: the existing `sharp` handles animated GIF
resizing without breaking timing, transparency or compositing, so no
decode-to-canvas-and-re-encode path and no new library were introduced.

---

## 6. Tests, build, regressions

### Focused tests

- `node --test tests/backgroundGifBounding.test.cjs tests/backgroundSettings.test.cjs tests/uiLayerOpacity.test.cjs` → **18/18 pass**.
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/backgroundLayer.ui.cjs` → **all 6 scenarios pass**.
- `npm run build` → **passes** (vite, 1803 modules; `data-bg-animated` present in the emitted CSS).

Coverage against the requested list:

1. GIF under the threshold → handled, no derivative, poster only. ✔
2. Oversized GIF → bounded derivative; dimensions and aspect ratio asserted. ✔
3. Aspect ratio and animation preserved. ✔
4. Transparency, frame timing, looping preserved (verified with sharp on the output, including transparent-pixel counts and frame-difference checks). ✔
5. Static images unchanged (0 processing calls, no derived files). ✔
6. Existing oversized GIFs optimised without re-import. ✔
7. Unchanged source not reprocessed (call counts + derivative mtime). ✔
8. A stale run cannot override or prune a newer selection (concurrent adoption). ✔
9. Opacity changes do not regenerate (main-process counts + renderer 0 reads / 0 probes). ✔
10. Preview no longer runs a full-resolution animation (poster asserted; decode measured). ✔
11. Cache invalidation and cleanup delete only derived files and the removed original. ✔
12. Persistence, import, removal and IPC workflows unchanged (existing suite still passes). ✔

### Regression verification

`node --test tests/*.test.cjs tests/*.test.mjs` (163 files, 1028 tests) against a
clean `HEAD` worktree baseline (159 files, 999 tests):

- **baseline: 41 failures**
- **after: 40 failures**
- diff: the only change is that
  `background image: adopt, replace, remove, and missing-file fallback` **now
  passes** (it failed at `HEAD` — see the file-size note below).
- **No new failures. No regressions.**

UI suites (each run under `xvfb-run` + `--no-sandbox`):

| Suite | Result |
|---|---|
| `sidebarAnimation.ui.cjs` (Phase 3) | pass |
| `terminalLogIsolation.ui.cjs` (Phase 1) | pass |
| `chatPagination.ui.cjs` (Phase 2) | pass |
| `chatFindNavigation.ui.cjs` (Phase 2.1) | pass |
| `rightSidebarSliders.ui.cjs` | pass |
| `backgroundLayer.ui.cjs` (new) | pass |
| `sliderField.ui.cjs` | fails **identically at `HEAD`** (pre-existing) |
| `contextPanel.ui.cjs` | pre-existing failure at line 137, untouched |

Phase 1 (terminal-log isolation), Phase 2 (pagination), Phase 2.1 (full-history
find) and Phase 3 (left/right sidebars) behaviour all still verified.

### Pre-existing issues observed (not introduced, not "fixed" beyond the one)

- The repo's `npm test` script (`node --test tests/`) is broken under Node 22.23
  — a directory argument is resolved as a module and the run aborts. Suites must
  be given explicit file globs. Left unchanged.
- `tests/backgroundSettings.test.cjs` failed at `HEAD`: it asserted that an
  11 MiB file is rejected with "smaller than 10 MB", but the real limit is 40 MiB
  (matching the audit's message/limit mismatch). Because the validation code was
  directly touched, the label now derives from `MAX_FILE_BYTES` (→ "40 MB") and
  the test was corrected to exceed the real limit. **The 40 MiB limit itself is
  unchanged.**
- The other 40 pure-suite failures and `sliderField.ui.cjs` /
  `contextPanel.ui.cjs` failures are identical at `HEAD` and unrelated to
  backgrounds.

---

## 7. Before-and-after measurements

### Conditions

- Software rendering only. GPU status on this machine:
  `gpu_compositing=disabled_software`, `rasterization=disabled_software`,
  `opengl=disabled_off`, `gl=(none,angle=none)`, `skiaBackendType=None`.
  **No GPU/compositing cost is represented.**
- Harness: `/tmp/opencode/bg32/harness/` (retained). Real `ChatInterface` via the
  Phase 3.1 profiling fixture; background applied with the production
  `uiLayerOpacity` helpers; `contentTracing` + `Performance.getMetrics` + rAF
  frame timing; 3 s per scenario; each unique media URL measured on first use.
- Window: 1280×800 and 1920×1080. Same conversation (200 messages), same theme.
- Assets: GIFs 1280×720×20f (66 KB), 1920×1080×24f (104 KB), 3840×2160×12f
  (114 KB), static PNG 3840×2160 (46 KB). Bounded derivative of the 3840 GIF:
  1920×1080×12f (60.6 KB). Poster: 512×288 PNG (2.9 KB).

### Primary fix — source/rendered dimensions and decode cost (first use)

| Asset | Source dims | Rendered dims | Bytes | decode / 3 s (1280×800) | decode / 3 s (1920×1080) |
|---|---|---|---|---|---|
| no background | — | — | — | 0 ms | 0 ms |
| static PNG | 3840×2160 | 3840×2160 | 46 KB | 0 ms | 0 ms |
| GIF | 1280×720×20 | 1280×720 | 66 KB | 82 ms | 45 ms |
| GIF | 1920×1080×24 | 1920×1080 | 104 KB | 222 ms | 152 ms |
| GIF | 3840×2160×12 | **3840×2160** | 114 KB | **415 ms** | **350 ms** |
| GIF (bounded) | 3840×2160×12 | **1920×1080** | **61 KB** | **38 ms** | **67 ms** |

Bounded vs native 3840: **~5–11× less decode time**, ~47% smaller file, same
frame count, delays, loop and sub-pixel-identical frames.

### Frame time and raster tasks

| Scenario | Raster tasks | Raster ms | p50 | p95 | max | frames >50 ms |
|---|---|---|---|---|---|---|
| none | 0 | 0 | 16.5 | 17.5 | 17.7 | 0 |
| static 4K | 0 | 0 | 16.6 | 17.4 | 17.6 | 0 |
| GIF 3840 native | 1777 | 474 | 16.6 | 22.1 | 32.2 | 0 |
| GIF 3840 bounded | 1802 | 577 | 16.6 | 24.7 | 33.6 | 0 |
| GIF 3840 + GIF preview | 1780 | 585 | 16.6 | 27.0 | 55.6 | 1 |
| GIF 3840 + poster preview | 1800 | 399 | 16.6 | 17.5 | 19.6 | 0 |
| GIF 3840 + modal (blur) | 1590 | 359 | **42.0** | 51.5 | 64.7 | 5 |
| GIF 3840 + modal (gated fix) | — | — | **16.6** | 17.5 | 22.0 | 0 |
| scroll, no background | 2429 | 259 | 16.6 | 17.4 | 104 | 3 |
| scroll + GIF native | 3992 | 702 | 16.7 | 17.9 | 126 | 5 |
| scroll + GIF bounded | 3993 | 905 | 16.6 | 19.7 | 115 | 3 |
| opacity-only churn | 1802 | 503 | 16.6 | 28.4 | 38.9 | 0 |
| opacity-full churn (old) | 1801 | 556 | 16.7 | 28.8 | 35.4 | 0 |

`raster ms` is summed task duration and is noisy under software rasterization;
`raster count` is the stable signal. As noted in §1, bounding does not reduce the
raster-task count, because the painted layer is viewport-sized.

### Scrolling and re-decode

During scroll the compositor re-creates/re-invalidates the background layer and
re-decodes frames. Native 3840: 132 tasks / **374 ms** (1280) and 135 / **349 ms**
(1920). Bounded: 130 / **81 ms** and 131 / **79 ms** — a ~4.5× reduction, with
max long frames also slightly lower (126 → 115 ms; 120 → 122 ms).

### React and style/layout

React renders during animation: **0** in every scenario (the layer is applied
imperatively, never re-rendered). `LayoutCount`/`RecalcStyleCount` deltas: **0**
for all GIF scenarios. This confirms the fix is not a React-level workaround.

### Responsiveness

Idle frame pacing is 60 fps (p50 16.5–16.8 ms) for every configuration except the
modal-with-blur case, which drops to p50 42–56 ms with 5–50 frames over 50 ms.
Typing/scroll responsiveness is otherwise not differentiated by asset size in
this environment; the differences are concentrated in decode CPU and in the
modal-blur and preview amplifiers.

### Measured vs expected

- **Measured:** decode reduction from bounding; preview decode elimination;
  modal-blur frame-time elimination; scroll re-decode reduction; 0 React renders;
  0 style/layout during animation.
- **Expected but not measured here:** lower GPU-process memory/upload from 4×
  smaller decoded frames; any GPU-compositing benefit of the bounded surface.
  Software rendering cannot show these.

---

## 8. Trade-offs

**Image quality.** Measured 0.009/255 mean absolute RGB difference versus a
box-filtered reference, and 60.6 KB vs 114 KB at 1920×1080 vs 3840×2160.
`sharp`'s GIF encoder re-quantises to a palette; fidelity was excellent on the
test content. Users who want pixel-exact 4K GIFs will now render at 1920 — that
is the deliberate trade for the decode reduction.

**Compatibility.** Sources are kept verbatim in `backgrounds/`; derivatives live
in `backgrounds/derived/` with `.bounded.gif` / `.poster.png` suffixes, so a
derivative can never be mistaken for an original (`resolveStoredImage` requires a
direct child of `backgrounds/`). `media://` serves both extensions
(`.gif`, `.png` are already whitelisted).

**Cache.** Bounded to ~2 files per active background; replacement and removal
delete the old derivatives immediately; a stray file left by a crash is pruned on
the next read of the active source. No unbounded growth, no duplicate large
assets, no timers or polling.

**Lifecycle.** Generation happens in the main process, off the renderer's render
path; the renderer awaits an IPC promise, so the UI keeps painting. Cancellation
is handled structurally: derivatives are keyed by the immutable UUID-based source
name, so a slow run for a replaced background writes only its own file, and
pruning is always evaluated against the currently stored record (regression-tested
with a concurrent replacement). Processing failures and missing files degrade to
"render the original" and never throw into the app.

**Startup cost.** The first read after upgrading a user with an oversized GIF
pays a one-time generation cost (hundreds of ms for a large GIF). Subsequent
launches are instant. This is the price of not having to re-import.

---

## 9. Deferred because it could not be verified

1. **GPU-accelerated behaviour.** Every measurement here is CPU/software
   rasterization (`gpu_compositing=disabled_software`). Therefore:
   - The bounded derivative's expected GPU-side benefit (4× smaller frame
     transfers/decoded memory) is **not** verified.
   - The modal-blur result is the strongest software finding, but `backdrop-filter`
     is normally GPU-composited. The change is gated to animated backgrounds only,
     which is the conservative choice; it should be re-checked on GPU hardware
     with `chrome://tracing` or an equivalent.
2. **Isolated background layer (VS Code-style overlay).** Re-measured and still
   not measurably cheaper under software rendering; not adopted. Per Step 4 this
   remains a deferred, GPU-dependent question, not a rewrite.
3. **Raster-task count.** Unchanged by bounding in this environment. Whether a
   bounded surface changes GPU rasterisation cost needs hardware verification.
4. **Very large GIFs beyond libvips' input-pixel limit.** Such files fail
   gracefully (the original is rendered) but are not optimised. Bounding by a
   file-size or pixel-count guard before processing was not added, because the
   existing 40 MiB import cap and libvips' own limit already bound it.
5. **Real user media.** Only synthetic assets of known dimensions were used, as
   in Phase 3.1.

---

## 10. Repository state

- **No commits and no pushes were made.**
- No `git reset`, `git clean`, stash, or destructive Git commands were run. The
  temporary `HEAD` baseline worktree used for the regression comparison was
  removed with `git worktree remove` (no history touched).
- All pre-existing working-tree changes are preserved: modified
  `RightSidebar.jsx`, `WorkspaceTimeline.jsx`, `ChatInterface.jsx`,
  `chatFind.mjs`, `main.jsx`, and all untracked Phase 2 / 2.1 / 3 files.
- Prohibited areas were not touched: no video-background support, no static-image
  behaviour change, no model-inference / context / compaction / GPU-loading /
  persistence changes, no application-state or background-architecture rewrite,
  and no changes to sidebar-animation, terminal-log, pagination or search
  architecture.
- The profiling harness lives outside the repository
  (`/tmp/opencode/bg32/harness/`) and no profiling instrumentation or verbose
  logging was left in the app.

Stop: awaiting review before Phase 4.
