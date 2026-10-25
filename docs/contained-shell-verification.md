# Contained shell verification

Task 1 count reconciliation: the original two runs reported 229 + 103 = 332
passes, with no failures/skips. They used these selections:

```sh
node --test tests/*[Pp]ermission*.test.* tests/mcp*.test.* tests/git*.test.* tests/recovery*.test.* tests/sandbox*.test.* tests/agentTools.test.cjs
node --test tests/toolApproval*.test.cjs tests/unifiedMcpSecurity.test.cjs tests/workspaceMcpApprovals.test.cjs tests/t2*Mcp*.test.cjs tests/context*Recovery*.test.cjs tests/subagentOutOfProcessRecovery.test.cjs
```

That selection omitted backgroundExecution, deleteProjectFile,
rememberedToolRules, u6RuntimeSecurity, u7ExecutionSecurity, workspaceCheckpoints
and workspaceWritePhase2. No tests were deleted. The recorded Phase 3 report
lists 360 passes, not 342; the historical 342 result could not be reconstructed.
The documented Phase 3 command, expanded to include git metadata and sandbox
suites, was run identically against an isolated archive of fce8cb6 and Task 1:

```sh
node --test tests/*ermission*.test.cjs tests/mcp*.test.cjs tests/*Mcp*.test.cjs tests/git*.test.cjs tests/deleteProjectFile.test.cjs tests/recovery*.test.cjs tests/workspaceCheckpoints.test.cjs tests/u6RuntimeSecurity.test.cjs tests/u7ExecutionSecurity.test.cjs tests/backgroundExecution.test.cjs tests/toolApproval*.test.cjs tests/workspaceWritePhase2.test.cjs tests/rememberedToolRules.test.cjs tests/sandbox*.test.*
```

Results: fce8cb6 377/377; Task 1 379/379; Task 2 382/382. All have zero skips.
The first complete Task 1 run found a stale U7 environment allowlist assertion;
ae4da84 updates it to require GIT_OPTIONAL_LOCKS=0. The corrected run passed.

Additional real Task 1 confirmation used disposable repositories and actual
shell tool dispatch: all status/diff/log/show commands succeeded with
GIT_OPTIONAL_LOCKS=0; commit failed with the git_* guidance; shell git init
succeeded and .git/config was read-only on the next invocation. Real linked
worktree and submodule sandbox mounts supported inspection and refused writes
to their resolved metadata and gitfiles. The shell description was asserted.

Task 2 retains cwd and command validation, single-use execution grants,
installation/publication review, unavailable-sandbox review and host-fallback
refusal. Policy trusts the main-process selected bwrap/sandboxFilesystem facts.
Dispatch independently requires a process-local registered filesystem plan and
checks its actual mounts, environment, executable, cwd and namespace flags.
The command argument inspector and its duplicate dispatch parser were removed.
Saved install rules also require the filesystem profile.

Tests cover the six requested probes, backslashes, URL arguments, absolute and
outside-path arguments, embedded programs, unavailable sandbox, cwd replacement
during recovery preparation, grant tampering, forged/tampered plans, missing
network isolation and host executable substitution. All six acceptance commands
also executed through real shell dispatch with zero prompts (npm test uses a
disposable project's successful test script). No GUI manual acceptance was run.

The supplemental command from the Phase 3 report passed 75 tests, failed zero,
and skipped the existing beyond-45-second main-loop fixture:

```sh
node --test tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/backgroundSettings.test.cjs tests/commandExecutionReliability.test.cjs tests/agentTools.test.cjs tests/recoverySafetyMessages.test.mjs tests/permissionSelector.test.mjs tests/cloudProviders.test.cjs
```

Only workspace_write["shell:system"] changed in the characterization fixture;
see contained-shell-fixture.diff. Existing approval-lifecycle fixtures now use
package publication/install commands instead of syntax/URL-based triggers.
Git identity (Task 3) and Part C configuration sanitization remain untouched.

## Task 3 and Task 2 follow-up

Task 2 probe rows live in table-driven tests in workspaceWritePhase2.test.cjs:
the six command probes, syntax/URL/absolute-path variants, unavailable-sandbox
review and dispatch enforcement. sandboxFilesystem.test.cjs independently
checks the executable, namespace flags, cwd and registered mount plan. These
include real sandbox execution, not just policy-unit assertions. The frozen
characterization JSON records the existing guard/MCP matrix across all modes;
dispatch tampering requires the execution harness. Keeping the additional
cases in tests respects the original instruction to change only the existing
workspace_write["shell:system"] fixture row. No other fixture row changed.

The rewritten lifecycle fixtures retain their decision and lifecycle assertions:
U7's three provider loops still allow fixture writes/checks and deny the
unrequested action; the IPC test still allows the check, denies publication,
and rejects a different sender; configuration changes still invalidate the
pending command before launch. The remembered-rule IPC test still prompts for
an initial install, permits the saved repeat, denies the unrememberable action,
rejects the wrong sender, persists the rule on the tool card and revokes it.
Only the prompt-triggering command changed to installation/publication. The
four-row toolPermissions approval table now uses npm publish in place of sudo
true, preserving four ask/deny rows; sudo true is covered as an autonomous
contained command in the probe table, as Task 2 requires.

Task 3 adds a Git identity card under Settings → Agents & Skills and a validated
main-process setting. Each field resolves from repo-local config, then the app
setting, then the launch-cached host global config. Both author and committer
receive that effective identity in contained native Git and shell environments.
Native commits require a complete identity and otherwise fail with clear
configuration guidance. Reads and non-git shell work remain available without
an identity. Uncontained Git keeps its existing host profile. Global config is
read outside the sandbox at launch, without inheriting GIT_* overrides; the
sandbox does not gain access to host config/home. No Part C work was done.

Verification: the complete required set passes 388/388 (382 before Task 3), with
zero failures/skips. Six new gitIdentity tests cover each identity source using
real contained commits, author and committer values, shell environment,
launch caching, independent fallback, live repo edits, missing/incomplete
identity, settings persistence and validation. The Electron UI smoke test
passes saved-field loading, labels, saving both fields, clearing to fallback
and save errors. The production Vite build passes (existing chunk-size warning).
The same supplemental selection passes 75 with the existing one long-running
fixture skipped. Full packaged-application launch was not exercised.
