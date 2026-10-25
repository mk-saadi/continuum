# Phase 1: centralized tool approval policy

Starting commit: `6cd2600` (clean working tree). Phase 2 was not started.

## API and responsibility

`src/main/toolApprovalPolicy.js:214` exports:

```js
decideToolApproval(input) // -> { decision: 'allow' | 'ask' | 'block', reason, route? }
```

The function is pure: its dependencies contain only synchronous classifiers, and it reads no filesystem, Electron APIs, process environment, database, session state, clock or approval state. Every `ask` has a nonempty human-readable reason. `route` identifies the existing preparation/enforcement step; it does not grant authorization. No remembered approvals were added.

Input fields: `tool`, `args`, effective normalized `mode`, `workspaceRoot`, `native`, `serverName`, optional `annotations`, `serverTrusted` (default false), `resolvedPaths`, `containment`, `checkpointCoverage`, and `sandbox: { bwrapAvailable, netUnshared, profile }`. Internal enforcement stages additionally receive `approved`, `permissionGranted`, `workspaceMcp`, and `mutationRequiresConfirmation`.

The stages retain the original enforcement order: initial evaluation; coarse capability/visibility decisions; containment failures; post-evaluation opaque Git approval; outgoing Git publication; and independent MCP dispatch checks. The legacy `baseDecision` export still returns its original `allow`/`approve`/`deny` shape for existing consumers.

Validation, async path/symlink checks, Git/delete snapshot preparation, approval callbacks, grant issuance/consumption, mutation challenge hashing/consumption, and actual execution remain outside the pure function. No current approval decision required changing behavior to reproduce it.

## Call sites

| Location | Purpose |
| --- | --- |
| `src/main/toolPermissions.js:331` | Initial evaluation and explicit native/MCP prompt routing |
| `src/main/toolPermissions.js:351` | Shell approval with authoritative sandbox facts after cwd validation |
| `src/main/toolPermissions.js:368` | Second push prompt, after outgoing-history preparation |
| `src/main/toolPermissions.js:417` | Outside-workspace write approval versus containment failure |
| `src/main/toolPermissions.js:464` | Post-evaluation opaque Git gate |
| `src/main/mcpManager.js:642` | Independent dispatch-time deletion check |
| `src/main/mcpManager.js:645` | Independent dispatch-time outbound/consequential-action check, after payload serialization |
| `src/main/mcpManager.js:648` | Independent dispatch-time Git publication and SQL challenge decision |
| `src/main/toolApprovalPolicy.js:270` | Initial evaluation delegates to the shared capability table |
| `src/main/toolApprovalPolicy.js:280` | Compatibility adapter for visibility and existing `baseDecision` callers |

`workspaceSandboxProfile.getWorkspaceSandboxProfile` derives the selected executor profile and executable availability in the main process. It mirrors the existing Linux workspace profile's network-isolation setting; it does not launch bwrap or claim that namespace creation will succeed. The executor still fails closed. Model arguments cannot supply this fact, and Phase 1 does not use it to relax approval.

`McpManager.getApprovalFacts` reads tool annotations and the explicit boolean `definition.trusted` from the existing server catalog. IPC passes these to the outer guard; internal reauthorization and dispatch also use catalog facts. Missing trust is false. Annotations/trust are inert in this phase. No config UI, sandbox implementation, checkpoint capture, or subagent permissions changed.

## Verification

Before any production refactor, `tests/toolApprovalCharacterization.test.cjs` was written and run against the original code, then its output was frozen in `tests/fixtures/toolApprovalCharacterization.json`. A second run verified the frozen table before extraction. It records 425 guard outcomes (85 native/MCP cases across four modes and casual context), plus 60 independent MCP dispatch outcomes. It exercises real temporary Git repositories, staged changes, sandboxed commit/push preparation, and a workspace-local bare remote. Push still records exactly `prepare_push` then `push`; fingerprint presence and stable errors are frozen as well.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Original permission/MCP/Git/recovery/sandbox baseline | 279 | 2 | 0 |
| Characterization before refactor (485 recorded outcomes) | 1 | 0 | 0 |
| Focused first extraction check | 19 | 0 | 0 |
| Same baseline suites after refactor + characterization + policy unit tests | 325 | 2 | 0 |
| Supplemental native/LSP/command/recovery-message suites, including new tests | 142 | 1 | 1 |
| Original committed code, isolated supplemental LSP suite | 8 | 1 | 0 |

The new policy unit suite contributes 45 passing tests. It covers the per-mode decision table, casual behavior, containment, independent Git gates, MCP hard rules, SQL challenge precedence/exemptions, inert sandbox/checkpoint/trust/annotation inputs, deterministic non-mutating decisions, authoritative sandbox fact plumbing, and catalog metadata plumbing.

The two main-suite failures are identical before and after:

- `tests/mcpIpc.test.cjs:22`: incomplete Electron fixture causes `Cannot read properties of undefined (reading 'getPath')` during database initialization.
- `tests/mcpIpc.test.cjs:273`: sender fixture lacks `once`, causing `event.sender.once is not a function`.

The supplemental failure also reproduces on the original commit in an isolated `/tmp` archive: `tests/lspProductionAgent.test.cjs:85` compares a JavaScript string length (3997) with its UTF-8 byte length (3999). The supplemental skip is the existing beyond-45-second main-loop command test. Existing test files were left unchanged; these unrelated failures prevent claiming an entirely green repository. No new test failures were observed.

The initial restricted test attempt could not spawn Git/use the needed sandbox capabilities. Baseline and subsequent integration runs used the approved elevated test runner. One combined elevated edit/test command was rejected by automatic approval review; it made no changes. Remaining edits used workspace-scoped patches and test execution was requested separately. No requested work remains blocked by that rejection.

Baseline/after command (append `tests/toolApproval*.test.cjs` for the after run):

```sh
node --test tests/*ermission*.test.cjs tests/mcp*.test.cjs tests/*Mcp*.test.cjs tests/gitTools.test.cjs tests/deleteProjectFile.test.cjs tests/recovery*.test.cjs tests/workspaceCheckpoints.test.cjs tests/u6RuntimeSecurity.test.cjs tests/u7ExecutionSecurity.test.cjs tests/backgroundExecution.test.cjs
```

`git diff --check` passes. Security integration suites continue to cover containment/symlinks, live policy revisions, single-use argument-bound native execution grants, commit/push/delete fingerprints, challenge scoping/consumption, activation trust, and Full Access behavior. The approval ID/timeout/sender/lifecycle and payload truncation implementation is unchanged.

## Files changed

- `src/main/toolApprovalPolicy.js` — pure central policy and relocated capability catalog/table.
- `src/main/toolPermissions.js` — policy calls; existing async validation/preparation/approval/grant flow retained.
- `src/main/nativeExecutionKinds.js` — pure command/opaque-Git classifiers, extracted without changes.
- `src/main/nativeExecutionPolicy.js` — imports those classifiers; grants unchanged.
- `src/main/workspaceSandboxProfile.js` — authoritative, read-only sandbox profile facts.
- `src/main/mcpManager.js` — catalog approval facts and shared-policy dispatch checks.
- `src/main/ipcHandlers.js` — passes catalog annotations/trust to the outer guard.
- `src/main/tools/agentTools.js` — corrects two descriptions to acknowledge Full Access's existing approval bypass; no logic changes.
- `tests/toolApprovalCharacterization.test.cjs` — real guard/dispatch characterization harness.
- `tests/fixtures/toolApprovalCharacterization.json` — frozen original decisions.
- `tests/toolApprovalPolicy.test.cjs` — table-driven policy and plumbing tests.
- `docs/permission-approval-phase1-report.md` — this report.

No UI changes, remembered approvals, new approval semantics, or Phase 2 changes were implemented. Nothing identified in the original decision behavior was intentionally changed or left unpreserved.
