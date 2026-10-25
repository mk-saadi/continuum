# Phase 3: remembered approvals

Implemented remembered approvals in Workspace Write. Changes are uncommitted for review. Phase 4 project settings UI is not included.

## Baseline and existing flow

The starting working tree was clean. The Phase 2 permission/MCP/Git/recovery/sandbox regression command passed **347 tests, 0 failures, 0 skips** before edits. A first restricted run could not spawn Git (`EPERM`); integration runs used the required child-process/namespace capabilities.

An ask originates in `decideToolApproval`, reaches `guardTool` / `requestApproval`, and passes bounded display arguments to `requestToolApproval`. The request controller owns a random approval ID, abort listener and 120-second timeout. `engine:request-tool-approval` displays the toast. The response IPC looks up the controller by requesting sender and request ID, then looks up the approval ID. The guard checks live policy revision before issuing an argument-bound, expiring, single-use execution grant. Native execution and independent MCP dispatch retain their checks.

SQLite owns projects, sessions and persisted message execution steps. Database initialization runs an idempotent schema inside its migration transaction, with existing column additions handled by schema introspection and `ALTER TABLE`. Project rules follow that table-creation pattern. Chat rules are process-local maps keyed by session ID and project ID; they survive turns and are cleared on session deletion or app restart.

## Storage and IPC

New table `project_tool_rules` has `id`, `project_id`, `tool`, `rule_key`, `label`, `created_at`, `last_used_at`, `use_count`, and `created_by_session`. It has a unique project/key constraint, cascading project foreign key, and a database trigger enforcing 200 rules per project. Chat storage is also capped at 200 rules per chat. Project use counters and timestamps persist; chat counters stay in memory.

Renderer APIs:

- `listToolRules(projectId, sessionId?)` → `tool-rules:list`; includes that chat's rules only when it belongs to the project.
- `deleteToolRule(projectId, id, sessionId?)` → `tool-rules:delete`; deletes a project rule or the identified chat rule.
- `deleteAllToolRules(projectId)` → `tool-rules:delete-all`; deletes all project-scope rules in that project.

There is no rule-creation IPC. The existing approval response sends request/approval IDs and a choice (`allow`, `deny`, `chat`, `project`); legacy `action` remains accepted. Extra renderer keys/patterns do not participate. Main derives the rule from the pending policy and refuses scopes that approval did not offer. The toast shows the two saved-scope choices and the main-generated label only when rememberable.

Rule edits advance affected session policy revisions and resolve other pending approvals as denied. Project edits affect all sessions in that project; chat edits affect that chat. A private, single-use main-process receipt lets the approval that saved the rule adopt its new revision without accepting an unrelated revision change. Revision tombstones also cover sessions without an active LSP context, preserving existing fallback-mode behavior.

## Rememberability matrix

| Ask in Workspace Write | Rememberable | Exact key |
| --- | --- | --- |
| Simple local `npm install` / `npm ci`, `pnpm install` / `pnpm add`, `yarn install` / `yarn add` | Yes, only with verified contained cwd and isolated bwrap profile | Tool + whitespace-normalized command + resolved cwd |
| Other uncertain shell commands, flags, path operands, parent-directory packages, metacharacters, newlines | No | — |
| System commands, global installs, registry publication, outside-workspace or host execution, unavailable sandbox | No | — |
| `generate_image` with an active authoritative provider | Yes | Tool + provider identity/API/base URL |
| Image generation without an active provider | No | — |
| MCP ask caused only by metadata argument-name heuristic | Yes | Server + tool |
| MCP Git publication, outbound actions, executable arguments, SQL mutations/challenges, unknown operations, destructive annotations | No, including nested executable/consequential options | — |
| Dirty/discarding Git switches, other Git review gates | No | — |
| Incomplete-checkpoint deletion, `approve_mcp_mutation` | No | — |
| Any ask in Ask for Approval, Read Only, Full Access, or casual context | No | — |
| Any block | Never overridden | — |

The shell whitelist is intentionally conservative: no flags, quoted arguments, paths, wildcards, prefixes or shell syntax. Tabs/spaces normalize; newlines are rejected. Tool and resolved cwd remain part of the key. Image prompts may differ, but changing provider identity/API/base URL requires a fresh approval; execution checks for a provider change after authorization.

The pure policy only converts a currently rememberable ask with an exact key match. It cannot override a block or a hard ask. Saved native and MCP calls receive single-use, argument-bound 120-second grants. Shell execution revalidates cwd, command policy, saved rule, sandbox profile and revision after asynchronous recovery preparation; missing bwrap never retries on the host. MCP dispatch recomputes rememberability against authoritative server metadata and current arguments before consuming its grant.

Tool events persist `savedRule.id`, label, scope, project ID and session ID through subsequent streaming updates. Both tool-card renderers show `allowed by saved rule: <label>` with a Remove rule button. Removal uses the delete IPC and revokes affected pending authorization.

## Frozen fixture diff

**Empty diff: zero rows regenerated or changed.** Phase 3 adds opt-in rules; without saved rules all 485 characterization outcomes remain identical.

Before and after SHA-256 of the entire fixture:

```text
5315afb541a4436c71813b3c648ecfa62a98f013fe7a29515877eb83e3c3bf60
```

`git diff -- tests/fixtures/toolApprovalCharacterization.json` emits no output. Existing section/row integrity tests pass.

## Validation

The new `tests/rememberedToolRules.test.cjs` has **13 passing tests**, covering the mode/hard-rule matrix, exact command/cwd matching, provider binding, chat/project isolation, sender binding, malicious renderer pattern/scope attempts, revision changes, pending approval invalidation, single-use native/MCP grants, sandbox/containment failures, provider changes before network dispatch, migration/idempotency/cap, use counters, and persisted tool-event rule IDs with IPC removal.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Clean Phase 2 baseline | 347 | 0 | 0 |
| Final required permission/MCP/Git/recovery/sandbox/characterization + Phase 3 suites | 360 | 0 | 0 |
| Supplemental background/command/native/provider/selector suites | 75 | 0 | 1 |

The supplemental skip is the existing beyond-45-second command fixture. `npm run build` passes with Vite's bundle-size advisory. `git diff --check` passes.

Required command:

```sh
node --test tests/*ermission*.test.cjs tests/mcp*.test.cjs tests/*Mcp*.test.cjs tests/gitTools.test.cjs tests/deleteProjectFile.test.cjs tests/recovery*.test.cjs tests/workspaceCheckpoints.test.cjs tests/u6RuntimeSecurity.test.cjs tests/u7ExecutionSecurity.test.cjs tests/backgroundExecution.test.cjs tests/toolApproval*.test.cjs tests/workspaceWritePhase2.test.cjs tests/rememberedToolRules.test.cjs
```

Supplemental command:

```sh
node --test tests/backgroundCommands.test.cjs tests/backgroundCommandIpc.test.cjs tests/backgroundSettings.test.cjs tests/commandExecutionReliability.test.cjs tests/agentTools.test.cjs tests/recoverySafetyMessages.test.mjs tests/permissionSelector.test.mjs tests/cloudProviders.test.cjs
```

Phase 3 stops here. No prefix/wildcard matching, project-settings management page, subagent permission changes, or sandbox/checkpoint implementation changes were made.
