# Phase 2: Workspace Write approval decisions

Phase 1 baseline: clean commit `e554a23`. The requested fixture-only repair was committed first as `cf4848a` (`test(mcp): repair IPC integration fixtures`), changing only `tests/mcpIpc.test.cjs`. Phase 2 implementation changes are left uncommitted for review. Phase 3 was not started.

## Decisions before and after

This table describes Workspace Write. Ask for Approval, Read Only, Full Access and casual-context decisions retain their frozen Phase 1 outcomes.

| Tool / variant | Before | After |
| --- | --- | --- |
| `execute_command` | Ask | Allow with verified workspace bwrap profile and reviewed contained paths; otherwise ask |
| `run_tests` | Ask | Same policy and profile binding as `execute_command` |
| Shell with missing bwrap / missing isolation | Ask | Ask; approved contained execution still fails if bwrap cannot start, with no host retry |
| System commands / package installation or publication | Ask | Ask through the existing approval path |
| Shell cwd or literal path escape | Cwd escapes blocked | Cwd and referenced literal path/symlink escapes blocked; uncertain expansions/code require review |
| `git_stage` | Ask | Allow after containment checks |
| `git_unstage` | Ask | Allow after containment checks |
| `git_create_branch` | Ask | Allow; executor still refuses a switch that would discard changes |
| `git_switch` | Ask | Allow when clean; ask for dirty worktree or force/discard flags; executor still refuses unsupported/discarding operations |
| `git_stash` list / show / push | Ask | Allow at the policy layer |
| `git_stash` drop / clear | Ask | Ask |
| `git_stash` pop / unknown action | Ask | Ask (unchanged) |
| `git_commit` | Ask | Allow with the existing staged fingerprint; message and staged diff persist in the tool-call card |
| `git_sync` fetch | Ask | Allow; existing contained network Git executor remains in use |
| `git_sync` pull | Ask once | Ask once, including incoming commits from an already-fetched tracking ref when available |
| `git_sync` push | Ask twice | Ask twice, before remote preparation and before outgoing-history publication |
| `delete_project_file`, exact complete capture | Ask, then capture during execution | Capture first, allow, reuse the capture during execution |
| `delete_project_file`, partial/skipped/excluded/failed capture | Ask, then refuse capture failure | Ask; denial keeps the file; explicit consent permits uncovered deletion |
| `generate_image` | Ask | Ask (unchanged) |
| `approve_mcp_mutation` | Ask | Ask (unchanged) |
| MCP hard operations: Git publication, sends/publishing, executable code, deletion, SQL mutation, unknown operation | Ask / existing challenge | Ask / existing challenge; hints cannot override these |
| MCP `destructiveHint: true` | Name/argument heuristic | Ask, regardless of server trust |
| Trusted MCP `readOnlyHint: true`, otherwise benign body/payload envelope | Argument-name heuristic can ask | Allow; hard operations, including nested executable/API operations, still win |
| Untrusted MCP `readOnlyHint: true` | Name/argument heuristic | Same heuristic; annotation cannot downgrade an ask |
| Other MCP calls | Existing heuristic | Existing heuristic |
| Other native tools | Existing policy | Unchanged |

**Existing schema limits remain enforced.** The current native stash executor exposes `list`, `push`, and `pop`; it does not expose `show`, `drop`, or `clear`. Their policy decisions are covered without broadening execution schemas in other modes. Similarly, native commit has no amend option and branch switching has no force/discard execution option. This phase changes approval policy, not those supported-operation schemas.

## Shell safety and grants

`decideToolApproval(input)` remains pure in `src/main/toolApprovalPolicy.js:252`. The async caller obtains sandbox availability from the executor's restricted executable-search path, resolves cwd and literal paths through the existing workspace/symlink validator, and passes system/package/containment facts to the policy. A negative system-command heuristic alone cannot authorize a process.

Dynamic expansion, globs, directory-changing shell builtins, inline programs, ambiguous options and other paths that cannot be reviewed conservatively still ask. Quoted path fragments are combined before validation, so `e''scape` cannot evade a symlink containment check.

An autonomous command returns `approved: false`, `commandUncontained: false`, and `executionProfile: 'bwrap_workspace'`. The existing 120-second single-use, argument-bound grant also binds the profile, containment selection and explicit-consent bit. Changing any of these invalidates the grant. The executor captures the required profile and refuses a host execution path. Immediately before execution, after asynchronous recovery preparation, it rechecks referenced paths and live authorization; the same wrapper covers foreground, background and verification commands.

The existing sandbox launcher and bwrap arguments are unchanged. Missing bwrap or a startup failure has no host fallback. Tests cover missing availability before authorization, bwrap disappearing after an autonomous grant, scope/profile tampering, and explicit consent before an uncontained Ask for Approval execution. Full Access retains its existing host-execution authorization.

## Capture-first deletion

The caller validates and fingerprints the target, calls `captureOperation` with `paths: [path]` and `required: [path]`, and passes normalized `checkpointCoverage` to the pure function. Automatic authorization requires complete coverage, an exact manifest file record matching the original hash and size, and no skipped or excluded paths. It never uses the recovery panel's protection status as evidence.

A process-local, expiring, single-use deletion grant binds the capture or explicit uncovered-deletion consent to the arguments, workspace, session, policy generation and content fingerprint. The executor consumes that grant, reuses the original capture, verifies the content fingerprint, then performs the final pre-unlink content check. Ask for Approval and Full Access retain their previous execution-time capture behavior.

`captureOperation` creates unpinned checkpoints. This code never pins pre-captured checkpoints, so denial or cancellation leaves them available for ordinary retention cleanup. The recovery store and checkpoint-capture implementation are unchanged. Tests cover exact capture reuse, partial/skipped/excluded/failed capture, denial, unpinned checkpoints, uncovered deletion after explicit consent, and content changes during capture or immediately before unlink.

## MCP enforcement

The outer guard and independent dispatch backstop both call the same pure function. Git publication, sends/publishing, executable arguments, deletion, SQL mutation and unknown operations win before hint handling. A trusted read-only hint may bypass metadata-shaped argument heuristics such as a benign `body` or `payload`; it cannot hide nested executable or consequential operations in those envelopes. `destructiveHint: true` asks for all servers.

`definition.trusted` is validated as a boolean, defaults to false when absent, and is read from the authoritative server catalog alongside tool annotations. There is no trust-toggle UI in this phase. Existing dispatch-time challenge scoping/consumption, activation trust checks, server/selection checks and live policy-revision checks remain enforced.

## Frozen fixture diff

The exact patch is [permission-approval-phase2-fixture.diff](permission-approval-phase2-fixture.diff). It changes only these 12 rows under `workspace_write`, all from one prompt to zero:

- `delete_project_file`
- `execute_command`
- `run_tests`
- `git_commit`
- `git_create_branch`
- `git_stage`
- `git_unstage`
- `git_stash` (the baseline case uses list)
- `git_stash:list`
- `git_stash:show` (policy characterization only; unsupported execution schema remains unchanged)
- `git_stash:push`
- `git_sync:fetch`

The characterization fixture's switch case deliberately has staged changes, so it still asks and that row is unchanged. A separate real-repository test proves a clean switch runs without a prompt.

The recorder now updates only authorized Workspace Write rows and refuses to write if any other outcomes differ. SHA-256 checks freeze the exact original bytes of `ask_approval`, `read_only`, `full_access`, `casual`, and independent MCP `dispatch` sections. A separate hash preserves every unlisted Workspace Write row. The characterization table still covers 485 guard/dispatch outcomes; push's two prompts and content fingerprint presence remain frozen.

## Tests

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Supplied Phase 1 baseline | 325 | 2 | 0 |
| After fixture-only repair, before Phase 2 | 327 | 0 | 0 |
| Final permission/MCP/Git/recovery/sandbox + policy/characterization/Phase 2 suites | 347 | 0 | 0 |
| Supplemental background/command/native/recovery-message/permission-selector suites | 55 | 0 | 1 |
| Final focused policy/characterization/Phase 2 check, including malformed sandbox facts | 66 | 0 | 0 |

The supplemental skip is the existing beyond-45-second main-loop command fixture. The new Phase 2 suite has 18 passing tests. The two added characterization integrity tests account for the remaining increase from 327 to 347. Existing security tests were updated to use real outbound/review-required operations when testing approval lifecycle; harmless contained file writes no longer stand in for outbound effects.

Main command:

```sh
node --test tests/*ermission*.test.cjs tests/mcp*.test.cjs tests/*Mcp*.test.cjs tests/gitTools.test.cjs tests/deleteProjectFile.test.cjs tests/recovery*.test.cjs tests/workspaceCheckpoints.test.cjs tests/u6RuntimeSecurity.test.cjs tests/u7ExecutionSecurity.test.cjs tests/backgroundExecution.test.cjs tests/toolApproval*.test.cjs tests/workspaceWritePhase2.test.cjs
```

Supplemental command:

```sh
node --test tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/backgroundSettings.test.cjs tests/commandExecutionReliability.test.cjs tests/agentTools.test.cjs tests/recoverySafetyMessages.test.mjs tests/permissionSelector.test.mjs
```

Integration tests run with the approved child-process and namespace capabilities required by the existing test infrastructure. `git diff --check` passes.

## Files

Production: `toolApprovalPolicy.js`, `toolPermissions.js`, `nativeExecutionPolicy.js`, `workspaceSandboxProfile.js`, new `workspaceCommandPolicy.js`, `mcpManager.js`, `tools/agentTools.js`, and `ipcHandlers.js` under `src/main/`.

Tests: new `tests/workspaceWritePhase2.test.cjs`; updates to `toolApprovalPolicy`, `toolApprovalCharacterization`, `gitTools`, `deleteProjectFile`, `permissionIsolationReliability`, and `u7ExecutionSecurity` tests; only authorized rows in `tests/fixtures/toolApprovalCharacterization.json`. The MCP IPC fixture changes are isolated in commit `cf4848a`.

Documentation: this report and the exact fixture patch. No remembered approvals, dialog components, project-rule table, checkpoint-capture implementation, sandbox-launch implementation, subagent permission changes, or Phase 3 work were added.
