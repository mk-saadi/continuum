# Custom Background Performance Audit — Phase 3.1

Read-only audit. **No fixes were implemented.** This document describes the two supported
background types (static images and animated GIFs), ranks the likely causes of the
background-related slowdown, compares Continuum with the user's VS Code background script,
and proposes a minimal Phase 3.2 plan.

- Date: 2026-10-18
- HEAD: `fab58bb`
- Scope: the custom background feature (static image + UI surface opacity, and animated GIF
  used through the same path). Video backgrounds are **out of scope**: Continuum rejects
  video extensions in this feature (see below).
- Every measured number in this document comes from the harness described in
  [Appendix A](#appendix-a--measurement-harness). Source-based reasoning is labelled as such.

---

## 0. Executive summary

1. **Confirmed:** the GIF slowdown is caused by Chromium continuously decoding GIF frames and
   re-rasterizing a full-window surface every animation frame. A static background does none of
   this while idle. This is measured directly (idle raster work: `0` for static/no background,
   ~1800 raster tasks per 3 s for a GIF; see §5).
2. **Confirmed:** the cost is entirely inside Chromium's image/paint pipeline and is **independent
   of React**. React render count during background animation was `0` in every scenario.
3. **Confirmed:** the GIF path causes **no layout or style recalculation** while idle
   (`LayoutDuration`/`RecalcStyleDuration` = 0). It is a decode + paint/raster + composite cost,
   not a layout problem.
4. **Confirmed:** cost scales with the GIF's **native pixel dimensions**, not file size — decode
   work rose 48 → 145 → 282 ms per 3 s for 1280 → 1920 → 3840-wide GIFs whose files were all
   ~66–114 KB.
5. **Not confirmed (hypothesis):** that Continuum's architecture (`<html>` `background-image` +
   `<body>` opacity group + `transparent` window) is itself the dominant amplifier. In the
   software-rendered test environment a VS Code-style isolated overlay was **not** cheaper than
   the current approach (it rastered slightly more). This must be re-verified on GPU hardware;
   a hardware-accelerated environment could not be reproduced here (§5.4, §7).
6. **Source-identified amplifiers not exercised by the harness** (medium confidence, ranked in §7):
   the `dialog::backdrop { backdrop-filter: blur(2px) }` rule re-blurs an animating backdrop every
   frame while a modal is open; the Settings preview `<img>` starts a *second* animation timer for
   the same GIF; and there is no dimension cap on imported media (up to a 40 MiB source file).

---

## 1. Actual rendering paths

### 1.1 Where settings come from

- Storage: `src/main/backgroundSettings.js`. `{ imagePath, opacity }` is stored in the SQLite
  `app_settings` table under `background-settings`. On import the picked file is **copied verbatim**
  into `<appData>/backgrounds/background-<uuid><ext>` (`adoptBackgroundImage`, uses
  `fs.copyFileSync`) — no resizing, no recompression, no dimension inspection.
- Accepted extensions (`IMAGE_EXTENSIONS`): `.png .jpg .jpeg .webp .gif .avif .bmp .ico`.
  Video extensions are not accepted.
- Size guard: `MAX_FILE_BYTES = 10 * 1024 * 4096` = **41,943,040 bytes (40 MiB)**. The error string
  says "smaller than 10 MB" and the code comment says "TODO: make it less than 10MB", so the limit
  is both mislabelled and unusually generous. **There is no limit on pixel dimensions or frame
  count.**
- IPC: `src/main/ipcHandlers.js` lines 214–225 (`background:get`, `background:set-opacity`,
  `background:remove`, and the picker/import handler).

### 1.2 How it is painted (the important part)

`src/hooks/useBackgroundSettings.js` runs once from `AppContent` (`src/App.jsx`). It:
1. reads the saved settings,
2. converts the path to a `media://` URL (`mediaSource`),
3. **decodes the image once as a probe** (`verifyImageUrl` → `new Image()`), then
4. calls `applyUiLayer(document, { imageUrl, opacity })`.

`src/utils/uiLayerOpacity.mjs#applyUiLayer` sets, as inline styles:

```
document.documentElement.style.backgroundImage = `url("media:///…")`
document.documentElement.style.backgroundSize    = "cover"
document.documentElement.style.backgroundPosition = "center"
document.documentElement.style.backgroundRepeat   = "no-repeat"
document.documentElement.style.setProperty("--bg-ui-opacity", factor)
document.body.style.opacity = factor            // only when factor < 1
```

So the design is a **single composited UI layer**:

```
<html>  ← background-image (the wallpaper, full brightness)
  <body style="opacity: .85">   ← one :stacking context / compositing group
    …entire app (opaque surfaces, portals, dialogs)…
  </body>
</html>
```

The whole opaque UI is rendered into one group and then blended **once** over the image at the
configured alpha. `opacity: 1` removes the `<body>` property so no group is created.

### 1.3 Window-level facts that affect compositing (`main.js`)

```js
mainWindow = new BrowserWindow({
  width: 1200, height: 800,
  frame: false,
  transparent: true,        // ← window surface carries alpha
  alwaysOnTop: true,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
});
mainWindow.webContents.setZoomFactor(1.2);   // ← rasterizes at 1.2× CSS pixels
```

`backgroundThrottling` is never set, so Chromium's default throttling for hidden/occluded windows
applies.

### 1.4 Two more CSS rules that only apply while a background image is set (`src/index.css`)

```css
html[data-bg-image="true"] dialog          { opacity: var(--bg-ui-opacity, 1); }
html[data-bg-image="true"] dialog::backdrop{ backdrop-filter: blur(2px); }
```

Top-layer `<dialog>`s are outside the `<body>` group, so they get the same opacity factor
individually, and their backdrop applies a blur.

### 1.5 Settings preview (a second consumer of the same media)

`src/components/settings/BackgroundSettings.jsx` renders a visible preview:
`<img src={mediaSource(settings.imagePath)} className="h-32 w-full object-cover">`. For a GIF this
is a **second, independent animation** of the same file while the Settings view is open.

---

## 2. Static images — investigation results

| Concern | Finding | Evidence |
| --- | --- | --- |
| Image dimensions / decoded pixel memory | Real and unbounded. Decoded memory ≈ `W × H × 4` bytes, independent of file size. A 3840×2160 source is **~33 MB decoded** from a **46 KB** file. | Arithmetic + asset table (Appendix B); source (no dimension check) |
| Repeated decoding / source reloads / remounts | The image is applied imperatively to `documentElement` from a non-React helper. It is **not** re-applied on React renders (confirmed: 0 React renders during animation; the hook only runs on mount and on the `background-changed` event). One **extra decode** happens at load via the `new Image()` probe (`verifyImageUrl`), separate from the CSS decode. | Source: `useBackgroundSettings.js` 39–59, 84–110; measured React render count = 0 |
| Large images resized/processed unnecessarily | Yes: the managed copy is stored at full original resolution and only scaled at paint time by `background-size: cover`. No downscale step exists. | Source: `backgroundSettings.js#adoptBackgroundImage` |
| CSS opacity / blur / filters / blend modes | `<body>` opacity creates a full-window compositing group. `dialog::backdrop` adds a blur (only while a dialog is open). No blend modes. | Source: `uiLayerOpacity.mjs`; `index.css` 1226–1232 |
| Background on a frequently rerendering component | No — it lives on `documentElement`, outside React, and is set once. | Source; React render count = 0 |
| Repeated paint / rasterization across the window | **None while idle.** A static background produced **0** raster tasks and **0** image-decode tasks in the 3 s measurement window (it is painted once, then cached). | Measured (§5, tables) |
| Duplicate rendering of the same background | One live copy on `<html>`. Transient duplicates: the load-time probe decode, and the Settings preview `<img>` (shared Chromium image cache, but a second animation timer for GIFs). | Source |
| Renderer memory / GPU pressure | Decoded pixel memory can be tens of MB for a single large static image; bounded here because a static image is decoded once and reused. | Arithmetic; measured: no ongoing work |

**Conclusion (static):** a static image is essentially free while idle. Its only real costs are
(a) one-time decode of the full-resolution image (which is why decoded dimensions matter more than
file size), and (b) the persistent full-window `<body>` opacity compositing group. Neither showed
up as measurable idle work in this environment.

---

## 3. Animated GIFs — investigation results

Everything in §2 applies, plus:

| Concern | Finding | Evidence |
| --- | --- | --- |
| Frame dimensions / frame count / complexity | No cap. Stored at native size and frame count. Decode work is dominated by frame dimensions. | Source; measured decode scaling |
| CPU cost of decoding frames | Continuous while visible. Decode ~48 / 145 / 282 ms per 3 s for 1280 / 1920 / 3840-wide GIFs (first use of each URL). | Measured (§5) |
| Paint invalidation / raster / compositing | Continuous full-window raster: ~1800 raster tasks per 3 s at both 1280×800 and 1920×1080, ~344–619 ms of raster CPU per 3 s depending on GIF size. | Measured (§5) |
| Large surfaces repeatedly painted because the GIF changes | Yes — the root-element background is re-rastered each frame (≈ 24 tiles/frame, ~25 fps). | Measured: RasterTask count ≈ 10× frame count; PrePaint ≈ frame count |
| CSS effects adding work per frame | `<body>` opacity group is re-blended each frame; `dialog::backdrop` blur re-runs each frame while a modal is open (source-based, not measured). | Source |
| Animation recreated / reloaded / duplicated | Root background = one animation. The Settings preview = a second animation while open. Opacity changes re-run `refresh()` → probe decode + re-set `background-image`. | Source |
| Correlates with React rerenders, or independent of React? | **Independent of React.** 0 React renders during animation; cost is in Chromium's image/paint pipeline. | Measured React render count = 0 |

**Conclusion (GIF):** an animated GIF converts a one-time paint into a continuous
decode + raster + composite workload that scales with native pixel dimensions. This is the
confirmed, dominant cause of the slowdown.

---

## 4. Why GIFs are worse than static images (confirmed)

A static image is decoded once and its painted result is cached; the compositor reuses it until
something else invalidates it. An animated GIF invalidates the background surface on every frame:

- Chromium advances the GIF frame at the file's frame delay (here 40 ms → ~25 fps).
- Each advance schedules a paint of the background surface, which rasters the whole window area
  (multiple tiles), and decodes the next frame.
- With `background-size: cover` + `setZoomFactor(1.2)`, that raster happens at ~1.2× CSS pixel
  density across the full window.

Net effect measured at 1920×1080 idle: **~455 ms of raster + ~145 ms of decode per 3 s** for a
1920×1080 GIF, versus **0 + 0** for a static image. That is ~15–20% of one CPU core spent purely
redrawing the wallpaper, before any UI work. Under interaction (scroll) the raster more than
triples (§5.3) and long frames appear.

---

## 5. Controlled profiling

### 5.0 What was actually measured, and what was not

Measured (harness, Appendix A):
- Real `ChatInterface` fixture (real transcript component, opaque, full-window) + the **real**
  `applyUiLayer`/`clearUiLayer` functions.
- Controlled assets with known dimensions (Appendix B).
- `Performance.getMetrics` deltas (Task/Script/Layout/RecalcStyle duration + counts).
- Chromium trace tallies (`RasterTask`, `ImageDecodeTask`, `PrePaint`, `Layout`,
  `UpdateLayoutTree`, `FunctionCall`, GC) in count and total ms.
- In-page `requestAnimationFrame` frame-time distribution (p50/p95/max, count > 50 ms, > 100 ms).
- React render count during each window.

**Not** measured / limitations:
- **No GPU acceleration.** Under Xvfb, ANGLE/EGL could not initialize a display
  (`eglInitialize … Could not open the default X display`), so Chromium ran **software rendering**.
  GPU-process and GPU-compositing costs therefore are **not** represented. This is the single
  biggest caveat: the user's desktop is GPU-accelerated.
- The full App shell was not exercised (no real dialogs, no top-layer, no real `transparent`
  desktop compositor for the main runs). A `transparent:true` + zoom 1.2 variant was run
  separately (§5.4).
- **No user-provided media was tested.** The user's actual background files live on removable
  drives and were not read. Only synthetic assets of known dimensions were used.
- Chromium in this Electron version did not emit `Paint`, `CompositeLayers`, `DrawFrame`, or
  `GPUTask` trace events; paint/composite conclusions rest on `RasterTask`, `ImageDecodeTask`, and
  `PrePaint` counts.

### 5.1 Idle background, 1920×1080, opaque window (3 s window)

```
scenario            p50  p95   max   >50 >100  Taskms Script Layout Style Rend  Rast ms  Rast#  Dec ms  Dec#  PreP#
none                16.7 17.6  21.9   0    0    154    21     0.0    0.0    0     0        0      0       0     182
static-4k           16.6 17.5  18.0   0    0    194    24     0.0    0.0    0     0        0      0       0     182
gif-1280            16.7 20.1  23.4   0    0     70     8     0.0    0.0    0     421.28  1800   48.67   75    181
gif-1920            16.7 24.1  30.1   0    0     72     8     0.0    0.0    0     455.84  1800  144.69   75    181
gif-3840            16.8 28.8  58.0   1    0    123    12     0.0    0.0    0     619.11  1779  281.83   74    175
gif-3840-op100      16.8 24.1  38.4   0    0     93     9     0.0    0.0    0     536.22  1806    2.19   76    181
overlay-gif-1920    16.7 20.9  38.3   0    0    104    11     0.0    0.0    0     727.51  1804  170.03   76    181
overlay-gif-3840    16.6 21.3  24.1   0    0     89    10     0.0    0.0    0     773.98  1824    2.55   76    182
```

Readings:
- **Static = free.** `none` and `static-4k` show 0 raster and 0 decode while idle.
- **GIF = constant raster + decode**, roughly independent of the container mechanism.
- **Decode scales with native dimensions** (1280 → 1920 → 3840: 48.7 → 144.7 → 281.8 ms).
- **`gif-3840-op100` and `overlay-gif-3840` show ~2 ms decode**: these re-use a URL already
  decoded in the previous scenario, so Chromium served it from its decoded-image cache. This is a
  caching artefact, not evidence that large GIFs are cheap — first use cost the full 282 ms.
- **`overlay-gif-*` rastered *more* than the `<html>`-background GIF** (727/774 ms vs 456/619 ms)
  with the same asset. The "isolated overlay" idea was **not** measurably better here.
- **React render count = 0** and **Layout/Style = 0** everywhere → not a React or layout problem.

### 5.2 Idle background, 1280×800, opaque window

```
scenario              p50  p95   max  >50 >100  Taskms Script Layout Style Rend  Rast ms  Rast#  Dec ms  Dec#  PreP#
none                  16.5 17.5  17.6  0   0      39     5    0.0   0.0   0      0        0      0      0     182
static-4k             16.5 17.5  18.1  0   0      40     5    0.0   0.0   0      0        0      0      0     182
gif-1280              16.6 18.2  24.9  0   0      44     5    0.0   0.0   0    348.61  1802   55.27  76    182
gif-1920-op100        16.6 19.2  24.2  0   0      43     5    0.0   0.0   0    343.02  1800   97.76  75    181
gif-1920-op85         16.6 17.6  22.1  0   0      47     5    0.0   0.0   0    378.85  1824    1.22  76    182
gif-1920-op40         16.6 17.5  25.2  0   0      46     5    0.0   0.0   0    380.81  1800    1.25  75    182
overlay-gif-1920      16.6 17.6  18.1  0   0      45     5    0.0   0.0   0    414.14  1802    1.14  76    181
overlay-gif-1920-op85 16.6 17.6  27.7  0   0      46     5    0.0   0.0   0    389.97  1802    1.22  76    181
```

- Varying the UI opacity (40 / 85 / 100) produced **no measurable difference** in raster or frame
  pacing at this size: `378–381 ms` raster for opacity 40/85, and the group-free opacity-100 case
  was `343 ms`. **The `body{opacity}` compositing group did not measurably change the background
  animation cost in software rendering.**
- Adding a `body{opacity}` group on top of the overlay changed nothing measurable either
  (`389.97` vs `414.14`).

### 5.3 Scrolling responsiveness with a background (1920×1080, 3 s of continuous scrolling)

```
scenario              p50  p95    max  >50 >100  Taskms Script Layout Style  Rast ms  Rast#  Dec ms  Dec#
scroll-none           16.6 20.9  118.0  3    2    1058   410   16.9  84.8    910.3   3109    0       0
scroll-gif-1920       17.9 28.9  137.6  3    1     863   364   17.6  57.7   1597.3   4480  252.1   137
scroll-gif-3840       16.7 20.5  106.2  4    2     838   403   16.7  43.5   1053.8   4778  350.55  134
```

- A GIF roughly **doubles the raster work during scrolling** (3109 → 4480 tasks; 910 → 1597 ms
  raster) and adds image decoding on top.
- Long frames (`> 50 ms`, `> 100 ms`) appear during scrolling. (Scrolling itself is already costly
  in this fixture, so treat the absolute deltas as directional; the raster multiple is the robust
  signal.)

### 5.4 Continuum-like window (`transparent: true`, `setZoomFactor(1.2)`) at 1920×1080

```
scenario            p50  p95   max  >50 >100 Taskms Script Rend  Rast ms  Rast#  Dec ms  Dec#
none                16.6 17.5  18.1  0   0     55     7    0     0        0      0       0
gif-1920            16.6 26.4  27.2  0   0     46     5    0    453.57  2256  161.39   76
overlay-gif-1920    16.6 17.6  23.3  0   0     41     5    0    469.68  2280    1.08   76
```

- The transparent + 1.2× window did **not** produce a dramatic regression here
  (`gif-1920`: 453.57 ms / 2256 tasks, essentially the same as the opaque 455.84 ms / 1800 tasks).
  More tiles (2256 vs 1800) are consistent with the 1.2× raster density, but total raster ms was
  flat — again likely because this is software rasterization.
- Overlay results remain comparable, not better.

---

## 6. VS Code script comparison

The user's script was located and read:
`/media/mk_saadi/d_drive/PROJECTS/fonts/bg-player.js`, loaded via
`vscode_custom_css.imports` (be5invis.vscode-custom-css). Its media list references the user's
private files; **no filenames or media content are reproduced here.**

Interpretation of the script was limited to its **architecture**; it was not executed:

- **Isolated background layer.** It creates a dedicated `#custom-bg-wrap` element:
  `position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 99; pointer-events: none;
  overflow: hidden`, prepended to `<body>` — a layer **separate from the editor UI**.
- **Double-buffered `<img>` and `<video>` slots**, each absolutely positioned at `100% × 100%`
  with `object-fit: cover`. Only one slot is visible.
- **Opacity is applied to the background element, not the UI:** `img.style.opacity = 0.15`. The
  editor UI itself stays opaque and is composited on top. There is **no full-UI opacity group**.
- **Crossfade** between slots via a short opacity transition (~1.5 s), then the outgoing slot's
  `src` is cleared and `load()` is called to release the decoded resource/decoder.
- **GIF duration is parsed from a bounded Range request** (first ~512 KB) so a GIF is *retired*
  after its own duration (with a ≥90 s dwell) rather than being left to loop forever in place.
- **Pauses on `visibilitychange` (hidden)** — media/timers stop when the window is hidden.
- **One media decoded at a time** (plus the brief crossfade).

Transferable techniques (all of these are candidates for Phase 3.2, subject to GPU verification):
1. Background lives in its own low-`z` layer **behind an opaque UI** — no whole-app opacity group.
2. Low opacity is applied to the **background element**, not to the UI.
3. Explicit **resource release** when the background changes.
4. **Pause when hidden**.
5. **Bounded work** — one media at a time.

Caveats on the comparison:
- This runs in VS Code, which has a different UI complexity, an **opaque** window, and (in the
  user's setup) mostly **video** media, which decodes efficiently and can be streamed from disk.
  It is not a like-for-like comparison.
- Continuum does **not** support video in this feature, and **adding video support is not
  recommended** here. The transferable ideas are about *where the background lives and how opacity
  is applied*, not about video.
- Consistent with §5, removing the `<body>` opacity group did **not** show a measurable win in
  software rendering, so technique #1/#2 is a **hypothesis** to be validated on the user's GPU, not
  a measured remedy.

---

## 7. Ranked likely root causes

| # | Cause | Confidence | Basis |
| --- | --- | --- | --- |
| 1 | Animated GIF decodes and re-rasters a full-window surface every frame (native dimensions drive decode cost) | **High — measured** | §5.1/§5.3: 0 → ~1800 raster tasks, 0 → 48–282 ms decode; scales with GIF width |
| 2 | Unbounded media dimensions: source up to 40 MiB, stored verbatim, no dimension/frame cap, scaled only at paint time by `cover` | **High — source** (+ measured decode scaling) | `MAX_FILE_BYTES`; `copyFileSync`; decode ms ∝ dimensions |
| 3 | Persistent full-window compositing group via `<body>{opacity}` (whole UI + portals blended over the animating backdrop each frame) | **Medium — source; not measurably cheaper to remove here** | `uiLayerOpacity.mjs`; §5.2 (no measured delta in software) |
| 4 | `dialog::backdrop{backdrop-filter: blur(2px)}` re-blurs an animating backdrop every frame while a modal is open | **Medium — source** (not exercised) | `index.css` 1230–1232 |
| 5 | `transparent: true` window + `setZoomFactor(1.2)` (alpha window surface, 1.2× raster density) as amplifier | **Low/medium — not reproduced** | `main.js`; §5.4 showed no dramatic regression in software rendering |
| 6 | Duplicate decode/animation: load-time `new Image()` probe, re-probe + re-set on opacity change, and the Settings preview `<img>` starting a second GIF animation | **Medium — source** | `useBackgroundSettings.js` 39–59, 79–90; `BackgroundSettings.jsx` 111–116 |
| 7 | No pause when the window is hidden (relies on Chromium defaults) | **Low** | `main.js` (no `backgroundThrottling` handling) |

---

## 8. Recommended minimal implementation plan (Phase 3.2)

Ordered by leverage-per-risk. All items are proposals; **nothing is implemented in Phase 3.1.**

**P1 — Cap animated-GIF decoded dimensions (highest leverage, measured).**
At import time in the main process (`backgroundSettings.js#adoptBackgroundImage`), when the source
is an animated GIF, downscale frames so the largest dimension ≤ a cap derived from the display
(e.g. `ceil(max(screenWidth, screenHeight) × zoom(1.2) × devicePixelRatio)`, with a hard ceiling
like 2560 px), and cap frame count (e.g. ≤ 150). `sharp` is already a dependency and supports
animated input (`sharp(input, { animated: true })`) with `resize` + `.gif()`.
- Rationale: decode cost scaled with native dimensions (48 → 145 → 282 ms), and the image is always
  displayed with `cover`, so pixels beyond the window are pure waste.
- Keep the non-animated path unchanged (or apply the same cap to oversized static images, which
  reduces one-time decode and decoded memory without changing visible output).

**P2 — Isolate the background from the UI (VS Code technique).**
Move the wallpaper from the `<html>` `background-image` + `<body>` opacity design to a dedicated,
`pointer-events: none`, low-`z-index` fixed layer (`<img ... object-fit: cover>` or equivalent),
with the configured opacity applied to **that layer** and the UI left opaque.
- Rationale: decouples background animation from the UI compositing group; UI repaints no longer
  re-raster/re-blend a full-window group; the background has an independent lifecycle
  (pause/teardown/visibility).
- Caveat: **not a measured win in software rendering** (§5.1/§5.4 — overlay rastered slightly more).
  Treat as a structural improvement to be A/B-verified on the user's GPU.

**P3 — Remove redundant decode/animation work.**
- Split opacity updates from image updates: `setBackgroundOpacity` should update only the opacity
  variable/body-opacity without re-running `verifyImageUrl` + re-setting `background-image`.
- Drop the `new Image()` probe (or verify on a single shared image) so the file is decoded once.
- Ensure the Settings preview does not run a second full animation of the same GIF (e.g. render a
  static first frame, or a non-animated thumbnail).

**P4 — Pause when hidden.**
Stop/omit the animated layer while `document.hidden` (or on window `blur`/minimize), and resume on
return. Low effort; complements Chromium's default behavior.

**P5 — Copy/limits hygiene (no behavior change).**
Fix the misleading 10 MB message and decide whether 40 MiB is intended; consider a dimension guard
with a clear message at import time.

Non-goals for Phase 3.2: adding video support, redesigning the background UI, changing the
persistence format, or reworking the transcript/layout (Phase 3 sidebar work).

---

## 9. Regression risks

- **Contract/architecture tests.** The `<html>` `data-bg-image` attribute, the `--bg-ui-opacity`
  variable, the `<body>` opacity semantics, and the `uiLayerOpacity.mjs` helpers are referenced by
  existing tests and by `index.css` dialog/backdrop rules. P2 changes all of these; any test that
  asserts the current mechanism must be updated deliberately.
- **Top-layer dialogs and portals.** `<dialog>` elements and portal roots are outside the `<body>`
  group and currently rely on `dialog { opacity: var(--bg-ui-opacity) }` and the backdrop blur.
  Moving to an isolated background layer must keep dialogs visually consistent (or intentionally
  normalize them) and must not change the `dialog::backdrop` behavior accidentally.
- **Persistence/IPC contract.** P1 writes a transformed copy into the managed `backgrounds/`
  directory. Verify that "Replace image…", "Remove image", re-import, and stale-file cleanup still
  behave, and that nothing asserts a byte-for-byte copy of the picked file.
- **Animation fidelity.** Resizing animated GIFs can drop frames, alter palette/dithering, or
  change file size. Verify frame count, loop behavior, and visual output on a real GIF.
- **Stacking/interaction.** The isolated layer must not intercept pointer events, must stay behind
  the UI, and must not break the `rounded-xl` root corners or the transparent-window shadow.
- **Opacity semantics.** `opacity = 100` must still create no compositing group; the 40–100 range,
  clamping, and "applies only while an image is set" behavior must be preserved.
- **Non-GIF paths.** Static PNG/JPEG/WebP/AVIF/BMP/ICO and the no-image state must be unchanged.

---

## 10. How to measure the improvement

Reuse the harness in Appendix A (same window size, same assets, same `MS`) and compare before/after
on **GPU hardware** (the environment used here was software-rendered, which is exactly why P2 must
be re-verified).

Acceptance signals for Phase 3.2:
1. **Idle GIF raster:** `RasterTask` ms and count should drop toward the static baseline
   (currently ~455 ms / ~1800 per 3 s at 1920×1080). Success = a large reduction in raster ms,
   demonstrating the decode/scale work was bounded (P1) and/or decoupled (P2).
2. **Idle GIF decode:** `ImageDecodeTask` ms should drop in proportion to the dimension cap
   (currently 48 → 145 → 282 ms for 1280 → 1920 → 3840).
3. **Scroll with a background:** no frames `> 50 ms` attributable to the background; raster during
   scroll should not double (currently 910 → 1597 ms, 3109 → 4480 tasks).
4. **Opacity change:** changing opacity must produce **0** image-decode tasks (currently the change
   path re-probes the image).
5. **React render count** during background animation must remain 0 (no regression into React).
6. **No visual regression:** background still visible at the configured opacity; static images,
   dialogs, portals, rounded corners, and the transparent-window shadow unchanged; accessibility
   and pointer-event behavior unchanged.
7. **GPU-process check on real hardware:** record `app.getGPUFeatureStatus()` and confirm GPU
   compositing is active, then re-run §5.1/§5.3 to validate P2 on an accelerated path.

Guard against a false positive from Chromium's decoded-image cache: always measure the **first use**
of each media URL in a fresh window, or alternate two different files.

---

## Appendix A — Measurement harness

Location (outside the repo, retained for reproduction): `/tmp/opencode/bgaudit/`.

- `fixture.jsx` — renders the **real** `ChatInterface` (same stub store as the sidebar suite) and
  exposes `window.__applyBg(url, opacity)` calling the **real** `applyUiLayer`/`clearUiLayer`.
- `run.cjs` — Electron main: `esbuild` bundles the fixture, loads it in a `BrowserWindow`, drives
  scenarios, records `Performance.getMetrics`, a `contentTracing` trace
  (`devtools.timeline`, `disabled-by-default-devtools.timeline`, `…timeline.frame`, `toplevel`,
  `benchmark`, `viz`, `cc`), and an in-page rAF frame-time sampler; optionally scrolls the
  transcript and can emulate `transparent: true` + zoom 1.2 (`TRANSPARENT=1 ZOOM=1.2`).
- Invocation:
  `env -u ELECTRON_RUN_AS_NODE WIDTH=1920 HEIGHT=1080 xvfb-run -a node_modules/electron/dist/electron --no-sandbox /tmp/opencode/bgaudit/run.cjs`
- Two mechanisms compared: `html` (Continuum: `<html>` background + `<body>` opacity) and
  `overlay` (VS Code-style: fixed `<img object-fit:cover>` layer with opacity on the element, UI
  opaque).

Environment: Electron 44.7.0, Node from the repo, Xvfb, `--no-sandbox`. **Software rendering**
(ANGLE/EGL unavailable: `Could not open the default X display`), so GPU-process/compositing costs
are not represented. HP/NVIDIA and virtual GPU devices were detected but could not be initialized
under Xvfb.

## Appendix B — Controlled assets

| File | Dimensions | File size | Decoded frame memory (`W×H×4`) |
| --- | --- | --- | --- |
| `static_1280x720.png` | 1280×720 | 9.3 KB | 3.7 MB |
| `static_3840x2160.png` | 3840×2160 | 46.6 KB | 33.2 MB |
| `gif_1280x720_20f.gif` | 1280×720, 20 frames | 66.2 KB | 3.7 MB/frame (~74 MB total) |
| `gif_1920x1080_24f.gif` | 1920×1080, 24 frames | 104 KB | 8.3 MB/frame (~199 MB total) |
| `gif_3840x2160_12f.gif` | 3840×2160, 12 frames | 114 KB | 33.2 MB/frame (~398 MB total) |

Frame advancement was verified with `ImageDecoder` (`frameCount = 24`, animated GIF), and
independently by the trace (static → 0 raster/decode; GIF → ~1800 raster tasks + ~75 decodes per
3 s).

## Appendix C — Source references

- `src/main/backgroundSettings.js` — storage, `MAX_FILE_BYTES`, extension whitelist, verbatim copy.
- `src/main/ipcHandlers.js` lines 214–225 — `background:get`, `background:set-opacity`,
  `background:remove`, picker/import.
- `src/hooks/useBackgroundSettings.js` — `resolveBackground`, `verifyImageUrl`, `refresh`, event.
- `src/utils/uiLayerOpacity.mjs` — `applyUiLayer`/`clearUiLayer`/`readUiLayer`, opacity semantics.
- `src/index.css` lines 1226–1232 — `dialog` opacity + `dialog::backdrop` blur.
- `src/App.jsx` line 48 — `useBackgroundSettings()` at the app root.
- `src/components/settings/BackgroundSettings.jsx` — picker/opacity UI, preview `<img>`, events.
- `main.js` lines 150–174 — `transparent: true`, `alwaysOnTop`, no `backgroundThrottling`,
  `setZoomFactor(1.2)`.
- `/media/mk_saadi/d_drive/PROJECTS/fonts/bg-player.js` — the user's VS Code background script
  (read for architecture only).
