# Unified tool architecture

## Implementation contract (recorded before behavior changes)

Workspace requests expose all supported native tools eligible under the existing permission, workspace and configuration filters, in deterministic name order. Native activation remains a compatibility API, not a prerequisite. Model-facing description compaction preserves every non-description schema field. Casual requests retain their bounded native exposure.

Auto MCP uses `find_and_prepare_mcp_tools` to search the existing manager registry, resolve one unambiguous enabled server, connect through existing activation, and prepare only matching tools. Uncertain matches return bounded choices. Manual mode excludes discovery and administration from model schemas and uses existing UI selection and disabled-tool state. Disabled configuration is never enabled by preparation.

Each inference boundary owns an immutable advertised-schema snapshot. Existing execution permission checks remain authoritative; external input validation uses original schemas. Consequential outbound operations require explicit approval even in Full Access. Existing provider formats, run ownership, context capacity checks and tool result pairing remain intact.

Validation and limitations will be recorded below; this contract does not assert completion.

## Implemented architecture and stage status

Date: 2026-10-24, Asia/Dhaka. Existing uncommitted work was preserved. No commits, pushes, stashes, resets, account mutations, paid inference, or W2 changes were made.

- **U1 implemented:** Workspace schema assembly directly exposes eligible native capabilities, compacts descriptions only, and orders native definitions lexically before external schemas. Existing mode, project, LSP, media, memory, question-setting and legacy delegation filters remain; skill loading additionally requires an enabled project skill. The old native group API remains compatible for administration/Casual use, but Workspace does not advertise or require it.
- **U2 implemented:** Auto advertises `find_and_prepare_mcp_tools`; Manual excludes it and model administration. Preparation reuses `searchCapabilities` and `activateTools`, the existing connection queue, session selections, authorization callback and context-capacity preflight. No second MCP client or dispatcher was introduced.
- **U3 implemented:** Main and investigation-child requests have trusted advertised-schema manifests, schema/source checks and current execution permission checks. External schemas are validated unchanged with pinned Ajv 8.20.0. Consequential outbound actions require explicit approval even in Full Access.
- **U4 verified for deterministic serialization/context integration:** Native order, external append boundary, conversation changes, permissions, model/session changes, recovery, and pairing are exercised. Actual backend token-prefix reuse remains unmeasured. Casual remains small and directs workspace requests to existing Workspace navigation; there is no new automatic transition workflow.
- **U5 regression/build work performed:** Full restricted and localhost-enabled runs, representative task simulations, large catalogs, and selected Electron fixtures were run. Remaining existing failures and missing real-model/browser validation mean full product acceptance is **not certified**.

The JSON evidence is the detailed measurement and failure record. These stage labels describe implementation, not proof that every acceptance criterion passed.

## Native inventory and schemas

The initial source contains exactly **50 registered definitions**: 47 agent definitions, two memory definitions, and `ask_user`. Adding the new MCP preparation definition makes **51 registrations**. The existing compatibility/admin definitions are retained. Registration count is distinct from executable schemas offered in a particular request.

| Group | Registered names |
| --- | --- |
| Files | `list_directory`, `search_project_content`, `read_project_file` |
| Editing | `str_replace_editor`, `edit_project_files`, `write_project_file`, `apply_patch`, `move_project_file`, `delete_project_file` |
| LSP | `lsp_definition`, `lsp_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_hover`, `lsp_diagnostics` |
| Commands | `execute_command`, `run_tests`, `get_command_status`, `stop_background_command` |
| Git read | `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_blame` |
| Git write | `git_stage`, `git_unstage`, `git_commit`, `git_create_branch`, `git_switch`, `git_sync`, `git_stash` |
| Tasks | `update_plan`, `get_project_plans` |
| Subagents | `spawn_sub_agent`, `delegate_task` |
| Web | `web_search`, `get_single_web_page_content`, `extract_web_page_data` |
| Memory | `search_memory`, `save_memory`, `get_recent_chat_history` |
| Media | `take_screenshot`, `generate_image` |
| Skills | `use_skill`, `propose_skill` |
| MCP | `find_and_prepare_mcp_tools`, `manage_mcp_servers`, `approve_mcp_mutation` |
| Compatibility/clarification | `manage_native_tools`, `ask_user` |

Workspace hides the two legacy management/discovery schemas, preserves the existing shadowing of `delegate_task` when commands are available, and hides image generation without a provider. It also hides `use_skill` when no project skill is enabled. The fixture therefore advertises 46 eligible definitions in Workspace Write/Full Access. Cloud adapters retain their existing exclusions of local-only legacy workers. Investigation children keep their independent read-only allowlist and LSP ceiling.

Description compaction collapses whitespace and bounds each description to 320 characters. Names, required fields, types, nested structures, enums, defaults, bounds, patterns and additional-property constraints are unchanged. No parameter or compatibility alias was removed. A structural comparison and schema compilation cover all 51 registrations; required-property rejection is tested for every definition with required arguments. Native domain validators and error contracts remain in the existing dispatcher; main inference calls also receive schema validation before dispatch.

Realistic execution coverage includes isolated file reading/search/editing, verification commands, plans, representative Git operations, LSP, memory, command lifecycle and child isolation through existing suites. Optional capabilities and every registered tool were **not all successfully executed** in one comprehensive 51-tool fixture. The full regression failures must not be interpreted as successful coverage.

Deterministic mocked completions prove dispatch names, argument validation and provider conversion, including first-call native reads and LSP eligibility. They do not measure model selection accuracy for ambiguous pairs (`read`/`search`, patch/edit, command/tests, status/diff, definition/references). Live selection accuracy and retry rates remain null.

## Auto and Manual MCP

Auto preparation searches the existing registry outside the prompt. It resolves one enabled server, connects an uncached selected server using an empty selection, retrieves authoritative tools/list, selects one unambiguous matching operation, applies the existing capacity preflight, and commits its session schema. An enabled Gmail fixture supports the natural query `gmail latest five messages`; small deterministic keyword normalization maps common email/recency terms. Exact tool identifiers rank ahead of substring variants.

An eligible operation needs one preparation call followed by direct MCP execution. Repeated execution uses the advertised schema and existing connection. At request boundaries, already selected disconnected servers reconnect through the existing manager/client without another model preparation call. Auto retains its exact selection; Manual retains UI selection. The ordinary permission/approval guard runs before reconnect, denied approval leaves the server unavailable, and policy/run/mode are revalidated before connection. Disabled configuration is checked authoritatively even if an older session grant exists. Setup errors are not retried every request. Tests cover one preparation, execution, repeated execution without reconnecting, native/MCP coexistence and same-run schema refresh across actual local-format, Anthropic and OpenRouter adapters. No paid provider inference was performed.

Ambiguous matches return bounded choices. Pagination never authorizes a partial page as an arbitrary integration choice. Exact server selection can resolve a tool with many substring matches. Cold catalogs without usable server purpose/identity metadata may need clarification; this is lexical discovery, not an embedding or general semantic search engine. Preparation does not call `enable` on deliberately disabled configuration. In Read Only, the public native tool returns capability search results and an explicit preparation restriction; it does not connect or execute external tools.

Read-oriented queries exclude known consequential operations. A Gmail read cannot prepare `send_email` merely because it is the server's only tool. A specifically requested send may be prepared, but execution still asks the user.

Manual uses existing UI-enabled server state and per-tool disabled selections. Only selected connected tools are exposed; an empty selection exposes none. Model-facing administration and Auto discovery are absent. Existing request-boundary assembly and current schema/source checks revoke stale calls when the user changes selection. No selected schema is silently dropped to satisfy a token target.

The initial server-index budget is **zero bytes**: no configured server directory is injected, even for small catalogs. The complete current registry remains searchable. Existing bounds are five results by default, ten maximum, 240-character descriptions, a 12,000-byte row budget and fingerprint-bound pagination. The 100-server/10,000-tool fixture keeps initial prompt size constant and finds late catalog entries without launching the catalog. Credentials, commands, environment and connection secrets are not returned in search results.

## Schema validation, approval and request ownership

External input schemas remain authoritative. Ajv validates required fields, types, nested fields, bounds, patterns, enums and additional-property rules without coercing or removing arguments. Compiled validators are cached with a bounded 256-entry cache. Unsupported dialects, unknown constraints or unsupported formats produce a clear compatibility error; preparation checks compatibility before declaring a tool ready. Draft-2020-12 and every possible MCP schema dialect are not claimed supported.

`getToolContext` returns aggregate exposed external schema cost and per-tool `mcpSchemaCosts`, using explicitly labeled character estimates. Existing context guards handle Manual pressure; selective Auto activation uses the full prospective request preflight. The existing UI receives aggregate tool/plugin estimates; no new per-tool selection-cost UI was designed.

Every main request records a run-owned request ID, session/run identity, native/external source identity, SHA-256 parameter-schema fingerprint, permission revision, MCP mode and configuration fingerprint. Children record their own request schemas and policy revision. The model cannot supply or reconstruct this manifest from text. Main dispatch requires membership in the originating manifest and matching current schema/source, then invokes existing permission and execution paths. The loop independently rejects unknown names and missing/repeated tool-call IDs. Current policy, server, tool selection and schema are rechecked; adding schemas cannot make an unadvertised response callable.

The manifest cache is bounded to four recent requests per run. Accepted asynchronous calls own their execution; a later schema refresh does not revisit their accepted manifest or discard paired results. Manifests are in-memory request ownership, not a second persisted authorization database. A recovered new run creates fresh advertisements instead of reconstructing grants from a summary. Existing active-step persistence, cancellation and transcript pairing are reused.

Explicit trusted approval is required in all writable modes for recognized sending, posting, publishing, deletion and financial operation names; mutating HTTP methods; and destructive SQL carried in query/sql fields. Legacy `approve_mcp_mutation` also requires a real approval channel even in Full Access. A hash or model-supplied `user_confirmed` field is not an outbound approval. The manager independently rejects outbound execution lacking an approved trusted grant. Native Workspace Write deletion containment and its approval/snapshot rules are unchanged.

Email, webpage and MCP result text remains untrusted. Tests include an MCP result asking the model to send mail, denied outbound approval, a send-only catalog queried for reading, and a legacy hash that cannot authorize another operation/session. This verifies the trusted gate, not immunity of a live model to all prompt injection.

**Boundary limitation:** operation names and top-level argument checks cannot universally classify arbitrary third-party `execute_code`, command or opaque API wrappers, or outbound effects hidden inside native Full Access shell programs. The named MCP approval gate does not provide network confinement for arbitrary programs. Configured MCP executables retain the existing trust and sandbox boundary. This implementation does not claim a universal semantic firewall or exhaustive financial/outbound classification.

## Prompt cost and cumulative work

All counts below estimate serialized JSON characters / 4; they are not actual tokenizer counts, cache hits or model-reported usage. The complete initial catalog was measured from before-edit source snapshots, rather than inferred from historical reports.

| Catalog | Estimated tokens |
| --- | ---: |
| Initial complete 50 registrations | 9,779 |
| Current complete 51 registrations after description compaction | 8,949 |
| Eligible Workspace Write/Full Access schemas in the fixture | 8,169 |

Largest compact schemas include `update_plan` (495), `spawn_sub_agent` (383), `search_memory` (377), `execute_command` (323), `get_project_plans` (288), and `read_project_file` (279) estimated tokens. The JSON includes the exact sampled ranking and per-mode measurements.

| Fresh request fixture | Approximate total input |
| --- | ---: |
| Casual hello | 1.36K |
| Workspace Read Only hello | 6.10K |
| Workspace Ask for Approval hello | 9.50K |
| Workspace Write/Full Access hello | 10.44K |

The catalog meets the preferred 10K budget under the historical characters/4 estimator. The unchanged conservative C1 budget guard uses UTF-8 bytes/3 plus message allowances; that estimator puts the complete catalog above 10K (roughly 12K). Exact tokenizer compliance therefore remains unverified. For the same current 51 registrations, description compaction changes 9,955 to 8,949 character-estimated tokens. Total Workspace overhead exceeds the 6K–9K preference in the fullest configurations. This measured configuration is not labeled compliant or an irreducible theoretical minimum. No eligible execution capability was hidden to force that target. Project instructions, user content and selected MCP schemas add their actual cost.

A fresh equivalent disposable coding workload loaded the actual before-edit builder/dispatcher snapshots and compared them with current direct exposure: search, read, verified edit, and run tests. Both completed and verified the edited fixture.

| Metric | Before (T2/T2F native workflow) | Direct |
| --- | ---: | ---: |
| Inference requests, including final answer | 9 | 5 |
| Native preparation calls | 4 | 0 |
| Execution calls | 4 | 4 |
| Cumulative estimated input | 31,628 | 53,526 |

Fewer requests **increased cumulative input** in this short workload. Mock fixture wall times are recorded as test timings only; they do not establish inference speedups. Output tokens and real task latency are unmeasured. The primary Gmail/browser loop measurements include a native call, one preparation, two hosted calls and an intentionally rejected hallucination; these are isolated operations with mocked MCP results, not live account or browser acceptance.

A separate equivalent Gmail workload returns five disposable messages through the real manager/dispatcher and mocked model/client. The before-edit Auto path takes seven requests (five preparations, one execution, final answer), totaling 18,084 estimated input tokens. Current Auto takes three requests (one preparation, one execution, final answer), totaling 32,061. Manual exposes two selected Gmail read/search schemas immediately: zero preparations, two executions, three requests, 142 estimated external schema tokens and 31,653 cumulative estimated input tokens. Each variant starts one fixture connection. The fake message asking for unauthorized sending causes no additional operation in the scripted workload; the independent trusted-approval tests establish the gate, not a model-resistance claim.

An additional local HTTP fixture verifies navigation and page/button inspection through a mocked Playwright MCP client: five requests, two preparations (one per operation), two executions, one connection, and 54,087 estimated cumulative input tokens. It checks actual local fixture content, while using no real browser engine. The full results and explicit null real-model/cache metrics are in the evidence.

## Prefix/cache, recovery and Casual behavior

Native definitions are sorted deterministically, independent of insertion order. External schemas sort deterministically after native definitions, with stable hashed provider names. Provider-required placement of messages and tools is unchanged. Tests compare repeated tool lists and native prefixes before/after external selection and exercise conversation growth, model/session changes, permission downgrade, context recovery, tool errors, repeated calls and steering.

These are serialized-JavaScript/provider-body observations. Actual llama.cpp chat-template token prefixes, cache reads/writes, prefill latency and prompt-evaluation time are **unmeasured**. Appending tools to an array is not proof of KV reuse. Existing nullable provider cache telemetry was preserved; its renderer fixture passes.

Casual's default fixture remains below 2K with persona/system instructions preserved. It retains small native group discovery for its relevant tools and the single Auto MCP capability; Manual retains only external UI selections. The prompt explicitly directs workspace work to Workspace. No permission mode changes automatically, and no filesystem/shell capability is granted by that text. Existing navigation is reused; input-preserving automatic handoff and duplicate-execution prevention during a real UI transition were not independently implemented or certified.

## Verification record and remaining acceptance gaps

The fresh restricted baseline was 224 test-file entries: 192 pass, 32 fail. `npm test` exited immediately with code 1; explicit test file globs were used consistently for the fresh baseline and final comparison. Exact before/after identities are in the evidence. Final totals and exact enabled-run failures are recorded in the evidence. Intermediate manifest-telemetry failures in minimal recovery mocks were repaired, and their four affected test files passed again. A concurrency assertion also failed in one heavily loaded run and passed focused retests; this timing observation remains recorded, without weakening its assertion.

The final restricted run has **226 file entries: 195 pass, 31 fail**, with **zero new failing identities** and `permissionIsolationReliability.test.cjs` resolved versus the 32-file baseline. The localhost-enabled run reports **1,734 tests: 1,721 pass, 12 fail, one skip**. No fresh enabled before-edit baseline was captured, so those assertion totals are not presented as an enabled before/after comparison.

The focused localhost-enabled authorization/LSP/provider/scaling gate passes **98/98** assertions, including reconnect and configuration-race cases. New unified architecture and security files pass. Existing suites verify file scope, symlink protections, command policies, native error contracts, plans, subagent ceilings, MCP lifecycle/selection/revocation, provider serialization, context budgeting/recovery, result pairing, repeated calls and Live Agent Steering. Historical activation-only expectations were rewritten to require direct schemas and zero native preparation; legacy API tests remain.

Production Vite build passes with the existing large-chunk warning. Electron fixtures pass for permission selectors, Live Agent Steering and honest cache-token display. The unchanged context-panel fixture fails `no token-savings claims in status`; it was not repaired as unrelated UI work. Initial restricted Electron startup was blocked; isolated display/socket-enabled fixtures were then used successfully.

A read-only health probe of the default local endpoint (`127.0.0.1:8080/health`) was refused. No live Qwen inference or tokenizer/cache experiment was performed, no model/session was restarted, and no paid inference was used. Real Playwright navigation, semantic model selection, all optional-native execution paths and full interactive session-transition/restart acceptance remain unverified. Mocked deterministic success is not presented as that evidence.

Remaining full-suite failures prevent a green-suite claim. Before declaring complete acceptance, run the outstanding real-model/cache/browser checks and resolve or independently baseline the remaining Electron/IPC/runtime fixture failures. Stop here: no Workspace W2 compaction or unrelated roadmap implementation was started.

## Files changed by this task

Production: `src/main/nativeToolActivation.js`, `promptBuilder.js`, `tools/agentTools.js`, `mcpManager.js`, `toolPermissions.js`, `mcpPermissionPolicy.js`, new `advertisedTools.js`, new `toolSchemaValidation.js`, `ipcHandlers.js`, `subagents/agentLoop.js`, and `src/lib/memoryChat.mjs`; `package.json` and lockfile explicitly pin already-present Ajv as a production dependency. Offline npm resolution was unavailable, so the existing matching lock entry was retained and only the root dependency declarations were added.

Tests: new `unifiedToolArchitecture.test.cjs`, new `unifiedMcpSecurity.test.cjs`; updated `t2PromptBudgets`, `t2eRuntimeMcpScaling`, `t2fRuntimeMcpScaling`, `agentTools`, `permissionPolicy`, `projects`, `recentChatHistory`, `sessionPromptWording`, `subagentModelSelection`, `subagentReliability`, `workspaceMcpApprovals`, `lspAgentIntegration`, and `permissionIsolationReliability` expectations/fixtures. These files include pre-existing changes that were preserved. The report/evidence list this task's touched files separately from the initial dirty working tree.
