# Background Execution & Scheduled Tasks — Design Plan (Draft v1)

Status: **draft, plan-only — no implementation yet.** Pending decision confirmation (section 11).

Related constraints: `future-plans.md` §8 non-negotiable ("no persistent daemon,
or scheduling system that continues running after the desktop app closes") and
§11.2 gap ("persistent scheduled jobs — only if compatible with the no-daemon
constraint, e.g. while the app is running"). This design is the concrete answer
to that gap.

## 1. Problem framing

- Continuum is local-first: the agent only executes while the Electron app is
  open (`llama-server` is a child of the app process; cloud providers are
  optional).
- OS-level schedulers (cron, systemd timers, Task Scheduler) are ruled out: they
  require a headless runtime process that outlives the app, which §8 forbids.
- Therefore the design is an **in-app scheduler**: a tick loop in the main
  process that is alive only while the app is open, plus **explicit catch-up
  semantics** for times the PC was closed or asleep.
- Honest positioning: this is an *in-app cron*, not a system scheduler. A task
  fires only while the app is running — or within a bounded catch-up window
  after it reopens. We must state this plainly in the UI so expectations match
  reality.
- **Zero-cost constraint** (hobby project, no paid options): no paid services
  and no paid dependencies. This design adds **zero** new npm dependencies
  (pure JS plus `Intl` for timezones; existing `better-sqlite3` for storage).
  Cloud models are used only through the user's existing BYOK provider
  configuration — no Continuum-side billing of any kind.

## 2. Scheduling model

A **scheduled task** is: a name, an agent prompt, an optional project/workspace
scope, a **model reference** (a local model, or a cloud provider + model ID),
a recurrence spec, a permission mode, a budget, and a catch-up policy.

Recurrence kinds for v1:

| Kind | Spec | Example |
| --- | --- | --- |
| `once` | `{ at: <epoch ms> }` | one-off: run at a chosen date + time |
| `daily` | `{ atTime: "09:30", startDate: <epoch ms> }` | daily alarm: every day at 09:30 from a chosen start date |

Weekly, every-N-days, and monthly are **deferred to v2**. The recurrence
module and the JSON spec column are shaped to accept them later without a
schema migration. (v1 scope confirmed by Sensei: "daily alarm" — the user
selects the date and the time.)

**Model reference:** exactly one primary model — either a local model path
(from the scanned model directory) or a cloud provider + model ID (from the
user's existing Cloud Providers settings; BYOK, no Continuum-side billing).
An optional ordered **fallback chain** (see §4) is tried when the primary is
unavailable.

Semantics:

- `atTime` is **local wall-clock time** in the user's IANA timezone (captured
  at task creation, editable). `next_run_at` is stored as UTC epoch ms.
- **Anchor-based recurrence (cron semantics):** the next occurrence is computed
  from the schedule anchor, never from the actual execution time. A missed run
  therefore never drifts the schedule forward.
- DST rules: spring-forward 02:30 (nonexistent) → fire at first instant at or
  after the intended wall time (03:00). Fall-back 01:30 (ambiguous) → fires
  exactly once, at the first such instant.

The recurrence math lives in a **pure, dependency-free module**
(`src/lib/scheduleCalc.cjs`) so it is fully unit-testable without Electron.

## 3. Missed-run (catch-up) policy

When the app opens (or on any tick) and finds `now > next_run_at`, the policy
decides:

| Policy | Behavior |
| --- | --- |
| `grace` (default) | Run now if missed by ≤ `grace_hours` (default 24h); otherwise record a `missed` run and advance the schedule past `now`. |
| `run-on-next` | Run once on next launch regardless of age. |
| `skip` | Never catch up; record `missed` and advance. |

Rationale: a daily briefing missed by 14 hours (overnight) is still useful;
one missed by 36 hours is usually stale. 24h covers the common "laptop was
closed" case while bounding staleness. The policy is per-task and editable.

This is the direct answer to *"the PC was off at the scheduled time"*: within
the grace window the task executes as soon as the PC becomes active; beyond
it, the slot is recorded `missed` and the schedule advances to the next
dated occurrence.
Laptop sleep is handled by the same mechanism: `setInterval` simply doesn't
fire while suspended; on `powerMonitor` `resume` we force an immediate tick and
the catch-up logic applies.

## 4. Execution model

- **Own session per run.** Each execution creates a session in a dedicated
  "Scheduled runs" grouping under the task's project (or general chat when
  project-less). The prompt is executed as a normal agent turn with a header
  identifying the run. Output stays browsable, searchable, and deletable like
  any chat — no hidden execution.
- **Serial queue, concurrency = 1** (fixed in v1). Local models are scarce
  resources; running two agent loops at once is an avoidable cost. If the user
  is actively running an agent, scheduled runs wait — user sessions always take
  priority over scheduled ones.
- **Model availability & VRAM conflict** (per task): at execution time the
  runner prefights the target model against what is currently loaded using
  the existing `gpuMemory` utilities (`assessGpuFit` /
  `estimateOffloadRequirements`), before attempting any load.
  - If the model is already loaded, or fits alongside the current engines →
    proceed (loading reuses the existing `engineManager` launch path).
  - If it does **not** fit (a different local model is loaded and there is no
    free VRAM) → the runner never evicts the user's active model. It tries
    the task's fallback chain if one exists; otherwise it records
    `skipped (vram-conflict)` and sends a notification.
  - **Fallback chain** (optional, per task, ordered): each entry is a
    specific local model path, `any-loaded` (whatever local model is
    currently loaded, if any), or a cloud provider + model ID. **Default:
    no fallback** — an explicit skip with a notification is preferred over
    silently substituting a different model, which changes task quality in
    unpredictable ways.
- **Permission mode: default `Read Only`.** A scheduled run is unattended; the
  rational default is no writes. Write-capable modes are available per task but
  must be opted into explicitly in the editor.
- **Budget caps** per run (max agent turns / tool calls / wall-clock) reuse the
  existing execution-budget infrastructure, so an unattended loop cannot run
  away indefinitely.
- **App close while a run is in flight:** the run is cancelled, the run record
  is marked `interrupted`, and the user is notified on next launch.
- **Run records:** every attempt (completed / failed / skipped / missed /
  interrupted) is stored with timestamps and token usage — full auditability,
  surfaced in the UI history.
- **Notifications:** reuse the existing `notificationService` for completion,
  failure, and missed-run notices.

## 5. Long absence and catch-up burst

Scenario: the PC was off or asleep for days, and several tasks are due at
startup.

1. **At most one catch-up execution per task per absence** — the latest
   missed slot only. A daily task missed 7 days does not replay 7 runs; it
   either runs once (if that latest slot is within the grace window) or
   records a single `missed` entry and advances.
2. **The grace window caps the burst naturally.** With the default 24 h
   grace, a week-long absence produces **zero** auto-runs at startup: every
   task's latest slot is older than the window, so each records `missed` and
   advances to its next dated occurrence. Only absences shorter than the
   grace window (the common overnight case) produce catch-up runs.
3. **Startup cap:** even within the grace window, at most **5** tasks
   auto-run at startup; the rest are recorded `skipped (startup-cap)` and
   remain runnable via **Run now**. (Personal-scale task counts rarely hit
   this cap.)
4. **User preempts:** queued auto-runs yield to any manual turn the user
   starts and resume after it ends.
5. **Staleness is visible:** a late catch-up run executes on today's context,
   not the scheduled time's. Run records store both `scheduled_for` and
   `started_at`, so this is auditable.

## 6. Architecture — files touched

| File | Role |
| --- | --- |
| `src/lib/scheduleCalc.cjs` (new) | Pure recurrence + catch-up computation (TZ-aware). No I/O. |
| `src/main/db.js` | New tables: `scheduled_tasks`, `scheduled_task_runs` (+ indexes). Follows existing `CREATE TABLE IF NOT EXISTS` + migration pattern. |
| `src/main/scheduledTasks.js` (new) | Store + scheduler core: 30 s tick loop, immediate tick on start and `powerMonitor` `resume`, catch-up evaluation, serial queue, run lifecycle, next-occurrence recomputation. |
| `src/main/chatTurnRunner.js` (new) | Extracted `engine:chat` core. Today the chat-turn implementation is closed inside `ipcHandlers.js` and coupled to `event.sender`; the scheduler must drive a turn with no renderer sender. Extraction lets both paths share one implementation. |
| `src/main/ipcHandlers.js` | New `scheduled-task:*` channels: list / create / update / delete / enable / run-now / history. No new stream-dispatcher coupling needed (runs stream into their session like normal turns). |
| `src/preload.js` + renderer | "Scheduled Tasks" panel: task list with next-run countdown, editor (prompt, scope, recurrence, model policy, permission mode, budget, catch-up), run history, run-now, enable toggle. |
| `tests/schedule.test.js` (new) | Recurrence, DST spring/fall, anchor semantics, catch-up policies, queue behavior — with an injected clock. |

Schema sketch:

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_id TEXT,
  model_ref_json TEXT NOT NULL,  -- {kind: 'local'|'cloud', modelPath | provider+modelId}
  fallback_json TEXT,           -- ordered array: {kind, ...} | 'any-loaded'; null = none
  recurrence TEXT NOT NULL,      -- JSON spec
  timezone TEXT NOT NULL,        -- IANA
  next_run_at INTEGER NOT NULL,  -- epoch ms UTC
  last_run_at INTEGER,
  last_status TEXT,
  permission_mode TEXT NOT NULL, -- default 'read-only'
  budget_json TEXT,
  catchup_json TEXT NOT NULL,    -- {policy, grace_hours}
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  scheduled_for INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL,          -- queued|running|completed|failed|skipped|missed|interrupted
  failure_reason TEXT,
  usage_json TEXT,
  created_at INTEGER NOT NULL
);
```

## 7. Integration risks (ordered)

1. **`engine:chat` extraction** — the current handler couples to
   `event.sender` (stream dispatcher, trusted-sender checks). The extracted
   runner must stream a run into its session through the existing per-session
   event channels so an open Scheduled-run session updates live. This seam is
   the main unknown; verify how session updates propagate to the UI before
   committing to the exact shape.
2. **Model loading on demand** — the scheduler must invoke `engineManager`
   launch with correct lifecycle (one engine per model, idle service attached,
   stop on app quit). Reuse the existing launch path; no new engine logic.
3. **Clock/sleep behavior** — sleep is covered by resume-tick + catch-up.
   User-initiated system-clock changes are accepted as-is (next-occurrence
   math is wall-clock based); noted, not engineered against.
4. **Concurrent model load while user is mid-run** — queue discipline (user
   first) plus the inference scheduler's existing lanes should make this safe;
   confirm with an integration test.

## 8. Phases

- **A.** `scheduleCalc` pure module + unit tests (recurrence, DST, catch-up).
- **B.** Schema + store layer in `db.js` / `scheduledTasks.js`.
- **C.** `chatTurnRunner` extraction from `engine:chat`.
- **D.** Scheduler core: tick loop, catch-up, serial queue, run lifecycle,
  notifications, interrupt-on-quit.
- **E.** IPC channels + UI panel (list, editor, history, run-now).
- **F.** Integration tests, docs, `future-plans.md` status update, full
  `npm test` pass.

## 9. Run sequence (one scheduled execution, end to end)

```
tick (30s) or app-start / power-resume
  └─ find enabled tasks where next_run_at <= now
       └─ for each (ordered by scheduled_for ascending):
            catchup evaluate (grace / run-on-next / skip)
              ├─ skip/missed   -> record run {status: missed}, recompute next_run_at, continue
              └─ due            -> enqueue
  queue (serial, concurrency 1; user turns preempt)
  └─ dequeue next queued run
       └─ resolve model (preflight VRAM vs loaded engines; fallback chain)
            ├─ unavailable and no fallback -> record {status: skipped, reason: vram-conflict}, notify, continue
            └─ available (already loaded, fits, or fallback) -> proceed (launch engine if needed)
       create run session (Scheduled-runs grouping, project scope)
       insert run {status: running, started_at}
       execute agent turn via shared chatTurnRunner (budget-capped, Read Only default)
       └─ on finish / error / cancel
            persist run {status, finished_at, usage}
            notificationService notify
            recompute next_run_at from anchor; store
```

Key invariant: `next_run_at` is always recomputed from the **anchor**, never
from `finished_at`, so drift is impossible regardless of when execution
actually happened.

## 10. Edge cases and failure modes

| Case | Handling |
| --- | --- |
| Multiple tasks due at once | Serialized in `scheduled_for` order; queue is bounded; overflow simply waits (no data loss). |
| User mid-run when a task is due | User turn preempts; the task stays `queued` and runs when the user's turn ends. |
| Model load fails (spawn error) | Record `failed` with `describeEngineSpawnError` text; notify; single attempt per due window (no retry loop). VRAM conflicts are handled by the §4 fallback policy instead. |
| PC absent for days; many tasks due at startup | §5 rules apply: one catch-up per task, grace window caps the burst, 5-run startup cap, remainder `skipped`. |
| Task edited while pending (change time / disable) | Recompute `next_run_at` on save; if disabled, drop from queue and leave `next_run_at` for re-enable. |
| Timezone changed on the OS | Next occurrence recomputed from anchor + current IANA zone at tick; a mid-day change may shift the next slot by one DST/hour delta — accepted, noted in docs. |
| System clock jumped forward | If now is far past next_run_at, catch-up policy decides (grace vs skip); no repeated fire for every missed slot. |
| System clock jumped backward | `now < next_run_at` simply means not yet due; tick resumes normally. No action. |
| App quits mid-run | Run marked `interrupted`; on next launch, catch-up sees the last completed anchor and does not double-fire. |
| Run errors mid-turn (tool failure) | Existing turn error handling applies; run recorded `failed` with reason; next slot unaffected. |
| Many tasks, tiny grace | All within one queue; worst case = sum of durations behind schedule; acceptable for personal-scale task counts. |

## 11. Open decisions — decision matrix

Each row states the **recommended default**, the rationale, and the fallback so
the choice is explicit rather than open-ended.

| # | Decision | Status | Recommended default | Fallback / alternative |
| --- | --- | --- | --- | --- |
| 1 | PC off at scheduled time | confirm | **`grace`, 24 h**: execute on activation if missed by ≤ 24 h; otherwise record `missed` and advance to the next dated occurrence | `run-on-next` (always execute on launch), `skip` (never catch up), or 1 h / 12 h |
| 2 | VRAM conflict (scheduled model cannot load) | confirm | **Skip with notification** — never evict the user's loaded model; optional per-task fallback chain | Auto-fallback to `any-loaded` as the default instead |
| 3 | Fallback chain entries | confirm | specific local model, `any-loaded`, cloud provider + model ID | Restrict to local models only |
| 4 | Startup auto-run cap after long absence | confirm | **5** tasks auto-run; the rest `skipped` + manual Run now | 1 / 3 / unlimited (the grace window already caps bursts) |
| 5 | Permission ceiling for scheduled runs | confirm | **Per-task opt-in, default Read Only** | Hard-lock to Read Only until v2 |
| 6 | UI placement | confirm | **Sidebar section** (next to Memory Palace / settings) | Dedicated Settings tab |

**Settled** (no longer open):

- v1 recurrence scope = **`once` + `daily` alarm** (user selects the date and
  the time); weekly / every-N-days / monthly deferred to v2.
- The model field accepts **local or cloud** per task (cloud via the
  existing BYOK settings).
- **Zero-cost constraint:** no paid services or dependencies; the design
  adds zero new npm dependencies.

Items 1–6 need confirmation; the recurrence scope, the local-or-cloud model
field, and the zero-cost constraint are settled as above. Per Sensei's
instruction, **nothing is implemented** until these decisions are confirmed.
