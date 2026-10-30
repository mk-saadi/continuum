# W6 — Workspace Git capabilities and recovery

Implemented October 31, 2026 (Asia/Dhaka). Workspace Write retains automatic local development operations, adds verified stash recovery and current Git guidance, enforces the selected repository boundary, and prevents unrelated sockets from blocking native Git inspection. The production build passes. The matched regression selection has no new failing identities; the repository is not entirely green.

## Preservation and audit

Before editing, `git status --short` recorded these existing changes:

- `src/components/ChatInputBar.jsx`
- `src/components/FormControls.jsx`
- `src/components/ModelSettingsModal.jsx`
- Untracked `tests/mtpDialogScroll.ui.cjs`

Their bytes were preserved. The original diff/status and pre-edit source/tests were saved under `/tmp/w6-baseline`. R3, R4 and R5 reports, `permissionModes.json`, approval/containment policy, native execution grants, Git dispatch, identity, metadata protection, sandbox mounts, recovery capture/restore, foreground/background ownership and the R5 capability refresh path were inspected. W6 did not commit, push, stash, reset or clean this repository, modify live databases, install dependencies, run inference, change model configuration, MCP authorization, plans, batching or compaction.

The source already allowed Workspace Write commits, stage/unstage, branch creation, clean switching and fetch. W6 does not claim to introduce those permissions. Commit preparation already fingerprints the staged diff, branch and parent; native capabilities are single-use, scoped to arguments/session/root/mode/revision. The main usability defects were missing Git context, unchecked parent discovery, unnecessary socket validation failures and lack of stash recovery coverage.

## Actual native operation audit and before/after policy

All contained native Git calls use fixed `execFile` argv through bwrap, sanitized environment, isolated temporary storage, read-only runtime mounts and no network except the dedicated remote profile. Full Access uses R5 host routing. Reads have a read-only workspace; explicit mutations receive a writable workspace. The table covers every implemented native Git tool/action. No tools were created for absent commands.

| Actual tool/action | Existing Workspace Write behavior | W6 behavior | Worktree / metadata / network | Recovery and executable effects |
|---|---|---|---|---|
| `git_status` | Automatic read | Automatic, typed repository errors | Read / no mutation / offline | No capture needed; fsmonitor disabled |
| `git_diff` | Automatic read | Same, selected repository only | Read / no mutation / offline | External diff/textconv disabled |
| `git_log` | Automatic read | Same | Read / no mutation / offline | No capture needed |
| `git_show` | Automatic read | Same | Read / no mutation / offline | External diff/textconv disabled |
| `git_branch` | Automatic listing (`-vv --all`) | Same | Read / no mutation / offline | No capture needed |
| `git_blame` | Automatic read | Same | Read / no mutation / offline | Validated file/ref/line inputs; native sandbox |
| `git_stage` | Automatic explicit files | Same; repository binding and write conflict checks | Read / index write / offline | No worktree overwrite; filters remain sandbox-contained |
| `git_unstage` | Automatic `restore --staged` | Same | No worktree change / index write / offline | Never passes `--worktree`; no file recovery needed |
| `git_commit` | Automatic staged-snapshot commit | Same; bound repository, hooks and signing disabled in contained profile | No worktree overwrite / objects, index, refs / offline | Existing author identity resolution preserved; no amend or push |
| `git_create_branch` | Automatic; optional switch, defaults true | Same; rejects conflicting writes | Switch may replace clean files / refs, HEAD, index / offline | Dirty tracked files rejected before branch creation; no force option |
| `git_switch` | Clean switch automatic; dirty request reviewed then refused by executor | Same; typed dirty failure at executor | Clean checkout / HEAD, index / offline | Dirty files never discarded, even after approval; Git refuses untracked collisions |
| `git_stash list` | Automatic | Same | Read / no mutation / offline | No capture needed |
| `git_stash show` | Not implemented | Automatic validated indexed diff | Read / no mutation / offline | Existing action expanded; external diff/textconv disabled |
| `git_stash push` | Automatic tracked-only stash, no Continuum capture | Automatic only after verified recovery | Replaces tracked content / stash objects, index, refs / offline | Exact affected paths captured and fingerprinted; no `-u`, `--all` or external worktree hooks |
| `git_stash pop` | Explicit review; conflict may partially apply, stash retained on conflict | Review plus verified recovery in Workspace Write | May overwrite files / index, stash refs / offline | Incoming stash paths included; conflicts surfaced, no automatic replay/rollback of Git state |
| `git_sync fetch` | Automatic authorized remote | Same dedicated remote policy | No worktree overwrite / remote refs, objects / dedicated network | Existing remote allowlist, URL/credential/transport rules; not shell authority |
| `git_sync pull` | Preparation approval and incoming-change review; fast-forward only | Same | Clean fast-forward checkout / refs, index / dedicated network | Dirty/diverged work rejected, existing review retained |
| `git_sync push` | Preparation approval, outgoing-history snapshot and publication approval | Same | No local worktree overwrite / remote history / dedicated network | Fingerprint rechecked; recovery cannot undo remote publication |

`git_restore`, `git_reset`, `git_clean`, `git_merge`, `git_rebase`, standalone `git_fetch`/`git_pull`/`git_push`, amend, force-push and remote deletion are **not native tools/actions**. Fetch/pull/push are `git_sync` actions. No API was invented for the other names. Worktree restore is not enabled through `git_unstage`. Stash apply/drop/clear/branch are unsupported. Destructive forms remain unavailable through native Git; Workspace Write shell keeps Git metadata read-only, including after ordinary command approval. Existing shell/Full Access authorization is unchanged. This is a limitation, not an automatic destructive grant.

## Commit and hook contract

Eligible local commits run without separate approval after staged preparation. They stage nothing, bind to the staged snapshot and branch/parent, require the existing valid identity, check the current native grant/revision/cancellation, and never amend or push. Repository identity, configured application identity and initialized host identity retain their existing precedence; W6 invents no author.

Contained Git already used `core.hooksPath=/dev/null` and `core.fsmonitor=false`. W6 additionally disables commit/tag signing and implicit submodule recursion in that safe profile. Hooks and signing programs cannot gain host execution from an automatic commit. Repository filters can still run inside the established sandbox; their access is limited by its mounts, isolated environment and local network namespace. Remote helpers retain the separate, explicitly authorized remote profile. Compatibility trade-off: contained commits are unsigned and skip hooks; hook-dependent validation should be run separately through supported commands. Full Access retains host configuration, hooks, signing and R5 routing.

## Recovery and concurrent writes

For Workspace Write stash push/pop:

1. Read NUL-delimited staged and unstaged paths with rename detection disabled. For pop, add paths changed between the selected stash's base and worktree trees. Unchanged tracked files are not needlessly captured.
2. Validate contained paths and ordinary-file/absent state. Reject unsupported symlinks/directories and recovery size/file limits before mutation. Hash bounded bytes through no-follow descriptors and check file stability.
3. Capture through the existing `recoveryStore.captureOperation`, with every affected path required.
4. Verify complete coverage, every manifest record and its actual hash/size/absence against the preflight state. An arbitrary existing checkpoint ID is insufficient.
5. Recompute the index/HEAD/stash/content fingerprint after capture and immediately before mutation. A changed state requires fresh authorization/recovery.
6. Bind the checkpoint, paths and fingerprint into the existing single-use native capability. Recheck cancellation and permission revision using the existing guard/execution path.
7. Record post-operation file state best-effort for conservative later restore. On failure, report the checkpoint without pretending Git metadata was rolled back.

A per-workspace in-process exclusion prevents overlapping native Git mutations and conflicting Workspace Write file/foreground-command operations. Parallel reads and existing file-to-file behavior remain unchanged. Active registered background commands block Git mutation until stopped/completed; ownership and lifecycle are unchanged. External editors/processes are not locked by this mechanism; fingerprint checks detect observed changes, but there remains an unavoidable external-process race after the final check. Git operations are never automatically replayed.

The existing recovery store captures file content, modes and absence, not index/ref/history state. Git stash itself preserves the Git snapshot. Partial/conflicting Git failure reports execution/side effects as unknown and retains captured recovery; it does not apply file-only automatic rollback that could leave index/history inconsistent. No historical records or recovery schema were rewritten.

## Repository and non-Git behavior

Discovery reads filesystem metadata without invoking Git or initializing anything. Contained calls explicitly set `GIT_DIR` and `GIT_WORK_TREE`, so `core.worktree` cannot redirect operations. A valid repository must start at the selected project root. A nested repository works when selected as that project's root. A project inside a parent repository cannot silently operate on the parent. Empty `.git` mount/fixture directories in ancestors are not treated as repositories.

Both `.git` directories and gitfiles are understood. Gitfile and `commondir` targets must stay within the selected root. Internal gitfiles work. Linked worktrees/submodule roots whose metadata belongs to another root return `GIT_REPOSITORY_OUTSIDE_WORKSPACE`; W6 does not widen metadata mounts to make them work. Existing shell metadata protection still understands nested repositories/worktrees/submodules. Full Access discovery/routing is unchanged.

Without Git, file reads, writes, searches, moves, tests, plans and Continuum recovery retain their ordinary policies. Tests exercise a real non-Git edit/recovery and sandboxed test execution. A Git request returns `NOT_A_GIT_REPOSITORY` with file/test/recovery continuation guidance, explicit nonexecution and no side effects; `.git` is never created automatically. Malformed metadata fails closed. No-Git is not described as unrecoverable.

## Socket isolation and execution authority

Dedicated contained Git masks discovered workspace socket files with read-only `/dev/null` mounts, then verifies other exposed runtime sockets as before. It does not connect to or delete host sockets. This lets inspection proceed despite unrelated scratch/X11 files. The shell profile continues rejecting workspace sockets, retains no network, read-only Git metadata and its verified mount/argv checks. No host fallback was added. The R5 real-socket test now checks Git success, shell rejection and continued Full Access host behavior; this is an intentional W6 contract change, not removal of the isolation assertion.

R5's async-local host scope remains per invocation. Native grants still bind arguments/root/session/mode/revision and expire/consume once. Read Only remains non-mutating; Ask retains approval behavior. The contained runner's repository binding, no-signing and recursion constraints also apply to other contained native calls as shared boundary/side-effect safeguards. Full Access does not receive these overrides.

## Model guidance and diagnostics

The existing R5 execution section now includes a short Git sentence generated from the effective mode and current filesystem state. It identifies automatic local operations, no-hooks execution, stash coverage and remote/destructive policy. Non-Git/outside/invalid states advertise unavailable Git and continued file/test/recovery support. R5 already regenerates this section for every provider request and removes the old section, so initialization, deletion and mode/branch transitions do not rely on a cached repository state. No repeated command catalog or retry loop was added.

Typed diagnostics include `NOT_A_GIT_REPOSITORY`, `GIT_REPOSITORY_OUTSIDE_WORKSPACE`, `GIT_WORKTREE_DIRTY`, `GIT_CONFLICT`, `GIT_RECOVERY_REQUIRED`, `GIT_RECOVERY_INCOMPLETE`, `GIT_REMOTE_AUTH_FAILED`, `GIT_NETWORK_UNAVAILABLE`, `GIT_OPERATION_CANCELLED`, and fallback `GIT_OPERATION_FAILED`. Existing equivalent `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `PERMISSION_DENIED` and `PERMISSION_REVOKED` are retained. No artificial hook-blocked result is emitted when hooks are intentionally disabled. Unsupported operations remain unsupported rather than pretending success.

Git results carry operation, execution/side-effect status, checkpoint ID when captured, and a safe next action. Errors after process dispatch conservatively say unknown effects. Preflight failures say not executed/no effects. Approval failures instruct use of the existing approval channel; dirty/recovery failures instruct inspection and preservation. Existing repetition/cancellation limits remain unchanged. Real credential/network failures are classified from available Git stderr, not simulated as actual external attempts.

## Verification and baseline comparison

All tests used disposable projects/databases. The preload redirects MCP configuration to an empty temporary file and disables native server discovery. No model inference or external service was started. Git remote tests used disposable local file remotes and loopback Git servers only. The initial restricted test-worker attempt could not run normally; matched runs used approved child-process execution. No automatic approval rejection occurred.

| Verification | Pass | Fail | Total |
|---|---:|---:|---:|
| Pre-edit main baseline | 238 | 3 | 241 |
| Additional baseline from preserved pre-edit source/tests | 201 | 2 | 203 |
| Broad post-change selection (444 existing + first 17 W6 tests) | 456 | 5 | 461 |
| Final Git/boundary/R5 focus, including all 18 W6 tests | 70 | 0 | 70 |

The final focus covers the last internal-gitfile/common-metadata correction after the broad run. It also includes all original Git tools, Git metadata and R5 execution checks. No final failing identity is new in the matched selection. The five retained baseline failures are:

- `automatic rollback preserves a labelled pre-rollback snapshot` — `tests/recoverySafety.test.cjs`
- `rollback failure is reported once without recursion` — `tests/recoverySafety.test.cjs`
- `17. batch write failure mid-sequence rolls back and keeps a durable point` — `tests/recoveryStore.test.cjs`
- `workspace retains safety, activation, task continuity and MCP discovery` — `tests/sessionPromptWording.test.cjs`
- `permission restrictions and workspace boundaries stay enforced` — `tests/verification.test.cjs`

No existing assertion was weakened to conceal these failures. The earlier R5 expectation that sockets block native Workspace Git was replaced with the requested success assertion plus an explicit unchanged shell-isolation assertion. Intermediate implementation failures were fixed; an empty ancestor `.git` fixture exposed an overly broad parent detector, which now requires repository HEAD metadata. Exact test results, logs' hashes, commands, coverage mapping and preservation hashes are recorded in the evidence JSON.

The selection covers permission modes/isolation, native Git and remote authorization, real sandbox filesystem/Git shell isolation, background lifecycle, deletion/ownership, R3 attachment/hash behavior, R4 verification, R5 host routing, native files, recovery boundaries/post-state/safety, plans, P2 activation, T1/T1.1 batching and C9/advanced/safe compaction. It is not the entire repository test suite or a real-agent acceptance run.

`npm run build` passed (existing large-chunk advisory). `git diff --check` passed.

## Remaining limits and real-agent acceptance

- Linux/bwrap and namespace availability remain prerequisites for contained Git; no fallback is promised.
- Worktrees/submodules with external metadata require a separately authorized metadata design and remain blocked here. Bare repositories are not advertised as editable workspaces.
- Recovery caps and unsupported affected content can block stash; choose a non-destructive alternative. Recovery does not restore Git index/refs, external helpers or remote side effects.
- Dirty switching is deliberately refused, including after approval. Destructive history tools, arbitrary merge/rebase and worktree Git restore were not added.
- Contained commits skip hooks/signing. Existing Git identity configuration remains required. Remote authentication/network limitations remain real failures.
- Application write exclusion does not lock external editors or independently authorized host processes. This is not an OS-wide transaction.
- The five baseline failures remain unresolved. Real inference and full repository/distribution testing were not performed.

Suggested acceptance (not executed): create a disposable project/session in Workspace Write; inspect Git guidance, edit/stage/unstage/commit, create/switch a clean branch and verify no approval. Dirty the file, attempt a switch and check preservation/diagnostic. Push a stash, inspect its checkpoint and stash diff, then request reviewed pop. Install a sentinel hook in that disposable repository and verify an automatic commit skips it. Repeat read/edit/test/recovery in a non-Git project and verify no initialization. Check parent/external-worktree rejection. Request pull/push against a disposable local remote and verify incoming/outgoing review. Switch to Full Access and verify host routing, then Read Only and verify mutations remain denied.

W6 stops here. No W7 work or commit/push was performed.
