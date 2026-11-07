// Session IPC returns fresh JSON objects. Compare only at snapshot ingestion,
// preserving row identity so React can skip unchanged history while streaming.
function equalData(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && equalData(a[key], b[key]));
}

export function reconcileMessageSnapshot(previous, incoming) {
  const byId = new Map(previous.filter(row => row.id != null).map(row => [row.id, row]));
  const next = incoming.map(row => {
    const prior = byId.get(row.id);
    return prior && equalData(prior, row) ? prior : row;
  });
  return next.length === previous.length && next.every((row, index) => row === previous[index])
    ? previous : next;
}
