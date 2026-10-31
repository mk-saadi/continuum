# W7 — Sandbox socket poisoning repair

Implemented October 31, 2026 (Asia/Dhaka). Internal masked sockets no longer prevent ordinary Workspace Write commands. Actual bubblewrap execution, production shell/test dispatch, Git inspection, and retained X77 socket fixtures were verified. Exposed sockets still reject shell preparation; W6 Git retains its existing per-socket `/dev/null` masks. Full Access routing is unchanged.

## Preservation and initial audit

The complete initial `git status --short` contained 24 modified files plus `docs/investigations/flow-parallel/`, `failure-audit-flow.json`, and `tests/memorySearchApproval.test.mjs`. These existing changes were retained. W7 changes only sandbox filesystem planning, its Git metadata traversal, preparation diagnostics, focused tests and these two deliverables. R4, R5 and W6 reports were read. Current W6 source and tests were inspected rather than inferred from report names.

No commit, push, stash, reset, clean, dependency installation, inference, model setting change, live database write, recovery deletion, compaction change, batching change, attachment authorization change or Git approval change was performed. Tests use disposable repositories/databases. Existing tests exercise fixture permissions and disposable Git mutations; no live project permission mode or Git history was changed. A source/test snapshot under `/tmp/w7-matched-before` preserves the current pre-W7 behavior, including the user's existing source changes. The three initially clean production files and two revised legacy tests were restored there to their pre-W7 content for comparison. Dependencies were linked, not installed.

## Root cause and original reproduction

`src/main/sandboxFilesystem.js:resolveFilesystem` called `assertNoSockets(workspace)` before applying masks. The recursive lstat walk entered `.llm_workspace/sandbox/tmp/.X11-unix/X77`. The later `/proc/net/unix` check also treated this hidden path as exposed. Both could reject an unrelated command before launch.

There was a second exposure issue: the mount builder bound host scratch at `/tmp` and `/sandbox-home`. Although `.llm_workspace` was hidden at its workspace spelling, these rebinds made its scratch subtrees visible elsewhere. Merely excluding the internal tree would have exposed sockets through those aliases.

The original module was saved before editing. A disposable real Unix server at the historical X77 path produced:

```text
BEFORE: Sandbox socket path is not permitted: /tmp/w7-reproduce-…/project/.llm_workspace/sandbox/tmp/.X11-unix/X77
AFTER: exitCode=0, stdout=<disposable workspace>, stderr="", socketIntact=true
```

The after command was actual bubblewrap `pwd`, not a mocked executor. The original socket was not deleted to make it pass. Initial unrestricted focused baseline: 46 passed, zero failed. The initial outer-restricted attempt failed at child-process creation (`spawnSync git EPERM`); it was superseded by authorized child-process runs.

## Effective mount plan and exposure boundary

The Linux mount order is:

1. Empty root tmpfs, private `/tmp`, and private HOME tmpfs when HOME is requested.
2. Read-only allowlisted system trees, required `/etc` files and validated runtime installation roots. Symlink destinations preserve the existing system mapping.
3. Workspace bind, writable for shell/eligible Git mutations and read-only for Git inspection.
4. W6 individual socket masks for eligible native Git; read-only Git metadata binds for shell.
5. Empty read-only mounts over effective protected data trees, including the existing canonical `.llm_workspace` root. Nested masks collapse to the outer covering mount.
6. The separately provisioned Git askpass directory, when needed; private `/proc`, `/dev`, and read-only root remount.

No host scratch bind follows the internal mask. HOME and `/tmp` are writable invocation-local filesystems. System/runtime admission, cwd containment, network namespaces, capability dropping, and shell plan/argv identity checks remain authoritative. Extra runtime roots overlapping protected trees are still rejected. A conflicting metadata/askpass source under an internal mask fails closed.

`effectiveMasks` is shared by the mount builder and socket validator; there is no separate `.X11-unix` or recovery exclusion list. The walker skips only exact canonical directory roots covered by these masks, checking realpath and directory type at the exclusion. Component-aware containment governs descendants in the socket table; table paths are normalized before comparison, so `..` cannot borrow an exclusion. Similar-prefix siblings remain scanned. Git metadata discovery receives the same exclusions, avoiding recursive inspection of inaccessible internal Git fixtures.

The walker retains lstat-first behavior and does not follow symlinks. An exposed symlink to hidden storage resolves within the sandbox to the masked tree, including absolute aliases; it cannot reach the host scratch through HOME or `/tmp`. An internal symlink pointing outward cannot exclude its exposed target. Real bubblewrap tests check hidden workspace, alias and `/tmp` spellings. Symlink replacement of a planned mask invalidates the shell plan at the dispatch recheck. Malformed or missing required runtime/mount paths fail closed.

## Scratch and process lifecycle

`tools/agentTools.js:executeCommand` currently creates `.llm_workspace/sandbox/home` and `tmp` with `scopedPath` and recursive mkdir. Previously every shell invocation reused these host directories with no per-command scratch cleanup. A successful/failed graphical attempt could retain host-visible artifacts; interruptions and concurrent commands could share them. This repair leaves existing scratch and recovery data intact and stops rebinding that storage. No cleanup success is required.

Fresh tmpfs mounts now scope scratch to each sandbox invocation. Concurrent real bwrap commands write the same `/tmp/concurrent` name with different contents and retain their own values. A subsequent command sees neither previous HOME nor temporary marker. Existing foreground execution owns a detached process group, handles cancellation/timeouts with TERM/KILL, bounds capture and revalidates authorization periodically. Background commands reuse the same executor and owned lifecycle. Those mechanisms were not changed. Linux PID namespace teardown and private mount lifetime prevent these invocation-local artifacts from poisoning later commands; arbitrary user-created background daemons and externally authorized host processes are not managed by new cleanup logic.

## Tool integration and diagnostics

There are two production callers of `resolveFilesystem`: contained shell execution (also used by `run_tests` and background execution), and native `runGit`. Both use the corrected plan. No Workspace Write host fallback was added.

With a real retained X77 socket, production dispatch executes `pwd`, `node --version`, `find docs/ -type f`, `grep -rn example docs/`, and a direct passing Node test. `run_tests` reports passed only with its existing structured TAP verification evidence. Git status/diff/log/show/branch are checked through production dispatch; empty-repository log/show retain ordinary Git diagnostics. The disposable committed-repository real-bwrap fixture successfully executes status, diff, log, show and branch as well as the shell/test commands.

An actually exposed socket yields `SANDBOX_PREPARATION_FAILED`, stage `sandbox_preparation`, execution not started, `operation_executed=false`, category `exposed_socket` (other preparation defects use `filesystem_boundary`), `retryable=false`, and a bounded suggestion to correct the identified exposed path/runtime configuration without deleting recovery data. `run_tests` returns `verificationState=execution_error` and `verificationStatus=inconclusive`; it does not invent a failed assertion. The original error still identifies the socket path. R5 explicit X11 capability rejection and repeat-failure guidance remain covered and unchanged.

Shell invocation validation rebuilds and checks the filesystem plan after asynchronous preparation, catches late socket creation and changed mask sources, and retains exact mount/environment/argv checking. Native Git builds its plan synchronously immediately before `execFile`. Existing permission/session revision guards remain in place; no stale grant or completed operation is replayed.

## Recovery and Full Access compatibility

`recoveryStore` already excludes `.llm_workspace` and `.git` from full-workspace captures. Its lstat-first traversal, parent containment, exact user paths, manifests, caps, ownership and checkpoint transaction logic were not modified. The live production fixture captures a recovery checkpoint with X77 present, includes `docs/w7.md` in its manifest, excludes internal scratch, and keeps the socket intact. Existing recovery suites cover mutations, pre-state capture, post-state, storage/reference ownership and cancellation.

R5 Full Access shell/tests and Git continue using authorized host execution without resolving a sandbox filesystem. Sentinel tests fail sandbox preparation deliberately and prove Full Access bypasses it. Mode switching, concurrent invocation-local Git scope, permission revision revocation, session ownership, Git authorization, R3 attachment reading, R4 plans, and T1/T1.1 remain covered by the existing suites. No compaction implementation was touched.

## Regression results and exact baseline comparison

The evidence JSON records commands, summaries, test identities, hashes and coverage. The final combined selection covers 367 tests: 362 passed, four failed and one skipped. The matched pre-W7 compatibility selection covers 315 tests: 310 passed, the same four failed and one skipped. The original focused selection passed 46/46 before editing. Final focused filesystem/R5/W6/W7 checks passed 52/52 before the last test-only recovery assertions; the subsequent production/recovery/security acceptance rerun passed 20/20, and the final combined run includes those assertions.

Persistent failures in both matched runs:

- `automatic rollback preserves a labelled pre-rollback snapshot` — recoverySafety.test.cjs.
- `rollback failure is reported once without recursion` — recoverySafety.test.cjs.
- `17. batch write failure mid-sequence rolls back and keeps a durable point` — recoveryStore.test.cjs.
- `permission restrictions and workspace boundaries stay enforced` — verification.test.cjs.

The first three retain existing disposable permission-failure expectations; the fourth retains the existing undefined approval-error-text expectation. None was weakened or repaired in W7. There are no new final failing identities. One existing long main-loop/background scenario is explicitly skipped by its test definition in both runs.

An intermediate nativePermissions assertion expected host scratch markers to persist; it was updated to require writable scratch, no host marker, and fresh storage on the next invocation. The old mount-order test now requires private tmpfs rather than host scratch rebinding. These are intentional changed-contract assertions, with stronger isolation checks. An intermediate new recovery assertion had an incorrect import path; that fixture was corrected and rerun successfully.

Tests used an empty disposable singleton MCP configuration, disabled native discovery and an unexpected-connection failure sentinel for final/baseline isolation runs. No unexpected external MCP process start was observed. Existing mock protocol tests retain their own isolated fixtures. `npm run build` passes with the existing large-chunk advisory; `git diff --check` passes.

## Limits and real-GLM acceptance

Actual Linux bubblewrap and Unix sockets were available in the authorized runs; real contained commands were executed. Other platforms were not live-tested and retain the existing explicit sandbox-unavailable routing. No fresh packaged distribution, full repository suite or real GLM inference was run.

Filesystem scanning and pathname-based bwrap construction remain point-in-time checks, not an atomic snapshot or an OS-wide lock against independently authorized host processes. Deterministic changes before dispatch are rechecked and fail closed; a hostile host mutation during the final kernel launch window is an inherited limitation, not claimed solved. Internal masks and private scratch prevent the excluded storage's alternate exposure in the verified mount plan. No architecture rewrite or permission escalation was introduced.

Short real-GLM acceptance: in a disposable project, retain a real server socket at `.llm_workspace/sandbox/tmp/.X11-unix/X77`; select Workspace Write and ask GLM to grep/find docs, run a direct Node test and inspect Git status/diff/log. Check persisted command and verification results, a recovery checkpoint and the still-existing socket. Put a socket in an exposed project directory and confirm a typed unlaunched preparation failure, then close only that disposable fixture. Switch explicitly to Full Access and back and verify Host versus Sandbox routing and fresh scratch. Do not run inference against the live development repository for this check.

W7 stops here. No W8 work was started.
