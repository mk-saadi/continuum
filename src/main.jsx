import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./components/memoryPalace.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { ToastProvider } from "react-toast-master";
import "react-toast-master/dist/style.css";

ReactDOM.createRoot(document.getElementById("root")).render(
	<React.StrictMode>
		<ToastProvider>
			<App />
		</ToastProvider>
	</React.StrictMode>,
);

// Dismiss the boot splash from index.html once React has painted. A short
// minimum on-screen time keeps the splash from flashing on fast starts; it is
// removable at any time by deleting the element, so a failed mount can never
// delay the app behind it. Two frames guarantee the first app paint lands
// before the fade begins.
const bootLoader = document.getElementById("boot-loader");
if (bootLoader) {
	const BOOT_LOADER_MIN_MS = 650;
	const sinceLoad = performance.now();
	const fadeOut = () => {
		bootLoader.classList.add("is-hidden");
		const remove = () => bootLoader.remove();
		bootLoader.addEventListener("transitionend", remove, { once: true });
		window.setTimeout(remove, 600);
	};
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			window.setTimeout(fadeOut, Math.max(0, BOOT_LOADER_MIN_MS - sinceLoad));
		});
	});
}
