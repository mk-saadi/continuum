# Compact Task-Plan Results (Phase 2.0E)

Status: implemented, tested, benchmarked, and stopped for review. No commit or
push was performed. The unrelated working-tree changes present before this phase
(`future-plans.md`, `src/components/main-app/MemorySettings.jsx`,
`src/index.css`) were left untouched.

## 1. Original `update_plan` response behavior

Before this phase, `src/main/workspacePlan.js` handled all three actions in one
tool. Successful `create`, `update`, and `get` responses each carried a `plan`
object produced by `readPlan()`:

```json
{
  "success": true,
  "action": "update",
  "exists": true,
  "plan": {
    "objective": "…",
    "revision": 19,
    "createdAt": "…",
    "updatedAt": "…",
    "steps": [
      {
        "id": 18,
        "position": 1,
        "description": "…",
        "status": "completed",
        "note": "",
        "createdAt": "…",
        "updatedAt": "…"
      }
    ]
  }
}
```

`updateSteps()` returned `readPlan(sessionId)` after every committed mutation, so
a single status change returned every step, every description, every note, and
both timestamps for every row. Error responses were already compact
(`{ success: false, error, code }`) and were not changed.

## 2. Root cause of repeated tool output

The plan record is intentionally durable and session-owned; returning it from
`get` is correct. The problem was returning the same record from *mutations*.
Each `update_plan({ action: "update", … })` therefore re-serialized the entire
plan into the tool result, which accumulates in the model context and in saved
execution history. The historical TaskFlow audit measured 22 plan calls,
roughly 89,041 characters of plan output, and a 38-step plan echoed after every
step update.

The current code confirmed the audit's cause, although its implementation had
since gained revisions, stale-revision checks, compact execution summaries, and
read-only cross-session plan retrieval. Those behaviors are preserved.

## 3. New mutation-result contract

`action: "update"` now returns a compact, authoritative result:

```json
{
  "success": true,
  "action": "update",
  "exists": true,
  "plan_id": "…",
  "revision": 19,
  "changed_steps": [
    {
      "id": 18,
      "position": 1,
      "description": "…",
      "status": "completed",
      "note": "",
      "change": "updated"
    }
  ],
  "progress": {
    "total": 38,
    "completed": 18,
    "in_progress": 1,
    "pending": 19,
    "blocked": 0
  }
}
```

Additional fields appear only when the operation uses them:

- `removed_step_ids` — sorted numeric ids of steps deleted in this call.
- `objective` — the new objective, only when `objective` actually changed.
- `change` inside `changed_steps` is `"updated"` or `"added"`.

Guarantees:

1. `success`, `action`, `exists`, error text, and error `code` semantics are
   unchanged.
2. `revision` is the post-commit revision read inside the same SQLite
   transaction, never the requested or pre-update revision.
3. `changed_steps` contains only steps this call touched. Existing rows are
   resolved from committed SQLite rows, not from requested values.
4. Added steps include their assigned stable id (captured from
   `lastInsertRowid`) and their position.
5. `progress` is derived from the committed plan:
   `total`, `completed`, `in_progress`, `pending`, `blocked`.
6. Blocker state and notes are included for every changed step; unchanged
   steps are not echoed.
7. `changed_steps` follows plan order (`position`, then `id`). Removed ids are
   sorted numerically, so an equivalent mutation produces a deterministic
   response.
8. A failed validation or persistence operation returns no compact success
   object and changes no row; the existing `PlanError` codes and
   `PLAN_PERSISTENCE_FAILED` path are untouched.
9. There is no partial-success shape: the response is built after the single
   transaction commits.
10. The response remains bounded by `MAX_STEPS = 50`; a single-step mutation
    contains one step regardless of plan size.

## 4. Creation and retrieval behavior

**Creation is unchanged.** `create` still returns the complete initial plan. It
is a one-time operation and the only point where the model receives every
newly assigned step id and position in one response. Replacing it with a
compact acknowledgement would force an immediate `get` call before the model
could reliably update any step, trading a small one-time saving for a new
round trip and a new failure mode. The response was already reasonable.

**`get` is unchanged.** It still returns the complete plan for the current
session: objective, revision, timestamps, ordered steps, stable ids, statuses,
and blocker notes. It is the documented recovery path after restart,
compaction, or uncertainty. No pagination existed or was introduced; the hard
`MAX_STEPS = 50` bound already limits plan size.

## 5. SQLite persistence compatibility

No schema or migration change was made. The authoritative tables remain:

- `workspace_plans(session_id PRIMARY KEY, objective, revision, created_at,
  updated_at)`
- `workspace_plan_steps(id, session_id, position, description, status, note,
  created_at, updated_at)`
- `idx_plan_steps_session(session_id, position, id)`
- session-delete cascades for both plan tables.

`updateSteps()` still runs one immediate transaction containing the revision
check, validation, step writes, removals, position compaction, revision
increment, and the final read. The only new bookkeeping is in-memory sets of
touched/added ids and a sorted removal list returned to the caller. Compact
fields are derived from `readPlan()` after the writes, so the response and the
database cannot disagree.

## 6. Cross-session retrieval compatibility

`get_project_plans` and `getProjectPlan()` were not modified. They still:

- list bounded plan summaries from the caller's project only;
- return a full historical plan by `plan_id`/`session_id`;
- require the target session to belong to the caller's project;
- remain read-only and non-mutating;
- never copy or merge another session's plan into the caller's plan;
- never inject another session's plan into context automatically.

The new compact result is produced only by `update_plan` for its own
`sessionId`. Cross-session reads continue to return the complete plan shape.

## 7. Context and compaction behavior

Compact mutation objects replace the previous full-plan echoes in tool results
and saved execution steps. The authoritative plan remains in SQLite, and the
existing prompt injection (`buildPlanSection`) still reads that table and emits
the same bounded plan section, including unfinished steps and blocker notes.

Compaction was not changed. It still reads the persisted plan and never writes
it. Recovery via `update_plan({ action: "get" })` returns the latest complete
plan and revision. Work-log/turn-digest handling already summarized plan calls
as “updated the task plan”; it remains accurate and does not depend on the
response containing every step. Token accounting (`planTokens`,
`getContextUsage`) was not changed.

The system prompt and tool schema now state that an update returns changed
steps, revision, and progress, and that `get` is the full-plan read. No prompt
requires a complete plan after every mutation.

## 8. Activity-tab compatibility

`WorkspacePlanCard` and its rendering were not changed. The card still loads
the complete plan through `session:get-plan` and still consumes
`session:plan-updated`.

Because tool results no longer carry `plan`, both IPC push sites now re-read the
complete plan from SQLite with `workspacePlan.getPlan(sessionId)` after a
successful `update_plan`. The event payload keeps its existing
`{ sessionId, plan }` shape, so the card receives the same complete state as
before (objective, steps, statuses, notes, revision). Failed mutations still
send no event, leaving the last durable state visible. If the post-commit read
itself fails, the push is skipped and the error is logged; the committed call
still returns success and the card can refresh through `session:get-plan`.

## 9. Concurrent-agent safety

Database transactions, revision checks, and session scoping were preserved.
The compact response is built per transaction from that session's committed
rows. Touched-id sets are local to the call, so no response can mix steps from
another plan. Concurrent sessions keep independent revisions; stale
`expected_revision` values still fail with `STALE_PLAN`; retries after a
rejected write cannot report success. Read-only cross-session retrieval does
not mutate either plan.

## 10. Files and functions changed

| File | Change |
| --- | --- |
| `src/main/workspacePlan.js` | `updateSteps()` tracks touched/added/removed steps and returns committed plan metadata; new `compactMutationResult()`; `updatePlan()` returns it for `update`. `create`/`get` untouched. |
| `src/main/ipcHandlers.js` | Both `session:plan-updated` push sites re-read the complete plan from SQLite instead of reading `result.plan`; a failed read omits the push rather than failing the committed call. |
| `src/main/tools/agentTools.js` | `update_plan` description documents the compact update result and points to `get` for the full plan. |
| `src/main/promptBuilder.js` | System-prompt planning instruction mentions the compact update result. |
| `tests/compactPlanResults.test.cjs` | New deterministic backend/IPC test suite. |
| `tests/workspacePlan.test.cjs` | Existing Phase 1.2 assertions updated to the compact update contract while keeping create/get checks. |
| `tests/projectPlanRetrieval.test.cjs` | Existing cross-session tests updated where they asserted `update().plan`. |
| `scripts/plan-output-benchmark.cjs` | New deterministic before/after benchmark (no model or network). |
| `docs/compact-task-plan-results-report.md` | This report. |

No new planning store, tool, framework, permission capability, migration, or
UI component was introduced.

## 11. Benchmark results

Command (deterministic; temporary SQLite database; no provider calls):

```bash
node scripts/plan-output-benchmark.cjs
```

The “previous” response is reconstructed exactly from the same authoritative
plan: the old code returned
`{ success: true, action: "update", exists: true, plan: readPlan() }`. Two
consecutive runs produced byte-identical JSON.
Character counts are ASCII `JSON.stringify` lengths; token figures use the
existing `chars / 4` approximation and are **not** billed provider tokens.

| Steps | Previous update chars | Optimized update chars | Reduction | Prev. tokens (approx) | New tokens (approx) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 1,309 | 383 | 70.74% | 328 | 96 |
| 20 | 4,717 | 385 | 91.84% | 1,180 | 97 |
| 38 | 8,821 | 385 | 95.64% | 2,206 | 97 |
| 50 | 11,557 | 385 | 96.67% | 2,890 | 97 |

Every optimized row still contained: the committed revision, the exact changed
step (id + completed status), and accurate whole-plan progress. The benchmark
also performs a blocked-step mutation and verifies that the status, blocker
note, and blocked progress count survive compact serialization.

A 100-step plan is **not supported** (`MAX_STEPS = 50`), so no 100-step figure
is claimed. The 50-step row is the supported maximum.

Creation and full retrieval are intentionally unchanged:

| Steps | Create chars | Get chars |
| ---: | ---: | ---: |
| 5 | 1,307 | 1,304 |
| 20 | 4,715 | 4,712 |
| 38 | 8,819 | 8,816 |
| 50 | 11,555 | 11,552 |

Repeated-update workflow (create a 38-step plan, then complete all 38 steps in
38 separate mutations):

| Measure | Previous | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Cumulative chars (39 responses) | 345,414 | 23,584 | 93.17% |
| Approx. tokens (`chars / 4`) | 86,354 | 5,896 | 93.17% |

The percentage is a character/token-estimate reduction, not a claim about an
identical reduction in billed cloud tokens. Provider tokenization, prompt
caching, replay of earlier messages, and billing tiers all affect billed usage.

## 12. Focused test results

Commands:

```bash
node --test tests/workspacePlan.test.cjs \
           tests/projectPlanRetrieval.test.cjs \
           tests/compactPlanResults.test.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a \
  node_modules/electron/dist/electron --no-sandbox tests/workspacePlan.ui.cjs
```

Result: **60/60 backend tests passed**, including the 24 new compact-result
tests; the existing plan and cross-session suites passed unchanged after their
contract updates. The Electron `WorkspacePlanCard` UI suite passed: statuses,
blocker notes, progress, revision badge, live updates, tab isolation,
loading/error/retry/empty/completed states, and stale-switch protection.

The new suite covers single-step status/blocker updates, multi-step updates,
creation, current and cross-session retrieval, same-project authorization,
cross-project isolation, completed/blocked plans, revision increments, stale
revisions, failed mutations, SQLite-derived values, restart recovery,
compaction, work-log digests, Activity-tab pushes, concurrent sessions,
subagent plan exclusion, large plans, determinism, backwards-compatible
success/error semantics, output-size reduction, and the existing Phase 1.2
behavior through the real tool dispatcher.

Related regression set (compaction, recovery, work log, turn digest,
permissions, tool result formatting, prompt, verbs) ran 104 tests: 99 passed
and 5 failed with the same identities already present in the pre-change
baseline (`contextCompaction`/`contextOverflowRecovery` real-IPC and overflow
scenarios).

## 13. Full-suite regression comparison

The historical Phase 2.0D numbers (1,393 total / 1,367 passed / 25 pre-existing
failures / 1 skipped) were treated as historical. To avoid comparing against a
different checkout, the pre-change baseline was reproduced from `HEAD` in an
isolated archive outside the working tree, using the same Node runtime and
command as the post-change run:

```bash
node --test --test-timeout=60000 tests/*.test.cjs tests/*.test.mjs
```

| Run | Tests | Passed | Failed | Cancelled | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pre-change `HEAD` (isolated checkout) | 1,394 | 1,365 | 27 | 1 | 1 |
| After Phase 2.0E | 1,418 | 1,390 | 26 | 1 | 1 |
| Delta | +24 | +25 | −1 | 0 | 0 |

The 24 new tests all passed. The post-change failure set is a strict subset of
the pre-change failure set: no new failing identity appeared. One pre-change
failure (`6. foreground, messages, and background runs all keep the one
resolved model`) passed in the post-change run, which is why the failure count
decreased by one rather than staying at 27.

The pre-existing failures are environmental/known issues in this runtime, not
plan-result regressions: Electron IPC/network-sandbox scenarios
(`contextCompaction`, `contextOverflowRecovery`, compaction badge, context
panel, engine settings, message actions/stats, MCP IPC, native permissions,
preload config, sub-agent/background model scenarios, skill IPC, attachments),
plus the RAG model test timing out (reported as one cancelled test with the
60-second harness timeout). The same identities fail at `HEAD`; the new
compact-plan suite, existing `workspacePlan` suite, cross-session suite, and
related plan/compaction/work-log suites all pass.

## 14. Production build result

`npm run build` completed successfully (Vite 6). Output included
`dist/assets/index-DAa0o3Rl.js` (1,596.46 kB, 461.04 kB gzip) and
`dist/assets/index-BLjSCOF0.css` (113.77 kB, 25.15 kB gzip), with only the
pre-existing large-chunk advisory. No build error or new warning category was
introduced.

## 15. Known limitations

- The compact result still includes the full description and note of each
  touched step. A mutation that changes all 50 descriptions can therefore
  approach the size of a plan read; this is intentional because those are all
  genuinely affected steps, and unchanged steps are still omitted.
- `update` no longer returns a `plan` field. Consumers inside this repository
  were updated (the Activity-tab push reads SQLite). External callers that
  relied on `result.plan` must use `action: "get"` for complete state; the
  stable `success`, `action`, `exists`, `revision`, and error semantics remain.
- Creation intentionally remains a full-plan response.
- No pagination exists for `get`; the existing `MAX_STEPS = 50` bound and the
  bounded prompt renderer remain the size protections.
- Token figures are estimates from deterministic character counts, not a
  provider billing measurement.
- The pre-existing Electron/Node environment failures in the broader suite are
  unrelated to plan results and were not fixed in this phase.
