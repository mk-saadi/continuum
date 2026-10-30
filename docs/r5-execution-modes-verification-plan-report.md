# R5 — Execution modes, verification and plan lifecycle

Implemented October 31, 2026. Full Access Git execution now uses the host, inconclusive checks no longer become failed tool invocations, current plan IDs reach each model request, and execution capabilities are visible to the model and user. The production build passes. The repository is **not entirely green**: the matched tests retain two pre-existing failures.

## Preservation and scope

The starting tree contained substantial tracked and untracked R3/R4, editing, batching, UI and compaction work. It was retained. No commit, push, stash, reset, clean, dependency installation, inference, model-setting change, historical database mutation or user-repository operation was performed. Fixtures used temporary projects/databases. The supplied R3 and R4 reports were read before implementation. No subagents were used.

Changes are limited to native execution routing/diagnostics, capability context, verification settlement/presentation, plan identity context, focused tests and these deliverables. Compaction algorithms, budgets, triggers, checkpoint validation, editing algorithms, attachment/hash handling and batching were not changed.

## Actual execution routing

Before R5, Full Access shell and `run_tests` already received `commandUncontained=true` from `toolPermissions.evaluateTool`, consumed the native execution grant, and used the host `/bin/sh -c` path in `executeCommand`. Background execution reused that path. The shell itself was not the confirmed Full Access routing defect.

Git was different. The dispatcher called `executeGitTool(..., false, guardDecision, permissionMode === 'full_access')`. Inspection branches called `runGit` without its `uncontained` option; mutation branches inherited the explicit false. The final `fullAccess` argument affected push approval logic, not execution routing. Consequently **Full Access `git_status` did wrongly use bubblewrap**, as did other Git inspection and nested preparation operations.

R5 establishes an asynchronous, invocation-local Git execution scope after authorization. Only the explicit Full Access mode selects host execution; all nested Git helpers inherit that scope. This includes status, branch, diff, log, show, blame, mutation helpers and remote preparation. No process-global current-mode flag or sandbox-failure fallback was added. Concurrent invocations cannot lend each other their execution mode. Git revalidates the live permission revision before subprocess execution.

| Tool | Read Only | Ask for Approval | Workspace Write | Full Access |
| --- | --- | --- | --- | --- |
| Shell / background commands | Blocked | Every invocation approved; sandbox with project-contained cwd, host for an authorized uncontained request/rootless session | Existing approved/eligible bwrap profile; no host fallback | Host, owned lifecycle |
| `run_tests` | Blocked | Same command authorization/routing | Same isolated command path | Host |
| Git inspection | Existing read policy, sandbox | Existing read policy, sandbox | Sandbox | Host |
| Git mutation | Blocked | Existing operation-specific approvals and contained policy | Existing stage/unstage/branch rules, commit/dirty-switch/sync approvals and contained policy | Authorized host operations; existing argument and operation restrictions remain |
| LSP | Not authorized | Not authorized | Existing bundled host language-server lifecycle with workspace/session authorization | Same host development lifecycle |

The LSP row intentionally reflects production source: Workspace Write does not move the existing trusted bundled language server into bwrap. No LSP authority was broadened. Its existing permission-change shutdown/restart, initialization, cancellation and crash handling remain intact.

Source audit also covered `nativeExecutionPolicy`, saved command rules, `foregroundCommand`, background ownership, `recoveryBoundary`, `recoveryIpc`, permission normalization and `lspExecutionContext`. Shell recovery captures files without launching a second sandbox command. The separate recovery diff-review UI still uses its existing sandboxed `runGit` policy: it has no session Full Access grant and is outside an agent invocation's host scope. It was not silently granted host execution.

### Host guarantees and socket root cause

Host shell execution inherits the application's actual environment, including HOME, PATH, temporary-directory and supported display variables. It does not initialize a login shell or promise that an unexported NVM installation will appear. Host Git retains its existing defensive Git environment/transport policy, bounded output, operation restrictions and credential-relay implementation; R5 adds no credentials. Host execution does not insert a sandbox temporary directory or invoke bwrap. It does not elevate the signed-in user's authority.

`sandboxFilesystem.resolveFilesystem` recursively calls `assertNoSockets(workspace)` before constructing mounts. A socket under `.llm_workspace/sandbox/tmp/.X11-unix/X77` is therefore found even though internal workspace data is subsequently masked. Because Full Access Git took this path, a previous sandbox socket could poison unrelated host-authorized inspection. This was routing plus recursive validation, not evidence of a cached permission mode.

The regression creates a **real Unix socket** at that scratch path in a disposable repository. Workspace Write still rejects it; Full Access Git and shell succeed. The socket validator was not weakened, scratch files/recovery records were not deleted as a repair, and mode transitions continue using existing revision-based revocation. Every command builds its own mode-specific configuration.

## Capability contract and unsupported workflows

`executionCapabilities.js` derives a secret-free manifest from the effective permission mode, workspace and current process environment. It reports execution profile, shell, cwd, HOME behavior, runtime executable availability, host NVM initialization visibility, network policy, temporary storage, Unix/display support, graphical verification and package limitations. Host executable discovery checks executable files in the actual PATH. Sandbox runtime availability is **unknown**, rather than claiming that a visible host binary necessarily runs inside the namespace. Network/display reachability is not inferred from installed tools or environment variables.

A compact current capability section is inserted in initial/rebuilt context and refreshed at every main model-request boundary, including after steering/mode changes. Detailed metadata is also retained on command results. The permission selector displays a separate “Execution environment” line: Host, Workspace sandbox, No executable shell, or Host after approval for rootless Ask sessions.

Explicit `required_capability="x11_display"` and direct `Xvfb`/`xvfb-run` invocations in a sandbox return `EXECUTION_CAPABILITY_UNAVAILABLE`, the missing requirement, profile, original command, `operation_executed=false` and actionable alternatives. Merely printing or mentioning Xvfb does not trigger preflight. Unknown shell operations continue through normal authorization and execution.

For display initialization failures discovered only after launch, the executor retains the first bounded raw evidence. Repeating the **same command/cwd/run/permission revision** returns that evidence and the stable capability diagnostic without relaunch. The memory is bounded to 128 entries; a different run, revision, command or cwd is not suppressed. This is neither a general blacklist nor command rewriting. A production-path regression mocks only the foreground process result, observes one launch, then proves the identical repeat is not launched.

Workspace Write retains containment, symlink/traversal checks, read-only Git metadata in shell, saved-rule restrictions, isolated HOME, network namespace, approval rules and fail-closed infrastructure handling. No automatic escalation exists. The existing sandbox suites exercise supported ordinary dispatch and containment. Live namespace availability remains an OS prerequisite; installing bwrap alone is not advertised as proof of successful startup.

## Why exit zero became a red failure

The responsible path was:

`executeCommand → verificationStatus → structureVerification → formatToolResult → runMemoryChat settlement → execution-step persistence → classifyStep/ToolEventCard`.

R4 marked incomplete or potentially exit-masking command output `inconclusive`, but `structureVerification` set `success` only for `passed`. Thus `success=false` caused `failedToolReason` to return “A tool call failed,” settlement persisted `status=error`, and activity rendered a red failed card. The formatter did not originate the defect.

The retained incident text alone does not reveal the original command syntax. In the reconstructed baseline, direct `printf SYNTAX_OK` was incorrectly called verified passing, while `printf SYNTAX_OK; true` and the equivalent XVFB probe reproduced the red-error mechanism: exit zero, inconclusive, `success=false`. The evidence includes both forms instead of claiming the direct probe historically failed when the baseline says otherwise.

R5 separates:

- `executionStatus`: process completion, launch failure, timeout, cancellation, permission denial, or known unavailable infrastructure.
- Process evidence: exact command, raw numeric exit code, signal, bounded stdout/stderr, start/finish timestamps and duration where the runner supplies them.
- `verificationStatus`: passed, failed or inconclusive. Legacy `status` and `verificationState` remain for existing consumers; legacy execution-error/deadline values are not mistaken for test assertions.

A complete authoritative TAP success passes. Structured test failures override a shell zero. Filtered/incomplete success and unrecognized exit-zero probes are inconclusive, with usable successful tool results. Display initialization failures are inconclusive with an environment explanation; their actual exit code remains unchanged. Missing commands, shell startup errors, timeouts and cancellation still fail appropriately. Nonzero checks and trustworthy assertion failures remain visible. Complete test evidence is not discarded because of an unrelated display warning.

The shared failure classifier recognizes completed inconclusive `run_tests` results. Activity labels distinguish “Verification inconclusive” and “Tests failed.” Production model-loop tests inspect the provider-visible JSON, settled steps, **actual disposable database persistence/reload**, and activity classification for SYNTAX_OK/XVFB_OK. A real Electron test renders the two outcomes. Real passing/failing Node runners and a masked failing pipeline are also exercised through native dispatch.

No arbitrary stdout marker establishes a formal pass. Non-TAP lint/build/runner commands without an authoritative result adapter may complete successfully while verification remains inconclusive; that is a disclosed evidence limit, not a failed tool invocation.

## Plan identities and consecutive tasks

The actual IDs are stable **database integers**, not string `step_...` identifiers and not ordinal positions. Full rendered plans showed both positions and IDs. R4's compact request-boundary state showed identity/revision/counts but omitted actionable IDs, so refreshed context could leave the model guessing positions from memory.

Current compact state now includes each step's exact `id`, `position` and `status`, plus plan identity/revision and existing lifecycle information. It excludes step descriptions/history. Both full and compact context instruct the model to use exact IDs rather than positions. `UNKNOWN_STEP` and `STALE_PLAN` also return the current authoritative state. Ordinal aliasing was not introduced: a database ID can never be silently reinterpreted as a position against another revision.

Existing create/get/update semantics remain: create only with no plan; incremental changes use returned IDs; `transition=new_task` requires completed prior work and an expected revision; explicitly authorized `supersede` replaces unfinished work. Existing transaction, ownership, stale-revision and history rules remain enforced. No historical plan migration was performed.

The new fixture creates and completes **Task A, Task B and Task C** in one conversation, transitions twice, updates the current returned IDs, rejects archived IDs with actionable current state, and verifies five history snapshots retaining Task A. Existing plan tests cover duplicate creation, revision/ownership errors, interrupted-task supersession, preparation/rebuild and history deletion. Existing C9.3 tests retain the guard against resuming an unrelated completed/untouched plan. The main loop still reloads state per model request, so compaction and steering do not authorize remembered IDs.

## Verification and baseline comparison

Initial restricted runs were saved, but the outer execution sandbox blocks child processes with EPERM. Those results were not treated as application regressions. Normal child-process runs were authorized by automatic review; no rejection or user approval block occurred.

A separate `/tmp/r5-before` snapshot retained the initial worktree's prior changes and reversed R5 behavioral changes for matched comparison. Its dependency directory links to the installed dependencies; no installation occurred. The reconstruction script and hashes are in the evidence. This is a reconstructed behavioral baseline, not a claim of byte-identical pre-edit source: harmless additive schema/timestamp metadata remains in that snapshot.

All normal verification runs used an empty disposable MCP configuration with native-server discovery disabled before initialization. No real model or external MCP service was started by this harness.

| Check | Result |
| --- | --- |
| Main matched baseline, 324 tests | 322 pass / 2 fail raw; one is a temporary dependency-symlink path artifact |
| Baseline LSP artifact recheck with `--preserve-symlinks` | 35/35 pass; no LSP test weakened |
| Additional matched baseline, 152 tests | 151 pass / 1 fail |
| Final combined run, 476 existing + initial 10 R5 tests | **484 pass / 2 fail**, 486 total |
| Final expanded R5 suite | **14/14 pass** |
| Repaired long-horizon/advanced compaction suite | **26/26 pass**, including unchanged 11-compaction assertion |
| Real Electron activity UI | Pass |
| Real Electron permission selector UI | Pass, including environment labels |
| `npm run build` | Pass; existing large-chunk advisory |
| `git diff --check` | Pass |

Exact persistent failing identities, before and after:

1. `permission restrictions and workspace boundaries stay enforced` — `tests/verification.test.cjs`, pre-existing line-150 approval-error-text expectation receives undefined.
2. `workspace retains safety, activation, task continuity and MCP discovery` — `tests/sessionPromptWording.test.cjs`, pre-existing wording expectation `/get the existing plan/`.

There are **no new final failing identities** in the matched set. The baseline-only packaging assertion rejected a dependency path because the temporary snapshot used a symlink; it passed all 35 LSP checks with symlink-preserving resolution. It is not counted as an R5 improvement.

An intermediate longer capability prompt raised the advanced long-horizon compaction count from 11 to 16. The prompt was shortened, without changing compaction code, thresholds or tests; the existing assertion now passes. The verification suite's former “any exit-zero command is passed” assertions were deliberately strengthened to require completed/inconclusive for non-test probes; formal pass/failure coverage is retained and expanded. No tests were weakened to conceal failures.

Coverage includes permissions/grants, native shell dispatch, sandbox filesystem/Git/metadata, background lifecycle/cancellation, LSP, R3 attachment/hash behavior, R4 verification, E1/E2, P2, T1/T1.1, formatting, plan persistence/revisions, prompts/rebuild, C9.3, advanced/safe compaction and deletion/history. The evidence maps the requested acceptance groups to tests or source inspection. The complete repository suite and fresh distribution packaging were not claimed or attempted.

## Remaining limitations and real-GLM acceptance

Full Access cannot repair missing runtimes, denied OS permissions, missing display services, network policy or unavailable authentication. A chmod-denied disposable file remains unreadable through Full Access. Workspace Write still cannot support host NVM initialization, host network/display services or graphical X11 socket workflows. Unknown or compound graphical commands may require one launch to obtain a concrete environment diagnostic. TAP is the current authoritative runner adapter; other successful probes may remain inconclusive. No real GLM inference was performed.

Suggested acceptance, in a disposable project:

1. Select Full Access. Run a plain command, a SYNTAX_OK probe, direct passing/failing Node TAP tests, and Git status. Check Host metadata, inherited runtimes, unchanged raw exit codes, inconclusive probes and visible assertion failures.
2. Select Workspace Write. Check isolated capability guidance; request Xvfb once and repeat it. Confirm typed nonexecution without a host fallback. Ordinary supported shell checks should continue; a missing namespace is infrastructure failure.
3. With a disposable scratch X11 socket left behind, switch explicitly to Full Access. Confirm status and shell operate without socket-validation errors. Downgrade while a command is pending and confirm revocation remains effective.
4. Create/finish Task A, then B, then C in one session. Use IDs in the current state, check revisions/history, and rebuild/compact once. Explicitly supersede unfinished work in a separate fixture; confirm C9.3 does not resume an unrelated plan.

R5 work stops here. No R6 or unrelated architecture work was started.
