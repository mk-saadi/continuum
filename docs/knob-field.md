# KnobField

Import `KnobField` from `src/components/FormControls.jsx`. It uses a native range input for labels, keyboard navigation, form submission and refs, with a rotary visual control.

```jsx
<KnobField
  label="Temperature"
  min={0}
  max={2}
  step={0.05}
  value={temperature}
  valueLabel={temperature.toFixed(2)}
  size={72}
  onChange={event => setTemperature(Number(event.target.value))}
/>
```

`size` is the dial diameter in pixels (default 72, minimum 32). Labels, value readouts and hint text keep their own font sizes. `className` styles the field wrapper; `inputClassName` styles the native input. Standard range props, `disabled`, `readOnly`, `hint`, and forwarded refs are supported. Use `aria-valuetext` for units or a spoken value that differs from the numeric value.

Drag upward or rightward to increase; drag downward or leftward to decrease. A 160px drag covers the range regardless of dial size. Pointer capture keeps adjustment active outside the dial. Arrow keys, Home and End use native range behavior. `onChange` previews each change; optional `onCommit` runs once after an edited pointer or keyboard interaction, or on blur.

The dial follows the active palette. Flat uses a simple surface, Aero uses a beveled surface, and Skeu adds machining and deeper relief. Avatar & Branding uses four knobs in a responsive grid; Max tokens remains a number field.
