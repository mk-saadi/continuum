# Phase 2.6A-3 — native main-agent and subagent LSP integration

## Scope and architecture

All six tools are registered in the existing native `agentTools` catalog and dispatched through `executeAgentTool`. They are not MCP tools. The agent/provider/runtime/JSON-RPC/process infrastructure is reused without replacement. Phase 4 has not started; no commit, push, stash, reset or clean was performed in this phase. The working tree was clean at entry (`b69167e`).

Read all four Phase 1/2 report/evidence files and inspected the implementations, permission catalog and guard, native dispatcher, prompt/tool construction, memoryChat loop and tool formatting, subagent allowlist/runtime/budgets/deadlines/continuations, provider conversion, IPC/preload, Activity/transcript rendering, steering/recovery, file tools and build inclusion rules. Fresh baseline tests and build ran before editing.

Execution path:

```text
engine:chat → runMemoryChat → native executeAgentTool → LSP tool validation
  → live trusted context + canonical guardTool → Phase 2 codeIntelligence
  → Phase 1 manager → bundled TypeScript server → ordinary tool result/steps

spawn_sub_agent → existing child runtime/agentLoop → executeChildTool
  → same native dispatcher/adapter/manager → child's own transcript/activity
  → existing bounded completion → owning parent tool result
```

`src/main/tools/lspTools.js` contains only schemas, strict validation and dispatch glue. `src/main/lspExecutionContext.js` holds trusted live authorization state; it is not an execution engine. Phase 1 transport/lifecycle/launcher are unchanged. A small Phase 2 pagination extension adds a per-snapshot character budget before cursor creation, retaining the original immutable snapshot semantics and avoiding lost rows through post-pagination truncation.

## Registered schemas and argument validation

| Tool | Fresh-query arguments | Optional arguments |
| --- | --- | --- |
| lsp_definition | path, line, column | page_size, cursor |
| lsp_references | path, line, column | include_declaration, page_size, cursor |
| lsp_document_symbols | path | page_size, cursor |
| lsp_workspace_symbols | query | page_size, cursor |
| lsp_hover | path, line, column | none |
| lsp_diagnostics | path | severities, page_size, cursor |

List-tool continuations accept cursor alone plus optional page_size; path/position/query/filter arguments cannot be mixed into a continuation. Simple object schemas avoid provider-specific union machinery. Hover requires its three fields in the schema. For paginated tools, conditional fresh-query requirements are enforced at runtime. Additional properties are forbidden in both schema and execution. Strings, integers, booleans and severity arrays are validated, including path/query/cursor lengths. Columns are explicitly 1-based UTF-16; the adapter still handles protocol conversion and workspace/symlink boundaries.

Native pages accept 1–25 entries and default to 25, additionally constrained by a 6,000-character snapshot payload budget. Query length is at most 256 characters; path input at most 1,024; severities are numeric LSP values 1–4. No workspace/session/run identity, executable, method, raw URI, process argument, server option, permission object or root override can be supplied as a model argument. Malformed/unsupported arguments return LSP_INVALID_REQUEST. Unsupported languages retain LSP_UNSUPPORTED_LANGUAGE; there is no filesystem or other-language fallback.

## Main-agent registration and provider dispatch

`promptBuilder.getToolContext` uses the canonical visibility policy and current live LSP permission mode. `agent:get-tools` also filters the six LSP entries by eligibility while preserving the previous treatment of unrelated native entries. A workspace and eligible mode are required. Known failed-server entries and a closed manager suppress LSP advertisement; readiness itself is not required. First eligible use starts the bundled server lazily. Failure filtering uses the registered root key (symlink aliases may only discover a failed instance on execution); execution always performs canonical authorization.

The main IPC path passes a main-process-created execution context and minted run ID into the existing dispatcher. LSP dispatch never treats `permissionGranted` or a prior approval as an authorization bypass: it checks trusted-context membership, current mode, canonical guardTool, and then the adapter's independent session/project authorization. Local tools keep the normal OpenAI-style schemas; cloud provider conversion remains shared. Tests execute the real OpenRouter streaming and Anthropic conversion/JSON paths with mocked network responses and no paid inference. Tool calls/results retain existing IDs, normal model turns, streaming step updates, persistence and error handling.

Descriptions are the primary discovery mechanism. The main workspace prompt adds one short instruction distinguishing LSP navigation, file bodies/edits, tests/builds, and untrusted/freshness semantics. Only authorized child prompts add their short LSP instruction; the default Read Only child prompt stays unchanged, preserving prior compaction/budget behavior. No six-tool tutorial is injected into every request, and no cloud token or pricing code changed.

## Exact permission policy and live changes

| Mode | Main tool advertisement/execution | Child LSP eligibility/execution |
| --- | --- | --- |
| Read Only | hidden / denied | hidden / denied |
| Ask for Permission | hidden / denied | hidden / denied |
| Workspace Write | advertised / allowed with workspace | advertised / allowed with independent trusted grant |
| Full Access | advertised / allowed with workspace | advertised / allowed with independent trusted grant |

A dedicated native LSP capability in `toolPermissions` applies this exact matrix before generic read/full-access decisions. Shell execution, file writes/deletion, approvals, and all unrelated capability policies retain their existing meanings. Ask for Permission never prompts to launch LSP: it is denied.

The permission selector calls the new constrained preload/IPC `engine:set-permission-mode` channel. Only the existing trusted renderer may invoke it; an active run additionally requires ownership by the calling sender, using the existing activeStreams/requests records. It accepts only a session and canonical permission-mode value, not a server/run/root configuration. This channel updates LSP's live policy; it does not rewrite the existing shell or mutation authorization model. A main-run context reads that current policy on every access; initial policy comes from the actual main-run permission selection. Canonical session/project resolution remains authoritative for workspace identity.

The channel invokes Phase 2 `manager.permissionChanged` with the canonical previous workspace root. Eligible-to-eligible transitions retain the server. Downgrades shut it down and reject future operations/cursors; the existing in-flight authorization checks cancel a pending query and prevent result delivery. Upgrades enable subsequent queries and catalog refresh on the next model checkpoint. No new run is created and no task plan/steering state is reset. Tests cover Workspace Write→Read Only, Full Access→Ask, denied→allowed, sender ownership, active cancellation/revocation, and eligible peers sharing a workspace.

Live policy storage is bounded at 256 session records; eviction/forgetting revokes retained contexts. Session deletion forgets its live policy. Grants are not persisted. Full application restart requires a new trusted run/authorization; persisted child transcripts never reconstruct privileges automatically.

## Independent child authorization

The pre-existing child execution policy was fixed Read Only; there was no configurable child permission grant to reuse for local process startup. This phase adds a narrowly scoped LSP context without widening its ordinary tools. The normal native spawn wrapper authorizes the newly created child at its existing onSpawn boundary, verifies parent ownership, and stores the context in a WeakMap keyed by the actual child session object. Its workspace authority is the owning database chat's current authorized project, never a model-supplied root.

Default child LSP ceiling is Workspace Write, even when the parent has Full Access. A trusted runtime caller can independently lower or set the child's canonical LSP mode; a model cannot set it. Parent eligibility is a live additional ceiling. Thus a parent downgrade disables its children's LSP and an independently Read Only/Ask child remains denied even beneath an eligible parent. Other child tools continue to execute as Read Only, and write/shell/approval/spawn tools remain outside CHILD_TOOL_NAMES. No private parent conversation, child-to-child messages, task-plan access or direct child steering is added.

All six names are added to the existing child allowlist. Advertisement is filtered independently on every child model turn. Forged calls to hidden LSP tools still reach an execution-time denial. Tests exercise both independent denied child modes, eligible child execution, parent ownership, concurrent children, separate private transcripts, cancellation of one child without terminating its peer, and one shared language server. Existing child budget/deadline/scheduler/persistence/completion paths remain in control.

## Result bounds, pagination and freshness

Native results remain compact structured JSON so state, errors, cursors and provenance survive the generic formatter. Definitions/references carry locations; symbols retain parent/container metadata; hover keeps its bounded type signature/docs. No raw protocol envelope or full file is returned. All results carry `untrusted: true`; language-server text is data, not instructions. Activity expansion uses existing escaped code/text rendering and never executes HTML.

The original Phase 2 snapshot TTL/count/result/memory limits remain. The optional internal `outputLimit` is validated and stored with each snapshot. Page construction stops before exceeding that payload budget (always allowing one item), then creates its cursor at the exact number of returned rows. No rows are skipped merely to shrink a page. Model arguments cannot set this internal budget. Native diagnostic messages are further projected to 240 characters with messageTruncated, related messages to 120 characters and at most two related entries. A pathological result still exceeding 10,000 serialized characters returns LSP_OUTPUT_LIMIT instead of leaking an unbounded body or corrupting a cursor.

Continuation keeps original sourceVersion, snapshot ID, observedAt and immutable-query-snapshot provenance. It is historical evidence, not a claim about current repository state. Source edits during initial queries still produce STALE_RESULT, and invalid/expired/foreign cursors preserve adapter error categories. No automatic page retrieval or diagnostics-after-write behavior is added.

Diagnostics preserve ready/pending/stale/unavailable exactly. The bundled server's unversioned publications remain stale/unverified, including the observed clearing publication. A single-file empty result never proves a clean project. Related locations continue to be authorized by Phase 2; no dependency declarations outside the workspace are exposed.

A targeted child context-projection branch preserves valid JSON and sourceVersion/cursor/diagnostic-state metadata when a large LSP list must be excerpted for a small model context. It marks context_trimmed, incomplete and contextOmittedCount; complete original results remain in raw child history. Existing compaction scheduling, budgets, checkpoints and pair validation are unchanged.

## Cancellation, errors, activity and steering

Existing run signals flow through the dispatcher to the adapter/manager. Child signals combine their existing execution deadline with user/parent cancellation. No new timer manager is introduced. Cancelling one caller leaves a healthy shared server running; actual permission revocation follows Phase 2's conservative shared shutdown and eligible peers can reacquire. Timeout and server failure remain bounded structured errors rather than successful empty results. Existing application shutdown still owns the server process tree.

The main Activity block uses these labels: Find definition, Find references, Document symbols, Search workspace symbols, Inspect type information, Check diagnostics. It retains tool names, relevant path/query, status, result count, freshness/error code and measured duration. Payloads remain expandable; compact summaries do not dump diagnostics. Existing subagent activity events gain duration/count/state and stay attached to the owning child, with parent tool-call linkage unchanged. No LSP dashboard is added.

The real main IPC test queues steering during the LSP tool sequence, observes it at the next normal model checkpoint, preserves one minted run ID, receives all results, and persists the execution steps. Existing plan/recovery/work-log and steering mechanisms are reused without a new turn or plan reset.

## Real agent-path evidence and measurements

The temporary real fixture has a strict tsconfig, exported TypeScript function, imported cross-file usages, class/method, JS/JSX/TSX files and intentional error 2322. Real agent tools initialize the bundled server lazily; the model stub sees all six actual definitions, requests an outline and cross-file definition, references and a continuation, hover, file/workspace symbols and diagnostics. The test fixes the type annotation through a controlled fixture write, refreshes, waits on bounded diagnostic publication events, and observes error 2322 disappear without falsely upgrading freshness. A real child executes definition/references and delivers its answer to the owning parent's normal tool result. Concurrent children keep independent transcripts and share the server; a second project gets a separate instance and cannot use the first project's cursor. Shutdown is asserted clean.

Bundled server versions remain typescript-language-server 4.3.4, TypeScript 5.7.3 and vscode-jsonrpc 8.2.1. Network/model responses are deterministic stubs; the language-server subprocess, real database, actual main IPC/agent loop, native dispatcher, adapter and child runtime are exercised. No paid or live cloud inference was performed.

Schema serialization: 3,775 bytes for all six tools (roughly 944 tokens using a four-character estimate, not a tokenizer measurement). Cold first outline tool: 1608.14 ms; first outline/definition model batch including startup/IPC: 1849.28 ms; warm definition: 51.94 ms. These are one-host observations under concurrent test load. Server reuse across the real child is asserted by identical manager entry identity.

| Model-facing result | Serialized bytes | Diagnostic state |
| --- | ---: | --- |
| lsp_definition-1 | 615 | — |
| lsp_references-2 | 741 | — |
| lsp_references-3 | 741 | — |
| lsp_hover-4 | 347 | — |
| lsp_document_symbols-5 | 965 | — |
| lsp_workspace_symbols-6 | 536 | — |
| lsp_diagnostics-7 | 708 | stale |
| lsp_diagnostics-8 | 516 | stale |

The persisted main run completed in 9 model requests, with 45 streamed step-update events and execution-step persistence. The child completed in 2 requests. The evidence JSON includes actual normalized response examples, schema size, timings, child activity/ownership, cloud conversion outcomes, workspace isolation and clean shutdown. Tiny fixtures measure ordinary responses; the byte-budget/projection safeguards and invalid-input tests cover bounding behavior without inferring a token/RSS guarantee.

## Regression and UI verification

- Fresh baseline before edits: 1473 tests; 1448 passed; 25 failed.
- Final: 1483 tests; 1458 passed; 25 failed. New failing identities: 0; resolved identities: 0. Exact identities for both runs are recorded in the evidence artifact.
- Focused: 55/55 passed: 29 Phase 1–3 LSP tests plus 26 existing compaction tests. Full suite covers the requested permission, agent/subagent, streaming, steering, recovery, file-version and workspace regressions.
- Baseline and final production Vite builds passed with the existing >500 kB chunk warning. No dependencies or packaging configuration changed.
- Electron/Xvfb: new lspActivity UI test passed (six labels, locations/counts/state/duration, expansion and inert content); existing permissionMode and liveSteering UI tests passed. This is selected relevant UI verification, not a rerun of the entire UI catalog.
- Older allowlist/catalog tests now expect LSP to be filtered out of unauthenticated/default Read Only contexts. The Phase 2 boundary test now checks the constrained native names instead of forbidding Phase 3 registration. These expectation changes reflect the new feature boundary rather than relaxing unrelated security assertions.

## Files changed

- `docs/lsp-phase-2.6A-3-agent-integration-report.md`
- `docs/lsp-phase-2.6A-3-evidence.json`
- `src/components/ToolCallBlock.jsx`
- `src/components/chat/SubagentTranscriptModal.jsx`
- `src/components/main-app/ChatInterface.jsx`
- `src/lib/lspToolLabels.json`
- `src/lib/memoryChat.mjs`
- `src/main/ipcHandlers.js`
- `src/main/lspCodeIntelligence.js`
- `src/main/lspExecutionContext.js`
- `src/main/promptBuilder.js`
- `src/main/subagents/agentLoop.js`
- `src/main/subagents/contextRecovery.js`
- `src/main/toolPermissions.js`
- `src/main/tools/agentTools.js`
- `src/main/tools/lspTools.js`
- `src/main/tools/subagent.js`
- `src/preload.js`
- `tests/agentTools.test.cjs`
- `tests/backgroundExecution.test.cjs`
- `tests/childAgentLoop.test.cjs`
- `tests/childMessaging.test.cjs`
- `tests/lspActivity.ui.cjs`
- `tests/lspAgentIntegration.test.cjs`
- `tests/lspCodeIntelligence.test.cjs`
- `tests/subagentModelSelection.test.cjs`

## Known limitations

1. Unversioned diagnostics cannot prove current-version cleanliness. Pending is immediate rather than a blocking analysis promise; agents should preserve uncertainty and avoid repeated polling.
2. No genuine filesystem/network sandbox is added around TypeScript. The trusted bundled backend can internally inspect project configuration/dependencies beyond the wrapper's returned-location boundary; no additional output access is granted.
3. Revocation closes the shared server conservatively and can interrupt eligible peers; ordinary child/run cancellation does not close it. Peers can reacquire on demand.
4. Live grants are in-memory and bounded. Recovered children are denied LSP until independently authorized again by trusted runtime code; transcript recovery never carries executable authority.
5. Known-server failure filtering is best effort for configured root aliases; execution checks remain canonical and fail closed. There is no automatic retry/restart loop or custom executable installation.
6. The native 10,000-character backstop may return OUTPUT_LIMIT for a pathological individual item; use a smaller follow-up query where possible. Child context excerpts explicitly disclose omitted rows and retain the original raw result.
7. Model providers were tested with deterministic mocked responses through actual conversion/dispatch paths. The actual TaskFlow interaction and installed Windows/macOS builds have not been manually exercised here.

## Manual Continuum verification in TaskFlow (not performed automatically)

1. Open the existing TaskFlow workspace and select Workspace Write. Ask:

   “Analyze TaskFlow using your LSP tools. Find the definition and references of a task-related function, inspect its type information, check diagnostics, and explain how it works. Do not modify any files.”

   Verify native LSP calls in Activity, correct workspace-relative locations, expandable bounded results, honest diagnostic freshness and no source modifications. Compare workspace changes before/after.

2. Ask:

   “Delegate a read-only code architecture review to a subagent. Have it use LSP definitions, references, symbols and diagnostics to investigate TaskFlow. Report the findings without modifying files.”

   Here read-only describes the review objective, not the execution permission setting. Keep the parent eligible; its independently authorized child receives a Workspace Write LSP ceiling while its ordinary tools remain Read Only. Open the child's activity/transcript and confirm actual child-owned LSP calls, correct parent completion and unchanged files.

3. Select Read Only and Ask for Permission in turn. Verify LSP disappears on the next model checkpoint, manual/forged calls are denied, and an active downgrade prevents pending result delivery. Do not seek an MCP workaround. Upgrade to Workspace Write/Full Access and confirm lazy availability returns.

4. Queue a steering instruction during a query. Verify the existing run continues with the tool result and steering at the next checkpoint, without a new run or reset plan. Exercise a reference continuation and keep its historical provenance explicit.

## Phase 2.6A-4 recommendations

Review Phase 3 before further work. Phase 4 should verify installed Linux/Windows/macOS runtime paths, Electron run-as-node/fuses, offline dependency inclusion, notices/licenses, real process-tree shutdown and representative project size/performance. Exercise the TaskFlow manual procedure against actual selected local/cloud models when authorized. Decide an explicit UI/policy for reauthorizing recovered child LSP contexts and evaluate finer-grained shared-server revocation if peer interruption matters. Consider transport response-size hardening and alias-aware failure availability without weakening execution checks. Preserve the six-tool boundary; additional languages, installation, rename, code actions, formatting and project modifications require separate authorization and scope.
