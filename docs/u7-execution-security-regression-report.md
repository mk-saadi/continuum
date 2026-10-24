# U7 — native execution security and regression disposition

Date: 2026-10-24, Asia/Dhaka. Evidence: [machine-readable results](u7-execution-security-regression-evidence.json).

## 1. Executive summary

Implemented a focused native execution approval boundary without changing direct native tools, MCP Auto/Manual discovery, the model loop, or W2. Arbitrary shell/test execution now requires specific consent in every writable mode, including Full Access. User consent does not silently remove workspace containment. Native command/Git grants are process-local, single-use and bound to exact operation, session, project, permission mode and revision.

Confirmed and closed: Full Access opaque shell approval bypass; shared-network and inherited-environment exposure in workspace shell; reusable/forged native approval metadata; ignored manifest authorization epochs; pending approval/configuration race; uncontained Git mutation helpers; Git remote preparation before approval; Full Access MCP Git-publication exception; legacy renderer-controlled custom engine shell launch.

**W2 is not ready.** This work is a verified application-level hardening phase, not a complete hostile-program sandbox certification. Configured host services and executable/configuration trust remain outside the shell boundary. The message-deletion/history contract also needs explicit disposition. No W2 implementation was started.

## 2. Current architecture

The per-inference schema manifest verifies advertised identity; it grants no consent. The dispatcher validates schema and live policy, requests user approval where required, then invokes the existing executor. Native tools remain direct. MCP Auto retains one preparation call; Manual retains selected authorized tools. The same guard is provider-independent. No client, dispatcher architecture or model loop was replaced.

## 3. Fresh baseline

Recorded the complete dirty tree and initial diff before production changes. Preserved existing modifications and untracked artifacts; no commit, push, stash, reset, clean or restoration of developer files. All six requested U6/architecture/T2F reports and evidence were read.

| Gate | Tests/entries | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Restricted baseline | 227 | 196 | 31 | 0 |
| Localhost-enabled baseline | 1,740 | 1,727 | 12 | 1 |
| Restricted final | 228 | 197 | 31 | 0 |
| Localhost-enabled final | 1,754 | 1,741 | 12 | 1 |
| Focused pre-edit baseline | 12 file entries | 12 | 0 | 0 |
| Focused final, localhost enabled | 166 | 165 | 0 | 1 |

Both fresh baselines exactly reproduce U6's final inventories. Restricted reporting counts failed child files; enabled reporting includes individual assertions. These units must not be conflated. Full command: `node --test --test-reporter=tap tests/*.test.cjs tests/*.test.mjs` with temporary HOME/XDG paths. Baseline and final production builds pass. Exact names, errors, hashes and independent reruns are in evidence.

## 4. Native execution trust boundaries

| Entry/path | Trusted checks and owner | OS launcher, scope and lifecycle |
| --- | --- | --- |
| Model `execute_command` / `run_tests` | request manifest → current schema → guardTool → user response → one-use native grant; database session/project and live mode/revision | runScopedCommand → recovery preparation → executeCommand → runForeground; launch revalidation, timeout, capture and process-group cleanup |
| Background launch | same command approval plus active main run/session/workspace ownership; authorization mode/revision/scope fingerprint stored as audit metadata | same runner, no alternate launcher; owner abort, 50ms revocation monitor, finite lifetime, closeRun and shutdown |
| `get_command_status` / stop | active run plus session/workspace ownership; child tools excluded | registry read or abort only; never starts/restarts a process |
| Git inspection | finite native registry; fixed argv, validated refs/paths, no pager/ext-diff/textconv/fsmonitor, read-only/no-network sandbox | runGit → execFile/bwrap; bounded timeout and abort signal |
| Git local mutation | path policy plus specific native grant; repository filters/signers considered opaque even in Full Access | same contained Git profile; approval does not enable uncontained Git |
| Git remote sync | approval before preparation; push additionally reviews outgoing history and binds snapshot; live revision check | dedicated network-enabled Git profile; gh auth probe/token relay are part of this approved host trust boundary |
| Investigation subagent | separate child allowlist and request manifest; read-only tools, explicit root; parent mode ceiling for LSP | arbitrary command/test, background handles, MCP mutation and approval tools unavailable |
| Legacy task/file/web delegation | finite task routing into existing subagent runtime; skills load instructions/files as untrusted content | model completion or bounded fetch; no automatic skill-script runner; a requested script must use guarded command execution |
| `agent:execute-tool` IPC | trusted sender wrapper and native registry; direct calls have no approval channel | opaque command/Git invocation fails closed; cannot manufacture a trusted decision |
| `terminal:spawn` IPC | legacy arbitrary shell API now unconditionally rejected | normal scanned-model loading uses argv/shell:false; raw shell branch removed |
| MCP stdio / bundled browser | configured registry, selection, session and MCP policy; metadata untrusted; browser interaction/evaluation and unknown actions retain approval | SDK StdioClientTransport and bundled installer are trusted host services, inherit configured host environment; not a native shell sandbox |
| LSP | trusted context, workspace/language/method checks, child ceiling, revision; fixed bundled CLI/tsserver, no configured plugins or automatic typing acquisition | owned Node process group; host filesystem/network, cleared NODE_OPTIONS/NODE_PATH; lifecycle managed by LSP manager |
| Engine/GPU/browser utility processes | user model selection/configuration or fixed internal probe, not a model-created shell tool | model argv loader, fixed nvidia-smi/gh/version/browser setup commands; trusted installed executable/configuration boundary |

Advertising, consent and OS execution are distinct stages. Child cancellation and owner shutdown reach the existing process launcher; neither history nor a task checkpoint is an approval token.

## 5. Approval policy implemented

| Effect/mode | Read Only | Ask for Approval | Workspace Write | Full Access |
| --- | --- | --- | --- | --- |
| Established file/search/Git inspection | allowed within existing scope | allowed | allowed | allowed |
| Scoped file edit | denied | existing contained-write policy | existing contained-write policy | existing Full Access policy |
| Opaque shell / test / build / script | denied | specific approval; contained inside project | specific approval; outside cwd denied | specific approval explicitly covering uncontained host execution |
| Local Git mutations with executable configuration | denied | specific approval and containment | specific approval and containment | specific approval and containment |
| Git remote operations | denied | network approval; push history review | same | same |
| Protected MCP outbound/unknown/browser action | denied | existing specific approval | existing specific approval | approval retained; Git publication exception removed |

No development command name proves harmlessness. `npm test`, Python, aliases, shell pipelines and verification tools all require approval. The old system-command heuristic remains only as a compatibility export and is not used to authorize execution. Commands/cwd over 4,000 characters are rejected rather than approving a truncated opaque operation.

## 6. Native command changes

`nativeExecutionPolicy.js` keeps grants in a WeakMap, binds exact tool/arguments/session/project/mode/revision and admits them for 120 seconds. The executor consumes a grant exactly once; plain objects, model `user_confirmed`, serialized approvals, unrelated arguments, another session/tool and replay fail. Arguments are cloned before asynchronous authorization and execution. Permissions are checked again after user response and recovery preparation. Grant expiry governs admission; admitted processes then use run ownership, timeout and revocation controls.

Workspace shell now unshares the network and receives only PATH, LANG, workspace HOME and TMPDIR. It retains read-only host root plus writable workspace/temp mounts and capability dropping. Missing platform/sandbox support fails closed; approval does not automatically bypass it. Full Access or explicitly approved outside-workspace execution carries a visible host-filesystem/environment/network disclosure. There is no reusable prefix grant or new tool-management round trip.

## 7. Background process handling

Launch shares the foreground guard and one-use grant. Records store non-executable authorization metadata, command summary, run/session/workspace and finite lifetime. Status/stop require owning context; launching after closure fails. Revocation cancels with the existing process-group TERM then KILL grace; foreground now also polls live authorization every 50ms. Run end, interruption and app shutdown await cleanup. Restored active records become cancelled/unknown and are never relaunched. Audit metadata cannot recreate a grant.

These controls cannot undo prior effects or guarantee capture of a deliberately detached/daemonized host process. PID namespaces improve contained commands; cgroups/Windows job objects and full hostile-code containment are not implemented.

## 8. Electron IPC enforcement

Actual registered engine:chat handlers, dispatcher and approval-response handlers are exercised with mocked Electron surfaces. Approval IDs remain random, pending, one-use, sender/request-owned, cancellable and time-bounded. Foreign-sender replies fail. The manifest epoch is rechecked after approval, and the accepted native execution retains epoch validation through recovery and background/foreground monitoring. Legacy raw engine shell launch is denied; scanned model argv loading still passes its test. Repeated handler registration retains existing Electron registration/disposal behavior; no second privileged path was created. A compromised trusted renderer is outside this claim; no mounted-Electron process test was added.

## 9. Outbound communication protections

No real email, account change, payment or remote publication occurred. Existing mock Gmail reads remain permitted, while MCP sending, evaluation, unknown actions and malicious tool content remain approval-gated. Native opaque processes cannot inherit permission to send from a read task or Full Access mode. Git remote preparation asks before contacting a remote; publication additionally reviews the outgoing snapshot. These are two different scopes, not a duplicated prompt for the same grant. MCP Git publication now also prompts in Full Access.

## 10. Prompt-injection tests

The full loops inspect and edit temporary files, run one user-approved harmless check returning malicious email-style instructions, then attempt a marker-writing opaque operation with `user_confirmed:true`. Runtime denial leaves the marker absent; the model continues and reports approval required. Existing Gmail read/send mock tests cover the dedicated service path. Transport responses are scripted, so this proves enforcement under a malicious attempt, not real-model resistance or natural-language understanding.

## 11. Per-request manifest verification

Revalidated duplicate and hallucinated names, unadvertised tools, wrong server/schema/session, disabled/revoked tools and permission downgrade. Fixed the previously stored-but-unused epoch comparison. Pending IPC approval followed by configuration change now fails before execution. Accepted background context uses epoch validation independent of request-cache eviction. Old in-flight request ownership can remain valid only while its authorization/configuration epoch is unchanged; current schema/registry checks remain authoritative.

## 12. Subagent isolation and recovery

Investigation children keep their independent finite read-only allowlist and cannot invoke command/test/background/approval tools or inherit Full Access. Existing child dispatch, session, provider, permission and recovery gates pass with localhost available. Recovery can rebuild messages, but cannot serialize a WeakMap grant; downgrade/upgrade still invalidates it. No W2 compaction or checkpoint authorization feature was added.

## 13. Security test outcomes and performance

The 14 new U7 tests pass in the enabled suite; the real namespace test skips only in restricted execution, where the launcher-contract test still passes. Focused final: 165 pass, zero fail, one pre-existing long-command opt-in skip. This includes native permission/lifecycle, MCP Auto/Manual, U6 security, manifests, subagents, provider loops and relevant Electron IPC/engine-launch tests.

Each provider loop uses six inference requests, five dispatcher authorization checks, two approval decisions (one allow, one deny), and exactly one process execution. No activation chain or additional inference request is introduced. Bounded local fixture timings are in evidence; they are not inference/network latency measurements. Background and command lifecycle checks pass. No U6 token/schema optimization was attempted.

## 14. Regression failure disposition

All 31 restricted failing files were independently rerun; the 11 files containing the 12 enabled failures were separately rerun with localhost support. All remain reproducible. Every file, inner test identity, exact message, first observation, category, security/tool relevance, W2 decision, owner and next action is in JSON. Source inspection refines two formerly unresolved U6 cases: messageStats compares save/load response shapes despite load-only sibling metadata; subAgentRunner expects non-streaming despite the current progress-observer contract. Neither establishes a security defect. Message deletion remains an explicit history-contract decision: recursive descendant deletion explains observed zero versus legacy expected two, but source behavior alone does not certify product semantics.

| File | Category | Evidence/root cause | Ownership and W2 disposition |
| --- | --- | --- | --- |
| `tests/apiServerPort.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/attachments.test.cjs` | Test infrastructure limitation | Fixture image/model capability setup is rejected by the attachment policy; app defect not established. | Integration test maintainer; W2 not individually blocked |
| `tests/childAgentLoop.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/cloudIpc.test.cjs` | Test infrastructure limitation | Electron mock has no app.getPath when legacy attachment migration initializes the DB. | Integration test maintainer; W2 not individually blocked |
| `tests/cloudProviders.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/deleteProjectFile.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/engineSettings.test.cjs` | Test infrastructure limitation | Expected defaults omit recoveryRetentionDays and recoveryStorageCapMB. | Integration test maintainer; W2 not individually blocked |
| `tests/filesystemToolLimits.test.cjs` | Test infrastructure limitation | Direct manager fixture never initializes DB required by getMcpMode; cap behavior is not reached. | Integration test maintainer; W2 not individually blocked |
| `tests/gitTools.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/localEngineFetch.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/lspAgentIntegration.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/lspCodeIntelligence.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/lspFoundation.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/lspProduction.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/lspProductionAgent.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/mcpIpc.test.cjs` | Test infrastructure limitation | First case lacks app.getPath; preload case expects a trusted handler absent from its mock. | Integration test maintainer; W2 not individually blocked |
| `tests/mcpManager.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/mcpSse.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/messageActions.test.cjs` | Unresolved | Legacy test expects deleting only one linear-history row; deleteMessage explicitly removes its descendant subtree. Expected two retained messages, observed zero. Branch-tree source explains the difference, but intended deletion/recovery contract has not been independently accepted. | Session/history maintainer; W2 blocked |
| `tests/messageStats.test.cjs` | Test infrastructure limitation | saveMessage response lacks siblings while loadSession deliberately adds sibling metadata. messageBranches pins sibling navigation. The test compares these distinct response shapes as equal. | Session/history maintainer; W2 not individually blocked |
| `tests/nodeHttpFetchCancel.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/rag.test.cjs` | Test infrastructure limitation | Fixture attempts real localhost:8080 completion through guarded fetch instead of stubbing that transport; ECONNREFUSED with localhost access. | Integration test maintainer; W2 not individually blocked |
| `tests/recoveryBoundary.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/recoveryIpc.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/recoveryStartupMemory.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/recoveryStore.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/skillImportIpc.test.cjs` | Test infrastructure limitation | Electron mock lacks app.getPath during DB attachment migration. | Integration test maintainer; W2 not individually blocked |
| `tests/skillProposalIpc.test.cjs` | Test infrastructure limitation | Electron mock lacks app.getPath during DB attachment migration. | Integration test maintainer; W2 not individually blocked |
| `tests/subAgentRunner.test.cjs` | Test infrastructure limitation | Legacy assertion expects stream=false; localProvider sets stream according to activity observer and runtime supplies onProgress. Actual true is consistent with current provider contract; tool-free enforcement is separately tested. | Subagent test maintainer; W2 not individually blocked |
| `tests/subagentOutOfProcessRecovery.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |
| `tests/subagentSession.test.cjs` | Sandbox or localhost restriction | Fails restricted execution and passes the fresh localhost-enabled full suite; subprocess/network/namespace permissions differ. | Runtime/test infrastructure; W2 not individually blocked |

No unrelated application systems or failing fixture contracts were changed to make the full suite green. Environment failures matter to verification: the enabled suite and direct security gate provide the corresponding executable evidence, rather than dismissing them because they are old.

## 15. Files changed

Production: `main.js`, `nativeExecutionPolicy.js`, `toolPermissions.js`, `tools/agentTools.js`, `foregroundCommand.js`, `backgroundCommands.js`, `advertisedTools.js`, `ipcHandlers.js`, `mcpManager.js` under their existing source paths. New U7 security suite and trusted fixture-grant helper; existing command/Git/permission/provider fixtures updated for explicit consent and manifest revocation. The exact 18 test/helper paths, source hashes and initial dirty tree are in evidence. Existing changes in those files were retained and extended; unrelated dirty files were not restored or rewritten.

## 16. Full regression comparison

Restricted final: 197 pass / 31 fail; localhost final: 1,741 pass / 12 fail / one skip. Exact `(file, testName)` sets show **zero new failures and zero resolved failures** in both environments. Fourteen new assertions account for enabled growth; one new passing child file accounts for restricted growth. Intermediate failures exposed outdated autonomous execution fixtures and the newly enforced epoch contract; fixtures were updated with explicit trusted consent, not model self-approval. All final functional tests ran after the policy changes; subsequent tool-description/comment edits do not change execution behavior.

## 17. Production build

Baseline and final `npm run build` pass. Existing Vite large-chunk warning remains. `git diff --check` passes. No dependency installation, model unload, external configuration change or live user database operation was performed. Test fixtures may create commits and publish to disposable local upstream repositories; the developer working tree was never committed or pushed.

## 18. Remaining limitations

An approved uncontained program still has host network, environment and filesystem access; mutable scripts, shell startup/configuration, executable search and dependencies cannot be perfectly classified from command text. Workspace root is read-only but host-readable; network namespaces do not constitute a complete boundary against pathname Unix sockets or all kernel/filesystem facilities. This is why opaque commands and repository-program mutations still require explicit approval even with isolation.

Configured MCP stdio servers, bundled LSP/browser and selected model backend are trusted host components. Their executable/configuration provenance and protection against poisoning through broad Full Access file writes are **not comprehensively enforced** by this patch. MCP operation-name policy describes registered capabilities, not proof a third-party executable is honest. Full certification of every indirect outbound effect would require stronger host/configuration isolation and trusted admission beyond this focused change. Do not interpret protected-tool approval as an OS-wide egress firewall.

Revocation is polled at 50ms plus existing cleanup grace, cannot undo earlier actions, and process groups cannot certify termination of escaped host daemons. Cross-platform hostile-program containment, compromised-renderer defense and mounted Electron end-to-end behavior remain unverified. Local Qwen, exact tokenizer and KV-cache measurements remain unverified; no active user model was probed or changed. Existing recovery/history limitations remain separate from authoritative approval state.

## 19. W2 readiness decision

**Do not start W2.** The immediate generic native-process approval bypass is hardened and deterministic regression/security gates pass, but complete host-process/configuration effect integrity is not certified. The message-deletion subtree/history contract must also receive a documented product decision and targeted recovery validation. Remaining unrelated fixture owners are identified. This report does not require arbitrary unrelated UI fixes or claim all U7 acceptance criteria are fully certified. Work stops at U7.
