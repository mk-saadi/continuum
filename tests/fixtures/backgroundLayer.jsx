import React from 'react';
import { createRoot } from 'react-dom/client';
import useBackgroundSettings, {
	notifyBackgroundChanged,
	notifyBackgroundOpacityChanged,
} from '/home/mk_saadi/projects/persona-projects/llm-electron/src/hooks/useBackgroundSettings';
import BackgroundSettings from '/home/mk_saadi/projects/persona-projects/llm-electron/src/components/settings/BackgroundSettings';

// Phase 3.2 renderer fixture: mount the real background hook / Settings section
// against a stubbed window.api, and count how often the source is re-read
// (getBackgroundSettings) and how often the browser is asked to decode the image
// (new Image(), the verifyImageUrl probe).

let getCalls = 0;
let probes = 0;
let payload = {
	imagePath: '/tmp/bg/background-a.gif',
	renderPath: '/tmp/bg/derived/background-a.bounded.gif',
	previewPath: '/tmp/bg/derived/background-a.poster.png',
	opacity: 85,
	animated: true,
};

// Counting Image stub. `media://` cannot be fetched from this file:// page, so
// every src assignment is reported as a successful decode below; the stub only
// counts how often the browser was asked to decode.
const RealImage = window.Image;
function CountingImage(...args) {
	probes += 1;
	return new RealImage(...args);
}
CountingImage.prototype = RealImage.prototype;
window.Image = CountingImage;

// Deterministic image loading. This page is file:// and cannot fetch media://,
// so the real resource error is suppressed (capture phase, before React's or the
// probe's target-phase handler) and a successful decode is reported instead.
window.addEventListener(
	'error',
	(event) => {
		if (event.target && event.target.tagName === 'IMG') {
			event.stopPropagation();
			event.preventDefault();
		}
	},
	true,
);
const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
Object.defineProperty(HTMLImageElement.prototype, 'src', {
	configurable: true,
	get() {
		return srcDescriptor.get.call(this);
	},
	set(value) {
		srcDescriptor.set.call(this, value);
		queueMicrotask(() => this.dispatchEvent(new Event('load')));
	},
});

window.api = {
	getBackgroundSettings: async () => {
		getCalls += 1;
		return payload;
	},
	pickBackgroundImage: async () => payload,
	removeBackgroundImage: async () => ({ imagePath: null, renderPath: null, previewPath: null, opacity: 85, animated: false }),
	setBackgroundOpacity: async (opacity) => ({ ...payload, opacity }),
};

function HookProbe() {
	useBackgroundSettings();
	return null;
}

const root = createRoot(document.getElementById('root'));
let key = 0;

window.__reset = () => {
	getCalls = 0;
	probes = 0;
};
window.__setPayload = (next) => {
	payload = next;
};
window.__mount = (mode) => {
	key += 1;
	root.render(mode === 'settings' ? <BackgroundSettings key={key} /> : <HookProbe key={key} />);
};
window.__counts = () => ({ getCalls, probes });
window.__state = () => {
	const root = document.documentElement;
	const body = document.body;
	return {
		bgImage: root.getAttribute('data-bg-image'),
		bgAnimated: root.getAttribute('data-bg-animated'),
		backgroundImage: root.style.getPropertyValue('background-image'),
		opacityVar: root.style.getPropertyValue('--bg-ui-opacity'),
		bodyOpacity: body.style.getPropertyValue('opacity'),
		previewSrc: document.querySelector('img[alt="Background preview"]')?.getAttribute('src') ?? null,
	};
};
window.__opacityChanged = (value) => notifyBackgroundOpacityChanged(value);
window.__changed = () => notifyBackgroundChanged();
