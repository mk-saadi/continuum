# Right Sidebar — Design Language Report

**Scope:** `src/components/RightSidebar.jsx` (986 lines) and the shared primitives it
composes (`src/components/FormControls.jsx`, `src/components/ChatTuning.jsx`,
`src/components/ContextPanel.jsx`, `src/components/SubagentModelSelect.jsx`,
`src/components/Tooltip.jsx`) plus the token layer in `src/index.css`.

**Purpose:** this document describes the right sidebar's design language precisely enough
to apply the same language to other parts of the app. It is analysis only — no code was
changed to produce it.

---

## 1. The one-sentence summary

The right sidebar is a **320 px, single-column, card-stack settings surface**: a fixed
header, a full-width icon tab bar, and a vertically scrolling column of elevated,
white/`--surface` cards separated by a small, deliberate rhythm — each card carrying a
`text-xs font-semibold` heading, an accent-colored 16 px Lucide icon, `text-[11px]`
muted body copy, and controls that are themselves card-like. Everything is
**border-defined rather than shadow-defined**; the only shadow is a single 2 px/4 px
hairline used to lift cards off the panel.

---

## 2. Anatomy of the surface

### 2.1 Shell and layout

```
<aside id="right-sidebar" aria-label="Chat controls" aria-hidden={!open} inert={...}
  className="relative z-30 h-full shrink-0 max-[900px]:absolute max-[900px]:top-0
             max-[900px]:right-0 max-[900px]:z-40 ${open ? "w-80" : "w-0"}">
  <div className="absolute inset-y-0 right-0 flex h-full w-80 flex-col overflow-hidden
                   border-l border-[var(--border)] bg-[var(--bg-secondary)]
                   text-[var(--text-primary)]
                   transition-[translate,opacity] duration-300 ease-in-out
                   motion-reduce:transition-none max-[900px]:shadow-xl
                   ${open ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}">
```

Key decisions encoded here:

| Concern | Decision |
| --- | --- |
| Width | `w-80` = **320 px**, fixed. Not fluid, no min/max. |
| Layout participation | The `<aside>` is a **spacer** (`w-80` / `w-0`); the inner panel is `absolute`. The code comment (lines 824–829) states the reason explicitly: only the inner panel animates, using translate/opacity, "so the transcript is not re-laid-out on every frame of the transition." |
| Animation | `transition-[translate,opacity] duration-300 ease-in-out`, with `motion-reduce:transition-none` for accessibility. |
| Responsive | Below 900 px the sidebar becomes an **overlay drawer** (`max-[900px]:absolute`, `z-40`, `shadow-xl`) rather than a column. |
| Panel background | `bg-[var(--bg-secondary)]` — one step *darker* than the cards it contains. |
| Divider | `border-l border-[var(--border)]` — a 1 px hairline, not a shadow. |
| Closed state | `aria-hidden` + `inert` — the closed panel is removed from the a11y tree and the tab order, not just visually hidden. |

**Design rule:** the sidebar never uses a backdrop/scrim. On desktop it is a
structural column; on mobile it is an overlay that floats above content with
`shadow-xl`.

### 2.2 Header

```jsx
<header className="flex shrink-0 items-center justify-between gap-3 border-b
                   border-[var(--border)] bg-[var(--surface)] px-4 py-4">
  <div className="flex min-w-0 items-center gap-3">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl
                     bg-[var(--active-chat)] text-[var(--accent)]">
      <LuSettings2 size={18} />   // or <LuActivity size={18} /> in workspace mode
    </span>
    <div className="min-w-0">
      <h2 className="truncate text-sm font-semibold">Chat controls</h2>
      <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
        {projectName ? `${projectName} · ` : ""}Chat Overridden
      </p>
    </div>
  </div>
  <button aria-label="Close chat controls"
    className="flex size-7 cursor-pointer shrink-0 items-center justify-center
               active:translate-y-0.5 rounded-lg text-[var(--text-secondary)]
               hover:bg-[var(--surface-hover)] focus-visible:outline-2
               focus-visible:outline-[var(--accent)] duration-300">
    <LuX size={17} />
  </button>
</header>
```

The **title block is a two-level hierarchy**: `text-sm font-semibold` title, then a
`text-[11px] text-[var(--text-muted)]` subtitle separated by `mt-0.5`. The subtitle is a
**live status string** ("Chat Overridden" / "Using Model Defaults"), not a static label.
The icon sits in a `size-9 rounded-xl` tile filled with `--active-chat` and stroked with
`--accent` — a recurring "tinted chip" motif. The close button is a `size-7` ghost
button with a 1 px nudge on press (`active:translate-y-0.5`).

### 2.3 Tab bar

```jsx
<div role="tablist" aria-label="Chat control sections"
  className="mt-3 flex shrink-0 gap-1 overflow-hidden border-b border-[var(--border)]
             bg-[var(--surface)] px-3 pt-2">
  <button role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
    className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center
                border-b-2 px-1 py-3 transition-colors
                focus-visible:outline-2 focus-visible:outline-[var(--accent)]
                ${tab === id
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
    <Icon size={17} className="shrink-0" />
  </button>
</div>
```

- **Icon-only tabs.** The label is present in the DOM as `aria-label` and `title`, never
  as visible text. Icon size is **17 px** (one step up from the 16 px card icons).
- **Underline tab affordance**: `border-b-2` with `border-transparent` when inactive.
  The active underline is `--accent`; the inactive is transparent, not a grey rule.
- **Equal-width distribution**: `flex-1` + `min-w-0` + `gap-1` + `overflow-hidden`.
  Tabs share the width evenly regardless of label length; icons are `shrink-0`.
- **Full-bleed separator**: `border-b border-[var(--border)]` spans the full width while
  the tab strip itself is inset by `px-3` and raised by `pt-2`. The header above uses
  `px-4`; the tab bar uses `px-3`; the panel below uses `px-4` (casual) or `px-3`
  (workspace). The 1 px inset difference is deliberate and is the only place the
  sidebar is not perfectly aligned.
- **Roving tabindex**: `tabIndex={tab === id ? 0 : -1}` plus arrow-key handling via
  `getNextTabIndex`. Full ARIA tabs pattern (`role="tab"` / `role="tabpanel"` /
  `aria-controls` / `aria-labelledby`).
- Panels are **all mounted, only one visible** (`hidden={tab !== id}`), so scroll
  position and field state survive tab switches.

### 2.4 Panel / scroll container

```jsx
const panelClass = isWorkspace
  ? "min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4"
  : "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5";
```

Two densities exist: **casual** uses `space-y-4 px-4 py-5`; **workspace** uses the
tighter `space-y-3 px-3 py-4` to fit denser content. `min-h-0 flex-1` inside a flex
column is the standard flexbox overflow fix.

---

## 3. The card — the central design object

Every panel is a vertical stack of cards. The card className is **literal and
repeated verbatim** (15 occurrences in `RightSidebar.jsx`):

```jsx
"rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
```

The identical string is exported as a constant in `ContextPanel.jsx:10-11`:

```js
const cardClass =
  "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]";
```

### Card anatomy

```
┌─ rounded-xl, 1px border --border, bg --surface, shadow 0 2px 4px --window-shadow
│  ┌─ p-3 (12px)
│  │  [16px Lucide icon, text-[var(--accent)]]  gap-2
│  │  <h3 class="text-xs font-semibold">Section title</h3>
│  │  ── optional lead paragraph: text-xs text-[var(--text-muted)]
│  │  ── optional body: text-[11px] leading-relaxed text-[var(--text-muted)]
│  │  ── optional list / form control
│  │  ── optional footer row: flex items-center justify-between gap-2
│  └─
└─
```

Header pattern, used verbatim across the file:

```jsx
<div className="mb-3 flex items-center gap-2">
  <LuUsers size={16} className="text-[var(--accent)]" aria-hidden="true" />
  <h3 className="text-xs font-semibold">Active agent</h3>
</div>
```

Variants observed: `mb-3` (title + content), `mb-2` (title + list), `mb-1` (title +
paragraph). Icons are always `size={16}` (Lucide default 24 → overridden to 16) and
always `text-[var(--accent)]`. Icons are `aria-hidden="true"` because the heading
already names the section.

### Card surface rules

- **Radius:** `rounded-xl` (12 px). This is the app's dominant radius.
- **Border:** `border-[var(--border)]` — 1 px, a *divider* token, not `--control-border`
  (which is reserved for interactive control frames).
- **Fill:** `bg-[var(--surface)]` — one step *lighter* than the panel's `--bg-secondary`.
  Cards are therefore lighter than their background, which is the opposite of the
  "dark card on light panel" convention many apps use.
- **Elevation:** exactly one shadow — `0 2px 4px var(--window-shadow)`. `--window-shadow`
  is an 8-digit hex with alpha (e.g. `#00000033` light, `#000000aa` dark), so the shadow
  strength is theme-controlled.
- **Padding:** `p-3` (12 px).

### Cards in the sidebar (complete inventory)

| # | Card | Where | Header icon |
| --- | --- | --- | --- |
| 1 | Reset chat overrides | Above the tab bar (casual) / in Controls (workspace) | none (button-only + hint) |
| 2 | Active agent | Persona | `LuUsers` |
| 3 | System prompt | Persona | `LuSparkles` |
| 4 | Sampling scope | Generation | `LuSlidersHorizontal` |
| 5 | ChatTuning (sampling controls) | Generation | none (nested card) |
| 6 | Memory & Context | Memory | `LuBrain` |
| 7 | Per-setting memory toggles (×2) | Memory | none (nested card) |
| 8 | Run status | Activity | status dot |
| 9 | Recent tool activity | Activity | none |
| 10 | Main model | Agents | `LuBot` |
| 11 | Available subagents | Agents | none |
| 12 | Sub-agent model | Agents | none |
| 13 | Running subagents | Agents | none |
| 14 | Context inspection | Context | `ContextPanel` (own card class) |
| 15 | Workspace plan / background commands / recovery | Activity | external components |

---

## 4. Typography system

The sidebar uses a **three-tier scale with a very small top end** — the largest text
anywhere in the panel body is `text-sm` (14 px), and that appears only in the header
title.

| Role | Class | Size / weight / color |
| --- | --- | --- |
| Panel title | `text-sm font-semibold` | 14 px / 600 / `--text-primary` |
| Section card title | `text-xs font-semibold` | 12 px / 600 / `--text-primary` |
| Form label | `text-xs font-semibold` | 12 px / 600 / `--text-primary` |
| Body / lead paragraph | `text-xs text-[var(--text-muted)]` | 12 px / 400 / `--text-muted` |
| Dense body, hints, list rows, status | `text-[11px] leading-relaxed text-[var(--text-muted)]` | 11 px / 400 / `--text-muted` |
| Status text | `text-[11px] font-medium` | 11 px / 500 / `--text-secondary]` or `--error` |
| Mono (tool names) | `font-mono` | JetBrains Mono Variable |
| Micro badge | `text-[10px]` | 10 px / 500 |

Rules worth carrying:

- **Nothing is uppercase and nothing is letter-spaced.** There is no
  `uppercase tracking-widest` eyebrow style anywhere in the sidebar. Section identity
  comes from the icon + weight, not from letterforms. (This diverges from the
  "uppercase eyebrow label" convention in many settings UIs.)
- **Hierarchy is weight + color, not size.** Between a card title (12/600) and body copy
  (12/400 muted) the *size is identical* — only weight and color change. Between
  body (12 muted) and dense body (11 muted) the *color is identical* — only size and
  leading change.
- `leading-relaxed` is used on all 11 px prose blocks; 12 px lead paragraphs sometimes
  omit it.
- `truncate` + `min-w-0` are used aggressively for any user-supplied or dynamic string
  (model names, tool names, long labels) so nothing can blow out the 320 px column.

---

## 5. Buttons

Three tiers, all sharing a `transition-colors` and a `focus-visible:outline-2
focus-visible:outline-[var(--accent)]` ring.

### Primary (filled accent) — exactly one per view

```jsx
"inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2
 text-xs font-semibold text-[var(--on-accent)] transition-colors
 hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2
 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
```

Used for **"Save prompt"** only. Note the `focus-visible:outline-offset-2` — a
deliberate ring offset, unlike the secondary buttons.

### Secondary (outlined)

Two near-identical variants exist:

```jsx
// A — the shared constant, used for "Reapply preset"
const secondaryButton =
  "flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg
   border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5
   text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]
   focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

// B — inline, used for "Reset chat overrides" and "Use model default"
"w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]
 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-hover)]
 focus-visible:outline-2 focus-visible:outline-[var(--accent)]
 disabled:cursor-not-allowed disabled:opacity-40"
```

Key traits: `rounded-lg` (8 px — one step *below* the card's `rounded-xl`), 1 px
`--border`, fill `--bg-secondary` (darker than the card it sits on, so it reads as
inset), `text-[11px] font-medium` (or `text-xs`), `px-2.5 py-1.5` (a 10/6 px compact
padding).

**Note the hierarchy:** the card is `rounded-xl` + `--surface`; the button on it is
`rounded-lg` + `--bg-secondary`. The button is *darker and sharper* than the card it
sits in. That inversion (container light, control dark) is a signature of this design
language.

### Ghost / icon-only

```jsx
"flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5
 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]
 focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
```

The close button. `size-7` (28 px) — a deliberately small hit target with a 1 px press
nudge. `duration-300` is unusually long for a hover color change; it matches the
panel's 300 ms open/close transition, so the whole surface feels like it moves at one
speed.

### Disabled convention

Two different idioms coexist, which is an inconsistency to fix before reusing:
- `disabled:opacity-50` (shared `secondaryButton` constant)
- `disabled:cursor-not-allowed disabled:opacity-40` (most inline buttons, and the
  primary button)

`disabled:opacity-40` + `cursor-not-allowed` is the dominant idiom (used by the primary
button, the reset block, and the "Use model default" button).

---

## 6. Form controls

The sidebar does not style inputs directly — it delegates to `FormControls.jsx`, which
defines the app's shared control language. This is the most transferable part of the
design system.

### Field shell (labels + hints)

```jsx
// FormControls.jsx:8-38
<div className={`min-w-0 ${className}`}>
  <label htmlFor={id} className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">
    {label}
    {required && <span className="ml-1 text-[var(--accent)]" aria-hidden="true">*</span>}
  </label>
  {children}
  {hint && (
    <p id={`${id}-hint`} className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
      {hint}
    </p>
  )}
</div>
```

- Label: **12 px / 600 / `--text-primary`**, `mb-1`.
- Hint: **11 px / relaxed / `--text-muted`**, `mt-1.5`, and it is *linked* to the input
  via `aria-describedby={`${id}-hint`}`.
- Required marker: a `--accent`-colored `*`, `aria-hidden`.
- Every control gets a `useId()`-generated id, so hints are always correctly associated.

### The field frame (the app's control surface)

```jsx
// FormControls.jsx:5-6
const fieldFrame =
  "flex min-h-8 items-center rounded-xl border border-[var(--control-border)]
   bg-[var(--input)] text-[var(--text-primary)] transition-colors
   hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)]
   focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)]
   has-[select:disabled]:opacity-50 has-[input:disabled]:opacity-50
   has-[textarea:disabled]:opacity-50";
```

This is the single most reusable primitive in the app:

- `--control-border` (a *stronger* border than `--border`) for the control edge.
- `--input` fill (a slightly different tone from `--surface`).
- **Two-part focus state**: border *and* ring both become `--accent`, giving a 1 px
  border + 1 px ring halo.
- `focus-within` (not `focus-visible`) so clicking into a field focuses the whole frame.
- `min-h-8` (32 px) minimum control height; `rounded-xl` matches the card radius.
- Disabled state is handled by the *frame* via `has-[...]:opacity-50` — a modern CSS
  `:has()` trick that avoids duplicating disabled classes.

### Text input

```jsx
"min-w-0 w-full bg-transparent px-3 py-1.5 text-sm outline-none
 placeholder:text-[var(--text-muted)] ${inputClassName}"
```

`text-sm` (14 px) for single-line inputs — one step *larger* than the surrounding 12 px
labels. The input is transparent; the frame supplies the visual surface.

### Textarea

```jsx
"flex rounded-xl border border-[var(--control-border)] bg-[var(--input)] ...
 focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)]
 has-[:disabled]:opacity-50"
"min-w-0 w-full bg-transparent px-3 py-2 text-xs outline-none ..."
```

Textarea is `text-xs` (12 px) — one step *smaller* than the text input, because it holds
multi-line prose. The sidebar's system-prompt textarea additionally passes
`inputClassName="resize-y leading-relaxed"`.

### Select (custom listbox, portal-rendered)

The native `<select>` is `sr-only` and `tabIndex={-1}`; a `<button>` acts as the
visible trigger, and the option list renders into a portal at
`fixed z-[9999] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-1 shadow-xl`.

- Trigger: `px-2.5 py-1 text-xs text-[var(--text-primary)]`.
- Option row: `rounded-lg px-2.5 py-1.5 my-0.5 text-xs`, hover/focus
  `bg-[var(--surface-hover)]`.
- Selected option label is `--text-primary`; unselected is `--text-muted`.
- A trailing `text-[11px]` badge shows the selected option's meta, `--accent` +
  `font-medium` when selected, `--text-muted` otherwise.
- Chevron rotates 180° with `transition-transform duration-200`.

### Checkbox (the sidebar's memory toggles)

```jsx
<label className="group flex w-full cursor-pointer items-start gap-3 rounded-xl
                   border border-[var(--border)] bg-[var(--surface)] px-3 py-3
                   transition-colors hover:bg-[var(--surface-hover)]
                   ${disabled ? "cursor-not-allowed opacity-50" : ""}">
  <input type="checkbox" className="peer sr-only" />
  <span aria-hidden="true"
    className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px]
               border border-[var(--control-border)] bg-[var(--input)] text-transparent
               transition-colors
               peer-checked:border-[var(--accent)] peer-checked:bg-[var(--accent)]
               peer-checked:text-[var(--on-accent)]
               peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
               peer-focus-visible:outline-[var(--accent)]">
    <LuCheck size={12} strokeWidth={3} />
  </span>
  <span className="min-w-0">
    <span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
    {hint && <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-muted)]">{hint}</span>}
  </span>
</label>
```

**This is the most distinctive control in the sidebar.** The checkbox is not a bare box —
it is a **whole card**: `rounded-xl` + `--border` + `--surface` + `px-3 py-3`, filling
its container. The native input is `sr-only` and a `peer`; the visible box is a 16 px
square with a **5 px radius** (`rounded-[5px]` — the only non-standard radius in the
system) and a 12 px `LuCheck` at `strokeWidth={3}`.

The pattern: **a control that carries its own label and hint inside a card shell.** The
`group`/`peer` combination gives hover and focus states without JS.

### Slider

`SliderField` is the most engineered primitive in the app:

- Track: `absolute inset-x-0 h-1.5 rounded-full overflow-hidden transition-[height] duration-200`
  with a two-stop gradient `linear-gradient(to right, var(--accent) X%, var(--active-chat) X%)`.
- Thumb: `absolute rounded-full bg-[var(--accent)] shadow-sm -translate-x-1/2
  transition-[width,height,box-shadow] duration-200 ease-out`, size `size-3` normally and
  `size-5 shadow-md` while active.
- The real `<input type="range">` is `absolute inset-0 opacity-0` — a transparent
  hit-target overlay with custom `[&::-webkit-slider-thumb]` styling.
- The label row is `flex items-center justify-between gap-2` with the value on the right
  in `font-normal tabular-nums` — **tabular numerals** so the number does not jitter
  while dragging.
- Height is `h-11` (44 px) — a generous vertical hit area for a 6 px track.
- The commit happens on `pointerup` / `keyup` / `blur` (an `onCommit` callback), not on
  every `change` — this is the "preview while dragging, commit on release" pattern.

---

## 7. Status, badges, and feedback

### Status dot

```js
const STATUS_DOT = {
  generating: "bg-[var(--accent)] animate-pulse",
  working: "bg-[var(--accent)] animate-pulse",
  awaiting_approval: "bg-amber-500",
  paused: "bg-amber-500",
  idle: "bg-[var(--text-muted)]",
};
```

A `size-2 shrink-0 rounded-full` dot. Active states pulse (`animate-pulse`); attention
states are amber; idle is muted. The dot sits in the card header row immediately before
the `text-xs font-semibold` title, so the card title *is* the status.

### Tool status colors

```js
const TOOL_STATUS_STYLE = {
  complete: "text-[var(--text-muted)]",
  error: "text-[var(--error)] font-medium",
  cancelled: "text-amber-500",
  running: "text-[var(--accent)]",
  pending: "text-[var(--text-secondary)]",
  preparing: "text-[var(--text-secondary)]",
  unknown: "text-[var(--text-muted)]",
};
```

Status is communicated by **text color alone** on a plain row — no badge, no pill. The
row is `flex min-w-0 items-center justify-between gap-2 text-[11px]`, with the left cell
`min-w-0 truncate font-mono` and the right cell `shrink-0`.

### Pills / badges

The availability badge is the sidebar's only pill:

```jsx
className={`shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5
            ${available ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`}
```

Full-pill geometry (`rounded-full` + `border`), small text (`text-xs` in the sidebar;
`text-[10px]` in `ContextPanel`'s `pillClass`).

### Inline status / notice rows

```jsx
<span role="status" className="flex items-center gap-1 text-[11px] text-[var(--accent)]">
  {isDirty && !notice && <span className="text-[var(--text-muted)]">Unsaved changes</span>}
  {notice && (<><LuCheck size={13} aria-hidden="true" />{notice}</>)}
</span>
```

Errors use `role="alert"` + `text-[var(--error)]`; informational notes use `role="note"`
+ `--text-muted`; warnings use `role="status"` + `text-amber-500`.

### The "two-click confirm" pattern

Destructive/overwriting actions invert their own label to request a second click:

```jsx
{confirmReset ? "Click again to confirm reset" : "Reset chat overrides"}
{confirmReapply ? "Click again to discard edits" : "Reapply preset"}
```

This is a distinctive, low-friction confirmation idiom: **no modal, no separate
confirm button** — the same button becomes the confirmation. Worth reusing.

### Empty states

Empty states are **one sentence of muted 11 px prose**, never an illustration, icon, or
placeholder box:

> "Tool calls will appear here as the agent works. Your approvals and questions are answered in the chat."

> "No subagents spawned in this chat yet."

> "Live run state is unavailable for this chat."

They are always `text-[11px] leading-relaxed text-[var(--text-muted)]` and always
explain *what will happen* rather than just stating absence. Loading states use the
same 11/12 px muted treatment inside a card, e.g. "Loading memory settings…".

### Icon + text note

```jsx
<p role="note" className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
  <LuInfo size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
  This assistant was removed from the library. …
</p>
```

13 px info icon, aligned to the first text line with `mt-0.5`, `shrink-0`, and the
text block allowed to wrap.

---

## 8. Spacing rhythm

| Context | Value |
| --- | --- |
| Card padding | `p-3` (12 px) |
| Panel padding (casual) | `px-4 py-5` |
| Panel padding (workspace) | `px-3 py-4` |
| Gap between cards (casual) | `space-y-4` (16 px) |
| Gap between cards (workspace) | `space-y-3` (12 px) |
| Card header → body | `mb-3` (primary), `mb-2`, `mb-1` |
| Label → control | `mb-1` |
| Control → hint | `mt-1.5` |
| Within-card body → footer | `mt-3` |
| Header title → subtitle | `mt-0.5` |
| List rows | `space-y-1.5` (6 px) |
| Icon → title | `gap-2` (8 px) |
| Header icon → title block | `gap-3` (12 px) |

The scale is essentially **4 / 6 / 8 / 12 / 16 px** with a deliberate gap between 6 and
8 (`space-y-1.5`) for dense lists and between 12 and 16 for card padding.

---

## 9. Color and elevation vocabulary

### Tokens the sidebar uses

| Token | Role | Light (`[data-theme="light"]`) | Dark (`[data-theme="dark"]`) | Lilac |
| --- | --- | --- | --- | --- |
| `--bg-secondary` | Panel background | `#f5f5f5` | `#141414` | `#ece0f7` |
| `--surface` | Card fill | `#fafafa` | `#1f1f1f` | `#ffffff` |
| `--surface-raised` | Popovers, menus | `#ffffff` | `#292929` | `#fcfaff` |
| `--surface-hover` | Hover fill | `#e5e5e5` | `#333333` | `#e9daf7` |
| `--border` | Card edge, divider | `#d4d4d4` | `#333333` | `#d8c2ea` |
| `--control-border` | Control frame edge | `#a3a3a3` | `#4a4a4a` | `#c9aee2` |
| `--subtle-border` | Quiet dividers | `#e5e5e5` | `#262626` | `#e8d7f7` |
| `--edit-border` | Control hover edge | `#9aa7c4` | `#6b7a99` | `#cbb9df` |
| `--input` | Control fill | `#f0f0f0` | `#242424` | (inherited) |
| `--active-chat` | Icon tile fill, slider track tail | `#dbe6fd` | `#26364f` | `#e2c5f8` |
| `--accent` | Icons, active tab, primary button, focus | `#2563eb` | `#5b9bff` | (theme accent) |
| `--accent-hover` | Primary button hover | `#1d4ed8` | `#86b5ff` | — |
| `--on-accent` | Text on accent fill | `#ffffff` | `#0a1426` | — |
| `--text-primary` | Titles, labels | `#111111` | `#ececec` | — |
| `--text-secondary` | Status text, inactive icons | `#404040` | `#c4c4c4` | — |
| `--text-muted` | Body, hints | `#6b6b6b` | `#8f8f8f` | — |
| `--error` | Error text | `#d92d3a` | `#ff6b6b` | — |
| `--window-shadow` | The one card shadow | `#00000033` | `#000000aa` | `#6d458326` |

### Elevation scale

| Level | Value | Used by |
| --- | --- | --- |
| 0 (none) | — | Panel background, flat list rows |
| 1 (hairline) | `border-[var(--border)]` | Cards, header divider, tab divider |
| 2 (card) | `shadow-[0_2px_4px_var(--window-shadow)]` | Sidebar cards only |
| 3 (control inset) | `border-[var(--control-border)]` + `--input` fill | Form controls |
| 4 (floating) | `shadow-xl` | Menus, modals, mobile drawer |
| 5 (transient) | `shadow-[0_8px_30px_var(--window-shadow)]` | Chat find bar, text selection menu |

**The sidebar lives at levels 0–2.** It uses exactly one shadow and one border weight.
It never uses a gradient, a glass/blur effect, or a colored glow.

### Theme coverage

`src/index.css` defines **22 distinct themes**: light, dark, mochi, mochi-dark, lilac,
lilac-dark, matcha, matcha-dark, ember, ember-dark, tokyo, tokyo-dark, gruvbox,
gruvbox-dark, solarized, solarized-dark, midnight-find, midnight-light, papaya,
papaya-dark, onyx, onyx-dark.

I verified programmatically (parsing each `[data-theme="…"] { … }` block) that
**every one of the 22 defines all nine tokens the sidebar depends on** — `--active-chat`,
`--surface`, `--surface-raised`, `--window-shadow`, `--bg-secondary`, `--border`,
`--control-border`, `--text-muted`, and `--accent`. The only theme block that omits
them is the `:root` / light default, which defines all nine as well.

One redundancy: the `matcha` block declares `--bg-secondary` **twice** — first
`#dedebd` (a yellow-green) and then `#dfefe1` (a green). The second wins by cascade
order, so matcha panels render green, but the first declaration is dead and should be
removed.

The sidebar is therefore fully themeable: swap the `data-theme` attribute and every
surface, border, icon, and shadow retints.

### Fixed colors that do NOT theme

Two hard-coded Tailwind colors appear in the sidebar:

- `text-amber-500` — 3 occurrences. Used for `awaiting_approval`, `paused`,
  `cancelled`, pending approvals/questions, and run-paused notices.
- `bg-amber-500` — 2 occurrences: the status dot for the same states.

`amber-500` is **not** in the token vocabulary, so it does not adapt to light/dark or to
any of the 22 palettes. It is the one genuine inconsistency in the color system. If
the sidebar's language is extended, this is the first thing to fix — add
`--warning` / `--warning-soft` tokens and replace it.

---

## 10. Interaction and motion

| Interaction | Motion |
| --- | --- |
| Panel open/close | `translate` + `opacity`, 300 ms, `ease-in-out` |
| Column width change | Instant (`w-80` ↔ `w-0`) — deliberately not animated |
| Tab underline | `transition-colors` |
| Button hover | `transition-colors` |
| Close button | `duration-300` (matches panel) |
| Slider thumb | `transition-[width,height,box-shadow] duration-200 ease-out` |
| Slider track | `transition-[height] duration-200` |
| Status dot | `animate-pulse` |
| Chevron | `transition-transform duration-200` |

Principles visible here:

1. **Two speed families: 200 ms (component-level) and 300 ms (surface-level).**
2. **Only `transform` and `opacity` are animated** on the panel — the layout is never
   animated, for performance.
3. **`motion-reduce:transition-none`** is applied to the panel (and to the Tooltip).
4. Hover transitions are `transition-colors` only — no transforms, no shadows.

---

## 11. Accessibility contract

The sidebar is unusually disciplined here, and this is part of the design language:

- `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-controls`,
  `aria-labelledby`, `aria-selected`, and a roving `tabIndex`.
- Arrow-key tab navigation via `getNextTabIndex`; `Home`/`End` supported.
- Every icon that is decorative carries `aria-hidden="true"`.
- Status text uses `role="status"` (polite), errors use `role="alert"` (assertive),
  hints use `role="note"`.
- All hints are programmatically linked with `aria-describedby={`${id}-hint`}`.
- Buttons have `aria-label` when the visible content is an icon (close button, "Use
  model default").
- The closed panel is `aria-hidden` **and** `inert` — it is not keyboard-reachable.
- Focus rings are never removed: every interactive element carries
  `focus-visible:outline-2 focus-visible:outline-[var(--accent)]`.
- `title` attributes on icon-only tabs (though `aria-label` already covers it).
- The primary button is `type="submit"` inside a `<form>`; destructive actions are
  `type="button"`.

---

## 12. How this differs from the rest of the app

I verified the adoption counts directly across `src/`.

### The card recipe is nearly exclusive to the sidebar

Files containing `shadow-[0_2px_4px_var(--window-shadow)]`:

| File | Occurrences |
| --- | --- |
| `src/components/RightSidebar.jsx` | 15 |
| `src/components/ChatHistory.jsx` | 4 |
| `src/components/ContextPanel.jsx` | 1 |
| `src/components/chat/RecoveryCard.jsx` | 1 |
| `src/components/chat/WorkspacePlanCard.jsx` | 1 |
| `src/components/chat/ToolEventCard.jsx` | 3 *(code blocks, different recipe)* |

`src/components/settings/` — **the app's largest UI surface, 10+ files** — contains
**zero** occurrences of the card shadow. It uses:

```jsx
"mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
```

Same border, same surface, same radius — but **`p-4` instead of `p-3`, and no shadow.**
It also uses `mb-5` for vertical rhythm instead of a `space-y-*` stack, and `h4` with
`font-semibold` (no size class, so it inherits) instead of `h3 text-xs font-semibold`.

**This is the single most important finding for reuse:** the right sidebar and the
Settings panels are two different generations of the same card, and the sidebar is the
newer, denser one.

### Other divergences

| Concern | Right sidebar | Settings panels |
| --- | --- | --- |
| Card padding | `p-3` | `p-4` |
| Card shadow | `0 2px 4px --window-shadow` | none |
| Card title | `h3 text-xs font-semibold` | `h4 font-semibold` |
| Card title icon | 16 px Lucide in `--accent` | none |
| Card spacing | `space-y-3/4` in a `space-y` panel | `mb-5` per section |
| Section header | icon + title + optional body | title + body |
| Empty state | one muted 11 px sentence | varies |

Other app-wide shadow scales that the sidebar does **not** use:
`shadow-[0_4px_20px_var(--window-shadow)]` (`main-app/ChatInterface.jsx`),
`shadow-[0_8px_30px_var(--window-shadow)]` (`chat/ChatFindBar.jsx`),
`shadow-[0_8px_32px_var(--window-shadow)]` (`App.jsx`),
`shadow-[0_2px_30px_var(--window-shadow)]` (`main-app/Header.jsx`).

### What IS shared

- `FormControls.jsx` — label, hint, field frame, checkbox, slider, select, pill toggle.
  Used by the sidebar, the settings panels, `ChatTuning`, and `SubagentModelSelect`.
- `ContextPanel.jsx` — imports the sidebar's exact `cardClass` string.
- `RecoveryCard`, `WorkspacePlanCard` — use the sidebar's exact card class.
- `Tooltip.jsx` — `rounded-lg` + `--border` + `--surface-raised` + `shadow-xl`.
- `ChatTuning.jsx` and `SubagentModelSelect.jsx` are rendered *inside* sidebar cards
  and are the same components used in Settings → General.
- Global scrollbar styling: 4 px, `border-radius: 9999px`, `--scrollbar-thumb` /
  `--scrollbar-track`, thumb hover → `--accent-hover`, thumb active → `--accent`.

---

## 13. The design language, stated as rules

If you are going to apply this language elsewhere, these are the rules, in priority
order.

**Foundation**
1. Cards are `rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3
   shadow-[0_2px_4px_var(--window-shadow)]`. One border weight, one shadow, one radius.
2. The panel behind the cards is `--bg-secondary`; the cards are `--surface` and are
   therefore *lighter* than their background.
3. Every color is a CSS custom property. No hard-coded hex in JSX. The only exception
   today is `amber-500` — which should be tokenized.

**Structure**
4. One card = one topic. A card has an optional icon+title header, optional lead
   paragraph, optional content, optional footer row.
5. The section header is always: 16 px Lucide icon in `--accent` + `text-xs
   font-semibold` title, in a `flex items-center gap-2` row. Icons are `aria-hidden`.
6. Cards stack with `space-y-3` (dense) or `space-y-4` (comfortable) in a
   `min-h-0 flex-1 overflow-y-auto` panel.

**Typography**
7. Three sizes only: `text-sm` (panel title), `text-xs` (section titles, labels,
   lead paragraphs), `text-[11px]` (body, hints, list rows, status). `text-[10px]`
   for micro-badges only.
8. Hierarchy comes from **weight and color**, not size. Titles are `font-semibold`;
   body is regular and `--text-muted`.
9. No uppercase, no letter-spacing, no eyebrows.
10. `text-[11px]` prose always carries `leading-relaxed`.

**Controls**
11. Form labels: `text-xs font-semibold text-[var(--text-primary)]`, `mb-1`.
    Hints: `text-[11px] leading-relaxed text-[var(--text-muted)]`, `mt-1.5`, linked via
    `aria-describedby`.
12. Control frames: `rounded-xl border border-[var(--control-border)] bg-[var(--input)]`,
    focus = accent border + 1 px accent ring, hover = `--edit-border` + `--surface-hover`.
13. Buttons: primary = `rounded-xl bg-[var(--accent)] text-[var(--on-accent)] text-xs
    font-semibold px-3 py-2`; secondary = `rounded-lg border border-[var(--border)]
    bg-[var(--bg-secondary)] text-[11px] font-medium px-2.5 py-1.5`; ghost = `size-7
    rounded-lg` with `--surface-hover`.
14. **One primary button per view.**
15. Checkboxes are cards (`rounded-xl border bg-[var(--surface)] px-3 py-3`) with a
    16 px `rounded-[5px]` peer box, not bare boxes.
16. Sliders: custom track + thumb, `tabular-nums` value, commit on release, not on
    every change.

**Feedback**
17. Status is color + text, never color alone. `role="status"` for polite,
    `role="alert"` for errors.
18. Empty states are one sentence of 11 px muted prose that says what *will* appear.
19. Destructive/overwrite actions confirm by **relabeling the same button** for a second
    click — no modal.
20. `disabled` is `cursor-not-allowed opacity-40`; disabled control frames dim via
    `has-[...]:opacity-50`.

**Motion**
21. 200 ms for components, 300 ms for surfaces. Animate only `transform` and `opacity`
    on the surface. Always ship `motion-reduce:transition-none`.

**Accessibility**
22. Every interactive element has an accent `focus-visible:outline-2` ring.
23. Every decorative icon is `aria-hidden="true"`; every icon-only control has an
    `aria-label`.
24. Tabs use the full ARIA tabs pattern with roving tabindex.
25. Closed overlays are `aria-hidden` + `inert`.

---

## 14. Known inconsistencies to resolve before reuse

1. **`amber-500` is not tokenized** (5 uses total in the sidebar: 3 `text-` + 2 `bg-`).
   Add `--warning` / `--warning-soft` tokens and replace it app-wide.
2. **Two disabled idioms** — `opacity-50` (the shared `secondaryButton` constant) vs
   `cursor-not-allowed opacity-40` (everything else). Standardize on the latter.
3. **Two secondary-button variants** — the `secondaryButton` constant uses `text-[11px]`
   and `disabled:opacity-50`; the inline copies use `text-xs` and
   `disabled:cursor-not-allowed disabled:opacity-40`. Same intent, two strings.
4. **Card padding drift** — `p-3` (sidebar) vs `p-4` (settings). Pick one.
5. **Header/tab/panel horizontal insets** — `px-4` / `px-3` / `px-4`. Pick one.
6. **No shared constant module** — the card class is duplicated as a literal string 15
   times in `RightSidebar.jsx` and again in `ContextPanel.jsx`. Extracting it (and the
   header/body/pill classes) into a shared module is the highest-value refactor before
   propagating the language.
7. **`focus-visible:outline-offset-2` on the primary button only** — all other focus
   rings are flush. Standardize.
8. **`rounded-[5px]`** on the checkbox is the only non-standard radius in the system.
   It is a deliberate softening of a 4 px square; worth documenting rather than
   "fixing".
9. **The `matcha` theme declares `--bg-secondary` twice** (`#dedebd` then `#dfefe1`) —
   the first is dead code.

---

## 15. Copy-paste reference

Every snippet below is transcribed verbatim from the source.

```jsx
// Card
<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">

// Card title row with accent icon
<div className="mb-3 flex items-center gap-2">
  <Icon size={16} className="text-[var(--accent)]" aria-hidden="true" />
  <h3 className="text-xs font-semibold">Title</h3>
</div>

// Body copy
<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">…</p>

// Dense status row
<li className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
  <span className="min-w-0 truncate font-mono">tool_name</span>
  <span className="shrink-0 text-[var(--text-muted)]">complete</span>
</li>

// Primary button
<button className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40">

// Secondary button
<button className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40">

// Status dot
<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse" />

// Availability pill
<span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--accent)]">Available</span>

// Icon-only button
<button className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300">

// Form label + hint
<label className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Label</label>
<p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">Hint</p>

// Control frame
<div className="flex min-h-8 items-center rounded-xl border border-[var(--control-border)] bg-[var(--input)] text-[var(--text-primary)] transition-colors hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)] focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)] has-[input:disabled]:opacity-50">

// Card-shaped checkbox
<label className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--surface-hover)]">
  <input type="checkbox" className="peer sr-only" />
  <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] border border-[var(--control-border)] bg-[var(--input)] text-transparent transition-colors peer-checked:border-[var(--accent)] peer-checked:bg-[var(--accent)] peer-checked:text-[var(--on-accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)]" />
</label>

// Icon-only tab
<button role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
  className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center border-b-2 px-1 py-3 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
  <Icon size={17} className="shrink-0" />
</button>
```

---

## 16. Recommended adoption path

**Phase 1 — extract, change nothing.** Create `src/components/ui/` (or a
`designTokens.js` + `surfaceClasses.js`) exporting:
`cardClass`, `cardHeaderClass`, `cardTitleClass`, `bodyClass`, `hintClass`,
`labelClass`, `primaryButtonClass`, `secondaryButtonClass`, `ghostButtonClass`,
`pillClass`, `statusDotClass`, `emptyStateClass`.

**Phase 2 — adopt in the right sidebar.** Replace the 15 literals in
`RightSidebar.jsx` and the 4 in `ChatHistory.jsx`. Zero visual change; this is a
pure refactor and can be verified with a screenshot diff.

**Phase 3 — adopt in settings.** Decide `p-3` vs `p-4` first. If the sidebar's density
wins, update `src/components/settings/*` (14 files) to the shared card class and add
the accent icon to section headers. This is the biggest visible change and should be
done panel by panel.

**Phase 4 — tokenize the remainder.** Replace `amber-500` with `--warning` across the
12 files that use it. Normalize the disabled and focus-ring idioms.

**Phase 5 — codify.** Add a small lint/test that fails when a new card is added
without the shared class, and a visual-regression snapshot of one representative
sidebar panel.

---

## 17. Source index

| File | Lines | What it contributed |
| --- | --- | --- |
| `src/components/RightSidebar.jsx` | 986 | Shell, header, tab bar, all 15 cards, buttons, badges, empty states |
| `src/components/FormControls.jsx` | ~600 | `fieldFrame`, `FieldShell`, `CheckboxField`, `SelectField`, `TextAreaField`, `SliderField`, `PillToggle` |
| `src/components/ChatTuning.jsx` | ~185 | Sampling sliders/number fields, status rows, reset button |
| `src/components/ContextPanel.jsx` | ~37 KB | `cardClass` / `headingClass` / `bodyClass` / `pillClass` constants — the same card recipe as a named constant |
| `src/components/SubagentModelSelect.jsx` | 3481 B | Shared select, used both in the sidebar and Settings → General |
| `src/components/Tooltip.jsx` | 166 | `rounded-lg` + `--surface-raised` + `shadow-xl` floating surface |
| `src/components/chat/RecoveryCard.jsx` | 75 | Card reuse + status dot |
| `src/components/chat/WorkspacePlanCard.jsx` | 148 | Card reuse as `<section>` with `aria-labelledby` |
| `src/components/chat/BackgroundCommandCard.jsx` | 24 | Card reuse **without** the shadow — a counter-example |
| `src/index.css` | 1578 | 22 theme blocks, `@theme` font tokens, global scrollbar |
| `src/components/main-app/Header.jsx` | 199-203 | The `FaSlidersH` toggle that opens the sidebar |

---

*Analysis only. No source files were modified to produce this report.*
