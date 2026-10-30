# R4 — Verification, shell reliability and session plans

R4 source changes are implemented. Focused deterministic checks pass; the matched regression set retains its original failures. Production UI build and whitespace checks pass. A disposable rebuilt distribution archive passes memory-worker startup/search. A fresh electron-builder distribution, live contained-shell probe, and real-GLM acceptance remain limited as described below. No inference was run.

## Preservation and historical evidence

The initial worktree contained substantial tracked and untracked changes, including the compaction repair, R3, P2 and T1/T1.1 work. These were retained. No commit, push, stash, reset, clean, dependency installation, model-setting change or live database write was performed. The historical session was inspected using SQLite `mode=ro`; all implementation tests used disposable databases/workspaces.

The supplied audit was checked against persisted execution steps for session `60322ed9-99c4-4d4d-9363-cf519591c807`: **195 tool calls, 15 recorded errors**. Classification:

| Recorded errors | Count | Classification |
| --- | ---: | --- |
| Missing sandbox NVM startup script | 5 | Model misuse plus environment limitation; insufficient guidance |
| Explicit host NVM path unavailable | 1 | Model misuse plus isolation contract |
| Other shell failures: stash, filtered grep status, Bash process substitution, wrong Git working directory | 4 | Model misuse; accurately failed execution |
| Empty root directory argument | 1 | Confirmed contract/usability defect |
| Memory worker imports Electron through `db.js` | 1 | Confirmed production defect |
| Existing session plan recreated | 1 | Confirmed contradictory prompt/lifecycle guidance |
| Empty edit batch and unmatched edit | 2 | Correct editing-engine rejection; unchanged |

The 15 errors exclude false successful verifications. Fourteen historical `run_tests` calls returned shell zero and were called passed. Replaying retained evidence now yields **6 failed, 7 inconclusive, 1 passed**. This is evidence classification, not a rerun of the user's historical commands. Call IDs, exact commands and retained output are in the evidence JSON. No historical plans were changed.

## Verification integrity

Previously `verificationStatus` returned passed immediately for shell exit zero. Pipelines such as `node --test broken.cjs | tail -20` report the last command's status, so failed TAP output could acquire successful verification and later successful-work claims.

The wrapper now retains the exact command, shell exit code, bounded raw streams, execution metadata and structured TAP evidence independently. `status` retains compatibility with existing `error`, `timed_out` and deadline consumers; `verificationState` exposes `passed`, `failed`, `inconclusive`, `execution_error`, or `cancelled` (and preserves the distinct controlling deadline outcome).

`testVerification.js` parses TAP protocol lines at column zero, top-level numbering/plans, and Node summary counts. Nested subtests do not become extra top-level results. Complete success requires a TAP header, contiguous top-level results, matching plan, consistent summary arithmetic and no capture truncation. Reliable structured failures take priority over shell zero. An intact failure summary can survive output filtering/truncation. Incomplete or contradictory success evidence is inconclusive. A prose substring containing `not ok` is insufficient by itself.

Protocol evidence is extracted before presentation truncation; foreground capture remains bounded. No output limit was bypassed. Other runner integrations had no authoritative result-file adapter in this wrapper; direct command status remains usable, while potentially masking shell constructs cannot establish success without complete supported evidence. Shell syntax/startup errors, known missing runner/script conditions, unavailable commands and spawn failures remain execution errors rather than assertion failures.

Masking detection is conservative and does not rewrite commands, invoke Bash or enable `pipefail`. It detects pipelines, command lists, Boolean chains, backgrounding and substitutions, while ignoring quoted literal pipes. It is not a complete shell parser. Direct test execution is the preferred contract.

Before/after deterministic reproduction:

```text
command: node --test --test-reporter=tap fail.cjs | tail -100
shell exit: 0
TAP: not ok 1; # tests 1; # pass 0; # fail 1
before: passed
now: failed; success=false; exitCode=0 retained
reason: structured output reports failures despite shell exit 0
```

A filtered success excerpt returns inconclusive. A legitimate complete passing TAP report remains passed. Cancellation and deadline precedence remain intact. The checkpoint evidence classifier and turn digest now respect failed/inconclusive verification, including historical masking evidence, so shell zero cannot turn these results into verified completed-work claims. Checkpoint coverage, validation and compaction algorithms were not changed.

## Shell/HOME/runtime contract

The actual executor selects `/bin/sh -c` on POSIX and `cmd.exe` on Windows. Contained Linux execution uses the existing verified bwrap filesystem profile, isolated HOME (`/sandbox-home` when scratch home is provisioned), executor-derived PATH, workspace-root default cwd, and existing cwd containment checks. Only existing system/runtime mounts are used; the host startup configuration is not mounted. Runtime installation images can be exposed through existing allowed runtime resolution without exposing host NVM initialization.

Model-facing instructions identify POSIX shell constraints, isolated HOME, unavailable host NVM/startup scripts, direct node/npm usage when available, and bounded tool output instead of pipelines. Command results expose shell, isolation and available executable names derived from the executor PATH, without dumping environment variables or host runtime paths.

A failed NVM startup request retains its actual stderr and receives bounded `environmentHint`: HOME is isolated, host initialization is unavailable, use available node/npm directly, and do not repeat sourcing the missing script. Commands are never repaired or rewritten automatically. Existing failure-circuit safeguards remain; no new autonomous repair or general repetition-suppression engine was added.

The live disposable contained-shell probe could not start in this execution environment: `bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted` / EPERM. Consequently **actual in-sandbox Node version and executable resolution were not observed here**. The source-derived mount/PATH contract and existing sandbox regression checks are distinguished from this unavailable live acceptance. Permissions and mount isolation were not weakened.

## Directory listing

Omitted, empty and `.` directory arguments now normalize consistently to the workspace root. Invalid/null-byte arguments remain rejected. The existing read-tool access policy remains unchanged: `readablePath` resolves accessible paths, while edit/command containment uses `scopedPath`. This fix neither adds a new host-path grant nor broadens the existing readable-path policy. Tests compare the three root aliases and retain filesystem validation.

## Packaged memory worker

The current source was still broken for permanent/all memory search, despite the audit's tentative suggestion that it was fixed. The import chain was:

```text
memorySearchWorker -> memorySearchCore -> memoryManager -> db -> electron
```

The existing `release/linux-unpacked/resources/app.asar` reproduces `Cannot find module 'electron'` in a real Electron Worker. `searchPermanentPage(connection, ...)` was moved unchanged to `permanentMemorySearch.js`; both main-process memory code and the worker reuse it. It accepts the existing connection, has no Electron/database-global dependency, and preserves filtering, deadlines and scope policy. The worker still opens the provided database read-only. A worker exit before a result now fails explicitly, including exit zero.

`scripts/audits/r4PackagedMemory.cjs` creates only a disposable database, starts the actual archive worker, verifies a visible sentinel and exclusion of a different model's sentinel, and returns nonzero on startup/search failure. The original archive fails. An isolated archive reconstructed from that distribution with the repaired worker import graph succeeds using the existing packaged Electron/native modules. Source-worker all-target search and missing-database feedback also pass.

The release artifacts were not overwritten. Fresh electron-builder packaging was attempted with dependency rebuild disabled. Its default path failed resolving github.com; retrying with the installed Electron avoided the download but failed in dependency collection: `No JSON content found in output`. No dependency installation/rebuild was attempted. Thus a newly produced AppImage was **not** verified. The archive check proves the worker repair under packaged loading, not completion of a fresh release build.

Remaining release acceptance, after producing a distribution with the project's normal packaging prerequisites:

```sh
ELECTRON_RUN_AS_NODE=1 release/linux-unpacked/continuum scripts/audits/r4PackagedMemory.cjs release/linux-unpacked/resources/app.asar
```

Run the same check against the archive extracted from the candidate AppImage before distribution. It must exit zero; the currently retained old artifact still fails.

## Plan lifecycle and visibility

The actual tool is `update_plan` with `action=create|update|get`; there is no separate native `create_plan` tool. Previously, one plan row belonged to each session while the system prompt told the agent to create a fresh plan after completion. This contradicted persistence and caused `PLAN_EXISTS`.

There remains one authoritative session-owned plan. Existing incremental updates retain their contract. Two narrow `action=update` transitions were added:

- `transition=new_task`: requires all prior steps completed, `expected_revision`, a new objective and new steps without IDs.
- `transition=supersede`: explicitly replaces unfinished work when authorized by the user's latest intent, with the same revision/objective/new-step requirements.

Transitions never happen automatically. A normal new user turn does not discard or resume unfinished work. Prior objective/steps/statuses are snapshotted transactionally into `workspace_plan_history` before every successful update, including ordinary removals and revisions. Active revision advances once. New steps default to pending; fresh IDs are allocated without reusing archived identities, including legacy IDs. Failed/stale/foreign-ID mutations roll back the entire transaction. Session deletion cascades plan history; stale/deleted-session state cannot authorize a write. No live plan was rewritten during implementation.

`PLAN_EXISTS` remains a failed, non-mutating response, now containing authoritative `existing_plan` identity, revision, objective, counts, completion state and the supported next action. It does not claim creation or change the revision. Existing argument-validation ordering remains intact.

Prompt preparation/rebuild renders plan identity, revision, objective, counts, completion state and lifecycle guidance from durable storage. Sessions without plans receive a compact create-permitted notice. The main loop re-reads compact state at each model-request boundary, replacing stale plan state after tool calls and steering; stale full-plan blocks are removed when refreshing. Children receive current parent-plan state as read-only delegated context and retain their existing tool/ownership restrictions.

The compact state is bounded by existing objective limits and contains no full historical steps. Existing plan rendering remains bounded. Guidance was shortened after an initial prompt-size regression; the original long-horizon regression again passes its exact 11-compaction assertion. No compaction threshold, checkpoint coverage, source validation, generation budget or batching behavior was changed.

## C9.3, rebuilds and deterministic coverage

The pre-existing C9.3 binding already requires a plan revision touched by this run or an explicit continue/resume request. A stale unfinished plan therefore does not automatically bind a distinct task. Completed steps do not qualify as unfinished work. This logic was preserved.

Coverage includes first creation, actionable duplicate creation, completion/new-task transitions, preserved snapshots, default step states, revision advancement/stale guards, foreign step IDs, explicit unfinished supersession, new-user preparation, context rebuild/resume, partial/degraded checkpoint projections, deletion/history cascade, bounded state, parent ownership and existing C9.3 cancellation/steering/completion checks.

The mocked model-loop scenario executes three turns: create/complete first plan; transition to a second objective; revise that task using the current revision. It observes refreshed state after each plan tool call, keeps historical records, and checks failed test feedback never appears as a verified pass. No cloud or local inference is involved. Separate fixtures cover real masked Node TAP, startup-error classification, root aliases, source-worker startup, packaged-worker scope isolation and explicit failure.

## Validation and baseline comparison

- Core assertion runs: **124 passed, zero failed** across workspacePlan (22), R4 parser (4), turnDigest (20), workspaceCheckpoints (4), memoryChat (50), compactPlanResults (24).
- Verification suite: 11 passed, one failure in `permission restrictions and workspace boundaries stay enforced` (an existing expectation of `error` text at line 150). Its file identity failed in the before baseline as well. R4 startup/masking cases pass.
- Matched regression set: **29 file identities, 24 passing / 5 failing before and after; zero new failing identities**. Failures: `recoveryStartupMemory.test.cjs`, `sandboxFilesystem.test.cjs`, `sandboxGitRelay.test.cjs`, `subagentCompaction.test.cjs`, `verification.test.cjs`. Comparison is explicitly at Node's reported file-test identity granularity; no unrecorded per-assertion baseline is invented.
- The matched set covers commands, sandbox profiles, memory startup, plans, project reads, C9.3, parent/child compaction, R3, compact/full tool profiles, T1/T1.1 and tool permissions.
- Additional 10-file check covering history/deletion, permissions, security, checkpoints, model-loop formatting and work logs passed.
- Two extra suites outside that matched baseline failed: attachments rejects the fixture PNG as unsupported/unverified for its selected model; fileVersion fails `13. large files keep the bounded read while hashing the full bytes` (expected `truncated=true`). These checks were not captured before editing, so no before/after claim is made for them. Their R3 algorithms were not altered.
- `npm run build`: passed, with existing large-chunk advisory. `git diff --check`: passed.

The evidence JSON records commands, exit codes/summaries, exact failing identities, hashes and representative outputs. The entire repository is **not** declared green.

## Remaining acceptance and short real-GLM check

1. On a host permitting the existing sandbox namespaces, run a contained `node --version` and inspect shell/HOME/cwd/runtime metadata. Attempt missing NVM initialization once; confirm actionable feedback, then run node directly.
2. Build a fresh distribution and run the packaged-memory acceptance command above; repeat against the candidate AppImage archive.
3. In a disposable GLM Workspace session, request a three-step implementation with a deliberate failing Node test piped to tail. Confirm failed/inconclusive feedback with shell zero retained; then run directly and correct it.
4. Finish the first task's plan, request a distinct second task in the same conversation, then revise it. Confirm existing-plan guidance, `action=update` transitions, preserved history and increasing revisions without repeated creation.
5. Leave work unfinished, request a distinct objective and explicitly authorize supersession. Confirm old unfinished statuses remain in history, and no unrelated C9.3 continuation occurs. Resume/rebuild once and verify current identity/revision.

These real-inference checks are documented acceptance steps, not actions performed during R4. No R5 work was started.
