export function getAppShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || event.repeat) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === 'p' ? 'spotlight' : null;
  return { '[': 'left', ']': 'right', '.': 'settings', m: 'models' }[key] || null;
}
