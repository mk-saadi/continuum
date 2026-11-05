import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "./",
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			// Local networking resources contain a private Linux rootfs with
			// cyclic /var/run links; it must never be traversed by Vite's watcher.
			ignored: ["**/.continuum-local/**"],
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
