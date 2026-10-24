# T2 prompt budgets and dynamic native activation

Implementation and deterministic validation: 2026-10-23. **Exact 6K/2K model-tokenizer acceptance is unverified.** No paid inference was used. No model-reported counts or irreducible token floor are claimed. All numeric token figures below are estimates of complete serialized requests, not the Context panel's stored-message estimate.

## Baseline and scope

Initial Git status contained only two untracked user audit artifacts: `docs/token-overhead-regression-audit.md` and `docs/token-overhead-regression-evidence.json`. Both were preserved. No commits, resets, stashes, dependency changes or user-store mutations were performed. Database fixtures use temporary Electron data directories; projects and executed verification commands target disposable directories.

Read the token-overhead audit/evidence, W1 audit, C1 report, dynamic MCP hot-activation report, context-budget recovery reliability and partial C3 reports. Source authority: promptBuilder, baseSystemPrompt, nativeTools, agentTools, toolPermissions, lspExecutionContext, ipcHandlers, memoryChat, cloudProviders and promptMeasurement.

Before editing, captured five production `prepareChatMessages` + `getToolContext` requests for Casual and all four Workspace modes. Existing configured MCP descriptions were read without connecting servers. These snapshots contain 17 inactive server descriptions and no inactive MCP schemas. Temporary root names introduce a few characters of fixture variance. Baseline evidence is source reconstruction, not the historical screenshot count.

`npm test` itself fails under Node 22.23.2: `Cannot find module '.../tests'` because its command is `node --test tests/`. The explicit broad baseline command was `node --test tests/*.test.cjs tests/*.test.mjs`: 219 files, 188 passing, 31 failing. Failure identities are preserved in the evidence JSON. Existing failures were not repaired as unrelated work.

## Architecture and authorization

The existing production agent loop calls `getChatTools` before inference checkpoints for local/cloud continuation. T2 uses that checkpoint; it does not add an inference engine, dispatch path, MCP implementation or schema-refresh-only request. Tool-call/result pairing stays in memoryChat and provider adapters.

Initial native core: `manage_native_tools`; Workspace also retains `ask_user` because existing Workspace policy forces clarification support on. Active MCP schemas keep their existing session visibility. The new tool lists currently authorized native groups or activates explicitly requested groups. Its schema carries the finite group enum. Unknown groups and cross-owner activation fail; an activation performs no underlying operation. Current permission filtering is reapplied to every refresh, including after a downgrade. Groups with only a few currently allowed members expose only those members.

Run-owned state is opened at engine:chat entry and removed in its existing finally block with an owner-ID check. Activation is idempotent, finite and retained through recovery within that run. New runs/sessions start compact. No automatic mid-run deactivation: this avoids losing unresolved status tools or creating activation thrashing. Completed calls/results are retained by the existing loop. Legacy sessionless/model-less inspection APIs retain their full authorized catalog contract; actual identified chat requests use the compact catalog.

Group inventory:

```text
files: listing, search, ranged file reading
editing: surgical/batch edits, verified writes, patches, moves, deletion
lsp: definitions, references, document/workspace symbols, hover, diagnostics
commands: execution, structured verification, background status/cancellation
git_read: status, diff, log, show, branches, blame
git_write: staging, commits, branch mutations, sync, stash
tasks: session plan and same-project plan retrieval
subagents: isolated workers and legacy file delegation where available
web: search, page reads, isolated extraction
memory: memory search/save and recent-chat retrieval
media: screenshots and configured image generation
skills: load and propose skills
mcp: installed-server management and mutation approval
```

Native discovery has READ capability only. The existing `guardTool`, dispatcher, bwrap/path boundaries, approval grants, revision checks, deletion restrictions, LSP context and MCP grants remain authoritative. Activation supplies no grant. Child runtimes keep their own fixed authorized tools; the new state does not expand a child's whitelist. Tests exercise read-only write rejection, live downgrade/upgrade, scoped deletion approval, parent/child separation and current owning run.

## Prompt changes and durable context

Compact session base instructions replace repeated prose while preserving memory boundaries, greeting behavior, untrusted-content handling, media rendering/failure rules and permissions. Legacy base variants still deduplicate. User persona/system configuration remains intact once; the disabled-memory override remains explicit. Specialized subagent protocol is returned with activation and reinserted on recovery when that group remains active.

Workspace retains concise task continuity, original user requirements, plan recovery, verified edits and truthful test-result guidance. Casual omits Workspace execution/planning/background-command guidance. Both can discover authorized optional capabilities. MCP creation/browser details travel with the MCP native group.

Eager automatic directory trees were removed. Project identity/path, user description, custom instructions, explicitly selected context files, repository AGENTS.md/PROJECT.md and matching skill instructions remain. These required/user-selected inputs can legitimately exceed the initial budget. No user text is truncated to fit it.

Task briefs/checkpoints/plans/work logs/summary construction, original prompt storage, C1's 90% trigger and partial C3 in-progress archival safeguards were not redesigned or removed. A fresh Workspace request still includes its small verbatim brief wrapper. This is accounted for, rather than hidden. Large requests/personas and task state survive the deterministic tests. W2 is outside scope.

## Measurements

Method: `ceil(JSON.stringify(complete request).length / 4)`, explicitly estimated. Request includes model, messages, tool schemas, sampling, stream/tool-choice/cache framing. This conservative wire-size proxy is not the model's chat-template token count; some JSON parameters do not become model tokens. Component figures overlap and must not be summed. Actual tokenizer and model-reported fields remain null.

Production `promptMeasurement` still uses server `/apply-template` + `/tokenize` where supported, and the existing full-request fallback elsewhere. Activation state now participates in its stale-state identity. Results include chatMode/provider/model, measurementMethod/confidence, initial/post-activation totals, component estimates, activation count/groups. Existing usage/billing telemetry remains unchanged.

Comparable captured requests with 17 inactive MCP descriptions:

| Scenario | Before estimated tokens | After estimated tokens | Reduction |
|---|---:|---:|---:|
| casual | 7,462 | 1,810 | 75.74% |
| read_only | 9,097 | 2,201 | 75.81% |
| ask_approval | 13,336 | 2,201 | 83.5% |
| workspace_write | 14,280 | 2,202 | 84.58% |
| full_access | 14,279 | 2,201 | 84.59% |
| lsp activated (full_access) | 14,279 | 3,145 | 77.97% |
| commands activated (full_access) | 14,279 | 3,020 | 78.85% |

Workspace + automatic MCP is represented by each Workspace row: catalog remains, inactive schemas stay absent. No-MCP disposable default: Casual **1,095**, Workspace **1,493** estimated tokens. This meets the requested *estimated* profiles with margin, including the Casual 1.5K preference. It does **not** establish exact-token acceptance for any model.

Explicit custom instructions, many configured MCP descriptions, selected project files, repository guidance and retained task state are variable configuration/context. None is silently cut to enforce a fresh greeting budget. No model tokenizer was reachable on the default local endpoint. Obtain an applicable loaded tokenizer before claiming exact pass or an irreducible floor.

## Continuation and activation overhead

The settings-modal test runs the real memoryChat loop and native dispatcher on a disposable React fixture, in both local and cloud loop modes: discover, activate files, search/read, activate editing, surgical edit, activate commands, run a real Node assertion. It preserves the stored plan, steering and paired results, continues under the same runtime context, rebuilds context with active tools, and tests permission downgrade and session isolation. Anthropic's production serializer is applied to every evolving transcript and checked for tool_result pairing and schema shape. These are deterministic mocked responses, not model-quality evidence or a full live provider test.

The fixture uses nine inference requests, eight tool operations and four discovery/activation responses (three actual group activations); no extra request exists solely to refresh schemas. Evidence records per-request tool counts, request estimates, total-run estimates and activation latency. MCP coexistence uses an isolated real manager with mocked connection and verifies session scoping/no duplicates. Existing MCP hot-activation tests exercise local/cloud and streaming/non-streaming continuation.

The twenty-call fixture uses 21 mocked inference requests, retains one activation across a deliberate file error, and verifies prior results at every checkpoint. Its final request and total-run estimates are recorded. No equivalent pre-change twenty-call run was captured, so the required before/after total-run cost comparison remains unavailable. First-request savings alone must not be represented as proof of lower ordinary-task total cost. Aggressive auto-deactivation and automatic preactivation are deferred.

## Validation and limitations

- New T2 suite: 12 deterministic checks passing, including all four permissions, custom Casual persona, large user text/task briefs, required guidance, native/MCP coexistence, real file edit/test, steering, recovery rebuild and twenty-call/error continuation.
- Focused production integration: context measurement, C1 integration, dynamic MCP activation, background-command IPC and T2 all pass.
- Broad before/after comparison: 219 files / 188 pass / 31 fail before; 220 files / 189 pass / 31 fail after. All 31 failing identities match exactly; no new failures. Evidence includes both lists. Native test-runner failures carry ERR_TEST_FAILURE at file level; the broad harness suppresses some child diagnostics.
- Production `npm run build` passes (existing large-chunk advisory only).
- Electron Context panel could not launch inside container sandbox. Outside it, the fixture failed `no token-savings claims in status`; no Context panel UI code changed. Baseline UI comparison was not established.
- Outside sandbox, chat-header functional assertions passed (`Chat vs Workspace header context and navigation OK`); fixture cleanup failed with ENOTEMPTY in temporary Session Storage. This is not reported as a clean UI pass.
- No actual model inference, provider billing, live database migration or destructive user-data tests. Actual model reload/session switching/live compaction quality and full provider transports were not end-to-end verified; inherited recovery/steering/child/background suites provide narrower coverage.

The exact-token acceptance gate and real-provider/model-quality gates remain open. T2 code is reviewable, with estimated savings and deterministic capability evidence; this report does not claim every requested acceptance item is complete. Remaining work is applicable-tokenizer measurement and live integration verification, not W2.

## Changed files

See the evidence JSON `filesChanged` list. Main production files: nativeToolActivation (finite run-scoped state/catalog), promptBuilder/baseSystemPrompt (compact profiles/selective project identity), agentTools/toolPermissions (existing dispatcher integration), ipcHandlers (run lifecycle), promptMeasurement (state identity and honest diagnostics). Existing tests were adjusted only where they asserted eager tool exposure or exact obsolete prompt prose; authorization assertions remain and IPC mock sequences now activate before operating.
