# Continuum: skeuomorphic style implementation

## Objective and visual reference

Use `/home/mk_saadi/projects/test-projects/aero-skeu/aero-skeu-exp` as the physical-material reference. Its `src/components/Settings.css` Skeu block and the original Skeu rules in `src/components/Projects.css` define the target: substantial molded controls, hard lower contact edges, deep recessed wells, stacked card edges, and visible fine surface finishes. The previous Continuum pass was too flat and restricted textures too much.

**Preserve Continuum's theme colors exactly.** Do not copy the reference's olive surfaces, gold accent, cream ink, hardcoded palette overrides, or font/layout system. All 22 palettes, their token definitions, accent identity, and foregrounds remain owned by Continuum. Transfer only neutral lighting, relief geometry, and texture construction, using existing semantic palette inputs.

Keep Continuum's layout, density, routing, content, and behavior. The reference's folder tabs and different toolbar layout are not required to reproduce the material treatment. Use the shared style-dependent corner tokens; housings remain compact rectangles and real icon controls can remain circular.

## Reference construction to transfer

- **Raised controls:** illuminated upper rim, 2px inner lower bevel, a hard 3px contact foot, then a small 5–8px ambient shadow. A soft shadow alone is insufficient.
- **Recessed fields:** a 3px/6px inner top shadow and fine lower illuminated rim. Keep text surfaces opaque and untextured.
- **Panels:** directional neutral lighting, upper/left bevels, lower contact edge, and a compact shadow. They must visibly sit above the canvas.
- **Project cards:** several tight lower edge steps, inspired by the reference's physical jackets, without adding folder silhouettes or changing card spacing.
- **Housing/canvas/chrome:** fine static diagonal machining at about 110°, repeated every 4px. Settings sidebar, section header, and housing need this finish too—not only a barely visible noisy header overlay.
- **Broad panels/cards:** fine horizontal finish, approximately 1px every 3px. Avoid the previous crossed diagonal hatch on every project card.
- **Color:** neutral white/black highlights and shadows over Continuum's existing surfaces. Never import reference palette constants or rewrite `src/index.css` theme definitions.

## Deliverables and scope

- Integrate the accompanying `/docs/skeu.css` as a reusable, opt-in material layer.
- Map existing semantic theme tokens to its palette inputs for all themes.
- Apply the layer to shared components and all screens listed below.
- Preserve the current appearance when the style is not selected.
- Provide rendered before/after captures and a concise verification report.
- Inspect repository instructions and existing architecture first. This guide is for the main Electron app; do not assume this experimental repository contains its components.

## Implementation order

1. Find the theme registry, theme mode metadata, Aero toggle, CSS import order, shared components, portal containers, and Electron draggable regions.
2. Identify current gradients, hardcoded palette values, broad selectors, inline styles, and duplicate component effects. Remove or scope conflicting effects when integrating rather than stacking shadows on top of them.
3. Use the existing style selection mechanism. If Aero must remain available, expose Skeu as a distinct style option using existing preference persistence. Do not silently rename Aero or change saved preferences. Keep theme selection independent of material style.
4. Import `/docs/skeu.css` after base/component styles, then add component-specific layout adjustments only where needed. Low-specificity component selectors allow integration overrides; inspect the actual cascade before adding specificity.
5. Establish Settings and its controls first. Then migrate the shared primitives, Projects, project workspace, MCP, and model settings.
6. Validate both modes and representative themes visually; verify the remaining theme token mappings.

## Material rules

Use one implied light source above the interface. Top edges catch light; lower edges darken. Keep shadows small enough to retain the existing compact desktop character.

- App canvas: theme-colored and visually behind panels, with a fine static machined finish.
- Window shells: raised opaque housing with a fine edge and a larger ambient shadow.
- Headers/toolbars: satin gradient and top highlight, separated by a fine rule.
- Panels/cards: a definite lower contact edge, upper bevel, restrained directional gradient, and fine horizontal finish. Use `.sk-satin` selectively for the broad top reflection visible in the screenshots. Do not put a hard midpoint shine on every surface.
- Inputs/composer/path labels: recessed wells with an inner top shadow and lower rim.
- Buttons: raised molded controls with a fine upper highlight, lower edge, and localized shadow.
- Primary/selected controls: glossy theme accent, readable foreground, restrained accent halo.
- Pressed controls: inset shadow. Avoid geometry changes that shift neighboring content.
- Text: crisp and readable; no blanket text shadows, filters, or embossing on body copy.
- Blur: optional for modal backdrops only. The skeu material must work without transparency, native window effects, image textures, or backdrop filtering.

## Theme contract

The stylesheet supplies a dark slate/peach fallback and a neutral light fallback. These are examples, not implementations of the 22 themes. Override inputs using the existing theme registry; do not create another independent palette registry.

| Input | Map to |
| --- | --- |
| `--sk-bg` | App canvas |
| `--sk-surface` | Raised panel base |
| `--sk-field` | Input/recessed surface |
| `--sk-text` | Primary foreground |
| `--sk-muted` | Secondary readable foreground |
| `--sk-accent` | Theme action/selection color |
| `--sk-on-accent` | Foreground verified against the entire accent gradient |
| `--sk-focus` | Clearly visible keyboard ring |
| `--sk-danger`, `--sk-success`, `--sk-warning` | Existing semantic status colors |
| `--sk-highlight` | Upper bevel strength appropriate to theme mode |
| `--sk-lowlight` | Lower bevel strength appropriate to theme mode |
| `--sk-shadow-color` | Ambient/inset shadow appropriate to theme mode |

Use `data-theme-mode="light"` for light material defaults; actual theme IDs remain independent. Place theme-specific overrides after the kit, with equal or greater specificity. Reuse the app's existing names when mapping values; do not invent references to undefined tokens. Derived gradients may need theme-specific adjustment if contrast fails.

Apply `data-style="skeu"` to a wrapper containing styled descendants. Repeat the scope and theme inputs on portal roots that live outside that wrapper. A native dialog can use a scoped ancestor; a separately mounted dialog needs an outer scope wrapper. Do not put the scope attribute solely on a component and expect descendant selectors to style that same element.

## Component mapping

The classes below are explicit opt-in hooks. Add them to existing components; the stylesheet deliberately does not target all buttons or inputs globally. Layout remains the responsibility of existing component styles.

| Existing component | CSS hook / contract |
| --- | --- |
| Canvas | `.sk-app` |
| Modal shell | `.sk-window.sk-dialog` for native dialog, or `.sk-window` for custom dialog |
| Modal header/footer | `.sk-window-header`, `.sk-window-footer` |
| Top bars/section headers/sidebar | `.sk-toolbar`, `.sk-section-header`, `.sk-sidebar` |
| Content container | `.sk-panel`, `.sk-card`; optional `.sk-satin` |
| Recessed container | `.sk-well`, `.sk-composer`, `.sk-list`, `.sk-path` |
| Standard button | `.sk-button`; add `.sk-primary` for primary action |
| Circular icon control | `.sk-icon-button`; supply accessible name |
| Navigation | `.sk-nav-item` with `aria-current="page"` |
| Tabs | `.sk-tab` with `aria-selected`; preserve existing tab keyboard behavior |
| Segmented controls | `.sk-segments` wrapper, `.sk-segment` buttons with `aria-pressed` |
| Theme choices | `.sk-choice` with `aria-checked`; implement a radio group and its keyboard behavior |
| Fields | `.sk-field` on input, textarea, select; use associated labels |
| Checkbox/radio | Native corresponding input with `.sk-checkbox` / `.sk-radio` |
| Switch | Native checkbox with `.sk-switch`, associated label; optional `role="switch"` |
| Control label/helper/error | `.sk-control-label`, `.sk-help`, `.sk-error`; associate helper/error IDs |
| Status badge | `.sk-badge` with optional `data-status="success|warning|error"`; retain text/icon |
| List/table | `.sk-list-row`, `.sk-table` |
| Popup/menu | `.sk-menu`, `.sk-menu-item`; preserve focus and dismissal behavior |
| Tooltip/notification | `.sk-tooltip`, `.sk-toast`; existing positioning/live-region logic |
| Link/progress/slider | `.sk-link`, native progress `.sk-progress`, native range `.sk-range` |
| Scroll region | `.sk-scroll` |
| Custom modal backdrop | `.sk-overlay`; optional `data-blur="true"` |
| Electron drag surfaces | `.sk-drag-region`, `.sk-no-drag` |

CSS supplies appearance, not interaction logic, ARIA behavior, popup positioning, focus traps, loading logic, or z-index orchestration. Keep native select/range behavior. Do not add fake interactive elements to match a shape. Use native disabled where possible; `aria-disabled` alone needs handler guards and keyboard behavior. Retain semantic loading/error/empty states.

## Screen-specific work

### Application shell

- Apply satin chrome to tab strip and toolbar; preserve compact heights.
- Distinguish active tabs through existing accent indicator and raised state.
- Use consistent circular bevels on navigation/settings controls.
- Keep window controls accessible and interactive inside Electron drag regions.
- Preserve window resize, maximize, and high-DPI behavior. No native window transparency changes are required.

### Settings / Appearance

- Raised dialog shell with consistent header, footer, and separators.
- Quiet sidebar with a glossy accent selected item.
- Shallow satin setting sections; recessed or quieter nested content.
- Theme choices receive consistent bevels and an explicit selected marker as well as accent color.
- Preserve all themes, material toggle behavior, and scroll positions.

### MCP Integrations

- Satin server cards with thin separators and quieter expansion rows.
- Recessed segmented-control tray with raised segments; selected segment uses accent gloss.
- Compact recessed switches with a raised thumb.
- Circular removal controls; preserve destructive semantics and confirmation behavior.
- Disabled badges remain legible and distinct from disabled interactive controls.

### Projects grid

- Keep the existing rectangular card layout and spacing.
- Shallow raised cards, subtle upper reflection, recessed path labels.
- Consistent circular pin controls; pinned state uses accent plus the existing marker.
- Search feels recessed; Create Project feels raised and primary.
- Hover adds edge definition without lifting the whole grid dramatically.
- Preserve title wrapping, path truncation, and independent card/pin interactions; no nested buttons.

### Project workspace

- Apply consistent shallow panel treatment to goal, composer, recent chats, instructions, files, and skills.
- Composer and editing fields are inset; send is the primary glossy action.
- Reading surfaces and chat rows remain quiet, with thin dividers.
- Existing empty states, upload zones, and secondary actions keep clear hierarchy.

### Model load settings

- Raised dialog housing with satin header/footer and stable action bar.
- Main form columns are shallow panels; fields are recessed.
- Toggle/checkbox rows have consistent depth without excessive shine.
- Disabled options use subdued controls, while explanatory text remains readable.
- Preserve footer estimates, two-column layout, narrow-window adaptation, and scrolling.

## Integration example

```html
<div data-style="skeu" data-theme-mode="dark">
  <section class="sk-window" aria-labelledby="settings-title">
    <header class="sk-window-header"><h2 id="settings-title">Settings</h2></header>
    <div class="sk-panel">
      <label for="project-name">Project name</label>
      <input id="project-name" class="sk-field" />
      <label class="sk-control-label">
        <input type="checkbox" class="sk-switch" /> Enable feature
      </label>
    </div>
    <footer class="sk-window-footer">
      <button class="sk-button" type="button">Cancel</button>
      <button class="sk-button sk-primary" type="button">Save</button>
    </footer>
  </section>
</div>
```

Keep the main app's existing dialog semantics, sizing, focus management, and layout. This snippet illustrates style hooks only.

## Verification and acceptance checklist

- [ ] No loss of app functionality, content, or theme options.
- [ ] Style-off appearance unchanged; switching styles/themes updates without restart.
- [ ] All 22 themes map correctly, including portal surfaces.
- [ ] Capture Settings, MCP, Projects, workspace, and model settings in dark slate/peach, Gruvbox Dark, Default Light, and another light palette.
- [ ] Check text contrast against actual gradient endpoints, including selected controls; normal text targets 4.5:1 and essential control boundaries/focus 3:1 where applicable.
- [ ] Verify hover, active, selected, focus, disabled, invalid, readonly, indeterminate, loading, and empty states where supported.
- [ ] Keyboard focus remains visible; dialogs trap/restore focus; menus/tabs/radio groups retain correct keyboard navigation.
- [ ] Check 100% and 125–150% scaling, smaller windows, long labels, text zoom, scroll clipping, and portal stacking.
- [ ] Reduced motion and forced colors work; status remains understandable without color alone.
- [ ] No animated shadows/blur, excessive compositor layers, accidental click interception, or broken drag regions.
- [ ] Run relevant existing checks and build. Add tests only for changed behavior, not static gradient values.
- [ ] Report exact files changed, representative rendered screenshots, checks run, and any remaining limitations.

The supplied stylesheet is an integration kit, not a claim that the main application has already been migrated or visually validated. Complete the component mapping and runtime checks in the main repository before declaring the task finished.

## Surface textures: required implementation guidance

Include a visible but fine surface-texture pass as part of the skeu treatment. The supplied `/docs/skeu.css` now contains three optional texture hooks. These are subtle finishes for the existing molded/satin materials, not a replacement for gradients, bevels, or shadows. Do not interpret them as evidence that grain is visible in the source screenshots; they extend the requested skeu direction.

| Hook | Finish | Recommended placement |
| --- | --- | --- |
| `.sk-texture-grain` | Static, embedded achromatic SVG noise | App housing, modal header, occasional larger panel |
| `.sk-texture-brushed` | Very faint directional CSS lines | Toolbar or hardware-like control housing, sparingly |
| `.sk-texture-satin` | Fine horizontal CSS line texture | Quiet broad panel surfaces where noise assets are unsuitable |

### Placement and integration

- Use one texture hook per element. Do not stack grain, satin, and brushed finishes.
- Use fine diagonal background machining on canvas, housing, sidebar, and chrome. Use a horizontal finish on broad panels and project cards. Grain remains a supplementary header finish; it is not the only evidence of texture. Avoid the old crossed diagonal card hatch.
- Keep inputs, dropdown content, path wells, chat transcripts, code blocks, helper copy containers, and dense lists untextured. Prefer an outer housing rather than a parent that also covers those reading surfaces.
- Never stack texture overlays over parent and child content. Housing and panel finishes may instead be painted in their own CSS backgrounds: opaque child surfaces occlude the parent finish, so texture does not accumulate over child text or fields. Keep overlay hooks on a single exposed face.
- Hooks preserve the existing surface background. They use a rounded, static `::before` overlay, local isolation, and a negative stack level so content stays above the texture. The overlay ignores pointer events.
- Inspect existing pseudo-elements before applying hooks. If `::before` is occupied, put the texture on a dedicated surface wrapper; do not overwrite an icon, selection marker, or focus effect.
- Hooks establish relative positioning and a stacking context. Inspect positioned descendants, badges, menus, and existing z-index relationships after applying them. Keep popups in the existing portal system.
- Grain uses an embedded data-URL SVG with a static noise filter; it has no external network dependency. Verify the renderer's Content Security Policy allows that image. If it does not, use the CSS-only satin/brushed hook or move the SVG to an approved local asset and update the URL. Do not weaken CSP just to load a texture.

### Theme tuning

- Dark fallback opacity is `--sk-texture-opacity: .035`; light fallback is `.025`. These values apply to noise overlays, not to direct background finishes. Reference-like direct finishes use neutral line alpha around `.008`–`.02`, depending on mode. Texture should be visible at normal size when compared on/off, while remaining subordinate to text. A finish that only becomes visible at extreme zoom is too weak.
- Map or override `--sk-texture-light` and `--sk-texture-dark` if directional lines look too harsh for a palette. Their default white/black colors are neutral highlights/shadows, not a replacement palette.
- `--sk-texture-grain-size` controls the grain tile size (default `128px`). Avoid enlarging it enough to reveal the tile pattern.
- Set `data-texture="off"` on the style scope or a container for an explicit texture opt-out. This removes textures while preserving skeu gradients and bevels. An additional user preference is optional; do not create one unless it fits the existing preference UI.
- Textures are disabled in forced-colors mode and print. They never animate and require no blend mode, blur, canvas, JavaScript, or extra compositor promotion.

### Example

```html
<header class="sk-window-header sk-texture-grain">...</header>
<section class="sk-panel sk-satin sk-texture-satin">...</section>
<div class="sk-toolbar sk-texture-brushed">...</div>
```

These demonstrate alternative placements, not a requirement to texture every surface.

### Texture acceptance checks

- [ ] Compare texture on/off at normal size in Gruvbox Dark, slate dark, Default Light, and another light theme.
- [ ] Texture is subtle and theme-neutral, with no obvious tiled squares, scanlines, moire, or dirty-looking patches at 100%, 125%, 150%, and 200% scale.
- [ ] Text and icons remain above texture; contrast and control state recognition remain intact.
- [ ] No texture overlap on nested surfaces, clipping leaks, blocked pointer events, or displaced positioned children.
- [ ] Grain loads under the actual Electron CSP; use the documented fallback if blocked.
- [ ] Texture opt-out, forced-colors mode, and print remove all texture overlays.
- [ ] Check scrolling/rendering performance on a populated Projects grid; reduce coverage if rasterization cost is noticeable.
