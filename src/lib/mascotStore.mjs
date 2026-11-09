import { normalizeMascotSettings, DEFAULT_MASCOT_SETTINGS } from './mascotSettings.mjs';
export { DEFAULT_MASCOT_SETTINGS };
let snapshot = { settings: normalizeMascotSettings(), error: '', ready: false };
const listeners = new Set();
let pending = Promise.resolve(), initialized = false;
export const getMascotSettings = () => snapshot;
export const subscribeMascotSettings = fn => { listeners.add(fn); return () => listeners.delete(fn); };
function publish(patch) { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); }
export function initializeMascotSettings() { if (initialized)
    return pending; initialized = true; window.desktopMascotMain?.onSettings(settings => publish({settings:normalizeMascotSettings(settings),error:''})); pending = Promise.resolve().then(() => window.api?.getAppSettings?.()).then(saved => publish({ settings: normalizeMascotSettings(saved?.mascot), ready: true })).catch(e => publish({ error: e.message, ready: true })); return pending; }
export function updateMascotSettings(patch) { const task = pending.then(async () => { const settings = normalizeMascotSettings({ ...snapshot.settings, ...patch }); await window.api?.saveAppSettings?.({ mascot: settings }); publish({ settings, error: '' }); }); pending = task.catch(e => publish({ error: e.message })); return pending; }
