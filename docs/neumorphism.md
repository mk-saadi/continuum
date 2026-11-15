# Neumorphic appearance

Neumorphism replaces Aero Glass as the default material. Flat and Skeu remain
registered with their existing palettes, styles and geometry. The command
spotlight and Appearance settings both expose the new name.

`src/styles/neumorphism.css` derives its material, paired shadow colors
and elevations from the active palette. Dark mode uses a smaller white mix to
avoid luminous rims. Controls use 3px/6px paired shadows, cards 4px/9px, and model
rows 2px/5px. The chat-history container shares the same material as its sidebar. Fields use a shallow 2px/5px inset; pressed and selected controls use a separate
1px/3px inset so small buttons do not become deep wells. Corners are 16px for
controls, 12px for fields and model rows, 20px for cards and 24px for modal shells. Icon
buttons remain circular. Transcripts and nested reading panels stay quiet.

The borderless material follows `NEUMORPHISM_PROMPT.md` and
`NEUMORPHISM_DESIGN_SYSTEM.md`, refined by the user’s screenshot feedback.
Cards and controls have transparent decorative borders, including selected controls.
Headers, navigation, footers and existing layout dividers retain subtle palette-derived
separators. Raised surfaces use a near-white highlight in light mode and a stronger
10% white mix in dark mode, making the top-left lighting visible in both modes.
Selection uses shallow relief, accent text and existing checks/status indicators.
Primary buttons share the base material with accent text. Keyboard focus, invalid
fields and forced-colors boundaries remain visible. The standalone reference HTML
was not included, so pixel-for-pixel equivalence cannot be established.

## Compatibility and migration

The canonical stored value is `neumorphism`. The early HTML boot script and
appearance store normalize legacy `aero`, including storage events from other
windows, and rewrite it to the canonical value. Both `data-appearance` and
`data-style` stay synchronized. Read-only storage still changes the material in
memory. Existing `flat` and `skeu` values remain unchanged.

The `.aero-*` component hooks and old material stylesheet remain because Flat
and Skeu also consume them. Aero-only selectors now explicitly require `aero`,
which normal application startup and setters no longer produce. Neumorphism
neutralizes all reflection and blur tokens and supplies its own scoped material
rules. Material rules do not change position, stacking, overflow or hit areas.

## Validation

Build with `npm run build`. Run preference/startup migration checks with
`node --test tests/appearance.test.mjs`. Run browser validation with:

```sh
CHROME_PATH=/usr/bin/google-chrome NEU_REVIEW_DIR=/tmp/neu-review node tests/neumorphism.ui.cjs
```

The browser suite uses real React components and mocked backend data, with all
production stylesheets and the required toast provider. It checks token
resolution, primary text contrast (at least 4.5:1), borderless surfaces and shallow
selected controls for 22 palettes, captures representative Gruvbox Light/Dark, default
Light/Dark and Lilac screens, and checks positioned model actions, responsive
modal footers, forced colors and reduced motion. It also captures Flat and Skeu
for comparison. Historical Aero screenshot suites describe the retired material;
this suite is the current appearance acceptance entry point.

The full unit suite in this environment reported 244 passing and 89 failing test
files. A separately inspected failure in `agentTools.test.cjs` expects 44 tools
but receives 18; this change does not alter tool registration. Full-suite failures
have not all been diagnosed. Production build reports the existing large-chunk
warning. Browser fixtures do not validate a packaged Electron window, live model
inference or operating-system window chrome.
