# Neumorphism Design System - Complete Reference

This document captures the **exact neumorphism implementation** from the `aero-skeu-exp` project. Use this as a reference for implementing consistent neumorphism in other projects.

---

## 🎯 Core Philosophy

> **Neumorphism = "New Skeuomorphism"**
> Soft, extruded UI elements that appear to be made from the same material as the background. Everything shares **one surface color** with depth created purely through **dual-tone shadows** (highlight + shadow).

### Key Principles
1. **Single Surface Color** — Background, cards, buttons, inputs all use the same base color
2. **No Borders** — Elements use `border: 1px solid transparent` (allows focus rings without visible borders)
3. **Dual Shadow System** — Every raised element has both a dark shadow (bottom-right) and light highlight (top-left)
4. **Consistent Light Source** — Top-left highlight, bottom-right shadow (simulates light from top-left)
5. **Monochromatic + One Accent** — Neutral surface with a single accent color (gold `#a5b8ff` here)
6. **Soft Transitions** — 150-200ms transitions for hover/active states

---

## 🎨 Color System

### Dark Mode (Default)
```css
:root[data-style='neumorphism'] {
  /* Semantic colors */
  --ink: #e6ebf3;           /* Primary text */
  --muted: #adb9cb;         /* Secondary text, placeholders */
  --gold: #a5b8ff;          /* Accent - primary actions, focus, active states */

  /* Neumorphism surface & shadows */
  --neu-surface: #292f3a;   /* THE single surface color - used EVERYWHERE */
  --neu-shadow: #1b1f27;    /* Dark shadow (bottom-right) - slightly darker than surface */
  --neu-highlight: #373f4d; /* Light highlight (top-left) - slightly lighter than surface */

  /* Composite shadows */
  --neu-raised: 6px 6px 14px var(--neu-shadow), -6px -6px 14px var(--neu-highlight);
  --neu-inset: inset 4px 4px 9px var(--neu-shadow), inset -4px -4px 9px var(--neu-highlight);
}
```

### Light Mode
```css
[data-style='neumorphism'][data-theme='light'] {
  --ink: #29364c;
  --muted: #54637a;
  --gold: #405ac0;

  --neu-surface: #e4e9f0;   /* Light gray-blue surface */
  --neu-shadow: #c2c9d3;    /* Medium gray shadow */
  --neu-highlight: #ffffff; /* Pure white highlight */
  /* --neu-raised & --neu-inset recalculate automatically */
}
```

### Color Relationship Rules
| Token | Dark Mode | Light Mode | Rule |
|-------|-----------|------------|------|
| `--neu-surface` | `#292f3a` | `#e4e9f0` | Base surface - **used for background AND all components** |
| `--neu-shadow` | `#1b1f27` | `#c2c9d3` | `surface - ~15-20% lightness` (darker) |
| `--neu-highlight` | `#373f4d` | `#ffffff` | `surface + ~15-20% lightness` (lighter) |
| `--gold` | `#a5b8ff` | `#405ac0` | Accent - **only color that breaks monochrome** |

---

## 🔲 Shadow System - The Heart of Neumorphism

### Raised / Convex (Buttons, Cards, Badges)
```css
--neu-raised: 6px 6px 14px var(--neu-shadow), -6px -6px 14px var(--neu-highlight);
/*                    ^ dark shadow              ^ light highlight */
/*                    bottom-right               top-left */
```

**Applied to:**
- `.projects-heading-badge`
- `.projects-toolbar`
- `.project-card`
- `.skeu-chip` (default)
- `.skeu-button--primary`
- `.project-card-folder`
- `.project-dialog`
- `.theme-switch-track > span` (thumb)
- `.settings-panel`
- `.settings-theme:not(.is-selected)`
- `.settings-close`, `.settings-image-actions button`
- `.settings-swatch`

### Inset / Concave (Inputs, Pressed States, Active Toggles)
```css
--neu-inset: inset 4px 4px 9px var(--neu-shadow), inset -4px -4px 9px var(--neu-highlight);
/*                    ^ inner dark shadow           ^ inner light highlight */
/*                    bottom-right                  top-left */
```

**Applied to:**
- `.skeu-field` (inputs)
- `.project-card-path`
- `.skeu-chip.is-active`, `.skeu-chip:active`
- `.skeu-button:active`
- `.style-option[aria-pressed='true']`
- `.project-pin.is-pinned`
- `.theme-switch-track` (track background)
- `.settings-theme.is-selected`
- `.settings-nav button.is-current`
- `.settings-radio`, `.settings-effect input`
- `.settings-opacity input` (range track)

---

## 📐 Border Radius Scale

```css
/* Consistent rounded scale - all elements use these */
--radius-sm: 8px;    /* Chips, small controls */
--radius-md: 12px;   /* Inputs, path display */
--radius-lg: 16px;   /* Badge, toolbar, cards (default) */
--radius-xl: 20px;   /* Cards in neumorphism mode */
--radius-2xl: 24px;  /* Dialogs, settings panel */
```

**Mode-specific overrides:**
```css
[data-style='neumorphism'] {
  --radius-card: 20px;      /* Project cards */
  --radius-badge: 16px;     /* Heading badge */
  --radius-toolbar: 16px;   /* Toolbar */
  --radius-input: 12px;     /* Inputs, path */
  --radius-button: 16px;    /* Buttons, chips */
  --radius-dialog: 24px;    /* Dialogs */
  --radius-pin: 50%;        /* Pin button (circular) */
  --radius-switch-track: 20px;
  --radius-switch-thumb: 50%;
}
```

---

## 🧱 Component Specifications

### 1. Surface / Background
```css
.projects-view[data-style='neumorphism'] {
  background: var(--neu-surface); /* Full viewport background */
  min-height: 100vh;
}
```

### 2. Heading Badge (Circular Icon Container)
```css
.projects-heading-badge {
  display: grid; place-items: center;
  width: 58px; height: 58px;
  border: 1px solid transparent;
  border-radius: 16px; /* --radius-badge */
  color: var(--gold);
  background: var(--neu-surface);
  box-shadow: var(--neu-raised);
}
```

### 3. Toolbar (Search + Filter Bar)
```css
.projects-toolbar {
  display: flex; gap: 12px; padding: 20px; /* Increased in neumorphism */
  border: 1px solid transparent;
  border-radius: 16px; /* --radius-toolbar */
  background: var(--neu-surface);
  box-shadow: var(--neu-raised);
  margin-bottom: 30px;
}
```

### 4. Input Fields (Inset)
```css
.skeu-field {
  flex: 1; min-height: 46px;
  padding: 10px 16px;
  border: 1px solid transparent;
  border-radius: 12px; /* --radius-input */
  background: var(--neu-surface);
  color: var(--ink);
  box-shadow: var(--neu-inset);
  font-size: 13px;
}
.skeu-field::placeholder { color: var(--muted); }
```

### 5. Chips / Toggle Buttons
```css
.skeu-chip {
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 44px; padding: 0 19px;
  border: 1px solid transparent;
  border-radius: 16px; /* --radius-button */
  background: var(--neu-surface);
  color: var(--ink);
  box-shadow: var(--neu-raised);
  font-size: 13px; font-weight: 650;
  cursor: pointer;
  transition: transform .15s, filter .15s, box-shadow .15s;
}

/* Hover - color shift only, no shadow change */
.skeu-chip:hover { color: var(--gold); filter: none; }

/* Active/Pressed - becomes INSET */
.skeu-chip.is-active,
.skeu-chip:active {
  color: var(--gold);
  background: var(--neu-surface);
  box-shadow: var(--neu-inset);
  outline: none;
  transform: none;
}
```

### 6. Primary Buttons
```css
.skeu-button--primary {
  /* Same base as chip but with accent colors */
  color: var(--gold); /* Gold text by default */
  background: var(--neu-surface);
  box-shadow: var(--neu-raised);
  border-radius: 16px;
}

/* Hover */
.skeu-button--primary:hover { filter: none; }

/* Active - pressed in */
.skeu-button--primary:active {
  color: var(--gold);
  background: var(--neu-surface);
  box-shadow: var(--neu-inset);
  transform: none;
}
```

### 7. Project Cards (Main Content Cards)
```css
.project-card {
  position: relative; isolation: isolate;
  display: flex; flex-direction: column;
  min-height: 202px; height: 100%;
  padding: 20px; /* Increased in neumorphism */
  border: 1px solid transparent;
  border-radius: 20px; /* --radius-card */
  background: var(--neu-surface);
  box-shadow: var(--neu-raised);
  transition: transform .2s, filter .2s;
}

/* Remove skeuomorphic pseudo-elements */
.project-card::before,
.project-card::after { display: none; }

/* Hover - subtle lift */
.project-card:hover {
  filter: none;
  transform: translateY(-2px);
}
```

### 8. Folder Icon (Card Top-Left)
```css
.project-card-folder {
  display: grid; place-items: center;
  width: 32px; height: 28px;
  border: 1px solid transparent;
  border-radius: 8px; /* Smaller radius */
  color: var(--gold);
  background: var(--neu-surface);
  box-shadow: var(--neu-raised);
}
```

### 9. Pin Button (Card Top-Right)
```css
.project-pin {
  display: grid; place-items: center;
  width: 44px; height: 44px; /* Larger touch target */
  margin: 0;
  border: none;
  border-radius: 50%;
  color: var(--muted);
  background: var(--neu-surface);
  cursor: pointer;
}

/* Hover - raises */
.project-pin:hover {
  color: var(--gold);
  box-shadow: var(--neu-raised);
}

/* Pinned - pressed in */
.project-pin.is-pinned {
  color: var(--gold);
  background: var(--neu-surface);
  box-shadow: var(--neu-inset);
}
```

### 10. Path Display (Inset)
```css
.project-card-path {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 12px; /* --radius-input */
  color: var(--ink);
  font: 10px/1.5 var(--mono);
  background: var(--neu-surface);
  box-shadow: var(--neu-inset);
}
```

### 11. Dialogs / Modals
```css
.project-dialog {
  width: min(400px, calc(100% - 64px));
  padding: 28px;
  border: 1px solid transparent;
  border-radius: 24px; /* --radius-dialog */
  background: var(--neu-surface);
  color: var(--ink);
  /* Elevated with extra depth */
  box-shadow: 12px 12px 40px #0005, -4px -4px 20px var(--neu-highlight);
}
.project-dialog::backdrop {
  background: #080c09b3;
  backdrop-filter: blur(5px);
}
```

### 12. Theme Switch (Toggle)
```css
.theme-switch-track {
  width: 30px; height: 17px;
  border-radius: 20px;
  padding: 2px; box-sizing: border-box;
  background: var(--neu-surface);
  box-shadow: var(--neu-inset); /* Track is INSET */
}

.theme-switch-track > span {
  display: block; width: 13px; height: 13px;
  border-radius: 50%;
  background: var(--gold); /* Thumb is accent color */
  box-shadow: 1px 1px 3px var(--neu-shadow); /* Subtle raise */
  transition: transform .18s;
}

.theme-switch[aria-checked="true"] .theme-switch-track > span {
  transform: translateX(13px);
}
```

### 13. Section Labels
```css
.projects-section-label {
  display: flex; justify-content: space-between; align-items: center;
  margin: 0 2px 23px;
  color: var(--muted);
  font-size: 10px; font-weight: 650;
  letter-spacing: 2px; text-transform: uppercase;
  text-shadow: none; /* Remove skeuo text-shadow */
}
```

---

## ⚡ Interaction States Summary

| State | Raised Elements | Inset Elements |
|-------|-----------------|----------------|
| **Default** | `box-shadow: var(--neu-raised)` | `box-shadow: var(--neu-inset)` |
| **Hover** | `color: var(--gold); filter: none;` | `color: var(--gold);` (inputs don't hover) |
| **Active/Pressed** | `box-shadow: var(--neu-inset); transform: none;` | Stays inset (already pressed) |
| **Focus** | `outline: 2px solid var(--gold); outline-offset: 4px;` | Same |
| **Selected/Active** (chips, toggles) | `box-shadow: var(--neu-inset); color: var(--gold);` | N/A |

---

## 📱 Responsive Adjustments

```css
@media (max-width: 760px) {
  .projects-view { padding: 28px 20px 48px; }
  .projects-toolbar { padding: 12px; }
  .project-card { min-height: 204px; }
}

@media (max-width: 500px) {
  .projects-header { flex-direction: column; gap: 20px; }
  .projects-header > button { width: 100%; }
  .projects-grid { grid-template-columns: 1fr; gap: 28px; }
  .skeu-chip { padding: 0 12px; }
  .style-option { flex-basis: calc(50% - 10px); }
}
```

---

## ♿ Accessibility

```css
/* Focus visible for all interactive elements */
:is(button, input):focus-visible {
  outline: 2px solid var(--gold);
  outline-offset: 4px;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; }
}

/* Color scheme for form controls */
.projects-view[data-style='neumorphism'] { color-scheme: dark; }
.projects-view[data-style='neumorphism'][data-theme='light'] { color-scheme: light; }
```

---

## 🎨 Settings Dialog - Neumorphism Variant

The settings dialog demonstrates neumorphism applied to a complex component:

```css
[data-style='neumorphism'] .settings-dialog {
  --settings-bg: var(--neu-surface);
  --settings-panel: var(--neu-surface);
  --settings-hover: var(--neu-surface);
  --settings-line: #8794aa26; /* Very subtle border */
  --settings-text: var(--ink);
  --settings-muted: var(--muted);
  --settings-accent: var(--gold);
  --settings-accent-ink: var(--neu-surface);
  border-radius: 24px;
  box-shadow: 16px 16px 50px #0005, inset 1px 1px 2px var(--neu-highlight);
}

[data-style='neumorphism'] .settings-panel {
  border-color: transparent;
  border-radius: 20px;
  box-shadow: var(--neu-raised);
  margin-bottom: 24px;
}

[data-style='neumorphism'] .settings-theme:not(.is-selected),
[data-style='neumorphism'] .settings-effect,
[data-style='neumorphism'] .settings-background-preview {
  box-shadow: var(--neu-inset);
}

[data-style='neumorphism'] .settings-close,
[data-style='neumorphism'] .settings-image-actions button {
  background: var(--neu-surface);
  color: var(--gold);
  border-color: transparent;
  box-shadow: var(--neu-raised);
}

[data-style='neumorphism'] .settings-nav button.is-current,
[data-style='neumorphism'] .settings-theme.is-selected {
  background: var(--neu-surface);
  color: var(--gold);
  border-color: transparent;
  box-shadow: var(--neu-inset);
}

[data-style='neumorphism'] .settings-swatch {
  box-shadow: 3px 3px 7px var(--neu-shadow), -3px -3px 7px var(--neu-highlight);
}
```

---

## 📋 Complete Variable Reference

```css
/* ===== NEUMORPHISM DESIGN TOKENS ===== */

/* Colors */
--ink: #e6ebf3;              /* Primary text */
--muted: #adb9cb;            /* Secondary text */
--gold: #a5b8ff;             /* Accent color */

/* Surface */
--neu-surface: #292f3a;      /* THE surface color */

/* Shadows */
--neu-shadow: #1b1f27;       /* Dark shadow color */
--neu-highlight: #373f4d;    /* Light highlight color */
--neu-raised: 6px 6px 14px var(--neu-shadow), -6px -6px 14px var(--neu-highlight);
--neu-inset: inset 4px 4px 9px var(--neu-shadow), inset -4px -4px 9px var(--neu-highlight);

/* Radii */
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 16px;
--radius-xl: 20px;
--radius-2xl: 24px;

/* Transitions */
--transition-fast: 150ms;
--transition-normal: 200ms;
--transition-slow: 300ms;

/* Z-index */
--z-dropdown: 100;
--z-dialog: 200;
--z-toast: 300;
--z-tooltip: 400;
```

---

## 🚀 Implementation Checklist

When implementing neumorphism in a new project, verify:

- [ ] **Single surface color** defined as `--neu-surface` used for background AND all components
- [ ] **Two shadow colors** derived from surface: `--neu-shadow` (darker), `--neu-highlight` (lighter)
- [ ] **Two composite shadows**: `--neu-raised` (convex) and `--neu-inset` (concave)
- [ ] **No visible borders** - use `border: 1px solid transparent` for focus ring compatibility
- [ ] **Consistent border radius scale** (8/12/16/20/24px)
- [ ] **Accent color** for interactive states (hover, active, focus)
- [ ] **Hover**: color shift to accent, no shadow change
- [ ] **Active/Pressed**: swap raised ↔ inset shadow
- [ ] **Focus**: accent-colored outline with offset
- [ ] **Light/dark mode** both work with recalculated shadows
- [ ] **Reduced motion** respected
- [ ] **color-scheme** set for native form controls

---

## ❌ Common Mistakes to Avoid

| Mistake | Correct Approach |
|---------|------------------|
| Using different background colors for cards vs page | Everything uses `--neu-surface` |
| Adding visible borders (1px solid gray) | Use `border: 1px solid transparent` |
| Single shadow (only dark or only light) | **Always both** - highlight + shadow |
| Inconsistent light source | Always top-left highlight, bottom-right shadow |
| Too much contrast in shadows | Keep shadows subtle (~10-15% opacity difference) |
| Sharp corners (4-8px radius) | Use 16px+ for neumorphism |
| Colored shadows | Shadows use `--neu-shadow`/`--neu-highlight` only |
| Forgetting inset state for inputs/pressed | Inputs = inset, Pressed = inset |

---

## 🎯 Quick Start Template

```css
/* 1. Define your surface */
:root {
  --neu-surface: #292f3a;        /* Your base color */
  --neu-shadow: #1b1f27;         /* surface - 15% lightness */
  --neu-highlight: #373f4d;      /* surface + 15% lightness */
  --accent: #a5b8ff;             /* Your brand accent */

  --neu-raised: 6px 6px 14px var(--neu-shadow), -6px -6px 14px var(--neu-highlight);
  --neu-inset: inset 4px 4px 9px var(--neu-shadow), inset -4px -4px 9px var(--neu-highlight);
}

/* 2. Page background */
body { background: var(--neu-surface); min-height: 100vh; }

/* 3. Raised component */
.card {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: 16px;
  box-shadow: var(--neu-raised);
}

/* 4. Inset component */
.input {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: 12px;
  box-shadow: var(--neu-inset);
}

/* 5. Interactive states */
.button { box-shadow: var(--neu-raised); }
.button:hover { color: var(--accent); }
.button:active { box-shadow: var(--neu-inset); }
.button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
```

---

*This design system extracted from `aero-skeu-exp` project - a reference implementation of neumorphism with skeuomorphic, aero glass, flat, and neumorphic variants coexisting.*