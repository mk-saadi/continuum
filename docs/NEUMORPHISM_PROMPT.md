# Neumorphism Implementation Prompt for AI Agents

---

## 🎯 **Copy-Paste This Prompt to Any Agent**

> **Implement a complete neumorphism (soft UI) design system following the exact specifications below. This is NOT material design, NOT flat design, and NOT standard skeuomorphism — it is neumorphism: a single surface color with depth created purely through dual-tone shadows (highlight + shadow) simulating extruded/pressed elements from the same material.**

---

## 📐 **Core Design Tokens (Define These First)**

```css
:root {
  /* === SEMANTIC COLORS === */
  --ink: #e6ebf3;              /* Primary text */
  --muted: #adb9cb;            /* Secondary text, placeholders */
  --accent: #a5b8ff;           /* Brand accent - ONLY non-monochrome color */

  /* === NEUMORPHISM SURFACE (THE SINGLE SOURCE OF TRUTH) === */
  --neu-surface: #292f3a;      /* Base surface - used for BG, cards, buttons, inputs, EVERYTHING */

  /* === SHADOW COLORS (Derived from surface) === */
  --neu-shadow: #1b1f27;       /* Darker than surface (~15% darker) */
  --neu-highlight: #373f4d;    /* Lighter than surface (~15% lighter) */

  /* === COMPOSITE SHADOWS (The heart of neumorphism) === */
  --neu-raised: 6px 6px 14px var(--neu-shadow), -6px -6px 14px var(--neu-highlight);
  --neu-inset: inset 4px 4px 9px var(--neu-shadow), inset -4px -4px 9px var(--neu-highlight);

  /* === RADIUS SCALE === */
  --radius-sm: 8px;    /* Chips, small controls */
  --radius-md: 12px;   /* Inputs, path displays */
  --radius-lg: 16px;   /* Buttons, badges, toolbar */
  --radius-xl: 20px;   /* Cards */
  --radius-2xl: 24px;  /* Dialogs, modals */

  /* === TRANSITIONS === */
  --transition-fast: 150ms;
  --transition-normal: 200ms;
}

/* Light mode overrides */
[data-theme='light'] {
  --ink: #29364c;
  --muted: #54637a;
  --accent: #405ac0;
  --neu-surface: #e4e9f0;
  --neu-shadow: #c2c9d3;
  --neu-highlight: #ffffff;
}
```

---

## 🔴 **NON-NEGOTIABLE RULES**

| Rule | Enforcement |
|------|-------------|
| **One surface color everywhere** | `background: var(--neu-surface)` on `body`, cards, buttons, inputs, dialogs, toolbars, badges |
| **No visible borders** | `border: 1px solid transparent` (allows focus rings) |
| **Dual shadows always** | Every raised element: `--neu-raised`; every inset: `--neu-inset` |
| **Consistent light source** | Top-left highlight (`-6px -6px`), bottom-right shadow (`6px 6px`) |
| **Monochrome + one accent** | Only `--accent` breaks neutrality (hover, active, focus) |
| **Radius ≥ 16px for cards/buttons** | Neumorphism looks wrong with sharp corners |

---

## 🧱 **Component Specifications (Implement Exactly)**

### 1. Page Background
```css
body {
  background: var(--neu-surface);
  min-height: 100vh;
  color: var(--ink);
  color-scheme: dark; /* or light */
}
```

### 2. Raised Card / Panel / Button / Badge
```css
.neu-raised {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: var(--radius-lg); /* 16px default */
  box-shadow: var(--neu-raised);
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}
.neu-raised:hover { color: var(--accent); }
.neu-raised:active {
  box-shadow: var(--neu-inset);
  transform: none;
}
.neu-raised:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
```

### 3. Inset Input / Textarea / Select / Pressed State
```css
.neu-inset {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: var(--radius-md); /* 12px */
  box-shadow: var(--neu-inset);
  color: var(--ink);
}
.neu-inset::placeholder { color: var(--muted); }
.neu-inset:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
```

### 4. Interactive Chip / Toggle Button
```css
.neu-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 16px; min-height: 44px;
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  box-shadow: var(--neu-raised);
  color: var(--ink);
  font-weight: 600;
  cursor: pointer;
  transition: color var(--transition-fast), box-shadow var(--transition-fast);
}
.neu-chip:hover { color: var(--accent); }
.neu-chip.is-active,
.neu-chip:active {
  color: var(--accent);
  box-shadow: var(--neu-inset);
}
```

### 5. Primary Button (Accent Text by Default)
```css
.neu-button--primary {
  /* Same as .neu-chip but: */
  color: var(--accent); /* Accent by default */
}
.neu-button--primary:active { color: var(--accent); }
```

### 6. Dialog / Modal (Extra Depth)
```css
.neu-dialog {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: var(--radius-2xl); /* 24px */
  /* Stronger shadow for layering */
  box-shadow: 12px 12px 40px #0005, -4px -4px 20px var(--neu-highlight);
}
.neu-dialog::backdrop {
  background: #0008;
  backdrop-filter: blur(8px);
}
```

### 7. Toggle Switch
```css
.neu-switch-track {
  width: 44px; height: 26px;
  border-radius: 999px;
  background: var(--neu-surface);
  box-shadow: var(--neu-inset); /* Track is INSET */
}
.neu-switch-thumb {
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 1px 1px 3px var(--neu-shadow); /* Subtle raise */
  transition: transform var(--transition-fast);
}
.neu-switch[aria-checked="true"] .neu-switch-thumb {
  transform: translateX(22px);
}
```

---

## ⚡ **Interaction State Machine**

```
┌─────────────┐     hover      ┌─────────────┐
│   DEFAULT   │ ─────────────> │   HOVER     │
│  (raised)   │                │ color:accent│
└─────────────┘                └─────────────┘
       ▲                              │
       │         active/press         ▼
       │                        ┌─────────────┐
       └─────────────────────── │   ACTIVE    │
                                │  (inset)    │
                                └─────────────┘
```

| Element Type | Default | Hover | Active/Pressed | Focus |
|--------------|---------|-------|----------------|-------|
| Raised (card, btn, badge) | `neu-raised` | `color: accent` | `neu-inset` | `outline: accent` |
| Inset (input, pressed chip) | `neu-inset` | — | `neu-inset` | `outline: accent` |
| Toggle (switch track) | `neu-inset` | — | — | `outline: accent` |

---

## 📱 **Responsive Behavior**

```css
@media (max-width: 768px) {
  .neu-card { border-radius: var(--radius-xl); padding: 16px; }
  .neu-toolbar { padding: 12px; gap: 8px; }
  .neu-chip { padding: 0 12px; }
}

@media (max-width: 480px) {
  .neu-dialog { border-radius: var(--radius-xl); margin: 16px; }
  .neu-grid { grid-template-columns: 1fr; }
}
```

---

## ♿ **Accessibility Requirements**

```css
/* 1. Focus visible on ALL interactive elements */
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[role="button"]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}

/* 2. Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }
}

/* 3. Color scheme for native controls */
:root { color-scheme: dark; }
[data-theme='light'] { color-scheme: light; }

/* 4. Sufficient contrast */
/* --ink vs --neu-surface: ≥ 4.5:1 */
/* --accent vs --neu-surface: ≥ 3:1 (for non-text) */
```

---

## ✅ **Verification Checklist (Run After Implementation)**

- [ ] `body` background = `var(--neu-surface)`
- [ ] Every card, button, badge, toolbar, dialog uses `background: var(--neu-surface)`
- [ ] Zero visible borders (all `border: 1px solid transparent`)
- [ ] All raised elements use `var(--neu-raised)` (two shadows)
- [ ] All inset elements use `var(--neu-inset)` (two inset shadows)
- [ ] Shadow direction consistent: highlight top-left, shadow bottom-right
- [ ] Hover = color change to `--accent` only (no shadow change)
- [ ] Active/pressed = shadow flips to inset
- [ ] Focus = `--accent` outline with 4px offset
- [ ] Light mode works (recalculates shadows correctly)
- [ ] Border radius ≥ 16px on cards/buttons
- [ ] Transitions 150-200ms
- [ ] `prefers-reduced-motion` respected
- [ ] `color-scheme` set for form controls

---

## 🎨 **Visual Reference - What It Should Look Like**

```
DARK MODE:                          LIGHT MODE:
┌─────────────────────┐             ┌─────────────────────┐
│  ████████████████   │  BG: #292f3a  │  ░░░░░░░░░░░░░░   │  BG: #e4e9f0
│  █  ┌─────────┐ █   │               │  ░  ┌─────────┐ ░   │
│  █  │  CARD   │ █   │  Card:        │  ░  │  CARD   │ ░   │  Card:
│  █  │ ░░░░░░░ │ █   │  #292f3a      │  ░  │ ███████ │ ░   │  #e4e9f0
│  █  │ ░ BTN ░ │ █   │  Shadow:      │  ░  │ █ BTN █ │ ░   │  Shadow:
│  █  │ ░░░░░░░ │ █   │  #1b1f27 +    │  ░  │ ░░░░░░░ │ ░   │  #c2c9d3 +
│  █  └─────────┘ █   │  #373f4d      │  ░  └─────────┘ ░   │  #ffffff
│  ████████████████   │               │  ░░░░░░░░░░░░░░   │
└─────────────────────┘             └─────────────────────┘
  ↑ Soft, extruded,                    ↑ Soft, pressed into
  monochromatic                        surface, monochromatic
```

---

## 📁 **Reference Files in This Project**

| File | Purpose |
|------|---------|
| `NEUMORPHISM_DESIGN_SYSTEM.md` | Complete design system documentation |
| `src/components/Projects.css` | Lines 227-276: Neumorphism implementation |
| `src/components/Settings.css` | Lines 68-70, 162-177, 189-191: Settings dialog neumorphism |

---

## 🚫 **Common Failure Patterns (Do Not Do These)**

```css
/* ❌ WRONG - Different backgrounds */
.card { background: #333; }
.button { background: #444; }
.input { background: #222; }

/* ❌ WRONG - Visible borders */
.card { border: 1px solid #444; }

/* ❌ WRONG - Single shadow */
.card { box-shadow: 4px 4px 8px #000; }

/* ❌ WRONG - Inconsistent light source */
.card { box-shadow: 4px 4px 8px #000, -4px -4px 8px #fff; }
.button { box-shadow: -4px -4px 8px #fff, 4px 4px 8px #000; }

/* ❌ WRONG - Sharp corners */
.card { border-radius: 4px; }

/* ❌ WRONG - Colored shadows */
.card { box-shadow: 4px 4px 8px blue, -4px -4px 8px cyan; }

/* ✅ CORRECT - All use same surface, dual shadows, consistent radius */
.card, .button, .input, .badge, .dialog {
  background: var(--neu-surface);
  border: 1px solid transparent;
  border-radius: 16px;
}
.card, .button, .badge { box-shadow: var(--neu-raised); }
.input { box-shadow: var(--neu-inset); }
```

---

## 💡 **Pro Tips**

1. **Generate shadow colors programmatically**: `--neu-shadow` = `color-mix(in oklab, var(--neu-surface) 85%, black)`; `--neu-highlight` = `color-mix(in oklab, var(--neu-surface) 85%, white)`

2. **Use CSS custom properties for everything** — enables instant theming

3. **Test in both light/dark** — shadows must recalculate correctly

4. **Keep it subtle** — neumorphism fails when shadows are too strong

5. **Reserve accent for interaction only** — not decorative elements

---

*This prompt is derived from the production neumorphism implementation in `aero-skeu-exp` which supports 4 design languages (skeuomorphic, aero glass, flat, neumorphism) with full light/dark theming.*