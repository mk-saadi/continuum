export const APPEARANCE_STORAGE_KEY = "appearance";
export const APPEARANCES = ["aero", "flat", "skeu"];
const normalizeAppearance = value => APPEARANCES.includes(value) ? value : "aero";
const CHANGED_EVENT = "appearance-changed";
function readSavedAppearance() {
	try { return normalizeAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY)); }
	catch { return "aero"; }
}
let appearance = readSavedAppearance();

export function initializeAppearance() {
	document.documentElement.dataset.appearance = appearance;
	document.documentElement.dataset.style = appearance;
}
export function setAppearance(value) {
	appearance = normalizeAppearance(value);
	initializeAppearance();
	try { localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance); }
	catch { /* The current window still changes when storage is unavailable. */ }
	window.dispatchEvent(new Event(CHANGED_EVENT));
}
export function subscribeAppearance(notify) {
	const onStorage = (event) => {
		if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
		appearance = readSavedAppearance();
		initializeAppearance();
		notify();
	};
	window.addEventListener(CHANGED_EVENT, notify);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(CHANGED_EVENT, notify);
		window.removeEventListener("storage", onStorage);
	};
}

export function getAppearance() { return appearance; }
