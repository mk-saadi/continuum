# Continuum desktop companion

Continuum now renders one independent, transparent, always-on-top mascot window. It remains available above other applications and on other workspaces while Continuum is running, including when the main window is minimized. Restart the application after installing this change: a renderer reload does not create the new native window or update its preload.

- Hover over the mascot to reveal the message button. Click it to open a prompt field below the artwork (above it when the display edge leaves insufficient room).
- Enter sends; Shift+Enter adds a line. Prompts use the currently selected Continuum chat and model. Draft text in the main composer is preserved. Clear pending main-window attachments before sending from the companion.
- Replies stream into a small scrollable box with 10 px text. The full conversation stays in the main application. Open full chat is available in the response header.
- Right-click the mascot for Open Continuum, Mascot settings, Lock position, Reset position, and Hide. There is no permanent three-dot button. The keyboard context-menu key or Shift+F10 opens the same menu.
- Drag the artwork anywhere in the usable desktop. Arrow keys move the focused mascot by 8 px; Shift+arrow moves it by 32 px. Positions are saved per display using normalized coordinates. Missing displays fall back to the primary display; resizing, size changes and display topology changes clamp placement.
- Approvals remain in Continuum's existing approval UI. The companion shows Confused and offers Open Continuum. It yields when the focused main window has an approval/settings dialog, so it cannot cover those controls.
- Settings → Mascot can re-enable a hidden companion, change size/hue/facing/motion/sleep/lock settings, reset placement and preview all expressions.

The main application process must remain running. Closing the main application quits its companion; minimizing keeps it available. Native always-on-top/workspace behavior is controlled by the desktop compositor. X11 is verified; Windows, macOS and Wayland behavior has not been tested here.

## Architecture and security

`src/main/desktopMascot.js` owns the separate BrowserWindow, native context menu, display coordinates, input hit regions and IPC authorization. The window is frameless and transparent, with context isolation, sandboxing, no Node integration and a dedicated `src/mascotPreload.js`. It has no filesystem, shell, provider or ordinary chat API. Navigation and new windows are blocked. Every companion IPC call is checked against the exact webContents, main frame and document URL; only the trusted main renderer can publish activity or select a target chat.

`DesktopMascotBridge.jsx` publishes the selected conversation's activity and persisted settings. `ChatInterface.jsx` receives request identities scoped to its active tab and session, acknowledges delivery and calls its existing `sendMessage` function. The ordinary `desktopChat.mjs` pipeline retains model/provider selection, tool execution, permissions, approvals, cancellation and conversation persistence. There is no second agent implementation and no separate model call for animation. A pending-delivery timeout and busy checks prevent silently lost or duplicated prompts. Preflight failures are shown as failures too.

`DesktopMascot.jsx` renders the artwork, hover composer and compact plain-text response. Main-process hit testing passes clicks through transparent space to applications beneath the companion, including when its expanded panel creates a wider native window. Dragging uses pointer capture; native cursor coordinates keep movement consistent across screens. Response publication is throttled, and unchanged native bounds are not repeatedly applied. Showing responses does not steal keyboard focus; opening the editor does.

Settings use the existing validated `app_settings` database and settings APIs. `desktopPosition` stores display ID and normalized desktop coordinates separately from the earlier in-window position. The browser uses `mascotSettings.mjs`; the main process uses `mascotSettings.cjs`, with parity tests. Updates from the native menu synchronize back to the settings modal. Hide persists the enable setting.

The main entry lazily mounts either the full application or the dedicated companion renderer. The original in-window mascot is no longer mounted in the main application. Transparency is applied before first paint, including the boot splash. The existing CSP permits same-origin asset fetches and generated blob URLs so packaged animation loading works without permitting arbitrary remote origins. The package includes the companion preload, native window code and selected Vite assets.

## Assets and playback

`mascotCatalog.json` is generated from `design/mascot/animated-webp/manifest.csv`. Run `node scripts/generate-mascot-assets.cjs` from the repository root after changing design exports. It selects the latest state/part versions, keeps small/full resolution tiers, and extracts genuine static PNG frames. Historical design exports stay intact. Both thinking and spiral variants remain previewable.

Vite bundles only `src/assets/mascot`. Height × device pixel ratio selects the resolution tier, including after moving between displays. Aspect ratio/transparency are preserved inside a stable anchor. Terminal v22 replaces turbo. Terminal and NAN keep their original facing: mirroring their baked artwork would reverse the symbols. Hue also affects baked face/error colors.

`mascotPlayback.mjs` uses exact manifest durations, decoded playback instances, cancellation tickets and timers that start after display. Reactions start from the beginning and transition to matching holds. Terminal has entry/loop/exit stages. Next-stage assets preload during the current stage. Repeated event identities do not restart playback. A 140 ms downward activity handoff bridges brief tool gaps; attention and new work interrupt immediately. Failed animated assets fall back to static PNGs. System mode respects reduced-motion preference; Reduced uses PNGs. Hidden/disabled companions unmount playback.

## Runtime expressions

| Structured signal | Expression |
| --- | --- |
| Request preparation, waiting, reasoning | Thinking |
| Indexing or search/retrieval tools | Thinking scan |
| Text generation or ordinary tools | Working |
| Active delegated tool execution | Analytical |
| Shell, code execution, build/test tools, terminal-server calls | Terminal entry → loop → exit |
| Approval, ask-user, paused loop, tool-limit decision | Confused reaction → hold until resolved |
| Recoverable tool error before recovery/new execution | NAN |
| Completed top-level request | Happy reaction, short hold, idle |
| Interrupted/failed top-level request, including preflight failure | X X until newer work |
| Cancellation | Idle without a success/failure celebration |
| Idle inactivity | Sleepy reaction → hold; input/work wakes it |

Only the selected conversation drives runtime activity. Tool/child completion never independently celebrates. Listening is preview-only because there is no voice-capture lifecycle. Excited and Laughing are preview-only. Both Spiral variants are preview-only because the outcome channel does not reliably distinguish overload from other interruptions. The companion has no automatic sounds, speech bubbles unrelated to a request, model calls for emotion or animation-frame announcements.

## Verification

- `node --test tests/desktopMascot.test.cjs tests/mascot.test.mjs tests/settingsPanels.test.mjs tests/desktopChat.test.mjs`
- `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/mascotPersistence.test.cjs`
- `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/engineSettings.test.cjs`
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/desktopMascot.ui.cjs`
- Same command with `--dev` to verify Vite development module loading.
- Existing `tests/mascot.ui.cjs` covers animation/reduced-motion/asset fallback; `tests/memorySettings.ui.cjs` covers the lazy settings modal.
- `npm run build`

The desktop UI test creates separate main, companion and unrelated application windows. It checks transparency, independent always-on-top visibility with the main window minimized, actual native pointer hover and dragging, click-through transparent regions, keyboard movement, hover composer, scoped prompt delivery, working/response/approval UI, 10 px response text, persistence and hide. Linux native pointer checks use X11/XTest inside the test's virtual display. It runs with both production `file:` assets and Vite development loading. `/tmp/continuum-desktop-mascot.png` records the compact result for visual inspection.

Controller tests cover display normalization/restoration, negative display origins, unplugged displays, small work areas, panel placement/hit regions, sender/subframe/navigation rejection, invalid/duplicate/busy submissions, stale context changes, native dragging/locking and focused modal access. Database close/reopen verifies durable position/settings persistence. Chat execution tests cover the existing request path. UI prompt/reply checks use a deterministic test-agent bridge; no live provider/model request or installer build is claimed.
