# P2 — compact native tool profile

Implemented 2026-10-28 (Asia/Dhaka). **Opt-in Workspace profile: 16 tools, 21,390 serialized local request bytes, 7,194 estimated input tokens**, versus 46 conditionally available advertisements, 41,647 bytes and 13,947 estimated tokens in the full-profile greeting fixture. The registry still contains all **51 legacy tools**. Savings: **48.6% of full request bytes**, 6,753 estimated input tokens per fresh greeting. The preferred 5,000–7,000 estimate target is narrowly missed; no validation was weakened to meet it.

[Machine-readable measurements, all 51 coverage rows, test results and failure identities](p2-compact-native-tools-evidence.json).

## Enable and fall back

Start a future application process with `CONTINUUM_NATIVE_TOOL_PROFILE=compact` to opt in. Leave it unset, or use `full`, for the existing catalog. No live process or model was restarted or reconfigured during this work. There is no UI setting or silent user/conversation migration. The selection is captured by `nativeToolActivation.begin` and remains stable until the owning run ends. Compact selection is applied only to Workspace; Casual retains its existing discovery-based selection. Sessionless integrations keep their full catalog. Compact runs log their selected profile.

## Controlled stages and design decision

Stage A used isolated P1 production request fixtures and an unchanged-schema subset: 20,469 bytes / 6,887 estimated tokens before discovery. This supported Stage B. The final profile includes both native discovery and direct MCP preparation. Stage C exercises deterministic agent requests, real disposable file/command handlers, serializers, permission checks and checkpoint continuation. The deterministic model responses are scripted; they do not establish model inference quality.

The primary interfaces keep their existing names and exact argument contracts. A new alias would require coordinated changes to outer approval policy, manifest fingerprints, specialized dispatch and child allowlists, adding risk without reducing schema payload. Git mutations remain individually discoverable and route to their original guarded handlers. The offline `code_intelligence` prototype measures a shared operation schema at 1057 bytes against 3999 bytes for six legacy LSP definitions. It compiles, and operation-specific required-position checks remain necessary. It is **not advertised or routed in production**: feature-specific permission/manifest/child identities remain authoritative. This is a selection-first implementation rather than a dispatcher rewrite.

Direct tools:

`ask_user`, `execute_command`, `find_and_prepare_mcp_tools`, `get_command_status`, `get_project_plans`, `get_recent_chat_history`, `git_diff`, `git_status`, `list_directory`, `manage_native_tools`, `read_project_file`, `search_project_content`, `stop_background_command`, `str_replace_editor`, `update_plan`, `write_project_file`.

Keep status/diff and both plan tools direct to avoid recovery rounds. Keep surgical replacement and guarded file writing direct. Batch edits, patches, moves and deletes remain available through `editing`. Keep background status/stop separate: their schemas are already small. Historical retrieval remains separate from personal memory. No giant union, permissive payload, schema truncation or shell-based Git wrapper was introduced.

## Actual serialized request measurements

Production `runMemoryChat` JSON bodies are intercepted at injected fetch; production OpenAI and Anthropic serializers transform the same bodies. UTF-8 bytes are exact. Tokens use production `approximateTokens`: `ceil(serialized UTF-8 bytes / 3) + 32 × normalized message count`. These are **estimates**, not a tokenizer or billing measurement. Temporary paths and dates are normalized. Tool-schema accounting includes schemas actually sent. Local covers llama.cpp/OpenAI-compatible normalization; cloud mappings cover OpenRouter/OpenAI and Anthropic adapters. No live provider/model calls occur.

| Greeting profile | Tools | Tool JSON bytes | Local request bytes | Estimated tokens |
|---|---:|---:|---:|---:|
| full | 46 | 34195 | 41,647 | 13,947 |
| compact | 16 | 13780 | 21,390 | 7,194 |
| compact-lsp | 22 | 17778 | 25,388 | 8,527 |
| compact-lsp-editing-git_write | 33 | 25028 | 32,638 | 10,944 |
| compact-web | 19 | 15425 | 23,035 | 7,743 |

Tool JSON includes descriptions, property schemas and JSON framing; it is not just source text. The entire default profile schema remains unchanged except the discovery tool gains an optional bounded intent query. Fifty other legacy argument-contract hashes match the pre-P2 fixture. Full-profile Workspace advertisements and request byte sizes match pre-P2 across all eight Workspace scenarios and all three serializers. Casual retains its selection/activation behavior, with a 105-byte additive discovery-query schema increase.

| Identical scenario | Full bytes | Compact bytes | Full → compact estimated tokens |
|---|---:|---:|---:|
| Casual greeting | 5,482 | 5,482 | 1,892 → 1,892 |
| Workspace greeting | 41,647 | 21,390 | 13,947 → 7,194 |
| Read-only task | 23,708 | 16,146 | 7,967 → 5,446 |
| Coding task | 41,693 | 21,436 | 13,962 → 7,210 |
| MCP disabled | 41,647 | 21,390 | 13,947 → 7,194 |
| MCP Auto | 41,647 | 21,390 | 13,947 → 7,194 |
| MCP Manual | 40,637 | 20,380 | 13,610 → 6,858 |
| Active checkpoint | 44,078 | 23,821 | 14,789 → 8,037 |
| Post-compaction request | 43,195 | 22,938 | 14,463 → 7,710 |

| Greeting serializer | Full bytes | Compact bytes | Full → compact estimated tokens |
|---|---:|---:|---:|
| local | 41,647 | 21,390 | 13,947 → 7,194 |
| openai | 41,549 | 21,292 | 13,914 → 7,162 |
| anthropic | 40,248 | 20,861 | 13,448 → 6,986 |

MCP Auto/Manual fixtures use an empty isolated external catalog; the disabled scenario has one explicitly disabled server. External MCP schemas are never treated as native wrappers. The new integration test separately checks that an authorized external schema survives selection unchanged and Manual suppresses preparation/management. Arbitrary user MCP catalogs will have additional schema costs. In specialized read-only measurement scenarios, groups with no authorized tools are skipped rather than claiming activation.

## Discovery cost and lifecycle

`manage_native_tools({action:"list", query:"definitions"})` searches group names, capability descriptions and tool names. Omit query to list all 13 groups. Responses distinguish available, unavailable and unauthorized entries; partially available groups identify unavailable/unauthorized members. `activate` validates every requested group before changing state, requires the owning run, confirms activation only after runtime success, and reports already active groups. Repeated activation does not increment the count. Activated schemas appear on the next refreshed request; current permissions, configuration, memory/media/skills/LSP availability still filter each advertisement.

Production activation calls derive availability from the full authorized catalog, never the compact subset. Compact Auto mode can discover the original MCP management interface; full Workspace retains its existing MCP presentation. Activation grants no approval. Legacy delegate_task shadowing when execute_command is available is unchanged.

The bounded fixed registry prevents unbounded accumulation (13 groups / 51 capabilities); no inactive-group eviction was added because changing advertisements while calls are in flight would require further lifecycle design. State clears at the owning run end or session deletion. It survives automatic C9 checkpoint/rebuild in that run, but not application restart or a later user run.

Representative production-loop fixtures use real file/search/edit/write/command handlers and scripted model responses. They verify tool-call/result pairing, refreshed schemas and Anthropic conversion on evolving transcripts. All calls succeed:

| Task | Profile | Requests | Discovery calls | Failed calls | Total estimated input tokens |
|---|---|---:|---:|---:|---:|
| Search/read/edit/write/test | full | 6 | 0 | 0 | 87,327 |
| Search/read/edit/write/test | compact | 6 | 0 | 0 | 46,814 |
| Coding + batch edit | full | 7 | 0 | 0 | 102,686 |
| Coding + batch edit | compact | 9 | 2 | 0 | 75,821 |

Common coding saves 40,513 estimated input tokens across six requests. The batch-edit fixture spends two additional requests on list/activate and returns 526/534 bytes respectively for those discovery results, yet still saves 26,865 estimated input tokens overall. Short specialized tasks can lose this advantage: discovery adds full request/response rounds, not merely schema bytes. The JSON retains each request measurement; no latency or real-model round count is claimed.

## Preservation and safety

- **Editing/R2:** unchanged exact/safe matching, localized E2 diagnostics, guarded hashes/revisions, multi-file rejection atomicity, containment and read pagination. New tests perform surgical JSX/CSS changes, accept a batch and reject a batch with no partial modification. Existing E1/E2/R2 suites pass.
- **Git:** no generic mutation route. Stage, commit, sync, switch and stash retain the existing operation-specific guards, staged-state fingerprints, sandbox/network checks and policy-revision enforcement. Read-only discovery reports mutations unauthorized and cannot activate them; forged writes still fail. Real Git process suites have the same sandbox failures as baseline; successful live Git commit/push acceptance is not claimed.
- **LSP:** service eligibility and availability filtering occur before selection; original feature schemas, cursor/position validation and trusted execution context remain. The offline combined schema is not a substitute for these checks. Real bundled-server failures remain baseline limitations.
- **Plans:** keep update_plan and get_project_plans separate. Original create/update/get distinctions, plan/session ownership, completed history, revisions, PLAN_NOT_FOUND and PLAN_EXISTS remain. No lifecycle defects were masked or redesigned.
- **History/memory:** get_recent_chat_history remains direct, including source message/step/brief retrieval and pagination. Memory settings independently suppress search_memory/save_memory. Existing source validation, deleted-session guards and archived evidence behavior are untouched.
- **MCP/subagents:** original server grants, Auto/Manual selection, manifest fingerprints, mutation approvals and dynamic refresh remain. Child allowlists and their separate dispatcher are untouched; parent activation is not inherited as child permission. Existing model selection, budgets, cancellation and transcripts are retained.
- **C7–C9:** no algorithm or summary-gate edits. Real fixture compaction confirms activated editing/Git schemas survive rebuilding, then a permission downgrade hides writes. Existing C9 4,999-token gate, source retrieval, pending-call handling and completed-call non-replay suites remain authoritative.
- **Persistence/providers:** unchanged tool names, arguments, result identities and handlers mean historical records are not migrated or rewritten. Schemas are selected before context telemetry/request accounting. Existing native manifests validate current advertised contracts and permissions before dispatch; no automatic unload invalidates in-flight calls.

## All 51 legacy capabilities

The JSON provides full per-capability handler, conditions, permissions, argument conversion, error behavior, contract hash and test mapping. Tests listed here are coverage references; exact pass/fail status is in the evidence, not implied by a listed filename. All tools retain their existing implementation and validation.

| Legacy tool | Compact path | Permission capability |
|---|---|---|
| `manage_native_tools` | Direct unchanged tool | read |
| `lsp_definition` | manage_native_tools activate lsp → lsp_definition | lsp |
| `lsp_references` | manage_native_tools activate lsp → lsp_references | lsp |
| `lsp_document_symbols` | manage_native_tools activate lsp → lsp_document_symbols | lsp |
| `lsp_workspace_symbols` | manage_native_tools activate lsp → lsp_workspace_symbols | lsp |
| `lsp_hover` | manage_native_tools activate lsp → lsp_hover | lsp |
| `lsp_diagnostics` | manage_native_tools activate lsp → lsp_diagnostics | lsp |
| `find_and_prepare_mcp_tools` | Direct unchanged tool | external_mutation |
| `use_skill` | manage_native_tools activate skills → use_skill | read |
| `propose_skill` | manage_native_tools activate skills → propose_skill | read |
| `manage_mcp_servers` | manage_native_tools activate mcp → manage_mcp_servers (compact only, Auto; full profile remains unchanged) | external_mutation |
| `approve_mcp_mutation` | manage_native_tools activate mcp → approve_mcp_mutation | external_mutation |
| `get_recent_chat_history` | Direct unchanged tool | read |
| `delegate_task` | manage_native_tools activate subagents → delegate_task (legacy shadowing retained when execute_command is available) | agent_spawn |
| `generate_image` | manage_native_tools activate media → generate_image | external_mutation |
| `spawn_sub_agent` | manage_native_tools activate subagents → spawn_sub_agent | agent_spawn |
| `web_search` | manage_native_tools activate web → web_search | read |
| `get_single_web_page_content` | manage_native_tools activate web → get_single_web_page_content | read |
| `extract_web_page_data` | manage_native_tools activate web → extract_web_page_data | read |
| `execute_command` | Direct unchanged tool | local_execution |
| `get_command_status` | Direct unchanged tool | read |
| `stop_background_command` | Direct unchanged tool | read |
| `run_tests` | manage_native_tools activate commands → run_tests | local_execution |
| `update_plan` | Direct unchanged tool | plan_write |
| `get_project_plans` | Direct unchanged tool | plan_read |
| `str_replace_editor` | Direct unchanged tool | workspace_write |
| `search_project_content` | Direct unchanged tool | read |
| `take_screenshot` | manage_native_tools activate media → take_screenshot | read |
| `read_project_file` | Direct unchanged tool | read |
| `write_project_file` | Direct unchanged tool | workspace_write |
| `move_project_file` | manage_native_tools activate editing → move_project_file | workspace_write |
| `delete_project_file` | manage_native_tools activate editing → delete_project_file | file_delete |
| `edit_project_files` | manage_native_tools activate editing → edit_project_files | workspace_write |
| `apply_patch` | manage_native_tools activate editing → apply_patch | workspace_write |
| `list_directory` | Direct unchanged tool | read |
| `git_status` | Direct unchanged tool | read |
| `git_diff` | Direct unchanged tool | read |
| `git_log` | manage_native_tools activate git_read → git_log | read |
| `git_show` | manage_native_tools activate git_read → git_show | read |
| `git_branch` | manage_native_tools activate git_read → git_branch | read |
| `git_stage` | manage_native_tools activate git_write → git_stage | workspace_write |
| `git_unstage` | manage_native_tools activate git_write → git_unstage | workspace_write |
| `git_commit` | manage_native_tools activate git_write → git_commit | external_mutation |
| `git_create_branch` | manage_native_tools activate git_write → git_create_branch | workspace_write |
| `git_switch` | manage_native_tools activate git_write → git_switch | workspace_write |
| `git_sync` | manage_native_tools activate git_write → git_sync | external_mutation |
| `git_stash` | manage_native_tools activate git_write → git_stash | workspace_write |
| `git_blame` | manage_native_tools activate git_read → git_blame | read |
| `search_memory` | manage_native_tools activate memory → search_memory | read |
| `save_memory` | manage_native_tools activate memory → save_memory | memory_write |
| `ask_user` | Direct unchanged tool | Existing clarification policy |

## Verification and limitations

- New P2 integration suite: **8/8 pass**.
- Paired before/after baseline: **21 files**, identical exit statuses and extracted failure identities. Six files fail both times: unifiedToolArchitecture (existing edit argument expectation), toolApprovalCharacterization/Git suites (sandbox Git EPERM and downstream expectations), lspCodeIntelligence/lspAgentIntegration (server termination and existing integration assumptions), sessionPromptWording (existing wording expectation).
- Additional full-profile suites: 11/12 pass. recentChatHistory fails its stale `/For recall, retrieve evidence/` prompt assertion; this additional suite was not in the paired baseline and is not represented as a newly verified baseline pass. No historical-retrieval implementation changed.
- Explicit compact environment: **16/16 suites pass**, including E1/E2, command/background IPC, deletion/history, C7/C8/C9, plans, MCP and child compaction.
- `npm run build`: **passes**, with the existing Vite large-chunk warning. `git diff --check`: **passes**.

No tests were modified to hide unrelated failures. These are focused file executions (`node tests/<name>.test.cjs`), not a claim that the entire repository test suite passes. No real Qwen/GLM inference, authoritative tokenizer count, live cloud/MCP/media operation, or successful sandbox-blocked Git/LSP execution is claimed. Exact method and failures remain in JSON.

## Reproduce and real Qwen/GLM acceptance

Run `node scripts/audits/p2CompactNativeTools.cjs /tmp/p2-full.json` with the profile variable unset, then `CONTINUUM_NATIVE_TOOL_PROFILE=compact node scripts/audits/p2CompactNativeTools.cjs /tmp/p2-compact.json`. Add `P2_GROUPS=lsp` or `P2_GROUPS=lsp,editing,git_write` for specialized cases. All roots/configuration/database files are disposable and removed on exit. Run `P2_LOOP_EVIDENCE=/tmp/p2-loop.json node tests/p2CompactNativeTools.test.cjs` for deterministic coding/discovery round measurements.

For an independently authorized real Qwen/GLM acceptance run, use disposable project/config/database roots, a safely available matching tokenizer and an already running permitted model endpoint. Do not load/reconfigure a model merely to obtain a count. Repeat identical objectives with full and compact profiles: source search/read, JSX/CSS and batch edits, file creation, tests, background start/stop, Git read and separately approved stage/commit, rejected mutation, LSP navigation, source-history retrieval, plan create/update/get, discovery, prepared MCP call, read-only child, checkpoint continuation and deleted-session late call. Capture actual request JSON, provider token usage or matching template/tokenize counts, failed calls, discovery rounds, approvals, persisted tool IDs/results and post-checkpoint schemas. Compare output correctness and total input cost, not just first-request size. Run blocked Git/LSP cases in an environment supporting their normal containment; do not bypass guards. Real-model acceptance remains outstanding.

## Scope and stop point

Only P2 selection/discovery integration and new audit/test/report artifacts were added. Existing P1/C9 tracked and untracked edits were preserved, including preexisting changes in shared promptBuilder/agentTools files. No compaction logic, TaskFlow sources, live SQLite database, model lifecycle or unrelated subsystem was changed. No commit, push, stash, reset or clean was performed. Work stops at P2.
