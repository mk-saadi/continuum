# Playwright MCP connection investigation

Date: 2026-10-21. No production changes, installs, browser downloads, commits, stashes, or security changes.

## Diagnosis and scope

**Verification blocker precisely isolated:** spawned children in this execution environment do not receive the parent's piped stdin; a standalone Node child observes immediate EOF. Child stdout/stderr also do not reach parent pipe listeners. This reproduces independently of Continuum, MCP, and Playwright. The environment's underlying pipe implementation/restriction is not observable here; attributing it to a specific OS policy would be speculation.

This explains the observed early stdio closure and prevents using this environment to establish a Continuum desktop defect. It does not establish that the original desktop session had the same cause. Following the request's environment-only stop instruction, no production workaround or error-reporting patch was invented. Existing production errors remain terse; the structured evidence artifact supplies investigation diagnostics only.

## Baseline and inspection

Ran `git status --short` before editing. The starting tree already contained 20 modified and nine untracked files, including manager, trust, permissions, agent, model and LSP work. All were preserved. No AGENTS.md was found under the project parent.

Read the dynamic activation report and evidence; inspected manager validation, spawn, stdio handshake, tool pagination, change notifications, closure, serialized management and shutdown; bundled Playwright launch/prepare/trust logic; Workspace Write guard; dynamic activation tests; IPC request-boundary schema refresh and dispatch; preload MCP methods; main-process startup/shutdown; and package runtime/asar configuration. No LSP, permission-isolation or context-recovery investigation was undertaken.

Fresh full baseline: `node --test tests/*.test.cjs tests/*.test.mjs`: **203 file entries, 167 pass, 36 fail**. All 36 failing identities match the prior report exactly (see evidence JSON); no added or resolved identities. The aggregate runner reports file failures, so these are not assertion counts. Relevant failures were inspected directly: manager's real stdio discovery assertion gets zero tools with `Connection closed`; SSE HTTP binding fails with `listen EPERM: operation not permitted 127.0.0.1`. Unrelated failures were not repaired or declared harmless.

`node --test tests/mcp*.test.cjs`: **8 files, 5 pass, 3 fail** (manager, IPC, SSE). Direct `node tests/mcpManager.test.cjs`: four assertions pass, real stdio discovery fails. Direct dynamic activation file: **7/7 pass**. Node 22 rejects an attempted `--test-isolation=none` diagnostic option; direct test-file execution was used to obtain assertion details instead.

## Reproduction and startup stage

1. Build the existing `nativePlaywrightConfig('/tmp')` without invoking the browser installer.
2. Call the actual `McpManager.connectServer('playwright-native', definition)`.
3. Observe error status, empty tools and `MCP error -32000: Connection closed`.
4. For stage tracing, wrap the installed SDK transport's public start/send/message/close callbacks in a disposable `/tmp` diagnostic script, leaving production sources untouched.

Observed sequence in all three runtime probes: configuration resolved → spawn attempted → child PID assigned / transport start completed → initialize request handed to transport → transport closed → manager error with zero tools → manager shutdown. No initialize response, initialized notification, list-tools exchange, or ready status occurs. No timeout or transport error callback was observed. No stderr was received; absent stderr is not evidence of an error-free child.

The direct Playwright subprocess exits **0, signal null**, before any protocol reply. A standalone Node control writes a start marker to `/tmp`, receives immediate stdin `end`, writes an EOF marker, and exits 0; its `data` handler never runs despite the parent writing `continuum-probe` on spawn. An independent child executing console output and `process.exit(23)` exits 23 with neither stdout nor stderr delivered. This proves children execute and exit status is available, while the expected pipe communication fails. It rules out missing Playwright packages and browser dependencies as necessary explanations for this reproduced transport failure. No private SDK process fields were used to infer manager-child exit status.

## Runtime and configuration findings

| Environment exercised | Result |
| --- | --- |
| Direct Node subprocess | Playwright exits 0 without protocol response |
| Actual manager under Node 22.23.2 | initialize sent; closure before response |
| Actual manager under development Electron 44.7.0, Node 24.21.0, RUN_AS_NODE | same closure |
| Actual manager under existing packaged executable, RUN_AS_NODE | same closure |
| Desktop Electron main process / GUI | not exercised |
| Packaged app.asar integration and desktop lifecycle | not exercised |

The packaged-runtime probe loads workspace source and dependencies with the packaged executable. It is not a packaged application acceptance test. PID/timing/runtime details and non-secret launch fields are captured in the evidence JSON. Launch arguments contain only local CLI/browser paths and supported headless/executable options; no environment values or credentials are recorded.

The installed bundled CLI and Chromium executable are present. Config uses `process.execPath`, `ELECTRON_RUN_AS_NODE`, explicit headless Chromium executable, and supplied config directory as cwd. CLI supports these options in the existing local installation. Package config unpacks Playwright dependencies; native resolution maps app.asar paths to app.asar.unpacked. The representative Electron probes demonstrate executable Node mode works. They do not validate every packaged path. Existing prepare logic may install a missing browser; it was deliberately not invoked in this investigation. No missing installation component was established. Writable profile/cache requirements and browser shared-library availability cannot be validated before browser launch.

## Authorization, same-run behavior and lifecycle

Existing seven deterministic dynamic-activation tests pass. They cover exact bundled trust identity, substituted-command/config-race rejection, permission modes, four local/cloud and JSON/SSE real-loop variants, activation followed by refreshed schema and tool invocation, result pairing, repeat activation without reconnect, chat isolation, deactivation, cancellation before startup, Manual mode, and steering delivery. The trust exception revalidates disk configuration inside the manager queue. No executable trust or generic MCP tool policy was broadened.

These tests exercise injected transports, not real Playwright initialization. They do not prove persisted Electron run ID, plan database continuity, desktop steering, arbitrary browser-side-effect safety, or every lifecycle scenario. Existing general MCP payload policy remains unchanged. Real Workspace Write activation, inspection and approval behavior in the desktop remain unverified.

Failed startup exposes no tools, and the real manager's close completes in the probes. Direct control children emit close/exit. SDK close retains its existing stdin-end / bounded signal cleanup. No new process manager or restart behavior was added. No comprehensive orphan-process audit, timeout/protocol fault matrix, shutdown race test or successful real restart is claimed.

## Browser smoke and regression

Real initialization **failed before response**. Navigation, DOM inspection, screenshots, and real same-run browser execution are **incomplete**. Local HTTP is prohibited (`EPERM`); a file-backed page cannot repair the missing MCP handshake, so browser navigation to it was not attempted. No sandbox bypass was attempted.

Full regression and focused results above are fresh baseline results. Since subsequent changes are documentation only, no second production regression run was needed. The full suite includes existing agent, permission, subagent, steering, LSP and IPC files; exact failures remain recorded without assigning unrelated causes. Interactive Electron UI tests were not run.

`npm run build`: **passed**, 24.73 seconds, existing large-chunk warning. `git diff --check`: passed. No new production regression has been introduced by these documentation-only additions; the baseline suite remains failing.

## Files changed and remaining work

Only these new files were added by this investigation:

- `docs/playwright-mcp-connection-repair-report.md`
- `docs/playwright-mcp-connection-repair-evidence.json`

The exact original desktop cause, successful real browser workflow, packaged app.asar behavior, complete lifecycle matrix and actionable production error-reporting change remain unresolved. There is no confirmed Continuum defect to fix on this evidence. No new mock tests were added that would imply real-server success.

## Manual Continuum verification

In an ordinary desktop environment with functioning subprocess pipes, use a disposable workspace and local page. Select Auto, leave bundled Playwright inactive, select Workspace Write, and record the existing run ID and task plan. Steer the active agent to inspect the page. Confirm trusted activation needs no redundant approval, reaches initialized/tools-listed/connected, refreshes schemas at the next inference boundary, and navigates, inspects and screenshots within the original run. Confirm result pairing, plan and steering continuity, and no duplicate launch. Disable and verify stale tool rejection; restart and close the app while monitoring child termination. Repeat Manual, Read Only, Ask for Permission and a substituted launch config to verify existing authorization gates. Browser operations with side effects still require their appropriate authorization. Capture child stderr and exit status locally if the handshake still closes; do not infer a cause from `Connection closed` alone.
