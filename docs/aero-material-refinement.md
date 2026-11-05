# Aero material refinement

The shared implementation now distinguishes reflective window chrome from
quiet content and glossy controls. Layout, density, theme palettes, appearance
persistence, shared radius tokens, and Electron configuration are unchanged.

## Shared implementation

- `src/index.css`: theme-derived chrome tint/opacity, diagonal reflection,
  illuminated edges, shallow content gradient, accent shading, localized glow,
  and separate light/dark lighting values. Solarized Dark shares the shaded
  accent material used by light palettes because its accent labels are white.
- `src/styles/aero.css`: reflective dialog/popover shells and chrome bands;
  unfiltered content cards and nested fills; stable recessed inputs/composers;
  calm checkbox containers and section headers; explicit selected hover and
  pressed states; keyboard focus within dialogs; environmental fallbacks.
- `src/styles/appearance.css`: resets every new material token needed by Flat.
  Dark lighting selectors deliberately use `:where` so Flat overrides win.
- `FormControls.jsx`, `MemorySettings.jsx`, and `Titlebar.jsx`: identify checkbox
  containers, content section headings, and window title chrome by role.
- `IntegrationsTab.jsx`: the Aero error status uses the theme's error ink rather
  than the darker error ink. Flat keeps its existing status color.
- `projects.css`: removes the broad heading text shadow. Cards share the quiet
  panel recipe, with a subtle hover rim/shadow and no lifting animation.

The native window already uses `frame: false` and `transparent: true`. No native
window behavior was changed. CSS glass filters app content behind the surface;
it does not promise desktop blur or desktop visibility. Dialog backdrop dimming
and its existing 2px page blur are separate from the shell's 18px material blur.

Panels, empty states, tooltips, controls, and nested surfaces have no backdrop
filter. Small title/tab/toolbar bands and floating shells own the glass blur;
headers inside dialogs share the shell's filter rather than adding another.
Animated-wallpaper, reduced-motion/transparency, forced-colors, and unsupported
filter fallbacks remain in the shared stylesheet. There are no reflection
pseudo-elements or blur animations.

## Validation

After building, run:

```sh
npm run build
node --test tests/appearance.test.mjs tests/settingsPanels.test.mjs
CHROME_PATH=/usr/bin/google-chrome AERO_REVIEW_DIR=/tmp/continuum-aero-review node tests/aeroMaterials.ui.cjs
```

`CHROME_PATH` is optional when Playwright's matching browser is installed.
The visual suite renders actual React components with deterministic mock IPC;
it never starts inference or changes real user settings.

Passed:

- Production build and the existing appearance/settings-panel unit suites.
- All 22 themes × Aero/Flat: resolved shell/panel tokens, primary reading
  contrast, no content blur, and no extra filters inside the Settings dialog.
- Aero accent label contrast at the brightest end of the reflection: at least
  4.5:1 in every palette, using the existing on-accent ink.
- Screenshots inspected for Gruvbox Dark, Default Dark, Default Light, and Lilac
  Light, with Aero on/off: title/tab/toolbar chrome, Settings, MCP Integrations,
  Projects grid, project workspace, and model load dialog.
- Hover, pressed, selected, disabled rendering, keyboard focus/navigation,
  MCP switches and expansion, composer focus, and model footer visibility at
  1280px and 700px widths. Forced colors, reduced motion, and animated-wallpaper
  filter opt-outs also checked in Chromium.
- Separate computed-style comparison against commit `53f1d7b`: Flat fills,
  gradients, borders, radius, text color, shadow, and filters match across all
  22 palettes for the shared shell, header, nav, footer, panel, fill, well,
  control, selected control, primary, orb, and empty-state recipes.
- `git diff --check`.

Existing checks with baseline failures:

- `tests/memorySettings.ui.cjs`: `Keyboard tab focus` assertion in the hidden
  Electron window. The same assertion fails in an isolated, unchanged copy of
  `53f1d7b`; real keyboard navigation/focus passes in the new Chromium suite.
- `tests/projects.test.cjs`: expects a system prompt containing `Complete the
  user`. The same assertion fails in the isolated baseline.
- The existing Projects Electron UI harness exits successfully.

## Limits

The attachment contained the written brief but no screenshot image files, so
reference-image matching could not be checked. Visual validation uses real
components with mock data, not the user's running production session or native
OS compositing. Solarized's existing secondary text/surface palette pairs are
about 4.1:1; those palette values were preserved. The contrast checks are not a
full accessibility audit or a guarantee for arbitrary wallpapers and user-set
whole-UI opacity.
