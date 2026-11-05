# Corner radius

`src/styles/radius.css` owns the shared radius tokens and Tailwind utilities.

| Token / utility | Aero (default) | Flat | Skeu |
| --- | --- | --- | --- |
| `ui-radius-small` | 4px | 2px | 2px |
| `ui-radius-control` | 9px | 4px | 3px |
| `ui-radius-surface` | 14px | 6px | 6px |
| `ui-radius-round` | 9999px | 9999px | 9999px |
| `ui-radius-pill` | Round alias | Round alias | Control alias |

Use these semantic utilities in components instead of Tailwind's built-in
radius classes or numeric inline styles. Component CSS uses the corresponding
`var(--ui-radius-…)` token. Circles keep their structural shape. Pills have a separate shape alias so Skeu
can use tighter corners without changing dots or circular icon buttons.
`ui-radius-inherit`, `ui-radius-top`, `ui-radius-bottom`, and `ui-radius-tail`
handle nested outlines and joined edges without defining more size tokens.
Tailwind variants such as `file:` and descendant selectors are supported.

For a new appearance, override the three size tokens under
`html[data-appearance="style-name"]` in the shared stylesheet and register
that appearance in the preference store/settings. Missing overrides inherit
the default geometry. No component changes are needed for its radii.

The inline boot splash in `index.html` mirrors the surface/round defaults so
its geometry matches before the application stylesheet loads; keep those
values synchronized when changing the defaults.

This supersedes the older Aero-specific radius tokens in the Aero design guide.
