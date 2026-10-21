# Permission and subagent isolation reliability

Date: 2026-10-21. Seven confirmed authorization/isolation defects corrected; measured baseline and authorization map were recorded before production edits. Existing working changes are preserved.

## Baseline and existing authorization path

`npm test` (`node --test tests/`) fails on this Node 22 installation because the directory is treated as a module. The explicit suite command `node --test tests/*.test.cjs tests/*.test.mjs` completes: 204 file entries, 172 pass, 32 fail. Exact identities are retained in `/tmp/continuum-permission-audit/baseline.log`. This is a fresh restricted-environment measurement, not an assumption from historical reports.

The shared catalog is `src/lib/permissionModes.json`; selector normalization mirrors `toolPermissions`. Casual Workspace Write normalizes to Ask for Approval. Project mode/default plus trusted renderer run selection initialize main execution; the sender-owned live-mode IPC updates `lspExecutionContext`. `promptBuilder.getToolContext` filters schemas; main IPC `executeTool` guards before native/memory/MCP dispatch. Native execution also guards unless explicitly granted by main IPC. File tools validate contained paths; commands use bwrap and 45-second timeout. LSP checks a trusted context, adapter and manager independently. Investigation children have an explicit read-only tool allowlist with a separately authorized LSP ceiling. Continuation uses the existing child/session/driver/persistence path.

## Four-mode capability map (existing canonical policy)

| Family / current tools | Read Only | Ask for Approval, workspace | Workspace Write | Full Access | Boundaries / child access |
|---|---|---|---|---|---|
| Reads: read_project_file, list_directory, search_project_content, git inspection, native web tools | Allow | Allow | Allow | Allow | Native path validation; child allowlist; file delegation is separate |
| Writes: write_project_file, str_replace_editor, edit_project_files, apply_patch, move_project_file; git staging/branch changes | Deny | Contained allow; external approval | Contained allow | Allow | Per-path containment incl. symlinks; unavailable to investigation children |
| delete_project_file | Deny | Approval | Approval | Allow | Workspace required; content fingerprint; contained deletion even with approval |
| execute_command, run_tests | Deny | Contained allow; system/external approval | Contained allow; system approval | Allow | bwrap is containment boundary; heuristics only gate prompts; no child command access |
| Six lsp_* tools | Deny | Deny | Allow | Allow | Workspace required; per-caller trusted live authorization; eligible child context only |
| manage_mcp_servers | Deny | Approval | Approval except exact trusted Playwright enable/restart | Allow | Configured server only; Manual mode blocks management; no child access |
| MCP methods | Deny | Approval | Allow plus mutation backstop | Allow | Enabled server/tool/session checks; activation does not remove mutation checks; no child MCP access |
| approve_mcp_mutation / generate_image | Deny | Approval | Approval | Allow | Mutation grant is one use; image tool also needs configured provider |
| save_memory | Deny | Allow | Allow | Allow | Session/model configuration; no child access |
| update_plan / get_project_plans | Deny write / allow read | Allow | Allow | Allow | Workspace/session ownership; no child plan writes |
| spawn_sub_agent / delegate_task | Allow | Allow | Allow | Allow | Model permission arguments rejected; investigation children retain read-only native policy plus separate LSP authorization |

Visibility and execution use `capabilityOf`/`baseDecision`; unknown native tools fail closed except explicit approval or Full Access. Shared server ownership alone conveys no caller authorization. The requested general Workspace Write child scenario is not implemented by the current runtime: the independent child setting here is the LSP ceiling, not a general mutation mode. Expanding the child engine is outside this repair.

## Original failing test identities and classifications

The untouched restricted baseline supplies exact **file identities**. Direct diagnostic logs expose assertion identities; some of these diagnostic reruns occurred after the first production fixes and are not presented as an untouched assertion baseline. The original native, canonical policy, MCP permission and LSP production direct baselines were also captured before edits. Detailed failing assertion names are in the structured evidence.

| Original file (`tests/`) | Classification | Evidence and disposition |
|---|---|---|
| `apiServerPort.test.cjs` | Environment restriction | listen EPERM 127.0.0.1; no failure in enabled final run. |
| `attachments.test.cjs` | Confirmed outdated expectation | Fixture requests image upload without a selected/verified image-capable model; current attachment policy refuses it. Unchanged. |
| `backgroundExecution.test.cjs` | Confirmed outdated expectation | Test 10 background children keep context isolation and tool allowlist, line 504: stream false versus true. Progress observer intentionally enables streaming. Isolation assertions retained; corrected fixture passes 14/14. |
| `childAgentLoop.test.cjs` | Confirmed test-harness defect / outdated expectation / environment restriction | Test 1 expects stream:false; actual runtime progress observer requests true. HTTP test parses tokenizer GET as empty JSON and also expects false. Corrected transport expectations and POST route; 16/16 enabled; restricted loopback still fails. |
| `cloudIpc.test.cjs` | Confirmed test-harness defect | Database initialization: captured Electron mock has no app.getPath in legacyDataMigration. Chat authorization is not reached. |
| `cloudProviders.test.cjs` | Environment restriction | cloud chat POST survives a GET-only global.fetch override: listen EPERM. Enabled final suite explicitly passes it. |
| `deleteProjectFile.test.cjs` | Environment restriction | Tracked deletion / untracked and non-Git tests: spawnSync git EPERM. Enabled final suite passes deletion coverage. |
| `engineSettings.test.cjs` | Confirmed outdated expectation | Exact settings object at line 30 omits established recoveryRetentionDays=30 and recoveryStorageCapMB=512. Unchanged. |
| `filesystemToolLimits.test.cjs` | Confirmed test-harness defect | MCP execution applies cap before serialization: singleton getMcpMode calls getAppSettings with no initialized database. Not an authorization rejection; unchanged. |
| `gitTools.test.cjs` | Environment restriction | Real repository fixture creation fails at spawnSync git EPERM. Enabled final suite passes. |
| `localEngineFetch.test.cjs` | Environment restriction | local completion / production local transport tests fail listen EPERM on fixture server. Enabled final suite passes. |
| `lspAgentIntegration.test.cjs` | Environment restriction plus corrected fixture assumption | Real bundled server fails to initialize under restriction; ensuing matrix/catalog assertions cascade. Enabled focused final passes. Revocation fixture previously relied on destroying the shared server to remove its request stub; now explicitly restores stub and asserts server reuse. |
| `lspCodeIntelligence.test.cjs` | Environment restriction; one observed timing-sensitive assertion | Real bundled server INITIALIZATION_FAILED/SERVER_TERMINATED restricted. One intermediate enabled full run lacked answer in workspace symbol results; later final full and focused pass. No result-completeness assertion weakened. Shared-server fixture now asserts process retention. |
| `lspFoundation.test.cjs` | Environment restriction | Real bundled-server and JS-only tests fail INITIALIZATION_FAILED/SERVER_TERMINATED restricted; enabled focused final passes. |
| `lspProduction.test.cjs` | Environment restriction plus repaired identity fixture | Original direct 32/35: native permission matrix and real extension/stress requests return LSP_SERVER_UNAVAILABLE restricted. Enabled focused final passes all 35. After cursor scoping, three fixtures needed one stable caller object across pages; expiration and cross-workspace assertions unchanged. |
| `lspProductionAgent.test.cjs` | Environment restriction | Real six-tool main/child requests return unavailable when bundled process cannot initialize. Enabled focused final passes all 9 including recovery. |
| `mcpIpc.test.cjs` | Confirmed test-harness defect | IPC executes MCP tools: Electron mock missing app.getPath. preload config methods: sender mock missing once. Both remain failing; no production approval bypass added. |
| `mcpManager.test.cjs` | Environment restriction; security gap separately reproduced | Real stdio discovery returns connection closed under restriction. Enabled focused final passes all five tests. Prior global payload-only mutation grants were accepted by old tests; new cross-session/method reproducer proves defect. |
| `mcpSse.test.cjs` | Environment restriction | SSE and fallback fixture servers fail listen EPERM; enabled final suite passes. |
| `messageActions.test.cjs` | Unresolved | Line 54 expects two variants, observes zero. Outside permission repair; unchanged and still failing. |
| `messageStats.test.cjs` | Unresolved | Line 80 exact legacy message object differs in siblings field. Outside permission repair; unchanged and still failing. |
| `nativePermissions.test.cjs` | Confirmed test-harness defect | Line 33 Full Access external write returned false because fake db lacks transaction(): Recovery capture failed; refusing write_project_file to protect existing content. Replaced fake project-row database with real temporary SQLite/project/session and Electron path fixture. Production authorization did not need widening; 1/1 passes. |
| `nodeHttpFetchCancel.test.cjs` | Environment restriction | All local HTTP fixtures fail listen EPERM; enabled final suite passes. |
| `rag.test.cjs` | Unresolved | Mock lacks Notification.isSupported and real context-count transport fails fetch. Harness drift suspected but not established for all assertions; unchanged. |
| `recoveryBoundary.test.cjs` | Environment restriction | Git index/branches/history fixture spawnSync git EPERM; enabled final suite passes. |
| `recoveryIpc.test.cjs` | Unresolved / environment restriction | Restricted diff review IPC registration test reports bwrap loopback NETLINK_ROUTE EPERM. Enabled final suite passes; original source-inspection assertion not independently certified beyond observed result. |
| `recoveryStore.test.cjs` | Environment restriction | Real uncommitted/index/history fixtures fail spawnSync git EPERM; enabled final suite passes. |
| `skillImportIpc.test.cjs` | Confirmed test-harness defect | Electron mock lacks app.getPath during legacyDataMigration database initialization; unchanged. |
| `skillProposalIpc.test.cjs` | Confirmed test-harness defect | Electron mock lacks app.getPath during legacyDataMigration database initialization; unchanged. |
| `subAgentRunner.test.cjs` | Confirmed outdated expectation; remaining budget assertion out of scope | Line 73 expects stream:false with an active progress observer; runtime requests true. Supplemental probe correcting that exposes file-analysis output default 3072 versus old 1024, then input-budget derivation 9389 versus old 22268. Original test left unchanged; no production budget changes. |
| `subagentOutOfProcessRecovery.test.cjs` | Environment restriction | Cross-process recovery fixture listen EPERM; enabled final suite passes. |
| `subagentSession.test.cjs` | Environment restriction | Each spawn opens own session real-provider test listen EPERM; enabled final suite passes. |

## Confirmed production defects and minimal corrections

1. **Stale main permissions and native advertisement.** Most tools used the run's original permission string; only LSP consulted the live registry. `promptBuilder`, main dispatch, standalone native visibility, direct native execution and direct memory dispatch now use the existing trusted session policy. The standalone `agent:get-tools` filter previously exempted all non-LSP tools from filtering; it now applies canonical visibility to each entry. Execution still independently authorizes calls. No provider adapter or inference loop changed.
2. **Approval surviving policy changes.** A pending approved action could execute after downgrade; comparing just mode strings would also miss downgrade→upgrade. Existing live policy records now carry monotonically increasing revisions. `guardTool` checks the revision after asynchronous authorization, and native/MCP dispatch reject stale grants. The sender-owned mode IPC resolves that run's pending UI approvals as denied. Decisions remain one-use and bound to the exact call's closure, rather than model-supplied consent flags.
3. **MCP mutation approval leakage.** The old process-wide Set used only a hash of serialized arguments. The same payload on a different chat, server or method could consume the grant. Challenges now bind session, live policy revision, server, method and serialized arguments; Set keys also include session. They are consumed synchronously before dispatch, including failed attempts. Full Access and explicitly approved MCP-call behavior retain the existing policy. No global approval bypass was added.
4. **LSP revocation disrupted authorized peers.** Both the live-mode hook and an authorization failure in `check` closed the workspace server. They now deny the individual caller while retaining the healthy process. Existing per-request checks and the existing 25 ms active-request monitor cancel revoked queries and suppress their results. Process lifecycle/crash cleanup remains with the existing manager.
5. **Recovery raised a child's restricted LSP ceiling.** Recovery always re-authorized at Workspace Write, even after a child's own ceiling was Read Only. Durable continuation options now record the child's own ceiling from trusted state; child-mode changes persist it. Recovery revalidates the current owning parent, preserves Read Only/Ask/Workspace Write ceilings, and defaults unknown, legacy or formerly Full Access ceilings to Read Only. Nothing restores a persisted Full Access grant. Old child context references are revoked on deletion/replacement; cancelled child contexts also deny LSP.
6. **LSP cursor caller leakage.** Pagination snapshots previously checked only workspace and operation. An eligible peer in the same workspace could consume another session's or child's cursor. Snapshots now include caller identity (session, child, run), parent policy revision and child authorization revision. Mock-only internal managers use object identity. A foreign request does not consume the owner's cursor. Existing expiry, process-restart, query and workspace checks remain.
7. **Queued command start after revocation.** A command waiting for recovery capture could start after downgrade. A reproducer paused the actual command path at `withShellRecovery`, downgraded to Read Only, and observed the forbidden marker file before the fix. Both command tools now recheck the captured policy revision after recovery preparation and immediately before sandbox process launch. The 45-second `execute_command` timeout is unchanged. No background execution was added.

The initial new reliability file reproduced five defects (**1 pass / 5 fail**); cursor and queued-command tests were added separately and each failed before its corresponding correction. Final reliability results are **13/13**. Error responses expose existing typed permission/approval failures plus `PERMISSION_REVOKED`; denied deletes remain truthful non-deleted outcomes.

## Main execution, live changes and concurrent sessions

The authorization source is the executing session's main-process policy record initialized by trusted application state, never the visible UI tab or a model argument. The renderer's selector remains backed by the shared catalog; its per-tab/session choice and project default initialize subsequent runs. The live registry is process-local, bounded to 256 records, and is not a new database permission framework.

Main IPC guards tool calls with the current mode and session identity, then carries its grant to native/MCP dispatch. Native dispatch rechecks stale grant mode/revision and cancellation. Schema filtering consults current mode on future normal model-request boundaries. In-flight generation is not interrupted for schema updates. A tool newly allowed during generation becomes advertised at the next boundary; it is not retroactively added to the schema of an already issued request. Recovery/compaction catalog rebuilds use the same `getToolContext` path.

Deterministic coverage includes Full Access→Workspace Write, Workspace Write→Read Only, Workspace Write→Ask, Read Only→Workspace Write and Ask→Full Access. Four concurrent session records exercise distinct permissions despite deliberately stale caller strings. Normal contained workspace writes remain prompt-free in Workspace Write **and** workspace Ask for Approval under the established policy. System-affecting commands still prompt; arbitrary external writes remain denied in Workspace Write.

Revocation is not instantaneous rollback. Already executing native file mutations and already started shell/MCP side effects retain their existing cancellation limits. The new checks block future calls, pending grants and queued shell/MCP dispatch. No claim is made that a filesystem commit halfway through its existing asynchronous atomic-write implementation can be undone. LSP's active request check is polling plus boundary validation, not a real-time guarantee.

## Subagents, delegation and recovery

The source and historical Phase 2.6A-3 report explicitly establish **read-only native investigation tools plus a separate LSP ceiling**. Ordinary child tools still pass `sessionId:null`, `permissionMode:read_only`, and an explicit read root through the native dispatcher. Their allowlist excludes writes, commands, plans, memory mutations, MCP, approvals and further spawning. The separate LSP context is held in a WeakMap keyed by the actual child session object, not a permission label in tool arguments. Unknown/model-supplied permission properties are rejected by schemas.

Trusted authorization verifies parent ownership. A Full Access parent defaults a child's LSP ceiling to Workspace Write; Read Only and Ask parents gate child LSP to Read Only. Siblings retain separate ceilings. Parent downgrade gates every descendant context without changing the sibling's stored ceiling, budgets, inbox, context or cancellation controller. A child cancelled independently no longer has eligible LSP authorization. Investigation cancellation, background control, parent abort propagation, model budgets, deadlines, continuation serialization and scheduler lanes otherwise retain their existing code paths.

Recovery uses the existing continuation manager, durable row, owning parent and current policy, and never starts inference merely by listing/recovering. It retains child identity, model, finite budget consumption, deadlines/renewal requirements and aggregate accounting. Pending approval closures are never persisted or revived. Expired runtime references are demoted on deletion; legacy continuation data without a recorded LSP ceiling remains denied until explicitly re-authorized through trusted runtime state. A recovered child with a valid Workspace Write ceiling under a currently eligible parent still uses LSP; restricted recovery no longer raises its ceiling.

A child recovered while its parent is denied receives no LSP context under the existing recovery policy. Later eligibility does not automatically create one: trusted reauthorization is required. Ordinary read-only continuation remains available. The audit does not turn this into implicit elevation.

**Scope mismatch with the requested generalized child matrix:** the existing engine cannot perform a native file write as a Workspace Write child. This audit does not implement that new capability. Accordingly, the end-to-end test uses an independently eligible LSP child and a restricted child, with workspace mutations performed by the authorized parent. It does not certify the requested general child-write scenario. This is an architectural limit, not an approval workaround.

## Approval lifecycle and activity

`requestToolApproval` allocates a random approval ID in the executing controller's map, emits request/session/tool/argument context, and settles once on decision, timeout, sender destruction or cancellation. Response IPC resolves through the sending renderer's request/controller and approval ID. Another sender, request, chat or sibling cannot release it by guessing an ID. The grant remains local to that call's arguments; native delete/commit/push also retain their existing snapshot fingerprints. Mutation-hash grants add caller, method and policy-generation binding as described above.

Tests cover concurrent requests, exact argument identity, independent cancellation, denial, replay, wrong sender, policy changes while approval is pending, and a scoped successful delete through real IPC. One approved action never releases another pending operation. The end-to-end simulation receives exactly one deletion prompt; ordinary workspace writes produce none.

Approval UI arguments remain the existing bounded sanitized preview, not an unlimited raw-payload display. Cancellation of a pending approval settles its boolean decision safely; some higher-level error paths still label that result `APPROVAL_DENIED` rather than a distinct cancellation category. This is a presentation limitation, not conversion of denial into execution. Cancellation signals still stop the agent's continuation. No new UI error-taxonomy architecture was added.

Activity, persisted steps and tool-result association continue through the existing dispatcher. Rejections return failed results and do not report a completed mutation. Main IPC attaches child identities to their original tool-call steps; child results retain their own activity. No plan table, steering queue, execution ID generation or log ownership mechanism changed.

## Shared LSP, shared MCP and Playwright

LSP's exact matrix remains Read Only **No**, Ask for Approval **No**, Workspace Write **Yes**, Full Access **Yes**. Tool, adapter and manager independently check workspace/caller authorization. Reusing a workspace server conveys no grant; revoked callers fail while eligible peers retain the same process. Pagination additionally binds the caller and authorization generation. Canonical root and result-location validation still reject cross-workspace sources and symlink escapes. No language-server integration or process-launch configuration changed.

MCP execution still verifies configured server membership, enabled state, session visibility, disabled tool state and argument shape. Session-bound calls now also check current caller permission. Dispatch rechecks policy revision and server/session enablement after asynchronous recovery preparation, preventing a stale call from reaching a deactivated server. Tests pause that preparation and revoke permissions or disable the server; zero calls reach its client.

Dynamic activation retains compact discovery and same-run schema refresh. The trusted Playwright exception still requires the exact stored bundled executable/arguments/environment/cwd definition and only the existing enable/restart operation in Workspace Write. Modified configuration, arbitrary executables and Manual mode do not inherit it. Activation does not approve broad database mutations. The existing dynamic-activation test passes all seven scenarios, including local/cloud and streaming/non-streaming mocked loops, one launch, steering retention, config-race rejection and no redundant trusted-activation prompt.

Configured MCP servers remain trusted external processes; this audit does **not** add a generic process/filesystem sandbox or classify every possible third-party method. Broad SQL/Mongo/Redis mutation detection is the existing backstop, not proof that an arbitrary MCP executable cannot write outside a workspace. Thus the four-mode policy is consistently applied at dispatch, but universal filesystem confinement of configured MCP methods is not certified. The separate environment-level Playwright stdin EOF problem was not changed or claimed repaired.

## File operations, roots, commands and restoration

Workspace native writes retain lexical containment, canonical-root resolution and symlink checks, including multi-path edits, patches and moves. Full Access and explicitly approved external writes retain their established broader path policy. `delete_project_file` remains workspace-contained even after approval and requires the unchanged SHA-256 fingerprint in non-Full Access modes. Restoration uses existing checkpoint/root ownership, pre-restore safety checks, content-addressed blobs and explicit stopped-run UI actions. It is not newly exposed as an agent bypass tool.

**Existing read policy is broader than workspace-only access:** `readablePath`, `isPathAllowed`, file-analysis delegation and `pathUtils` deliberately allow accessible absolute paths, traversal and external symlinks for reads. Existing tests explicitly assert these external reads succeed. The user requested preserving canonical read policy; silently confining all reads would redefine it. This remains a material limitation against any requirement for universal workspace-only source disclosure. LSP has stricter, workspace-only source boundaries. No claim is made that native reads provide that same boundary.

Command protection continues to use bwrap for contained execution, project-scoped cwd validation and existing system-command approval heuristics. Those heuristics decide prompts, not containment. Approved or Full Access commands retain the established unsandboxed escape. The new queued-execution revision check applies to `execute_command` and `run_tests`. Filesystem atomicity, version-check semantics, shell timeout and background behavior were not redesigned.

Recovery-store and file-operation test failures under restriction were not hidden: enabled final full regression explicitly exercises their real temporary Git/file fixtures. The native-permission test's original fake database could not support recovery transactions; replacing it with temporary real SQLite fixed the harness while retaining read denial, symlink/path rejection, sandbox confinement, autonomous development commands and legitimate Full Access behavior.

## Deterministic end-to-end result

`tests/permissionIsolationReliability.test.cjs` drives production `engine:chat`, `runMemoryChat`, real native dispatch, real child runtime, continuation persistence/recovery and JSON-RPC LSP manager paths. Inference and the LSP transport are deterministic fixtures; no separate execution engine is introduced.

Within one unchanged parent run ID it:

1. Creates a durable plan and launches independently eligible/restricted children through normal tool dispatch.
2. Executes an authorized child LSP query; rejects the restricted child's forged write and LSP query.
3. Performs a parent workspace write, downgrades during inference and rejects a previously advertised write.
4. Queues steering without resetting the plan; reauthorizes through sender-owned IPC and observes write tools returning at the next normal request boundary.
5. Writes successfully, approves exactly one fingerprint-bound deletion, and verifies the correct file is deleted.
6. Recovers the restricted child without raising its ceiling; rejects its subsequent LSP request.
7. Cancels another child through its independent signal and verifies the surviving child's state/authorization is intact.
8. Completes with unchanged plan step identity, steering present, preserved authorized output, no unauthorized marker, no duplicate tool-result IDs and the same run ID.

Additional reliability tests exercise all five live transitions, four concurrent session modes, sibling ceilings, cancelled/expired references, wrong-parent delegation, concurrent approvals, stale grants, cross-caller cursors, MCP scope/deactivation and queued-command revocation. They do not assert exhaustive cross-product coverage of every transition during every compaction/steering phase.

## Verification and regression comparison

| Check | Actual final result |
|---|---|
| New real-dispatch reliability suite, direct execution | **13 pass / 0 fail** |
| Focused permission/native/child/MCP/LSP selection with loopback/subprocess access | **155 pass / 0 fail**; explicit TAP assertions, including all five LSP files and real bundled server |
| Restricted full suite, same glob as baseline | **175 pass / 30 fail / 205 file entries**; baseline **172 / 32 / 204** |
| Exact restricted identity comparison | Resolved `backgroundExecution.test.cjs` and `nativePermissions.test.cjs`; **no new failing file identities**; new reliability file passes |
| Enabled full suite | **1,554 pass / 12 fail / 1,566 reported tests**, eight suites; includes script-style file entries as well as assertions |
| Lifecycle selection, serialized files | **9/9 file entries pass**: steering, context recovery, continuation, compaction, timeouts and concurrent dispatch |
| Dispatch concurrency direct repeat | **11/11 pass** |
| Production build | **Pass**, Vite 41.52 s; existing large-chunk warning |
| Permission selector Electron/Xvfb | **Pass** |
| Live Steering Electron/Xvfb | **Pass** |
| Subagent acceptance Electron/Xvfb | **Pass**, including expected invalid-settings rejection |
| LSP activity Electron/Xvfb | **Pass** |
| `git diff --check` | **Pass** |

The restricted runner suppresses child assertion details and reports test files; the enabled runner reports nested assertions. Their totals are **not directly comparable**. No pre-edit enabled full-suite baseline is claimed. The enabled results validate local fixture transport and bundled server operation, not paid/cloud inference or a packaged desktop session.

One parallel lifecycle selection recorded a failure of `subagentDispatchConcurrency.test.mjs` while other full/focused work was running. Its independent repeat passes 11/11 and the serialized selection passes 9/9; both final full runs also explicitly pass that file. The original parallel child assertion was suppressed by the restricted runner. This remains an observed timing/load-sensitive limitation, not a proven harmless failure or a reason to widen timeouts. An intermediate enabled full run also observed incomplete early workspace symbols; final focused/full runs pass without weakening that assertion.

The 12 enabled remaining failures are: attachments, cloud IPC initialization, engine settings object, MCP filesystem-limit fixture initialization, two MCP IPC fixtures, message actions, message stats, RAG, skill import IPC, skill proposal IPC and the old subAgentRunner transport assertion. Their classifications and exact names are in [the evidence](permission-subagent-isolation-evidence.json). These remain failures; the entire repository is not green.

Logs and before-edit main-source snapshots are in `/tmp/continuum-permission-audit`. Structured evidence retains summaries and exact identities even if temporary logs are later removed. `node --test tests/` itself fails to resolve the directory on this Node 22 installation; the explicit file globs were used consistently. The package script was left unchanged.

## Files changed by this phase

Production: `src/main/ipcHandlers.js`, `lspCodeIntelligence.js`, `lspExecutionContext.js`, `lspManager.js`, `mcpManager.js`, `promptBuilder.js`, `safetyGuards.js`, `toolPermissions.js`, `tools/agentTools.js`, `subagents/continuationState.js`, `subagents/continuationManager.js`.

Tests: `agentTools.test.cjs`, `backgroundExecution.test.cjs`, `childAgentLoop.test.cjs`, `lspAgentIntegration.test.cjs`, `lspCodeIntelligence.test.cjs`, `lspProduction.test.cjs`, `mcpDynamicActivation.test.cjs`, `mcpManager.test.cjs`, `nativePermissions.test.cjs`, new `permissionIsolationReliability.test.cjs`. `subAgentRunner.test.cjs` was probed but returned to its original contents; it is not a final change.

Documentation: this report and `docs/permission-subagent-isolation-evidence.json`. Some production/tests were already modified or untracked when the task began; this list describes this phase's incremental edits, not ownership of all working-tree changes. Existing changes were preserved. No commits, pushes, stashes, resets or cleans were performed.

## Remaining limits and manual desktop verification

This is a focused set of evidence-backed corrections, not certification of every acceptance criterion. The important unresolved boundary mismatches are general Workspace Write children (not supported), native reads outside workspace (explicit established policy), and arbitrary configured MCP executable confinement (no generic sandbox). Legacy recovered children may need explicit trusted LSP reauthorization. Pending approval cancellation wording is not fully distinct from rejection. Existing unrelated failures and timing observations remain documented above. Broader architectural work was not undertaken.

For a manual desktop check with disposable projects:

1. Open four chats with Workspace Write, Read Only, Full Access and Ask for Approval, including two on the same workspace. Switch the visible tab while a background agent is running; verify activity, results, plan and approval target remain attached to their owning session.
2. In Workspace Write create/edit a marker, request a contained development command and separately request a file deletion. Expect autonomous contained work, one deletion approval, and no unrelated unrestricted write. Deny one approval, cancel another and verify both leave the protected target intact.
3. Downgrade while generation is pending. A stale write/command/LSP call must fail; upgrade and verify eligible schemas appear at the next request boundary without a new run or lost steering/plan.
4. Run two eligible LSP callers sharing a workspace, downgrade one, and verify the peer still uses the same healthy server. Do not treat pending/stale diagnostics as clean. Attempt to reuse a pagination cursor in the other chat; expect rejection.
5. Launch investigation children, restrict one through trusted child configuration, cancel one and inspect separate transcripts. Check ordinary child tools remain read-only. Restart/recover an eligible child and a restricted child; ensure the restricted ceiling stays restricted and budgets do not reset. Old/unknown authorization must not become Full Access.
6. In Auto mode activate the exact trusted Playwright configuration and verify same-run tools without redundant activation approval. Modified/untrusted configuration must follow ordinary approval. Disable a server before a queued call executes and verify rejection. This does not retest or certify the separately isolated Playwright stdin EOF issue.
7. Inspect one approved MCP mutation and attempt the same payload from another chat/method; expect independent denial/approval. Verify no duplicate protected operation, incorrect tool-result association or task-plan reset.

Use the enabled test commands and UI fixtures before live-model checks. No paid inference was called in this audit. Permission/subagent-isolation work stops here; no next stabilization phase was started.
