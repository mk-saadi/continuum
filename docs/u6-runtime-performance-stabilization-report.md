# U6 runtime, performance and stabilization report

Date: 2026-10-24 (Asia/Dhaka). Revision `78923fa85b21341ffe1dcc7c52fda514bcbf1ab5`, branch `main`.

## 1. Executive summary

The historical coding result reproduces exactly: **31,628 → 53,526 estimated cumulative input tokens**, while requests fall **9 → 5**. Advertising the eligible native schemas on every request adds **28,348.25 character-estimated tokens** across this fixture. Reduced activation results/history offset about 6,450 tokens. No duplicate-history or unexpected-MCP cause was found in this workload. Token cost after U6 remains **53,526**; no inference performance improvement is claimed.

Three targeted defects were repaired: opaque/unknown MCP capabilities lacked a mandatory approval gate; duplicate advertised names silently replaced manifest entries; the installed Playwright MCP's authoritative JSON Schema 2020-12 could not compile. Real isolated Chromium navigation and inspection now work through Auto and Manual. Native tools remain directly advertised. No dispatcher, client, activation architecture or W2 redesign was introduced.

**Full U6 acceptance is not certified.** Real Qwen/tokenizer/KV measurements remain unavailable. Existing native Full Access shell execution remains an opaque outbound-effect boundary. The full suite retains its 12 localhost-enabled failures, including three unresolved behavioral mismatches. W2 should not begin yet.

## 2. Fresh baseline

Recorded `git status --short`, branch and revision before editing production code. There were 29 modified tracked files and 21 untracked files; exact original identities and initial-diff fingerprint are in the evidence JSON. Existing work was preserved. No commit, push, stash, reset, clean, restoration, credential change or production database mutation occurred.

The fresh baseline ran **before production edits**. Instrumentation scripts were added after the baseline; all mutation fixtures use temporary databases/workspaces. HOME and XDG configuration/data paths were redirected to `/tmp/continuum-u6`. Existing tests mock Electron and model/provider responses. Localhost-enabled executions received tool approval; application sandbox settings were retained. No paid inference or real Gmail account was used.

| Run | Tests/file entries | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Restricted baseline | 226 file entries | 195 | 31 | 0 |
| Restricted final | 227 file entries | 196 | 31 | 0 |
| Localhost baseline | 1,734 assertions/entries | 1,721 | 12 | 1 |
| Localhost final | 1,740 assertions/entries | 1,727 | 12 | 1 |

Command: `node --test --test-reporter=tap tests/*.test.cjs tests/*.test.mjs`, with isolated HOME/XDG paths, both restricted and localhost-enabled. Restricted output exposes file-level child failures; independent direct-file reruns provide inner test names and messages. Do not compare its 31 file entries to the enabled run's 12 failing tests as the same unit.

## 3. Source inspected

Read all seven requested reports/evidence files and the actual native registry, compact schema builder, MCP manager/selection/preparation, request manifests, permission gates, inference loop, cloud serializer, local context guard/tokenizer, engine launch/cache settings, session persistence, command lifecycle, child isolation and relevant tests. Exact source references and SHA-256 fingerprints are in `sourceFilesInspected` in the evidence. Reports were treated as historical claims, then checked against code and fresh execution.

## 4. Files changed

Production changes are limited to `mcpPermissionPolicy.js`, `advertisedTools.js`, `toolSchemaValidation.js`, and one discovery-eligibility expression in `mcpManager.js`. The latter preserves preparation of opaque tools while requiring approval at execution, instead of accidentally making them undiscoverable. Existing stdio/SSE tests now supply explicit trusted fixture grants for opaque echo/failure tools; their transport and single-use SQL checks remain intact. Six assertions in `u6RuntimeSecurity.test.cjs` cover the changes. Four U6 diagnostic scripts and the two requested documents were added. The evidence lists only U6 modifications separately from the initial dirty tree.

## 5. Original cumulative-token regression

Replayed the saved historical builder/dispatcher modules in a disposable fixture using current shared dependencies, then the current builder/dispatcher. This is a **historical-module reconstruction**, not a whole-version live model A/B. No checkout/reset occurred. The identical task searches, reads, edits `App.jsx`, runs a real harmless Node assertion and verifies the final file. The mock model returns predetermined calls; task success does not measure model selection accuracy.

Historical per-request estimates: 1,586; 2,038; 2,675; 2,758; 2,864; 4,237; 4,418; 5,399; 5,653. Current estimates: 10,452; 10,535; 10,641; 10,822; 11,076. Both totals match the original evidence exactly. Four historical native preparation calls disappear.

## 6. Per-request cost breakdown

Counts below are **serialized JSON characters / 4**, not tokenizer tokens. Each message/tool belongs to one category; JSON delimiters/options are separately charged to serialization. Category estimates are unrounded fractions; total estimates round up per request. No component is counted twice. The scripted fixture contains no injected task checkpoint, document context or MCP schema, so those categories are zero. Fixed instructions include the assembled system/project instructions.

| Request | Total estimate | Native schemas | Instructions | User | Assistant history | Tool results | Serialized bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 10,452 | 8,156.75 | 2,202.00 | 27.00 | 0.00 | 0.00 | 41,826 |
| 2 | 10,535 | 8,156.75 | 2,202.00 | 27.00 | 41.25 | 41.25 | 42,158 |
| 3 | 10,641 | 8,156.75 | 2,202.00 | 27.00 | 83.00 | 104.75 | 42,581 |
| 4 | 10,822 | 8,156.75 | 2,288.75 | 27.00 | 153.25 | 128.25 | 43,309 |
| 5 | 11,076 | 8,156.75 | 2,288.75 | 27.00 | 237.25 | 297.75 | 44,325 |

The evidence includes every request for both reconstructed historical and current variants, plus cumulative totals separately. Exact formatted tokens, actual context capacity, output tokens, prefill/cache metrics and model latency are null. Workflow elapsed time measures fixture execution only. This is opt-in diagnostic instrumentation of representative transport requests, not an always-on production prompt logger.

## 7. Confirmed root causes

| Exclusive cumulative component | Historical reconstruction | Current/U6 | Delta |
| --- | ---: | ---: | ---: |
| Native schemas | 12,435.50 | 40,783.75 | +28,348.25 |
| Fixed instructions | 11,199.75 | 11,183.50 | -16.25 |
| User messages | 243.00 | 135.00 | -108.00 |
| Assistant/tool-call history | 1,677.00 | 514.75 | -1,162.25 |
| Tool results | 5,546.00 | 572.00 | -4,974.00 |
| JSON structure/options | 524.00 | 333.75 | -190.25 |
| Rounding to per-request integers | 2.75 | 3.25 | +0.50 |
| Total | 31,628 | 53,526 | +21,898 |

The native schema increase explains more than the net growth; activation-result/history savings offset it. No failed calls occur in this successful coding fixture. No MCP schemas are present. Instructions are larger per current request, but fewer requests leave their cumulative contribution almost unchanged. This does not prove every real workflow has the same attribution. The historical estimator itself remains an approximation.

## 8. Exact tokenizer availability

Installed llama.cpp: `version: 0.4.0-dev (build 10899, commit d7680c67b)`. A read-only `/health` probe at localhost:8080 was refused. Bounded depth-four searches of accessible home/media locations found no GGUF fixture; this is not an exhaustive inventory. No user model was loaded or disturbed, and no weights were downloaded.

The existing C1 integration probes `/props`, renders `/apply-template`, verifies schema presence, and calls `/tokenize`. These paths pass mocked contract tests but could not be exercised with a disposable loaded GGUF here. Serialized estimates, formatted prompt tokens, per-slot input budget, prompt tokens evaluated, cached tokens, output and total occupancy remain distinct; all actual backend values are null.

## 9. Prompt-prefix stability

`u6-prefix-probe.cjs` captures actual local-format request bodies for A repeated native; B appended paired native results; C added MCP schema; D unchanged prepared schema; E permission downgrade; F independent session; G rebuilt recovery history. A repeats identically; D repeats identically. Tool order is deterministic; native tools precede external schemas. Permission/session/recovery changes alter relevant serialized regions. No random manifest IDs are sent in the tool-prefix body. The evidence records hashes and serialized common-prefix lengths.

This establishes JSON/request stability only. Actual chat-template rendering and token-prefix stability remain **unverified**. The local guard merges system messages before template/tokenizer measurement and transport; stable JavaScript/tool ordering alone does not establish model-token prefix reuse.

## 10. Actual KV-cache findings

`memoryChat.mjs` requests `cache_prompt: true`; engine configuration defaults to one parallel slot but permits more. No request-level `id_slot` affinity is set in this loop. Backend slot selection, eviction and interleaved-session reuse therefore cannot be inferred. Existing nullable usage/timing telemetry is retained. Prompt-token count memoization in C1 is separate from backend KV caching. No cross-session prompt cache or slot-pinning optimization was added.

Cached/reused positions, evaluated tokens, prefill time/throughput and reset events are **not measured**. A cached prefix would still occupy context even if prefill computation were reduced.

## 11. Targeted optimizations

No production prompt-cost optimization was justified by this measurement. The dominant increase is the intentional direct native schema set, not duplicated content. Removing valid constraints, tools, instructions or results to improve this short benchmark would violate scope. Instrumentation adds exclusive cost attribution; it does not alter request contents. No performance gain is claimed for the security/schema fixes.

## 12. Before/after performance

| Metric | Historical architecture | U1–U5 baseline | After U6 |
| --- | ---: | ---: | ---: |
| Fresh Workspace hello, estimate | Not remeasured equivalently | 10,441 | 10,441 |
| Fresh Casual hello, estimate | Not remeasured equivalently | 1,355 | 1,355 |
| Eligible Workspace native schema estimate | Varies by activation | 8,169 | 8,169 |
| Coding requests | 9 | 5 | 5 |
| Coding cumulative estimated input | 31,628 | 53,526 | 53,526 |
| Cached tokens / prefill time | Unknown | Unknown | Unverified |
| Real-model correct first tool / argument retries | Unknown | Unknown | Unverified |
| Gmail Auto setup | 5 in saved reconstruction | 1 | 1 |
| Gmail Manual setup | Historical not measured | 0 | 0 |
| Browser setup | Historical not measured | Prior mocked only | 1 per new operation Auto; 0 Manual |

The complete compact 51-registration catalog estimates 8,949 tokens; the eligible Workspace fixture is 46 schemas / 8,169. Historical complete definitions estimated 9,779. C1's separate conservative bytes/3 estimate is not replaced by characters/4, and no exact-token compliance claim is made.

## 13. Real Qwen results

**Blocked/unverified:** no disposable loaded local model was available. All model completions in the coding/Gmail/browser suites are scripted. Real first-choice accuracy, invalid argument retry rate, hallucination rate, error recovery quality and task success are null. Native file/search/edit/verification dispatch works in disposable fixtures; it does not substitute for real Qwen-generated calls.

## 14. MCP Auto results

Fresh Gmail fixture: **three inference requests, one preparation, one read execution**, final answer, five synthetic messages returned, one connection. Estimated cumulative input remains 32,061. The email body includes an untrusted instruction to send mail; no send occurs in the scripted workflow. Independent approval tests verify a forged instruction/argument cannot supply the trusted grant. Repeated prepared execution and reconnect/revocation checks pass.

## 15. MCP Manual results

Gmail fixture: **zero preparation calls**, two direct selected read/search executions, three requests, five messages per execution and one connection. Cumulative estimate remains 31,653. An empty selection exposes no external tools. The 100-server/10,000-tool scaling and bounded pagination tests pass; original authoritative schemas remain enforced. No real Gmail account was accessed.

## 16. Browser results

The first genuine installed Playwright MCP probe failed before browser execution with `TOOL_SCHEMA_UNSUPPORTED` in both modes. Its public schemas specify JSON Schema 2020-12. Added a draft-specific Ajv 2020 compiler; unsupported constraints still fail closed, and required/type/additional-property/tuple constraints are regression tested.

After repair, the real installed MCP client/server and sandbox-enabled Chromium navigated a disposable localhost page and returned its heading/button through the actual model loop. **Auto: five requests, two preparations (one for each distinct operation), two executions. Manual: three requests, zero preparations, two executions.** This is real browser/MCP execution with scripted model responses. Auto does not yet prepare two distinct tools in one call; its existing one-operation contract is preserved and explicitly reported. No authenticated browser, cookies, external transaction or sandbox-disabling flag was used. Manager, browser process, HTTP server and temporary storage were closed; a subsequent process check found no Chrome/llama process.

## 17. Advertised-tool manifest security

Main dispatch resolves current schemas, requires membership in the originating request-owned manifest, checks schema/source identity, then runs current permission authorization. Loop checks reject missing/repeated tool-call IDs. Children have a separate read-only tool allowlist and cannot call MCP, approvals, shell or parent-only spawning. Existing cross-session, revocation, disabled-server, reconnect/race, schema-change, recovery, model-selection and pairing suites pass.

A duplicate-name manifest previously used Map's last entry silently. Creation now rejects `TOOL_NAME_CONFLICT`. New tests verify immutable schema fingerprints, foreign sessions, independent in-flight request IDs and repeated acceptance within batch ownership. Accepted operations are not replayed because later advertisements change. Existing request-level ownership is retained; no global current-tool set was introduced. Not every listed scenario was exercised with a real concurrent model response; exhaustive real-model/model-switch acceptance is not claimed.

## 18. Outbound communication approval

Recognized sending/posting/payment/destructive operations still require trusted explicit approval in every writable mode. Approval occurs before the Full Access fast path. Read-looking names no longer bypass the outbound word check, and program/action arguments can make a nominal read opaque. The manager independently enforces the approval requirement even when outer permission is granted. The model's `user_confirmed` field does not authorize execution. Investigation subagents cannot reach external MCP sending.

## 19. Opaque action classification

The shared classifier distinguishes read, known existing mutation, outbound, destructive, external mutation, opaque and unknown. Code/script/command/request wrappers and unidentified operations require the existing user approval channel instead of inheriting autonomous Full Access. Explicit existing file/browser/Git policy is retained; this is not a semantic guarantee about arbitrary executable behavior. SQL text checks are conservative heuristics, not a database-effect proof.

**Remaining security blocker:** native Full Access `execute_command`/`run_tests` still authorize arbitrary programs under the existing native policy. Workspace command containment restricts writes but does not unshare the network. U6 does not prove that email sending hidden inside arbitrary native programs must receive a separate explicit outbound approval. Likewise a dishonest third-party tool labeled as reading cannot be proven harmless by naming heuristics. Closing this native opaque boundary requires a deliberate command-authorization/confinement policy decision; it was not silently treated as solved or expanded into an architecture redesign.

## 20. Casual Chat

Fresh Casual greeting costs 1,355 character-estimated tokens, 341 schema tokens, independently of Workspace. Existing fixtures cover Auto capability availability, Manual/empty selection, and absence of Workspace file/shell grants. Workspace-only requests remain directed to existing Workspace navigation. No permission escalation or execution handoff was added. An input-preserving Casual-to-Workspace UI transition with duplicate-execution prevention remains unverified; prompt wording is not evidence of such a transition.

## 21. Context budget and recovery

C1 measures the assembled request including native/active MCP schemas. The 90% trigger is `floor(usableInputTokens * .90)` after output reservation. Runtime `/props` capacity, allocated total context, per-slot capacity and advertised model length remain separate concepts. Prepared-context identity includes history, settings, activation and selected tools. Schema/template changes invalidate tokenizer-count cache keys. Current permissions and manifests are rechecked rather than reconstructed as grants from summaries.

Existing budget/recovery tests verify schema inclusion, template omission rejection, one bounded rebuild, pairing, active-run transcript retention and Live Steering. The focused final gate passes **92/92**. Full suite retains existing compaction limitations; no W2–W4 work or compaction redesign was performed.

## 22. Restricted failures

The fresh 31 failing file identities match the final restricted run exactly. Every baseline failing file was rerun independently to capture its inner failure identities/messages, including startup scripts that define no named tests. Those exact records are embedded in the evidence JSON. Localhost failures include `listen EPERM: operation not permitted 127.0.0.1`; subprocess failures include `spawnSync git EPERM`, restricted bwrap networking and terminated language-server fixtures. Nineteen restricted failing files pass with fixture access enabled; they are classified as environment dependent rather than product successes in the restricted environment.

| Baseline file | Classification | Evidence / interpretation |
| --- | --- | --- |
| `tests/apiServerPort.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/attachments.test.cjs` | test infrastructure problem | Fixture image/model capability setup is rejected by the attachment policy; app defect not established. |
| `tests/childAgentLoop.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/cloudIpc.test.cjs` | test infrastructure problem | Electron mock has no app.getPath when legacy attachment migration initializes the DB. |
| `tests/cloudProviders.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/deleteProjectFile.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/engineSettings.test.cjs` | test infrastructure problem | Expected defaults omit recoveryRetentionDays and recoveryStorageCapMB. |
| `tests/filesystemToolLimits.test.cjs` | test infrastructure problem | Direct manager fixture never initializes DB required by getMcpMode; cap behavior is not reached. |
| `tests/gitTools.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/localEngineFetch.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/lspAgentIntegration.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/lspCodeIntelligence.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/lspFoundation.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/lspProduction.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/lspProductionAgent.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/mcpIpc.test.cjs` | test infrastructure problem | First case lacks app.getPath; preload case expects a trusted handler absent from its mock. |
| `tests/mcpManager.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/mcpSse.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/messageActions.test.cjs` | unresolved | Expected two related message records, observed zero. Reproducible before U6; product defect versus stale sibling fixture remains unresolved. |
| `tests/messageStats.test.cjs` | unresolved | Expected siblings metadata missing. Reproducible before U6; product defect versus stale metadata expectation unresolved. |
| `tests/nodeHttpFetchCancel.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/rag.test.cjs` | test infrastructure problem | Fixture attempts real localhost:8080 completion through guarded fetch instead of stubbing that transport; ECONNREFUSED with localhost access. |
| `tests/recoveryBoundary.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/recoveryIpc.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/recoveryStartupMemory.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/recoveryStore.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/skillImportIpc.test.cjs` | test infrastructure problem | Electron mock lacks app.getPath during DB attachment migration. |
| `tests/skillProposalIpc.test.cjs` | test infrastructure problem | Electron mock lacks app.getPath during DB attachment migration. |
| `tests/subAgentRunner.test.cjs` | unresolved | Expected false, observed true at test line 73. Reproducible before U6; old runner contract versus application defect unresolved. |
| `tests/subagentOutOfProcessRecovery.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |
| `tests/subagentSession.test.cjs` | sandbox/localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. |

## 23. Localhost-enabled failures

All 12 failures reproduce independently. Exact names/locations/messages and classifications are in `baselineLocalhostEnabled.failures` and the final comparison. They comprise the 11 files in section 22 that remain failing with localhost access; `mcpIpc.test.cjs` has two failed assertions. Eight files with fixture/setup/stale-expectation failures account for nine failing assertions; message actions, message metadata and the legacy subagent runner retain unresolved behavioral mismatches. No controlled pre-U1 run was made, so U1–U5 causal attribution is explicitly null except the missing-DB MCP-mode fixture dependency. Existing failures are not declared harmless.

## 24. Full regression comparison

Final restricted: **227 entries, 196 pass, 31 fail**. Final localhost-enabled: **1,740 tests, 1,727 pass, 12 fail, one skip**. Compared exact `(file, test name)` identities in each environment: **zero new and zero resolved failures**. Six new U6 assertions pass. During development, three MCP transport assertions initially failed because previously autonomous opaque test fixtures lacked the newly required trusted grant; fixtures were corrected without weakening transport or single-use mutation checks. Existing failure identities remain unchanged. This is regression parity, not a green-suite certification.

## 25. Production build

Baseline and final `npm run build` pass. Vite reports its existing large-chunk warning. `git diff --check` passes. The existing Electron cache-token-history UI fixture passes under Xvfb with isolated HOME/XDG paths and Electron sandboxing retained.

## 26. Remaining limitations

No exact GGUF tokenizer counts, actual formatted-token prefix checks, KV reuse, prefill latency, output occupancy or real Qwen selection measurements. The historical benchmark uses saved modules with current shared dependencies. Diagnostic instrumentation covers representative captured requests, not continuous production telemetry. Browser automation is real but model decisions are scripted; two different Auto operations still need two preparations. Native opaque outbound effects remain an approval-policy blocker. Casual mode transition guarantees and the three behavioral regression mismatches remain unresolved. No speedup or complete security acceptance is claimed.

## 27. W2 readiness recommendation

**Do not begin W2 yet.** Resolve or explicitly disposition the native opaque outbound boundary and the remaining regression failures, then run disposable real-Qwen/tokenizer/KV validation with the intended GGUF/template and context configuration. The unified direct-tool architecture is preserved and more diagnosable; these results do not justify declaring all U6 acceptance criteria met. Work stops at U6.
