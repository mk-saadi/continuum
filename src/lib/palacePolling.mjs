// Pure helpers for Memory Palace polling control. Kept free of React so the
// gating rule and equality checks are directly testable in plain node
// (tests/palacePolling.test.cjs); the hook consumes them in
// src/components/MemoryPalace.jsx. The Electron UI suite
// (tests/palacePolling.ui.cjs) drives the real hook with fake timers.
export const PALACE_POLL_INTERVAL_MS = 2000;

export function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

// Gate for one poll tick: only the currently active pane polls, and never
// while the document is hidden. Explicit event-driven refreshes (settings,
// compression, user actions) bypass this gate — it guards the periodic timer
// only, never correctness updates or agent execution.
export function shouldPollTick({ isActive = true, hidden = isDocumentHidden() } = {}) {
  return isActive === true && hidden !== true;
}

// Semantic equality for getContextUsage results. The hook stores the result
// object, so a fresh-but-identical poll would otherwise re-render the whole
// pane subtree every interval. Telemetry is compared by value (same producer,
// stable key order); an unknown future shape fails open to unequal, which
// only costs a render, never correctness.
export function usageEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.totalTokens !== b.totalTokens || a.messageCount !== b.messageCount || a.hasSummary !== b.hasSummary) {
    return false;
  }
  const ta = a.telemetry ?? null;
  const tb = b.telemetry ?? null;
  if (ta === tb) return true;
  if (!ta || !tb) return false;
  return JSON.stringify(ta) === JSON.stringify(tb);
}
