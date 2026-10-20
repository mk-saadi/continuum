# Phase 2.6A-1 — local JS/TS LSP foundation

## Architecture and backend decision

The main-process-only `src/main/lspManager.js` owns a canonical-root registry, LSP clients, document snapshots and latest diagnostic publications. No preload, renderer bridge, prompt injection or agent tool was added. Servers launch only on an explicit internal acquire/refresh/request operation. There is no installer, hosted service, inference call, generic server configuration, or file-modifying LSP operation.

Selected pinned production dependencies:

| Package | Version | License | Installed directory size |
| --- | --- | --- | --- |
| typescript-language-server | 4.3.4 | Apache-2.0 | 2,216 KiB |
| typescript | 5.7.3 | Apache-2.0 | 22,572 KiB |
| vscode-jsonrpc | 8.2.1 | MIT | 352 KiB |

These add approximately 24.6 MiB of installed directories (filesystem allocation, not compressed installer growth). npm added three packages. The server bundles its protocol dependencies and has no native addon. Production uses the bundled TypeScript, never a global or project-selected executable. These pinned versions support Node >=18 / Continuum's >=20 baseline; adopting the latest server would increase runtime requirements. TypeScript syntax newer than 5.7 is not promised. npm reported 22 vulnerabilities across the complete existing dependency tree; no audit remediation or unrelated upgrades were performed.

The chosen server is an established LSP wrapper over Microsoft's tsserver, supporting JS/JSX/TS/TSX, project configuration and all six future operations. Native tsserver alone speaks a different protocol. Building a language engine or adopting a different project service would add unnecessary integration and packaging work. Source references: [server README](https://github.com/typescript-language-server/typescript-language-server/tree/v4.3.4), [configuration](https://github.com/typescript-language-server/typescript-language-server/blob/v4.3.4/docs/configuration.md), [JSON-RPC implementation](https://github.com/microsoft/vscode-languageserver-node/tree/release/jsonrpc/8.2.1).

## Repository inspection and preserved state

Inspection covered package/runtime dependencies, main.js quit handling, preload and trusted IPC handlers, projectManager/DB session-to-project persistence, toolPermissions (especially local execution and bwrap), agentTools scopedPath and file-version hashes, recoveryBoundary/recoveryIpc/recoveryStore, subagent agentLoop executionDeadline conventions, and existing Node/Electron test patterns. No existing LSP, TypeScript project service or suitable JSON-RPC client integration was found in application code.

Initially, many unrelated files were modified/untracked, including steering, file-version, subagent and UI work. They were not edited or reverted by this implementation. During execution those changes became part of repository HEAD `185b9bc` through an external action; this agent made no commits, pushes, stash, reset or clean operations. The isolated comparison baseline uses that HEAD, which contains the pre-existing work but none of this LSP implementation.

Existing file mutations are not centralized in a general filesystem-change bus: write/replace/multi-edit/patch/move/delete flow through agentTools and recovery boundaries; recovery restoration and external shell/editor changes are separate paths. Broadly refactoring those was deliberately avoided.

## Transport and initialization

`Client` uses vscode-jsonrpc stream framing, request IDs, correlation, notifications, protocol errors and cancellation tokens. stdout is protocol only. stderr is drained into a bounded 4 KiB internal tail. Unknown server requests receive method-not-found; apply-edit and execute-command are never implemented. A bounded outstanding-ID set filters duplicate responses before JSON-RPC dispatch, so the first wire response wins even in concatenated packets. Cancelled requests continue to count toward the wire-pending bound until a response or connection disposal, preventing ignored cancellations from growing the library pending map without limit. Stream failure or child exit rejects pending requests. Local cancellation settles promises even when the server ignores cancellation. Timers and abort listeners are removed on settlement. No renderer can supply executable paths or raw methods.

Handshake: spawn → attach connection/diagnostic listener → initialize with canonical file URI and workspace folder → validate capabilities and UTF-16 encoding/document sync → initialized → ready. Failed initialization kills the owned process group and remains failed until explicit close/reopen; there is no restart loop. Cancellation while waiting for shared initialization cancels that caller, not other chats' startup. The shared initialization itself has a bounded timeout, and workspace/app closure stops it through bounded cleanup.

## Registry, authorization and ownership

Production authorization resolves the session through `toolPermissions.sessionProject`, checks a persisted workspace root and effective `full_access` execution mode, then canonicalizes with realpath. The internal context must come from trusted main-process execution, not renderer payloads. `workspace_write` is insufficient: existing shell commands in that mode run inside bwrap, while this language server does not. No implicit unsandboxed launch is permitted in that mode. Explicit execution-approval support remains a Phase 2 integration task.

Multiple chats with the same real root share one instance/start promise. Different roots have separate processes, queues, documents and diagnostics. Symlink aliases of existing roots/files normalize to one identity. Traversal and escaping symlink ancestors fail closed. At most three instances exist; there is no eviction of active work. Failed instances count toward that bound until closed. Request methods are a fixed allowlist, capability checked, with validated positions/query input. Returned file locations are checked for workspace containment; results outside the root reject rather than silently becoming successful empty results.

This is not a filesystem or network sandbox. TypeScript may read configuration, dependency declarations and compilerOptions.plugins, and execute project plugins. An authorized trusted workspace may therefore inspect files outside its root internally. The wrapper confines input files and output locations; it cannot confine the backend's OS access. No application source is deliberately transmitted to a hosted service. Future restricted permission modes need an actual sandbox or explicit execution approval, not a claim that code intelligence is inherently read-only.

## Documents, hashes, positions and diagnostics

Extensions: js/mjs/cjs → javascript; jsx → javascriptreact; ts/mts/cts → typescript; tsx → typescriptreact. `refresh` reads actual disk bytes, computes the same canonical `sha256:<hex>` contract as Phase 2.0F, and decodes that same read for didOpen/didChange. No mtime-based identity, redundant metadata read, project file write or authoritative cache-read tool is introduced. The existing hash helper is private to agentTools; the small canonical hashing operation is reproduced without loading its DB/tool machinery.

Up to 128 documents per workspace, 2 MiB each. Initial version is 1; changes increase it. Full-sync servers receive full replacements; incremental-sync servers receive a whole-document UTF-16 range replacement. Unchanged hashes produce no notification. `saved` sends didSave only if advertised, including text only if requested. `closeFile` sends didClose. Missing open files close and clear diagnostics. Moves use close old / refresh new, or are detected as deletion plus new query path. Queries refresh all currently open files first, including imported files changed by external editors, then refresh the target. Post-response refresh rejects STALE_DOCUMENT if an observed document changed during the request. No heavyweight watcher is added.

`request` supports definition, references, documentSymbol, workspace/symbol and hover. Diagnostics are notifications, retrieved separately through internal `diagnostics`. Native null/array/object result shapes remain intact; basic shape checks reject malformed responses. Requests are serialized within a workspace so synchronized snapshots cannot be changed by another caller during an operation; transport correlation still supports concurrent pending requests, and distinct workspaces can operate concurrently. Partial-result tokens are not advertised or collected in this phase; servers return final results. This must be extended before exposing paginated workspace symbol tools.

Positions are zero-based lines and zero-based UTF-16 code units, not visible glyph columns or human-facing one-based coordinates. Node pathToFileURL/fileURLToPath handles native-platform file URIs, spaces, Unicode and Windows drive/UNC semantics on Windows. Windows behavior has not been executed on this Linux host. The tests include supplementary Unicode source and filenames; UI coordinate conversion remains Phase 2 work.

Diagnostics store only the latest publication for an open URI, capped at 1,000 entries, preserving complete individual LSP diagnostic objects and related information. null means unavailable, distinct from a publication containing []. Changed/closed/deleted documents invalidate stored publications. Matching explicit document versions are current; mismatched or absent versions are marked stale. Unversioned diagnostics cannot establish freshness and must never be presented as verified-current errors. Initialization does not imply diagnostics completion. Related information is untrusted and must pass location authorization before future UI/tool navigation. JavaScript diagnostic behavior follows project checkJs/configuration, not an unconditional correctness assertion.

## Lifecycle, limits and runtime packaging

States are stopped/starting/initializing/ready/stopping/failed. Limits: three workspace servers, 64 pending requests per transport, 20-second initialization, 15-second requests, 1.5-second graceful shutdown request and 1.5-second exit grace, zero automatic restarts. There is no idle eviction. Error codes distinguish unavailable/terminated, initialization, authorization, type/capability/method, invalid position/response, cancellation, timeout, limits and stale source.

Production launch uses process.execPath (Electron in installed builds) with ELECTRON_RUN_AS_NODE=1, fixed bundled CLI and TypeScript paths, no shell, cleared NODE_OPTIONS/NODE_PATH, hidden Windows console. On POSIX the server has its own owned process group without unref; forced cleanup kills that group so tsserver descendants are included. Windows uses taskkill /T /F for forced cleanup. Normal shutdown sends shutdown then exit. Abnormal server exit rejects pending calls and force-cleans its owned group. main.js awaits LSP close alongside existing MCP shutdown without changing llama.cpp or Playwright ownership. Project update/delete IPC closes the old workspace server; switching visible chat tabs does not close shared servers. Internal callers can explicitly closeRoot for workspace ownership termination.

Both server and TypeScript directories are included in asarUnpack. Runtime paths map app.asar to app.asar.unpacked; JSON-RPC stays in the main process. electron-builder includes production dependencies. Fresh installation is offline-capable after bundled dependency installation. Automatic TypeScript typing acquisition is disabled, so ordinary JS analysis does not invoke npm to download types; tsserver heap is capped at 512 MiB per process. No internet installer exists. Final installed AppImage/Windows/macOS smoke tests, Electron run-as-node fuse verification, license-notice packaging and compressed installer measurements remain Phase 4 packaging work. Linux real-process tests verify Node runtime behavior, not a signed/installed Electron distribution.

## Files and functions changed

- src/main/lspManager.js: Client, LspManager, fixed launch/runtime path helpers, language map, fail-closed production singleton.
- main.js: await singleton close during existing before-quit cleanup.
- src/main/ipcHandlers.js: close previous workspace server after project root update or deletion.
- package.json/package-lock.json: three pinned runtime dependencies and unpack rules.
- tests/lspFoundation.test.cjs: transport/lifecycle/security/document and real-server integration tests.
- this report and companion verification evidence JSON.

## Integration evidence and timings

A temporary tsconfig project contains an exported numeric definition, an importing module with intentional string assignment error, a TSX file and a JS file. Real bundled server initialization, document opens, error 2322 publication, definition/reference/hover results, disk edit synchronization, error clearing and process termination are asserted. No model inference or paid API is used. The diagnostic polling test explicitly waits for publications rather than assuming completion after initialization.

Representative first passing run: startup 88.8 ms; warm hover 4.3 ms; final document sync 0.49 ms; initial diagnostics after opens 1,233.6 ms; shutdown 7.5 ms. Later runs and final test totals are recorded in companion evidence. These are one-host observations, not performance guarantees. The restricted execution sandbox closes real child stdio immediately; real-server verification therefore ran with permission to launch local child processes.

## Verification and regression comparison

The initial `npm test` command fails before loading suites on Node 22.23.2 because `node --test tests/` treats tests/ as a module: 1 failed runner entry, 0 passes. This existing script was not changed. Explicit file globs are required on this host.

The initial restricted explicit-glob baseline reported 197 file entries, 166 passes and 31 failures; the same restricted post-change run preserved every existing failure identity, adding only the real-server test blocked by sandbox stdio. These are file-level runner totals, not the complete nested assertion counts available outside the sandbox.

A second baseline was exported non-destructively to /tmp from HEAD 185b9bc, without LSP files, and executed from its own cwd with the same local-process permissions as integration. It reported 1,454 tests, 1,429 passes, 25 failures, 0 skipped/cancelled. An earlier unrestricted post-change run (four LSP tests) reported 1,458 tests, 1,433 passes, the identical 25 failure identities, 0 skipped/cancelled. Final run: **1,464 tests, 1,439 passed, 25 failed, 0 skipped/cancelled; no new failure identities**. All **10 focused LSP tests passed**. Counts and all 25 identities are in companion evidence.

The Electron fileBrowser.ui.cjs Xvfb run failed on “Actual local image loads through protocol and CSP” both on the isolated baseline and with changes. This is a reproduced baseline failure. The complete 60-file Electron UI catalog was subsequently executed under Xvfb, with failing files checked against the isolated baseline; **56 passed, 3 failed, and 1 timed out**. The failures were contextPanel.ui.cjs (token-savings copy assertion), skillProposalProjectId.ui.cjs (card never rendered), and sliderField.ui.cjs (renderer script failure). Each reproduced on the baseline, with the slider checked again after a baseline build. transcriptVirtual.ui.cjs exceeded the same 60-second timeout on both current and baseline sources. There were no new failing UI file identities; the timeout is not counted as a pass. Detailed output is in companion evidence. In that catalog run the fileBrowser test passed, so its earlier failure was environmental/intermittent. The full Node suite includes file-version, workspace tools/permissions, IPC, context/recovery and subagent suites. Baseline/final production Vite builds passed, both with the existing >500 kB chunk warning. No unrelated baseline failures were fixed.

## Remaining limitations and Phase 2 handoff

1. Do not register raw request or launch APIs over IPC. Add only the six explicitly named read-only tools in the next phase with trusted session context, existing execution permission/approval gates, bounded result budgets and untrusted-text treatment.
2. Add explicit unsandboxed LSP execution approval if supporting ask_approval/workspace_write; until then production startup is full_access only. Never substitute read permission for execution trust. Consider project-plugin restrictions or a genuine sandbox before broader enablement.
3. Tools must interpret native result shapes, translate one-based human positions to UTF-16, authorize all returned locations/diagnostic related information, and report unsupported capability / timeout / cancellation / stale source as failures.
4. Mutation events are not eagerly wired to write_project_file, str_replace_editor, edit_project_files, apply_patch, move/delete, browser edits or recovery restore. Refresh-before-query covers their disk changes, including external shell/editor changes. Wire saved/closeFile/refresh after successful committed mutations if immediate background diagnostics are needed; preserve recovery and conditional-write behavior. Unopened newly created files are opened on demand, not preloaded.
5. No push diagnostic UI exists. Treat unversioned/stale diagnostic publications as unverified. Add a reliable diagnostic readiness/version strategy before claiming diagnostics correspond to current source. A dedicated real JS-only/no-config hover fixture passes; no unconditional JS error-checking behavior is claimed. Windows URI behavior still needs execution on its target platform.
6. Partial-result aggregation, pagination, workspace symbol budgets, document eviction, idle policy, application-shutdown E2E and full installed-platform lifecycle testing remain unimplemented. Explicit closeRoot/reopen is the only restart mechanism. Failed instances retain a bounded registry slot.
7. Deterministic tests exercise key protocol/lifecycle/authorization cases but do not individually cover all 50 requested scenarios: real JS-only/no-config diagnostics, Windows/macOS and real process-tree forced-kill tests remain useful hardening. Standard JSON-RPC framing/correlation are delegated to the established library.

Phase 2.6A-2 was not started; no model-facing LSP tools are available.
