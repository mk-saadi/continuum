// Legacy CommonJS entry point for callers outside BrowserWindow.
// Sandboxed windows must load src/preload.js directly: local require is unavailable.
require("./src/preload.js");
