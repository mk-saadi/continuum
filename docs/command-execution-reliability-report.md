# Foreground command execution reliability — Phase 2.2A

2026-10-21, Asia/Dhaka. No commits, paid inference, background execution, permission expansion, or packaging changes. Pre-existing working changes were retained.

## Symptom, reproduction and cause

The native `execute_command` branch passed a literal `45000` to `runScopedCommand` and Node `exec`/`execFile`. Its schema exposed no timeout option. This is a confirmed execution-layer cause matching the approximately 45-second symptom, rather than evidence of a model, IPC, inactivity or parent-budget timeout. An actual dispatcher call in a disposable project requested a deterministic 46-second process: **45,068 ms elapsed**, `timedOut:true`, synthesized `exitCode:1`, no success output. The original pagoda session was not replayed, so this does not attribute every historical failure to this layer.

Other confirmed defects: the callback runner accumulated up to a 16 MiB `maxBuffer` before presentation truncation, could terminate output-heavy commands, fabricated an exit code for termination, and targeted the shell rather than its process group. Existing line-based truncation did not bound single enormous lines. These are corrected within the existing native dispatch path.

## Architecture and authorization

Main IPC `executeTool` guards the exact arguments, passes its run AbortSignal and approval to `executeAgentTool`, then records the returned result in the original loop. Native dispatch independently resolves live permission mode, approval revision, contained cwd and workspace. `runScopedCommand` performs the existing shell recovery snapshot, revalidates authorization immediately before execution, and executes the existing sandbox/direct branches. The bwrap filesystem bindings, private workspace home/temp, namespace flags and fail-closed platform policy are preserved.

Read Only continues to deny execution. Ask for Permission retains contained execution and exact-operation approval requirements; `user_confirmed` remains non-authoritative. Workspace Write retains bwrap containment and system-operation approval. Full Access retains direct shell execution. Increasing timeout changes neither command classification nor workspace/executable authorization. The existing queued-command revocation fixture passes without weakening the guard.

Native `run_tests` shares this path and retains its separate verification verdict. No second command tool or service is introduced: `foregroundCommand.js` is a small subprocess lifecycle helper owned by the existing dispatcher.

## Timeout contract and deadlines

Both tool schemas accept optional integer `timeout_ms` in **1000–300000 ms**, with **60000 ms default**. Non-numeric, fractional, negative, null, too-small and excessive values are rejected consistently; there is no unlimited value. Previously `run_tests` allowed 1000–120000 with a 45000 default; its supported interval is extended, not reduced. All authorized modes share the same bound.

An armed existing execution deadline is obtained by session ID at execution time, after recovery preparation. Its signal is combined with the owning run signal, retaining the abort reason. The effective allowance is the minimum of requested/default timeout, the validated 300000 maximum and remaining armed deadline. The timer is absolute: silence is allowed and periodic output cannot renew it. Deadline expiration reports `agent_deadline_exceeded`; explicit run/parent abort reports `cancelled`. No child deadline or lifetime budget is renewed. Main chat currently has cancellation but no separate finite command-controlling wall-clock deadline registry entry by default; this patch does not invent one.

`requested_timeout_ms` records the request/default, `timeout_ms` the effective allowance at spawn, and `duration_ms` monotonic process/lifecycle elapsed time. Tool/recovery snapshot overhead is outside process runtime. Termination cleanup can extend result delivery beyond the runtime allowance by the bounded cleanup interval.

## Process lifecycle and output

POSIX shells/bwrap launch in their own process group. Timeout, cancellation and shutdown send SIGTERM to that owned group, wait **250 ms**, send SIGKILL even if the shell has already exited, and settle after an additional **100 ms** drain bound. Normal shell exit also checks for remaining group members and cleans them up, including children whose stdio is closed. With no remaining group, ordinary close settles immediately. Error/exit/close paths remove timers, signal listeners and active ownership; spawn failures settle a structured result. Shutdown awaits all owned foreground calls alongside the existing Electron shutdown work. Ownership is per invocation; one cancellation never uses a global current-process slot.

Windows follows the existing engine cleanup convention using `taskkill /pid PID /T`, escalating with `/F`; POSIX process groups apply on Linux/macOS. Windows and macOS have not been executed on native hosts. Windows tree cleanup after a shell has already exited needs native validation and may require a Job Object solution; no unsupported guarantee is made.

Each stdout/stderr stream is decoded incrementally and retains at most **16384 characters** (8192 head + 8192 tail), plus a small explicit omission marker. Temporary chunk memory is bounded by incoming pipe chunks, not cumulative output. The existing small-output line-window projection then runs over this bounded capture. `output_truncated` reports omissions from either layer. Both streams and final error tails survive; output volume does not kill an otherwise valid command. This is a code-level storage bound and a multi-megabyte fixture check, not a process RSS benchmark.

Raw command results retain `stdout`, `stderr`, `exitCode`, and compatibility flags `timedOut`, `cancelled`, `spawnError` where relevant. Additive fields include `success`, `status`, `signal`, duration and timeout/truncation metadata. Statuses are `completed`, `nonzero_exit`, `timed_out`, `cancelled`, `spawn_failed`, `permission_denied`, `agent_deadline_exceeded`. A signal-terminated process has nullable `exitCode`, never an invented 1. A real exit status is retained even when termination races exit. `success` is true only for `completed`, ensuring activity/checkpoint failure detection continues to recognize interruptions. Argument-validation failures retain the existing error contract. Verification maps process outcomes to its established passed/failed/error verdicts, with explicit deadline status.

## Agent, child and steering integration

The opt-in real-duration test uses **one actual `runMemoryChat` invocation**, actual native dispatcher and recovery path, and a deterministic SSE model fixture, without inference. It executes one command for **46111 ms**, receives `LONG_OK`, `completed`, exit 0 and a valid matching `tool_call_id`, then issues one continuation request and delivers one queued steering instruction. No replacement run or replayed tool call is created. The fixture run label is not evidence of a live desktop IPC session ID. Existing steering, context-recovery, child compaction and tool-ordering suites cover their own paths; no compaction logic changed.

**Actual child commands are unavailable in this repository.** `subagents/agentLoop.js` has an explicit independent read-only allowlist excluding both shell tools, and dispatches reads with Read Only permissions and no database session inheritance. This phase preserves that boundary. The requested two command-running subagents cannot be exercised without violating the no-permission-expansion constraint. Instead, concurrent native calls prove cancellation isolation, existing child-loop tests prove the policy and continuation paths, and an armed-deadline fixture proves command deadline classification. These are not presented as successful child-shell integration. Parent cancellation uses the same existing combined signal propagation.

Ordinary steering stays queued until the next eligible model request; it does not abort the command. Development servers executed in foreground expire truthfully and have their owned group cleaned up. Startup text is never treated as success. The command schema and browser guidance now state that persistent server launch is unsupported. Phase 2.2B must supply an explicitly designed background lifecycle; none is implemented here.

## Fresh verification and evidence

Detailed counts, identities and measurements are recorded in `command-execution-reliability-evidence.json`. Raw session logs are under `/tmp/continuum-command-audit/` (ephemeral, not a committed evidence store).

Before edits: four focused file identities passed (`agentTools`, `nativePermissions`, `permissionIsolationReliability`, `verification`). Explicit full-suite invocation was `node --test tests/*.test.cjs tests/*.test.mjs`: **175 passing, 30 failing file entries, zero skips**, 44188 ms. Baseline production build passed in **19.90 s**. Restricted Node test subprocesses report file-level results rather than the enabled run's individual assertions; those counts must not be compared as assertion counts.

A first enabled full run exposed a recovery fixture that deliberately depended on a detached shell writer persisting after command completion. That conflicts with this phase's foreground lifecycle. The fixture now writes through a separate workspace actor after the post-scan, preserving all late-write detection/restore assertions without requiring an orphan. No unrelated expected failures were rewritten. The verification fixture now expects the additive raw execution status while retaining legacy stream/exit assertions.

The new fast lifecycle suite covers schema/default/max/invalid input, both streams, nonzero status, silent completion, large single lines and tails, absolute timeout despite output, cancellation, concurrency isolation, deadline classification, forced TERM-ignoring descendant cleanup, post-success child cleanup, spawn failures, shutdown settlement and child allowlist preservation. Its 46-second loop test is opt-in (`CONTINUUM_LONG_COMMAND_TEST=1`) so ordinary full suites remain fast. The enabled long test passed independently: one tool, two model requests, one delivered steering instruction.

Measured five normal native-dispatch calls: total **31.73–81.28 ms**, process/lifecycle **7–26 ms**, all exit 0 with `OK`. A cancellation scheduled at 100 ms settled in **468 ms** (approximately 368 ms cleanup/scheduling overhead). A TERM-ignoring process with a 100 ms configured timeout settled in **460 ms**, signal SIGKILL. These are host samples under concurrent test load, not guaranteed latency bounds or separately instrumented timer-fire measurements.

Electron steering fixture passed with desktop access. Permission-mode UI behavior passed; its first run failed temporary-directory cleanup with ENOTEMPTY, and a repeat passed. Restricted Electron startup failed at `sandbox_host_linux.cc` with EPERM; no UI code or fixture was modified.

## Platform matrix and remaining limits

| Platform | Evidence | Remaining verification |
|---|---|---|
| Linux, this host | Actual native dispatcher, process groups, timeout/cancellation, forced descendant cleanup, shutdown helper, SSE main-loop continuation, enabled integration suites and Electron fixtures | Packaged desktop quit during a live command; original pagoda workload not replayed |
| macOS | POSIX process-group path reviewed | Native shell, descendant, quit and cancellation tests; contained bwrap remains unavailable as before |
| Windows | Existing taskkill tree convention retained; code reviewed | Native cmd quoting, taskkill timing, shell-exit descendants, cancellation and shutdown; Job Object ownership may be required |

Process groups cover ordinary shell/build descendants; deliberately escaping Full Access processes (`setsid`, double-fork/daemonization) can leave the owned group. This implementation is not a hostile-process containment system and does not claim complete cleanup of intentionally daemonizing unrestricted programs. Linux workspace bwrap PID namespaces provide a stronger existing boundary. Persistent/daemonizing commands are unsupported. OS-uninterruptible processes and Windows cleanup need platform-specific validation. These limits mean universal no-orphan and command-capable-child acceptance claims remain unverified, rather than being silently declared complete.

No persistent command logs, pagination, background handles, daemons, inference calls, LSP/MCP behavior changes, permission inheritance changes, or context redesign were introduced.

## Files and Phase 2.2B handoff

Changes for this task: `src/main/foregroundCommand.js` (new helper), `src/main/tools/agentTools.js` (existing command path/schema/evidence), `main.js` (foreground shutdown), `src/main/promptBuilder.js` (foreground server guidance), `tests/commandExecutionReliability.test.cjs` (new), `tests/verification.test.cjs`, `tests/recoveryBoundary.test.cjs`, and the two command reliability documents. Other modified/untracked files predate this task.

Phase 2.2B needs a separate authorized persistent-process lifecycle, bounded output ownership, explicit stop/shutdown behavior and native Windows/macOS validation. It must not infer that startup output or this phase's timeout constitutes a successful server launch. Supporting command-capable child agents requires a separately authorized policy design; this phase does not enable it.

## Final regression disposition

- Final restricted suite: **176 passed / 30 failed file entries**, 56041 ms, no new or resolved failing identities against the fresh 175/30 baseline. Exact passing/failing identities are in the evidence JSON.
- Final enabled suite: **1567 passed / 12 failed / 1 skipped assertions**, 57887 ms. All failing file families also appeared in the fresh restricted baseline; an untouched enabled baseline was not taken, so this is not an assertion-level enabled before/after claim. Failures remain in attachments, cloud IPC, engine settings, filesystem/MCP cap initialization, MCP IPC (two assertions), message actions/stats, RAG, skill import/proposal IPC and subagent runner. Current full logs expose missing Electron mocks/database initialization and assertion failures. They are not certified harmless or fixed by this task.
- One intermediate full enabled run additionally failed the LSP stale-document assertion (`LSP_INVALID_POSITION` versus `LSP_STALE_RESULT`). The isolated LSP production suite passed **35/35**, and the final enabled full run did not reproduce it. No LSP code/tests were changed.
- Final directly affected command/permissions/recovery/activity/checkpoint group: **78 passed / 0 failed / 1 skipped**, 7727 ms. Supplementary final command suite including the Windows lifecycle mock: **14 passed / 0 failed / 1 skipped**, 7995 ms. The separately enabled real-duration main-loop test passed **1/1**. Related child/steering/context/LSP/MCP integration group passed **134 assertions, zero failed, one skipped**. Prompt guidance tests passed both files.
- Final production build passed in **6.74 s**, with the existing chunk-size warning. `git diff --check` passed.

Final review reproduced and fixed an additional lifecycle race: a shell exiting 0 could acquire `timed_out` during its descendant cleanup grace period. The runtime timer now stops on shell exit; cleanup has its own bounded settlement. An independent regression covers this distinction. A bounded pipe-drain fallback also prevents a foreground promise hanging on inherited pipes held by an escaped process.

Windows cmd invocation preserves Node's existing `/d /s /c` outer quoting and verbatim argument convention. A mocked Windows lifecycle test verifies ownership PID, `/T`, `/F` escalation and verbatim forwarding; this does not substitute for native Windows process verification.

Manual native-platform checks: in a disposable workspace run a finite quiet command beyond 45 seconds with `timeout_ms:55000`; confirm exit 0 and same transcript continuation. Run a TERM-ignoring parent/child fixture with `timeout_ms:1000`, then cancel another instance and quit the app during a third; verify every owned PID stops and another independent command survives. On Windows additionally verify a quoted executable path containing spaces, cmd metacharacters and child survival after shell exit. On macOS verify process-group cleanup and the unchanged approval requirement when workspace sandboxing is unavailable. Do not claim these checks were executed outside Linux.
