# Continuum — Agentic Phase 1.3C Implementation Report

**Durable subagent continuation, renewable execution budgets, and accurate cumulative
accounting.**

- Date: 2026-10-18
- Reference brief: Phase 1.3C (durable continuation and renewable budgets).
- Prior work preserved: **Phase 1.1** (`run_tests`), **Phase 1.2** (durable plans),
  **Phase 1.3A** (long-horizon budgets, unbounded limits), **Phase 1.3B** (deadlines,
  request timeouts, cancellation propagation, terminal-state contract).
- Scope implemented: **Phase 1.3C only.** No Phase 1.4/1.5 work, no compaction redesign,
  no child-management UI, no daemon/server/cloud infrastructure.
- Working tree preserved. **No commits, pushes, stashes, resets, or cleans.** All changes
  are uncommitted working-tree modifications plus two new files.

---

## 1. Stop point and scope

Implementation, deterministic tests, full-suite verification, production build, and the
Electron acceptance test are complete, and this report is written. **Phase 1.4 is not
started.** Waiting for review.

In scope: an explicit, authorized, renewable and durable continuation path for a child
that stopped because a *configured allowance* ran out; a read-only control surface; durable
persistence of the continuation verdict; and restart recovery that rebuilds a child
without executing it. Out of scope: any new child runner, any change to the continuation
mechanisms added in 1.3B (`sendMessage`/`interrupt`/`resume`/driver), and any UI.

---

## 2. Initial state and confirmed defects

Phase 1.3A/1.3B left three gaps that the audit (`docs/subagent-system-comprehensive-audit.md`)
called out:

1. **A budget stop was terminal.** A child that hit `tool_limit`, `turn_limit`,
   `input_budget`, or `output_budget` settled `partial`/`failed` and there was no supported
   way to continue it. `requireContinuable` rejected every terminal status.
2. **No renewal.** Budget totals were write-once at spawn; `maxToolCalls`/`maxTurns`
   ambiguously meant both an original ceiling and a per-attempt counter, and there was no
   way to distinguish "original allowance", "granted", "consumed", and "remaining".
3. **No durability.** The live session, its context, and its budget state were in-memory
   only; nothing survived a restart, and no persisted verdict existed to say whether a
   child *could* continue.

Confirmed by inspection: `continuationManager.requireContinuable` (sessionManager status
gates), `executionBudget.getExecutionBudget` (no renewal, no `original`), and
`persistence.persistChildRun` (no budget/continuation columns).

---

## 3. Design principles (reuse, never a second runner)

- **One decision, one module.** `src/main/subagents/continuationState.js` is a new *pure*
  module (no I/O, no runtime maps) that owns eligibility, allowance summarization, and
  durable serialization. The control surface and the persistence layer share this one
  definition, so the rules cannot drift or be bypassed.
- **Reuse the existing machinery.** Continuation re-uses the 1.3B driver (`drive`), the
  agent loop, the inference scheduler, compaction, the deadline arming, and the
  permission allowlist unchanged. `continueChild` enqueues work and wakes the *same*
  driver; it never starts a second runner.
- **Explicit and authorized.** Every mutating call requires the owning
  `parentSessionId`; a renewal is only applied when a caller explicitly supplies it.
- **Truthful durability.** A child is advertised resumable only after a successful write.

---

## 4. Continuation eligibility model

The single decision function is `continuationState.evaluateContinuation(session,
{ pendingContinuation })`. It returns a machine-readable class plus human detail:

| Status / shape | Class | Notes |
| --- | --- | --- |
| `partial`/`failed` with `tool_limit`, `turn_limit`, `input_budget`, `output_budget` | `needs_renewal` | the central renewable case |
| `partial`/`failed` with a non-renewable reason (`aggregate_tool_limit`, `context_exhausted`, `compaction_failed`, `provider_budget_violation`, `provider_error`, `runtime_error`, `malformed_response`, `empty_response`, `no_progress`) | `not_eligible` | `not_renewable:<reason>` |
| `partial` with no budget reason | `needs_explicit_action` | continues without a renewal |
| `failed` with no recognized reason | `not_eligible` | `uncertain_failure` — never replayed |
| `interrupted` | `needs_explicit_action` | existing explicit-resume semantics |
| `timed_out` | `needs_explicit_action` | requires `allowTimedOut` |
| `cancelled` | `needs_explicit_action` | requires `allowCancelled` |
| `completed` (no pending work) | `not_eligible` | `already_completed` |
| `completed` with inbox/pending turn | `needs_explicit_action` | drains queued work |
| `created`/`waiting`/`running` | `not_eligible` | `in_progress` |
| any status with an **unsafe transcript boundary** | `not_eligible` | `recovery_required` |

The boundary check (`isSafeBoundary`) independently verifies that every assistant
`tool_calls` batch has matching tool results and that the history never ends on an
unanswered assistant tool call. An unsafe prefix means an external side effect may be in
flight; such a child is marked recovery-required and refused automatic continuation even
when its status/stop reason would otherwise be eligible.

---

## 5. Renewable budget semantics

`executionBudget.renewBudget(state, patch, { reason, source, parentSessionId })`:

- `patch` carries **new absolute totals** per field (`maxTurns`, `maxToolCalls`,
  `inputBudget`, `outputBudget`) — never an addition the caller must compute.
- A finite value must be a safe integer `>=` the current total and within the configured
  bounds. Below-current is refused; equal is a no-op with no renewal record.
- The explicit `'unbounded'` sentinel is the only way a finite budget becomes unbounded,
  and it must be requested. An already-unbounded field cannot be re-capped.
- **Consumption is never reset:** `toolCalls`, `ledger`, and `usage` are untouched.
- **The shared aggregate is never modified.** For `maxToolCalls`, a renewal may not grant
  more than the parent run's remaining aggregate allowance
  (`scope.maxToolCalls - scope.toolCalls`); otherwise it throws.
- Every applied field appends an auditable record
  `{ at, field, previous, granted, total, reason, source, parentSessionId }`.

---

## 6. Cumulative accounting

`executionBudget.getExecutionBudget` now snapshots `state.original` at creation and starts
an append-only `state.renewals`. `continuationState.summarizeAllowance(state)` exposes the
full breakdown, re-used by `outcome().accounting.allowance` and `continuationStatus`:

```
original   { maxTurns, maxToolCalls, inputBudget, outputBudget }
granted    { ... }        // current - original (null for unbounded)
current    { ... }        // live totals
consumed   { turns, toolCalls, inputTokens, outputTokens, aggregateToolCalls }
remaining  { ... }        // current - consumed (null when unbounded)
aggregate  { limit, consumed }
renewals   [ ... ]        // append-only history
```

`maxToolCalls` therefore never ambiguously means both an original ceiling and a reset
per-attempt counter: the original, granted, current, consumed and remaining values are
always distinct.

---

## 7. Durable persistence and the false-resumable refusal

`persistence.persistChildRun` computes the continuation verdict **before** the write and
only advertises resumability after it succeeds:

- On success, `session.continuation = { ...verdict, persisted: true, resumable: eligible }`
  and `session.durableResumable = eligible`.
- On failure, `session.durableResumable = false` and `session.continuation.persisted =
  false` — a write that did not happen can never look resumable.
- A child is never reported resumable on the strength of a stated-but-unwritten verdict.

New columns (with `ALTER TABLE` migration for existing databases): `budget_json`,
`continuation_json`, `attempt_count`.

---

## 8. Restart recovery (rebuild, never execute)

`recoverChild(childId, { parentSessionId, engine, verifyOwner })` rebuilds a child from
durable state into the in-memory runtime and **never starts execution**:

- Refuses when the stored routing identity (kind/engine) is missing or is not
  `investigation`, and when the requested owner does not match the stored parent.
- With `verifyOwner`, also refuses when the owning session row is gone.
- `sessionManager.rehydrateSession` re-inserts the child in its truthful stopped state; a
  child that was mid-flight when the process died (`created`/`waiting`/`running`) is
  marked `interrupted` via `recoveryStatus`, never silently resumed.
- `listRecoverableChildren({ parentSessionId })` lists durable children that are not
  currently live. Listing starts nothing.

`continuationState.deserializeBudgetState` rebuilds the live ledger; per-child consumption,
allowance and renewal history are preserved verbatim. Aggregate counters restart with the
new process (documented limitation in §17).

---

## 9. Control surface, IPC, and preload contract

New runtime exports (`src/main/subagents/index.js`): `continuationStatus`,
`renewChildBudget`, `continueChild`, `listRecoverableChildren`, `recoverChild`.

IPC handlers and preload methods (minimal contract; Phase 1.5 will build UI on it):

| IPC channel | preload method | mutating |
| --- | --- | --- |
| `subagent:describe` | `describeChild` | no |
| `subagent:continuation-status` | `getContinuationStatus` | no |
| `subagent:renew-budget` | `renewChildBudget` | yes (owner) |
| `subagent:continue` | `continueChild` | yes (owner) |
| `subagent:list-recoverable` | `listRecoverableChildren` | no |
| `subagent:recover` | `recoverChild` | yes (owner + `verifyOwner`) |

`continueChild` returns a structured result and never throws for an ineligible child
(authorization errors still throw). It applies the renewal (when the verdict requires
one), enqueues exactly one continuation instruction (or re-drives an interrupted turn), and
wakes the existing driver.

---

## 10. Supported vs unsupported continuation (explicit statement)

**Supported continuation**

- A `partial`/`failed` child that stopped at a configured budget
  (`tool_limit`/`turn_limit`/`input_budget`/`output_budget`) **may** be continued by the
  owning parent via `continueChild` with an explicit renewal.
- An `interrupted` child **may** be resumed explicitly (existing behavior).
- A `cancelled` or `timed_out` child **may** be continued only with explicit
  `allowCancelled` / `allowTimedOut`.
- A `partial` child with no budget reason **may** be continued without a renewal.
- A `completed` child with queued work **may** drain its inbox.
- Every continuation reuses the same session, context, model, provider, permission
  allowlist, deadline logic, and driver.

**Unsupported continuation**

- A child that stopped for a **non-renewable** reason (aggregate limit, context
  exhaustion, compaction failure, provider budget violation, provider/runtime error,
  malformed/empty response, no progress) is **not** continued.
- A `failed` child with an **uncertain** side-effect status is **not** replayed.
- A `completed` child with no pending work, or an in-progress child, is **not** continued.
- A child whose **transcript is not at a protocol-safe boundary** is
  `recovery_required` and is **not** continued automatically.
- A renewal **never** resets consumption, **never** modifies the parent aggregate, and is
  **never** applied without an explicit owning-parent request. A tool-call renewal can
  **never** grant more than the parent aggregate's remaining allowance.
- Restart recovery **never** auto-executes; continuation after a restart is always an
  explicit owning-parent action.

---

## 11. Files and symbols changed

| File | Change |
| --- | --- |
| `src/main/subagents/continuationState.js` | **new** pure module: eligibility, boundary safety, allowance summary, budget/continuation (de)serialization |
| `src/main/subagents/executionBudget.js` | `original`/`renewals` on the state; `renewBudget`; `RENEWABLE_FIELDS`; allowance in `outcome()` |
| `src/main/subagents/sessionManager.js` | new session fields; `prepareContinuation`, `CAN_CONTINUE`, `rehydrateSession`, `recoveryStatus` |
| `src/main/subagents/continuationManager.js` | control surface: `continuationStatus`, `renewChildBudget`, `continueChild`, `listRecoverableChildren`, `recoverChild`, `ownerSessionExists` |
| `src/main/subagents/persistence.js` | persist `budget_json`/`continuation_json`/`attempt_count`; durable-resumable semantics; `readPersistedContinuation` |
| `src/main/db.js` | 3 new `subagent_runs` columns + `ALTER TABLE` migration |
| `src/main/subagents/index.js` | runtime exports |
| `src/main/ipcHandlers.js`, `src/preload.js` | minimal IPC/preload wiring |
| `tests/subagentContinuation.test.cjs` | **new** deterministic suite (34 tests) |

`node --check` passes on every modified/new JavaScript file.

---

## 12. Test coverage (26 required scenarios + 2 preservation checks)

`tests/subagentContinuation.test.cjs` — **34/34 pass** (`node --test`), deterministic and
model-free except for two scripted end-to-end cases.

| # | Scenario | Test(s) |
| --- | --- | --- |
| 1 | Budget exhaustion types (`tool`/`turn`/`input`/`output`) → `needs_renewal` | 1, 33 |
| 2 | Non-budget `partial` → explicit action, continues without renewal | 2, 26 |
| 3 | Uncertain failure is not eligible | 2 |
| 4 | Non-renewable stop reasons refused | 3 |
| 5 | `interrupted` needs explicit resume | 4 |
| 6 | `cancelled` needs explicit action (`allowCancelled`) | 4, 22 |
| 7 | `timed_out` needs explicit action (`allowTimedOut`) | 4, 22 |
| 8 | `completed` is not resumable | 5, 21 |
| 9 | In-progress statuses are not continuation targets | 6 |
| 10 | Transcript boundary safety verified independently | 7 |
| 11 | Unsafe boundary → `recovery_required`, refused | 8, 25 |
| 12 | Renewal raises only named totals, monotonic, no-op on equal | 9, 10 |
| 13 | Renewal never resets consumption/usage | 11 |
| 14 | Renewal validation (unknown field, out-of-range) | 12 |
| 15 | Unbounded sentinel; finite cannot be re-capped | 13 |
| 16 | Aggregate bypass refusal (renewal ≤ parent remaining) | 14, 34 |
| 17 | Allowance accounting (original/granted/current/consumed/remaining) | 15 |
| 18 | Read-only status snapshot mutates nothing | 16 |
| 19 | `continueChild` requires a renewal when needed | 17 |
| 20 | Continuation drives the same child/context/model; no duplicate tool calls | 18, 19, 33 |
| 21 | Consecutive renewals accumulate history, keep consumption continuous | 20 |
| 22 | Ownership enforced on inspect/renew/continue/recover | 23, 30 |
| 23 | Concurrent isolation: renewing one child never touches another or the aggregate | 24 |
| 24 | Durable resumability advertised only after a successful write | 27 |
| 25 | Persistence failure → false-resumable, never advertised | 28 |
| 26 | Restart recovery rebuilds a stopped child without executing; ownership/owner checks | 29, 30 |
| 27 | Late-term settlement cannot overwrite a stopped child | 31 |
| 28 | Existing model / deadline / permission scope intact across continuation | 32, 18 |

---

## 13. Regression, build, and Electron acceptance results

- **Baseline reproduced before changes:** `node --test --test-reporter=tap tests/*.test.cjs
  tests/*.test.mjs` → 1113 tests, 1086 pass, **27 fail** (saved at
  `/tmp/opencode/baseline.txt`).
- **After changes:** 1147 tests, 1120 pass, **27 fail** — the 34 new tests all pass, and
  the failing set is **identical** to baseline (diffed by failing-test identity; 27 known,
  unrelated pre-existing failures).
- **Focused subagent suites:** `tests/subagent*.test.cjs` + `tests/childMessaging.test.cjs`
  → **228/228 pass**.
- **Production build:** `npm run build` → succeeded.
- **Electron acceptance:** `tests/subagentAcceptance.ui.cjs` → **PASS**, exit 0.

---

## 14. Preservation of Phases 1.1 / 1.2 / 1.3A / 1.3B behavior

- `sendMessage`/`resume`/`interrupt`/`requireContinuable` keep their existing semantics for
  live children; `childMessaging`, `subagentSession`, `subagentReliability`,
  `subagentCompaction`, and `subagentBudgets` all pass unchanged.
- Model selection is decided once at spawn and is unchanged by continuation (tests 18, 19,
  32 assert the same session/model/provider and no second child).
- Mid-run compaction is untouched; `compactionState` round-trips through persist/recover
  (test 29).
- Deadline arming and the terminal-state contract are untouched; a renewal never clears or
  alters runtime limits (test 32). A `timed_out` child still requires explicit action.
- The read-only child allowlist and permission mode are unchanged for continuation turns
  (test 18 asserts every tool in the continuation request is in the allowlist).

---

## 15. Race conditions and safety

- **Single-turn ownership** is unchanged: at most one execution of a given child mutates
  its context at a time; `continueChild` only enqueues and wakes the existing driver.
- **Late results** cannot resurrect or overwrite a stopped child: terminal settlements are
  valid only from `running`, so a completion/failure arriving after an
  interrupt/cancel/timeout is a no-op (test 31).
- **Concurrent isolation:** each child has its own ledger and scope; a renewal mutates only
  the named child's totals (test 24).
- **Aggregate atomicity** is enforced in `dispatchTool` (unchanged) and independently in
  `renewBudget`, so no renewal can bypass the shared ceiling.

---

## 16. Security, ownership, and permission scope

- Every mutating control call authorizes the exact owning `parentSessionId` before any
  state change (tests 23, 30).
- `recoverChild` refuses non-`investigation` kinds, missing routing identity, mismatched
  owners, and (optionally) a missing owner row.
- Continuation carries no new capability: the same read-only allowlist and `read_only`
  permission mode govern every continuation turn.

---

## 17. Remaining limitations

- **Aggregate counters do not survive a restart.** After recovery a child is rebuilt with
  fresh aggregate scope counters (the owning parent run is gone). Per-child consumption,
  allowance, and renewal history are preserved, so this is a truthful, documented
  limitation rather than a silent reset.
- **Recovery is manual.** There is no automatic re-drive on startup; recovery only makes
  durable work available and requires an explicit owning-parent continuation.
- **No UI.** The control surface is exposed over IPC/preload only; the child-management UI
  is Phase 1.5 work.
- **In-memory liveness.** Live children, driver records, and inboxes remain in-memory;
  only terminal state is durable.

---

## 18. Recommended next steps for Phase 1.4

1. **Harden child-context compaction and recovery** (the 1.4 target): exercise repeated
   compaction across continuation turns and recovery boundaries, reusing the
   `compactionState` already round-tripped here.
2. **Persist the aggregate scope identity** so a recovered child can be reattached to a
   durable parent invocation, closing the §17 aggregate-counter limitation.
3. **Surface the control surface** minimally (status badge + explicit "continue"/"renew"
   affordances) as part of 1.5, without building broad child-management UI now.

---

## Appendix — key invariants

- `original`, `granted`, `current`, `consumed`, `remaining`, and `aggregate` are always
  distinct; a renewal is never a reset.
- A child is advertised durable-resumable only after a successful write.
- A renewal never modifies the parent aggregate and never exceeds its remaining allowance.
- Recovery never executes; continuation after a restart is always explicit.
- The eligibility and allowance rules live in exactly one pure module.
