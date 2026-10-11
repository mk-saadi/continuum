// Pure helpers for the transcript text-selection menu (see
// src/components/chat/TextSelectionMenu.jsx). Kept DOM-light with injected
// dependencies so they stay unit-testable without a browser.

// Returns the trimmed selected text when the whole selection lives inside
// scopeEl, otherwise "". Textareas/inputs are never included: their content
// is not part of window.getSelection().
export function extractScopedSelectionText(scopeEl, selection) {
  try {
    if (!scopeEl || !selection || selection.isCollapsed || !selection.rangeCount) return "";
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus) return "";
    if (typeof scopeEl.contains !== "function") return "";
    if (!scopeEl.contains(anchor) || !scopeEl.contains(focus)) return "";
    return String(selection.toString?.() ?? "").trim();
  } catch {
    return "";
  }
}

// Prepends a quoted transcript excerpt to a fresh composer submission so the
// agent receives the selection as context above the user's own words. Returns
// text unchanged when there is no quote, so non-quote sends are unaffected.
export function combineQuotedMessage(quote, text) {
  const block = String(quote ?? "").trim();
  if (!block) return text;
  const quoted = block
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const body = String(text ?? "").trim();
  return body ? `${quoted}\n\n${body}` : quoted;
}

// Viewport-clamped floating-menu position for a selection rect. Prefers above
// the selection, falls below when there is no headroom. Pure math: the menu
// dimensions are estimates since the menu is not measured before first paint.
export function clampMenuPosition(rect, menuWidth = 216, menuHeight = 38, gap = 10) {
  const viewportWidth =
    typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
  const left = Math.min(Math.max(8, rect?.left ?? 0), Math.max(8, viewportWidth - menuWidth - 8));
  const fitsAbove = (rect?.top ?? 0) >= menuHeight + gap + 8;
  return {
    left,
    top: fitsAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
    placement: fitsAbove ? "above" : "below",
  };
}
