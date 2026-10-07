export function getTabShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return null;
  const key = event.key.toLowerCase();
  if (key === 'w') return event.shiftKey ? 'close-all' : 'close';
  if (key === 't' && !event.shiftKey) return 'new';
  if (key === 'pageup' || (key === 'tab' && event.shiftKey)) return 'previous';
  if (key === 'pagedown' || (key === 'tab' && !event.shiftKey)) return 'next';
  return null;
}
