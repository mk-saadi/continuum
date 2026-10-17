# Continuum Phase 7 — Whole-application performance audit

Date: 2026-10-18 (Asia/Dhaka). Current source at HEAD `fab58bb` **plus the pre-existing modified/untracked Phase 2–6 tree**. This is an audit; no fixes or virtualization were implemented. Raw samples, runtime versions, commands, counter results, build output, initial Git status and preservation checks are in [the evidence JSON](app-performance-phase7-evidence.json).

## Executive summary

The representative regression checks for Phases 1–6 pass together: 10 focused unit-test files, 11 Electron UI suites and a production renderer build. Three-tab counter tests retain zero chat renders for unrelated chrome actions, two involved tabs per switch, and no rendering for unchanged status events. Persistence batches three same-tick updates into one write. These are fixture results, not a certification of every live workflow.

Pagination still mounts only 15 rows initially. Exploring history retains every revealed row. At 600 complex messages, total DOM elements grew **1,751 → 55,794**, and retained JavaScript heap grew **11.49 → 50.10 MiB** (three runs, garbage-collected endpoints). The median 15-row reveal took **287.4 ms**, with a **448.9 ms p95**. A separate single-send sample after expansion took **1,770.7 ms** to display the user row; the deterministic response has only a 200 ms simulated generation wait. The renderer therefore has a meaningful expanded-history cost worth addressing, although a CPU trace is still needed to attribute the send delay precisely.

Steady scrolling was substantially better than those reveal/send costs: no frames exceeded 50 ms in the 600-complex-message samples. Do not describe this as universally poor scrolling. Recommend a bounded transcript virtualization prototype, preserving existing canonical search and session semantics, followed by equivalent measurements. GPU-specific background behavior remains unverified if the acceleration probe below reports software rendering.

## Environment and measurement boundaries

- Pop!_OS 24.04 LTS; Linux 6.17.9-76061709-generic, x86_64. Host Node 22.23.2. Installed Electron 44.7.0, Chromium 152.0.7977.130; full embedded Node/V8 versions in JSON.
- Current source bundled directly with existing esbuild; transcript and background timing fixtures use `NODE_ENV=production`, without StrictMode. Existing counter/UI suites use `NODE_ENV=test`; their counts are reported separately, without treating their durations as user latency.
- Transcript BrowserWindow: 820×760, shown, devicePixelRatio 1, background throttling disabled. Existing shell-counter suites: 900×700, three mounted tabs, heavy leaves stubbed. Polling suite mounts ten hook probes. No real model, provider request or inference was launched.
- Transcript fixture explicitly disables acceleration: `gpu_compositing=disabled_software`, `rasterization=disabled_software`, OpenGL disabled. Background probe requests default acceleration and reports actual status separately. Neither fixture reproduces the user's complete transparent Electron shell; hardware-backend confirmation is qualified below.
- Observed initial RAM: 15,814 MiB total / 4,309 MiB available; a later reading during profiling was 2,712 MiB available. Swap was already in use. Host workload was not controlled; an existing Electron process group was present and left untouched. Sandboxed `nvidia-smi` could not communicate with its driver. A subsequent host query succeeded: NVIDIA GeForce RTX 5060 Ti, 16,311 MiB total / 15,553 MiB used VRAM, 0% utilization at that instant. This is not a scenario-level VRAM measurement. Absolute timings are descriptive, not statistically controlled A/B results.
- Fixtures use synthetic canonical histories and mocked storage/IPC, isolated temporary Electron profiles, current components and existing `dist` CSS. A fresh Vite build emitted the same CSS filename; build output went only to `/tmp`. The timing bundle is production-mode React, not the packaged production application. App startup, bundle download and DB hydration time are excluded.
- For each content/size combination, three sequential repetitions in one process; 100/300/600 messages; one mounted real ChatInterface. Plain rows contain 20 repetitions of a word; complex assistant rows contain a Markdown heading, table, 12-line highlighted JavaScript block and six bold list items; user rows remain plain. No timed expanded attachment/image/tool-result fixture was added. Such content may be more expensive, but no number is extrapolated to it.
- DOM numbers count **elements** using `querySelectorAll('*')` over the document (text nodes excluded). Transcript-only descendants are separately recorded in JSON. Heap is CDP `JSHeapUsedSize` after explicit garbage collection, not renderer RSS, total application memory or GPU memory.
- Initial-ready proxy: invoke fixture render, poll until 15 rows exist, then wait two animation frames. Reveal proxy: dispatch scroll at top, wait for row growth and two animation frames. These include scheduling, rendering and browser work; they are not React-only render durations or proof of physical presentation. Each size has 6/19/39 page reveals per run.
- Scroll: 120 rAF-driven scroll positions per run, away from pagination edges after full expansion; 360 frame intervals per table row. The actual display's frame intervals often approach 8.3 ms. No comparison to the historical Xvfb/60 Hz timing tables is valid. No manual smoothness rating was made.
- Initial sandbox startup failed before application execution. Retrying isolated checks outside the sandbox succeeded. Temporary harness errors were corrected locally; no application code was changed.

## Previous evidence inventory and current-source verification

All requested Phase 2/2.1/3/3.2/4/5/6 reports were inspected, as were Phase 4–6 structured evidence files, the original custom-background audit and streaming audit. No dedicated terminal-isolation Phase 1 report exists in this tree; unrelated recovery/subagent Phase 1 documents are not evidence for terminal isolation. HEAD's Phase 1 commit, terminal store source and its tests provide that evidence. Phase 4 report/evidence also disagree about historical base commit; current measurements identify the actual tree rather than treating those old builds as identical.

| Phase | Problem and historical evidence | Current verification; remaining boundary |
|---|---|---|
| 1 | Terminal chunks propagated through AppContent. Store tests and Electron shell counters established isolation. | Store still batches at 50 ms, retains 2,000 entries, subscribes via external store; both suites pass. Burst/live/remount/clear preserve order and leave AppContent unchanged. Not a measured high-rate live engine trace. |
| 2 | Whole-history initial mounting. Electron row/node counts at 100/300/600 and anchor assertions supported 15-row pagination. | Source still derives a rendering slice without truncating canonical history. Initial row count constant; full reveal unbounded. Scroll prepend/order/anchor/termination and inference-context assertions pass. |
| 2.1 | DOM-only find missed older messages. Reproduction and canonical matching/navigation tests established the regression and bounded target navigation. | Canonical search + radius-8 target window retained. 13-scenario UI suite and pure search tests pass; an old result can be mounted without the intervening transcript. Hidden/collapsed content may resolve to its owning row rather than a visible highlight. |
| 3 | Animating in-flow sidebar widths repeatedly reflowed transcripts. Historical CDP/frame A/B saw ~19 widths become one. | Source retains transform animations with snapping layout spacers; structural and UI suites pass, including rapid toggles, pointer behavior, search, pagination and streaming. Historical 76–95% layout savings were not remeasured here. |
| 3.2 | Oversized GIF decoding, animated preview, opacity re-probes and modal blur. Historical contentTracing/CDP/rAF measurements were software-only. | 1,920-long-edge derivative and 512-pixel poster policy remain; GIF fidelity/cache/replacement tests pass. Renderer opacity changes cause zero source reads/probes; poster preview and animation flag pass. GPU benefit remains a separate question. |
| 4 | Global chrome changes rerendered every mounted chat. Real shell with counted stub leaves provided before/after evidence. | Three-tab suite reproduces zero shell/chat renders on chrome actions, two tabs on switch, one on genuine status. These counters proxy TabPane propagation; they do not measure expensive real leaf durations. |
| 5 | Palace/callback identities restarted listeners; proposal scans and duplicate derived lookups repeated. Hook probes, listener wrappers and proposal counters supported the fixes. | Zero object/callback changes across eight unchanged-input rerenders; zero keydown additions/proposal scans with stable provider; skill decision recomputes once and updates panel; real session change propagates. Memo dependencies for model/session/proposals remain in source. Full lookup timing and every provider/memory event were not instrumented. |
| 6 | Impure updaters and duplicate persistence/status notifications. Instrumented real TabProvider and three-tab counters supported batching/deduplication. | Updater remains pure; effect serializes committed changes and writes only changed durable payloads. Current counters match the prior evidence. Shared TabContext still notifies subscribers on genuine changes; no measured need for a context rewrite. |

## Principal interaction results

**Idle:** current source keeps a 2,000 ms Memory Palace poll on the active pane; each refresh requests usage, core memories and effective settings. Inactive panes do not create poll timers; hidden-document ticks are skipped. The deterministic ten-probe suite passes: one active timer during operation, identical polls do not rerender, timer ownership moves on activation, and zero intervals remain after unmount (27 total mocked usage calls over the full scenario sequence). This verifies gating, not actual whole-app CPU usage or real idle IPC volume. Two-second transcript idle samples retain stable heap, but their TaskDuration includes end-of-sample forced GC and must not be interpreted as idle CPU. Live application-shell idle CPU/RSS and periodic render traces are unavailable.

**Global UI, three tabs:** settings/model-selector open and close, theme change, and both sidebar toggles each cause **0 ChatInterface leaf renders and 0 AppContent proxy renders**. Settings/model selector mount once when opened. Genuine theme changes apply. Correctness suites cover current sidebar behavior, but no fresh modal/layout/paint timing trace or React Profiler duration was collected. Long real transcripts combined with three real tabs were not timed.

**Tabs:** switching first↔third and a same-tick rapid switch renders exactly the outgoing/incoming pair plus one AppContent render. Unrelated third tab stays stable. A genuine inactive-tab stream status renders only its own tab; duplicate status produces 0 tab/0 AppContent renders. One-tab real transcript and three-tab stubbed-shell coverage are separate; memory scaling for 3+ real expanded transcripts and simultaneous real generation is unmeasured.

**Typing/streaming:** existing input suite passes debounced draft storage, isolated typing, message memoization, IME, session change, send clearing and cleanup. Pagination/search suites pass deterministic streaming completion, full inference context, auto-follow, reading-history preservation and session-window reset. Cancellation and complex tool-call streams were not profiled end-to-end.

Separate production-mode send probes after full complex-history expansion (one sample per size, same fixture, no background):

| Canonical before send | Input→Send enabled ms | Click→user row ms | Click→completed reply ms | Context sent | Final rows |
|---|---:|---:|---:|---:|---:|
| 100 | 6.0 | 653.9 | 1874.2 | 101 | 102 |
| 600 | 4.1 | 1770.7 | 4347.2 | 601 | 600 |

The deterministic stream injects a **200 ms wait**, not model inference. Completion wall time includes that wait, state updates, rendering and polling latency; subtracting it does not isolate pure React time. These samples confirm a slow expanded-history send path in the fixture, but do not identify the dominant function or establish a live-user latency distribution. Input readiness itself was 4–6 ms by this synthetic event method, not physical-key-to-paint latency.

**Terminal:** burst of four chunks while closed, live chunk while open, closed-panel collection/remount and clear all pass. AppContent counter remains unchanged; parent fixture does not render for subscribed log updates. Pure tests exercise cadence/retention/order. No real engine flood was generated and no per-chunk IPC duration measured.

## Transcript pagination and resource results

Rows/elements at initial render, first approximately half-history checkpoint, then full exploration. Three runs per row; counts are deterministic. Heap columns are medians in **MiB**, measured within each run after GC; all canonical counts remain complete.

| Content | Canonical messages | Initial rows / elements | Midway rows / elements | Expanded rows / elements | JS heap initial → expanded MiB |
|---|---:|---:|---:|---:|---:|
| plain | 100 | 15 / 639 | 60 / 1,674 | 100 / 2,594 | 6.38 → 9.28 |
| plain | 300 | 15 / 639 | 150 / 3,744 | 300 / 7,194 | 6.78 → 15.97 |
| plain | 600 | 15 / 639 | 300 / 7,194 | 600 / 14,094 | 7.12 → 25.99 |
| complex | 100 | 15 / 1,751 | 60 / 5,844 | 100 / 9,544 | 10.62 → 16.30 |
| complex | 300 | 15 / 1,751 | 150 / 14,169 | 300 / 28,044 | 10.99 → 30.08 |
| complex | 600 | 15 / 1,751 | 300 / 28,044 | 600 / 55,794 | 11.49 → 50.10 |

For example, the 600-complex-message transcript itself contains 1,463 elements initially and 55,506 after full exploration; the total-document counts above include 288 elements of surrounding UI. Returning to a different session resets the rendering window; rows stay mounted while simply scrolling back down within the same expanded session. Search can replace it with a bounded target window, and Jump to latest resets the suffix to 15. Thus retention is intentional pagination state, not canonical-history corruption or a proven leak.

Timings in **ms**. Initial is median (min–max) over three runs. Reveal is pooled median/p95/max, with sample count. Scroll is pooled frame p50/p95/max, with frames over 50 ms. Initial timing is a readiness proxy, not startup time.

| Content | Messages | Initial ready median (range) | Reveal median / p95 / max (n) | Expanded scroll p50 / p95 / max | Frames >50 ms |
|---|---:|---:|---:|---:|---:|
| plain | 100 | 46.2 (39.2–138.6) | 33.6 / 54.4 / 54.4 (18) | 8.4 / 9.2 / 9.9 | 0/360 |
| plain | 300 | 46.2 (44.6–49.0) | 48.9 / 66.3 / 73.5 (57) | 8.4 / 10.1 / 24.6 | 0/360 |
| plain | 600 | 54.6 (51.8–117.5) | 89.3 / 318.6 / 378.3 (117) | 8.7 / 19.7 / 39.5 | 0/360 |
| complex | 100 | 209.2 (141.5–683.2) | 175.6 / 325.2 / 325.2 (18) | 9.0 / 20.6 / 60.9 | 1/360 |
| complex | 300 | 192.4 (190.2–350.1) | 218.0 / 360.1 / 468.4 (57) | 16.3 / 30.4 / 64.0 | 5/360 |
| complex | 600 | 355.3 (242.1–362.9) | 287.4 / 448.9 / 832.7 (117) | 14.9 / 24.3 / 39.8 | 0/360 |

DOM growth is approximately linear in explored messages. Complex full-history DOM is roughly four times the plain-text DOM at 600 messages, despite identical row counts. Complex reveal latency is already noticeable by a 100-message fully explored fixture; at 600, retained heap adds about **38.6 MiB** beyond its own initial state, and reveals have a 287 ms median. Even plain 600-message reveals reach 89 ms median. No single universal scrolling failure threshold was observed: 300-complex samples have five >50 ms frames while 600-complex samples have none. Workload/noise and content matter; do not claim monotonically worsening scroll jank.

Normal ordering, no duplicates, initial latest-15 behavior, ±2 px anchor preservation, top-triggered older loading, termination, canonical integrity, auto-follow and reading-history stability pass existing UI assertions. Full-history search passes across far results, deletion and session switches. These assertions are narrower than proving every edit/retry/regenerate/attachment layout combination.

## Background measurements

Current-source production-mode background fixture: 1280×800, shown window, 200 canonical messages (initial paginated transcript), no model or IPC generation. Reused prior Phase 3.2 synthetic assets read-only: static PNG 3840×2160, normal GIF 1280×720×20 frames, oversized source 3840×2160×12 frames displayed through its existing 1920×1080 derivative, 512×288 poster. Two sequential 3-second samples per scenario; same process, warm caches on later uses. CDP/contentTracing sums are CPU trace-event durations, not GPU time. Fixture applies current production opacity/background helpers directly. Modal and poster are a representative native dialog plus preview, not the full Settings tree; the separate backgroundLayer suite exercises the real Settings section.

| Scenario | p50 ms, runs 1 / 2 | p95 ms, runs 1 / 2 | Frames >50 ms, runs 1 / 2 | Image decode ms, runs 1 / 2 | Raster ms, runs 1 / 2 |
|---|---:|---:|---:|---:|---:|
| None | 8.4 / 8.3 | 9.2 / 9.0 | 0 / 0 | 0 / 0 | 3.79 / 0 |
| Static 4K | 8.5 / 8.4 | 9.2 / 9.2 | 0 / 0 | 0 / 0 | 0 / 0 |
| Normal GIF | 8.4 / 8.4 | 9.1 / 9.1 | 0 / 0 | 32.86 / 73.50 | 11.13 / 15.20 |
| Bounded oversized GIF | 8.4 / 8.4 | 9.1 / 9.1 | 0 / 0 | 25.18 / 0 | 19.28 / 13.63 |
| Scroll + bounded GIF | 8.3 / 8.3 | 10.1 / 9.5 | 4 / 3 | 0 / 0 | 75.19 / 83.45 |
| Modal + bounded GIF + poster | 8.4 / 8.4 | 9.0 / 9.0 | 0 / 0 | 0 / 12.45 | 11.65 / 11.63 |
| Opacity-only changes + bounded GIF | 8.3 / 8.3 | 9.0 / 9.1 | 0 / 0 | 0 / 0 | 14.11 / 13.17 |

Frame counts vary with elapsed sampling: idle configurations ~361–362 frames/run; scroll 319/344 frames, maximum 68.2/57.9 ms. No matching no-background-scroll control was run in this pass, so the scroll outliers cannot be attributed specifically to GIF compositing. Warm decode caches explain some zero decode samples; do not interpret them as removal of continuous animation or compare them with historical cold software-decode savings. No native-oversized-versus-bounded A/B was repeated, so this audit does not re-estimate Phase 3.2's 5–11× historical improvement. The fixture-parent render counter changed by zero throughout; this does not count every internal ChatInterface render.

Current renderer checks establish the stronger opacity property directly: **0 source reads / 0 new Image probes**, versus 1/1 on a genuine replacement. Animated flag is set; static flag is absent; preview uses the poster, with the existing source fallback. Pure GIF tests inspect actual derivatives for frame timing, loop, transparency, bounds, reuse and cleanup. No persistent user background was imported, replaced or changed.

**Acceleration qualification:** this default-acceleration run reports `gpu_compositing=enabled`, `rasterization=enabled`, OpenGL enabled and active NVIDIA device (vendor 4318, device 11524). However complete GPU info also returns `glImplementationParts=(gl=none,angle=none)`, `skiaBackendType=None`, `inProcessGpu=true`. The host driver query works, but those incomplete/contradictory backend diagnostics prevent a definitive statement about physical compositor execution. Record this as an acceleration-requested, feature-enabled run, separately from the explicitly software-rendered transcript run. GPU execution times, texture upload costs and per-scenario VRAM changes are unmeasured; a validated accelerated whole-shell trace is still needed to close the original GPU-lag question. Near-full existing VRAM is context, not proof of its cause. No models were launched and no memory-pressure experiment was attempted.

## Persistence and lifecycle

Current real-TabProvider fixture results (test-mode counter measurements, one scenario sequence):

- Startup: **0 writes / 2 serializations** (includes initialization/hydration; not a claim of zero startup work).
- Three same-tick title updates: **1 write / 1 serialization**, final title A3.
- Status-only genuine update: **0 writes**, in-memory status changes. Duplicate status: **0 shell/tab renders** in the switch suite; source reducer returns the prior state.
- Model change: **1 write**, correct model restored in payload. Create then close: **2 writes**, correct counts and closed tab purged. Activate: **1 write**; reselect active: **0**.
- Simulated write failure preserves old durable value, later update retries successfully. StrictMode scenario performs **1 write**. Restoration/parsing and no-op pure reducers pass. No real user reload/restart was performed; persisted fixtures are not evidence of crash durability.

Retained full-history heap is stable across three repetitions: plain 600 runs **25.93–26.10 MiB**, complex 600 **50.04–50.10 MiB** after GC. Initial session remounts return to much smaller heap even after prior expansion. This argues for expected reachable transcript retention within these short runs; it does not establish a memory leak or rule out one during hours of use. Native image memory, GPU memory, full-process RSS, detached-node retaining paths and repeated real-tab memory scaling were not measured. Existing tests cover GIF derivative cleanup/replacement races, listener disposal and poll-timer cleanup. No long-duration soak or aggressive pressure experiment was run.

## Ranked concerns and next engineering action

| Rank | Concern, conditions and evidence | Confidence / smallest next step / risk |
|---|---|---|
| 1 | Expanded complex transcripts retain 55,794 elements / 50.10 MiB JS heap at 600 messages versus 1,751 / 11.49 initially; page reveal median 287 ms, p95 449 ms. Phase 2 optimizes initial mounting; Phase 2.1 bounds search jumps but ordinary exploration remains cumulative. | High confidence in retention and measured fixture cost; moderate confidence in real-workload frequency. Next: bounded variable-height transcript prototype plus equivalent profiling. Risks: anchor/follow, row-local state, search, delayed media heights. No claim that virtualization removes parsing cost of newly mounted rows. |
| 2 | Sending after complex full expansion: user row 654 ms at 100 and 1,771 ms at 600; completion 1,874/4,347 ms including a 200 ms stub wait. | Confirmed single samples; dominant function remains a hypothesis. Capture scripting/React commit trace in the same prototype comparison before selecting any separate rendering fix. Risk of misattributing storage, fixture scheduling or row work; no blanket memoization recommendation. |
| 3 | Hardware-accelerated animated-background behavior remains an evidence gap from Phase 3.2. | No confirmed GPU bottleneck in this audit. If background lag persists, obtain an actual accelerated trace with the existing bounded GIF/poster path. Do not redesign the background layer based on software-only evidence. |
| 4 | Build emits ~1,504.86 kB main JS and 598.73 kB secondary chunk (gzip 437.94/215.75 kB), with >500 kB warning. | Confirmed artifact size, not measured startup bottleneck. Defer splitting until a cold-start trace demonstrates user impact; risk of moving loading delays into interactions. |

Do not add a new state library, split all contexts or add memoization indiscriminately. Current evidence supports preserving Phase 1–6 isolation and focusing the next task on expanded transcripts. The smallest reviewable follow-up is a bounded transcript prototype and A/B measurements with a CPU trace, not a whole-app rewrite. No further implementation is authorized by this audit.

## Smallest compatible virtualization design

Keep canonical messages, persistence, inference and canonical match indexing unchanged. Replace cumulative mounted rows with a bounded viewport range plus overscan, using top/bottom spacers and a height cache keyed by **session + stable message id + content/layout revision**. Use estimated heights until measured, observe asynchronous height changes, and correct scroll position relative to an anchored visible message. Support both casual rows and WorkspaceTimeline through the same message identity contract.

- On an old search result, resolve its canonical index, set the range directly around it (as current `showTarget` already does), estimate spacer offset, mount the target, measure and correct to the exact mark/row. **Never mount the intervening messages.** Keep occurrence identity, canonical counter and highlight/fallback behavior; cap highlights only within mounted content.
- Continuously measure streaming row height. Pin the latest range only while auto-follow is active; preserve a reader's anchor otherwise. Jump to latest restores the tail range and bottom alignment.
- Preserve Markdown/code widths; invalidate height cache on width/font/theme geometry changes. Images/attachments and tool expansion need ResizeObserver-driven corrections. Keep expanded tool state and drafts/edits outside evictable row-local state where necessary.
- Deletion/edit/retry/regeneration must update canonical identities, invalidate affected heights and reconcile the anchor/search target. Production messages use `msg.id`; the positional fallback key for missing ids must not become a virtual-list identity assumption.
- Reset or scope viewport/cache state per session; do not accidentally carry an expanded range into restored sessions. Bound height-cache lifetime as well as DOM. Ensure focused editors, selection/copy, keyboard navigation, accessibility and find marks survive eviction as designed.

Expected gains: bounded element/React-tree retention and less offscreen browser/commit work. These gains are **not yet measured** with a virtualized implementation. Parsing and highlighting a newly visible complex row, canonical search scans, GPU GIF decoding and model inference remain separate costs. A bounded range of roughly one viewport plus overscan should be evaluated empirically, not hard-coded from this report's 15-row startup count.

## Verification commands and results

All final checks below exited 0. Durations are wall-clock suite/build runtime in seconds, **not interaction timings**.

| Check | Result | Runtime s |
|---|---|---:|
| unit | PASS | 5.40 |
| terminalLogIsolation | PASS | 2.15 |
| chatPagination | PASS | 2.96 |
| chatFindNavigation | PASS | 2.32 |
| sidebarAnimation | PASS | 7.90 |
| renderIsolation | PASS | 3.48 |
| palaceStability | PASS | 2.26 |
| tabContextPersistence | PASS | 1.65 |
| tabSwitchIsolation | PASS | 3.09 |
| backgroundLayer | PASS | 0.78 |
| chatInputPerformance | PASS | 5.94 |
| palacePolling | PASS | 1.60 |
| build | PASS | 8.01 |

Focused command: `node --test` followed by the explicit ten paths: `tests/terminalLogStore.test.mjs`, `tests/transcriptWindow.test.mjs`, `tests/chatSearch.test.mjs`, `tests/sidebarAnimation.test.cjs`, `tests/backgroundGifBounding.test.cjs`, `tests/backgroundSettings.test.cjs`, `tests/uiLayerOpacity.test.cjs`, `tests/tabPersistence.test.mjs`, `tests/palacePolling.test.cjs`, `tests/messageIdentity.test.mjs`. Node reports **10 passing test files, 0 failures**; several files contain plain assertions rather than separately enumerated node:test cases.

UI command pattern: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox <temporary-wrapper.cjs>`. Each wrapper sets an isolated `/tmp` userData path then requires the unchanged corresponding `tests/<name>.ui.cjs`. Names: terminalLogIsolation, chatPagination, chatFindNavigation, sidebarAnimation, renderIsolation, palaceStability, tabContextPersistence, tabSwitchIsolation, backgroundLayer, chatInputPerformance, palacePolling. Full exact invocation arrays are in JSON. Production transcript/background harnesses used the existing display rather than Xvfb.

Build: `node node_modules/vite/bin/vite.js build --outDir /tmp/continuum-phase7/build`; succeeds with the existing large-chunk warning. No Electron runtime/native dependency rebuild. The complete suite was not rerun: previous reports document environmental/native and source-assertion failures, but those historical failures are not newly reproduced or classified as current regressions here. All selected final checks pass.

## Safety, limitations and decision

Before work, `git status --short` recorded **21 modified tracked files and 38 untracked files** (exact initial listing in JSON). All pre-existing repository files were SHA-256 checked; final changed/missing pre-existing count: **0** across **525** hashed files. Only the two requested Phase 7 reports were added. No source, test, configuration, package, lockfile, dependency or persistent user data/settings were changed. No commit/push/stash/reset/clean/revert was performed. Temporary profiling scripts, build output, traces and isolated profiles are removed after evidence extraction; pre-existing `/tmp/opencode` assets were read only and preserved.

Limits remain: no live full-application production trace; no actual model inference, streamed tools/cancellation timing, multi-real-tab expanded-history timing, hour-long resource soak, physical input latency, React-only durations, full application CPU/RSS, or confirmed hardware GPU compositing. Synthetic message complexity is reproducible but cannot establish the frequency or exact cost of the user's real histories. Timing runs share an uncontrolled host; use resource/count results and repeated page measurements as stronger signals than individual wall times.

**Virtualization recommended:** measured cumulative exploration at 100/300/600 rows causes linear DOM growth, ~38.6 MiB additional retained JS heap at 600 complex messages, and meaningful page-reveal latency, despite largely responsive steady scrolling. Those concrete resource and interaction costs justify a bounded variable-height transcript prototype as the next engineering task. Preserve canonical bounded search navigation, streaming, auto-follow and anchor behavior; validate actual benefit before shipping. Stop here for review; no virtualization was implemented.
