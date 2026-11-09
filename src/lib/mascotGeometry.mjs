export function bounds(viewport, size) { return { left: Math.min(16, Math.max(0, viewport.width - size) / 2), top: Math.min(48, Math.max(0, viewport.height - size - 28)), right: Math.max(0, viewport.width - size - 16), bottom: Math.max(0, viewport.height - size - 44) }; }
export function point(position, viewport, size) { const b = bounds(viewport, size); return { x: b.left + Math.max(0, b.right - b.left) * position.x, y: b.top + Math.max(0, b.bottom - b.top) * position.y }; }
export function normalized(p, viewport, size) { const b = bounds(viewport, size); return { x: Math.max(0, Math.min(1, (p.x - b.left) / Math.max(1, b.right - b.left))), y: Math.max(0, Math.min(1, (p.y - b.top) / Math.max(1, b.bottom - b.top))) }; }
export function facing(x, width, previous = 'left') { return x < width / 2 - 24 ? 'right' : x > width / 2 + 24 ? 'left' : previous; }
export function mayMirror(state) { return !['terminal', 'error-nan'].includes(state); }
