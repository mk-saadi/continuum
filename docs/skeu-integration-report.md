# Skeu integration

Skeu is a third UI design style in Settings → Appearance → UI design style.
Aero Glass and Flat retain their existing preference values and material recipes.
Theme selection remains independent; every existing palette is preserved.

## Reference-material revision

The current target is the physical material construction in
`/home/mk_saadi/projects/test-projects/aero-skeu/aero-skeu-exp`, specifically
`src/components/Settings.css` and `src/components/Projects.css`. The earlier
Continuum version was too flat. The revision transfers hard 3px control feet,
2px lower bevels, compact contact shadows, 3px/6px recessed wells, stepped card
edges, diagonal housing machining, and horizontal panel finishes. It does not
copy olive/gold palette constants, folder silhouettes, font choices, or layout.

`docs/SKEU-IMPLEMENTATION.md`, the portable `docs/skeu.css`, and both runtime
Skeu stylesheets now describe/implement this target. Housing finishes are
self-painted backgrounds occluded by opaque child surfaces, rather than
parent overlays over reading content. Texture opt-out, print, and forced colors
remain supported. The reference's animated filter/shadow/translation effects
were not copied.

Validation: production build, focused unit suites, and the complete rendered
Skeu suite pass. Captures include Ember Dark, Gruvbox Dark, Papaya Dark, Default
Light, and Lilac. The 22-theme contrast/state checks also pass. SHA-256 comparison
before/after confirms `src/index.css` and `src/lib/themes.mjs` are unchanged.
Current captures: `/tmp/continuum-skeu-relief-review/`.

## Architecture and geometry

- `src/lib/appearance.mjs` accepts `skeu`, persists it using the existing
  `appearance` key, restores it, and synchronizes windows. It updates both the
  existing `data-appearance` and the kit's `data-style` on `html`. This ancestor
  covers the app, body portals, tooltips, and native top-layer dialogs.
- The existing theme picker registry moved to `src/lib/themes.mjs`. Its mode
  metadata supplies `data-theme-mode` through `applyTheme`; palette values still
  live in `src/index.css`. There is no second palette registry.
- `src/styles/skeu-kit.css` adapts the supplied `docs/skeu.css`: demo dimensions,
  padding, and type styles were removed so existing component layouts win.
  Explicit scoped hooks have enough specificity to replace the unlayered Aero
  recipes. `src/styles/skeu.css` owns the palette adapter and material bridges.
- Shared geometry in `src/styles/radius.css`: Skeu uses 2px details, 3px controls,
  and 6px housings. Pills use the control radius in Skeu, while actual circles
  (icon buttons, status dots, radio indicators, and switch thumbs) stay circular.
  Aero and Flat keep their existing sizes and pill shapes. No Tailwind radius
  classes were introduced into component className props.
- Readable accent shading was factored into shared `--ui-accent-*` inputs so
  Skeu does not depend on enabling Aero. Accent gradient endpoints retain the
  existing on-accent foreground and achieve at least 4.5:1 in all 22 palettes.

## Materials and textures

Opaque molded housings, satin chrome, shallow content bevels, recessed fields,
quiet reading/list surfaces, glossy selected actions, inset pressed states,
localized hover rims, and visible keyboard focus use the shared hooks.
Checkbox rows keep helper text readable when the checkbox is disabled.
MCP switches are native checkbox switches in Skeu; existing controls are kept
for Aero/Flat. Theme choices use a radio group with roving keyboard focus.
The style selector uses native radio buttons and native keyboard behavior.

Textures are static, neutral finishes scoped exclusively to Skeu:

- Grain: modal headers, titlebar, toolbar chrome.
- Brushed: tab strips, as a sibling of the grain-textured chrome bands.
- Satin: fine horizontal finish on card housings; panel backgrounds also carry
  a fine horizontal finish. Canvas, housing, sidebar, and section chrome have
  a diagonal machined background finish.

Opaque child surfaces occlude the parent background finish; no parent overlay
is painted over child reading surfaces. Inputs, dropdown content,
path wells, chat transcripts, code, helper-copy containers, and dense lists
remain untextured. Existing pseudo-elements were checked before adding hooks.
Texture overlays use local isolation, inherited clipping radius, negative
stacking within the housing, and no pointer events. Existing portal logic is
unchanged. They introduce no animation, blur, blend mode, network asset, or
compositor promotion. Motion only transitions color/border; shadows change
immediately. Texture hooks disappear outside Skeu, in forced colors, and in
print. `data-texture="off"` on `html` or a housing disables texture without
changing its material. No additional preference was added.

The actual Electron renderer successfully decoded the embedded grain using the
app's unchanged CSP (`img-src` already permits `data:`). Switching to Aero
removed the overlay. Native transparency/window configuration was not changed.
Skeu surfaces have no backdrop filters; the existing modal backdrop is separate.

## Verification

Commands:

```sh
npm run build
node --test tests/appearance.test.mjs tests/themes.test.mjs tests/settingsPanels.test.mjs
CHROME_PATH=/usr/bin/google-chrome SKEU_REVIEW_DIR=/tmp/continuum-skeu-review node tests/skeuMaterials.ui.cjs
CHROME_PATH=/usr/bin/google-chrome AERO_REVIEW_DIR=/tmp/continuum-aero-review-final node tests/aeroMaterials.ui.cjs
```

The browser suites render actual components with deterministic mock IPC and
never start inference. `CHROME_PATH` is optional when the corresponding
Playwright browser is installed. Captures and JSON contrast results are saved
to the requested review directories. Before/after captures compare Aero and
Skeu using the same components/data.

Checked:

- All 22 theme mappings, mode metadata, opaque/nonfiltered shell behavior,
  tight radii, and primary text/accent contrast at gradient endpoints.
- Settings, MCP, Projects grid, workspace, model dialog, and app chrome in
  Ember Dark (slate/peach), Gruvbox Dark, Default Light, and Lilac Light.
- Preference selection/restoration and cross-window synchronization; native
  style radios and button-radio theme navigation, including wrapping/Home/End.
- Native MCP switches and tool checkboxes; modal dropdown portal scope;
  keyboard focus; pressed, selected, disabled, readonly, invalid,
  indeterminate, loading, error, and empty states where supported by fixtures.
- Stable model footer while scrolling and at effective viewports of 1280×900,
  1024×720, 853×600, and 700×740. Texture captures at 100%, 125%, 150%, and 200%
  CSS scale; forced-colors, reduced-motion, print, and explicit texture opt-out.
- A populated 60-project grid: static card finishes, no backdrop filters,
  search/empty recovery, hover without movement, scrolling and clipping.
- A separate before/after computed-style comparison across all 22 palettes:
  Aero and Flat shared fills, gradients, borders, radii, text, shadows, and
  filters match their pre-Skeu values (transitions disabled for comparison).
- The actual sandboxed Electron renderer loaded the grain under the original
  CSP, then removed it when leaving Skeu.
- Production build, focused unit suites, Aero material regressions, the existing
  Projects Electron UI harness, and `git diff --check`.
- Across the 22-theme audit, the minimum primary-text endpoint contrast was
  4.56:1, accent-label endpoint contrast 4.65:1, and focus/input contrast 3.21:1.

Existing baseline failures remain as documented in `aero-material-refinement.md`:
`tests/memorySettings.ui.cjs` has a hidden-window keyboard-focus assertion;
`tests/projects.test.cjs` expects obsolete system-prompt text. Both reproduced
before the style changes. Their unrelated behavior was not rewritten here.

## Practical limits

Visual tests use real components with mock data, not a production user session.
Scale/reflow screenshots are renderer checks, not certification across physical
DPI settings or every operating system/window manager. The populated-grid check
is a scrolling/rendering smoke check, not a GPU performance benchmark. Existing
low-contrast muted palette pairs (notably Solarized) were preserved; this is not
a full accessibility audit or a contrast guarantee for arbitrary user opacity
settings. The written guide and CSS kit were available; no original reference
screenshot image files accompanied the request.

## Files

Foundation, settings behavior, and styling:

- `index.html`
- `src/main.jsx`
- `src/App.jsx`
- `src/context/UIStateContext.jsx`
- `src/lib/appearance.mjs`
- `src/lib/themes.mjs`
- `src/lib/radioChoices.mjs`
- `src/index.css`
- `src/styles/radius.css`
- `src/styles/aero.css`
- `src/styles/skeu-kit.css`
- `src/styles/skeu.css`
- `src/components/settings/AppearanceSettings.jsx`
- `src/components/main-app/MemorySettings.jsx`

Shared-component hooks and screen coverage are listed below. Hooks are inert
outside the Skeu scope; existing component dimensions and interactions remain.

- `src/components/AdditionalPrompts.jsx`
- `src/components/AgentSettingsPopover.jsx`
- `src/components/AvatarSettings.jsx`
- `src/components/ChatHistory.jsx`
- `src/components/ChatInputBar.jsx`
- `src/components/ChatTuning.jsx`
- `src/components/CloudProviderSettings.jsx`
- `src/components/ContextPanel.jsx`
- `src/components/DirectorySettings.jsx`
- `src/components/FormControls.jsx`
- `src/components/IntegrationsTab.jsx`
- `src/components/LocalApiSettings.jsx`
- `src/components/MemoryTab.jsx`
- `src/components/ModelCapabilitiesModal.jsx`
- `src/components/ModelProfileSettings.jsx`
- `src/components/ModelSettingsModal.jsx`
- `src/components/ProjectModal.jsx`
- `src/components/ProjectWorkspace.jsx`
- `src/components/ProjectsView.jsx`
- `src/components/RightSidebar.jsx`
- `src/components/Sidebar.jsx`
- `src/components/TabBar.jsx`
- `src/components/ToolCallBlock.jsx`
- `src/components/Tooltip.jsx`
- `src/components/chat/BackgroundCommandCard.jsx`
- `src/components/chat/DiffReviewModal.jsx`
- `src/components/chat/RecoveryCard.jsx`
- `src/components/chat/RecoveryHistoryModal.jsx`
- `src/components/chat/TextSelectionMenu.jsx`
- `src/components/chat/WorkspacePlanCard.jsx`
- `src/components/main-app/ChatInterface.jsx`
- `src/components/main-app/Header.jsx`
- `src/components/main-app/MemorySettings.jsx`
- `src/components/main-app/ModelSelectorModal.jsx`
- `src/components/main-app/Titlebar.jsx`
- `src/components/project/ProjectSkillsCard.jsx`
- `src/components/settings/AppearanceSettings.jsx`
- `src/components/settings/McpSettingsTab.jsx`
- `src/components/settings/SettingsSection.jsx`
- `src/components/settings/TokenHistory.jsx`
- `src/components/settings/usage/AttributionView.jsx`
- `src/components/settings/usage/ModelDetailPanel.jsx`
- `src/components/settings/usage/ModelSpendingTable.jsx`
- `src/components/settings/usage/PricingHistoryView.jsx`
- `src/components/settings/usage/ProviderBreakdownTable.jsx`
- `src/components/settings/usage/SpendingTimeline.jsx`
- `src/components/settings/usage/UsageCostsDashboard.jsx`

Validation sources:

- `tests/appearance.test.mjs`
- `tests/themes.test.mjs`
- `tests/skeuMaterials.ui.cjs`
- `tests/fixtures/materialScope.mjs`
- `tests/fixtures/memorySettings.jsx`
- `tests/fixtures/projects.jsx`
- `tests/fixtures/aeroModelSettings.jsx`

The existing Aero review fixtures/suite are reused for regression validation.
