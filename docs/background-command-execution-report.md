# Background command execution — Phase 2.2B

2026-10-21, Asia/Dhaka. Implementation only; no commits, pushes, resets, stashes, paid inference, new execution engine, or daemon. All pre-existing working changes were preserved. The Phase 2.2A report and current implementation were inspected before changes. Test logs are in `/tmp/continuum-bg-audit/` and are ephemeral; the adjacent evidence JSON retains counts, identities, and measurements.

## Architecture and tool contract

`execute_command` still enters `executeAgentTool`, the existing live permission guard, cwd containment, shell recovery boundary, `executeCommand`, and `foregroundCommand.runForeground`. The new `backgroundCommands.js` is an ownership/history/notification registry. It has no spawn, shell, or process-killing implementation. It runs the exact same recoverable operation asynchronously. Foreground arguments, results, timeout defaults and cleanup remain compatible. The shared lifecycle helper adds optional spawn/output observers and handles output-stream errors with a truthful `output_capture_failed` termination.

New arguments on `execute_command`:

```json
{"command":"npm run build","background":true,"timeout_ms":180000}
```

`background` must be boolean. Missing/false preserves foreground execution. `timeout_ms` remains an integer in 1000–300000, default 60000. An explicit alternative for background servers is `background_lifetime_ms`, an integer in 1000–1800000, mutually exclusive with `timeout_ms` and requiring `background:true`.

Startup returns a UUID-based `cmd_…` ID, `background:true`, `status:starting`, timestamps and ownership metadata. Recovery preparation and spawn happen asynchronously. **Starting is not command success:** exitCode is null, there is no invented successful exit, and eventual spawn failure is retained and notified. `running` is published on the actual subprocess spawn event. Effective timeout and process-start timestamp are then recorded. IDs are reserved before scheduling the operation.

New tools:

```json
{"name":"get_command_status","arguments":{"command_id":"cmd_…"}}
{"name":"stop_background_command","arguments":{"command_id":"cmd_…"}}
```

Both reject unknown arguments, invalid IDs and mismatched session/workspace ownership. They require a trusted active main-run context, supplied by IPC rather than model arguments. Status includes current bounded output and terminal metadata. Stop aborts only the registered operation, awaits its existing tree cleanup and recovery scan, and returns its actual terminal outcome. Repeated/concurrent stops are idempotent; stopping an already successful command preserves success. A later main run in the same session/workspace may inspect retained history, but old completion events never enter that new run.

## Ownership, lifecycle and limits

Main `engine:chat` registers the existing main-process run UUID, database session ID, canonical workspace root and run AbortSignal. Canonicalization is synchronous before active-run registration, preserving the existing no-overlapping-runs check. Tool arguments cannot select these identities. The manager independently checks all three. Model-facing records omit process IDs, controllers, signals used for cancellation, callbacks and promises. An internal PID is held only for tracking; cleanup stays in the shared executor. No environment values are exposed.

States reuse foreground conventions: starting → running → completed/nonzero_exit/timed_out/cancelled/spawn_failed/agent_deadline_exceeded/output_capture_failed. Startup can go directly to a terminal state. A completed registry record has no live observer capable of returning it to running. The single operation promise owns terminal settlement. End time, duration, nullable exit code, termination signal, effective timeout, truncation, recovery evidence and notification state survive settlement.

Limits are fixed and conservative: **2 active per run, 4 active application-wide**, no queue. Foreground work is outside these slots. There are at most **32 commands per run**, including retained notifications, and **200 retained commands application-wide**. Excess starts fail clearly before execution. Old terminal delivered/undelivered records are evicted on subsequent starts; queued/included rows are never silently evicted. Startup reconciles and caps durable history to 200. This is a bounded registry, not a job scheduler. SQLite log storage is bounded by record count and existing per-command capture/recovery limits; no separate log files or pagination exist.

## Lifetime, finalization and servers

There is no unlimited lifetime. Normal background commands default to 60 seconds; normal timeout_ms is capped at five minutes. Explicit background_lifetime_ms permits up to **30 minutes**. The existing armed agent deadline can shorten either allowance. Output or silence never renews it. Timeout remains distinct from run cancellation/deadline expiry.

**All remaining commands are cancelled when their owning run ends**, including when the model returns a final answer before a finite command finishes. The runtime awaits cleanup, retains the real result, and records undelivered completion. It does not claim the model received that result. This deliberately conservative policy means a development server is useful while the agent continues source/browser work, but will not remain available after the run. It is not a persistent preview service. The model-facing contract states that startup is not completion and that commands stop at run end. No readiness detection is implemented: printing a Local URL leaves the command running.

Up to four queued events enter each inference checkpoint. A completion arriving during final generation may trigger up to **four extra finalization continuations**, using the same run and existing request loop. No request is interrupted, no partial generated response is rewritten, and unfinished processes do not keep inference alive indefinitely. Remaining events at the cap are retained as undelivered at closure. No new conversation, persisted user message, or independent agent run is created.

## Automatic completion delivery and context

Terminal settlement queues one completion on the original run/session/workspace. The request loop consumes it before constructing the next model payload, **after queued user steering**. A final-response race uses the same checkpoint on a bounded continuation. Notifications contain compact JSON metadata: command ID, sanitized/truncated command summary, state, exit code, signal and duration, plus a retrieval hint. Full logs and stderr instructions are never automatically injected.

Runtime events use an explicitly framed ordinary conversation message (`[Runtime background command events; no new user instruction]`). This is internal wire context, not a new user message persisted in the UI, a forged model tool result, or a high-priority system instruction. Retrieved command output remains untrusted data. The original startup tool-call/result pairing is unchanged. Context recovery preserves these events in the existing current-run tail; real request construction and the existing payload budget gate account for the additional text. No persistent history block or compaction redesign is added.

Delivery states are separate: pending (not terminal), queued, included (durable transport claim), delivered (HTTP/provider adapter accepted the request), undelivered, and ambiguous (restart found a claim without durable acknowledgment). Acceptance proves transport acceptance, not model reasoning or successful parsing of a whole response. Claim persistence must succeed before sending an event. If it fails, the event stays queued. If acknowledgment persistence fails, an included disk row reconciles as ambiguous; ordinary execution does not duplicate it. Request rejection marks the claimed batch undelivered. A hard crash can still lose recent output or the terminal write; stale running rows are cancelled with an explicit unknown-process-outcome interruption, never fabricated success.

## Persistence, failure handling and shutdown

Records use a small table in the **existing SQLite database**, initialized with its existing schema. Startup restores bounded history and reconciles active rows; it never restarts a command or reattaches an old notification to a new run. Initial durable registration failure denies startup before running the operation. Terminal persistence failure retains the truthful bounded result in memory with a persistence error. Notification claim failures defer delivery; acknowledgment ambiguity survives restart as described above. A command failure does not throw out of its settlement promise or crash Electron.

A stop, owning-run AbortSignal, run end, permission revision change, or Electron shutdown aborts the managed operation. The existing POSIX process group SIGTERM → 250 ms → SIGKILL → bounded drain behavior remains authoritative, including descendants after shell exit. Windows retains the existing taskkill /T, then /F path. `before-quit` awaits both background registry cancellation/recovery and the foreground helper, alongside existing MCP/LSP shutdown, before database closure. No OS-level crash-safe descendant cleanup is claimed. Deliberately daemonizing Full Access programs can escape ordinary POSIX groups; unchanged bwrap containment provides the stronger Workspace Write boundary on Linux.

Permission revisions are checked before preparation, immediately before spawn through the existing authorization callback, and every 50 ms while a background operation is active. Any revision change conservatively cancels it, including mode transitions that later return to the same value. Terminal outcomes are not rewritten by later revocation. Read Only cannot execute; Ask for Permission retains the existing exact-command approvals for operations requiring them; Workspace Write keeps bwrap and its existing command classification; Full Access keeps direct execution. Status/stop are scoped safety operations classified as reads so an owner can stop after a downgrade. Actual child execution still uses the independent read-only tool allowlist; none of the three background capabilities is added to it, and no child inherits a background run context.

## Activity, work log, steering and plans

The existing Activity sidebar contains one small background-command card, loaded through the usual trusted IPC/data-access wrapper. It subscribes to session-filtered pushes and merges snapshots without overwriting newer events. It shows running count, summary, ID, status, start, duration, exit, bounded output preview, truncation and delivery state. Agent informed, queued, and undelivered are distinct. There is no terminal dashboard or UI redesign. Activity is loaded from retained session history after a chat switch/restart.

At a completion checkpoint, the existing execution step is refreshed with truthful terminal evidence for Activity persistence and the existing per-turn work digest. This does not rewrite the startup tool result in the model transcript. The original plan is untouched. Steering keeps its own queue and acknowledgments, entering before completion events at the normal checkpoint. A completion-only finalization does not drop a queued steer: the next iteration drains it before constructing that request.

## Verification and evidence

The adjacent JSON records exact final counts and failing identities. Fresh pre-edit restricted baseline: **176 passed / 30 failed test-file entries**, 36.771 s, no skips; build passed in **7.15 s**. These are file-entry counts from the restricted Node runner, not individual enabled assertions. Historical Phase 2.2A figures were not used as a fresh enabled baseline.

New deterministic coverage uses real native dispatch and real local subprocesses on Linux. It covers schemas, invalid arguments, startup versus terminal state, live output, nonzero exits, timeouts, bounded head/tail output, per-run/app limits, scope rejection, concurrent/repeated stop, sibling cancellation isolation, permission revision cancellation before execution, required approvals, child allowlist preservation, record/claim persistence failure, notification capacity, ambiguous restart recovery, rejected transport, compaction/recovery tail preservation, bounded final-response continuation, plan retention, work-digest evidence, and multi-run shutdown.

Four streamed model-loop cases use a deterministic SSE fixture: local Workspace Write success/failure and cloud-shaped mock success/failure. They call the real native dispatcher, do an independent directory inspection while the command is active, receive the completion automatically on a later inference, preserve steering and the durable plan, and assert one notification, matching run identity, actual exit code and output. No model polling or additional user message discovers completion. Test-side status checks only synchronize/assert fixture execution; they are not model calls or runtime delivery logic.

The additional real **engine:chat IPC** fixture mints the main run UUID, starts a bwrap-contained Workspace Write command, inspects the directory, submits actual steering IPC, holds final generation until process completion, and receives a fourth-request continuation with the automatic event. It verifies original run UUID, exit 0, IPC_BUILD_OK, execution-step evidence, retained session history and Agent informed push. It passes without inference/network calls.

The Electron component fixture passes **7 checks** for Activity running count, terminal count, bounded output, queued versus informed, retained undelivered state, and cross-session filtering. This is a renderer fixture, not a claim of manual packaged-app verification.

Existing foreground tests exercise absolute timeout, deadline, cancellation, descendant cleanup after shell success/TERM, spawn error, Windows taskkill mocks and foreground shutdown. The opt-in 46-second Phase 2.2A test remains skipped in ordinary runs; it was not rerun for this phase. Broader steering, context recovery, child, permissions, verification, MCP and LSP suites are included in regression runs. No unrelated baseline failures were changed.

An early failure in the new persistence-fault fixture used the db facade's nonexistent exec method; it was corrected to use the existing connection. Restricted test subprocesses also route Node console writes through inherited test transport; deterministic child fixtures now use direct fs pipe writes like the existing foreground tests. Neither fixture issue changed production execution semantics.

## Final regression comparison and measurements

- New background coverage: **19 manager/dispatcher/loop/failure cases plus 1 real engine:chat IPC case**. Final focused command/IPC/permission/child/steering/recovery/verification group: **98 passed, 0 failed, 1 skipped** in 8.218 s. The skip is the existing opt-in 46-second foreground test.
- Restricted full suite: **178 passed / 30 failed file entries**, 39.019 s, versus fresh **176 / 30**. Exact new/resolved failing identity sets are both empty. Both added test files pass. A loaded intermediate run transiently failed untouched subagentDispatchConcurrency; it passed 11/11 in isolation and passed the repeat full restricted run. It was not modified.
- Final enabled full suite: **1588 passed / 12 failed / 1 skipped**, 52.451 s. Failure locations are attachments, cloud IPC, engine settings, filesystem/MCP cap initialization, two MCP IPC assertions, message actions/stats, RAG, skill import/proposal IPC and subagent runner. Every failing file appears in the fresh restricted baseline. There was no untouched enabled assertion-level baseline; this is not an assertion-by-assertion enabled before/after claim. Exact identities/locations are in the evidence JSON.
- Electron Activity fixture: **7 checks passed**. Final production build: **passed in 18.91 s**, with the existing chunk-size warning. Syntax checks and git diff --check passed.

One final focused-run host sample measured **1.354 ms** for immediate native tool response, **7.461 ms** to actual process-start publication (including preparation and durable writes), and **0.012 ms** for in-process manager status retrieval. Completion queueing to acknowledgment was **14.178 ms**, including the test's checkpoint scheduling; claim/ack work at that checkpoint took **3.084 ms**. Real provider generation or a longer independent tool delays the next checkpoint; these are fixture samples, not production latency guarantees.

Two concurrent controlled Node children reported RSS samples of **44,154,880** and **44,048,384 bytes** (88,203,264 combined sample, excluding shells and shared-memory accounting). Parent RSS delta in that sample was **0 bytes**; a zero sampled delta does not mean zero allocation or overhead. Each stream retains **16,384 characters plus an omission marker**, with the existing final display projection. A TERM-ignoring server-like stop settled in **358.920 ms** and its controlled PID was no longer executing. The sampled compact completion was **441 UTF-8 bytes**. The three command schemas serialize to **2,220 bytes**; all native schemas grew from **34,080 to 35,223 bytes** (**+1,143 bytes**). Token counts depend on the model tokenizer and are handled by the existing real payload gate rather than inferred from these byte counts.

## Platform verification and remaining limits

Linux: actual bwrap Workspace Write execution, real main IPC/agent loop, Full Access command path, forced TERM-ignoring process stop, timeout/cancellation, output bounds, live revocation and registry shutdown tested. Process PID checks confirm the controlled stopped descendant no longer executes. Existing shared foreground tests cover parent-exit descendants and cleanup isolation. Server readiness text is explicitly tested as running, then stopped.

Windows/macOS: code reuse and existing Windows lifecycle mocks only; no native host was available. Manual validation is still required for native shell quoting/executable resolution, process trees after parent-shell exit, cancellation, and packaged quit. The existing contained-shell platform policy is unchanged: bwrap is Linux-only; other platforms require the existing approved/uncontained policy. Windows may need Job Objects for guarantees beyond taskkill. Uninterruptible or intentionally escaping processes and abrupt OS/process crashes are not universally covered.

Other limits: a 30-minute explicit lifetime is still cut short by run end; history is bounded and eventually evicted; logs are bounded, not a complete build archive; no readiness probe, daemon reconnection or restart replay exists. Concurrent whole-workspace recovery snapshots have the same external-write ambiguity as existing concurrent foreground operations. A command finishing after the last safe finalization checkpoint can be retained undelivered. An accepted transport request does not prove semantic model consumption.

## Manual Continuum checks

1. In a disposable Workspace Write project ask the main agent to run a finite build with background:true while inspecting source. Confirm a command ID with null exit first, independent Activity, one automatic result, unchanged run ID and plan, and actual exit/output afterward. Repeat with a failing build and with cloud provider mocking, without paid inference.
2. Start a controlled server with explicit background_lifetime_ms:1800000; confirm readiness text leaves it running. Inspect through existing browser tools if available, then stop by command ID. Verify descendants are gone and a sibling command remains alive. Repeat stop after completion.
3. Queue steering during a build and downgrade permission before another command spawns, then while one runs. Confirm no unauthorized spawn and only owned operation cancellation. Read Only/child agents must not gain shell access or parent output.
4. Switch chats/workspaces, return, and inspect Activity. Verify no completion/output crosses ownership boundaries. End a run before command completion: verify cancellation and retained undelivered result, without an extra user message or new run.
5. Quit the packaged app with multiple owned commands. Verify processes stop before database closure. Restart and confirm terminal history, stale interrupted rows reconciled, ambiguous claims labeled, and no commands restarted. Repeat natively on Windows and macOS with quoted paths and parent-shell-exit descendants.

## Files changed for this phase

- `src/main/backgroundCommands.js` (new registry, persistence, ownership, notifications).
- `src/main/foregroundCommand.js` (optional state/output observation and capture errors; pre-existing untracked Phase 2.2A helper preserved).
- `src/main/tools/agentTools.js` (schemas and background branch in existing path).
- `src/main/toolPermissions.js` (two scoped status/stop capability mappings only).
- `src/main/db.js` (existing database table and reconciliation).
- `src/main/ipcHandlers.js` (main-run ownership, safe delivery hooks, Activity history/push and closure).
- `src/lib/memoryChat.mjs` (checkpoint injection/ack, bounded finalization, step evidence).
- `main.js` (await background shutdown alongside existing cleanup).
- `src/preload.js`, `src/components/RightSidebar.jsx`, `src/components/chat/BackgroundCommandCard.jsx` (existing Activity integration).
- `src/main/promptBuilder.js` (server lifecycle guidance).
- `tests/backgroundCommands.test.cjs`, `tests/backgroundCommandIpc.test.cjs`, `tests/backgroundCommands.ui.cjs` (new coverage).
- This report and `docs/background-command-execution-evidence.json`.

Other modified/untracked files shown by git status predate this phase. No later development phase was started.
