# Continuum — Subagent System Comprehensive Audit

Audit date: 2026-10-18. Investigation, verification and technical planning only: **no application code,
tests, configuration, dependencies, schemas or user data were modified; nothing was committed or pushed.**
The only artifact created is this document.

Repository: `/home/mk_saadi/projects/persona-projects/llm-electron`, branch `main`,
`git status` clean at HEAD `af09c90` ("Add durable Workspace task plan system").

---

## 1. Executive summary

Continuum's subagent system is **far more complete than the roadmap text implies**. Phases 1.3
(budgets/termination), 1.4 (child-context compaction/recovery) and 1.5 (completion/result reliability)
are, in substance, **already implemented and deterministic-test-covered** in the current tree. They were
built as the "subagent Phase 1–4" work stream (see `docs/subagents.md`, `docs/subagent-phase1..4.md`,
`docs/subagent-baseline.md`) whose staged proposal the current source realises. The new roadmap should
therefore be framed as *hardening, exposing and de-capping* an existing subsystem, not building one.

Five findings dominate:

1. **Mid-run child-context compaction is implemented and works.** A child investigation compacts its own
   transcript on context pressure *before each model request* through
   `contextRecovery.createChildContextAdapter` → `compressionEngine.checkAndCompressContext({transcriptAdapter})`
   → `compactionCore.compactTranscript`, with summary + evidence-validated checkpoint, version/raw-history
   preservation and one compact-and-retry on a confirmed backend overflow. Verified by
   `tests/subagentCompaction.test.cjs` (**26/26 passing**, including repeated compaction and continuation).

2. **The hard ceilings block the real-world workload.** `maxToolCalls` and `maxTurns` are validated and
   enforced to **1–100**; `maxInputTokens` to **1,000,000**; `maxOutputTokens` to **500,000**;
   `maxAggregateToolCalls` to **10,000** (`budgetSettings.js:17-20,40-42`; `executionBudget.js:28-30,39-40`).
   Consequence: **>100 tool calls and >100 model requests per child are impossible**, and **2 M+ cumulative
   tokens is unreachable** (input + output caps total ≤ 1.5 M). These are not mis-enforced — they are
   correctly enforced but too low.

3. **The Automatic policy is much tighter than the caps.** For investigation the defaults are
   `maxTurns = 12`, `maxToolCalls = 25`, aggregate `= 100`, and input budget `= 4 × child context window`
   (`budgets.js:38-46`). With a 102 K-token child window the Automatic cumulative input budget is only
   ~409,600 tokens — roughly four full-prompt re-sends.

4. **No execution deadline exists.** There is no child wall-clock deadline and no per-model-request
   timeout: `localEngineFetch` explicitly disables header and body deadlines
   (`headersTimeout: 0, bodyTimeout: 0`, `localEngineFetch.js:7`). A stalled local model hangs a child
   until the user cancels the parent turn. There is no `timed_out` terminal state.

5. **The rich child-control surface is dead code from the UI's point of view.** `startInvestigation`,
   `sendMessage`, `interrupt`, `resume`, `cancelBackground`, `describeChild` and `backgroundEvents` are
   exported by `src/main/subagents/index.js` but are **not wired to any IPC handler, preload method or UI**.
   The only model-reachable delegation path is the foreground `spawn_sub_agent` tool. Persistence
   (`subagent_runs`) is a preview/diagnostic record, **not** resumable execution: active children do not
   survive restart.

Verdict on the headline question — *can Continuum compact a running subagent's context and continue the
same task?* — is **Yes, verified** (deterministically; live-model fidelity untested). But it can only do so
within the caps in finding 2/3.

---

## 2. Architecture and execution-flow diagram

### 2.1 Real entry points

| Layer | Symbol | File |
|---|---|---|
| Parent model tool | `spawn_sub_agent` schema | `src/main/tools/subagent.js:18` |
| Parent dispatch | `executeSpawnSubagent` | `src/main/tools/subagent.js:54` |
| Parent tool router | `executeAgentTool` (`name === 'spawn_sub_agent'`) | `src/main/tools/agentTools.js:1843` |
| Runtime boundary | `runInvestigation` / `runFileAnalysis` / `runWebExtraction` | `src/main/subagents/index.js:107-120` |
| Foreground core | `runInSession` | `src/main/subagents/index.js:232` |
| Background core | `startInBackground` | `src/main/subagents/index.js:278` |
| Child identity | `openRun`, `createSession` | `index.js:162`, `sessionManager.js:59` |
| Model choice | `resolveChildEngine` | `modelSelection.js:131` |
| Investigation loop | `runInvestigationExecution` | `agentLoop.js:189` |
| Tool execution | `executeChildTool` → `executeAgentTool` (`permissionMode:'read_only'`) | `agentLoop.js:135` |
| Scheduler | `scheduleInference` → `submit` | `inferenceScheduler.js:160,113` |
| Provider | `chatCompletion` | `providers/localProvider.js:18`, `providers/cloudProvider.js:32` |
| Prompt guard/measure | `createContextGuardedFetch` | `contextBudget.js:114` |
| Budget | `getExecutionBudget`, `dispatchTool`, `stopBeforeRequest`, `outcome` | `executionBudget.js:25,144,50,165` |
| Child compaction | `createChildContextAdapter` → `compactTranscript` | `contextRecovery.js:83`, `compactionCore.js:59` |
| Lifecycle | `completeSession`/`failSession`/`cancelSession`/`interruptSession` | `sessionManager.js:184-217` |
| Continuation | `registerChild`/`sendMessage`/`interrupt`/`resume`/`drive` | `continuationManager.js:136,316,343,384,193` |
| Persistence | `persistChildRun`, `readPersistedTranscript` | `persistence.js:102,168` |

### 2.2 Execution flow (foreground investigation, the primary path)

```
Parent chat turn (ipcHandlers engine:chat, line 470)
  childBudgetScope = createParentRunBudget()                 // shared per parent invocation
  runMemoryChat(...)                                          // memoryChat.mjs:399
    model reply with tool_calls
    dispatch ahead (memoryChat.mjs:765-772) for spawn_sub_agent
      executeAgentTool(spawn_sub_agent, budgetScope)          // agentTools.js:1843
        executeSpawnSubagent(investigate:true)                // tools/subagent.js:73-81
          runtime.runInvestigation({task, rootPath, engine, budgetScope, onSpawn})   // index.js:118
            resolveChildEngine(engine)   // modelSelection.js:131 (once, frozen for lifetime)
            controller = new AbortController(); forwardAbort(parentSignal)           // index.js:249-250
            openRun -> createSession(child_<uuid>) + startSession + createExecution    // index.js:162 / sessionManager.js:59
            continuationManager.registerChild(session)          // only 'investigation' is continuable
            runInvestigationExecution({session, engine, signal, ...})   // agentLoop.js:189
              getExecutionBudget(session,...)                   // executionBudget.js:25 (freezes budgets on first call)
              messages = [system child prompt, user task] (or restored session.context)
              createChildContextAdapter(...)                    // contextRecovery.js:83
              loop:
                stopBeforeRequest / turn reserve                // executionBudget.js:50
                inferenceScheduler.scheduleInference            // inferenceScheduler.js:160
                  provider.chatCompletion -> localEngineFetch (context-guarded + budgeted)
                    createContextGuardedFetch measures/recovers/overflows
                tool calls -> normalizeToolCalls (agentLoop.js:107)
                  per call: repetition sig, allowlist, dispatchTool (budget), executeChildTool
                append tool results, commit context, persist
                context.prepare(payload) before each request -> compaction when under pressure
              finish -> executionBudget.outcome -> {output, outcome, stopReason, usage, accounting}
            completeExecution + completeSession + onTurnSettled  // index.js:266-268
          boundResultForParent (1800 chars)                      // tools/subagent.js:47
        tool result returned to parent runMemoryChat
```

### 2.3 Verified vs intended

- **Implemented:** child identity/parent link, model freeze, isolated child context, read-only tool
  allowlist, per-child + shared budgets, mid-run compaction + checkpoint, overflow retry, terminal
  statuses incl. `partial`, transcript/accounting persistence, background lifetime (runtime API),
  child message/interrupt/resume (runtime API), retention pruning.
- **Implemented but not exposed:** background start, messaging, interrupt, resume, cancel,
  `describeChild`, `backgroundEvents`, background badge.
- **Not implemented:** nested delegation (children cannot spawn — by design, `agentLoop.js:59-73,137`),
  wall-clock deadlines/timeouts/`timed_out` status, restart recovery/resumption of active or interrupted
  children, un-limited budgets, live-streaming of child tokens into the parent transcript.

`agentId` is stored on the session but no separate child agent profile/instructions are loaded
(`modelSelection` + `agentLoop` use a fixed child system prompt) — consistent with the Phase 0 finding.

---

## 3. Current capabilities inventory

| Capability | Status | Evidence |
|---|---|---|
| Foreground delegated investigation (multi-turn) | Implemented, tested | `agentLoop.js:189`; `childAgentLoop.test.cjs` 14 pass |
| One-shot file analysis / web extraction | Implemented, tested | `executionManager.js:319,432`; `subagentFailureDiagnostics.test.cjs` 5 pass |
| Background (detached) children | Implemented (runtime only), tested | `index.js:278`; `backgroundExecution.test.cjs` 13 pass |
| Child identity + parent linkage | Implemented, tested | `sessionManager.js:54-92` |
| Independent child context (no parent history) | Implemented, tested | `agentLoop.js:25-40`; `childMessaging.test.cjs` 16 pass |
| Read-only tool allowlist + `read_only` enforcement | Implemented, tested | `agentLoop.js:62-73,150-157` |
| Per-child tool/request/token budgets | Implemented, tested | `executionBudget.js`; `subagentReliability.test.cjs` 23 pass |
| Shared parent-invocation aggregate budget | Implemented, tested | `executionBudget.js:20-24,147`; `subagentDispatchConcurrency.test.mjs` 11 pass |
| Mid-run child-context compaction | Implemented, tested | `contextRecovery.js:83`; `subagentCompaction.test.cjs` 26 pass |
| Evidence-validated checkpoint across compactions | Implemented, tested | `compactionCore.js:30`; `taskCheckpoints.js:371,700` |
| Overflow compact-and-retry (once) | Implemented, tested | `agentLoop.js:244-262`; `contextBudget.js:114-180` |
| Terminal statuses incl. `partial` | Implemented, tested | `sessionManager.js:23-38,184` |
| Child progress/activity feed (bounded) | Implemented, tested | `sessionManager.js:225`; `getChildTranscript` `index.js:393` |
| Usage accounting (measured/estimated/reserved) | Implemented, tested | `budgets.js:135-159`; `subagentDisplay.mjs:16` |
| Durable transcript (preview) + compaction events | Implemented, tested | `persistence.js:102`; `subagentTranscript.test.cjs` 14 pass |
| Child streaming (SSE) + XML tool-call recovery | Implemented, tested | `streamCompletion.js:5`; `subagentStreaming.test.cjs` 7 pass |
| Retention pruning of completed children | Implemented, tested | `continuationManager.js:454`; `subagentRetention.test.cjs` 13 pass |
| Nested delegation | **Missing (by design)** | `agentLoop.js:59-73` |
| Execution deadline / `timed_out` | **Missing** | no deadline in `subagents/**`; `localEngineFetch.js:7` |
| Restart recovery / resumable children | **Missing** | `backgroundStore.js:18-21`; in-memory maps |
| User-facing child control (message/interrupt/resume) | **Missing wiring** | runtime exports only (`index.js:424-439`) |
| Unlimited / very-high budgets | **Missing** | caps in `budgetSettings.js:17-20` |

---

## 4. Budget and limit enforcement findings

### 4.1 Origin of the reported numbers

| Reported setting | Origin | UI max | Backend validation | Enforcement |
|---|---|---|---|---|
| Tool calls per child = 100 | `subagentBudgets.maxToolCalls` | 100 (`SubagentBudgetSettings.jsx:96`) | 1–100 (`budgetSettings.js:40`) | `dispatchTool` `executionBudget.js:146` |
| Model requests per child = 100 | `subagentBudgets.maxTurns` | 100 (`…:97`) | 1–100 (`budgetSettings.js:41`, `executionBudget.js:28`) | `stopBeforeRequest`/`reserveRequest` `executionBudget.js:53,71`; loop reserve `agentLoop.js:225` |
| Tool calls per parent run = 10,000 | `subagentBudgets.maxAggregateToolCalls` | 10000 (`…:98`) | 1–10000 (`budgetSettings.js:42`, `executionBudget.js:39`) | `dispatchTool` `executionBudget.js:147` |
| Max input tokens = 1,000,000 | `subagentBudgets.maxInputTokens` | 1000000 (`…:110`) | 512–1000000 (`budgetSettings.js:18,38`) | `stopBeforeRequest` `executionBudget.js:55` |
| Max output tokens = 500,000 | `subagentBudgets.maxOutputTokens` | 500000 (`…:120`) | 256–500000 (`budgetSettings.js:20,39`) | `stopBeforeRequest` `executionBudget.js:57,64` |

All five are stored as a single app-settings row `app_settings.key = 'subagentBudgets'`
(`budgetSettings.js:12,46-73`) and are app-wide (not per-session).

### 4.2 Concrete semantics (source-confirmed)

- **Tool-call counter counts individual calls, not batches.** `dispatchTool` is invoked once per call in
  the response loop (`agentLoop.js:342`). A response with N calls consumes N slots (or is denied/skipped
  individually).
- **Checked before execution.** `dispatchTool` returns a skip reason *before* `executeChildTool` /
  file read / page fetch; the increment is synchronous, immediately before dispatch
  (`executionBudget.js:148-152`).
- **Failed dispatched tools consume budget** (increment already happened; the error is returned as a
  tool string). **Denied calls do not** consume the child counter — once `toolCalls >= maxToolCalls`,
  each further call only bumps `blockedCalls` (`executionBudget.js:146-148`, `agentLoop.js:330,347`).
- **Concurrent children cannot overspend** the shared scope: check+increment are synchronous with no
  await between them (`executionBudget.js:149-151`; verified by "concurrent children atomically compete
  for one aggregate dispatch slot", `subagentReliability.test.cjs:294`).
- **Children consume the parent invocation's aggregate** (`scope.toolCalls`), which is created once per
  `engine:chat` call (`ipcHandlers.js:470`) and passed down. Note: the label "Tool calls per parent run"
  is misleading — the parent's **own** tool calls are not counted; only child dispatches are.
- **Model-request counter counts attempted dispatches.** `reserveRequest` increments `ledger.turns`
  before send (`executionBudget.js:71`); failed requests keep their reservation
  (`subagentReliability.test.cjs:309`). Compaction summary/checkpoint, incomplete-answer continuation,
  finalization and retries each count (`agentLoop.js:236-262`, `contextRecovery.js:135-141`).
- **Off-by-one by design:** the loop stops tool work at `turns >= maxTurns - 1` to reserve the last
  request for a tool-free report (`agentLoop.js:225`). So the default 12 requests = ≤11 work + 1 report.
- **Retries do not bypass accounting.** One-shot empty-answer retry and investigation continuation each
  traverse `scheduleInference` → `budgetedFetch.beforeRequest` (`subagentReliability.test.cjs:238,265`).
- **Usage survives compaction.** The ledger lives on `session.budgetState`, independent of the transcript
  (`subagentCompaction.test.cjs:128`).
- **Token budgets are per-child lifetime, not per-request.** `getExecutionBudget` returns the cached
  `session.budgetState` on every later call (`executionBudget.js:26`); budgets are frozen once
  (`subagentReliability.test.cjs:85`).

### 4.3 Token accounting

- **Input**: `settleRequest` prefers reported `prompt_tokens`/`input_tokens`; otherwise the whole turn
  stays estimated via `estimatePromptTokens` (`executionBudget.js:81-86,70-72`).
- **Output**: reported `completion_tokens`/`output_tokens`; otherwise the full dispatched `max_tokens` is
  **reserved** (`outputReserved`, `outputUnknownTurns`) — absent usage is never treated as zero
  (`executionBudget.js:73-74,87-91`).
- **Coverage** is labelled `measured`/`estimated`/`mixed`/`reserved`/`partial`/`unavailable`
  (`budgets.js:148-159`; surfaced by `subagentDisplay.mjs`).
- **Local child usage is frequently reserved, not measured**: the child payload does not request
  `stream_options.include_usage` (`agentLoop.js:236-237`; `streamCompletion.js:35` reads `chunk.usage`
  only if the backend sends it). Cloud providers normally report measured usage.

### 4.4 Configuration behaviour

- Defaults (current code): `MAX_TURNS.investigation = 12`, `MAX_TOOL_CALLS.investigation = 25`,
  `DEFAULT_AGGREGATE_TOOL_CALLS = 100`, input `4 × contextLength`, output `maxTurns × perRequestCeiling`
  (`budgets.js:28-46,93-125`).
- **Documentation conflict (Confirmed source behaviour):** `docs/subagents.md:11-15,148` and
  `docs/subagent-phase3.md` state the defaults/default policy are **10 calls / 8 requests / 40 aggregate**.
  The code and the on-screen hint (`SubagentBudgetSettings.jsx:90`) now say **25 calls / 12 requests /
  100 aggregate**. The spec doc is stale by ~1 implementation generation.
- Changes take effect **only for new children**; a live child's budgets are frozen (`executionBudget.js:26`;
  UI `…:91` "Changing settings affects new children").
- Values **persist** in `app_settings`; invalid saved JSON **fails loudly**
  (`budgetSettings.js:59`) rather than silently defaulting (missing DB → auto).
- **Unlimited execution is not representable**; there is no "no limit" mode.
- Budgets **cannot be extended after child creation** (frozen state; no extension API).

### 4.5 Budget inventory table

| Budget | Config location | Default | UI maximum | Backend maximum | Enforcement location | Actual behaviour | Issues |
|---|---|---|---|---|---|---|---|
| Tool calls / child | `subagentBudgets.maxToolCalls` | 25 (investigation) | 100 | 100 | `executionBudget.js:146` | per call, pre-dispatch; failed counts, denied doesn't | caps 150+ workloads |
| Model requests / child | `.maxTurns` | 12 | 100 | 100 | `executionBudget.js:53,71`; `agentLoop.js:225` | attempted generations; last reserved for report | caps 150+ requests |
| Aggregate child tool calls / parent invocation | `.maxAggregateToolCalls` | 100 | 10000 | 10000 | `executionBudget.js:147` | shared across children of one `engine:chat` | label misleading; per-parent-turn |
| Child input tokens (cumulative) | `.maxInputTokens` | `4 × contextLength` | 1,000,000 | 1,000,000 | `executionBudget.js:55` | measured or estimated; lifetime | blocks 2 M+ |
| Child output tokens (cumulative) | `.maxOutputTokens` | `maxTurns × ceiling` | 500,000 | 500,000 | `executionBudget.js:57,64` | measured or reserved; lifetime | combined < 2 M |
| Per-request generation ceiling | fixed | 2048 / 3072 / 1024 | n/a | n/a | `budgets.js:28-32`, `agentLoop.js:237` | `max_tokens`; +1 bounded escalation | — |
| Child wall-clock deadline | **none** | — | — | — | — | no deadline | stalled model hangs child |
| Model-request timeout | **none** | — | — | — | `localEngineFetch.js:7` | disabled | no `timed_out` |
| Tool-execution timeout | partial | web fetch 15 s | — | — | `webSearch.js:177` | local reads unbounded | — |
| Compaction guard | fixed | ≥3 request slots, ≥1792 output tokens | — | — | `contextRecovery.js:135-141` | refuses compaction when short | competes with report |

---

## 5. Child-context management and mid-run compaction findings

### 5.1 Shared vs child-specific mechanisms

- **Shared primitives:** `compactionCore.summarizeCandidates` and `generateCheckpoint` (extracted from the
  Workspace engine), `taskCheckpoints.validateCheckpoint`/`renderCheckpointSection`,
  `contextBudget` measure/reserve/classify, the same summary/checkpoint prompt constants
  (`compactionCore.js:3-4,8,30`; `compressionEngine.js:250-251`).
- **Child-specific:** `contextRecovery.createChildContextAdapter` builds the child snapshot from
  `session.rawContext`, keeps its own version/owner, uses an isolated evidence index with an injectable
  `messageExists`, and persists to the child's own `subagent_runs` row — never the parent's session
  (`contextRecovery.js:83-236`; `docs/subagents.md:99-123`).
- **Parent-independent:** the child adapter branch of `checkAndCompressContext` never acquires the
  primary-session `is_compressing` lock or reads parent briefs/checkpoints (`compressionEngine.js:250`).
- Compaction is honoured only if the **selected model's** `compactionEnabled` is on
  (`contextRecovery.js:213-219`).

### 5.2 Triggers (source-confirmed)

| Trigger | Where | Condition |
|---|---|---|
| Before each child model request | `agentLoop.js:238` → `adapter.prepare(payload)` | pressure ≥ threshold |
| Pressure computation | `compactionCore.js:61-64` | `(tokens + reserve) / limit`; exact-measure threshold **0.78**, estimate **0.75** |
| On confirmed backend overflow | `agentLoop.js:244-262` | one compact-and-retry (`contextBudget.js:169-178`) |
| After repeated large tool outputs | `trimToolResult` at append time | result capped to `min(12000, 12% × window × 3)` (`contextRecovery.js:51-81,362`) |
| Idle/periodic | **parent only** | `scheduleIdleCompression` (`compressionEngine.js:734`) — not used by children |

Compaction is **automatic**; there is no user-facing manual "compact child" control. It is **not** driven
by a fixed turn interval.

### 5.3 Information preservation (evaluated against the 14 required items)

Preserved independently of the model summary:
1. **Original objective** — pinned user task + checkpoint `objective` (`contextRecovery.js:148-153`,
   `compactionCore.js:3`). ✔ (also re-derived as a checkpoint requirement)
2. **Parent instructions/constraints** — all `user` messages are pinned and never archived
   (`contextRecovery.js:148`). ✔
3. **Workspace identity/boundaries** — child `rootPath` + fixed read-only allowlist live outside the
   transcript. ✔
4. **Important findings** — evidence index + checkpoint `completedWork`/`decisions` with sources. ✔*
5. **Files read/changed** — checkpoint `filesChanged`; evidence `paths` (reads only for children). ✔
6. **Decisions made** — checkpoint `decisions` (+`retainPrior` union across compactions). ✔
7. **Failed approaches** — captured indirectly via error tool results and `blockers`/`unknowns`; no explicit
   "failed approaches" field. Partial.
8. **Active blockers** — checkpoint `blockers`. ✔
9. **Remaining tasks** — checkpoint `nextActions` + `outstandingRequirements`. ✔
10. **Pending verification** — checkpoint `tests`/`verified` flags. ✔
11. **Tool/permission constraints** — fixed allowlist + `read_only`, outside transcript. ✔
12. **Budget counters** — `session.budgetState` ledger, independent of transcript; survives compaction. ✔
13. **Cancellation/deadline state** — the `AbortSignal` is external and unaffected by compaction; single-turn
    ownership enforced by `continuationManager`. ✔
14. **Source references** — checkpoint `sources`/`stepRef` validated against an evidence index built from
    `session.rawContext` (`contextRecovery.js:174-185`; `compactionCore.js:45-53`). ✔

**Successive compactions:** yes — `meta.summary`/`meta.checkpoint` are carried forward and
`retainPrior` unions earlier checkpoint entries; refusal occurs if essential state would be trimmed
(`compactionCore.js:37-51`; `subagentCompaction.test.cjs:88,309`).

**Data independent of model summaries:** original system prompt, all user/task messages, tool-call/result
raw history (`session.rawContext`), budget ledger, engine descriptor, permissions, allowlist, signal,
inbox. **Data that depends on model-generated summaries:** the rolling summary and the checkpoint's
narrative fields. `rawContext`/`compactionState` are persisted alongside the active projection
(`persistence.js:154-156`) but are **not** used to rebuild a live child after restart.

### 5.4 Compaction execution and recovery

- **Summarizer model:** the child's own engine/provider through the same scheduler and ledger
  (`contextRecovery.js:118-132`); summary ≤512 output tokens, checkpoint ≤1024 (`agentLoop.js` budget
  guard, `contextRecovery.js:155,187`; `taskCheckpoints.js:34`).
- **Budget:** summary + checkpoint are charged as ordinary requests and output tokens; they do **not** refill
  any counter (`contextRecovery.js:135-141`; `subagentCompaction.test.cjs:128`).
- **Child resumes its own loop:** yes; the loop continues after `context.prepare` returns a compacted payload
  and re-checks the reporting/aggregate reserves (`agentLoop.js:238-243`).
- **Identity unchanged:** `meta.owner`, version and engine identity are verified at commit; engine/root/
  allowlist stay with the runtime (`contextRecovery.js:199-200`).
- **Structural validity:** `validatePairs` rejects malformed/mismatched/duplicate/in-flight pairs before
  generation and again on commit (`contextRecovery.js:17-34,198-204`; `subagentCompaction.test.cjs:146`).
- **Summarization failure:** candidate is abandoned with no archival and no retry loop; reason
  `compaction_failed` (`compactionCore.js:76`; `subagentCompaction.test.cjs:153,159`).
- **Still too large / irreducible:** refusal with `protected-context-too-large` (compactionCore) or
  `non-compressible-context-too-large` (Workspace floor) → the child returns a truthful partial
  (`subagentCompaction.test.cjs:309`).
- **Overflow retry:** exactly one, after the scheduler releases the lane (`agentLoop.js:244-262`;
  `subagentCompaction.test.cjs:199,211`).
- **Repeated-failure loop:** not possible — one retry flag (`recovered`).
- **Cancellation during compaction:** `signal.throwIfAborted` threaded through measure/summarize/commit;
  raw/active history retained (`contextRecovery.js:109,198`; `subagentCompaction.test.cjs:165`).
- **Results persisted:** summary/checkpoint/events upserted with the run (`persistence.js:156`;
  `subagents.md:114-123`).
- **Restart recovery:** none — the live session/context is in-memory only.

### 5.5 Long-horizon feasibility (the 102 K / 150-call / 2 M scenario)

| Obstacle | Type | Evidence |
|---|---|---|
| `maxTurns ≤ 100` | configuration limit | `budgetSettings.js:41`, `executionBudget.js:28` |
| `maxToolCalls ≤ 100` | configuration limit | `budgetSettings.js:40` |
| `maxInputTokens ≤ 1,000,000` cumulative | configuration limit | `budgetSettings.js:18` |
| `maxOutputTokens ≤ 500,000` cumulative | configuration limit | `budgetSettings.js:20` |
| Automatic input = `4 × window` (≈409,600 at 102 K) | configuration policy | `budgets.js:46,96` |
| No child deadline; stalled model hangs | harness gap | `localEngineFetch.js:7` |
| `partial` children cannot resume to finish | lifecycle limitation | `sessionManager.js:38,123`; `subagents.md:53` |
| No restart recovery | persistence limitation | `backgroundStore.js:18` |
| Semantic repeated reads consume the cap (no result cache) | design | `agentLoop.js:337-340` (verified by `subagentReliability.test.cjs:164`) |

Not obstacles: search/reasoning per se; compaction availability; scheduler capacity (a large-context child
uses one lane and can compact/continue).

**Definitive answer: Can Continuum currently compact a running subagent's context and continue the same
delegated task reliably? → Yes, verified (deterministic).** The compaction/recovery/continuation path is
present, exercised by 26 passing tests (repeated compaction, checkpoint retention, overflow retry,
cancellation, failed compaction), and preserves the objective, constraints and evidence. Caveats:
live-model summary fidelity and threshold tuning are unverified; and the caps in §4/§5.5 prevent the
specific 100+ call / 100+ request / 2 M-token workload from ever being reached.

---

## 6. Long-horizon execution feasibility (summary)

| Workload | Currently supported? | Blocking issue | Required change |
|---|---|---|---|
| 50+ tool calls | Only under Custom (≤100) | Automatic default 25 | Raise Automatic or document Custom |
| 150+ tool calls | **No** | `maxToolCalls ≤ 100` | Raise/uncap the cap |
| 150+ model requests | **No** | `maxTurns ≤ 100` (+ last reserved for report) | Raise/uncap the cap |
| 2 M+ cumulative tokens | **No** | `maxInputTokens ≤ 1 M` (+ output ≤ 0.5 M) | Raise/uncap or make renewable |
| Multiple context compactions | **Yes** | each costs requests/tokens | keep caps above compaction overhead |
| Parent cancellation | **Yes (foreground)** | forwarded via `forwardAbort` | expose child-level cancel |
| Nested delegation | **No (by design)** | child allowlist | product decision |
| Resume interrupted child | Runtime API only (`resume`) | not wired to UI/tool | expose + persist |
| Reliable terminal reporting | **Yes** | `partial`/stopReason/`accounting` | keep; verify live |

---

## 7. Parent-child context and usage accounting

- **Child gets a focused task prompt, not a copy of the parent conversation.** `agentLoop.js:202-204`
  seeds `[system, user(task)]`; the module never reads parent history/memory/other children
  (`agentLoop.js:25-40`). Continuations append parent messages as single `user` turns
  (`continuationManager.js:211-218`).
- **Parent history is not included** in any child request.
- **Children keep independent histories** (`session.context` per child id).
- **Parent receives a bounded result**, not the transcript: `boundResultForParent` caps the returned
  string at 1800 chars (`tools/subagent.js:47-52`); the full child answer stays in `session.result` /
  `session.context`.
- **Tool logs are exposed to the parent only as step metadata** (`childSessionsByToolCall`, `ipcHandlers.js:696-705`)
  and the inspection modal; not as context.
- **Child compaction cannot modify parent context** — separate adapter, no parent session id, isolated
  persistence (`subagents.md:99`).
- **Token usage reporting:** the parent's `ContextPanel` shows parent usage; child usage lives in
  `accounting`/`usage` in the transcript modal (`subagentDisplay.mjs:16-32`).
- **Shared mutable state across children:** the aggregate budget scope (by design) and the shared
  scheduler lanes. No shared transcript state.

**Parallel children with a 102 K parent window:** children do not inflate the parent prompt (only the
bounded 1800-char result per spawn enters parent context), so parallel children do not cause parent
context duplication. Real risks: (a) the parent result cap can drop evidence the parent needs to
synthesise; (b) concurrent same-lane local children serialise (capacity 1), so "parallel" is scheduling,
not speedup; (c) child transcripts are retained in memory (`pruneChildSessions` mitigates, TTL 30 min /
500 cap).

---

## 8. Cancellation, timeout, and termination findings

**Cancellation path:** user cancels parent turn → `controller.abort()` (`ipcHandlers.js`) → parent signal
forwarded into each foreground child's controller (`index.js:194-203,249-250`) → scheduler dequeues a
queued request or the provider's fetch aborts (`inferenceScheduler.js:119-135`) → the loop checks
`signal.throwIfAborted()` between turns and after tools (`agentLoop.js:221,277,366`) → settlement marks the
execution `cancelled` and the session `cancelled` (`index.js:218-221`).

| Target | Stops reliably? | Evidence / caveat |
|---|---|---|
| Active model request | Yes (fetch abort) | `signal` threaded to provider |
| Queued request | Yes (dequeue) | `inferenceScheduler.js:125-134` |
| Pending retries | Yes | abort checked at loop top |
| Streaming | Yes (`reader.cancel`) | `streamCompletion.js:72-75` |
| Context compaction | Yes | `signal` in measure/summarize/commit |
| Nested children | N/A (none) | — |
| Tool execution | Best-effort | abort signal passed; **a started side effect is not undone** |
| Background child | Only via runtime `cancelBackground` (no UI) | `backgroundStore.js:75` |

**Timeouts:** no per-child wall-clock deadline; **no model-request timeout** (`localEngineFetch.js:7`);
web fetch has a 15 s timeout (`webSearch.js:177`). A stalled local model or a non-responding backend hangs
the child until the user cancels. There is **no `timed_out` status**; timeout precedence is undefined
because overall deadlines do not exist.

**Terminal-state contract:** statuses `created`, `waiting`, `running`, `completed`, `partial`,
`interrupted`, `failed`, `cancelled` (`sessionManager.js:23-38`). `stopReason` enumerates
`tool_limit`, `aggregate_tool_limit`, `turn_limit`, `input_budget`, `output_budget`, `context_exhausted`,
`compaction_failed`, `no_progress`, `empty_response`, `malformed_response`, `incomplete_response`,
`provider_error`, `provider_budget_violation`, `runtime_error`, `cancelled`, `interrupted`
(`subagents.md:55-65`). **Timed out** is not representable. **Partial/incomplete** is represented by
`partial`. `IS_TERMINAL` includes `partial`, so a partially-complete child **cannot be resumed** to
finish its objective (`sessionManager.js:38`, `continuationManager.js:123`).

Terminated children do not keep running model requests: the loop and provider honour the one signal.
A late provider resolution is discarded because the loop already rethrew on abort. The one honest caveat
is a tool that already began an external side effect (not reachable by children, which are read-only).

---

## 9. Streaming and result reporting

- **Child streaming** is per-child and in-memory: `session.liveProgress` is set by the scheduler task
  (`inferenceScheduler.js:169-175`) and bounded; `pushActivity` retains the last 80 events with 600-char
  text caps (`sessionManager.js:223-237`).
- **Parent/UI visibility:** the parent transcript shows step metadata and the bounded final result; live
  child output is available only by **polling** `getChildTranscript` in the activity modal
  (`SubagentTranscriptModal.jsx:205`; IPC `subagent:get-transcript`, `ipcHandlers.js:293`). There is no
  event-push channel for child tokens to the parent.
- **Partial child output is not streamed into the parent transcript**; only the final bounded string is.
- **Errors** are not pushed live to the parent either; the parent sees the tool error at settlement.
- **Streaming survives compaction** because `onProgress`/`liveProgress` are independent of the transcript.
- **Cancellation listener cleanup:** the scheduler removes its abort listener on start; SSE readers are
  cancelled in a `finally` (`streamCompletion.js:72`; `inferenceScheduler.js:73-78`).
- **Late events overwriting terminal status:** the status is set by the single settlement path; transcript
  readers use a live record or fall back to SQLite. Low risk; not dynamically tested here.
- **Concurrent children have isolated event identity** (per session id; Scheduler lanes per provider/model).
- **Memory risks:** `liveProgress` holds up to a 3000-char text slice per active child; `activity` bounded
  at 80×600; completed sessions pruned by TTL/count. Acceptable, but background `active` map only clears on
  settlement.

---

## 10. Model/backend compatibility

- **Local (llama.cpp/OpenAI-compatible):** `providers/localProvider.js`. Streams when a progress observer
  is present (always for children, since `session` is passed). Tools pass through only with
  `allowTools:true` (the child loop opts in). Uses `localEngineFetch` (context-guarded, budgeted,
  no deadlines). Context overflow classified from HTTP 400 bodies (`contextBudget.js:12-23`).
- **Cloud (OpenAI-compatible providers):** `providers/cloudProvider.js`, capacity 4; builds its own
  transport from the saved provider; **ignores the caller `fetchImpl` and does not use the local guarded
  recovery** (so cloud overflow relies on the provider-transport `onErrorResponse` classifier,
  `cloudProvider.js:38-47`). Anthropic-style normalization is covered by `cloudProviders.test.cjs`.
- **Reasoning formats/tool calls:** reasoning captured from `reasoning_content`/`reasoning`
  (`streamCompletion.js:44`; `agentLoop.js:288`); Qwen XML tool calls are inferred and hidden from visible
  output by `createXmlToolCallInterceptor` (`streamCompletion.js:8,15-17,54,79`); incomplete XML is marked
  `toolMarkupIncomplete` and treated as `malformed_response`.
- **Reasoning-only turns / thinking saturation:** handled by the bounded incomplete continuation
  (`agentLoop.js:309-316`) then `empty_response`; a `length` finish escalates the ceiling once
  (`escalatedCeiling`, `budgets.js:177`). One-shot paths diagnose empty/reasoning-only output with
  structural diagnostics (`executionManager.js:122-168`). This is the Phase 1.5 territory —
  currently *partially* handled, not fully hardened (e.g. an accepted non-empty `length` answer becomes
  `incomplete_response` partial, which is truthful but not a completion).
- **Usage accounting differs by backend:** cloud reports measured usage; local often omits it, so child
  totals are reserved/estimated (§4.3).
- **Request cancellation:** both providers forward `signal` to `fetch`.
- **Retry handling:** no provider-level retry; only the bounded empty-answer retry (one-shot) and
  incomplete-continuation (investigation).
- **Provider error normalisation:** local/cloud return `{ok:false,status}` and the loop maps to
  `provider_error`; cloud bodies are classified in memory and not logged.

Backend differences are real: the local path has tokenizer-based measurement and guarded recovery; the
cloud path uses labelled byte estimates and gets no local recovery adapter.

---

## 11. Persistence and restart behaviour

| Persisted | Location | Notes |
|---|---|---|
| Child identity + parent link + model/provider | `subagent_runs` | `persistence.js:121-157` |
| Task text, output, error, thoughts | `subagent_runs` | `persistChildRun` |
| Tools used (with counts) | `tools_json` | `summarizeToolsUsed` |
| Turns preview (last 60 × 3000 chars) | `turns_json` | preview only |
| Raw child history | `raw_turns_json` | `session.rawContext` |
| Active (compacted) context | `context_json` | `session.context` |
| Compaction summary/checkpoint + events | `compaction_json` | `session.compactionState` |
| Usage/accounting/stop reason/duration | columns | `accounting_json`, `stop_reason` |

Scenario outcomes:
1. **Switch tabs** — in-memory session unaffected; UI filters by session id.
2. **Parent continues another turn** — completed children remain in memory; the new `engine:chat` gets a
   **new** aggregate scope; existing children are not re-driven.
3. **Child finishes while UI unfocused** — settlement writes the run row; the modal reads it later.
4. **App closes during child execution** — active children are lost (in-memory controller/session).
5. **Crash** — same as 4; last committed preview survives.
6. **Restart** — `getChildTranscript` falls back to `readPersistedTranscript` (a **preview**, not a
   replayable session). No inbox, context resume, or job restart (`backgroundStore.js:18-21`).
7. **Parent requests continuation of an interrupted child** — possible via runtime `resume`/`sendMessage`
   **only while the process lives**; no UI/tool wiring, and no persistence of the inbox.

**Transcript persistence ≠ resumable execution.** This is explicitly not implemented. Phase 1.1
(`run_tests`, `verification.test.cjs` 10 pass) and Phase 1.2 (`update_plan`, durable `workspace_plans`)
persisted data can support *future* resume (objectives/steps/verification are durable, session-keyed and
compaction-independent), but no code currently rehydrates an interrupted **child** from them.

---

## 12. Security and permission boundaries

- **Children always run `permissionMode: 'read_only'`** with `sessionId: null` (`agentLoop.js:150-157`),
  independent of the parent's mode. A `full_access` parent still gets a read-only child.
- **Tool allowlist** is a fixed 10 read-only tools (`agentLoop.js:62-73`); anything else is rejected before
  execution and never dispatched (`agentLoop.js:137-140,341`).
- **Workspace containment:** `readingFiles` tools honour the explicit child `rootPath`; writes/commands
  never accept that override (`agentTools.js:1834-1841`).
- **No writes/shell/MCP/memory/spawning** in the child allowlist; MCP tools are deliberately excluded
  (`tools/subagent.js:12-15`).
- **Child execution does not bypass parent permission checks:** spawn itself is gated by
  `CAPABILITIES.AGENT_SPAWN`, allowed in all modes (`toolPermissions.js:101-103,254-300`), and the child's
  own tools are separately gated read-only.
- **Narrower scope:** children are strictly a subset (read-only) of the parent's capabilities.
- **Local vs cloud:** identical allowlist and permission mode; cloud buys no capability
  (`modelSelection.js:29-31`; verified by `subagentModelSelection.test.cjs` #8, though that file currently
  fails on an Electron-mock hook, see §13).
- **Cancellation during a filesystem mutation:** not reachable for children (read-only). In the parent,
  aborting the promise does not undo an external side effect — the code acknowledges this
  (`agentLoop.js:355-357` records "outcome is unknown and it will not be replayed").
- **Destructive-operation safeguards:** parent-side `guardTool`/loop guard/circuit breaker remain in force
  (`engineManager.js:515-620`); children inherit none of them but cannot mutate.

---

## 13. Confirmed bugs with reproduction evidence

I reproduced the current suite and classified every failure. **The failure set is byte-for-byte the same
category set documented in the committed `docs/agentic-phase1-2-report.md` (40 failures)** — no new or
resolved failures.

### 13.1 Failure inventory (this run)

Command: `node --test --test-reporter=tap tests/*.test.cjs tests/*.test.mjs` →
**1066 tests, 1026 passed, 40 failed.**

Subagent-adjacent failures:

| ID | Test file | Test | Classification | Root cause |
|---|---|---|---|---|
| B-1 | `subagentModelSelection.test.cjs` | 13 tests (all) | **Environmental (outdated harness)** | `before` hook: `Cannot read properties of undefined (reading 'getPath')` — Electron app mock missing in `node --test`; `db.initDatabase` → `legacyDataMigration.repairLegacyAttachmentPaths` |
| B-2 | `childAgentLoop.test.cjs` | "a child finishes after one model response…" | **Outdated expectation** | Asserts `payload.stream === false` (line 50); provider now streams (`stream:true`) |
| B-3 | `childAgentLoop.test.cjs` | "spawn_sub_agent with investigate=true…" | **Outdated harness** | Mock HTTP server `JSON.parse(body)` on a GET probe body (line 460); also asserts `stream:false` (line 487) |
| B-4 | `backgroundExecution.test.cjs` | "background children keep the Step 4 context isolation…" | **Outdated expectation** | Same `stream:false` assertion (line 504) |

Other failures (not subagent-specific, pre-existing): `contextOverflowRecovery` (5),
`workspaceBriefBudget` (2), `mcpIpc` (2), and one each in `tokenUsage`, `subAgentRunner`,
`skillProposalIpc`, `skillImportIpc`, `rag`, `nativePermissions`, `messageStats`, `messageActions`,
`filesystemToolLimits`, `engineSettings`, `contextPanel`, `compactionBadge`, `cloudProviders`, `cloudIpc`,
`attachments`. Error signatures: 15× `app.getPath` undefined, 4× `CONTEXT_BUDGET_EXCEEDED`
("server-template-tokenizer input tokens; budget …"), 1× `event.sender.once is not a function`,
1× `Call initDatabase()…`, 1× `Unexpected end of JSON input`.

### 13.2 Genuinely subagent-relevant issues (source-confirmed, not suite failures)

| ID | Severity | Subsystem | Symptom | Root cause | Reproduction | Proposed phase |
|---|---|---|---|---|---|---|
| D-1 | High | Budgets | 150+ calls / 150+ requests impossible; 2 M tokens unreachable | hard caps in `budgetSettings.js` | set Custom to max → max is 100/100/1M/500K | 1.3 |
| D-2 | High | Timeouts | Stalled model hangs child indefinitely | `localEngineFetch.js:7` no deadline; no child deadline | no live-model needed; source | 1.3 |
| D-3 | High | Lifecycle | `partial` children cannot resume to finish | `IS_TERMINAL` includes `partial` (`sessionManager.js:38`) | source | 1.3/1.5 |
| D-4 | High | Persistence | Active/interrupted children lost on restart | in-memory only (`backgroundStore.js:18`) | source; restart | 1.4 |
| D-5 | Medium | Control surface | No UI/tool to message/interrupt/resume/cancel a child | exports not wired (`index.js` vs `ipcHandlers.js`) | `grep` shows no IPC | 1.3 |
| D-6 | Medium | Docs | `docs/subagents.md` states 10/8/40; code is 25/12/100 | docs stale | compare `budgets.js` to `subagents.md` | 1.3 |
| D-7 | Medium | Accounting | Local child usage often reserved/estimated, not measured | no `stream_options.include_usage` in child payload | source `agentLoop.js:236` | 1.5 |
| D-8 | Low | UI label | "Tool calls per parent run" counts only child dispatches | `executionBudget.js:147` | source | 1.3 |
| D-9 | Low | Compaction | No explicit "failed approaches" preservation field | checkpoint schema | source `compactionCore.js:3` | 1.4 |
| D-10 | Low | Tests | 16 subagent-adjacent tests fail (env/outdated) | see 13.1 | rerun | 1.5 |

No test in this audit demonstrated a *new* runtime defect; the failures are environmental or outdated
expectations, consistent with `docs/subagent-phase4.md`.

---

## 14. Test baseline and coverage gaps

**Executed (this audit):**

| Suite | Result |
|---|---|
| Full: `node --test tests/*.test.cjs tests/*.test.mjs` | 1066 tests, 1026 pass, **40 fail** (matches Phase 1.2 baseline) |
| `subagentCompaction.test.cjs` | 26 / 0 |
| `subagentReliability.test.cjs` | 23 / 0 |
| `subagentBudgets.test.cjs` | 14 / 0 |
| `subagentTranscript.test.cjs` | 14 / 0 |
| `subagentRetention.test.cjs` | 13 / 0 |
| `subagentSession.test.cjs` | 8 / 0 |
| `subagentStreaming.test.cjs` | 7 / 0 |
| `subagentRuntime.test.cjs` | 9 / 0 |
| `subagentDispatchConcurrency.test.mjs` | 11 / 0 |
| `subagentFailureDiagnostics.test.cjs` | 5 / 0 |
| `childMessaging.test.cjs` | 16 / 0 |
| `inferenceScheduler.test.cjs` | 13 / 0 |
| `spawnSubagent.test.cjs` | 5 / 0 |
| `childAgentLoop.test.cjs` | 14 / **2** (B-2, B-3) |
| `backgroundExecution.test.cjs` | 13 / **1** (B-4) |
| `subagentModelSelection.test.cjs` | 0 / **13** (B-1) |

**Not executed:** Electron UI suites (`subagentAcceptance.ui.cjs`, `subagentModal.ui.cjs`,
`subAgentBadge.ui.cjs`, `workspacePlan.ui.cjs`) require a display/Electron; no live-model benchmark was
run (prohibited).

**Coverage gaps that need an isolated harness:**
- No wall-clock deadline/timeout behaviour (feature absent).
- No restart/resume-of-child test (feature absent).
- No child-control IPC/UI test (feature absent).
- No explicit test that the caps block the 150+/2 M workload (arithmetic, §6).
- Live-model summary fidelity and threshold calibration — blocked by backend availability
  (`docs/subagent-phase4.md`).

---

## 15. Proposed reproducible benchmark

Deterministic, mock-model, temp-DB. **Not implemented here.** Each scenario specifies setup, mock
behaviour, workload, expected outcome, metrics, pass/fail, current runnability and target phase.

Common harness: `Module._load` electron stub + `db.initDatabase(mkdtemp)` (pattern from
`subagentCompaction.test.cjs:8-14`); a scripted `fetchImpl`; `saved.saveBudgetSettings(...)` to set Custom
budgets; assert on `session.accounting`, `session.status`, `stopReason`, request count.
**Estimated current runnability is given honestly.**

| Scenario | Setup / mock | Workload | Expected | Metrics | Pass/fail | Currently runnable | Target phase |
|---|---|---|---|---|---|---|---|
| A Simple delegation | script: one final answer | 1 request, 0 tools | `completed` | status, requests=1 | status completed, requests=1 | **Yes** | 1.3 |
| B 150+ tool calls | script: 150 tool-call rounds then answer; Custom calls=200 | ≥150 dispatches | continue to 150+ | `accounting.toolCalls`, turns | 150 executed | **No** — `maxToolCalls ≤ 100` | 1.3 |
| C 150+ model requests | script: 150 no-tool-then-answer turns; Custom turns=200 | ≥150 requests | continue | `accounting.turns` | 150 requests | **No** — `maxTurns ≤ 100` | 1.3 |
| D 2 M+ cumulative tokens | script: ~20 K input × 150 requests | ≥2 M input+output | continue | `ledgerTotals.inputTokens+outputTokens` | ≥2,000,000 | **No** — 1 M input cap | 1.3 |
| E Multiple compactions | large synthetic rounds crossing pressure twice | 2+ compaction events, early marker retained | continue | `compactionState.events.length`, marker present | ≥2 events, marker survives | **Partly Yes** — `subagentCompaction.test.cjs:88,219` covers it | 1.4 |
| F Cancellation/timeout | abort at request N / during tool | stops, no further dispatch | no post-abort request | dispatch counter after abort | zero post-abort | **Yes** for abort; **No** for timeout | 1.3 |
| G Nested delegation | attempted child spawn | rejected | tool error, no child | child count | 0 child children | **Yes** | 1.3 (decision) |
| H Failure reporting | exhaust budget / provider 500 / empty response | no false "completed" | `partial`/`failed` + reason | status, stopReason | never `completed` on exhaustion | **Yes** — `subagentReliability.test.cjs:125,193` | 1.5 |

Scenario D arithmetic (no live spend): with a 102 K window, one full prompt ≈ 102 K input tokens; 2 M
input ÷ 102 K ≈ 20 requests at *full* prompts, or 150 requests at ~13 K prompts — both exceed the 1 M
input cap. Demonstrates the blocker without spending tokens.

---

## 16. Comparison of bounded, unbounded, and renewable budgets

| Criterion | A Strict bounded | B Configurable / unbounded | C Progress-aware renewable |
|---|---|---|---|
| Reliability | Highest (no runaway) | Lower without other safeguards | High if renewals are gated |
| Complexity | Lowest (status quo) | Low (raise caps / add "unlimited") | Highest (extension API, persisted state) |
| Local-model compatibility | Good | Good | Good |
| Cloud cost control | Strong | Weak if unbounded | Strong (renewal needs authorisation) |
| Runaway prevention | Structural | Relies on kill switch/timeout | Budget + deadline + no-progress detector |
| Long-horizon capability | Poor (blocks 150+/2 M) | Excellent | Excellent |
| Compaction compatibility | Compaction competes with tight caps | Ample headroom | Needs ≥3 request slots/compaction (already guarded) |
| Nested delegation | N/A | N/A | Natural fit |
| Persistence | Not needed | Not needed | Requires durable counters/state |
| UX | Simple | Simple | Needs extension prompts/progress UI |
| Fit with Continuum | Already here | Small change to `budgetSettings`/validation | Reuses `subagent_runs`, `update_plan`, checkpoints |

**Recommendation: a combination of B (as the immediately shippable step) and C (as the durable
long-horizon design), explicitly not pure A and not naive unbounded.**

Rationale grounded in evidence: the enforcement machinery already exists and is correct
(`executionBudget.js`), so **raising/decoupling the numeric caps (B)** is a low-risk, high-value change
that directly addresses D-1. But unbounded per-child execution without a deadline is unsafe (D-2) and
unresumable (D-4), so **C adds**: an overall deadline + per-request timeout, a no-progress detector
(partly present via `no_progress`), a persisted child ledger, and an authorised "extend/resume" path that
reuses the durable Phase 1.1/1.2 stores (`workspace_plans`, checkpoints). Do **not** adopt unlimited by
default: keep Automatic conservative for cost control, make Custom genuinely large, and add an explicit
opt-in for renewable long-horizon runs.

---

## 17. Prioritized recommendations

1. **De-cap and correct enforcement (Phase 1.3).** Raise validation/UI maxima for `maxTurns`,
   `maxToolCalls` and `maxInputTokens`/`maxOutputTokens` to values that permit the target workload; add an
   explicit "unlimited (subject to deadline)" option rather than a low ceiling. Keep the per-request
   `max_tokens` ceiling. (D-1)
2. **Add timeouts/deadline (Phase 1.3).** A per-child wall-clock deadline and a per-model-request
   timeout, with a `timed_out` terminal state and precedence rules. (D-2)
3. **Make `partial` resumable, add durable child state (Phase 1.3/1.4).** Persist the child ledger +
   inbox + context pointer and allow an authorised resume/renewal (Option C), reusing `subagent_runs`
   and the Phase 1.1/1.2 durable stores. (D-3, D-4)
4. **Expose child control (Phase 1.3).** Wire `interrupt`/`resume`/`cancelBackground`/`sendMessage` to
   IPC/UI and/or a parent tool. (D-5)
5. **Reconcile docs and labels (Phase 1.3).** Update `docs/subagents.md` defaults and the "per parent run"
   label. (D-6, D-8)
6. **Harden completion reporting (Phase 1.5).** Reasoning-only/malformed/empty paths, local
   `include_usage`, and forbidden "completed on exhaustion". (D-7, D-9)
7. **Fix/replace the 16 subagent-adjacent failing tests and add the benchmark harness (Phase 1.5).**
   (B-1..B-4, D-10)

---

## 18. Revised Phases 1.3–1.5 implementation roadmap

> This is a plan; nothing below is implemented. Slices are ordered so each is independently verifiable.

### Phase 1.3 — Budgets, deadlines, termination (extend the existing system)

**1.3a — Configurable/de-capped budgets**
- Confirmed problem: caps 100/100/1 M/500 K block the target workload (D-1).
- Root cause: validation bounds in `budgetSettings.js:17-20,40-42` and `executionBudget.js:28-30,39-40`;
  UI maxima in `SubagentBudgetSettings.jsx:96-120`.
- Files/symbols: `budgetSettings.js` (`normalizeBudgetSettings`), `executionBudget.js`
  (`getExecutionBudget`), `SubagentBudgetSettings.jsx`, `budgets.js` (`resolveTaskBudgets`).
- Required behaviour: allow larger finite values and an explicit unlimited mode; keep per-request ceiling.
- Data contract: extend the `subagentBudgets` record (nullable, backward compatible). Persistence:
  new nullable fields in that JSON. Permissions: unchanged. Dependencies: none.
- Risks: runaway cost/loop → mitigated by 1.3b.
- Tests: extend `subagentBudgets.test.cjs` + benchmark B/C/D.
- Acceptance: a mocked child completes 150 tool calls and 150 requests and reports ≥2 M cumulative tokens.
- Rollback: revert validation bounds; old records still valid.

**1.3b — Deadlines and `timed_out`**
- Confirmed problem: no deadline; stalled model hangs (D-2).
- Root cause: `localEngineFetch.js:7` (`headersTimeout:0, bodyTimeout:0`); no per-child timer.
- Files: `localEngineFetch.js`, `inferenceScheduler.js` (`scheduleInference`), `agentLoop.js`,
  `sessionManager.js` (`SESSION_STATUS`, settlement), `contextBudget.js` (probe timeouts already exist).
- Required: per-child wall-clock deadline + per-request timeout, abort via the existing controller,
  new terminal state `timed_out`, precedence (whichever first), cleanup.
- Tests: benchmark F.
- Acceptance: a stalled provider aborts at the deadline with `timed_out`, no post-deadline requests.
- Rollback: disable by default via null deadline.

**1.3c — Child-control exposure + resumable `partial`**
- Confirmed problem: runtime API unexposed (D-5); `partial` terminal (D-3).
- Files/symbols: `index.js` exports, `ipcHandlers.js` (new `subagent:*` handlers), `preload.js`,
  `continuationManager.js` (`requireContinuable`, `IS_TERMINAL` handling), `sessionManager.js`.
- Required: IPC/UI (and optionally a parent tool) to message/interrupt/resume/cancel; allow resuming a
  `partial` child within remaining (or renewed) allowance; keep origin/model/allowlist.
- Persistence: reuse `subagent_runs`; add durable inbox/ledger only in 1.4.
- Tests: extend `childMessaging.test.cjs`, `subagentSession.test.cjs`, new IPC test.
- Acceptance: a partial child resumes and completes without replaying committed tools.
- Rollback: hide IPC/UI; runtime behaviour unchanged.

### Phase 1.4 — Child-context compaction and recovery (harden the existing system)

**1.4a — Compaction observability + tuning**
- Confirmed: compaction exists and is tested; thresholds (0.75/0.78) are unvalidated live.
- Files: `contextRecovery.js` (`prepare`), `compactionCore.js`, `compressionEngine.js`.
- Required: surface/threshold as configurable, record before/after pressure and method in the transcript.
- Tests: extend `subagentCompaction.test.cjs`; benchmark E.
- Acceptance: benchmark E produces ≥2 compaction events with early markers retained across all of them.

**1.4b — Durable child execution state / restart recovery**
- Confirmed problem: active/interrupted children lost on restart (D-4).
- Root cause: in-memory `sessions`/`records`/`backgroundStore` maps.
- Files: `sessionManager.js`, `continuationManager.js`, `backgroundStore.js`, `persistence.js`,
  `contextRecovery.js` (persist ledger + inbox + context pointer).
- Required: on startup, rehydrate interrupted/partial children as resumable (not auto-running), with
  ledger and context; reuse `workspace_plans`/checkpoints for objectives/verification.
- Data contract: extend `subagent_runs` columns/serialization; no parent-message coupling.
- Risks: schema migration, double-execution → version/hash guards like `contextRecovery.js:199-200`.
- Tests: new restart test (close/reopen SQLite, assert resumable).
- Acceptance: after restart, a previously interrupted child can be listed and explicitly resumed.
- Rollback: feature-flag; historical rows remain previews.

**1.4c — Failed-approach preservation (D-9, low priority)**
- Add explicit `failedApproaches`/`blockers` emphasis to the checkpoint schema and retention tests.

### Phase 1.5 — Completion and result reliability

**1.5a — Reasoning-only / malformed / empty hardening**
- Confirmed: bounded continuation + empty_response exist; a non-empty `length` answer becomes
  `incomplete_response` partial.
- Files: `agentLoop.js` (lines 306-320), `executionManager.js` (`extractAnswerText`, `describeCompletion`),
  `providers/streamCompletion.js`.
- Required: truthful completion classification, no placeholder success; preserve existing diagnostics.
- Tests: extend `subagentReliability.test.cjs`, `subagentFailureDiagnostics.test.cjs`.
- Acceptance: reasoning-only and truncated turns never report `completed`.

**1.5b — Local usage measurement (D-7)**
- Add `stream_options.include_usage` to the child payload so local children report measured usage;
  keep reserved fallback.
- Tests: extend `subagentStreaming.test.cjs`, `subagentBudgets.test.cjs`.

**1.5c — Test-baseline repair + benchmark harness (B-1..B-4, D-10)**
- Fix obsolete `stream:false` assertions / Electron mocks in `childAgentLoop`, `backgroundExecution`,
  `subagentModelSelection`; land the §15 harness as `tests/subagentBenchmark.*`.
- Acceptance: subagent suites green except genuinely unrelated failures; benchmark A–H documented.

---

## 19. Open questions requiring product decisions

1. **Uncapped vs renewable (Option B vs C):** should users be able to run children with no fixed
   per-child tool/request ceiling, and if so what global kill-switch (deadline, cost ceiling) must exist?
2. **Default policy after de-capping:** keep Automatic conservative (25/12) or raise it? The current
   numbers were chosen as a compatibility default with no live benchmark evidence.
3. **Resumable `partial`:** should a partially-complete child be resumable by default, and who authorises
   a renewal?
4. **Nested delegation:** should children be able to spawn (currently forbidden)? This changes budget
   attribution and cancellation propagation significantly.
5. **Deadline defaults:** what wall-clock and per-request timeouts suit long local prefill without
   truncating legitimate reasoning-heavy turns?
6. **Cloud cost control:** do renewable budgets need a separate cost accounting/limit for cloud children?
7. **`agentId`/child profiles:** should a child load distinct agent instructions, or stay on the fixed
   read-only investigation prompt?
8. **UI exposure scope:** which child-control actions (message/interrupt/resume/cancel, background
   spawn) should be user-visible vs parent-tool-driven?

---

## Mandatory summary tables

### A. Capability matrix

| Capability | Implemented | Verified | Partially working | Missing | Evidence |
|---|---|---|---|---|---|
| Foreground delegated investigation | ✔ | ✔ | | | `agentLoop.js:189`; `childAgentLoop.test.cjs` |
| One-shot file/web children | ✔ | ✔ | | | `executionManager.js:319,432` |
| Background children | ✔ | ✔ (runtime) | UI absent | | `index.js:278`; `backgroundExecution.test.cjs` |
| Child identity/parent link | ✔ | ✔ | | | `sessionManager.js:54` |
| Independent child context | ✔ | ✔ | | | `agentLoop.js:25-40` |
| Read-only allowlist + mode | ✔ | ✔ | | | `agentLoop.js:62-73,150` |
| Per-child budgets | ✔ | ✔ | | | `executionBudget.js` |
| Shared aggregate budget | ✔ | ✔ | | | `executionBudget.js:20,147` |
| Mid-run compaction | ✔ | ✔ | live tuning unverified | | `contextRecovery.js:83`; `subagentCompaction.test.cjs` |
| Checkpoint evidence preservation | ✔ | ✔ | semantic fidelity unverified | | `compactionCore.js:30` |
| Overflow compact-and-retry | ✔ | ✔ | | | `agentLoop.js:244-262` |
| Terminal statuses incl. partial | ✔ | ✔ | | | `sessionManager.js:23-38` |
| Child progress feed | ✔ | ✔ | stream-to-parent absent | | `sessionManager.js:225` |
| Usage accounting | ✔ | ✔ | local often reserved | | `budgets.js:148` |
| Durable transcript | ✔ | ✔ | preview only | | `persistence.js:102` |
| Child streaming + XML recovery | ✔ | ✔ | | | `streamCompletion.js` |
| Retention pruning | ✔ | ✔ | | | `continuationManager.js:454` |
| Execution deadline / timed_out | | | | ✔ | no source |
| Model-request timeout | | | | ✔ | `localEngineFetch.js:7` |
| Nested delegation | | | | ✔ (by design) | `agentLoop.js:62-73` |
| Restart recovery/resume | | | | ✔ | `backgroundStore.js:18` |
| User-facing child control | | | runtime only | | `index.js` exports unwired |
| Unlimited/high budgets | | | | ✔ | `budgetSettings.js:17-20` |
| >100 calls / >100 requests | | | | ✔ | caps |

### B. Defect inventory

| ID | Severity | Subsystem | Symptom | Root cause | Reproduction | Proposed phase |
|---|---|---|---|---|---|---|
| D-1 | High | Budgets | 150+/150+/2 M workloads impossible | hard caps `budgetSettings.js:17-20,40-42`, `executionBudget.js:28-30` | set Custom to max | 1.3 |
| D-2 | High | Timeouts | stalled model hangs child | `localEngineFetch.js:7`; no deadline | source | 1.3 |
| D-3 | High | Lifecycle | partial child not resumable | `IS_TERMINAL` incl. partial `sessionManager.js:38` | source | 1.3/1.5 |
| D-4 | High | Persistence | restart drops active/partial children | in-memory maps | source | 1.4 |
| D-5 | Medium | Control | no UI/tool to control children | exports unwired | grep IPC | 1.3 |
| D-6 | Medium | Docs | spec doc defaults (10/8/40) ≠ code (25/12/100) | stale `subagents.md` | compare | 1.3 |
| D-7 | Medium | Accounting | local usage reserved/estimated | no `include_usage` | `agentLoop.js:236` | 1.5 |
| D-8 | Low | UI | "per parent run" label counts only child dispatches | `executionBudget.js:147` | source | 1.3 |
| D-9 | Low | Compaction | no explicit failed-approach field | checkpoint schema | source | 1.4 |
| D-10 | Low | Tests | 16 subagent-adjacent failures | env/outdated expectations | rerun suite | 1.5 |
| B-1 | Low | Tests | subagentModelSelection 13 fails | Electron mock missing `getPath` | rerun | 1.5 |
| B-2/3/4 | Low | Tests | stream=false expectations | provider now streams | rerun | 1.5 |

### C. Long-horizon readiness

| Workload | Currently supported? | Blocking issue | Required change |
|---|---|---|---|
| 50+ tool calls | Only Custom (≤100) | Automatic 25 | raise Automatic / document Custom (1.3a) |
| 150+ tool calls | No | `maxToolCalls ≤ 100` | de-cap (1.3a) |
| 150+ model requests | No | `maxTurns ≤ 100` (+ report reserve) | de-cap (1.3a) |
| 2 M+ cumulative tokens | No | input ≤ 1 M (+ output ≤ 0.5 M) | de-cap / renewable (1.3a) |
| Multiple context compactions | Yes | competes with caps | keep caps above compaction overhead (1.3a/1.4a) |
| Parent cancellation | Yes (foreground) | child-level cancel unexposed | expose (1.3c) |
| Nested delegation | No | child allowlist | product decision (1.3) |
| Resume interrupted child | Runtime API only | not wired; not durable | expose + persist (1.3c/1.4b) |
| Reliable terminal reporting | Yes | local usage unmeasured | keep + include_usage (1.5b) |

### D. Recommended implementation order

| Priority | Phase | Scope | Dependencies | Acceptance gate |
|---|---|---|---|---|
| 1 | 1.3a | De-cap/adjustable budgets + unlimited opt-in | none | benchmark B/C/D pass |
| 2 | 1.3b | Child deadline + request timeout + `timed_out` | 1.3a | benchmark F passes |
| 3 | 1.3c | Expose child control; allow resuming `partial` | none | resume test passes |
| 4 | 1.4a | Compaction observability/tuning | 1.3a | benchmark E passes |
| 5 | 1.4b | Durable child ledger/inbox/context; restart resume | 1.3c | restart-resume test passes |
| 6 | 1.5a | Reasoning/malformed/empty hardening | none | no false `completed` |
| 7 | 1.5b | Local `include_usage` | none | measured-usage test passes |
| 8 | 1.5c | Test-baseline repair + benchmark harness | all | subagent suites green; harness documented |

---

## Evidence-quality classification (per finding)

- **Verified** (source + executed test): mid-run compaction, overflow retry, budgets/termination,
  concurrency isolation, cancellation of foreground children, read-only allowlist, terminal statuses,
  transcript persistence, streaming/XML recovery.
- **Confirmed source behaviour** (inspection, not dynamically exercised here): cap values, deadline
  absence, `partial` non-resumability, restart non-recovery, unexposed control APIs, doc/code conflict,
  local reserved-usage behaviour.
- **Suspected**: live summary fidelity, threshold calibration, late-event/terminal-race behaviour,
  cloud-vs-local accounting divergence in practice.
- **Not implemented**: deadlines/`timed_out`, nested delegation, restart recovery, unlimited budgets,
  user child control.
- **Undetermined**: exact live-model compaction behaviour (backend unavailable — prohibited to run),
  real provider usage adherence on the user's cloud providers.

## Conflicts between documentation and implementation

1. `docs/subagents.md:11-15,148` and `docs/subagent-phase3.md` state defaults 10 calls / 8 requests /
   40 aggregate; `budgets.js:38-46` and `SubagentBudgetSettings.jsx:90` now use 25 / 12 / 100.
2. Baseline/phase docs describe a simpler child recovery (`childContextRecovery`, leading-system +
   last-ten trimming); the implementation now uses the shared Workspace candidate engine + checkpoint
   adapter (`contextRecovery.js`, `subagents.md:93-137`). The older baseline text is superseded.
3. `docs/subagents.md:53` states partial children cannot be resumed "to evade limits" — consistent with
   code, but note it also prevents legitimate completion of partial work (open question).

---

## Tests executed and outcomes (audit summary)

- `node --test tests/*.test.cjs tests/*.test.mjs` → **1066 tests, 1026 pass, 40 fail** (identical
  category set to the committed `docs/agentic-phase1-2-report.md`).
- Focused subagent suite → **196 tests, 180 pass, 16 fail**, all environmental/outdated (B-1..B-4).
- Core subagent engineering suites all green: compaction 26/26, reliability 23/23, budgets 14/14,
  transcript 14/14, retention 13/13, session 8/8, streaming 7/7, runtime 9/9, dispatch-concurrency 11/11,
  failure-diagnostics 5/5, child-messaging 16/16, inference-scheduler 13/13, spawn 5/5.
- No live-model benchmark was run (prohibited); no application code, tests, config or data were modified.
