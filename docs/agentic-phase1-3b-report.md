# Continuum — Agentic Phase 1.3B Implementation Report

**Subagent execution deadlines, model-request timeouts, cancellation propagation, and a
deterministic terminal-state contract.**

- Date: 2026-10-18
- Reference brief: Phase 1.3B (timeouts, cancellation & termination safety).
- Prior work preserved: **Phase 1.3A** (long-horizon budgets, optional unbounded limits,
  expanded Automatic policy, child-model-aware context sizing, normalized token accounting).
- Scope implemented: **Phase 1.3B only.** No 1.3C, no budget renewal, no new compaction
  mechanism, no new child-orchestration UI.
- Working tree preserved. **No commits, pushes, stashes, resets or cleans.** No unrelated
  refactors. No global HTTP/timeout behavior changed. No token-budget policy changed.

---

## 0. Stop point

Implementation, deterministic tests, full-suite + build + Electron verification, and this
report are complete. **Phase 1.3C is not started.** Waiting for review.

---

## 1. Initial state and confirmed defects

Phase 1.3A left every child execution with **no wall-clock bound and no request bound**:
a stalled or extremely slow provider could hang a child indefinitely, and a parent
cancellation only reached a child through the forwarded `AbortSignal` of a *foreground*
spawn. The audit and code inspection confirmed:

1. **No execution deadline.** Nothing bounded a child's overall runtime. `budgets.js`
   bounded *work* (requests, tool calls, tokens) but not *time*.
2. **No model-request timeout.** `localEngineFetch` builds an undici `Agent` with
   `headersTimeout: 0, bodyTimeout: 0` (deliberately, for large/slow local models); a
   provider that accepted a connection and then never produced a byte would hang forever.
3. **Timeout was not a distinct terminal state.** The terminal vocabulary was
   `completed | partial | failed | cancelled | interrupted` (plus a `stopReason` string).
   A clock event had no status of its own and could be misreported as a cancellation
   (it rides the abort path) or as a generic failure.
4. **Late results could rewrite state.** Nothing prevented a straggling response, a second
   settlement, or a timeout/cancellation race from overwriting the first authoritative
   outcome on an attempt or session.
5. **Cancellation during compaction/tools had no "no new work" guarantee at the loop top.**
   A child could, in principle, schedule a further request after an abort that a compaction
   or tool batch returned late.

Phase 1.3A behavior was verified unchanged wherever 1.3B adds nothing (Automatic mode arms
no deadline and no request timeout).

---

## 2. Existing cancellation architecture (reuse, not replacement)

Cancellation is a first-class `AbortSignal` chain that was already present end to end and
is reused unchanged:

```
parent run signal
  └─ spawn_sub_agent (foreground) ── runtime.runInvestigation(signal)
        └─ forwardAbort(signal, controller)      // index.js
              └─ agentLoop.runInvestigationExecution(signal)
                    ├─ inferenceScheduler.submit({ signal })   // dequeue + provider abort
                    │     └─ provider.chatCompletion({ signal })
                    │           └─ fetch(url, { signal })  (undici / nodeHttpFetch)
                    ├─ executeChildTool({ signal })
                    │     └─ fs / child_process / fetch (signal-aware)
                    └─ contextRecovery.adapter.commit({ ... })  // compaction, signal-aware
```

Backend children (`startInBackground`) own their `AbortController`; `cancelBackground(id)`
and `interrupt(childId)` abort it. `signal.throwIfAborted()` is checked at every loop
boundary, and the scheduler refuses to start a request on an already-aborted signal and
dequeues a queued one. **1.3B adds a second, independent signal (the deadline) alongside
this run signal; it does not replace or repurpose it.**

---

## 3. Files and symbols changed

New file:

| File | Contents |
|---|---|
| `src/main/subagents/executionDeadline.js` | `DEADLINE_CODE` (`SUBAGENT_DEADLINE_EXCEEDED`), `REQUEST_TIMEOUT_CODE` (`SUBAGENT_REQUEST_TIMEOUT`), `TIMEOUT_REASONS`, `monotonicNow` (performance.now, hrtime fallback), `defaultTimers`, `deadlineError`/`requestTimeoutError`, `isDeadlineError`/`isRequestTimeoutError`/`isTimeoutError`/`timeoutReasonOf`, `combineSignals`, `createDeadline`, `createRequestTimeout`, and the parent-deadline registry `armExecutionDeadline`/`releaseExecutionDeadline`/`getExecutionDeadline`/`clearExecutionDeadlines`. |

Application code (symbols / behavior):

| File | Change |
|---|---|
| `budgetSettings.js` | Three new fields with finite bounds: `maxRuntimeMs` (1 000–604 800 000 ms), `requestTimeoutMs` (1 000–86 400 000 ms), `requestInactivityMs` (1 000–3 600 000 ms). Added to the `UNBOUNDED`/`LIMITS` contract and `normalizeBudgetSettings`. |
| `budgets.js` | `RUNTIME_DEFAULTS`/`RUNTIME_FIELDS`; `resolveRuntimeLimits(settings)` resolves the three time limits (all `null` under Automatic). `describeAutoPolicy().runtime` exposes them + the rule string for the UI. |
| `executionBudget.js` | `state.runtime = policy.resolveRuntimeLimits(saved)`; `outcome()` maps the timeout stop reasons to status `timed_out` with header `[Sub-agent timed out: …]`; `accounting.runtime` added; `reasonOf()` maps timeout codes via `timeoutReasonOf`. |
| `executionStore.js` | `EXECUTION_STATUS.TIMED_OUT`; `TERMINAL_EXECUTION_STATUSES`/`isSettled`; terminal guards on `completeExecution`/`failExecution`/`cancelExecution`/`interruptExecution` so a late settlement never overwrites a terminal attempt. |
| `sessionManager.js` | `SESSION_STATUS.TIMED_OUT`; added to `IS_TERMINAL`. |
| `inferenceScheduler.js` | Optional `requestTimeoutMs` argument (explicit wins over `budgetState.runtime.requestTimeoutMs`); `createRequestTimeout` guard + `Promise.race` against the generation; **when the guard fired, its error is re-thrown even if the transport rejected its own abort first**, so a timeout is never misread as a cancellation. Injectable `timers` seam. |
| `providers/localProvider.js`, `providers/cloudProvider.js` | Forward `inactivityMs: budgetState?.runtime?.requestInactivityMs` to `readCompletion`. |
| `providers/streamCompletion.js` | Streaming-only inactivity watchdog with injectable `timers`, armed before each `reader.read()` and disarmed on return (measures inter-chunk gaps, never total duration). |
| `agentLoop.js` | `deadline` + `timers` parameters; `activeSignal = combineSignals(signal, deadline?.signal) ?? signal`; deadline checks at the loop top, after a successful request, and in `catch`; timeout/request-timeout classification in `catch`; tool-batch `timed_out` classification. Raw `signal` stays the cancellation identity. |
| `executionManager.js` | `deadline`/`timers` for the one-shot file/web executions: `activeSignal` for reads and page fetch, deadline checks, timeout classification in `completeOneShot`. |
| `index.js` | `isCancellation` exempts timeout errors from the AbortError/`ABORT_ERR` cancellation shortcut (an aborted run signal still wins); `settleTimeout` safety net; arm/pass/release deadlines in `runInSession` and `startInBackground` (release in `finally`); a timeout that reaches the runtime is rethrown as a `resultError` carrying the timed-out output, not a bare abort. |
| `continuationManager.js` | Per-turn deadline armed/released in `drive`; timeout branch in `settleStoppedTurn`; `isCancellation` exemption; `timed_out` added to `isProtectedSession`. |
| `src/lib/subagentDisplay.mjs` | `TIMEOUT_REASONS` notice in `subagentLimitNotice`; `Timed-out findings` in `subagentResultTitle`. |
| `src/components/SubagentBudgetSettings.jsx` | Three new Custom fields ("Execution deadline (ms)", "Model request timeout (ms)", "Stream inactivity timeout (ms)") with the shared bounds + "No limit" sentinel; hint text. |

Tests:

| File | Change |
|---|---|
| `tests/subagentTimeouts.test.cjs` | **New** deterministic suite (22 tests) covering the brief's 21-scenario table (see §10). All timers/clocks injected; no real-time waits. |
| `tests/subagentDisplay.test.mjs` | Added timeout-notice and `Timed-out findings` title assertions. |
| `tests/subagentBudgets.test.cjs`, `tests/subagentLongHorizonBudgets.test.cjs` | Updated expected settings shapes for the three new keys. |

---

## 4. Deadline configuration and semantics

- **Fields.** `maxRuntimeMs` (execution deadline), `requestTimeoutMs` (whole request),
  `requestInactivityMs` (streamed inter-chunk stall). All milliseconds.
- **Automatic mode arms nothing.** `resolveRuntimeLimits` returns
  `{ maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null }` under
  `mode: 'auto'`, so the default behavior is unchanged and long-horizon work is never
  silently cut off. A finite Custom integer arms the limit; blank or `'unbounded'` clears
  it (no numeric ceiling).
- **Backend-enforced.** The parser bounds the values, and enforcement happens in the
  runtime, the loop, the scheduler and `readCompletion` — never only in the UI.
- **Monotonic clock.** `createDeadline` measures elapsed time with `performance.now()`
  (hrtime fallback); timers are injectable so tests drive expiry without sleeping.
- **Whole-run coverage.** The deadline is armed once per child run (first turn *and* each
  continuation turn) and its signal is combined into `activeSignal` for model requests,
  tool calls and compaction. No new work starts after expiry: the loop checks at the top,
  after a request, and in `catch`, and the scheduler refuses to start on an aborted signal.
- **Cleanup reliable.** Armed before work and released in a `finally`
  (`releaseExecutionDeadline(session.id)`), on foreground, background and continuation paths.
- **Nested delegation cannot extend a parent deadline.** `armExecutionDeadline` looks up the
  parent session's live deadline and the child deadline fires at
  `min(own, parentRemaining)`; a descendant can never outlive the deadline it inherited.
- **Timeout is never success.** A fitted deadline yields `outcome: 'timed_out'`; it is never
  folded into `completed`.
- **No-deadline mode is allowed and cancellation stays available.** With all three limits
  null, `createDeadline` returns `null` (no timer, no allocation) and the run signal,
  `cancelBackground`, `interrupt` and direct child cancellation remain fully functional.

**Error identity.** The deadline aborts with `name: 'AbortError'`,
`code: 'SUBAGENT_DEADLINE_EXCEEDED'` so it rides `signal.throwIfAborted()` and the
transports' abort paths exactly like a cancellation, but the code lets the loop convert it
to a result before settlement. The request timeout is a plain `Error`
(`code: 'SUBAGENT_REQUEST_TIMEOUT'`, `timeoutKind: 'total' | 'inactivity'`) so it is never
mistaken for a stop.

---

## 5. Model-request timeout behavior

- **Configurable, local and cloud.** `inferenceScheduler.scheduleInference` is the single
  choke point and already has `budgetState`; the effective timeout is an explicit argument
  or `budgetState.runtime.requestTimeoutMs`, resolved per child. Both provider adapters
  route through the scheduler.
- **Effective request deadline ≤ remaining child deadline.** The request signal always also
  carries the caller's signal, which for a child turn already includes the execution
  deadline, so the request can never outlive the remaining child deadline.
- **Cancellation propagates.** The guard's `signal` is `combineSignals(runSignal, timeoutSignal)`,
  forwarded unchanged through the providers to `fetch`, which aborts the in-flight transport.
- **Stalled streams.** The inactivity watchdog in `readCompletion` is armed before each read
  and disarmed when it returns, so it measures the gap *between chunks*, not total request
  time. A large or slow-but-progressing local model is never cut off. A single-JSON response
  is unaffected — the scheduler's total-duration timeout covers it.
- **Inactivity vs total duration.** Both are supported and distinguishable via
  `error.timeoutKind`. `requestInactivityMs` (streaming) is separate from
  `requestTimeoutMs` (whole request).
- **Deterministic settlement even if a transport ignores abort.** The scheduler races the
  generation against the guard timeout; **if the guard fired, the timeout error is the
  authoritative result even when the transport rejects its own generic abort first**. So a
  transport that does not honor `AbortSignal` still cannot hang the child, and the outcome
  is `request_timeout`, not a cancellation and not a success.
- **Global HTTP behavior unchanged.** `localEngineFetch`'s `Agent({ headersTimeout: 0,
  bodyTimeout: 0 })` is untouched; unrelated application-wide timeouts are untouched. The
  request timeout is per-child, opt-in, and enforced by racing the generation, not by
  editing the shared agent.

---

## 6. Parent-child cancellation propagation

| Source | Mechanical path | 1.3B status |
|---|---|---|
| Parent run cancels (foreground delegation) | parent signal → `forwardAbort` → child controller → `activeSignal` → scheduler/provider/tools/compaction | Works; verified (test 7). |
| Direct child `cancelBackground(executionId)` | stored controller aborts; scheduler dequeues/aborts; loop `throwIfAborted` | Works; idempotent; verified (tests 8/16, 15, 17). |
| `interrupt(childId)` (safe boundary, resumable) | controller aborts as interrupt | Unchanged behavior; `isCancellation` true via aborted signal. |
| Cancellation during inference | scheduler refuses to start on aborted signal; aborts the active transport | Verified (tests 5, 6, 10). |
| Cancellation during tools | loop stops before the next request; tool batch marked `cancelled`; no replay | Verified (test 11). |
| Cancellation during compaction | `commit` rejects on an aborted signal; scheduler refuses anyway | Verified (test 10). |
| Nested delegation / descendants | child inherits the parent deadline (registry) and the parent signal is forwarded into any nested runtime call | Bounded; verified at the runtime-API level (test 9). |

**Isolation.** Cancelling one child never terminates a sibling or an unrelated session: the
controllers, sessions, executions and deadline registry entries are per-run. This is asserted
directly (tests 8/16) and unchanged from Phase 1.3A.

**Cancellation is idempotent.** `cancelExecution`/`cancelSession` are guarded by the terminal
sets, so a second cancel or a cancel racing a completion is a no-op (test 15).

---

## 7. Terminal-result contract

Existing vocabulary is preserved and one status is introduced:

| Outcome | Status | Notes |
|---|---|---|
| Completed | `completed` | success |
| Failed | `failed` | no usable findings |
| Cancelled | `cancelled` | explicit user/parent action (session + attempt) |
| Interrupted | `interrupted` | deliberate stop at a safe boundary; child stays resumable |
| **Timed out** | **`timed_out`** (new) | execution deadline *or* request timeout; terminal; never success |
| Budget exhausted | `stopReason` (`tool_limit`, `turn_limit`, `output_budget`, …) | carried on the result; status is `partial` when findings exist, else `failed` |
| Partial / incomplete | `partial` | terminated with preserved findings |

**Partial is an attribute of a terminated result, not a separate lifecycle.** It is derived
(any stop reason with findings, other than `completed`) exactly as before. Budget exhaustion
remains a `stopReason` on `partial`/`failed`; only clock events introduce the new status.

- **One authoritative outcome.** `outcome()` in `executionBudget.js` computes the single
  status from `stopReason`; the runtime writes it to the attempt and the session once.
- **`timed_out` reaches the UI.** `subagentResultTitle('timed_out') === 'Timed-out findings'`;
  `subagentLimitNotice` explains the elapsed deadline / request timeout and points at
  Settings. Both `timed_out` and `request_timeout` map to status `timed_out`.
- **Findings and diagnostics preserved.** A timeout uses `finish('', reason, findings().length > 0, …)`,
  so already-gathered tool evidence is retained. The `accounting` block, including
  `accounting.runtime`, is reported.
- **Never fabricates success.** A clock event cannot produce `completed`, and the model's late
  answer text is never accepted as the output (tests 3/14, 13).

---

## 8. Race-condition handling (deterministic precedence)

Precedence is fixed and tested:

> **explicit cancellation / interrupt (run signal aborted) > child execution deadline >
> model-request timeout > any concurrent non-timeout error.**

- **Cancellation vs completion / timeout.** `isCancellation` returns true if and only if the
  *run* signal is aborted; deadline and request-timeout errors are explicitly exempt, so a
  clock event is never recorded as a user action even though it rides the abort path.
- **Deadline vs model response.** A deadline that elapses while a request is in flight wins:
  the loop discards the response (including one from a transport that ignored the abort) and
  returns `timed_out`. A completion *before* the deadline is retained and cannot be rewritten
  by a later clock event (test 13).
- **Request timeout vs child deadline.** If the guard fired, the request timeout is the
  authoritative error; the deadline remains higher precedence and is checked first in `catch`.
- **Budget exhaustion vs cancellation.** The run-signal check runs before any budget
  classification, so a cancellation wins; otherwise the exhaustion stop reason is used.
- **Late streamed events / tool completion after termination.** Terminal guards on the
  execution store and session manager make every later settlement a no-op; a tool that
  returns after termination is marked skipped and never replayed.
- **Late settlement after a terminal status.** `isSettled` guards `complete`/`fail`/`cancel`/
  `interrupt`, so a second close never overwrites the first authoritative outcome (test 15).

---

## 9. Provider compatibility and limitations

- **Local (llama.cpp / OpenAI-compatible).** `localEngineFetch` honors `AbortSignal`; the
  deadline and request timeout abort the in-flight request. Streaming inactivity uses
  `readCompletion`. Large/slow models are safe: the inactivity watchdog only fires on a
  *gap*, and Automatic arms no timeout at all.
- **Cloud (OpenAI-compatible and Anthropic).** The cloud adapter honors `AbortSignal` through
  `nodeHttpFetch`; Anthropic responses are normalized before accounting, so timeouts surface
  uniformly. Cloud providers build their own transport, so tests inject it via
  `cloudProviders.createCloudFetch`.
- **Transports that ignore abort.** None of the app's transports ignore `AbortSignal`, but the
  scheduler does not *rely* on that: the timeout race guarantees deterministic settlement and
  reports `request_timeout`. There is no per-provider "cancellation unsupported" capability
  flag to advertise (see §13).
- **Compaction and streaming infrastructure is untouched.** The compaction algorithm, the
  provider lanes and the scheduler's FIFO/capacity logic are unchanged; only opt-in guards
  were added.

---

## 10. Unit and integration test results

`tests/subagentTimeouts.test.cjs` — **22 tests, all pass**, deterministic (injected
timers/clocks), mocked providers, no paid calls. Coverage of the brief's table:

| # | Scenario | Test |
|---|---|---|
| 1 | Normal short child | 1 (completed, no deadline under Automatic) |
| 2 | Long child within deadline | 2 (every turn runs, completes) |
| 3 | Child deadline expires | 3/14 (`timed_out`, late response ignored) |
| 4 | Model request stalls | 4/19 (`request_timeout`), + request-timeout unit test |
| 5 | Local request cancellation | 5 (abort reaches the transport signal) |
| 6 | Cloud request cancellation | 6 (abort through the cloud transport) |
| 7 | Parent cancelled | 7 (owned child cancelled) |
| 8 | Direct child cancellation | 8/16 (correct child stops) |
| 9 | Nested delegation | 9 (descendant clamped to parent deadline) |
| 10 | Cancellation during compaction | 10 (no continuation, no request) |
| 11 | Cancellation during tools | 11 (no further model request) |
| 12 | Timeout during streamed response | 12 (inactivity watchdog) |
| 13 | Completion just before deadline | 13 (success retained) |
| 14 | Late response after timeout | 3/14 (ignored) |
| 15 | Repeated cancellation | 15 (idempotent) |
| 16 | Multiple concurrent children | 8/16 (isolation) |
| 17 | Unbounded child | 17 (still cancellable) |
| 18 | Different cloud model | 18 (routed through cloud transport) |
| 19 | Local model timeout behavior | 4/19 |
| 20 | Existing compaction | 20 (no regression) |
| 21 | Existing budgets/permissions | 21 (unchanged; time limits independent) |

Plus structural tests: timeout error identities vs cancellation; `executionBudget` mapping
of timeout errors to the `timed_out` status; and one-shot file analysis honoring the deadline.

Focused suites re-run green apart from the pre-existing failures: subagent budgets,
long-horizon budgets, model budgets, reliability, compaction, session, runtime, background
execution, retention, transcript, streaming, model selection, dispatch concurrency, child
messaging, inference scheduler, display, failure diagnostics (217 + 56 tests; only the
baseline failures remain).

---

## 11. Comparison against the previous baseline

| Run | Tests | Passed | Failed |
|---|---|---|---|
| Baseline (start of 1.3B) | 1,090 | 1,063 | 27 |
| After 1.3B | **1,113** | **1,086** | **27** |
| Delta | **+23** | **+23** | **0** |

- The **failure set is byte-for-byte identical** to the baseline (diffed by test name):
  27 pre-existing failures, none introduced by 1.3B.
- The 23 added tests are the new 1.3B timeout suite plus display assertions; every added test
  passes.
- Pre-existing failures are unrelated to this phase (UI/preload/compaction/skill/RAG/MCP and
  two known subagent fixtures: "a child finishes after one model response…" and
  "spawn_sub_agent with investigate=true…"). They were failing before 1.3B and are unchanged.

---

## 12. Regression and build results

- **Production build:** `npm run build` succeeds (1,809 modules transformed; `dist/` emitted).
- **Electron integration (real preload/IPC/SQLite + child runtime):**
  `tests/subagentAcceptance.ui.cjs` **PASS** — Settings persistence/remount, mode fallback,
  invalid-value rejection, and the completed/partial/failed/cancelled transcripts all
  validated; the intentional invalid-value rejection is logged and expected. The three new
  time-limit fields persist and round-trip with the existing fields.
- **Phase 1.1/1.2 suites, cancellation and streaming suites:** unchanged and green apart from
  the same baseline failures.

---

## 13. Remaining limitations

- **Best-effort, not guaranteed, process termination.** Cancellation and deadlines abort the
  in-flight *requests/tools* that honor `AbortSignal`. An OS operation already dispatched to a
  subprocess (e.g. a running shell command) keeps running until it exits or its own timeout
  fires; a network read on a transport that ignored abort is *logically* terminated (the child
  settles deterministically) but the underlying socket may drain in the background. **No claim
  of guaranteed process termination is made.**
- **No transport capability flag.** There is no per-provider "does not support reliable
  cancellation" advertisement; the request-timeout race is the guarantee instead. A future
  phase could add such a capability and surface a warning.
- **Inactivity timeout is streaming-only.** A single-JSON provider response is bounded by the
  total-duration request timeout; it has no separate inactivity signal.
- **One authoritative status per attempt/session, not per nested descendant.** A nested
  descendant's own terminal outcome is recorded on its own session; the registry only bounds
  its deadline.
- **Nested delegation is not reachable through the child tool allowlist.** The parent-deadline
  inheritance is exercised at the runtime-API level today; it is ready for a future
  nested-spawn capability.

---

## 14. Recommended next steps for Phase 1.3C

1. **Durable/renewable budgets** (the explicit 1.3C target): persist and renew long-horizon
   allowances across restarts without reintroducing a hidden short wall-clock cap.
2. **Surface a transport-cancellation capability** and a user-visible warning when a provider
   cannot honor abort, so "logically terminated" is distinguishable from "process stopped".
3. **Subprocess cancellation hardening** for dispatched shell operations (tree-kill / sandbox
   teardown) so best-effort becomes closer to guaranteed for that class.
4. **Nested delegation exposure** (if/when the allowlist permits it), now that deadlines and
   cancellation already propagate through the registry and signal chain.
5. **Telemetry for timeouts** (counts by reason and `timeoutKind`) to tune the Automatic
   posture without adding a short default.

---

## Appendix — exact resolution and mapping

```
Automatic (mode: 'auto')  -> { maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null }
Custom finite integer     -> that value (armored by the parser within LIMITS)
Custom blank / 'unbounded'-> null (no numeric ceiling)

stopReason 'timed_out'        -> status 'timed_out'   (execution deadline)
stopReason 'request_timeout'  -> status 'timed_out'   (single request)
budget stop reasons           -> status 'partial' (findings) | 'failed' (none)

error: SUBAGENT_DEADLINE_EXCEEDED  (AbortError)     -> timed_out
error: SUBAGENT_REQUEST_TIMEOUT    (Error, kind)    -> request_timeout
run signal aborted                                  -> cancelled / interrupted (wins over both)
```
