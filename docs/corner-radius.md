# Corner radius

`src/styles/radius.css` owns the shared radius tokens and Tailwind utilities.

| Token / utility | Aero (default) | Flat |
| --- | --- | --- |
| `ui-radius-small` | 4px | 2px |
| `ui-radius-control` | 9px | 4px |
| `ui-radius-surface` | 14px | 6px |
| `ui-radius-round` | 9999px | 9999px |

Use these semantic utilities in components instead of Tailwind's built-in
radius classes or numeric inline styles. Component CSS uses the corresponding
`var(--ui-radius-…)` token. Circles and pills keep their structural shape.
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
