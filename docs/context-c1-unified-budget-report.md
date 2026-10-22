# Phase C1 — unified runtime context budget

Date: 2026-10-22 (Asia/Dhaka). Scope ends at C1. No commits, pushes, resets, stashes, live conversation mutations or paid inference were performed. Existing working-tree edits were retained, including edits in files touched here. This report describes C1's additions, not every difference from HEAD.

## Incident and confirmed causes

The configured 70,000 tokens were a server total, while `/props.default_generation_settings.n_ctx` reported 35,072 tokens for an individual request. Reserving 1,024 output tokens and 128 safety tokens leaves **33,920 input tokens**. The old scheduler waited for 52,500 tokens (75% of configured total).

The new trigger is **floor((35,072 − 1,024 − 128) × 0.90) = 30,528**.

Before replacement, duplicated calculations were:

| Consumer | Previous calculation / defect |
| --- | --- |
| Final local request guard, `contextBudget.js` | `/props` context, capped by configured context; output/reasoning and safety reserves already enforced |
| Prepared measurement, `promptMeasurement.js` | Outer payload cache returned an old capacity without probing; model/port identity omitted load generation and configuration |
| Idle compression, `compressionEngine.js` | Full-request approximation mixed with DB chars/4 total, compared to 75% of caller's configured context |
| Header, `MemoryPalace.jsx` | Configured context as denominator; overlapping measurements shared a generation rather than incrementing it per invocation |
| Context panel | Partial saved-content estimates and usage telemetry without the complete request budget |
| Child model selection | Configured context on local descriptors even when verified runtime capabilities were available |

F01, F02, F06 and F13 were addressed. F05 was inspected for builder/tool/measurement consistency; checkpoint generation and live-run recovery were not redesigned. Audit sources: `context-compaction-audit-2026-10-22.md` and its evidence JSON.

## Contract and resolution

`contextBudget.createRuntimeBudget()` is the shared capacity/reservation contract. It carries provider, model, backend identity, configured total, runtime context, advertised provider context, effective capacity, output reserve, safety reserve, usable input, current input occupancy, measurement method/confidence, capacity method/confidence, 90% ratio and integer trigger. Existing `limit`/`budget` measurement fields remain compatibility aliases for effective capacity and usable input.

A valid positive safe-integer `/props` per-request capacity takes precedence over configured totals, including runtime rounding. Capacity is never guessed by dividing total context by slots. A backend overflow can further lower the guard's limit. Invalid/missing runtime capacity uses the existing 8,192-token fallback ceiling, additionally bounded by any smaller valid configured total, with `conservative-fallback` / `unverified` labels. A smaller already-known overflow ceiling is also retained when a later capability probe fails. This ceiling is a compatibility fallback, not proof of a backend minimum; reactive backend overflow recovery remains necessary.

The established reservation policy is retained: explicit positive output cap, otherwise min(1,024, floor(capacity/4)); numeric reasoning is part of output, so reserve max(output, reasoning); safety is min(128, ceil(capacity/100)). Invalid or exhausting reservations throw `ContextBudgetError`; usable budgets cannot become negative. Prepared measurement uses the existing reasoning resolver, including Anthropic's existing 4,096 default and mapped reasoning output requirements. Provider limits/validation remain in the existing provider transport/resolver.

Capacity and occupancy do not use cumulative inference usage. Cached prompt input is not subtracted from occupancy.

## Scheduling and strict dispatch

The production idle timer keeps the ten-second debounce. At timer execution it resolves the current backend and rebuilds/measures the prepared full request using actual filtered native/MCP schemas, active instructions, attachments, history, summaries, task state, plan and work log. It compares that snapshot's input tokens with the contract's integer trigger using `>=`.

The renderer's passed denominator cannot authorize capacity. IPC resolves trusted engine configuration itself. Engine/model identity and prepared-state fingerprints (history, settings, tool schemas) are checked after measurement and again before archival. Local runtime changes during tokenizer measurement fail closed. A bounded per-session attempt map suppresses unchanged failed prompt/budget attempts; changing the payload or budget permits a later attempt. It does not aggressively repeat compaction to chase the meter.

The final wire-request guard still measures and enforces usable input before dispatch. The 90% threshold does not grant overflow permission: the 34,000-token incident test rejects against 33,920 before dispatch. Its bounded recovery and backend overflow retry remain in place. Post-compaction targets, summary/checkpoint drafting and transaction design were preserved.

Minimal active-message defense: idle compaction exits when an active message has `status = in_progress`, and rechecks at commit. A session that starts a live message or changes backend/prepared state during summarization cannot be archived by the newly scheduled idle operation. Forced/live-run recovery is not redesigned here.

## Measurement, images and UI

Text/template counts still use `/apply-template` and `/tokenize`, including tool-schema verification. Multimodal requests remain `approximate-full-request`: serialized UTF-8 bytes/3, role allowance and **4,096 tokens per image**, explicitly exposed as image count and image allowance. One image does not masquerade as exact tokenization. No vision tokenizer or image allowance reduction was introduced. The existing frontend image optimization is bounded to 1,024 × 1,024, JPEG quality 0.8; that does not establish the backend's vision patch count.

Header and Context panel consume the same `budgetContract.usableInputTokens`. The incident header is `Context: 29.1k / 33.9k`. Header tooltip and panel expose configured total, runtime capacity, provider-advertised capacity, output/safety reservations, usable input, 90% trigger and confidence. The panel receives the existing hook's snapshot rather than making another capacity probe. DB component estimates are explicitly partial.

Prepared measurement is a **prepared-request projection**, even when its text is tokenized exactly. Subsequent tool rounds, media sanitation/movement and provider wire fields can differ from this projection; this limitation is disclosed in both tooltip and panel. Exact tokenizer status applies to the measured representation, not a promise that every later wire request is numerically identical. Draft text remains a cheap estimate. Prior actual request usage stays separately labeled as last-turn telemetry.

Each frontend measurement increments a sequence and clears the previous reading. Results require the current sequence, session and model. Model/context/slot/load-generation changes rerun measurement; unload invalidates pending work. MCP change events refresh measurement even when their aggregate token count happens to stay equal. A deterministic sequence test proves B cannot be overwritten by late A; a real server-rendered Context panel test verifies the 33,920 denominator and image/confidence diagnostics. Electron interaction coverage was blocked as recorded below.

## Cache and agent behavior

Managed engine launches allocate a UUID runtime identity and clear prepared/tokenizer caches; unload clears identity/capabilities and caches. Runtime identity reaches renderer status, local descriptors and count-cache keys. Prepared backend keys additionally include context and slot configuration. Payload hashes include output/reasoning reservation fields, schemas and message content. Counts are bounded to 64 entries per measurer; prepared results to 32. Explicit measurement events refresh `/props` before reusing counts; no capacity probe runs per React render or periodic usage poll. A same-model/same-port context change therefore cannot reuse 35,072 after `/props` reports 16,384.

Local main/child descriptors prefer the existing normalized runtime capability's context, retain backend generation, and preserve independent child selection. Child requests retain the same strict local guard and each child's own model/provider. Child execution permissions, isolation and compaction algorithms were preserved. A stale continuation descriptor cannot override a smaller `/props` capacity at final dispatch.

Cloud capacity uses existing provider/model metadata, with `provider-advertised` / `unverified`, separate from a local runtime measurement. It is never divided by local slots. Existing provider output/reasoning mapping is retained; no cloud parent compaction or new cloud context guard was introduced. Unknown cloud output/capacity remains a labeled projection/fallback rather than verified runtime precision.

## Files changed for C1

- Runtime: `main.js`, `src/main/contextBudget.js`, `src/main/promptMeasurement.js`, `src/main/compressionEngine.js`, `src/main/ipcHandlers.js`, `src/main/localEngineFetch.js`, `src/main/subagents/modelSelection.js`.
- UI: `src/components/MemoryPalace.jsx`, `src/components/ContextPanel.jsx`, `src/components/RightSidebar.jsx`, `src/components/main-app/ChatInterface.jsx`, `src/components/main-app/Header.jsx`, `src/lib/contextDisplay.mjs`, `src/lib/contextMeasurement.mjs`.
- Tests: new `tests/contextC1.test.cjs`, `tests/contextC1Integration.test.cjs`, `tests/contextC1Ui.test.cjs`; targeted updates to `tests/contextPanel.test.cjs` (new measurement prop) and `tests/subagentLongHorizonCompaction.test.cjs` (mock now reports its intended runtime capacity).
- Evidence: this report and `context-c1-unified-budget-evidence.json`.

`modelCapabilities.js`, `promptBuilder.js`, `engineManager.js`, `memoryChat.mjs` and provider reservation/transport paths were inspected and their existing mechanisms reused. They were not independently rewritten for C1.

## Deterministic verification

The three new files contain **29 passing tests**. They cover the exact incident; one/two/three/four reported slot capacities and rounding; explicit output/reasoning/safety reservation; invalid capacity and outage; below/exact/above 90% and >100%; no guard dispatch on overflow; content/schema/output/load/context changes; exact text versus one/two image estimates; cloud semantics; late frontend responses; rendered panel; failed idle-attempt deduplication; active-row preservation; and backend changes during measurement/summarization. Temporary databases use `os.tmpdir()` with a stub Electron data path, not live recovery storage.

Fresh baseline before editing: focused six-file Node run **6 passing files, 0 failed, 0 skipped**. Full explicit-file baseline **215 files: 184 passed, 31 failed, 0 skipped**. `npm test` itself failed because `node --test tests/` tried to resolve the directory as a module on this Node setup. No package script was changed to hide that failure.

Direct post-change focused shell runs: **28 files, 27 passed, 1 failed**; **244 TAP tests passed, 0 TAP failures, 0 skipped**, plus two passing non-TAP scripts and one failing non-TAP script. The failure is the existing `attachments.test.cjs`: its PNG upload has no verified runtime image capability and fails attachment policy. Exact identities/counts are in the evidence JSON. Full-regression comparison and build status are recorded below by the final evidence update.

A Node `spawnSync` aggregation attempt was discarded: the sandbox can return an `EPERM` error together with status 0 and empty output. Those empty results are not test evidence. Focused tests were rerun directly by the shell. The repository's broader tests also have environment-sensitive process/network checks; file-level passes are not a substitute for unrestricted runtime validation.

Electron fixtures attempted: `contextPanel.ui.cjs`, `compressionDispatch.ui.cjs`, `cloudContext.ui.cjs`, `palacePolling.ui.cjs`. All four fail before assertions because Chromium aborts in `sandbox_host_linux.cc` with `Operation not permitted`. No interactive Electron pass is claimed.

Real llama.cpp smoke A–E could not run: this execution namespace exposed no running llama server or workspace GGUF fixture. No existing user's model/conversation was loaded or reconfigured. Slot/reload/threshold/guard checks here use deterministic transports and disposable sessions. Real loaded-model UI agreement remains to be verified in a runnable desktop environment.

## Performance

Single-run measurements, not service-level guarantees; no paid or real inference latency is claimed:

| Measurement | Milliseconds | Method |
| --- | ---: | --- |
| Initial budget/tokenizer resolution | 36.991 | Cold mocked `/props` + template/tokenize path |
| Token-count cache hit with capacity refresh | 0.549 | Mocked `/props` still queried |
| Tool-schema change | 1.204 | Mocked new template/tokenizer count |
| Final guard measurement + mock dispatch | 2.479 | Full guarded transport |
| Header label + tooltip | 0.0474 per call | 1,000 formatting iterations |
| Prepared request first event | 100.215 | Real builders and disposable DB, mocked backend |
| Prepared request repeated event | 11.593 | Real builders + capacity refresh, cached count |
| Idle scheduling boundary/failure/active-row test | 55.840 | Whole deterministic test, fake debounce; includes several cycles, not isolated backend latency |
| Context panel server render | 34.390 | Real bundled component, Node React renderer |

The standalone benchmark made four `/props` probes for four explicit measurement/guard calls, and three tokenizer calls (one count cache hit). A header render makes zero backend probes. Actual local HTTP latency, desktop render timing and server resource impact remain unmeasured.

## Remaining limitations and C2–C5 handoff

C1 does not establish summary fidelity or guarantee useful compaction savings. Prepared projections can differ from eventual live tool-round wire payloads; the final guard remains authoritative. Image allowances are approximate and can require backend overflow recovery. The unverified fallback is not proof of capacity. A managed load generation detects restarts; externally restarted servers without managed identity still require fresh `/props`, which is deliberately not skipped.

C2 should address checkpoint/summary validity, truncation and resumability without weakening this guard. C3 must address live-tail/current-run recovery and transactional continuity; the idle active-message defense here is only a narrow guard. C4 owns in-chat compaction lifecycle UI. C5 owns cloud parent-chat compaction parity. Existing full-suite failures, the attachment policy fixture, unrestricted Electron tests and real one/two-slot smoke tests remain required validation work; they are not declared harmless.

## Final regression and build result

`node --test tests/*.test.cjs tests/*.test.mjs`: **218 file-level tests; 187 passed, 31 failed, 0 skipped**, in 37.597 seconds. Baseline: 215 / 184 / 31 / 0. **New failing identities: 0; resolved failing identities: 0.** Three additional passing files contain the new C1 coverage.

Existing failing file identities (also present before editing):

- `tests/apiServerPort.test.cjs`
- `tests/attachments.test.cjs`
- `tests/childAgentLoop.test.cjs`
- `tests/cloudIpc.test.cjs`
- `tests/cloudProviders.test.cjs`
- `tests/deleteProjectFile.test.cjs`
- `tests/engineSettings.test.cjs`
- `tests/filesystemToolLimits.test.cjs`
- `tests/gitTools.test.cjs`
- `tests/localEngineFetch.test.cjs`
- `tests/lspAgentIntegration.test.cjs`
- `tests/lspCodeIntelligence.test.cjs`
- `tests/lspFoundation.test.cjs`
- `tests/lspProduction.test.cjs`
- `tests/lspProductionAgent.test.cjs`
- `tests/mcpIpc.test.cjs`
- `tests/mcpManager.test.cjs`
- `tests/mcpSse.test.cjs`
- `tests/messageActions.test.cjs`
- `tests/messageStats.test.cjs`
- `tests/nodeHttpFetchCancel.test.cjs`
- `tests/rag.test.cjs`
- `tests/recoveryBoundary.test.cjs`
- `tests/recoveryIpc.test.cjs`
- `tests/recoveryStartupMemory.test.cjs`
- `tests/recoveryStore.test.cjs`
- `tests/skillImportIpc.test.cjs`
- `tests/skillProposalIpc.test.cjs`
- `tests/subAgentRunner.test.cjs`
- `tests/subagentOutOfProcessRecovery.test.cjs`
- `tests/subagentSession.test.cjs`

`npm run build`: **passed**, 14.49 seconds. The existing large-chunk warning remains. Baseline build passed in 18.04 seconds. `git diff --check` and edited main-process JavaScript syntax checks passed. Production packaging and an interactive desktop smoke were not claimed.
