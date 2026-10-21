# Right Sidebar — Design Language Report

**Scope:** The right-hand "Chat controls / Workspace controls" panel (`src/components/RightSidebar.jsx`, 986 lines) plus the shared building blocks it relies on: `FormControls.jsx` (TextField / SelectField / CheckboxField / TextAreaField / SliderField), the chat cards (`WorkspacePlanCard`, `RecoveryCard`, `BackgroundCommandCard`), and the global theme tokens in `src/index.css`.

**Purpose:** This document distills the sidebar's visual system into reusable rules so other parts of the app can adopt the same design language. No code was modified while producing this report.

---

## 1. Overall character

The right sidebar is a **dense, card-based control surface**: quiet neutral chrome, one accent color doing all the "alive" work, and information expressed at very small type sizes with tight vertical rhythm. It reads as an instrument panel rather than a marketing page — every element earns its place, status is conveyed through tiny dots and muted text, and hierarchy comes from weight/size contrast (12px semibold headings vs 11px muted body) rather than color or decoration.

Key traits:
- **Token-driven theming** — zero hard-coded colors in the component; everything references CSS custom properties on `[data-theme="…"]`.
- **Card-as-unit** — every logical block is a bordered, rounded, softly-shadowed card with identical internal padding.
- **Accent = state + action** — the single accent color marks active tabs, icons, focus rings, running status, and primary buttons; everything else stays neutral.
- **Restraint in motion** — only two motions exist (panel slide-in, pulsing status dots); all other feedback is instant `transition-colors`.

---

## 2. Theme token system (`src/index.css`)

The app ships ~20 themes (light, dark [default], mochi/mochi-dark, lilac/lilac-dark, matcha/matcha-dark, ember/ember-dark, tokyo/tokyo-dark, gruvbox/gruvbox-dark, solarized/solarized-dark, midnight-find/midnight-light, papaya/papaya-dark, onyx/onyx-dark). Each theme redefines the same ~30 custom properties. The sidebar only ever uses this subset:

| Token | Role in the sidebar | Dark example | Light example |
|---|---|---|---|
| `--bg-secondary` | Panel background (darker than main surface) | `#141414` | `#f5f5f5` |
| `--surface` | Card backgrounds | `#1f1f1f` | `#fafafa` |
| `--surface-raised` | Popover/dropdown surfaces (select menus) | `#292929` | `#ffffff` |
| `--surface-hover` | Hover fill for buttons, tabs, list rows | `#333333` | `#e5e5e5` |
| `--bg-tertiary` / `--input` | Input field backgrounds (`--input`) | `#242424` | `#f0f0f0` |
| `--border` | Card borders, dividers, tab bar underline track | `#333333` | `#d4d4d4` |
| `--control-border` | Input field resting border (slightly stronger than card border) | `#4a4a4a` | — |
| `--edit-border` | Input hover border | `#6b7a99` | — |
| `--text-primary` | Headings, labels, primary values | `#ececec` | `#111111` |
| `--text-secondary` | Secondary body text, inactive tab icons | `#c4c4c4` | `#404040` |
| `--text-muted` | Hints, captions, empty states, idle dots | `#8f8f8f` | `#6b6b6b` |
| `--accent` | Active tab, icons, focus rings, primary button bg, running status | `#5b9bff` (dark) / ember theme: `#efa26f` | `#2563eb` |
| `--accent-hover` | Primary button hover | `#86b5ff` | `#1d4ed8` |
| `--on-accent` | Text on accent surfaces (dark themes use a *dark* ink, e.g. `#0a1426`) | theme-dependent | `#ffffff` |
| `--active-chat` | Header icon tile background (tinted blue) | `#26364f` | — |
| `--window-shadow` | Card shadow color (`#000000aa` dark / `#00000033` light) | theme-dependent | theme-dependent |
| `--error` | Error status text (e.g. failed tool calls) | `#ff6b6b` | — |

**Rule for reuse:** never hard-code a hex value in a component; reference these tokens so the new surface automatically supports all themes and both dark/light variants. The only literal color used anywhere in the sidebar is **amber-500** (`text-amber-500`, status dots) as a semantic "needs attention / paused" warning hue, paired with `--error` for failures.

---

## 3. Panel structure & layout

### 3.1 Container
```
aside (spacer): relative z-30 h-full shrink-0; width animates w-80 ↔ w-0
inner panel: absolute inset-y-0 right-0, flex h-full w-80 (320px) flex-col overflow-hidden
  border-l border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)]
```
- Fixed width **`w-80` = 320px**; the outer `aside` is a layout spacer that owns the transcript reflow, while the inner panel is absolutely positioned so it can slide without jacking the DOM.
- Closed state: `translate-x-full opacity-0`; open: `translate-x-0 opacity-100`, with `transition-[translate,opacity] duration-300 ease-in-out` and `motion-reduce:transition-none`.
- The panel is marked `inert=""` when closed (accessibility: not focusable).
- **Responsive:** below 900px the whole thing becomes an overlay (`max-[900px]:absolute … z-40`) with `shadow-xl` to lift it off the content.

### 3.2 Vertical anatomy (top → bottom)
1. **Header** — `border-b border-[var(--border)] bg-[var(--surface)] px-4 py-4`: icon tile + title/subtitle on the left, close button on the right.
2. **Reset block** (casual chats only) — a full-width card with a secondary "Reset chat overrides" button and an 11px muted hint; two-click confirm pattern ("Click again to confirm reset").
3. **Tab bar** — `mt-3 … border-b bg-[var(--surface)] px-3 pt-2`, equal-width icon tabs (see §5).
4. **Scrolling panel body** — the only scrollable region:
   - workspace mode: `min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4`
   - casual mode: same but `space-y-4 … px-4 py-5` (slightly airier for fewer, larger cards).

### 3.3 Header details
- **Icon tile:** `size-9 rounded-xl bg-[var(--active-chat)] text-[var(--accent)]`, containing a 18px Lucide icon (`LuSettings2` casual / `LuActivity` workspace). This is the sidebar's one "brand" moment — a tinted square with an accent glyph.
- **Title:** `text-sm font-semibold truncate` ("Chat controls" / "Workspace controls").
- **Subtitle:** `mt-0.5 text-[11px] text-[var(--text-muted)]`, e.g. `llm desktop assistant · Using Model Defaults` — project name and override state in one line, truncated.
- **Close button:** `size-7 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] active:translate-y-0.5 focus-visible:outline-2 outline-[var(--accent)]`, 17px `LuX`. Note the tactile press feedback (`active:translate-y-0.5`).

---

## 4. The card — atomic unit of the design language

Every block in every tab is this exact recipe (appears ~15× in the sidebar and identically in the chat cards):

```
rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]
```

| Property | Value | Notes |
|---|---|---|
| Radius | `rounded-xl` (12px) | Cards, primary buttons, inputs, dropdown menus all share this radius; small controls use `rounded-lg` (8px); pills/badges use `rounded-full`; checkboxes use a bespoke `rounded-[5px]`. |
| Border | 1px solid `--border` | One hairline, never double borders or outlines. |
| Fill | `--surface` | Sits slightly above the panel's `--bg-secondary`, so cards "float" without heavy shadow. |
| Padding | `p-3` (12px) uniform | Identical on all four sides — no asymmetric card padding anywhere in this system. |
| Shadow | `0 2px 4px var(--window-shadow)` | Very soft, theme-tinted; the elevation cue is subtle by design. |

### Card anatomy pattern
```
[icon (16px, accent)] [h3: text-xs font-semibold]        ← header row, gap-2, mb-2/mb-3
body paragraphs: text-[11px] leading-relaxed text-[var(--text-muted)]   (or --text-secondary)
lists: space-y-1.5 or space-y-2; rows are flex justify-between text-[11px]
footer actions row: mt-2/mt-3, flex items-center gap-2
```
- **Card title:** always `text-xs font-semibold` (12px), plain primary color — no uppercase, no letter-spacing.
- **Optional accent icon** before the title (`size={16}`, `text-[var(--accent)]`) when the card represents a capability (Active agent, System prompt, Sampling scope, Memory & Context). Cards that are pure status readouts (Recent tool activity, Workspace Recovery) often omit it or use a status dot instead.
- **Body copy:** 11px (`text-[11px]`), `leading-relaxed`, muted color. This is the workhorse size of the sidebar — most text in the panel is 10–11px.
- **Inline lists** (tool activity, running subagents): rows are `flex min-w-0 items-center justify-between gap-2 text-[11px]` with a truncating left label (`min-w-0 truncate`, mono for tool names) and a right-aligned status word colored by state (§7).
- **Status dot** pattern: `size-2 rounded-full` + color class, placed in the header row before the title (Activity card, RecoveryCard, plan steps).

---

## 5. Tab bar

```
role="tablist": mt-3 flex shrink-0 gap-1 overflow-hidden border-b bg-[var(--surface)] px-3 pt-2
each tab: flex min-w-0 flex-1 items-center justify-center border-b-2 px-1 py-3 transition-colors
  active:   border-[var(--accent)] text-[var(--accent)]
  inactive: border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]
```
- Tabs are **icon-only** (17px Lucide icons), equal-width (`flex-1`), no labels visible — `aria-label`/`title` carry the name. Casual mode has 3 tabs (Persona, Generation, Memory); workspace mode has 4 (Activity, Agents, Context, Controls).
- Selection indicator is a **2px bottom border in accent** riding on the tab bar's own 1px `--border` underline track — no pill background, no fill.
- Full keyboard support: arrow keys/Home/End move between tabs (`getNextTabIndex`), roving `tabIndex`, focus-visible outline in accent.

---

## 6. Buttons & controls

### 6.1 Primary button (accent)
```
inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold
text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)]
focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]
disabled:cursor-not-allowed disabled:opacity-40
```
Used for "Save prompt". Icon (14px) + label, 12px semibold.

### 6.2 Secondary button (the workhorse) — two size variants share one recipe
```
rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5
text-[11px] or text-xs font-medium transition-colors hover:bg-[var(--surface-hover)]
focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40/50 cursor-not-allowed
```
Full-width variant adds `w-full` (Reset block, RecoveryCard actions); inline variant is used for "Reapply preset", "Use model default". The fill is the *panel* background (`--bg-secondary`), making secondary buttons read as recessed relative to cards.

### 6.3 Icon-only button
```
flex size-7 items-center justify-center rounded-lg text-[var(--text-secondary)]
hover:bg-[var(--surface-hover)] active:translate-y-0.5 focus-visible:outline-2 outline-[var(--accent)]
```

### 6.4 Form fields (`FormControls.jsx`) — shared with the rest of the app
- **Field frame** (inputs/selects/textareas): `rounded-xl border border-[var(--control-border)] bg-[var(--input)] transition-colors hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)] focus-within:border-[var(--accent)] focus-within:ring-1 ring-[var(--accent)]`, disabled → `opacity-50`.
- **Labels:** `mb-1 text-xs font-semibold text-primary`; required marker is an accent `*`.
- **Hints:** `mt-1.5 text-[11px] leading-relaxed text-muted` — often with a 13px `LuInfo` icon for callout-style hints inside cards.
- **CheckboxField** is itself card-like: the whole label is a `rounded-xl border bg-surface px-3 py-3 hover:bg-surface-hover` row containing a custom 16px checkbox (`size-4 rounded-[5px]`, unchecked = input fill + control border; checked = accent fill with 12px check in `--on-accent`) plus label (12px medium) and hint (11px muted).
- **SelectField** is a custom listbox: trigger styled like the field frame with a 14px chevron that rotates 180° (`transition-transform duration-200`); menu is a portal — `rounded-xl border bg-[var(--surface-raised)] p-1 shadow-xl`, max-height 288px, items are `rounded-lg px-2.5 py-1.5 text-xs hover:bg-surface-hover my-0.5`; selected item gets `bg-surface-hover font-medium` + accent check icon; optional right-aligned description in 11px (accent when selected).
- **SliderField** is fully custom: a 44px-tall hit area with a visual track (`h-1.5 rounded-full`, fill = accent, transitions width/height) and an accent thumb that scales on hover/press; value label right-aligned in `tabular-nums`.

### 6.5 Status pills
Small read-only badges: `rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px]`, colored by meaning — accent when available/active, muted when not (e.g. "Available" / "Unavailable" on subagent capabilities).

---

## 7. Status & state vocabulary

| State | Visual |
|---|---|
| generating / working | `size-2` dot, `bg-[var(--accent)] animate-pulse` |
| awaiting approval / paused | dot or text in **amber-500** (`text-amber-500 font-medium`) — the only literal hue; always paired with a short imperative line ("Run paused — respond in the chat to continue.") |
| idle / unknown | dot `bg-[var(--text-muted)]`, text muted |
| running (tool/subagent) | status word `text-[var(--accent)]` |
| complete / done | `text-[var(--text-muted)]` |
| pending / preparing | `text-[var(--text-secondary)]` |
| error / failed | `text-[var(--error)] font-medium` |
| cancelled | amber-500 |

Rules: status is **always** a 2px dot or an 11px word — never large banners; counts are inlined with middle dots (`3 tool calls · 1 running · 2 done · 0 failed`); `role="status"` / `role="alert"` attributes accompany the text.

---

## 8. Typography

- **Families:** Inter Variable for all UI prose; JetBrains Mono Variable only for machine identifiers (tool names in activity lists). CJK falls back to Noto Sans CJK JP.
- **Scale used by the sidebar** (deliberately compressed):
  - `text-sm` (14px) semibold — panel title, field labels are 12px so this is the max size in the panel.
  - `text-xs` (12px) semibold/medium — card titles, button labels, list row labels.
  - `text-[11px]` — body copy, hints, status lines, pills. The dominant size.
  - `text-[10px]` — plan-step sub-labels and the smallest captions (WorkspacePlanCard).
- **Weights:** only regular / medium / semibold are used; no bold, no italic (except line-through for completed plan steps).
- **Line height:** body copy is always `leading-relaxed`; tight labels have default leading.
- **Truncation discipline:** every potentially long string gets `min-w-0 truncate` (titles, model names, tool names); multi-line hints are allowed to wrap freely.

---

## 9. Spacing system

All spacing comes from the Tailwind scale; no arbitrary values except shadows:

| Context | Value |
|---|---|
| Card padding | `p-3` (12px) everywhere |
| Card-to-card gap in panel body | `space-y-3` workspace / `space-y-4` casual |
| Panel horizontal gutters | `px-3` workspace / `px-4` casual; vertical `py-4`/`py-5` |
| Header padding | `px-4 py-4`; icon-to-title gap `gap-3`; title→subtitle `mt-0.5` |
| Tab bar top margin | `mt-3`; tab internal `px-1 py-3`, inter-tab `gap-1` |
| Inside cards: header→body | `mb-2`/`mb-3`; between stacked elements `mt-2`/`mt-3`; icon gaps `gap-1.5`–`gap-2` |
| Lists | `space-y-1.5` (dense rows) or `space-y-2` (richer rows); row internal gap `gap-2` |

The system is **4px-based with 8/12 as the structural steps** — consistent enough that a new surface can match by eye.

---

## 10. Motion & interaction feedback

Only three motion patterns exist in the whole sidebar:
1. **Panel slide:** translate + opacity, `duration-300 ease-in-out`, disabled under `motion-reduce`.
2. **Pulse** on active status dots (`animate-pulse`).
3. **Color transitions** everywhere else — buttons, tabs, fields use bare `transition-colors` (150ms default); the select chevron uses a 200ms rotate; slider fill/thumb use 200ms width/height/shadow easing; plan progress bar animates width over 300ms.

Feedback conventions:
- **Hover** = background shift to `--surface-hover` (never color shifts on text except tabs, which go secondary→primary).
- **Press** = `active:translate-y-0.5` on icon buttons (1px tactile dip).
- **Focus** = always a 2px accent outline (`focus-visible:outline-2 focus-visible:outline-[var(--accent)]`, with offset 2 on primary button); inputs instead show border+ring in accent via `focus-within`.
- **Disabled** = `opacity-40`/`50` + `cursor-not-allowed`; busy states swap labels ("Saving…", "Loading memory settings…") rather than adding spinners.

---

## 11. Accessibility baked into the pattern

- Real ARIA tablist/tab/tabpanel wiring with roving tabindex and arrow-key navigation; panels use `hidden` when inactive (not just CSS).
- Closed sidebar is `inert`; status text uses `role="status"`/`role="alert"`.
- All icons are decorative (`aria-hidden`) with adjacent real labels; icon-only buttons carry `aria-label`.
- Form fields wire `htmlFor`, `aria-describedby` hints, and focus returns to triggers after select interactions.

---

## 12. Reuse checklist (apply when building another surface)

1. **Background layering:** page/panel = `--bg-secondary`; cards = `--surface`; popovers/menus = `--surface-raised`; inputs = `--input`. Never invert this order.
2. **Card recipe** (§4) verbatim: `rounded-xl border-[var(--border)] bg-surface p-3 shadow-[0_2px_4px_var(--window-shadow)]`, 12px semibold title, 11px muted body, 8/12px internal gaps.
3. **One accent:** use `--accent` only for active states, icons, focus, running status, and the single primary action per view; everything else neutral (primary/secondary/muted text).
4. **Semantic literals allowed:** amber-500 = needs attention/paused/cancelled; `--error` = failure. Nothing else hard-coded.
5. **Buttons:** secondary = recessed (`bg-bg-secondary`, 8px radius, 11–12px medium); primary = accent fill (12px radius, 12px semibold); icon buttons 28px square with press dip.
6. **Status vocabulary** (§7): 2px dots + 11px words; counts inlined with `·`.
7. **Type scale:** 14/12/11/10 px, Inter, semibold for titles only, `leading-relaxed` on body, `truncate` on anything that can be long, mono only for identifiers.
8. **Motion budget:** slide-in for panels (300ms ease-in-out), pulse for live dots, color transitions otherwise; honor `motion-reduce`.
9. **Focus rings:** 2px accent outline everywhere; inputs use border+ring on focus-within.
10. **Theming:** reference tokens only — the surface must work unchanged under all ~20 themes (dark default + light variants).

### Canonical class snippets (copy-paste ready)

```html
<!-- Card -->
<div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">…</div>

<!-- Card title row with accent icon -->
<div class="mb-3 flex items-center gap-2">
  <Icon size={16} class="text-[var(--accent)]" />
  <h3 class="text-xs font-semibold">Title</h3>
</div>

<!-- Body copy / hint -->
<p class="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">…</p>

<!-- Dense status row -->
<li class="flex min-w-0 items-center justify-between gap-2 text-[11px]">
  <span class="min-w-0 truncate font-mono">tool_name</span>
  <span class="shrink-0 text-[var(--text-muted)]">complete</span>
</li>

<!-- Secondary button -->
<button class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40">…</button>

<!-- Primary button -->
<button class="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-40">…</button>

<!-- Status dot -->
<span class="size-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse"></span>
```

---

## 13. Sources examined

| File | What it contributed |
|---|---|
| `src/components/RightSidebar.jsx` (986 lines) | Panel structure, header, tabs, all card blocks, status vocabulary, reset block |
| `src/components/FormControls.jsx` | Field frame, checkbox, custom select listbox, slider — the form layer of the language |
| `src/components/chat/WorkspacePlanCard.jsx`, `RecoveryCard.jsx`, `BackgroundCommandCard.jsx` | Card recipe reuse outside the sidebar; status dots, progress bar, pills |
| `src/index.css` (1578 lines) | All theme tokens (~20 themes), fonts, scrollbar styling (`scrollbar-width: thin`, themed track/thumb) |
| `src/context/UIStateContext.jsx` | Theme applied via `[data-theme]` on `<html>`, persisted to localStorage |

*Report generated from static analysis plus a live screenshot of the workspace-mode sidebar (ember-dark theme).*
