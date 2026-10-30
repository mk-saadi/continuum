# P1 — prompt and tool-schema efficiency

Completed 2026-10-28 (Asia/Dhaka). Scope: fixed prompt wording and native description reductions only. Existing C9 working-tree changes were preserved. No new compaction phase, selection system, scheduling or worker redesign was introduced.

**Measured result:** the normalized Workspace greeting request shrinks from 44,297 to 41,647 UTF-8 JSON bytes. All advertised tool names and all 51 native argument contracts remain unchanged. Token counts below are **estimates**, not model tokenizer measurements. No live-model accuracy, latency or historical 16.7K-token reproduction is claimed.

[Machine-readable measurements and exact failure identities](p1-prompt-tool-schema-efficiency-evidence.json).

## Request path and measurement

`engine:chat` resolves session/profile/project permissions and prepares messages through `promptBuilder.prepareChatMessages` / `rebuildChatMessages`. Those builders assemble the base temporal/core instructions, authoritative briefs, checkpoint or earlier summary, session/project/skill instructions, selected conversation, worklog and durable plan. `getToolContext` applies `isToolVisible`, runtime permission downgrades, MCP mode, memory/media/skill/LSP availability, Casual run-scoped activation, legacy delegation shadowing, description compaction and stable ordering. Workspace retains all authorized native tools.

`runMemoryChat` refreshes tool advertisements and builds the actual normalized request through `sanitizeChatMessages` (including `mergeSystemMessages` and tool-call/result pairing). The audit intercepts its injected fetch at the final `JSON.stringify` boundary. `prepareCloudPayload` then exercises the production OpenAI and Anthropic serializers, including whitelist mapping, system/tool conversion and cache fields. No real provider or model is contacted. Dispatcher ownership and permission enforcement remain authoritative.

The fixture uses an Electron stub and disposable SQLite/configuration/project roots. It normalizes only the temporary directory and date anchor for comparison. Nine identical scenario recipes run against saved pre-edit module sources and final sources. The post-compaction cases actually pass through `compactAtBoundary`, commit their checkpoint, archive covered history, and rebuild through the production path. Summary certification uses the existing **synthetic fixture tokenizer**, explicitly not a real model count. These cases also include a durable plan and recorded worklog.

There is no global MCP-disabled setting: the application supports Auto and Manual. The disabled scenario has one explicitly disabled fixture server and zero external advertisements. Auto and Manual use empty external catalogs; this isolates fixed discovery overhead. Prepared MCP tools and refresh/ownership are tested separately by the integration suites. These measurements do not represent the cost of arbitrary user-configured MCP schemas.

The authoritative server `/apply-template` → `/tokenize` path is available in production `contextBudget`, but no matching model tokenizer was supplied or invoked for this audit. The existing production fallback is `ceil(serialized UTF-8 bytes / 3) + 32 × normalized message count`. All request sizes below include serialized roles, schemas, control fields and framing. Hidden provider chat templates remain unknown. This is more concrete than measuring source strings, but it does not certify exact billed input tokens.

## Before / after

Local final normalized request estimates; exact UTF-8 byte sizes accompany them. No tool was removed.

| Scenario | Before tokens (est.) | After tokens (est.) | Saved (est.) | Before → after bytes | Capability regression |
|---|---:|---:|---:|---:|---|
| Casual greeting | 2,013 | 1,857 | 156 | 5,846 → 5,377 | None proven; names/contracts identical |
| Workspace greeting | 14,830 | 13,947 | 883 | 44,297 → 41,647 | None proven; names/contracts identical |
| Read-only task | 8,809 | 7,967 | 842 | 26,234 → 23,708 | None proven; names/contracts identical |
| Coding task | 14,845 | 13,962 | 883 | 44,343 → 41,693 | None proven; names/contracts identical |
| MCP disabled | 14,830 | 13,947 | 883 | 44,297 → 41,647 | None proven; names/contracts identical |
| MCP Auto | 14,830 | 13,947 | 883 | 44,297 → 41,647 | None proven; names/contracts identical |
| MCP Manual | 14,493 | 13,610 | 883 | 43,287 → 40,637 | None proven; names/contracts identical |
| Active checkpoint | 15,672 | 14,789 | 883 | 46,728 → 44,078 | None proven; names/contracts identical |
| Post-compaction request | 15,346 | 14,463 | 883 | 45,845 → 43,195 | None proven; names/contracts identical |

All three serializers shrink for every fixture. Workspace greeting provider comparison:

| Serializer | Before bytes | After bytes | Before → after estimated tokens |
|---|---:|---:|---:|
| local | 44,297 | 41,647 | 14,830 → 13,947 |
| openai | 44,199 | 41,549 | 14,797 → 13,914 |
| anthropic | 42,898 | 40,248 | 14,332 → 13,448 |

## Fixed composition without double counting

The evidence partitions **every serialized byte** once. Description bytes include description string values recursively; schema bytes contain the remaining tools JSON, including schema structure and keys. Core and Workspace content exclude separately attributed safety spans. Safety includes the delete block, workspace/approval/untrusted-data rules and base credential/customization restrictions. Briefs/checkpoints/worklogs/plans retain their own safety language under their owning category. Serialization is the residual JSON, escaped message separators and provider control fields. It is not a measured hidden chat template.

Category token allocations are `floor(category bytes / 3)` with remaining rounding and normalized message allowances assigned to serialization. They sum to the final fallback estimate; they are not isolated tokenizer measurements.

Workspace greeting composition:

| Category | Before bytes | After bytes | Before → after allocated token estimates |
|---|---:|---:|---:|
| core | 1,556 | 1,556 | 518 → 518 |
| workspace | 6,656 | 4,318 | 2,218 → 1,439 |
| safetyPermissions | 851 | 757 | 283 → 252 |
| toolDescriptions | 17,845 | 17,627 | 5,948 → 5,875 |
| toolSchemas | 16,568 | 16,568 | 5,522 → 5,522 |
| plans | 0 | 0 | 0 → 0 |
| briefs | 534 | 534 | 178 → 178 |
| worklogs | 0 | 0 | 0 → 0 |
| checkpoint | 0 | 0 | 0 → 0 |
| recentConversation | 5 | 5 | 1 → 1 |
| serialization | 282 | 282 | 162 → 162 |

Native advertisements dominate: approximately 34K serialized bytes remain in Workspace, compared with approximately 6K of core, session and safety content. The mandatory brief also repeats the greeting in Workspace; it is not removed because authoritative requirement retention is outside this focused change. Plans, worklogs and checkpoint content are zero in fresh greetings, and nonzero in the stateful fixtures. All nine category breakdowns and three provider sizes/hashes are retained in JSON.

## Reductions and retained rules

- Removed the repeated greeting/recall/save-memory/rendering summary from the session prompt. `COMPACT_BASE` already carries those rules in every assembled session request. Preserved memory-disabled behavior and the prohibition on saving non-user content.
- Removed the duplicate credential prohibition from the session safety block; the unconditional base still prohibits seeking media credentials without explicit authorization. The delete preview/count, exact test-ID cleanup and human confirmation requirements are unchanged.
- Consolidated delegation orchestration into one protocol: mandatory page isolation, independent sources, direct local inspection, bounded child scope, read-only children, no child commands/memory/recursion, partial-result reuse, shared resource ceilings and exclusive invocation modes all remain. Removed the worked JSON example because field types and exclusivity guidance are already supplied by the tool schema/protocol. Existing wording tests now check the schema flag instead of requiring the deleted example.
- Shortened `web_search`, `run_tests` and `spawn_sub_agent` descriptions into complete guidance under the existing 320-character cap. Previously the cap cut longer descriptions mid-sentence. Removed the redundant command examples in the verification command argument. No enums, argument names, types, defaults, bounds, required fields or additional-properties rules changed.
- Honor the existing `delegationAvailable` argument when injecting the Workspace protocol. This avoids claiming worker availability when a caller explicitly disables delegation; it does not grant or revoke dispatcher capabilities.

Prompt-level tool-use overlap was removed only when the base or schema retains the rule. Workspace boundaries, approvals, untrusted-input rules, task-plan lifecycle/error recovery, immutable finished plans, brief authority, checkpoint continuity, historical retrieval and final chart/Markdown formatting remain. The audit did not change the base-prompt stripping history, C7–C9 algorithms, dispatcher, MCP grants, cancellation, deletion or plan persistence.

Changed model-facing tool text:

| Tool | Description bytes before → after | Parameter-schema bytes before → after |
|---|---:|---:|
| spawn_sub_agent | 320 → 317 | 1119 → 1119 |
| web_search | 320 → 229 | 324 → 324 |
| run_tests | 320 → 275 | 501 → 422 |

## Native tool audit

All 51 catalog entries, including conditionally hidden tools, have description/schema costs, argument-contract hashes, availability by fixture, discovery path, representative scripted use, essentiality for that script and exclusion risk in the evidence. Cost estimates are bytes/3 rounded up separately for each column and should not be added to the full-request count. Argument-schema cost includes argument descriptions.

Availability remains governed by the shared policy: Casual permits authorized activated web/memory/media groups and discovery; Workspace exposes authorized groups directly. Read Only withholds edits/commands/Git mutations. Ask for Approval and Workspace Write preserve existing approval enforcement. Memory depends on settings; `ask_user` depends on clarification settings; image generation needs a configured backend; skill loading needs enabled project skills; LSP needs availability; Manual hides native MCP preparation; `manage_mcp_servers` is already excluded from the final advertisement. `delegate_task` is already shadowed by `execute_command` when present. No condition changed.

Representative coding usage is **scripted**, not observed model usage: search → read → surgical edit → verification, plus durable plan operations in stateful fixtures. Specific media/Git/web/LSP tools are not essential to this small script but can be essential for other authorized tasks. Excluding them without discovery can prevent completion. The inventory does not treat absence from one fixture as evidence that a capability is unnecessary.

| Native tool | Description tokens (est.) | Schema tokens (est.) | Group |
|---|---:|---:|---|
| manage_native_tools | 79 | 110 | clarification |
| lsp_definition | 53 | 162 | lsp |
| lsp_references | 64 | 176 | lsp |
| lsp_document_symbols | 43 | 123 | lsp |
| lsp_workspace_symbols | 49 | 108 | lsp |
| lsp_hover | 38 | 106 | lsp |
| lsp_diagnostics | 64 | 172 | lsp |
| find_and_prepare_mcp_tools | 89 | 113 | mcp |
| use_skill | 35 | 95 | skills |
| propose_skill | 41 | 135 | skills |
| manage_mcp_servers | 94 | 203 | mcp |
| approve_mcp_mutation | 73 | 72 | mcp |
| get_recent_chat_history | 90 | 355 | memory |
| delegate_task | 46 | 110 | subagents |
| generate_image | 60 | 65 | media |
| spawn_sub_agent | 106 | 373 | subagents |
| web_search | 77 | 108 | web |
| get_single_web_page_content | 101 | 50 | web |
| extract_web_page_data | 39 | 81 | web |
| execute_command | 107 | 293 | commands |
| get_command_status | 28 | 54 | commands |
| stop_background_command | 32 | 54 | commands |
| run_tests | 92 | 141 | commands |
| update_plan | 107 | 516 | tasks |
| get_project_plans | 108 | 243 | tasks |
| str_replace_editor | 99 | 196 | editing |
| search_project_content | 40 | 78 | files |
| take_screenshot | 73 | 48 | media |
| read_project_file | 107 | 304 | files |
| write_project_file | 107 | 219 | editing |
| move_project_file | 40 | 105 | editing |
| delete_project_file | 107 | 109 | editing |
| edit_project_files | 108 | 212 | editing |
| apply_patch | 64 | 75 | editing |
| list_directory | 16 | 61 | files |
| git_status | 58 | 26 | git_read |
| git_diff | 78 | 167 | git_read |
| git_log | 36 | 136 | git_read |
| git_show | 43 | 131 | git_read |
| git_branch | 34 | 26 | git_read |
| git_stage | 61 | 88 | git_write |
| git_unstage | 73 | 89 | git_write |
| git_commit | 104 | 60 | git_write |
| git_create_branch | 74 | 138 | git_write |
| git_switch | 58 | 54 | git_write |
| git_sync | 107 | 158 | git_write |
| git_stash | 77 | 147 | git_write |
| git_blame | 54 | 164 | git_read |
| search_memory | 66 | 407 | memory |
| save_memory | 107 | 96 | memory |
| ask_user | 38 | 101 | clarification |

## Verification and preexisting failures

The direct-file selection covers 85 files: prompt/schema/budget tests, permissions/approval, provider serialization/caching, MCP integration, Workspace, C7–C9, plans/worklogs, context telemetry/UI, subagent access/history, cancellation and recovery. Baseline module snapshots were loaded without reverting or overwriting the working tree. **63/85 files passed before; 65/85 passed after**, with no newly failing file or newly failing final subtest identified. This is not an all-green suite claim. Exact filenames, failing subtest identities and errors are in `validation.before` and `validation.after` in the evidence.

Notable successful final checks: `t2PromptBudgets` 12/12 (including real scripted local/cloud agent loops, source search/read/edit/test, MCP refresh and permission downgrade); `subagentModelSelection` 14/14; `subagentFailureDiagnostics` 5/5; `subagentCompaction` 26/26. C7 reliability, C8 effective compaction, C9 simple compaction, safe compaction, checkpoint/brief/plan behavior and telemetry tests are included in the passing selected files where indicated by the evidence. Successful summary certification remains synthetic fixture coverage.

Preexisting failing direct-file identities (retained rather than repaired outside P1):

- `tests/cloudProviders.test.cjs`: not ok 16 - cloud chat POST survives a GET-only global.fetch override (sub-agent shim).
- `tests/compactionActivity.ui.cjs`: .
- `tests/contextC3LiveProtection.test.cjs`: not ok 3 - status-only transition during summary generation rolls back all archival and summary writes.
- `tests/contextPanel.ui.cjs`: .
- `tests/mcpManager.test.cjs`: not ok 2 - real stdio discovery, pagination, namespacing, execution and disable.
- `tests/mcpSse.test.cjs`: not ok 1 - SSE sends configured headers on GET and POST, discovers tools, executes and reloads; not ok 3 - untyped URLs fall back after SSE GET 405; explicit SSE does not POST to that URL.
- `tests/sessionPromptWording.test.cjs`: not ok 4 - workspace retains safety, activation, task continuity and MCP discovery.
- `tests/steeringPrompts.ui.cjs`: .
- `tests/subAgentBadge.ui.cjs`: .
- `tests/subAgentRunner.test.cjs`: .
- `tests/subagentAcceptance.ui.cjs`: .
- `tests/subagentModal.ui.cjs`: .
- `tests/subagentOutOfProcessRecovery.test.cjs`: not ok 1 - a child persisted by another OS process is recovered and continued here.
- `tests/subagentSession.test.cjs`: not ok 7 - each spawn_sub_agent call opens its own completed child session end to end.
- `tests/toolApprovalCharacterization.test.cjs`: not ok 1 - real guard and MCP dispatch retain frozen decisions except intentional Workspace Write changes.
- `tests/unifiedToolArchitecture.test.cjs`: not ok 6 - compaction preserves every structural field and validator compiles the complete registry.
- `tests/workLogPanel.ui.cjs`: .
- `tests/workspaceBudgetVerification.test.cjs`: not ok 5 - concurrent history change during measurement invalidates without partial persistence.
- `tests/workspacePlan.ui.cjs`: .
- `tests/workspaceWritePhase2.test.cjs`: not ok 7 - Git real guard: fetch silent, pull once with cached incoming commits, push twice; not ok 8 - clean switch runs without approval; dirty switch asks and still refuses to discard; not ok 15 - commit message and staged diff are persisted in the actual IPC tool-call card; not ok 20 - all six acceptance commands execute in the real sandbox with zero prompts.

Failure causes include blocked local listeners (`EPERM`), Git subprocess sandbox restrictions, and stale UI/prompt expectations already present in the initial tree. `sessionPromptWording` still expects “get the existing plan” while the initial and final implementation say “get it first”; its other three assertions pass. The baseline `t2PromptBudgets` three budget failures are resolved by the measured reduction. `subagentCompaction` final rerun passes. No preexisting failure was silently relabelled as passing.

`npm test` fails before edits because this Node runtime cannot resolve the `tests/` directory entrypoint. An explicit broad `node --test` run before edits yields 224/338 file wrappers passing, 114 failing; legacy standalone scripts are therefore also run directly for useful assertion-level results. No unrelated test-runner fix was introduced.

`npm run build` **passes**; Vite retains its nonfatal >500KB chunk warning. `git diff --check` **passes**. No commits, pushes, stash/reset/clean, live database writes, model restarts or user setting changes occurred.

## Remaining overhead and recommendation

The remaining schema payload is mostly real argument structure and tool-specific guidance. The largest catalog entries by description plus parameter bytes are `update_plan`, `spawn_sub_agent`, `search_memory`, `get_recent_chat_history`, `read_project_file` and `execute_command`. Some long descriptions still undergo the preexisting blind cap (notably plan/command guidance). Do not shorten security or recovery guidance merely to meet a token target.

Dynamic Workspace selection is worth evaluating separately because native advertisements dominate. It is not justified as an automatic change from one scripted coding trace. Existing Casual discovery provides a starting point, but Workspace would need authorized complete catalog discovery, run ownership, downgrade handling, unavailable-tool honesty, MCP coexistence, post-compaction continuity, worker consistency and tool-call pairing coverage. Any trial must prove edit/test completion across diverse real tasks and measure the extra discovery rounds and accumulated input cost. P1 does not implement it.

The next low-risk optimization is curated, complete model-facing summaries for the remaining capped tool descriptions, especially `update_plan` and `execute_command`, followed by matched real-model `/apply-template` + `/tokenize` captures for these same fixtures. Then evaluate optional Workspace group discovery behind focused acceptance tests. No claim is made that shorter prompts improve model accuracy.

## Reproduce

Run `node scripts/audits/p1PromptEfficiency.cjs /tmp/p1-current.json docs/p1-prompt-tool-schema-efficiency-evidence.json`. It creates disposable fixtures, captures all serializers, verifies retained argument contracts and tool sets against the recorded baseline, asserts every final serialized request shrinks, and checks key safety/read-only rules. The output includes normalized bodies for inspection; the checked-in evidence stores measured sizes, component attribution, contract fingerprints and request hashes instead of repeated full bodies. For regression tests run each selected file in the evidence as `node <file>`; the final wording/description follow-ups were rerun after the 85-file pass. Build with `npm run build`, then `git diff --check`.

Exact model input-token certification and real-model quality testing remain **unverified**, explicitly separate from the achieved byte reduction and deterministic capability checks.
