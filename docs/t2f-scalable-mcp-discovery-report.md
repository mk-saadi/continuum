# T2F — scalable MCP discovery and selective activation

Date: 2026-10-24 (Asia/Dhaka). Preserved working tree based on `78923fa85b21341ffe1dcc7c52fda514bcbf1ab5`.

## 1. Executive summary and confirmed defects

T2F removes the configured-server directory from both chat prompts and adds bounded capability search and run-scoped tool selection to the existing MCP manager. A 100-server/10,000-tool fixture has exactly the same fresh transport size as an empty catalog. A 150-tool server exposes two selected schemas, then accepts incremental selection in the same run. No replacement MCP client, dispatcher, database, dependency, or agent runtime was introduced.

Deterministic transport verification passes for local llama.cpp-format requests and actual Anthropic/OpenRouter adapters. Production build passes. Exact tokenizer, real-model inference and mounted Electron UI acceptance remain unverified. These limits must not be presented as full runtime acceptance. W2 has not been started.

## 2. Existing architecture and root causes

`McpManager` owns configuration, shared clients, tool listings and session server grants. Configuration is read from `mcp_config.json`, validated, written through an atomic file/queued change path and watched for reloads. Startup honors the existing lazy/UI enable rules; selected servers use existing stdio or remote SSE/HTTP clients. Shutdown closes those clients. MCP tools/list pagination and notification refresh already existed.

Previously `buildSessionSystemPrompt` called `getDiscoveryCatalog` and interpolated every configured server into system text. Each server row was clipped, but the total row count was unlimited. `getTools(sessionId)` then exposed every enabled tool of a session-visible connected server. These were separate defects: lazy connection alone fixed neither prompt-directory growth nor whole-server schema exposure.

Native activation uses a finite native group registry and a run-owned group set; it filters authorized native definitions without starting an external process. MCP uses shared server processes plus server-level session grants. Both converge at `getToolContext`, provider tool serialization, per-request schema refresh and the existing trusted dispatch/approval path. T2F adds MCP selections there, without replacing native activation.

Main-agent IPC starts/ends the MCP exposure run beside native activation. `runMemoryChat` obtains current schemas at each request, preserves tool-call IDs/results, and supplies a current request snapshot to activation preflight. Recovery refreshes the same schema set. Investigation children retain their independent allowlist: MCP management, hosted MCP tools and mutation approvals remain excluded.

## 3. Files changed by T2F

Production: `src/main/mcpManager.js`, `src/main/promptBuilder.js`, `src/main/nativeToolActivation.js`, `src/main/toolPermissions.js`, `src/main/tools/agentTools.js`, `src/main/ipcHandlers.js`, `src/lib/memoryChat.mjs`.

New tests: `tests/t2fMcpDiscovery.test.cjs`, `tests/t2fRuntimeMcpScaling.test.cjs`.

Updated expectations: `tests/agentTools.test.cjs`, `tests/promptCorrectness.test.cjs`, `tests/sessionPromptWording.test.cjs`, `tests/t2PromptBudgets.test.cjs`, `tests/t2eRuntimeMcpScaling.test.cjs`. Directory-in-prompt assertions now require its absence and verify searchable metadata separately. T2E's legacy whole-server fixture remains as explicit API compatibility coverage. Historical T2/T2E reports/evidence were preserved.

All other pre-existing dirty files were retained. No commits, resets, stashes, live database migrations, real account operations or user MCP configuration edits were performed.

## 4. Registry, search and pagination

The existing manager's server Map and cached tool metadata form the registry outside the prompt. Before manager initialization, search can read configuration metadata without launching a process. Search never returns environment variables, executable arguments, URLs, credentials or full input schemas. Unknown uncached tools become searchable after approved `inspect` of one chosen server; no attempt is made to start every configured server.

`manage_mcp_servers` accepts `search`, `inspect`, `activate` and the legacy `enable`, `disable`, `restart` actions. Search takes an optional capability query, exact `server_names: [id]` filter, limit and cursor. Default limit is 5; maximum is 10. Empty query browses the catalog. Query length is at most 500 characters. Names, optional display names, descriptions and tool names participate in case-insensitive matching. All non-stopword query fragments must match; separators include spaces, underscores, hyphens and slashes. Exact server/tool names rank first, followed by stable server/tool identifier ordering. This is deterministic substring search, not semantic search; an over-specific query may need refinement.

Each result is one server or tool, with exact identifiers, a clipped description, disabled/status fields and `metadataTrust: untrusted`. Duplicate display/tool names do not replace server identity. Descriptions are clipped to 240 characters; identifiers are never silently clipped. Result rows total at most 12,000 UTF-8 bytes, plus a small JSON envelope and fixed-size continuation. An identifier too large for one row produces `MCP_IDENTITY_TOO_LARGE` instead of corrupting identity.

Cursors contain an offset, catalog fingerprint and query/filter fingerprint. They bind the search and reject changed catalogs, statuses, schemas, display names or disabled-tool sets. They are not authorization tokens. Search visits the entire registry before pagination; a unique capability on server #99 is found. The 10,000-tool test also traverses matches across all 100 servers. Unicode, long malicious descriptions, invalid requests, empty results, disabled tools and stale cursors are covered.

## 5. Initial prompt and discovery interface

Both modes now receive one fixed discovery instruction. Neither names nor descriptions of installed servers are inserted into system instructions. The initial native discovery tool exposes the finite `mcp` group; activating it supplies the existing `manage_mcp_servers` interface. Its expanded schema is 978 bytes and is deferred rather than injected into every greeting. Thus MCP discovery is reached through native discovery, not a second always-advertised tool or a duplicate discovery system.

`getDiscoveryCatalog` remains a legacy metadata helper for compatibility/tests, but production prompt construction no longer calls it. Settings uses `getStatus`, not the removed prompt directory. No user content or task state is truncated.

## 6. Selective activation, compatibility and active lifecycle

`inspect` connects exactly one approved server with an empty selection. It exposes no hosted schemas; the model pages its tools using search filtered by server identifier. `activate` accepts up to 20 exact tool names for one server per request, validates their existence, disabled status and root schema shape, unions them with that run's prior selection, and exposes only that set. Incremental groups allow more than 20 tools overall when capacity permits. No hosted tool is executed by selection.

Tools keep the existing hashed provider-safe name derived from both server and raw tool identity. `getTools`, `resolveTool` and pre-dispatch checks use the selection. Activations are queued with configuration changes. Authorization/run identity is rechecked after asynchronous connection/measurement, and a schema snapshot detects notification changes during preflight. Failed capacity checks do not commit the proposed selection or discard existing selections. A failed activation may leave the approved server connected with an empty selection.

Legacy explicit server `enable`/`restart` retains whole-server exposure; `disable` revokes it. Settings/manual mode keeps its UI-enabled whole-server contract. The default model instructions prefer search/inspect/selective activation. Legacy whole-server operations retain the existing next-request context guard rather than gaining a new incompatible activation limit.

Main-agent selections reset at run start and are cleared with session server grants at owner-checked run completion. Shared processes may stay warm until existing lifecycle shutdown. New selective calls require an active owning run. Independent sessions retain independent selections. Model changes within a run rebuild schemas and preflight with the current request; a new run starts compact. Recovery keeps selections in trusted process state, never reconstructs grants from summaries, and allows incremental activation afterward. There is no automatic pruning of unused selections while a run has pending calls.

Disabled/removed servers disappear from model schemas/dispatch; configuration removal and Settings disable clear selections. Tool revocation removes explicitly selected names so re-enabling a tool does not silently restore that selection. Disconnection removes executable exposure; reconnect obtains the current listing. Existing tool-list notifications update selected schemas or remove missing tools. Existing cancellation/error behavior for already-dispatched external calls is retained.

## 7. Context capacity and runtime authorization

Selective activation preflights the prospective full active tool set against C1. Desktop IPC passes current history, native/MCP schemas, sampling and reasoning fields. Local measurement uses the existing `/props`, `/apply-template`, `/tokenize` measurer with labeled approximate fallback. Cloud uses existing advertised model metadata and `createRuntimeBudget`; unavailable capacity uses C1's conservative fallback. Standalone manager fixtures use the same C1 fallback on schemas. No independent model-token ceiling or invalid schema truncation is introduced.

Activation reports selected group schema bytes, added bytes and estimated added schema tokens. If capacity is exceeded it returns `MCP_ACTIVATION_BUDGET_EXCEEDED` and recommends a smaller selection. The existing request guard remains authoritative, including history/tool-result growth after preflight. Activation cannot guarantee a future result will fit.

Search is an action-specific read-only exception for the discovery interface. Connecting/selecting still uses the existing external-mutation approval policy and narrowly trusted bundled Playwright exception; Read Only cannot use selection to bypass that policy. MCP schema visibility grants no permission. Every hosted invocation still passes policy, live revision checks, one-use scoped mutation approvals and the existing client dispatcher. Ask for Permission, Workspace Write deletion restrictions and child ceilings are unchanged. Permission downgrade removes hosted schemas via existing policy filtering and rejects stale direct calls. Existing focused suites exercise grant revocation, approval races, mutation backstops and cross-session boundaries. Metadata is returned as untrusted tool data rather than trusted system instructions.

Failures distinguish invalid search/cursor, stale catalog/selection, unavailable catalog, disabled/removed server or tool, disconnected server, invalid root schema, missing active run, changed schema, unauthorized activation and activation capacity. Existing dispatch and permission-revocation errors remain explicit. No private arguments/results or credentials were added to logging.

## 8. Measurements and performance

Counts below use the same actual transport serializer and `ceil(JSON.stringify(body).length / 4)` proxy as the fresh T2E baseline. These are serialized-request estimates, **not exact model tokens**. C1 independently uses its more conservative full-request byte estimate and role allowance. Request/schema bytes, both estimates and fingerprints are in JSON. Empty schema arrays serialize to two bytes; they represent zero MCP schemas.

| Scenario, local provider | Fresh before | After |
| --- | ---: | ---: |
| Casual, 0 servers | 1,087 | 1,169 |
| Casual, 100 inactive servers | 4,304 | 1,169 |
| Workspace, 0 servers | 1,467 | 1,548 |
| Workspace, 100 inactive servers | 4,684 | 1,548 |
| Workspace, explicit legacy 150-tool activation | 9,650 | 9,508 |
| Workspace, two selected tools from that catalog | unavailable | 1,654 |

The 150-tool comparison reproduces the earlier `read_record_N` descriptions and JSON schemas: 31,841 schema bytes for all tools versus 425 bytes for two. The same serializer is used; synthetic temporary workspace names can affect request counts by a token. The selected pair need not be identical to a real task's tools. Schema savings are measured directly; no invented percentage is used.

Across local/Anthropic/OpenRouter, fresh Casual is 1,135–1,169 and Workspace 1,514–1,548. Each provider/mode has identical sizes at 0, 5, 20, 50 and 100 servers, including 10,000 tools. Casual meets the preferred 1.5K serialized estimate target; Workspace meets the preferred 3K target. C1 conservative estimates are 1,560–1,623 Casual and 2,056–2,129 Workspace, also below mandatory limits but Casual above the preferred 1.5K under that estimator. Exact tokenizer counts are null.

| Servers × tools/server | Cached tools | Search ms | Search rows | Response bytes | Activation ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 × 0 | 0 | 0.66 | 0 | 113 | — |
| 5 × 10 | 50 | 0.66 | 5 | 1,029 | 1.83 |
| 20 × 20 | 400 | 0.75 | 5 | 1,033 | 2.87 |
| 50 × 20 | 1,000 | 1.66 | 5 | 1,033 | 1.05 |
| 100 × 20 | 2,000 | 3.50 | 5 | 1,033 | 4.75 |
| 100 × 100 | 10,000 | 14.50 | 5 | 1,033 | 0.99 |

These are single-run mock timings, not production network latency. The largest serialized registry metadata is 1,414,902 bytes outside context. Heap deltas include fixture/request allocations and GC (some are negative); they are not peak RSS or isolated retained-memory measurements. Search is linear scan plus sorting of matches; it does not build an embedding index or launch subprocesses. No mock connection starts during discovery; activation connects only the selected server. Timings are recorded with full precision in evidence and the rounded table reflects that captured run.

The representative mixed task uses 12 model requests and 12 tool dispatches per provider, including discovery/activation and a two-call MCP batch. Cumulative estimated input: local 45,700, Anthropic 45,104, OpenRouter 45,295. These are whole multi-request task estimates, not the initial prompt floor or real provider billing. No directly equivalent selective task existed before T2F, so no comparative total-token saving is claimed.

## 9. Same-run, providers, recovery and security evidence

The deterministic task discovers native groups, activates files/MCP, searches GitHub-style metadata, inspects one mock server, searches its tool catalog, selects two tools, executes both with stable distinct IDs, searches/reads a real disposable source fixture, adds a third tool and answers without modifying files. It asserts stable trusted run identity, no duplicate dispatch, provider-specific ordered result pairing, no unrelated MCP schemas, session isolation and a live permission downgrade. A steering instruction is delivered exactly once.

Actual local OpenAI-format, Anthropic tool_use/tool_result and OpenRouter function/tool bodies are checked at transport boundaries. Cloud transports are mocked and fake credentials belong only to disposable fixtures. No paid inference occurs. The local recovery callback is triggered after the initial tools and before the third selection; history remains paired, earlier operations are not replayed and discovery/activation still works. This is recovery-callback compatibility, not a real overflow/compaction threshold acceptance test. Parent-cloud recovery and pre-existing C2/C3 architectural gaps remain outside T2F.

Lifecycle fixtures additionally cover concurrent queued selections, duplicate raw names across servers, stale identifier routing, schema updates, disconnect/reconnect, tool revoke/re-enable, server removal/add/description change, disabled-server rejection, manual-mode rejection, very large schemas, invalid root schemas, failed capacity checks and ending a run during activation.

## 10. Regression, build and UI

Fresh full baseline: 221 test files, 190 pass, 31 fail, zero skips. Full post-change: 223 files, 192 pass, the same 31 failing identities, zero skips. Exact passing/failing identities and set comparison are recorded in evidence. The historical 31 were not assumed; the fresh baseline reproduced them. Node 22 rejects `node --test tests/`, so both full runs use explicit `tests/*.test.cjs tests/*.test.mjs`. A `--test-reporter=json` attempt also fails because that reporter is unavailable; these environment/command errors were corrected before editing.

Expanded focused suite: 34 files, 31 pass, the same baseline failures `mcpIpc.test.cjs`, `mcpManager.test.cjs`, `mcpSse.test.cjs`, zero skips. New T2F direct suites have six named subtests, all passing. T2 native, updated T2E, permission, context C1/recovery, steering and provider tests are included. One heavily concurrent intermediate full run also hit the existing timing-sensitive backgroundCommands test; its direct rerun and final full run pass. Initial obsolete directory-wording assertions were updated to assert absent prompt metadata plus searchable registry entries; no security checks were weakened.

Production Vite build passed before and after; existing large-chunk warnings remain. `git diff --check` passes. No Settings components or IPC subscription registration/removal changed. Manager status and existing Settings enable/disable configuration APIs remain intact; deterministic lifecycle tests exercise those paths. A mounted Electron tab-context test was attempted under xvfb with the existing harness and aborted before assertions with `sandbox_host_linux.cc: shutdown: Operation not permitted`. Thus UI rendering, actual tab switching and process-level model/backend changes are not claimed verified.

## 11. Limitations and W2 readiness

No suitable workspace GGUF fixture was found; no user's active model was probed, restarted or disturbed. Real local inference, model-template/tokenizer counts, model susceptibility to malicious descriptions, mounted UI behavior and real remote transport behavior are unverified. Existing baseline transport/LSP failures remain. Root object schema shape is checked during activation; full JSON Schema validity and protocol transport validation continue to depend on the existing MCP SDK/provider path. Uncached tool descriptions are unavailable until a chosen server is inspected. Discovery is intentionally deterministic keyword search and may require refined queries. Explicit legacy full-server activation remains potentially expensive and relies on the existing request guard.

The two confirmed scaling defects are fixed and deterministic T2F gates pass. T2F does not establish full runtime release readiness or resolve C2/C3 compaction gaps. W2 should retain those verification prerequisites; it was not started here. No claim of exact-token or real-model acceptance is made.
