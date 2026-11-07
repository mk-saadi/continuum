// Accounting scope describes which usage was aggregated, not request count.
// Unknown historical counts must not be presented as evidence of a tool loop.
export function hasMultipleRequests(stats = {}) {
  if (stats.scope === 'final') return false;
  const count = stats.promptRequests ?? (Array.isArray(stats.raw) ? stats.raw.length : null);
  return Number.isInteger(count) && count > 1;
}
