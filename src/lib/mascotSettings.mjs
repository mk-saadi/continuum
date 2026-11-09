// Browser ESM entry point. Keep behavior aligned with mascotSettings.cjs.
export const DEFAULT_MASCOT_SETTINGS = Object.freeze({ enabled: true, size: 128, hue: 0, automaticFacing: true, facing: 'left', animation: 'system', sleep: 5, locked: false, position: { x: 1, y: 0.78 }, desktopPosition: null });
export function normalizeMascotSettings(value) {
    const v = value && typeof value === 'object' ? value : {};
    const number = (n, min, max, fallback) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    const bool = (key) => typeof v[key] === 'boolean' ? v[key] : DEFAULT_MASCOT_SETTINGS[key];
    const desktopPosition = v.desktopPosition && Number.isFinite(v.desktopPosition.displayId) && Number.isFinite(v.desktopPosition.x) && Number.isFinite(v.desktopPosition.y) ? {displayId:v.desktopPosition.displayId,x:number(v.desktopPosition.x,0,1,1),y:number(v.desktopPosition.y,0,1,.75)} : null;
    return { desktopPosition, enabled: bool('enabled'), size: number(v.size, 80, 240, 128), hue: number(v.hue, 0, 360, 0), automaticFacing: bool('automaticFacing'), facing: v.facing === 'right' ? 'right' : 'left', animation: ['system', 'full', 'reduced'].includes(v.animation) ? v.animation : 'system', sleep: [0, 1, 5, 15].includes(v.sleep) ? v.sleep : 5, locked: bool('locked'), position: { x: number(v.position?.x, 0, 1, 1), y: number(v.position?.y, 0, 1, .78) } };
}

