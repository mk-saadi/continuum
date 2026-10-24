# T2E — runtime, native activation and MCP scaling verification

Date: 2026-10-23 (Asia/Dhaka). Source: preserved working tree at `78923fa85b21341ffe1dcc7c52fda514bcbf1ab5`.

## 1. Executive verdict

**T2E does not meet full acceptance.** Empty-catalog fresh requests provisionally meet the budgets by serialized-request estimate. All 50 tools are accounted for and eligible native schemas are reachable. Deterministic coding tasks and native/MCP coexistence pass. **Gate 3 fails:** configured MCP metadata is injected linearly into initial prompts; Casual exceeds 2K at 50 servers. There is no bounded capability search or server pagination. No architecture replacement or W2 work was performed.

## 2. Fresh baseline

Before adding audit tests: `78923fa85b21341ffe1dcc7c52fda514bcbf1ab5`, 220 files / 189 pass / 31 fail. Exact identities, initial dirty status and SHA-256 working-tree module fingerprints are in the evidence JSON. All pre-existing modified and untracked files were preserved. T2 implementation is in nativeToolActivation, promptBuilder/baseSystemPrompt, agentTools/toolPermissions, IPC run lifecycle and promptMeasurement. No production files were edited in T2E.

Fixtures use OS-temporary projects, Electron app-data paths, SQLite databases and disposable MCP configurations. MCP connections and cloud transports are injected; no live databases, account connections, symlinks to live stores or Git mutations are used. The audit tests clean only their own temporary roots.

## 3–6. Actual initial requests, Workspace/Casual budgets and measurement confidence

Production `prepareChatMessages` + `getToolContext` feed `runMemoryChat`. Local bodies are captured at its transport boundary. Cloud bodies are captured after `createCloudFetch` applies actual Anthropic/OpenRouter conversion. No paid requests occur. Estimates are `ceil(JSON.stringify(actualBody).length / 4)`, including message/schema/request framing. This is a reproducible wire-size proxy, not a template-aware token count: sampling and JSON envelope fields need not become model tokens. Exact and provider-reported real counts remain **null**. Synthetic fixture usage is never treated as a real count.

| Provider | Casual hello | Workspace hello, all four modes | Verdict |
| --- | --- | --- | --- |
| local | 1087 | 1466 | provisional estimate pass |
| anthropic | 1063 | 1435 | provisional estimate pass |
| openrouter | 1053 | 1432 | provisional estimate pass |

The reported ~1.1K/~1.5K empty-catalog figures are supported by independent transport captures. Casual meets the preferred 1.5K estimate target. Workspace meets the mandatory 6K and preferred 3K estimates. This is **not full tokenizer acceptance**.

| Local variant | Estimated input tokens |
| --- | --- |
| persona | 1104 |
| custom-system | 3719 |
| repository | 1480 |
| task-brief | 1512 |

The repository fixture is a disposable minimal React repository marker with AGENTS.md, not this real project or an exhaustive repository-context test. The task-brief variant retains one earlier user requirement plus hello; it is intentionally separate from the no-history benchmark. Large custom instructions exceed 2K without truncation; that is variable user content, not fixed-overhead regression. Existing T2 checks separately preserve a large persona, required project guidelines and large user input.

Every measured case records provider/model, UTF-8 request/system/persona/schema/catalog/project/task bytes, message count, request SHA-256, estimate/method/confidence and null exact/real-provider counts. Components are overlapping attribution, especially the system message containing task state, and must not be summed. MCP discovery metadata is prompt text, not an initially advertised standalone MCP schema.

## 7–9. Inventory, initial catalog and discoverability

The exact requested inventory is **50 unique schemas**, 38,750 serialized characters, 38,768 UTF-8 bytes, **9,688 estimated tokens**. The historical 38,750 characters / 9,688 estimate is reproduced; characters and UTF-8 bytes differ because descriptions contain Unicode.

Initial native catalog: Casual `manage_native_tools` (659 schema bytes); Workspace adds `ask_user` (1156 schema bytes). Local native schema estimates are 165 Casual / 289 Workspace tokens, measured independently in the direct T2 fixture using the same current schema serialization. No eager full-catalog exposure. The JSON `inventory` array is the 50-row matrix: group, initial visibility, capability, per-mode eligibility/activation and base policy decisions, parent/Casual/child contexts, dispatch registration, dependencies, coverage and actual result.

All eligible schemas returned by full policy filtering appear in the native group list and can be activated incrementally. Capability discovery is a finite group enum/list, not free-text search. Image generation is hidden without a provider; direct invocation returns an explicit error. LSP depends on a supported workspace and authorized mode. Legacy delegate_task remains available only where policy/provider filtering permits it and is shadowed by command execution. Child investigation keeps its separate whitelist, rather than inheriting the parent native catalog. Schema reachability is not proof that all 50 backends executed successfully.

## 10–11. Same-run activation and dispatch

The existing 12-check T2 suite passes directly. Its local/cloud loop creates a durable plan, lists/activates files, searches/reads a React component, activates editing, edits, activates commands and runs a real safe Node assertion. It checks steering, paired results, durable-plan reconstruction, authorization downgrade and another session. A 20-operation continuation passes through an intentional missing-file error with one activation and no repeated activation loop.

The new audit independently runs the coding task through local, direct Anthropic and OpenRouter adapters. Each compact task takes 8 mock inference requests (7 tool calls, including 3 activations), edits exactly once and passes a real disposable-project assertion. Full-catalog fixtures take 5 requests for the same 4 operational calls. Refresh happens on the next necessary request, with no dedicated schema-refresh round. Tool IDs/results and schema-name uniqueness are asserted at each request. The stable trusted execution context is held for each run; this is not a live Electron persisted-run-ID acceptance test.

## 12–13. MCP scaling, discovery and pagination

| Servers | Tools/server | Cached schemas | Catalog bytes | Casual estimate | Workspace estimate | Activated schemas | Post-activation Workspace estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 1087 | 1466 | 0 | — |
| 5 | 10 | 50 | 595 | 1431 | 1811 | 10 | 2326 |
| 20 | 20 | 400 | 2389 | 1884 | 2263 | 20 | 3298 |
| 50 | 20 | 1000 | 5989 | 2791 | 3171 | 20 | 4206 |
| 100 | 20 | 2000 | 11989 | 4304 | 4683 | 20 | 5718 |
| 100 | 100 | 10000 | 11989 | 4304 | 4683 | 100 | 9878 |

All mock schemas can remain cached outside context; inactive detailed schemas stay absent. Only the last server is activated in nonempty fixtures. Other sessions receive zero schemas. MCP activation latencies, discovery timings, heap deltas, result counts/bytes and request fingerprints are in JSON. These are single-run fixture timings; heap deltas include allocations from request construction, are not GC-normalized or peak RSS, and do not predict real server latency.

**Root cause:** `McpManager.getDiscoveryCatalog` maps every configured server to a text row; `buildSessionSystemPrompt` inserts the joined rows as optional integrations. Descriptions are clipped to 180 characters individually, but server identifiers and row count are not globally bounded. Growing server count therefore grows every rebuilt prompt. With populated caches but no explicit purpose, up to six tool descriptions per server can make rows larger still. The fixture uses short explicit descriptions, so the observed failure is not a worst case.

The result contains all 100 rows, including GitHub capability metadata at the last entry. Nothing is silently truncated; however, there is **no relevant bounded search, result limit, server pagination or tool-specific activation**. MCP `listTools` pagination exists for loading schemas from one connected server; that is not model-facing registry search/pagination. At 20 servers Casual still meets mandatory 2K by estimate but misses preferred 1.5K; at 50/100 it fails mandatory 2K. Workspace stays below 6K for these fixtures but growth is unbounded. Zero-server metadata overhead is zero.

A safe fix needs a model-accessible bounded registry search/continuation path coordinated with discovery, permissions and schema refresh. Merely truncating the list would strand later servers. **This workstream stops at the reproduced defect and follow-up recommendation**, under the no-redesign requirement.

## 14. One server with many tools

A 150-tool fixture needing only 2 exposes **all 150**: 31,841 schema bytes / 7,961 estimated schema tokens, and 9,649 estimated tokens in the post-activation Workspace request. This is later context, not a fresh-request budget failure. Tool-level activation is absent. A context window must accommodate this whole-server cost plus history/output reserves, or the existing guard may refuse continuation.

Selective exposure is feasible only with coordinated session tool selections, discovery, registry/dispatcher checks, refresh/revocation and preserved pending-call representation. It must not be implemented by slicing schemas. No such runtime rewrite was made. Disabled/removed server stale-name resolution is tested and rejected.

## 15. Native/MCP coexistence

One deterministic run activates native files and MCP management, reads the React fixture, enables the mock GitHub server through the native dispatcher, resolves and invokes its issue reader through the MCP manager, activates editing/commands, edits once and passes a real assertion. Eight requests, six native calls and one MCP call; no collisions or orphaned results. Another session sees no MCP schema. External accounts are never contacted.

## 16. Permissions and security

All four modes are included in the inventory/initial-request fixtures. Focused permissionPolicy, toolPermissions, nativePermissions and permissionIsolationReliability suites pass. Read Only excludes writes/commands and rejects direct writes. Ask for Permission keeps existing policy: some contained workspace actions are allowed, while external/unsafe operations require approval. Workspace Write retains deletion approval and path restrictions. Full Access retains trusted ownership, revision and runtime guards. Activated groups grant no permissions.

The new lifecycle fixture verifies a stale Full Access dispatch cannot write after a live downgrade. Existing focused tests cover pending-approval revocation, scoped MCP mutation grants, shared LSP caller isolation, child ceilings, asynchronous pre-dispatch revocation and workspace boundaries. No permission policy changed. Real-LSP integration failures remain in the baseline, so full LSP runtime acceptance is not claimed.

Untrusted MCP descriptions do not determine executable trust, ownership or permission decisions. They are still interpolated into system-role catalog text. Deterministic transports cannot establish model prompt-injection resistance; that limitation remains explicit. Security must continue to rely on backend guards, never catalog prose.

## 17. Sessions, tabs and lifecycle

Independent native activations, Casual exclusion, owner-checked cleanup, reopened/new-run compact state, model-change schema rebuilding, separate MCP grants, disable/removal and permission downgrades pass in runtime fixtures. Process-local native state resets on process restart by construction; a full app restart is not tested. MCP grants are session state, not native run state, and can persist for the same session.

Electron `tabContextPersistence.ui.cjs` was attempted with xvfb and aborted before assertions (`sandbox_host_linux.cc`, Operation not permitted). Switching/closing/reopening actual mounted tabs, subscription cleanup and model/backend restarts remain unverified. No MCP session-close cleanup API was found for sessionServers/sessionDisabled; session churn and shutdown cleanup require focused follow-up rather than assuming a cross-session grant leak.

## 18. Compaction compatibility

Existing contextC1/C1Integration, contextC3LiveProtection, contextOverflowRecovery, contextDispatch and steering suites pass in the focused run. The new local coding task explicitly invokes the production recovery callback after tool work, retains paired live results, refreshes schemas, then activates another group without replaying an edit or command. That callback is a deterministic simulation, **not a real 90% threshold/model overflow**. Existing budget fixtures separately test threshold/guard behavior.

Source inspection confirms recovery rebuilds historical prefix and retains the current-run tail, while native activation remains trusted process state. It does not derive authority from model summaries. Current-run tail growth, missing parent C2 validation/preservation/full-resumed-fit guarantees and partial C3 remain broader compaction blockers. Parent cloud recovery parity is not established. W2 was not implemented.

## 19–20. Local runtime and cloud serializers

No compatible llama-server process or suitable non-hidden workspace GGUF fixture was found; no current model was disturbed. Local transport, template/tokenizer guard fixtures and optional reasoning controls are tested deterministically, but no exact tokenizer or real local-model activation smoke passes are claimed.

Actual Anthropic/OpenRouter adapters are exercised for greeting and every evolving coding-task request. Anthropic tool_use/tool_result IDs and dynamic tools, OpenRouter function/tool messages and local tools are checked. ReasoningRuntime and cloud prompt caching/accounting suites pass in focused regression; usage in this audit is synthetic and excluded from real counts. The existing cloudProviders file still fails a real localhost listening test (`listen EPERM`), despite the new injected-adapter paths passing. No live cloud compatibility or billing measurement is claimed.

## 21. Cumulative efficiency

| Provider | Compact requests | Compact cumulative estimate | 50-schema requests | 50-schema cumulative estimate | Estimated savings |
| --- | --- | --- | --- | --- | --- |
| local | 8 | 25986 | 5 | 55892 | 53.5% |
| anthropic | 8 | 25449 | 5 | 54027 | 52.9% |
| openrouter | 8 | 25713 | 5 | 55722 | 53.9% |

The baseline is a controlled 50-schema request fixture with the current schema text, not a production architecture toggle. Both execute identical search/read/edit/test operations against separate disposable projects. Compact adds three activation rounds, zero failed/repeated activations. Estimates include all subsequent request histories/results. Output token counts and real inference latency are unavailable. These fixtures demonstrate no pathological activation loop; they do not prove model decision quality or superiority to other agent harnesses.

## 22–24. Focused/full regression and production build

Focused run: **37/37 files pass**. New audit: **8/8 named checks pass** directly; existing T2: **12/12 named checks pass** directly. The final new-file-only test-runner check also passes. Full explicit-file suite: baseline **220 files / 189 pass / 31 fail**; final **221 / 190 / 31**. Added failing identities: 0; resolved: 0. These are file-level suite counts, not individual assertion totals. All exact identities and timings are in JSON.

`npm test` itself fails because its `node --test tests/` command resolves a missing directory module on this Node 22 setup. The full suite was therefore run using `node --test tests/*.test.cjs tests/*.test.mjs` before and after. This is not a green full-suite claim; no unrelated failures were fixed. UI scripts are outside that glob and the attempted isolated Electron UI run failed as above.

Production `npm run build`: **passed, 13.13 seconds**, existing >500 kB chunk warning. This is Vite production build, not Electron packaging. `git diff --check` passes.

## 25. Files changed

Created only the new eight-check audit suite and these Markdown/JSON reports. **No production changes.** Existing T2 implementation/tests/docs remain intact. No commits, pushes, stashes, resets, cleans, dependency upgrades or W2 implementation.

## 26–28. Limitations, follow-up and W2 readiness

1. Add bounded searchable MCP registry discovery with continuation and explicit treatment of untrusted metadata; preserve later-server reachability. This requires separate scoped implementation approval, not a T2E truncation patch.
2. Design optional per-tool/small-group MCP exposure with matching registry/dispatch/revocation semantics; measure whole-server costs until then.
3. Run actual template-aware tokenizer and harmless local-model smoke cases in an available isolated runtime. Verify real activation decision quality, not just scripted transport responses.
4. Validate mounted-tab lifecycle, model changes, backend restart, MCP session cleanup and clean Electron interaction in a working desktop environment.
5. Resolve existing regression failures in their own workstreams. Complete the established C2/C3 preservation and resumed-request-fit prerequisites before implementing long-running current-run compaction.

**Ready to resume W2: No.** Native activation has useful deterministic evidence, and fresh empty-catalog costs are provisionally low, but MCP scaling fails mandatory requirements and exact/live/UI acceptance remains incomplete. Stop after this T2E report.
