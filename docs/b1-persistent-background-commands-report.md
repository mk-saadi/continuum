# B1 — Persistent background commands

## Behavior and changed files

- src/main/backgroundCommands.js: retain explicitly persistent records/processes on normal run completion, detach the originating run signal, preserve application ownership, record expiration and termination causes, stop detached processes during session termination/deletion and shutdown.
- src/main/tools/agentTools.js: add survive_run_completion:boolean (default false, requires background:true), document finite lifetime semantics, retain the guarded executor and backend selection, and validate persistent commands against current session policy and canonical workspace.
- src/main/lspExecutionContext.js: separate persistent policy revision from per-run authorization revision. Same-mode run creation or permission synchronization does not revoke a persistent command; actual mode changes, rule invalidation, forgetting, and policy-cache eviction revoke it.
- src/main/ipcHandlers.js: keep closeRun in finally; allow persistence only after successful normal completion. Add session-scoped UI Stop and cleanup on explicit session cancellation.
- src/preload.js: expose scoped Stop IPC.
- src/components/chat/BackgroundCommandCard.jsx: existing panel displays persistence, remaining lifetime, bounded output, Stop, and readable termination cause. Refresh while mounted so detached command changes remain visible.
- tests/backgroundCommands.test.cjs, tests/backgroundCommandIpc.test.cjs, tests/backgroundCommands.ui.cjs: lifecycle, real HTTP, IPC, and panel regressions.

The pre-existing WorkspaceTimeline.jsx modification was preserved. No commits, live database edits, sandbox/network changes, or unrelated MCP services were used.

## Ownership and authority

Records keep command_id, originating run_id, session_id, canonical workspace, persistence flag, start/expiration timestamps, status and reason. The registry, executor, process-group cleanup, concurrency limits (2 per originating run, 4 application-wide), 200-record history, 32-record per-run capacity, and bounded output are reused.

Lifetime alone does not imply persistence. Persistent commands use the same initial shell grant, approval requirements, and selected execution backend. Their ongoing validator uses current session policy revision/mode, current session project, and canonical workspace rather than a completed run's tool advertisement or signal. Later native status/stop calls still traverse current authorization and require an active matching session/workspace run. UI Stop resolves the workspace from the trusted session rather than accepting a caller-supplied workspace or PID.

Existing execution statuses remain intact. Reasons include user_stopped, owning_run_ended, owning_run_cancelled, lifetime_expired, permission_revoked, session_deleted, session_terminated, application_shutdown, agent_deadline_exceeded, process_completed, unexpected_process_exit, and application_interrupted. Restored stale records never claim running and are never restarted.

## Verification

Final focused command:
node --test tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/backgroundExecution.test.cjs tests/commandExecutionReliability.test.cjs tests/nativePermissions.test.cjs tests/toolPermissions.test.cjs tests/permissionPolicy.test.cjs tests/permissionIsolationReliability.test.cjs tests/casualToolAuthorization.test.cjs

Result: 84 tests, 83 passed, 0 failed, 1 existing optional beyond-45-second test skipped. The unrestricted run exercised Linux sandbox tests as well as authorized Full Access host execution.

The initial restricted HTTP attempt failed with listen EPERM from the outer test environment. Re-running the isolated fixtures with approved host execution allowed localhost binding. Registry/executor reproduction: HTTP 200 before normal run closure, HTTP 200 after closure and a later same-session authorization context, unreachable after scoped stop. The real engine:chat integration also returned normally with its HTTP server reachable, then UI Stop IPC terminated it and HTTP became unreachable. Tests use temporary workspaces/databases and disable MCP initialization.

Before: the supplied request reports the original 30-minute server becoming unreachable about 411 ms after normal closure. That timing was not independently remeasured against the original code. After: the above real HTTP and engine:chat regressions pass.

Production build: npm run build passed; Vite reported its large-chunk advisory.
git diff --check passed.
Isolated Electron panel fixture: 10 checks passed, including persistent lifetime, session-scoped Stop, and termination cause.

## Limits

No packaged-app/manual GUI end-to-end session was exercised. The panel was tested in an isolated Electron renderer and the production IPC lifecycle separately. No 30-minute wall-clock soak was performed; short finite-lifetime tests verify expiration. Switching session contexts is covered at the registry/renderer boundary rather than through a full packaged tab interaction.

Processes are not adopted or restarted after app restart. An unclean crash leaves the actual process outcome unknown. Existing POSIX process-group cleanup cannot guarantee termination of descendants that deliberately escape the group. Workspace Write networking/localhost policy is unchanged; HTTP reachability was tested using the authorized Full Access backend.
