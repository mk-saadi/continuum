# Aero Glass Design System

Status: **active** — reference implementation shipped on the Projects dashboard
Last updated: **2026-11-01**
Applies to: every page, panel, control, form, popover, toast, and modal in Continuum
Shared material implementation: `src/styles/aero.css`
Project-specific geometry: `src/components/projects.css`
Reference markup: `src/components/ProjectsView.jsx`

> This document is normative. When a component and this guide disagree, the
> guide wins and the component is a bug. If the guide is wrong, change the
> guide in the same pull request that changes the component.

---

## 0. Read this first (the 12 rules)

1. **Aero is a lighting model, not glassmorphism.** Translucency alone is not
   Aero. Every raised surface needs a specular top edge, a dark bottom bevel, a
   gloss gradient, and a layered shadow.
2. **Light always comes from directly above.** Every gloss gradient is
   `180deg`. Never light a surface from below or the side.
3. **Elevation is semantic.** Choose the surface recipe by role (flat content,
   well, control, panel, floating chrome). Do not invent new depths per screen.
4. **Glass is for chrome and controls, not dense content.** Chat transcripts,
   code, terminals, tables, and long-form text stay flat and opaque.
5. **One blur per surface, and no nested blurs.** If a panel is already glass,
   children use `.aero-fill` (bevel, no blur), not another `backdrop-filter`.
6. **Derive colors from theme tokens with `color-mix`.** No raw hex values in
   component code. No hardcoded Aero blue. Theme identity is preserved.
7. **Every interactive control has five states:** rest, hover, pressed,
   focus-visible, disabled. Selected toggles add a sixth (accent).
8. **Contrast beats gloss.** If the effect makes text harder to read, the
   effect is wrong. Add a scrim or raise the fill opacity.
9. **Use the shared classes.** Do not copy-paste 20-line gradients into a new
   component. Use `.aero-panel`, `.aero-control`, `.aero-primary`, `.aero-well`,
   `.aero-orb`, `.aero-badge`, `.aero-dialog`, `.aero-popover`.
10. **Do not add `overflow: hidden` to a blurred surface** unless it is needed
    for clipping. It removes focus rings and can hide portaled-looking children.
11. **Do not add `transform`, `filter`, or `backdrop-filter` to an ancestor of a
    non-portaled `position: fixed` element.** It becomes the containing block
    and the popover will move. Portaled menus (`FormControls`, `Tooltip`,
    `AgentSettingsPopover`, `TextSelectionMenu`) are safe.
12. **Test at least six themes:** `gruvbox-dark`, `dark`, `onyx-dark`,
    `solarized`, `light`, `papaya`. Then test the component's own default theme.

---

## 1. What "Aero Glass" means in this app

We are emulating the **Windows Vista/7 Aero Glass** lineage, not Windows 11
Acrylic. Aero Glass has three independent ingredients:

| Ingredient | What it contributes | Where it lives |
|---|---|---|
| **Material** | Translucency, blur, saturation, tint | `background` + `backdrop-filter` |
| **Light** | Specular rim, top-half gloss, accent glow, text shadow | `border` + gradient + `inset` shadow |
| **Geometry** | Bevels, elevation, pressed depth, rounded chrome | `box-shadow` + `transform` + radius |

If any one ingredient is missing, the result reads as either flat glassmorphism
(material only) or plastic (light/geometry only). The reference implementation
has all three.

### 1.1 Visual signature (memorize these numbers)

| Cue | Value | Notes |
|---|---|---|
| Gloss horizon on controls | `47%`–`49%` | Sharp Aero "waterline"; do not soften past 52% |
| Gloss horizon on panels | `38%`–`40%` | Softer, because panels are larger |
| Top highlight | `inset 0 1px 0` white at `34%` (panels) / `46%` (controls) | 1 CSS px, never 2 |
| Bottom bevel | `inset 0 -1px 0` black at `30%`–`38%` | Gives the plinth depth |
| Outer border | 1px white at `16%` | Aero rim, not a hairline grey border |
| Bottom rim (raised) | 1px white at `9%` | Outer bottom edge sits in shadow; dimmer than the top/sides |
| Bottom rim (accent) | 1px white at `24%` | Primary buttons and selected/active toggles |
| Panel fill | surface at `54%` alpha | See tokens |
| Control fill | surface-raised at `66%` alpha | Slightly denser than panels |
| Well fill | input at `62%` alpha | Sunken, darker than its parent |
| Blur — panel | `16px` | Cards, settings cards |
| Blur — control | `10px` | Buttons, tabs, chips |
| Blur — well | `12px` | Inputs, search, path chips |
| Blur — floating | `24px` | Dialogs, popovers |
| Saturation | `150%`–`160%` | Makes the tint feel like glass, not fog |
| Radius — panel | `14px` | Cards, panels |
| Radius — control | `9px` | Buttons, tabs |
| Radius — well | `12px` | Fields, search |
| Radius — floating | `16px` | Dialogs |
| Radius — orb | `999px` | Icon toggles, pin, knob |
| Control transition | `120ms` | Press must feel immediate |
| Panel transition | `180ms` | Hover lift |
| Floating entry | `160`–`220ms` | Opacity + 2px translate + 0.98 scale |

### 1.2 The two gradients you will use constantly

**Raised control gloss** (top half catches the light, bottom half falls into
shadow):

```text
linear-gradient(
	180deg,
	color-mix(in srgb, #ffffff 28%, transparent) 0%,
	color-mix(in srgb, #ffffff 9%, transparent) 48%,
	transparent 49%,
	color-mix(in srgb, #000000 10%, transparent) 100%
)
```

**Sunken well** (inverse: dark at the top, light at the bottom rim):

```text
linear-gradient(
	180deg,
	color-mix(in srgb, #000000 12%, transparent) 0%,
	color-mix(in srgb, #000000 3%, transparent) 12%,
	transparent 32%
)
```

Everything else in this guide is a variation on those two.

---

## 2. Elevation model

Aero works because there is a hierarchy. Apply the recipe by role, not by
whichever looks good on the screen you are editing.

| Level | Name | Recipe | Used for |
|---|---|---|---|
| **L0** | Flat content | `.aero-flat` — no blur, no gloss, 1px border at most | Chat transcript, message bubbles, code blocks, terminal, tables, lists, markdown |
| **L1** | Well / sunken | `.aero-well` — inset shadow, dark top gradient | Text inputs, search, select triggers, path chips, progress tracks, editor wells |
| **L2** | Raised control | `.aero-control` — gloss + 1px highlight + outer shadow | Secondary buttons, tabs, chips, icon buttons, segmented controls |
| **L3** | Panel | `.aero-panel` — glass + gloss + rim + deep shadow | Cards, settings cards, sidebars, page sections, empty states |
| **L4** | Floating chrome | `.aero-dialog` / `.aero-popover` / `.aero-tooltip` — strongest shadow + 24px blur | Modals, menus, dropdowns, popovers, toasts, tooltips |
| **L5** | Accent | `.aero-primary` / `.aero-badge--accent` / `[aria-pressed="true"]` | Primary CTA, selected tab, pinned/active state, destructive only after review |

Rules:

- **Never skip levels.** A well (L1) inside a card (L3) is correct. A control
  (L2) inside a control (L2) is not.
- **Nested surfaces use `.aero-fill`** (bevel + tint, no blur). Only the
  outermost surface gets `backdrop-filter`.
- **L0 content must not inherit gloss.** If a card contains a transcript or a
  table, those children stay flat.
- **The app shell is not a glass panel.** It is the frame. The stage behind it
  supplies the light. See §6.1.

---

## 3. Architecture: where styles live

### 3.1 File responsibilities

| File | Responsibility |
|---|---|
| `src/index.css` | Theme tokens (23 palettes), Tailwind setup, **global Aero tokens**, global scrollbars, top-layer dialog rules |
| `src/styles/aero.css` | Global unlayered Aero utilities, interaction states, and fallbacks; imported once by `src/main.jsx` |
| `src/styles/appearance.css` | Global `html[data-appearance="flat"]` overrides; imported after Aero utilities |
| `src/components/projects.css` | Projects layout and the heading badge / compact path-chip shapes |
| `src/components/settings/SettingsSection.jsx` | Shared settings card/button/field recipes — **first component to migrate** |
| `src/components/FormControls.jsx` | `fieldFrame` for every text/number/select/checkbox/slider — **second component to migrate** |
| `src/components/**/*.css` | Component- or page-scoped additions only when a shared class cannot express the shape |
| Inline `className` strings | Layout, spacing, and typography only. **No material recipes.** |

### 3.2 CSS vs Tailwind

- Aero material (background, border, shadow, blur, gloss) goes in the shared
  utilities in `src/styles/aero.css` (plain, **unlayered** CSS so it wins over Tailwind's
  `utilities` layer), or in a page-scoped block when the shape is unique.
- Tailwind remains responsible for `flex`, `grid`, `p-*`, `gap-*`, `text-*`,
  `size-*`, positioning, and responsive breakpoints.
- When you add an `.aero-*` class, **remove the old `bg-*`, `border-*`, and
  `shadow-*` utilities from that element.** Do not leave two sources of truth.
- Remove `!` (important) modifiers from `rounded-*`, `bg-*`, and `border-*` on
  elements you convert. They will beat the Aero class.

### 3.3 Scope and naming

- Shared utilities: `.aero-panel`, `.aero-control`, `.aero-primary`,
  `.aero-well`, `.aero-orb`, `.aero-badge`, `.aero-dialog`, `.aero-popover`,
  `.aero-tooltip`, `.aero-empty`, `.aero-tab`, `.aero-track`, `.aero-stage`,
  `.aero-fill`, `.aero-flat`.
- Modifiers use BEM-ish suffixes: `.aero-panel--interactive`,
  `.aero-control--danger`, `.aero-badge--accent`.
- Page-specific overrides are prefixed with the page class:
  `.projects-page .project-card { … }`, not a bare `.project-card`.
- Never style bare element selectors (`button`, `input`, `dialog`) with Aero
  material. Icon-only controls, native pickers, and third-party widgets would
  be caught.

---

## 4. Canonical tokens

Add this block **once** to `src/index.css`, after the theme blocks and before
the scrollbar/top-layer rules. Phase 0 has promoted these tokens from the Projects prototype (see §12). `color-mix()` requires Chromium 111+; Electron 44 ships a newer
Chromium, so it is safe in this app.

```css
/* ==========================================================================
   Aero Glass tokens
   Derive from the active theme. Do not duplicate per theme.
   Plain, unlayered CSS: intentionally wins over Tailwind utilities.
   ========================================================================== */
:root {
	/* Material */
	--aero-blur-panel: 16px;
	--aero-blur-control: 10px;
	--aero-blur-well: 12px;
	--aero-blur-float: 24px;
	--aero-saturate: 155%;
	--aero-saturate-control: 150%;
	--aero-blur-orb: 8px;
	--aero-radius-popover: 12px;
	--aero-radius-tooltip: 8px;
	--aero-saturate-float: 160%;

	--aero-glass: color-mix(in srgb, var(--surface) 54%, transparent);
	--aero-glass-raised: color-mix(in srgb, var(--surface-raised) 66%, transparent);
	--aero-glass-strong: color-mix(in srgb, var(--surface-raised) 84%, transparent);
	--aero-glass-subtle: color-mix(in srgb, var(--surface) 38%, transparent);
	--aero-well-fill: color-mix(in srgb, var(--input) 62%, transparent);

	/* Light */
	--aero-line: color-mix(in srgb, #ffffff 16%, transparent);
	--aero-line-strong: color-mix(in srgb, #ffffff 34%, transparent);
	--aero-line-soft: color-mix(in srgb, #ffffff 8%, transparent);
	/* Raised rims fall off toward the bottom edge: the top/sides catch light,
	   the bottom sits in shadow. Wells are the inverse and keep their full
	   rim. */
	--aero-line-bottom: color-mix(in srgb, #ffffff 9%, transparent);
	--aero-line-bottom-strong: color-mix(in srgb, #ffffff 24%, transparent);
	--aero-shade: color-mix(in srgb, #000000 32%, transparent);
	--aero-shade-strong: color-mix(in srgb, #000000 45%, transparent);

	/* Gloss */
	--aero-gloss-panel: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 12%, transparent) 0%,
		color-mix(in srgb, #ffffff 3%, transparent) 38%,
		transparent 40%,
		color-mix(in srgb, #000000 8%, transparent) 100%
	);
	--aero-gloss-control: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 28%, transparent) 0%,
		color-mix(in srgb, #ffffff 9%, transparent) 48%,
		transparent 49%,
		color-mix(in srgb, #000000 10%, transparent) 100%
	);
	--aero-gloss-control-hover: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 36%, transparent) 0%,
		color-mix(in srgb, #ffffff 12%, transparent) 48%,
		transparent 49%,
		color-mix(in srgb, #000000 8%, transparent) 100%
	);
	--aero-gloss-accent: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 58%, transparent) 0%,
		color-mix(in srgb, #ffffff 14%, transparent) 46%,
		transparent 47%,
		color-mix(in srgb, #000000 22%, transparent) 100%
	);
	--aero-gloss-accent-hover: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 66%, transparent) 0%,
		color-mix(in srgb, #ffffff 18%, transparent) 46%,
		transparent 47%,
		color-mix(in srgb, #000000 18%, transparent) 100%
	);
	--aero-gloss-well: linear-gradient(
		180deg,
		color-mix(in srgb, #000000 12%, transparent) 0%,
		color-mix(in srgb, #000000 3%, transparent) 12%,
		transparent 32%
	);
	--aero-gloss-pressed: linear-gradient(
		180deg,
		color-mix(in srgb, #000000 24%, transparent) 0%,
		transparent 58%
	);
	--aero-gloss-orb: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 26%, transparent) 0%,
		color-mix(in srgb, #ffffff 6%, transparent) 48%,
		transparent 49%,
		color-mix(in srgb, #000000 14%, transparent) 100%
	);

	--aero-gloss-orb-selected: linear-gradient(
		180deg,
		color-mix(in srgb, #ffffff 55%, transparent) 0%,
		color-mix(in srgb, #ffffff 12%, transparent) 48%,
		transparent 49%,
		color-mix(in srgb, #000000 18%, transparent) 100%
	);

	/* Bevels and elevation */
	--aero-bevel-panel:
		inset 0 1px 0 var(--aero-line-strong),
		inset 0 -1px 0 var(--aero-shade),
		0 1px 2px color-mix(in srgb, #000000 30%, transparent),
		0 8px 20px -10px color-mix(in srgb, #000000 40%, transparent);
	--aero-bevel-panel-hover:
		inset 0 1px 0 var(--aero-line-strong),
		inset 0 -1px 0 var(--aero-shade),
		0 1px 3px color-mix(in srgb, #000000 28%, transparent),
		0 12px 28px -12px color-mix(in srgb, #000000 46%, transparent);
	--aero-bevel-control:
		inset 0 1px 0 color-mix(in srgb, #ffffff 46%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #000000 30%, transparent),
		0 1px 3px color-mix(in srgb, #000000 26%, transparent);
	--aero-bevel-well:
		inset 0 2px 4px color-mix(in srgb, #000000 30%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #ffffff 8%, transparent),
		0 1px 0 color-mix(in srgb, #ffffff 6%, transparent);
	--aero-bevel-pressed:
		inset 0 2px 5px color-mix(in srgb, #000000 48%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #ffffff 7%, transparent),
		0 1px 0 color-mix(in srgb, #ffffff 5%, transparent);
	--aero-bevel-orb:
		inset 0 1px 0 color-mix(in srgb, #ffffff 45%, transparent),
		0 1px 3px color-mix(in srgb, #000000 26%, transparent);
	--aero-shadow-float:
		inset 0 1px 0 var(--aero-line-strong),
		inset 0 -1px 0 color-mix(in srgb, #000000 38%, transparent),
		0 1px 4px color-mix(in srgb, #000000 30%, transparent),
		0 20px 52px -20px color-mix(in srgb, #000000 52%, transparent);
	--aero-glow: 0 0 18px -4px color-mix(in srgb, var(--accent) 70%, transparent);

	/* Geometry */
	--aero-radius-panel: 14px;
	--aero-radius-control: 9px;
	--aero-radius-primary: 12px;
	--aero-radius-well: 12px;
	--aero-radius-float: 16px;
	--aero-radius-orb: 999px;

	/* Motion */
	--aero-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
	--aero-dur-control: 120ms;
	--aero-dur-panel: 180ms;
}
```

Why tokens instead of per-theme values:

- Every token derives from `--surface`, `--surface-raised`, `--input`, or
  `--accent`. All 23 themes inherit the system automatically.
- `color-mix(..., transparent)` preserves the theme color and applies alpha.
  It does **not** wash the palette toward grey.
- If exactly one theme needs a tweak, override only the affected token in
  `[data-theme="that-theme"]`. Never fork the whole recipe.

---

## 5. Canonical utilities

These utilities live in `src/styles/aero.css`, imported globally by `src/main.jsx`.
They are plain, unlayered CSS and are the shared material recipes for every area.

```css
/* ==========================================================================
   Aero Glass utilities
   ========================================================================== */

/* L0 — flat content surface. Use inside glass panels for transcript, code,
   tables, terminal output, and any long-form text. No blur, no gloss. */
.aero-flat {
	border: 1px solid var(--subtle-border);
	background: var(--surface);
	border-radius: var(--aero-radius-well);
}

/* L3 — nested fill. A bevel without a second blur. */
.aero-fill {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-control);
	background: var(--aero-gloss-panel), var(--aero-glass);
	box-shadow:
		inset 0 1px 0 var(--aero-line-strong),
		inset 0 -1px 0 var(--aero-shade);
}

/* Page stage. Every page that uses glass needs a lit backdrop behind it. */
.aero-stage {
	position: relative;
	isolation: isolate;
	background-color: var(--bg-secondary);
	background-image:
		linear-gradient(180deg, color-mix(in srgb, #ffffff 5%, transparent), transparent 22%),
		radial-gradient(52rem 30rem at 14% -14%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%),
		radial-gradient(38rem 26rem at 94% 2%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 72%),
		radial-gradient(34rem 22rem at 58% 118%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%);
}
html[data-bg-image="true"] .aero-stage {
	background-color: transparent;
	background-image: none;
}

/* L3 — glass panel. */
.aero-panel {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-panel);
	background: var(--aero-gloss-panel), var(--aero-glass);
	-webkit-backdrop-filter: blur(var(--aero-blur-panel)) saturate(var(--aero-saturate));
	backdrop-filter: blur(var(--aero-blur-panel)) saturate(var(--aero-saturate));
	box-shadow: var(--aero-bevel-panel);
}

/* Interactive panel (clickable card). Do not use on static cards. */
.aero-panel--interactive {
	transition:
		transform var(--aero-dur-panel) var(--aero-ease),
		box-shadow var(--aero-dur-panel) var(--aero-ease),
		border-color var(--aero-dur-panel) var(--aero-ease);
}
.aero-panel--interactive:hover {
	border-color: color-mix(in srgb, var(--accent) 48%, var(--aero-line));
	transform: translateY(-2px);
	box-shadow:
		var(--aero-bevel-panel-hover),
		0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
}

/* L2 — raised control (secondary button, tab, chip). */
.aero-control {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-control);
	background: var(--aero-gloss-control), var(--aero-glass-raised);
	-webkit-backdrop-filter: blur(var(--aero-blur-control)) saturate(var(--aero-saturate-control));
	backdrop-filter: blur(var(--aero-blur-control)) saturate(var(--aero-saturate-control));
	box-shadow: var(--aero-bevel-control);
	transition:
		transform var(--aero-dur-control) var(--aero-ease),
		box-shadow var(--aero-dur-control) var(--aero-ease),
		border-color var(--aero-dur-control) var(--aero-ease),
		background-color var(--aero-dur-control) var(--aero-ease);
}
.aero-control:hover {
	border-color: color-mix(in srgb, #ffffff 28%, transparent);
	background:
		var(--aero-gloss-control-hover),
		color-mix(in srgb, var(--surface-hover) 72%, transparent);
}
.aero-control:active,
.aero-control[data-pressed="true"] {
	transform: translateY(1px);
	background:
		var(--aero-gloss-pressed),
		color-mix(in srgb, var(--surface-hover) 60%, transparent);
	box-shadow: var(--aero-bevel-pressed);
}
.aero-control[aria-pressed="true"],
.aero-control[aria-selected="true"],
.aero-control[data-selected="true"] {
	border-color: color-mix(in srgb, #ffffff 30%, transparent);
	border-bottom-color: var(--aero-line-bottom-strong);
	background: var(--aero-gloss-accent), var(--accent);
	box-shadow:
		inset 0 1px 0 color-mix(in srgb, #ffffff 60%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #000000 32%, transparent),
		0 2px 5px color-mix(in srgb, #000000 40%, transparent),
		var(--aero-glow);
	color: var(--on-accent);
}
.aero-control[aria-pressed="true"]:active,
.aero-control[aria-selected="true"]:active,
.aero-control[data-selected="true"]:active {
	transform: translateY(1px);
	background: var(--aero-gloss-pressed), var(--accent-hover);
	box-shadow: var(--aero-bevel-pressed), var(--aero-glow);
}

/* L5 — primary CTA. */
.aero-primary {
	border: 1px solid color-mix(in srgb, #ffffff 40%, transparent);
	border-bottom-color: var(--aero-line-bottom-strong);
	border-radius: var(--aero-radius-primary);
	background: var(--aero-gloss-accent), var(--accent);
	box-shadow:
		inset 0 1px 0 color-mix(in srgb, #ffffff 70%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #000000 35%, transparent),
		0 1px 3px color-mix(in srgb, #000000 30%, transparent),
		0 6px 14px -8px color-mix(in srgb, var(--accent) 60%, transparent);
	color: var(--on-accent);
	transition:
		transform var(--aero-dur-control) var(--aero-ease),
		box-shadow var(--aero-dur-control) var(--aero-ease),
		background-color var(--aero-dur-control) var(--aero-ease);
}
.aero-primary:hover {
	background: var(--aero-gloss-accent-hover), var(--accent-hover);
}
.aero-primary:active {
	transform: translateY(1px);
	background: var(--aero-gloss-pressed), var(--accent-hover);
	box-shadow:
		inset 0 3px 6px color-mix(in srgb, #000000 52%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #ffffff 10%, transparent);
}

/* L1 — sunken well (input, search, path chip, track). */
.aero-well {
	border: 1px solid color-mix(in srgb, #ffffff 14%, transparent);
	border-radius: var(--aero-radius-well);
	background: var(--aero-gloss-well), var(--aero-well-fill);
	-webkit-backdrop-filter: blur(var(--aero-blur-well)) saturate(var(--aero-saturate-control));
	backdrop-filter: blur(var(--aero-blur-well)) saturate(var(--aero-saturate-control));
	box-shadow: var(--aero-bevel-well);
}
.aero-well:hover {
	border-color: color-mix(in srgb, #ffffff 24%, transparent);
	background:
		linear-gradient(180deg, color-mix(in srgb, #000000 10%, transparent) 0%, transparent 32%),
		color-mix(in srgb, var(--input) 70%, transparent);
}
.aero-well:focus,
.aero-well:focus-within {
	border-color: color-mix(in srgb, var(--accent) 78%, transparent);
	box-shadow:
		inset 0 2px 5px color-mix(in srgb, #000000 40%, transparent),
		0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent),
		var(--aero-glow);
}
.aero-well[aria-invalid="true"],
.aero-well:has([aria-invalid="true"]) {
	border-color: color-mix(in srgb, var(--error) 80%, transparent);
	box-shadow:
		inset 0 2px 5px color-mix(in srgb, #000000 40%, transparent),
		0 0 0 1px color-mix(in srgb, var(--error) 55%, transparent),
		0 0 18px -4px color-mix(in srgb, var(--error) 70%, transparent);
}

/* Raised orb (icon toggle, pin, knob). */
.aero-orb {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border: 1px solid color-mix(in srgb, #ffffff 18%, transparent);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-orb);
	background:
		var(--aero-gloss-orb),
		color-mix(in srgb, var(--surface-raised) 45%, transparent);
	-webkit-backdrop-filter: blur(var(--aero-blur-orb)) saturate(var(--aero-saturate-control));
	backdrop-filter: blur(var(--aero-blur-orb)) saturate(var(--aero-saturate-control));
	box-shadow: var(--aero-bevel-orb);
	color: var(--text-secondary);
	transition:
		color var(--aero-dur-control) var(--aero-ease),
		border-color var(--aero-dur-control) var(--aero-ease),
		box-shadow var(--aero-dur-control) var(--aero-ease),
		transform var(--aero-dur-control) var(--aero-ease);
}
.aero-orb:hover {
	color: var(--text-primary);
	border-color: color-mix(in srgb, #ffffff 34%, transparent);
}
.aero-orb[aria-pressed="true"]:active {
	transform: translateY(1px);
	box-shadow: var(--aero-bevel-pressed);
}
.aero-orb[aria-pressed="true"] {
	color: var(--on-accent);
	border-color: color-mix(in srgb, #ffffff 46%, transparent);
	border-bottom-color: var(--aero-line-bottom-strong);
	background: var(--aero-gloss-orb-selected), var(--accent);
	box-shadow:
		inset 0 1px 0 color-mix(in srgb, #ffffff 65%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #000000 30%, transparent),
		0 1px 4px color-mix(in srgb, #000000 28%, transparent),
		0 0 16px -3px color-mix(in srgb, var(--accent) 75%, transparent);
}

/* Raised pill (badge, status, chip that is not a button). */
.aero-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-orb);
	background: var(--aero-gloss-control), var(--aero-glass-raised);
	box-shadow:
		inset 0 1px 0 var(--aero-line-strong),
		0 1px 2px var(--aero-shade);
	color: var(--text-secondary);
}
.aero-badge--accent {
	border-color: color-mix(in srgb, #ffffff 30%, transparent);
	border-bottom-color: var(--aero-line-bottom-strong);
	background: var(--aero-gloss-accent), var(--accent);
	color: var(--on-accent);
	box-shadow:
		inset 0 1px 0 color-mix(in srgb, #ffffff 60%, transparent),
		inset 0 -1px 0 color-mix(in srgb, #000000 32%, transparent),
		0 1px 3px color-mix(in srgb, #000000 35%, transparent);
}

/* L4 — dialog. Apply to the <dialog> itself. */
.aero-dialog {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-float);
	background: var(--aero-gloss-panel), var(--aero-glass-strong);
	-webkit-backdrop-filter: blur(var(--aero-blur-float)) saturate(var(--aero-saturate-float));
	backdrop-filter: blur(var(--aero-blur-float)) saturate(var(--aero-saturate-float));
	box-shadow: var(--aero-shadow-float);
	color: var(--text-primary);
}
.aero-dialog::backdrop {
	background: color-mix(in srgb, #000000 55%, transparent);
	-webkit-backdrop-filter: blur(6px) saturate(120%);
	backdrop-filter: blur(6px) saturate(120%);
}
/* Existing perf guard: animated backgrounds must not pay for a per-frame blur. */
html[data-bg-animated="true"] .aero-dialog::backdrop {
	-webkit-backdrop-filter: none;
	backdrop-filter: none;
}

/* L4 — popover, menu, dropdown, toast. */
.aero-popover {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-popover);
	background: var(--aero-gloss-panel), var(--aero-glass-strong);
	-webkit-backdrop-filter: blur(20px) saturate(var(--aero-saturate-float));
	backdrop-filter: blur(20px) saturate(var(--aero-saturate-float));
	box-shadow:
		inset 0 1px 0 var(--aero-line-strong),
		inset 0 -1px 0 color-mix(in srgb, #000000 38%, transparent),
		0 1px 4px color-mix(in srgb, #000000 30%, transparent),
		0 14px 32px -14px color-mix(in srgb, #000000 48%, transparent);
}

/* L4 — tooltip. No gloss: it is text and must stay crisp. */
.aero-tooltip {
	border: 1px solid var(--aero-line);
	border-bottom-color: var(--aero-line-bottom);
	border-radius: var(--aero-radius-tooltip);
	background: var(--aero-glass-strong);
	-webkit-backdrop-filter: blur(12px) saturate(140%);
	backdrop-filter: blur(12px) saturate(140%);
	box-shadow:
		inset 0 1px 0 var(--aero-line-soft),
		0 6px 16px -6px var(--aero-shade-strong);
}

/* Selected tab. Uses the app's existing aria-current/data-active marker. */
.aero-tab {
	border: 1px solid transparent;
	border-bottom: 0;
	border-radius: 8px 8px 0 0;
	background: transparent;
	box-shadow: none;
	transition:
		background-color var(--aero-dur-control) var(--aero-ease),
		box-shadow var(--aero-dur-control) var(--aero-ease),
		color var(--aero-dur-control) var(--aero-ease);
}
.aero-tab:hover {
	background: color-mix(in srgb, var(--surface-hover) 55%, transparent);
}
.aero-tab[data-active="true"],
.aero-tab[aria-selected="true"],
.aero-tab[aria-current="page"] {
	border-color: var(--aero-line);
	background: var(--aero-gloss-control), var(--aero-glass-raised);
	box-shadow: var(--aero-bevel-control), inset 0 -2px 0 var(--accent);
	color: var(--text-primary);
}

/* Well + accent fill for progress and sliders. */
.aero-track {
	border: 1px solid color-mix(in srgb, #ffffff 14%, transparent);
	border-radius: var(--aero-radius-orb);
	background: var(--aero-gloss-well), var(--aero-well-fill);
	box-shadow: var(--aero-bevel-well);
	overflow: hidden;
}
.aero-track__fill {
	background: var(--aero-gloss-accent), var(--accent);
	box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 55%, transparent);
}

/* Empty state. Dashed glass, not a solid card. */
.aero-empty {
	border: 1px dashed color-mix(in srgb, var(--aero-line) 55%, var(--border));
	border-radius: var(--aero-radius-panel);
	background: var(--aero-glass-subtle);
	-webkit-backdrop-filter: blur(12px) saturate(140%);
	backdrop-filter: blur(12px) saturate(140%);
	box-shadow:
		inset 0 1px 0 color-mix(in srgb, #ffffff 26%, transparent),
		0 10px 24px -14px color-mix(in srgb, #000000 55%, transparent);
}

/* Shared focus + disabled contract. */
.aero-control:focus-visible,
.aero-primary:focus-visible,
.aero-orb:focus-visible,
.aero-tab:focus-visible,
.aero-badge:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
.aero-control:disabled,
.aero-control[aria-disabled="true"],
.aero-primary:disabled,
.aero-primary[aria-disabled="true"] {
	cursor: not-allowed;
	opacity: 0.45;
	transform: none;
	-webkit-backdrop-filter: none;
	backdrop-filter: none;
	box-shadow: inset 0 1px 0 var(--aero-line-soft);
}
/* Keep bottom rims in shadow even when hover changes the other edges. */
.aero-control:hover,
.aero-orb:hover,
.aero-panel--interactive:hover {
 border-bottom-color: var(--aero-line-bottom);
}
.aero-primary:hover,
.aero-control[aria-pressed="true"],
.aero-control[aria-selected="true"],
.aero-control[data-selected="true"],
.aero-orb[aria-pressed="true"] {
 border-bottom-color: var(--aero-line-bottom-strong);
}
/* Nested material retains its shape and bevel without another blur layer. */
.aero-fill {
 -webkit-backdrop-filter: none;
 backdrop-filter: none;
}
.aero-orb:active {
 transform: translateY(1px);
 box-shadow: var(--aero-bevel-pressed);
}
.aero-orb:disabled,
.aero-orb[aria-disabled="true"],
.aero-tab:disabled,
.aero-tab[aria-disabled="true"],
.aero-well:disabled,
.aero-well:has(> input:disabled, > textarea:disabled, > select:disabled) {
 cursor: not-allowed;
 opacity: 0.45;
 transform: none;
 -webkit-backdrop-filter: none;
 backdrop-filter: none;
 box-shadow: inset 0 1px 0 var(--aero-line-soft);
}
.aero-control:disabled,
.aero-control[aria-disabled="true"],
.aero-primary:disabled,
.aero-primary[aria-disabled="true"],
.aero-orb:disabled,
.aero-orb[aria-disabled="true"],
.aero-tab:disabled,
.aero-tab[aria-disabled="true"] {
 pointer-events: none;
}

/* A nested utility keeps its own bevel/shape but never stacks backdrop blur.
   Portaled menus remain outside the ancestor and retain their L4 material. */
:is(.aero-panel, .aero-dialog, .aero-popover, .aero-well)
:is(.aero-control, .aero-well, .aero-orb, .aero-empty) {
	-webkit-backdrop-filter: none;
	backdrop-filter: none;
}

/* Native checkbox input stays semantic; its adjacent span paints the well. */
.aero-checkbox {
	border: 1px solid var(--aero-line);
	border-radius: 5px;
	background: var(--aero-gloss-well), var(--aero-well-fill);
	box-shadow: var(--aero-bevel-well);
	color: transparent;
}
input:checked + .aero-checkbox {
	border-color: var(--aero-line-bottom-strong);
	background: var(--aero-gloss-accent), var(--accent);
	color: var(--on-accent);
}
input:focus-visible + .aero-checkbox {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
input:disabled + .aero-checkbox { opacity: 0.45; }
@media (forced-colors: active) {
	.aero-checkbox { background: Canvas; border-color: ButtonBorder; box-shadow: none; }
	input:checked + .aero-checkbox { background: Highlight; color: HighlightText; }
}
```

### 5.1 Fallbacks and user preferences

```css
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
	.aero-panel { background: var(--surface); }
	.aero-control { background: var(--surface-raised); }
	.aero-well { background: var(--input); }
	.aero-dialog,
	.aero-popover,
	.aero-tooltip { background: var(--surface-raised); }
}

@media (prefers-reduced-transparency: reduce) {
	.aero-panel,
	.aero-control,
	.aero-well,
	.aero-orb,
	.aero-badge,
	.aero-dialog,
	.aero-popover,
	.aero-tooltip,
	.aero-fill,
	.aero-empty {
		-webkit-backdrop-filter: none;
		backdrop-filter: none;
	}
	.aero-panel { background: var(--surface); }
	.aero-control { background: var(--surface-raised); }
	.aero-well { background: var(--input); }
	.aero-dialog,
	.aero-popover { background: var(--surface-raised); }
}

@media (prefers-reduced-motion: reduce) {
	.aero-panel,
	.aero-panel--interactive,
	.aero-control,
	.aero-primary,
	.aero-orb {
		transition: none;
	}
	.aero-panel--interactive:hover {
		transform: none;
	}
}
/* Wallpaper animations must not force per-frame backdrop filtering. */
html[data-bg-animated="true"] :is(.aero-panel, .aero-control, .aero-well, .aero-orb, .aero-empty, .aero-dialog, .aero-popover, .aero-tooltip) {
 -webkit-backdrop-filter: none;
 backdrop-filter: none;
}
@media (prefers-reduced-motion: reduce) {
 :is(.aero-panel--interactive, .aero-control, .aero-primary, .aero-orb):is(:hover, :active, [data-pressed="true"]) { transform: none; }
}
@media (forced-colors: active) {
 :is(.aero-panel, .aero-fill, .aero-control, .aero-primary, .aero-well, .aero-orb, .aero-badge, .aero-dialog, .aero-popover, .aero-tooltip, .aero-empty, .aero-track, .aero-tab) {
  border-color: ButtonBorder;
  background: Canvas;
  color: CanvasText;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
 }
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
 :is(.aero-fill, .aero-orb, .aero-badge, .aero-empty) { background: var(--surface-raised); }
 .aero-track { background: var(--input); }
}
@media (prefers-reduced-transparency: reduce) {
 :is(.aero-fill, .aero-orb, .aero-badge, .aero-empty, .aero-tooltip) { background: var(--surface-raised); }
 .aero-track { background: var(--input); }
}
```

> `prefers-reduced-transparency` is not supported everywhere. It is a
> progressive enhancement; the `@supports` fallback above is the hard
> guarantee. If a runtime "reduce transparency" preference is added later,
> mirror the same declarations under `html[data-reduced-transparency="true"]`.

---

## 6. Component recipes

Each recipe below assumes the utility classes from §5 exist. Where a component
needs extra geometry, add only that geometry in the component's CSS — never a
second material recipe.

### 6.1 Page stage

**Use:** every scrollable page root: Projects, Project Workspace, Settings,
Memory, usage dashboards, chat when it owns the page.

```jsx
<main className="aero-stage projects-page">…</main>
```

Rules:

- The stage must be behind any glass. A glass panel on a solid `--surface`
  parent has nothing to blur and looks flat while still costing GPU.
- Do **not** put `backdrop-filter` on the stage itself.
- If `html[data-bg-image="true"]` is set, the stage goes transparent (see the
  `.aero-stage` rule) so the backdrop can show through. Today the app shell is
  still opaque, so this resolves to the shell surface; it is the intended path
  to true desktop glass once the shell is made translucent.
- The app shell (`src/App.jsx`) stays opaque for now; it is the frame, not the
  stage. Do not blur it.

### 6.2 Card / panel

**Use:** project cards, settings cards, dashboard sections, right-sidebar
cards, static content groups.

```jsx
<article className="aero-panel p-3">…</article>

{/* only when the whole card is clickable */}
<article className="aero-panel aero-panel--interactive p-0">
	<button className="…">…</button>
</article>
```

Do not add a second `bg-*`, `border-*`, or `shadow-*` class. Do not add
`backdrop-blur-*`.

### 6.3 Secondary button

**Use:** Cancel, Filter, Pinned, Retry, toolbar buttons.

```jsx
<button className="aero-control inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium">
	Retry
</button>
```

Requirements:

- Keep the existing `focus-visible` outline unless the Aero class already
  provides it (the shared rule does).
- `:active` is already handled. Do not add `active:bg-*`.
- Disabled: the shared rule handles it. Do not add `disabled:opacity-40`
  (duplicate) — remove it when converting.

### 6.4 Primary button

**Use:** one primary action per view. Create New Project, Save, Start.

```jsx
<button className="aero-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold">
	Create New Project
</button>
```

- Always `color: var(--on-accent)` from the class.
- Never combine with `bg-[var(--accent)] hover:bg-[var(--accent-hover)]`.
- Destructive primary: add `.aero-control--danger` later only after a design
  review; do not improvise red gloss.

### 6.5 Icon button / orb

**Use:** pin, star, close, send, reorder, playback controls, small toggles.

```jsx
<button className="aero-orb size-7" aria-pressed={pinned} aria-label="Pin">
	<FiStar fill={pinned ? "currentColor" : "none"} />
</button>
```

- Minimum hit target: `28px` (the app's existing standard).
- The orb is round. Do not apply it to rectangular toolbar buttons.
- Selected state uses `aria-pressed="true"` — never a custom `active` class.

### 6.6 Text input / search / select trigger / textarea

**Use:** every field, including hand-written native inputs.

```jsx
<div className="aero-well flex min-h-8 items-center">
	<input className="w-full min-w-0 bg-transparent px-3 py-1.5 text-sm outline-none" />
</div>
```

Prefer the wrapper form. A native input can carry `aero-well` directly, but
blur on replaced form controls is less predictable across platforms; verify it
in Electron before choosing that shape.

- Remove `bg-[var(--input)]`, `border`, `rounded-*`, and `focus:ring-*` from the
  frame. The Aero class owns them.
- For the shared `TextField`/`SelectField`, change `fieldFrame` in
  `src/components/FormControls.jsx` to include `aero-well`, not each call site.
- Select menus are L4: `.aero-popover` on the menu, `.aero-well` on the trigger.
- Textarea: same, plus `resize: vertical` stays in component CSS.
- Search: same, plus the app's search icon/padding layout stays.

### 6.7 Modal dialog

**Use:** all ten `<dialog>` elements.

```jsx
<dialog className="aero-dialog fixed inset-0 m-auto p-0">
	<div className="flex max-h-[85dvh] flex-col">
		<header className="…">…</header>
	</div>
</dialog>
```

- Apply `.aero-dialog` to the `<dialog>` itself, not to an inner wrapper.
- Remove `bg-[var(--surface)]`, `border`, `rounded-*`, and `shadow-*` from the
  dialog. Keep `fixed inset-0 m-auto`, width, max-height, and `overflow`.
- The `::backdrop` is part of `.aero-dialog`.
- If the dialog has an inner header, give it `.aero-fill` (no blur) or a flat
  `--surface` band; do not give it a second `backdrop-filter`.
- Preserve the existing `html[data-bg-image="true"] dialog` opacity rule: native
  dialogs live in the top layer, outside `<body>`'s opacity group.

### 6.8 Popover / menu / toast

**Use:** custom selects, tooltips, text selection menu, agent settings popover,
toasts, dropdowns.

```jsx
<div className="aero-popover …">…</div>
```

- Popovers are portaled to `document.body` (`FormControls`, `Tooltip`,
  `AgentSettingsPopover`, `TextSelectionMenu`). Keep it that way.
- Do not animate `backdrop-filter`; animate `opacity` and `transform` only.
- Toast: `.aero-popover` plus the existing semantic accent/error left border.

### 6.9 Tabs

**Use:** `src/components/TabBar.jsx`.

- Add `aero-tab` to the tab wrapper and `data-active={tab.id === activeTabId}`
  (or rely on `aria-current`, which is already on the inner button — but moving
  it to the wrapper is cleaner).
- Active: raised control with an accent underline via
  `.aero-tab[data-active="true"]`.
- Inactive: transparent with a hover fill. Do not give every tab a glass plate;
  it becomes noisy.
- The tab bar container itself can be `.aero-fill` or flat `--surface-raised`.

### 6.10 Toggle / checkbox / radio / slider

- **Toggle track:** `.aero-track`; **checked fill:** `.aero-track__fill`;
  **thumb:** `.aero-orb` with `size-*` and `box-shadow: var(--aero-bevel-orb)`.
- **Checkbox/radio:** 16px `.aero-well` box; checked uses
  `background: var(--aero-gloss-accent), var(--accent)` and a white glyph.
- **Slider:** `.aero-track` for the rail, `.aero-orb` for the thumb.
- Keep the existing label/row layout. Only the control shape changes.

### 6.11 Progress, meters, token bars

- Track: `.aero-track`.
- Fill: `.aero-track__fill`.
- Do not add blur to a track that updates every frame; the bevel and gradient
  are enough. The existing percentage-driven `linear-gradient` in
  `FormControls.jsx` can stay if it reads correctly; otherwise use the track
  fill.

### 6.12 Chat surfaces (special case)

Aero loses to readability in a dense transcript. Use this split:

| Surface | Treatment |
|---|---|
| Assistant/user message bubbles | `.aero-flat` or existing flat `--user-bubble`. **No blur.** |
| Markdown body, code blocks, tables | Flat. No gloss, no blur. |
| Tool call cards, thought blocks | Flat with 1px border. Optionally `.aero-fill` for the header row only. |
| Chat composer | `.aero-well` for the input well; `.aero-primary` for send; `.aero-orb` for attach/mic. |
| Message actions / selection menu | `.aero-popover`. |
| Recovery cards / notices | `.aero-panel` only if they are isolated cards, not inline rows. |
| Terminal log | Flat, `--terminal` background. Never glass. |

Do not add `backdrop-filter` per message. A virtualized transcript can have
dozens of mounted bubbles; each one would be a composited layer.

### 6.13 Tables, lists, code, terminal

- `.aero-flat` at most. Keep `--table-header-bg`, `--code-bg`, and
  `--terminal` exactly as they are.
- The container may be `.aero-panel`, but the table/code/terminal inside is
  flat.
- This is the main readability boundary. Do not blur it.

### 6.14 Settings

`src/components/settings/SettingsSection.jsx` is the highest-leverage file:

- `settingsCard` → `aero-panel` (keep `p-3`, radius comes from the class).
- `settingsField` → `aero-well` (keep padding/text classes).
- `buttonVariants.secondary` → `aero-control`.
- `buttonVariants.primary` → `aero-primary`.
- `buttonVariants.ghost` stays flat; hover fill only.
- `SettingsIconButton` → `aero-orb` when it is a round toggle; otherwise a flat
  ghost icon button.
- `SettingsCheckRow` → keep the row flat; only the checkbox itself gets the
  Aero treatment.
- `SettingsEmpty` → `aero-empty`.
- `SettingsMessage` → unchanged typography; error/success colors stay.

After this file is converted, every settings tab inherits the system. Do not
convert each tab's cards individually unless they bypass the primitives.

### 6.15 Titlebar / TabBar / app shell

- **App shell:** keep the outer `rounded-xl bg-[var(--surface)]` frame and its
  window shadow. It is the window, not a glass panel.
- **Titlebar:** a flat-to-slightly-raised chrome bar. Add a 1px bottom
  `--aero-line`, a top highlight, and a subtle top sheen. Do not blur it; the
  desktop is behind the whole window, not behind the bar.
- **TabBar:** flat `--surface-raised` container; `.aero-tab` on tabs (see
  §6.9).
- **Window controls:** use `.aero-orb` only on hover if the existing design
  allows; close stays red on hover, not accent.

### 6.16 Sidebars and panels

- `Sidebar` / `RightSidebar` roots: flat `--surface` with a 1px border. Do not
  blur the whole sidebar; it is a large area and would add constant compositing
  cost.
- Individual cards inside them: `.aero-panel`.
- Nested sections: `.aero-fill`.
- This keeps the expensive blur on small surfaces.

---

## 7. Interaction state contract

| State | Visual | Implementation |
|---|---|---|
| Rest | Gloss + 1px highlight + bottom bevel + outer shadow | Base class |
| Hover | Brighter gloss, brighter rim, no size change for controls; `-2px` lift for interactive panels | `:hover` in shared class |
| Pressed | `translateY(1px)`, gloss inverted to dark, bevel becomes inset | `:active` (and `[data-pressed="true"]` for synthetic presses) |
| Focus-visible | 2px accent outline, 2px offset, **outside** the bevel | Shared `:focus-visible` rule |
| Selected / toggled | Accent gloss + accent glow + `--on-accent` text | `[aria-pressed="true"]`, `[aria-selected="true"]`, `[data-active="true"]` |
| Disabled | 45% opacity, no blur, no transform, flat bevel | `:disabled`, `[aria-disabled="true"]` |
| Invalid | Error border + error focus glow | `[aria-invalid="true"]`, `:has(...)` |
| Loading | Keep shape; swap content for a spinner; `cursor: progress`; no shimmer over blur | Component-level `[data-loading="true"]` |

Non-negotiables:

- Every control must be operable by keyboard and show focus.
- Do not use `outline: none` without an equivalent focus-visible replacement.
- Do not encode pressed/selected state with gloss alone; keep
  `aria-pressed`/`aria-selected`/`aria-current` in the DOM.
- Transitions are short. Aero should feel crisp, not floaty.

---

## 8. Theme rules

All 23 themes (`light`, `dark`, and the named palettes) share one Aero token
set. Because the tokens derive from theme variables, no per-theme maintenance
is needed.

### 8.1 Light themes

- White highlights are subtle but still visible. If a light theme looks
  washed out, **raise the line alpha**, don't add black gloss:
  ```css
  [data-theme="solarized"] {
  	--aero-line: color-mix(in srgb, #ffffff 24%, transparent);
  	--aero-line-strong: color-mix(in srgb, #ffffff 44%, transparent);
  }
  ```
- Keep panel fills at 54% or higher so body text remains readable.
- Prefer a darker scrim behind text over a darker glass fill.

### 8.2 Dark themes

- White gloss reads as plastic above ~40% on large surfaces. Keep panel gloss
  at 12% and control gloss at 28–36%.
- Use accent glows sparingly; they are much more visible on dark backgrounds.
- Deep shadows need `-12px` to `-14px` spread to avoid a muddy halo.
- Test `onyx-dark` and `gruvbox-dark` specifically; they have the highest
  saturation contrast.

### 8.3 Adding or changing a theme

- Add theme variables in `src/index.css` as usual. Aero inherits them.
- Do not add Aero values to a theme block unless a token genuinely fails on
  that palette.
- Do not introduce a fixed Aero blue. If the product wants a dedicated
  "Windows Aero" theme, create a normal theme with blue `--accent` /
  `--surface` values; keep component CSS theme-agnostic.

### 8.4 Representative test matrix

| Theme | Why |
|---|---|
| `gruvbox-dark` | Reference screenshot; warm accent |
| `dark` | Default dark |
| `onyx-dark` | High-contrast dark; glow check |
| `solarized` | Light; sunken wells and contrast |
| `light` | Default light; white-on-white bevel check |
| `papaya` | Saturated warm accent; glow check |

---

## 9. Accessibility

Aero's translucency reduces contrast. The effect must never win over legibility.

1. **Text contrast:** 4.5:1 minimum for body text, 3:1 for large text and UI
   boundaries (WCAG AA). Measure the composite, not the token.
2. **Scrims:** for text on glass, either raise the fill opacity (panel to 66%+)
   or place a local scrim:
   ```css
   .aero-panel--copy {
   	background:
   		linear-gradient(
   			180deg,
   			color-mix(in srgb, var(--surface) 72%, transparent),
   			color-mix(in srgb, var(--surface) 60%, transparent)
   		);
   }
   ```
3. **Focus:** 2px accent outline, 2px offset, outside the bevel. Never clip it
   with `overflow: hidden`.
4. **State:** keep semantic attributes. Gloss is decoration, not the only
   signal.
5. **Motion:** honor `prefers-reduced-motion`. Disable lift/translate, not the
   bevels.
6. **Transparency:** honor `prefers-reduced-transparency` and the manual
   fallback. The UI must remain usable with blur off.
7. **High contrast / forced colors:** the `@supports` and forced-colors
   fallbacks should remove shadows and restore system colors:
   ```css
   @media (forced-colors: active) {
   	.aero-panel,
   	.aero-control,
   	.aero-primary,
   	.aero-well,
   	.aero-dialog,
   	.aero-popover {
   		border: 1px solid ButtonBorder;
   		background: Canvas;
   		box-shadow: none;
   		-webkit-backdrop-filter: none;
   		backdrop-filter: none;
   	}
   }
   ```
8. **Text shadows:** only on large display headings (the prototype uses one on
   the page `h1`). Never on body text, controls, tables, or code.
9. **Placeholder contrast:** keep `--text-muted`; do not lower it for gloss.
10. **Hit targets:** do not shrink to make an orb look dainty. 28px minimum.

---

## 10. Performance

`backdrop-filter` is the expensive part. Bevels and gradients are paint-cheap
by comparison.

### 10.1 Budgets

- **Panels:** `blur(16px)` maximum. Dialogs/popovers may use `24px`, but only
  when few are open.
- **Controls:** `blur(10px)`; wells `12px`.
- **Visible blurred surfaces:** keep under ~20 in the viewport. A grid of 100
  cards should blur only the visible page's cards (native scrolling already
  limits paint), but avoid blurring every row of a long list.
- **No per-message blur.** See §6.12.
- **No nested blur.** Use `.aero-fill`.
- **No animation of blur, filter, or large shadow radii.** Animate
  `transform`/`opacity` only.
- **Animated backgrounds:** the existing guard in `index.css` drops dialog
  backdrop blur when `data-bg-animated="true"`. Extend that guard to any new
  animated background surface; never let a GIF force per-frame blur.
- **Large surfaces:** sidebars and the app shell stay flat. Blur small panels.

### 10.2 How to measure

1. Open DevTools → Performance.
2. Record 5 seconds of scrolling the heaviest page (Projects with 100 cards,
   chat with 500 messages, settings with all cards expanded).
3. Check frame time. Target ≤ 16.7ms at 60Hz, ≤ 8.3ms at 120Hz.
4. If frame time doubles, reduce blur radius or remove blur from the largest
   surface first.
5. Test with an animated background enabled; the blur should be gated off, not
   silently dropping frames.

### 10.3 Fallback

Always ship the `@supports not (backdrop-filter…)` fallback. The UI must look
intentional with flat fills, not broken.

---

## 11. Top layer, portals, overflow, and transforms

These are the four places Aero implementations usually break.

### 11.1 Native `<dialog>`

- Dialogs paint in the browser top layer, **outside** `<body>`. The app's
  background-image opacity layer sets `--bg-ui-opacity` on `body`; dialogs use
  it separately (`html[data-bg-image="true"] dialog`). Do not remove that rule
  when adding `.aero-dialog`.
- `::backdrop` is part of the dialog recipe. Do not add a second backdrop
  element.
- `onCancel` / focus trapping already exist; don't touch behavior while
  restyling.

### 11.2 Portals

- Menus, tooltips, and popovers are portaled to `document.body`, or into their
  owning native `<dialog>` so they stay in the top layer. Keep these portals.
  A filtered dialog establishes a fixed-position containing block;
  `fixedPortalPosition` in `src/lib/portalCoordinates.mjs` converts viewport
  coordinates to that dialog's padding box (including border/scroll offsets).
  Both FormControls and Tooltip use it. Flat dialogs keep viewport coordinates.
  Nested dialog menus/tooltips retain their material fill without a second blur.
- `useMenuCoords` in `FormControls.jsx` already clamps menus to the viewport and
  the owning `<dialog>`. Preserve it.

### 11.3 Overflow

- Blurred panels should not clip focus rings. Avoid `overflow: hidden` unless
  the shape requires it.
- Rounded panels with inner images need `overflow: hidden`; in that case add
  inner padding so focus rings are not clipped.

### 11.4 Transforms

- `.aero-panel--interactive:hover` uses `translateY(-2px)`. A transform makes
  the element a containing block for fixed descendants. Since menus are
  portaled, this is safe. Do not apply the interactive lift to a panel that
  contains a non-portaled fixed element.

---

## 12. Migration playbook

Do the phases in order. Each phase has a hard acceptance gate; do not start the
next phase until it passes.

### Phase 0 — Foundation (one PR)

Files: `src/index.css`, `src/styles/aero.css`, `src/main.jsx`, Projects markup,
and the opt-in `TextField.frameClassName` hook.

Validation: production build passes; browser checks cover all six reference
themes, focus, search, pin filtering, reduced motion, animated-background blur
guards, rim alpha, and absence of nested star blur. The backend Projects test currently
fails at `tests/projects.test.cjs:64` on its unrelated `Complete the user`
system-prompt assertion.

Implementation is complete. Projects and its existing workspace chrome consume
the global recipes. Layout remains page-specific. Deliberate differences:
selected Pinned filters use the shared accent state; the empty border mixes
with `--border` for light themes; nested star buttons retain their orb bevel
without a second blur. Bottom rims remain at the approved 9% / 24%.

1. Add the tokens from §4 and the utilities from §5.
2. Add the fallbacks from §5.1.
3. Verify no visual change on unconverted pages.
4. Refactor the existing Projects prototype in `projects.css` to consume the
   shared classes where they match. Keep `.projects-page` for the stage and for
   the two page-specific shapes: the 36px heading badge and the compact path
   chip. Delete duplicate material values everywhere else. The empty-state
   border may take the cross-theme-friendly `--aero-empty` value.
5. Acceptance: Projects retains its look; any visual difference is intentional
   and noted in the PR; every other page is untouched; `npm run build` passes.

### Phase 1 — Shared primitives (one PR)

Files: `src/components/settings/SettingsSection.jsx`,
`src/components/FormControls.jsx`, `src/components/Tooltip.jsx`.

1. Convert `settingsCard`, `settingsField`, `buttonVariants`, icon buttons,
   empty states.
2. Convert `fieldFrame` and the native field recipe.
3. Convert the select menu and tooltip to `.aero-popover` / `.aero-tooltip`.
4. Acceptance: every settings tab, every form, and every tooltip inherits Aero
   with no per-tab edits. Keyboard focus remains visible. Menus still clamp and
   flip correctly inside dialogs.

### Phase 2 — Chrome (one PR)

Files: `src/App.jsx`, `src/components/main-app/Titlebar.jsx`,
`src/components/TabBar.jsx`, `src/components/Sidebar.jsx`,
`src/components/RightSidebar.jsx`, `src/components/ContextPanel.jsx`.

1. Add the stage to page roots (`aero-stage`).
2. Titlebar: bottom rim + top sheen; no blur.
3. TabBar: `aero-tab` on tabs; flat container.
4. Sidebar roots: flat; inner cards `aero-panel`.
5. Acceptance: window still drags/minimizes/closes; tab drag-reorder works;
   no layout shift; 60fps scrolling with the sidebar open.

### Phase 3 — Dialogs (one PR)

Files (10): `ModelSettingsModal.jsx`, `main-app/ModelSelectorModal.jsx`,
`main-app/MemorySettings.jsx`, `ModelCapabilitiesModal.jsx`,
`ProjectModal.jsx`, `ChatHistory.jsx`, `DirectorySettings.jsx`,
`chat/DiffReviewModal.jsx`, `chat/RecoveryHistoryModal.jsx`,
`chat/SubagentTranscriptModal.jsx`.

1. Apply `.aero-dialog` to each `<dialog>`.
2. Remove old `bg-*`, `border-*`, `rounded-*`, `shadow-*`.
3. Keep header/footer bands flat (`.aero-fill` at most).
4. Acceptance: open/close, Escape, focus trap, scroll containment, and the
   background-image opacity path all still work. No double scrollbars.

### Phase 4 — Popovers, menus, toasts (one PR)

Files: `FormControls.jsx` (select menu), `Tooltip.jsx`,
`AgentSettingsPopover.jsx`, `TextSelectionMenu.jsx`,
`main-app/ToolApprovalToast.jsx`, `main-app/ToolLimitToast.jsx`,
`chat/ChatFindBar.jsx` (if it has a floating panel).

1. Apply `.aero-popover` / `.aero-tooltip`.
2. Keep portal placement and clamping.
3. Acceptance: no clipping inside dialogs; no drift on scroll; Escape/outside
   click still closes; toast stacking unaffected.

### Phase 5 — Chat surfaces (one PR)

Files: `ChatInputBar.jsx`, `ChatInput.jsx`, `ChatMessage.jsx`,
`AssistantMessage.jsx`, `MessageActions.jsx`, `ThoughtBlock.jsx`,
`ToolCallBlock.jsx`, `chat/*`, `RichBlocks.jsx`, `TerminalLog.jsx`.

1. Composer → `.aero-well`; send → `.aero-primary`; attach/mic → `.aero-orb`.
2. Message bubbles, markdown, code, tables, terminal stay flat.
3. Tool cards: flat; only isolated cards may use `.aero-fill`.
4. Acceptance: 500-message transcript scrolls at 60fps; code and terminal
   contrast unchanged; text selection menu works.

### Workspace migration — completed

The single-project workspace now uses shared panels, nested wells/controls,
and opaque inset Markdown/recent-chat content. Its dependencies (`FormControls`,
`ChatInputBar`, `AgentSettingsPopover`, `Tooltip`, `ProjectSkillsCard`) use
shared Aero recipes. These shared controls also update their other consumers.
The skills manager uses a portaled native dialog so panel blur cannot change
its containing block; Escape and native focus containment are preserved.
Nested material never adds another blur. Disabled wells detect only direct
native fields, not disabled buttons or placeholder options deeper inside.

### Phase 6 — Remaining pages (one PR per area)

Files: `ProjectsView.jsx` (already done), `ProjectWorkspace.jsx`,
`ProjectModal.jsx`, `MemoryTab.jsx`, `MemoryPalace.jsx`,
`ProjectsView` empty state, `settings/*` tabs, `settings/usage/*`,
`FileBrowserWidget.jsx`, `InteractiveChart.jsx`, `AdditionalPrompts.jsx`.

1. Page root → `aero-stage`.
2. Isolated cards → `aero-panel`.
3. Forms → `aero-well` / `aero-control` / `aero-primary`.
4. Charts/tables → flat.
5. Acceptance: each page passes the §15 checklist; no mixed flat/Aero cards on
   the same screen.

### Phase 7 — Sweep and QA

1. `grep -rn "bg-\[var(--surface)\]" src --include=*.jsx` and review each hit:
   is it a panel, a flat content surface, or a layout wrapper?
2. `grep -rn "<dialog" src --include=*.jsx`: all ten must use `.aero-dialog`.
3. `grep -rn "shadow-\(sm\|md\|lg\|xl\|2xl\)"` and
   `grep -rn "shadow-\["`: remaining shadows should be intentional flat
   elevation, not leftover cards.
4. Remove duplicate material utilities (`bg-*`, `border-*`, `shadow-*`) from
   converted elements.
5. Run the full QA checklist (§15) on six themes and the heaviest pages.
6. `npm run build` and `npm test`.

---

## 13. Component map (elevation cheat sheet)

Counts at time of writing: **10 dialogs**, **94 `bg-[var(--surface)]` uses across
37 JSX files**, **191 buttons**, **32 native form controls**.

| Area / file | Elevation | Notes |
|---|---|---|
| `App.jsx` shell | frame | Opaque rounded window; keep window shadow |
| `main-app/Titlebar.jsx` | L2 chrome | Rim + top sheen; no blur |
| `main-app/Header.jsx` | L2 chrome / controls | Migrated: unblurred `aero-header`, nested controls/orbs, context track |
| `TabBar.jsx` | L2 tabs | Migrated: `aero-tab` with `data-active`, gloss and accent underline; flat `aero-tabbar` |
| `Sidebar.jsx` / `ChatHistory.jsx` | L0 root / L3 cards | Migrated: borderless frame, glass folder cards, flat chat rows and compact search toolbar |
| `RightSidebar.jsx` | L0 root / L3 cards | Migrated: unblurred frame, Aero cards and tabs across casual/workspace modes |
| `ContextPanel.jsx` | L3 cards | Individual cards glass |
| `settings/SettingsSection.jsx` | L3 / L2 / L1 | Convert primitives once |
| `FormControls.jsx` | L1 / L4 | Migrated: wells, popover menus, checkbox, pill toggle, slider |
| `Tooltip.jsx` | L4 | `.aero-tooltip`, no gloss |
| `ProjectsView.jsx` | L3 / L2 / L1 | Reference implementation (done) |
| `ProjectWorkspace.jsx` | L3 / L1 / L0 | Migrated: glass panels, nested wells/controls, opaque inset goal, flat chat list with row feedback |
| `ProjectModal.jsx` | L4 | `.aero-dialog` |
| `MemoryTab.jsx` / `MemoryPalace.jsx` | L3 cards / L0 list | Cards glass; memory text flat |
| `settings/usage/*` | L3 cards / L0 tables | Cards glass; charts/tables flat |
| `ChatInputBar.jsx` / `ChatInput.jsx` | L1 + L2/L5 | Composer well; send primary |
| `ChatMessage.jsx` / `AssistantMessage.jsx` | L0 | Flat bubbles; no blur |
| `ThoughtBlock.jsx` / `ToolCallBlock.jsx` | L0 | Flat; header may be `.aero-fill` |
| `RichBlocks.jsx` | L0 / L3 | Isolated rich cards may be glass; data blocks flat |
| `TerminalLog.jsx` | L0 | Never glass |
| `chat/*Modal.jsx` | L4 | `.aero-dialog` |
| `chat/ChatFindBar.jsx` | L4 | `.aero-popover` if floating |
| `Tooltip` / `AgentSettingsPopover` / `TextSelectionMenu` | L4 | Portaled `.aero-popover` / `.aero-tooltip` |
| `main-app/*Toast.jsx` | L4 | `.aero-popover` + semantic border |
| `FileBrowserWidget.jsx` | L3 / L0 | Panel + flat rows |
| `InteractiveChart.jsx` | L0 | Chart stays flat |
| `AdditionalPrompts.jsx` | L3 / L2 | Cards + controls |

---

## 14. Step-by-step: converting one component

1. **Classify**: L0, L1, L2, L3, L4, or L5. Write it down in the PR.
2. **Find the material**: inspect the element's current `className` and any
   component CSS rule. List every `bg-*`, `border-*`, `rounded-*`, `shadow-*`,
   `backdrop-*`, and `focus-visible:*`.
3. **Replace with one Aero class**: `.aero-panel`, `.aero-control`,
   `.aero-primary`, `.aero-well`, `.aero-orb`, `.aero-badge`, `.aero-dialog`,
   `.aero-popover`, `.aero-tooltip`, `.aero-empty`, `.aero-flat`, or
   `.aero-fill`.
4. **Delete the old material utilities.** Keep layout, spacing, typography,
   responsive, and positioning utilities.
5. **Add the semantic state marker**: `aria-pressed`, `aria-selected`,
   `data-active`, `aria-invalid`, `disabled`. Do not invent a visual-only
   class.
6. **Check nesting**: if the parent is already glass, use `.aero-fill` on the
   child instead of `.aero-panel`/`.aero-control`.
7. **Check containment**: any fixed-position child must be portaled; otherwise
   do not add `backdrop-filter` to the parent.
8. **Check theme contrast** on the six-theme matrix. Screenshot before/after.
9. **Check keyboard**: Tab to the control, ensure a 2px accent ring appears
   outside the bevel. Press Space/Enter; ensure the pressed state appears.
10. **Check performance** on the heaviest instance of the component (long list,
    large grid, open dialog).
11. **Remove dead CSS** from the component file. Do not leave the old flat
    recipe commented out.
12. **Update the component map** in §13 if the elevation classification changed.

### Example diff: secondary button

```diff
- <button className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
+ <button className="aero-control inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium">
```

### Example diff: card

```diff
- <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
+ <section className="aero-panel p-3">
```

### Example diff: dialog

```diff
- <dialog className="m-auto w-[calc(100%-24px)] max-w-md overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60">
+ <dialog className="aero-dialog m-auto w-[calc(100%-24px)] max-w-md overflow-hidden p-0">
```

---

## 15. QA checklist

Copy this into every Aero PR.

### Visual

- [ ] The surface is classified at the correct elevation (L0–L5).
- [ ] Specular highlight is on the top edge; under-bevel is on the bottom.
- [ ] Gloss horizon is at 47–49% (controls) or 38–40% (panels).
- [ ] No raw hex/Aero blue in component code.
- [ ] No duplicate `bg-*`/`border-*`/`shadow-*` on the converted element.
- [ ] Nested surfaces use `.aero-fill`, not a second blur.
- [ ] Content inside the surface stays flat (text/code/table/terminal).

### States

- [ ] Hover brightens; it does not change size (controls).
- [ ] `:active` depresses by 1px with an inset bevel.
- [ ] `:focus-visible` shows a 2px accent ring outside the bevel.
- [ ] Disabled is visibly inert and non-interactive.
- [ ] Selected/pinned uses `aria-pressed`/`aria-selected` + accent gloss.
- [ ] Invalid fields use the error border and error focus glow.

### Themes

- [ ] `gruvbox-dark` (reference)
- [ ] `dark`
- [ ] `onyx-dark`
- [ ] `solarized`
- [ ] `light`
- [ ] `papaya`
- [ ] The component's own default theme

### Accessibility

- [ ] Body text meets 4.5:1; UI boundaries meet 3:1.
- [ ] Keyboard-only operation works.
- [ ] Focus is never clipped by `overflow: hidden`.
- [ ] State is conveyed semantically, not only by gloss.
- [ ] `prefers-reduced-motion` disables lift/translate.
- [ ] `prefers-reduced-transparency` (or the documented fallback) keeps the UI
      usable with blur off.
- [ ] Forced-colors mode does not produce invisible text.

### Performance

- [ ] No more than ~20 blurred surfaces visible at once.
- [ ] No nested `backdrop-filter`.
- [ ] No per-message or per-row blur.
- [ ] No animated blur/filter/large shadow.
- [ ] Heaviest page scrolls at 60fps.
- [ ] Animated background gates the backdrop blur off.

### Regression

- [ ] Dialogs open/close, Escape works, focus trap intact.
- [ ] Portaled menus still position correctly and clamp inside dialogs.
- [ ] Tab drag-reorder still works.
- [ ] Window drag/minimize/maximize/close still works.
- [ ] Background-image + `--bg-ui-opacity` path still works.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.

---

## 16. Anti-patterns (reject these in review)

1. **Glassmorphism only**: blur + translucent fill with no gloss or bevel.
2. **Flat glass**: 1px border and blur, but no top highlight or bottom shadow.
3. **Light from below**: `linear-gradient(0deg, …)` or bottom-heavy highlight.
4. **Raw Aero blue** in component CSS. Theme identity wins.
5. **Gloss over text**: a `::before` overlay above content. If you need a
   pseudo-element, use `z-index: -1` inside an isolated stacking context and
   prove text stays on top.
6. **Blur on every row/message**: creates dozens of composited layers.
7. **Nested blurs**: `aero-panel` inside `aero-panel` both with
   `backdrop-filter`.
8. **`overflow: hidden` on interactive panels**: clips focus rings and menus.
9. **Transform on an ancestor of a non-portaled fixed menu**: popover drift.
10. **Animating `filter`/`backdrop-filter`/large `box-shadow`**: jank.
11. **Removing focus outlines** to "clean up" the glass.
12. **Using opacity for disabled** without also disabling pointer events.
13. **Applying Aero to the app shell or a full sidebar**: large-area blur.
14. **Adding `!important`**: fix the source of the conflict instead.
15. **Leaving the old flat CSS in place** "just in case": two sources of truth
    will drift.
16. **Hardcoding radius/blur** in a component when a token exists.
17. **Per-theme recipe forks**: override a token, not the whole class.
18. **A dedicated `.aero-*` class on every child**: the material belongs on the
    surface, not on text spans.

---

## 17. Reference implementation

The Projects dashboard is the visual source of truth:

- `src/styles/aero.css` → global materials and states.
- `src/components/projects.css` → Projects layout, heading badge, compact path chip.
- `src/components/ProjectsView.jsx` → markup (`aero-panel`, `aero-primary`, `aero-well`, `aero-orb`,
  plus page-specific layout classes).
- Screenshot: the page in `gruvbox-dark` is the canonical look; `solarized`
  light was verified for the sunken well and bevel contrast.

The shared foundation is global and opt-in. Unconverted surfaces retain their
existing styles. Projects consumes the shared classes; its 36px heading badge
and compact path chip keep page-specific geometry/material variations using
shared tokens. The empty-state border mixes with `--border` for light themes.

### 17.1 Prototype values that must survive refactoring

| Element | Key values |
|---|---|
| `.projects-page` stage | accent radials at 22%/11%/9%, white top sheen 5%, `background-color: var(--bg-secondary)` |
| `.project-card` | `aero-panel`, radius 14, blur 16/155%, hover lift −2px, accent rim at 48% |
| `.aero-control` | `aero-control`, radius 9, blur 10/150%, gloss 28% → 9% → 0 → 10% black |
| `.aero-primary` | `aero-primary`, radius 12, gloss 58% → 14% → 0 → 22% black, accent glow |
| `.aero-well` search frame | `aero-well`, radius 12, blur 12/150%, inset shade 30%, focus accent ring + glow |
| `.project-path` | sunken chip, radius 7, inset shade 32% |
| `.aero-orb.project-pin` | `aero-orb`, 28px, gloss 26% → 6% → 0 → 14% black, selected orb accent gloss; no nested blur |
| `.project-heading-icon` | accent glass badge, gloss 34% → 0 → 16% black, accent glow |
| Raised bottom rim | cards, controls, orbs, heading badge at white `9%`; primary and pressed toggles at white `24%` |

### 17.2 Open decisions

These are intentionally unresolved. Do not invent answers per component; raise
them once and record the outcome here.

1. **Runtime toggle — resolved.** Settings → Appearance → Visual effects →
   Aero glass switches the entire app between `data-appearance="aero"` and
   `data-appearance="flat"`. The local `appearance` preference defaults to Aero
   and is restored before first paint. `src/styles/appearance.css` removes
   blur, translucency, gloss, bevels, stage lighting and interactive lift from
   converted surfaces, including portals and native dialog backdrops. Flat
   mode preserves solid theme fills, semantic accents, hover and focus states.
   New components use shared utilities; do not add component-level toggles.
2. **Wallpaper glass.** `.aero-stage` already goes transparent when
   `data-bg-image="true"`, but the app shell is opaque. True desktop glass
   requires making the shell translucent and re-testing `--bg-ui-opacity` for
   top-layer dialogs.
3. **Dedicated Aero theme.** Not planned. Theme identity wins; if product wants
   classic blue Aero, add it as a normal theme with blue tokens.
4. **Blur budget enforcement.** Currently manual QA. If regressions appear,
   consider a development-only overlay that counts visible `backdrop-filter`
   elements.

---

## 18. Appendix: quick reference card

```
L0 flat        .aero-flat         transcript, code, terminal, tables
L1 well        .aero-well         inputs, search, path chips, tracks
L2 control     .aero-control      secondary buttons, tabs, chips
L2 orb         .aero-orb          round icon toggles, pin, knobs
L3 panel       .aero-panel        cards, settings cards, empty states
L3 nested      .aero-fill         inner sections (no second blur)
L4 dialog      .aero-dialog       <dialog> + ::backdrop
L4 popover     .aero-popover      menus, dropdowns, toasts
L4 tooltip     .aero-tooltip      tooltips (no gloss)
L5 primary     .aero-primary      one CTA per view
L5 badge       .aero-badge        status pills, selected chips
Stage          .aero-stage        page backdrop with accent aurora
```

**The sentence to remember:** *Translucency is the material; the top highlight,
bottom bevel, and gloss horizon are the effect. If the light is not coming from
above, it is not Aero.*

### Workspace polish: list feedback and read-only wells

Use `.aero-list-item` for chat rows and select options. Hover/focus adds a
theme-derived accent tint and a restrained bevel; selected
options retain a quieter tint at rest. Rows never blur or lift. Select triggers
brighten their rim on hover and while open. `.aero-inset` gives read-only goal
copy a sunken bevel over an opaque fill, without blur or a raised gloss layer.

### TabBar migration

TabBar uses `.aero-tabbar` for flat, unblurred window chrome and `.aero-tab`
on each draggable wrapper. `data-active` selects the raised gloss and accent
underline; `data-dragging` dims the dragged item. Inactive tabs brighten on
hover, active tabs get stronger gloss, and pressing the label inverts its
bevel without moving the tab. A focus-visible descendant draws an inset ring
so horizontal overflow cannot clip keyboard focus. Close buttons use ghost
chrome feedback; the new-tab button uses a nested, unblurred Aero orb.

### Appearance preference implementation

`src/lib/appearance.mjs` owns the persisted material preference and root DOM
attribute. `useAppearance` subscribes only the settings control, avoiding a
transcript-wide React update. `AppearanceSettings` is placed before the theme
picker in the Settings modal. Startup HTML applies the preference before paint;
`src/main.jsx` initializes the same store before rendering. Storage failure
still permits switching the current window. The preference has unit coverage
for persistence, restart, storage events and unavailable storage.

### Header migration

`main-app/Header.jsx` uses `.aero-header` for an opaque top-lit chrome bar,
with no backdrop filtering or large outer shadow. Sidebar/settings/home
buttons use nested Aero orbs; the model and workspace selectors use nested
raised controls. Sidebar toggles retain `aria-expanded`/`aria-controls` and
expose `aria-pressed` for the shared accent state. The context meter uses
`aero-track` / `aero-track__fill` and retains its measured progress semantics.
The centered model picker, workspace routing, labels and callbacks are
unchanged. Global flat mode removes material effects from all these classes.

### Right sidebar migration

The sidebar frame stays opaque and unblurred (`sidebar-frame`), keeping the
existing translate/opacity animation and width spacer in both appearances.
Only isolated cards use `.aero-panel`; nested fields and buttons retain
bevels without another blur. Section tabs use `.aero-tab` with `aria-selected`
and an inset keyboard focus ring. The header uses unblurred chrome and a
close orb. Cost, assistant, prompt, sampling, memory, activity, agent, plan,
recovery and context cards use shared material recipes. Context summaries,
plan steps, recent tool/subagent lists and command output remain flat.
Status badges keep semantic colors via `data-tone`. Flat mode applies to
all shared materials; the undecorated frame preserves its slide animation.

### Model selector migration

`main-app/ModelSelectorModal.jsx` presents one scrollable view with separate
Local models and Cloud models sections. The All/Local/Cloud filters are
removed. Shared search filters both groups; sorting applies within each group.
Local columns show parameters, quantization and disk size. Cloud columns show
context, maximum output and per-million-token pricing. Section counts reflect
matching entries. Only the modal blurs: rows use nested `.aero-fill`, row
hover/current feedback uses `.aero-list-item`, and expanded cloud selectors
use opaque `.aero-inset`. The global flat preference remains supported.
Dropdown and tooltip coordinates account for a blurred native dialog, while
capability editing, cloud favorites, manual model IDs, local reuse/loading,
rescan and unload retain their existing behavior.

### Model load settings migration

`ModelSettingsModal.jsx` uses `.aero-dialog` with the existing 880px maximum
width, 85dvh height cap, field grids, ordering, spacing and scrolling behavior.
Section cards use `.aero-fill` so the dialog supplies the only backdrop blur.
Header/footer bands use unblurred chrome; actions use shared control, orb and
primary recipes. Existing shared FormControls retain their Aero treatment.
Error/warning semantics, load options, projector safeguards, memory estimates
and persistence are unchanged. The system-wide flat preference applies to
the dialog, cards, fields and actions.

### Chat-history navigation migration

The outer `Sidebar` and standalone `ChatHistory` use borderless frames.
Embedded `ChatHistory` fills its available width. Selected list rows use
an accent-tinted fill without a bright vertical stripe. Search and the compact New Folder button share one toolbar row.
Workspace/folder/recent cards use `.aero-panel`; chat lists stay opaque and
unblurred, with `.aero-list-item` hover and current-chat feedback. Row action
buttons remain keyboard reachable and reveal on hover or focus. Stable row
components preserve focus when menus close. Action dialogs, portaled menus
and export toasts use shared floating materials and honor flat mode.

### Appearance settings tab migration

Only the Appearance panel opts into `SettingsMaterialContext`. Its Visual
effects, Color theme, Background image and avatar cards use shared Aero
materials; theme choices and nested actions use `.aero-fill`. Shared settings
primitives retain their previous defaults outside this subtree. Theme swatches
keep their palette colors, selected descriptions use the accent foreground,
and file upload inputs retain native picker behavior and keyboard focus.
The modal frame, navigation and other tabs are unchanged. Flat mode applies
to the new cards and controls through the global appearance preference.

### Additional Settings tab migrations

Notifications, MCP Integrations, Agents & Skills, Engine & API, and Storage
& Data opt into the same settings material context as Appearance. The
provider is scoped to each panel and preserves lazy mounting. Shared cards,
actions, icon buttons, check rows and empty states use Aero; fields retain
the FormControls well. MCP mode buttons and server switches use nested
controls, and notification volume uses the shared slider. Directory paths
and local API details use opaque inset wells. Tool lists, budget copy and
other dense content stay flat; no nested blur is added. Flat mode and all
settings handlers remain supported. Unconverted panels retain their defaults.

### Unified model settings

Avatar & Branding owns the single per-model list. Each entry combines its
name and avatar controls with a lazy, expandable memory/prompt/sampling
profile. Appearance contains only visual settings; Models & Generation
retains provider setup and the global generation profile; Memory retains
the current-chat switch, global memory profile and saved memories. Existing
avatar keys, model-path profile keys, patch saves and inheritance reset are
preserved. Nested model profiles use `.aero-fill` to avoid another blur. The
new panel follows the same lazy mounting and flat-mode rules as other tabs.

### Remaining Settings tabs

Models & Generation, Memory, Usage & Logs, and Usage & Costs now opt into
the settings material context. Cloud provider categories use nested Aero
controls and rate fields use an inset well. Shared profile, memory, token
history and terminal cards inherit the same treatment. Spending filters,
metrics, timeline frames, detail cards, attribution and pricing sections
use Aero panels; dashboard tabs use `.aero-tab`. Charts and tables have
opaque flat content surfaces, terminal output keeps its terminal palette,
and saved-memory text stays flat. Nested model timelines use `.aero-fill`.
Warning metrics preserve their semantic border. Global flat mode remains
available across every settings tab.

### Settings modal frame

`MemorySettings` uses `.aero-dialog` instead of the legacy `palace-dialog`
class. Main and section headers use `.aero-header`, navigation uses unblurred
`.aero-navigation`, and selected vertical tab buttons use nested `.aero-control` with
`aria-selected`. Inactive tabs remain flat, with a quiet hover tint and
keyboard focus ring. The close action uses a nested orb. Existing dialog sizing,
responsive navigation, lazy panels, focus handling and keyboard tab routing
remain in place. The dialog supplies the only backdrop filter: nested panels
as well as controls and wells suppress their filters through the shared
material rule. Flat mode applies to the frame and navigation through the
same global preference.

### Diff review modal

`chat/DiffReviewModal.jsx` uses the shared dialog, header, footer, close orb
and nested action/layout controls. Changed files use an opaque list with
quiet current-file tint and shared hover feedback. Diff panes keep their
code palette, syntax colors, line numbers and addition/removal tones; no
blur or gloss is added to code. Revert previews use an opaque inset well.
The dialog supplies the only blur and honors global flat mode. Existing
split/unified geometry, scrolling, preview/confirm flow, risk authorization,
overwrite flags and active-run/busy guards remain unchanged.

### Recovery history modal

`chat/RecoveryHistoryModal.jsx` uses the shared dialog/header, close orb,
pin, preview and restore controls. History entries use quiet current-item
feedback inside an opaque list; checkpoint details use a nested panel,
with flat file content and an inset restore preview. Native overwrite and
content-authorization checkboxes use the shared `.aero-checkbox` visual.
Only the dialog blurs, and global flat mode remains supported. Checkpoint
selection, pinning, partial-capture notices and restoration safeguards keep
their existing behavior.

### Right-sidebar card separation

Right-sidebar panels override shared `--aero-panel-fill` and
`--aero-panel-gloss` slots in Aero mode. A 94% theme-surface fill limits
background tint, and a 2% lower gloss shade keeps light-theme cards distinct
from the frame. Other panels retain their standard material; flat mode
retains its existing opaque theme fills. This rule is scoped to the sidebar
frame and inherited across every sidebar tab, without component recipes.

### Reading-first chat materials

`ChatInterface` exposes `data-chat-mode` for casual/workspace styling. Casual
user bubbles use `.aero-chat-user`: an opaque theme bubble with a faint top
highlight and 1px shadow. Workspace messages remain undecorated. Both modes
use `.aero-chat-composer`, with an even shorter shadow and no gradient in
workspace mode. No new material uses backdrop blur or text shadows.

`.aero-chat-detail` adds only a subtle rim and inset highlight to supporting
content. Expanded workspace tool rows use `.aero-chat-tool` with an opaque
fill and faint edge; collapsed rows remain plain, with theme-aware hover
feedback. Assistant prose, thought text, code and tool output remain flat.
Global flat mode removes these highlights and shadows. Transcript widths,
streaming, message actions, tool expansion and composer input stay unchanged.

### Model capabilities editor

`ModelCapabilitiesModal` uses the shared Aero dialog, header, footer, close
orb and save action. Capability dropdowns use `SelectField`, and cloud context
length uses `NumberField`. Menus remain inside the native dialog top layer
and account for its filtered coordinate system. `SelectField` forwards an
explicit accessible label to its visible trigger as well as the native
backing select. Local/cloud save targets, automatic detection, reset and
context validation remain unchanged. The editor honors global flat mode.

### Project creation modal

`ProjectModal` uses the shared Aero dialog, header/footer chrome and nested
actions. Name uses `TextField`; goal and custom instructions use
`TextAreaField`. Root-folder selection displays an opaque inset path well.
The obsolete `.project-dialog` material rules are removed. Required-name
validation, folder picking, busy/error handling and creation payload remain
unchanged; shared flat-mode overrides apply throughout.

### Consolidated usage navigation

The duplicate Usage & Logs tab is removed. Usage & Costs owns cloud spending
and a Token usage subtab preserving all-model (local and cloud) totals,
filters and history charts. That subtab mounts lazily and stays mounted to
preserve filter state; its duplicate cloud-cost summary is suppressed. The
spending dashboard retains provider/model attribution and pricing evidence.
Engine logs live in Engine & API and subscribe only while that main tab is
active. Retention stays in Storage & Data. No usage records or aggregation
APIs are removed or migrated.

## Material refinement experiment — 2026-11-02

Shared tokens now use quieter panel gloss, softer shadows, denser fills, and
12px panel / 18px floating blur. Controls, wells, and orbs retain their lighting
and pressed states without live backdrop sampling. Static usage metrics use
`.aero-metric`; unselected theme choices use `.aero-theme-choice` to keep the
selected choice visually dominant. A theme-colored wallpaper scrim sits outside
the UI opacity group so image detail is subdued without dimming text again.
These runtime values supersede the earlier reference token examples above.
