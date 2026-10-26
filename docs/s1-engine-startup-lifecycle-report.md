# S1 — Startup measurement and local-engine lifecycle

Date: 2026-10-26. Scope: S1 only.

## 1. Executive summary

Implemented targeted restoration, measurement, idle-compression and engine-ownership fixes. The deterministic startup fixture reproduces the old offline/prevalidation measurement behavior. A second fixture reproduces rejection of a newly started session measurement by an unchanged-engine effect. Both pass after correction. Stale idle measurements now cancel without a compaction-error notification or timer-driven retry loop.

**The reported real-world model ejection was not reproduced. Its cause remains unproven.** Socket closure and connection refusal establish transport failure/unavailability, not who stopped a process or why. No automatic restart, inference replay, permission redesign or agent-loop rebuild was introduced.

The production build passes. Broad regression suites remain non-green for existing failures, fixture limitations and timing-sensitive assertions. This is not global acceptance of the application. Exact test identities, diagnostics, run hashes and comparisons are in `s1-engine-startup-lifecycle-evidence.json`.

## 2. Preservation and live data

The initial `git status --porcelain=v1` was empty. No existing modification was restored, removed or overwritten. Permission-policy files are byte-identical to the initial source copy; their before/after SHA-256 values are in the evidence.

Read-only discovery of `/home/mk_saadi/.config/Continuum/directories.json` identified app data at `/home/mk_saadi/.config/Continuum`, including the existing `memory_palace.db`. The live database was **not opened**. No live conversations were inspected/deleted and no live model process was controlled.

Baseline sources were copied before editing to `/tmp/continuum-s1/baseline`; final sources to `/tmp/continuum-s1/final`. Runs use distinct temporary HOME/XDG_CONFIG_HOME paths and test-owned SQLite/workspace fixtures. Git suites create their own disposable repositories/remotes; no destructive Git operation targets this repository. The engine-launch fixture now mocks `process.kill` explicitly, in addition to its mock spawn/PIDs. Electron fixtures use hidden disposable windows and temporary userData.

An initial source copy omitted unchanged tracked assets. Those were added before the corrected `baseline2` runs. The first runs are retained for transparency, but are not the principal comparison. A supplemental restricted run used source-root cwd with isolated HOME/config and test-owned databases/workspaces; the matched comparison uses the disposable source copies.

## 3. Startup measurement root cause

Actual path:

`main.js` app readiness → data migration/database initialization/IPC registration → window creation → `src/main.jsx` mounting → `src/context/TabContext.jsx` synchronous saved-tab parsing → `src/App.jsx` mounted ChatPane → `src/components/MemoryPalace.jsx` hook → preload `session:measure-context` → `src/main/ipcHandlers.js` → `src/main/promptMeasurement.js` → prompt/session builders → H1 deletion guard.

Previously:

- TabProvider mounted panes before asynchronous session-list validation completed.
- Its shared `hydrated` ref was set before awaiting validation. StrictMode cleanup invalidated the first invocation; the next invocation returned early because the ref was already set. Validation could therefore never finish.
- `dropOrphanTabs` deliberately retained unsaved tabs. That correctly preserves unused IDs, but also retained an unsaved ID carrying a permanent deletion marker.
- The hook measured on mount whenever a model ID was selected, including a persisted local selection with no engine loaded. MCP/settings changes could request further measurements; usage refresh itself does not poll the measurement endpoint.

Now panes wait for restoration validation. A bounded, read-only `session:validate-references` IPC checks tombstones, including unsaved IDs. Unknown session-list failures preserve unverified tabs, while already proven deleted IDs are still discarded. StrictMode invocations each own their completion flag.

Local measurement requires an active pane and a ready engine. Permanently deleted IDs are remembered by the hook; deletion events invalidate pending generations. The expected measurement IPC returns typed cancellation for deleted/stale work, and the renderer discards invalid tab references. Unexpected guard violations in other operations still throw. `sessionDeletion.assertAvailable()` remains in place; deleted conversations cannot be recreated.

The sidebar shares only in-flight session listings through `src/lib/sessionGroups.mjs`. It does not own a compression timer. Pending component results are rejected by session/model/generation checks after switching, deletion or unmounting.

## 4. Idle snapshot race root cause

`MemoryPalace.schedule` invokes `session:trigger-compression`; main schedules a 10-second idle timer. ChatInterface debounces this while streaming; completing a turn also schedules it. The timer asynchronously measures a prepared-history snapshot before considering pressure and compression. Persistence/restoration/settings can change history during that await. The final source-identity check correctly rejected the obsolete snapshot, but the idle catch treated the rejection as a permanent compression error and notified the inspection channel.

The snapshot check remains mandatory. It now has a `stale-measurement` code. Only recognized stale/deleted cancellation and an aborted owner settle quietly; unexpected errors still log and notify. An obsolete snapshot cannot reach compression/cache publication. There is no automatic stale retry: the next normal stable persistence/settings/session boundary can schedule a new debounced attempt. Existing pressure checks, identity deduplication and per-session compression serialization remain.

Concurrent identical measurements share a promise only for the same snapshot, transport, configuration and cancellation owner. Deletion invalidates/aborts pending measurements. Idle measurement receives its controller signal. Timer replacement aborts the replaced owner; migration retries clean up the old owner through the normal finally path. Shutdown cancels idle timers/candidates and invalidates measurement work.

Workspace idle work explicitly defers with `owning-request-required` before measurement/candidate generation. It never fabricates an owning request or bypasses W3/W4. Casual Chat retains its existing summary/archive contract, targets and pressure rules.

A separate hook race was reproduced with deferred promises: changing the session also changed the measurement callback, which reran the engine-transition effect. That effect invalidated the new session's measurement even though engine readiness/port had not changed. It now invalidates only on a real engine transition. Old-session results are rejected and current-session results survive.

**Limit:** a clean offline startup has no proven idle-timer scheduling path in this checkout: streaming begins false and local load configuration is absent. The stale-idle failure is reproduced deterministically once a timer exists; why such a timer existed at the user's reported startup remains unverified.

## 5. Model unload/process lifecycle audit

| Origin | Actual source | Behavior |
| --- | --- | --- |
| Managed spawn | `main.js:launchProcess`; `src/main/engineManager.js:buildLlamaServerArgs` | Direct detached spawn with `shell:false`; one owned process |
| User unload | `src/components/main-app/ModelSelectorModal.jsx` → `src/preload.js` terminal API → `main.js` `terminal:kill`/`stopEngine` | Signals the owned process tree; graceful stop then bounded escalation |
| Model switch/settings reload | `src/components/ModelSettingsModal.jsx` → `engine:launch` in `src/main/ipcHandlers.js` → `main.js:launchModel` | Validates selection/settings; waits for previous close before replacement; existing switch/launch guards remain |
| Configured idle unload | `src/main/engineManager.js:createIdleService` → `main.js` onIdle | Never/5/15/60 minute policy; waits for active request owners, independent of context percentage |
| Spawn/setup failure | `main.js:launchProcess` catch | Cleans up only its owned spawned process |
| Process exit/close | `main.js` child event handlers | Records actual code/signal; marks unavailable at exit, clears ownership at close |
| All windows closed/app quit | `main.js` `window-all-closed`/`before-quit` | Existing owned-process cleanup, now attributed `app-shutdown`; window closure policy is unchanged |
| Renderer destruction/IPC disposal | `src/main/ipcHandlers.js` request owners | Aborts request controllers; does not call model stop |
| Tab switch/close/chat deletion | `src/context/TabContext.jsx`; `src/main/sessionDeletion.js` | Switch preserves inference; close/delete cancel only that session/run, not the shared model |
| HTTP failure/title timeout/context failure/compaction cancellation | `src/main/localEngineFetch.js`, `src/main/ipcHandlers.js`, `src/main/compressionEngine.js`, `src/main/workspaceGenerationRuntime.js` | Request failure/cancellation, no process teardown call |
| Child/background agent model selection | `src/main/subagents/modelSelection.js`, `agentLoop.js`, `inferenceScheduler.js`, `providers/localProvider.js` | Resolves/uses an existing local endpoint or cloud provider; never launches/replaces the local model |

`engineManager.js` is a helper module, not the process owner. Foreground/background commands, LSP and MCP have separate process-cleanup code; those are not llama-server ownership paths. No health-check/busy-server classification was found that unloads a model. Startup warmup failure updates readiness/error state; it does not kill the model.

## 6. Proven versus suspected model causes

Proven code-level gap: main chat/title/standalone delegation already had high-level idle leases, but context probes and direct compaction requests did not consistently hold a lease through the entire HTTP body lifetime. These now acquire process-scoped transport leases, including streaming/body-read failures. This is a lifecycle correction, **not proof that the idle timer caused the reported ejection**. Ordinary active chat already held a lease. The user's configured idle timeout was not read from the live database.

The existing authorized stop paths are now attributable. Repeated competing unloads preserve the first stop origin. Force-stop timers compare process object identity as well as PID, so a successor reusing a PID cannot be targeted by an old timer. Process exit immediately removes engine readiness/routing even if stdio close is delayed. Retired owned endpoints reject new dispatch; child requests with old runtime identities cannot use a replacement generation on a reused port.

Possible OS termination, GPU/backend failure, resource pressure, an explicit UI transition or configured idle expiration require actual event evidence. None is asserted as the real-world cause. Usage below 30% does not itself establish process memory health or authorize an unload.

## 7. Lifecycle diagnostics

`src/main/engineLifecycle.js` emits content-free JSON records for starting, stop requests, escalation, spawn unavailability and actual exit. Records include timestamp, runtime generation, hashed model identifier, component, reason, user-action flag, active local transport count, PID and exit code/signal. First authorized stop origin is retained; an unattributed exit is never labeled user unload. Model paths, prompts, tool output, credentials and argv are excluded.

`src/main/localRequestLifecycle.js` records request cancellation, transport disconnection and server unavailability separately from process-exit events. A connection failure never manufactures a process-exit diagnosis. `serverTerminated` on a transport record describes whether that event establishes termination; actual exit is recorded independently. Retired endpoint rejection can use the already observed termination state. Request events use the local-transport component; lifecycle stops identify the actual initiating owner.

## 8. Cancellation and ownership

A title's 30-second AbortController belongs to the title request, not `activeStreams` or the process owner. Renderer/session/request controllers and compaction controllers remain scoped to their owners. The transport lease captures the exact process service at dispatch and releases once on full body consumption, body failure or cancellation. Completing an old request cannot reset the replacement process's idle timer.

H1 retains synchronous pending markers, durable tombstones and guarded mutation. W3/W4 safe activation, evidence/source checks and owning runtime boundaries are unchanged. W6 cancellation machinery remains intact. No permission policy, native execution approval rule, tool loop or durable conversation replay behavior was changed.

## 9. Local inference concurrency and recovery

The managed default is `parallel:1`, emitted as `-np`; settings can change it. Child inference uses the existing per-provider/model scheduler. Main chat, title generation and direct compaction do not all enter that child scheduler. The renderer normally requests a title after the first reply, but other tabs/children can overlap. Context template/tokenizer probes are not token-generation slots.

Mock scheduler/provider tests verify child serialization/concurrency, cancellation and isolated accounting. Transport overlap tests verify that a failing title-like request, a failed probe or a cancelled compaction-like request cannot stop another inference lease. No caller silently cancels another request to acquire capacity. The installed llama.cpp build's real main/title/child overlap and queue behavior was **not** certified with a live GGUF instance. No speculative scheduler redesign or auto-restart loop was added.

Ordinary socket/refusal errors are returned at the request boundary. Transport does not retry; the new tests assert one dispatch. Existing context-overflow recovery remains separately guarded and was not broadened to network failures. No completed tools or irreversible operations are replayed. A known dead/replaced endpoint returns an actionable error while durable history remains untouched.

## 10. Files changed

Production: `main.js`; `src/components/MemoryPalace.jsx`; `src/context/TabContext.jsx`; `src/main/compressionEngine.js`; `src/main/engineManager.js`; `src/main/engineLifecycle.js` (new); `src/main/ipcHandlers.js`; `src/main/localEngineFetch.js`; `src/main/localRequestLifecycle.js` (new); `src/main/promptMeasurement.js`; `src/main/sessionDeletion.js`; `src/main/subagents/providers/localProvider.js`; `src/preload.js`.

Tests: extended `tests/engineLaunch.test.cjs`; new `tests/s1EngineLifecycle.test.cjs`, `tests/s1StartupLifecycle.test.cjs`, `tests/s1StartupLifecycle.ui.cjs`. Deliverables: this report and its evidence JSON.

## 11. Deterministic verification coverage

| Requested scenarios | Evidence and limits |
| --- | --- |
| 1–3 offline/valid/deleted restored chats | S1 mounted StrictMode fixture; isolated tombstone IPC/DB fixture, including unsaved deleted ID |
| 4–8 stale/repeated/deleted/racing/coalesced measurement | S1 controlled deferred fetches and mock timers; unchanged history retained, fresh boundary succeeds; restoration/session-switch UI deferred promise |
| 9 Workspace without owner | S1 mock timer verifies no measurement/generation; existing Workspace safe-compaction suites |
| 10 Casual compression | Existing `idleCompactionProjection`, `compressionLifecycle`, context-compaction/recovery suites; S1 cancellation/debounce fixture |
| 11 low context/model retained | Lease tests have no pressure-triggered unload and main mock remains process-owned; a real below-30% GGUF workload remains unverified |
| 12–14 title/probe/compaction failure | Concurrent failure/body/socket/abort transport fixtures plus title IPC and W6/runtime suites; no process termination from those helpers |
| 15–16 tab switch/close with other inference | Existing mounted tab fixtures, session-scoped close wiring, S1 old/new measurement publication; existing tab-render-count failure documented below |
| 17–18 socket/refusal | Controlled header/body `UND_ERR_SOCKET` and `ECONNREFUSED`; one dispatch, request-only outcome |
| 19–22 exit/unload/switch/shutdown | Real main.js executed with mock child processes, app callbacks and signal functions; attribution unit fixtures |
| 23 competing lifecycle operations | Existing switch guard/wait-for-close fixture; duplicate unload signals once; process-identity escalation guard |
| 24 child/background overlap | Existing inference scheduler and child dispatch suites; transport overlap leases; real llama.cpp overlap unverified |
| 25 no tool replay | Transport single-dispatch fixtures, existing guarded recovery/provider suites and source audit; no new inference retry path |

## 12. Regression results and exact failures

| Run | Unit | Pass | Fail | Cancelled | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| Fresh restricted baseline | child files | 205 | 42 | 0 | 0 |
| Settled restricted final | child files | 209 | 40 | 0 | 0 |
| Fresh localhost baseline | assertions/file wrappers | 2029 | 19 | 1 | 1 |
| Settled localhost final | assertions/file wrappers | 2046 | 14 | 1 | 1 |
| 49-file focused run | assertions/file wrappers | 477 | 2 | 1 | 0 |

Both settled final failure-identity sets are subsets of their baseline sets: **zero new observed identities**. Restricted: two baseline-only timing failures. Localhost: five baseline-only timing/network failures. Independent reruns pass on both versions for these differing cases. The final broad runs use concurrency 4; the default-concurrency baselines were additionally reconciled with file-at-a-time reruns. Earlier intermediate differences are retained in evidence and are not suppressed. The focused run preceded the last endpoint-generation test; the settled full suite includes that test and all final production changes.

| Settled localhost failing identity | File |
| --- | --- |
| tests/attachments.test.cjs | tests/attachments.test.cjs |
| cloud settings persist privately and cloud chat works without a local engine | tests/cloudIpc.test.cjs |
| tests/engineSettings.test.cjs | tests/engineSettings.test.cjs |
| MCP execution applies the cap before serialization | tests/filesystemToolLimits.test.cjs |
| H1 real tool approval pending at deletion is invalidated without command execution | tests/h1DeletionIpc.test.cjs |
| packaging configuration ships the bundled server and its runtime dependencies | tests/lspProduction.test.cjs |
| the six native tools are registered once and dispatched through the real pipeline | tests/lspProductionAgent.test.cjs |
| tests/messageActions.test.cjs | tests/messageActions.test.cjs |
| tests/messageStats.test.cjs | tests/messageStats.test.cjs |
| tests/rag.test.cjs | tests/rag.test.cjs |
| workspace retains safety, activation, task continuity and MCP discovery | tests/sessionPromptWording.test.cjs |
| tests/skillImportIpc.test.cjs | tests/skillImportIpc.test.cjs |
| tests/skillProposalIpc.test.cjs | tests/skillProposalIpc.test.cjs |
| tests/subAgentRunner.test.cjs | tests/subAgentRunner.test.cjs |
| permission restrictions and workspace boundaries stay enforced | tests/verification.test.cjs |

The evidence retains exact `(file, testName)` identities and diagnostic blocks for every run. Restricted Node execution reports failing child **files**, whereas localhost-enabled execution exposes individual assertions and cancellations; these units must not be compared as equal.

Principal stable failures include attachment fixture policy mismatch; cloud/skill IPC mocks missing Electron `app.getPath`; engine-settings expected-default mismatch; MCP limit fixture accessing an uninitialized DB; legacy message deletion/stat-shape assertions; a RAG fixture reaching an unmocked unavailable backend; obsolete `stream:false` subagent expectation; prompt-wording/tool-count expectations; and verification error-shape assumptions. The disposable node_modules symlink also reproduces a bundled-server path assertion failure in both copies. No fixes to these unrelated contracts were attempted.

`h1DeletionIpc.test.cjs`'s exact cancelled case is **“H1 real tool approval pending at deletion is invalidated without command execution”**, with **“Promise resolution is still pending but the event loop has already resolved.”** It reproduces independently on baseline and final. Other H1 history/deletion cases pass; the cancelled case is not claimed as a pass.

Timing-sensitive background startup, permission-isolation, child cloud-overlap and LSP publication/timeouts varied under overlapping broad-suite load. Independent file-at-a-time baseline/final reruns and exact differences are in JSON. No new failure is called a regression solely from a raw count.

Mounted UI: startup, saved-tab persistence and tab-context persistence pass. The existing permission-mode mounted fixture passes on both baseline and final sources (context options, defaults and project saves). `tabSwitchIsolation.ui.cjs` fails on both versions at **“a status change renders only its tab”**, actual 3 vs expected 1. `palaceStability.ui.cjs` produced the same **“stable wiring: no keydown re-registration”**, actual 1 vs expected 0, on an initial baseline/final comparison, then passed on a later final rerun; it is timing-sensitive, not a proven fix or regression. The new startup/switch test fails before each targeted correction and passes afterward. Restricted Electron startup is blocked by the sandbox; enabled isolated Xvfb runs provide the mounted evidence.

## 13. Build and exclusions

Fresh baseline and final `npm run build` pass. The final production bundle retains Vite's large-chunk advisory. `git diff --check` passes. The code and permission-file hashes are retained in JSON.

No live-model shutdown/restart, live database migration/delete, real TaskFlow run or real GGUF concurrency/resource-pressure test was performed. Existing opt-in long-command coverage remains skipped by the broad suite's established configuration. No browser UI suite was inferred to pass from Node-only source tests; mounted fixtures are reported separately. Unrelated features and permission modes were excluded from implementation, not silently repaired.

## 14. Readiness for another real TaskFlow run

Ready for a **controlled diagnostic TaskFlow run** with the targeted startup/context fixes and lifecycle attribution. Preserve the emitted engine generation/start/stop/exit records if ejection recurs, together with whether an exit event preceded transport failure. Do not infer cause from `UND_ERR_SOCKET`, `ECONNREFUSED` or context percentage alone.

The code-level/mock/UI corrections are verified, but real-world ejection prevention and the installed backend's cross-request overlap remain unverified. Existing suite failures and the H1 cancelled fixture prevent a global green/readiness claim. Stop after S1; no further features or permission-mode changes were implemented.
