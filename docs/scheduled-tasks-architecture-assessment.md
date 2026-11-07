# Continuum Background Execution & Task Scheduling — Architecture Assessment & Implementation Plan

**Status:** Assessment complete — ready for implementation decision.

---

## 1. Executive Summary

This document analyzes Continuum's existing architecture to determine what can be reused for **Background Execution and Task Scheduling**, identifies gaps, and provides a minimal incremental implementation plan that respects the "no daemon, no paid services, local-first" constraints.

**Key finding:** The existing architecture provides strong foundations. ~70% of required infrastructure already exists (database, model management, agent runtime, notifications, IPC, background commands). The main gaps are: (1) persistent scheduled task definitions, (2) a main-process scheduler tick loop with catch-up logic, (3) model usage lease mechanism, (4) extraction of the agent turn execution from `engine:chat` handler.

---

## 2. What Already Exists (Reusable Components)

| Component | File(s) | Reuse Assessment |
|-----------|---------|------------------|
| **SQLite database (better-sqlite3)** | `src/main/db.js` | ✅ Full reuse. WAL mode, migrations, transactions. Add `scheduled_tasks` + `scheduled_task_runs` tables following existing patterns. |
| **Model loading/unloading & pool** | `main.js`, `engineManager.js`, `engineRuntimeState.js` | ✅ Full reuse. Multi-engine pool (`engines` Map), per-model lifecycle, idle timeout, GPU preflight, startup handler, warmup. |
| **Model usage tracking** | `main.js` (transportRequestCounts, localRequestOwners, engineLifecycle) | ⚠️ **Partial.** Request-level tracking exists (`beginRequest`/`release` per fetch). **Missing:** turn-level lease covering multiple generations + tool calls. Need to extend `engineLifecycle` with `acquireTurnLease`/`releaseTurnLease`. |
| **Agent turn execution** | `ipcHandlers.js` (`engine:chat` handler, `runMemoryChat`) | ⚠️ **Partial.** Core logic exists but is coupled to `event.sender` for streaming, tool approvals, steering. **Must extract** into a renderer-agnostic `chatTurnRunner.js` that accepts callbacks for streaming/notifications. |
| **Background commands** | `src/main/backgroundCommands.js` | ✅ Full reuse for *command* lifecycle. Already persists, restores on startup, handles cancellation, emits `change` events, supports `survive_run_completion`. **Note:** This is for *commands started by agents*, not scheduled task execution. Keep distinct. |
| **Cloud provider integration** | `src/main/cloudProviders.js` | ✅ Full reuse. BYOK providers, local endpoints (Ollama/LM Studio), model metadata, pricing. |
| **Local model scanning** | `main.js`, `modelScanner.js` | ✅ Full reuse. `scannedModels` Map, recursive scan, projector detection. |
| **GPU memory assessment** | `src/main/gpuMemory.js` | ✅ Full reuse. `assessGpuFit`, `estimateOffloadRequirements`, `queryGpuMemory`, `shouldPreflightOffload`. |
| **Notification service** | `src/main/services/notificationService.js` | ✅ Full reuse. Electron `Notification` API, backgrounded-window detection, configurable events/sounds. |
| **IPC infrastructure** | `src/preload.js`, `src/main/ipcHandlers.js` | ✅ Full reuse. `contextBridge`, trusted-sender validation, `ipcMain.handle`/`on`, streaming via `event.sender.send`. |
| **Power/suspend handling** | *Not yet implemented* | ❌ Missing. Need `powerMonitor` listeners for `suspend`/`resume` to trigger catch-up tick. |
| **App startup/recovery** | `main.js` (engineRuntimeState.reap, db.initDatabase) | ✅ Pattern exists. Engines reaped, DB migrations run, background commands restored. Scheduler must follow same pattern. |
| **Settings/config persistence** | `src/main/configManager.js`, `src/main/configStore.js` | ✅ Full reuse. `app_settings` table, validation, normalization. |
| **Session/project management** | `src/main/sessionManager.js`, `src/main/projectManager.js` | ✅ Full reuse. Sessions, projects, workspaces, permissions. |
| **Sub-agent runtime** | `src/main/subagents/` | ✅ Reuse for scheduled tasks that spawn children. Budget settings, model selection, continuation. |

---

## 3. What Is Missing (Gaps)

| Gap | Description | Effort |
|-----|-------------|--------|
| **Scheduled task schema** | Two new tables: `scheduled_tasks` (definitions) + `scheduled_task_runs` (execution records). Follow existing migration pattern in `db.js`. | Low |
| **Schedule calculation module** | Pure JS (no Electron deps): recurrence math (daily, every-N-days, weekdays, once), timezone-aware (IANA via `Intl`), anchor-based next-occurrence, DST spring/fall rules, catch-up policy evaluation. | Medium |
| **Main-process scheduler** | 30s tick loop, immediate tick on startup + `powerMonitor` `resume`, finds due tasks, evaluates catch-up, enqueues, serial execution, recomputes `next_run_at` from anchor. | Medium |
| **Model usage turn lease** | Extend `engineLifecycle` with `acquireTurnLease()`/`releaseTurnLease()` covering full agent turn (multiple generations + tool calls). Scheduler waits for lease release before unloading/loading models. | Medium |
| **Chat turn runner extraction** | Factor `engine:chat` handler into `chatTurnRunner.js` accepting: `modelId`, `messages`, `sessionId`, `permissionMode`, `budget`, `callbacks` (onStream, onStep, onComplete, onToolApproval, onAskUser). No `event.sender` dependency. | High |
| **Scheduler ↔ model manager integration** | At execution time: check if target model loaded → if not, check if another turn holds lease on current model → if yes, queue/wait → else load target model (reuse `launchModel`). Serialize model loads. | Medium |
| **Fallback model resolution** | Per-task optional fallback chain. Try primary → on VRAM conflict/unavailable, try fallbacks in order. Never silent local→cloud switch. Surface "fallback used" in run record + notification. | Medium |
| **IPC channels for scheduled tasks** | `scheduled-task:list`, `create`, `update`, `delete`, `enable`, `disable`, `run-now`, `get-history`, `get-run-detail`. | Low |
| **UI: Scheduled Tasks panel** | List (upcoming/queued/running/completed/failed), editor (prompt, recurrence, model, fallback, permission, budget, catch-up), run-now, pause/resume, history. | Medium |
| **Startup/wake reconciliation** | On app ready + `powerMonitor` `resume`: force scheduler tick, process overdue tasks per catch-up policy, respect startup cap (default 5). | Low |

---

## 4. Scheduler ↔ Agent Runtime Interaction

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS (Electron)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Scheduler (30s tick + powerMonitor resume)                                 │
│    │                                                                        │
│    ├─► Find due tasks (next_run_at ≤ now)                                   │
│    │                                                                        │
│    ├─► For each due task: evaluate catch-up policy                          │
│    │     ├─ grace (≤24h): enqueue                                           │
│    │     ├─ run-on-next: enqueue                                            │
│    │     └─ skip: record missed, advance schedule                           │
│    │                                                                        │
│    ├─► Serial queue (concurrency = 1)                                       │
│    │     │                                                                  │
│    │     ├─► Dequeue next                                                   │
│    │     │                                                                  │
│    │     ├─► Resolve model:                                                 │
│    │     │     ├─ If loaded & no lease conflict → use it                    │
│    │     │     ├─ If not loaded:                                            │
│    │     │     │     ├─ Check if active turn holds lease on current model   │
│    │     │     │     ├─ If yes → wait for lease release (queue task)        │
│    │     │     │     ├─ If no → load target model (launchModel)             │
│    │     │     │     └─ On VRAM conflict → try fallback chain               │
│    │     │     └─ If fallback exhausted → record skipped (vram-conflict)    │
│    │     │                                                                  │
│    │     ├─► Create session (Scheduled-runs grouping, project scope)        │
│    │     │                                                                  │
│    │     ├─► Execute via chatTurnRunner:                                    │
│    │     │     ├─ permissionMode = task.configured (default: read-only)     │
│    │     │     ├─ budget = task.configured (turns, tools, wall-clock)       │
│    │     │     ├─ callbacks: onStream → persist + notify UI if open         │
│    │     │     │          onStep → persist execution steps                   │
│    │     │     │          onToolApproval → block (unattended = deny/queue)  │
│    │     │     │          onAskUser → block (unattended = queue)            │
│    │     │     │          onComplete → record run, notification             │
│    │     │     │          onError → record run, notification                │
│    │     │     └─ Acquires turn lease on model for entire turn              │
│    │     │                                                                  │
│    │     └─► On finish: recompute next_run_at from anchor, persist          │
│    │                                                                        │
│    └─► Startup cap: max 5 auto-runs at launch; rest → skipped (startup-cap)│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **`chatTurnRunner.executeTurn({ modelId, messages, sessionId, permissionMode, budget, callbacks })`** — renderer-agnostic, returns `{ status, usage, error }`.
2. **`engineLifecycle.acquireTurnLease(modelPath)` / `releaseTurnLease()`** — blocks model unload/load while turn active.
3. **`scheduler.waitForModelAvailability(targetModelPath)`** — returns when safe to load (no active lease on conflicting model).
4. **`modelManager.launchModel(modelId, config)`** — existing, reused.

---

## 5. Model Usage Lease Mechanism (Prevents Active Model Unloading)

### Current State
- `engineLifecycle` tracks `stop-requested`, `server-process-exit`, `activeRequests` (per-fetch).
- `transportRequestCounts` + `localRequestOwners` track in-flight HTTP requests.
- Idle timeout unloads model when `activeRequests == 0` for N minutes.

### Problem
- A single agent **turn** = multiple generations (LLM calls) separated by tool calls.
- Current tracking releases between generations → model could be unloaded mid-turn.
- Scheduled task needing Model B cannot wait for Model A's turn to finish.

### Solution: Turn-Level Lease (Add to `engineLifecycle`)

```javascript
// In engineLifecycle.js
function createEngineLifecycle({ generation, modelPath, pid, activeRequests = () => 0, ... }) {
  let turnLeaseCount = 0;  // 0 = no active turn; >0 = turn in progress
  const turnWaiters = [];  // [{ resolve, reject, targetModelPath }]

  return {
    // ... existing methods ...
    
    acquireTurnLease() {
      turnLeaseCount++;
      return {
        release: () => {
          turnLeaseCount = Math.max(0, turnLeaseCount - 1);
          if (turnLeaseCount === 0) this._notifyWaiters();
        }
      };
    },
    
    hasActiveTurnLease() {
      return turnLeaseCount > 0;
    },
    
    waitForTurnLeaseRelease(targetModelPath) {
      if (!this.hasActiveTurnLease()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        turnWaiters.push({ resolve, reject, targetModelPath });
      });
    },
    
    _notifyWaiters() {
      for (const w of turnWaiters.splice(0)) w.resolve();
    },
    
    requestStop(reason, component, userAction) {
      if (turnLeaseCount > 0) {
        // Cannot stop while turn active — reject or queue
        return false;
      }
      // ... existing logic
    }
  };
}
```

### Integration in `chatTurnRunner`

```javascript
// At turn start
const lease = engineLifecycle.acquireTurnLease();
try {
  // ... entire agent loop (generations + tool calls) ...
} finally {
  lease.release();  // Always released, even on error/cancel
}
```

### Scheduler Wait Logic

```javascript
async function ensureModelAvailable(targetModelPath) {
  const currentEntry = engines.get(activeModelPath);
  if (currentEntry?.modelPath === targetModelPath) return; // Already loaded
  
  // If another model loaded and has active turn lease, wait
  if (currentEntry?.lifecycle?.hasActiveTurnLease()) {
    await currentEntry.lifecycle.waitForTurnLeaseRelease(targetModelPath);
  }
  
  // Now safe to load target model
  await launchModel(targetModelPath, config);
}
```

---

## 6. Queued Executions Surviving Restarts

### Persistence Strategy
- **Task definitions** → `scheduled_tasks` table (persisted on create/update/delete).
- **Run records** → `scheduled_task_runs` table (inserted at queue time with `status: 'queued'`, updated to `running`/`completed`/`failed`/`skipped`/`missed`).
- **Next occurrence** → `next_run_at` column on `scheduled_tasks` (recomputed from anchor on every completion/miss).

### Startup Recovery Flow

```
app.whenReady()
  │
  ├─► engineRuntimeState.reap()          // Clean orphaned llama-server
  ├─► initDatabase()                     // Runs migrations, restores background_commands
  │
  ├─► scheduledTasks.restore(db)         // NEW: Load enabled tasks, rebuild next_run_at
  │     ├─ For each task: compute next_run_at from anchor + now
  │     └─ If next_run_at ≤ now → evaluate catch-up policy immediately
  │
  ├─► scheduledTasks.startScheduler()    // NEW: Begin 30s tick loop
  │
  └─► powerMonitor.on('resume', () => scheduledTasks.forceTick())
```

### Duplicate Execution Prevention
- **Atomic claim:** When dequeuing, `UPDATE scheduled_task_runs SET status='running', started_at=... WHERE id=? AND status='queued'` — only one process claims it.
- **Idempotency key:** `task_id + scheduled_for` uniquely identifies an occurrence.
- **Startup:** Any `status='running'` rows from previous crash → mark `interrupted`, do not re-execute.

---

## 7. Architectural Blockers & Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **`engine:chat` extraction complexity** | High | The handler is ~400 lines with deep `event.sender` coupling (streaming, tool approvals, steering, loop pause). Extraction must be done carefully. Recommend: create `chatTurnRunner.js` that accepts callback map; keep `engine:chat` as thin IPC wrapper. |
| **Model lease + idle timeout interaction** | Medium | Idle timeout must not fire while `turnLeaseCount > 0`. Modify `createIdleService` to accept `hasActiveTurnLease()` check, or have `engineLifecycle.requestStop` return false when lease held (already planned). |
| **Concurrent model loads** | Medium | Serialize via scheduler queue (concurrency=1). Only one model load at a time. |
| **Tool approvals in unattended runs** | Medium | Scheduled tasks default to `read-only` permission. If a tool requires approval → block run, record `blocked (approval_required)`, notify user. Never auto-approve. |
| **PowerMonitor on Linux** | Low | `powerMonitor` works on all platforms but Linux `suspend`/`resume` may need `systemd` inhibitor. Test on target platforms. |
| **Timezone/DST edge cases** | Medium | Use pure JS `Intl.DateTimeFormat` + `Temporal` (polyfill) or `luxon` (but zero-dep preferred). Test spring-forward/fall-back explicitly. |
| **VRAM preflight race** | Low | Preflight checks current VRAM; another load could start between check and load. Acceptable for v1 — load will fail with clear error, recorded as `failed`. |

---

## 8. Minimal Incremental Implementation Order

### Phase 1: Background Execution Reliability (Prerequisite)
- [ ] 1.1 Extract `chatTurnRunner.js` from `engine:chat` handler
- [ ] 1.2 Add turn-level lease to `engineLifecycle.js` (`acquireTurnLease`/`releaseTurnLease`/`waitForTurnLeaseRelease`)
- [ ] 1.3 Modify `engineLifecycle.requestStop` to return `false` when turn lease active
- [ ] 1.4 Update `createIdleService` / idle timeout to respect turn lease
- [ ] 1.5 Test: user turn holds model → scheduled task waits → user turn ends → scheduled task loads model

### Phase 2: Scheduler Foundation
- [ ] 2.1 Add `scheduled_tasks` + `scheduled_task_runs` tables to `db.js` (migration pattern)
- [ ] 2.2 Create `src/lib/scheduleCalc.cjs` — pure recurrence + catch-up math (unit tested)
- [ ] 2.3 Create `src/main/scheduledTasks.js` — store + scheduler core (tick loop, catch-up, queue)
- [ ] 2.4 Implement startup recovery + `powerMonitor` resume tick
- [ ] 2.5 One-time scheduling (`once` recurrence) working end-to-end

### Phase 3: Recurring Scheduling
- [ ] 3.1 Daily recurrence (anchor-based, wall-clock time, IANA timezone)
- [ ] 3.2 Every-X-days recurrence
- [ ] 3.3 Weekday recurrence
- [ ] 3.4 Catch-up policies: `grace` (default 24h), `run-on-next`, `skip`
- [ ] 3.5 Maximum overdue age (default 7 days → `expired`)
- [ ] 3.6 Duplicate prevention (idempotency key, atomic claim)

### Phase 4: Model-Aware Execution Queue
- [ ] 4.1 Scheduler integrates with `engineLifecycle` turn lease
- [ ] 4.2 `ensureModelAvailable(targetModelPath)` — waits for lease, loads model
- [ ] 4.3 Fallback chain resolution (primary → fallback1 → fallback2…)
- [ ] 4.4 VRAM conflict detection via `assessGpuFit` before load attempt
- [ ] 4.5 Clear blocked/waiting states in run record (`waiting_for_model`, `waiting_for_lease`, `vram_conflict`)

### Phase 5: UI & Notifications
- [ ] 5.1 IPC channels: `scheduled-task:*` (list, create, update, delete, enable, run-now, history)
- [ ] 5.2 Preload bindings in `src/preload.js`
- [ ] 5.3 Scheduled Tasks panel (sidebar section)
- [ ] 5.4 Task editor (prompt, recurrence, model, fallback, permission, budget, catch-up)
- [ ] 5.5 Run history view (status, timestamps, model used, fallback used, output, error)
- [ ] 5.6 Desktop notifications for completion/failure/blocked (reuse `notificationService`)

### Phase 6: Reliability & Validation
- [ ] 6.1 App restart recovery test (tasks survive, no duplicate runs)
- [ ] 6.2 PC sleep/wake reconciliation test
- [ ] 6.3 Multiple overdue tasks at startup (startup cap, grace window)
- [ ] 6.4 Missing/unavailable model handling
- [ ] 6.5 Insufficient VRAM → fallback → skip with notification
- [ ] 6.6 Active agent turn during scheduled model switch (lease wait)
- [ ] 6.7 Provider/network failure handling (cloud fallback only if explicitly configured)
- [ ] 6.8 Duplicate execution prevention under concurrent triggers

---

## 9. Database Schema (Proposed)

```sql
-- In db.js SCHEMA, additive migration pattern
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  model_ref_json TEXT NOT NULL,           -- {kind: 'local'|'cloud', modelPath|provider+modelId, config?}
  fallback_json TEXT,                     -- ordered array: [{kind, modelPath}|{kind, provider, modelId}|'any-loaded']
  recurrence_json TEXT NOT NULL,          -- {type: 'once'|'daily'|'every_n_days'|'weekdays', atTime?, startDate?, endDate?, maxOccurrences?, intervalDays?, weekdays?:[0-6]}
  timezone TEXT NOT NULL,                 -- IANA, e.g., 'America/Los_Angeles'
  next_run_at INTEGER NOT NULL,           -- epoch ms UTC
  last_run_at INTEGER,
  last_status TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'read_only', -- read_only|workspace_write|ask_approval|full_access
  budget_json TEXT,                       -- {maxTurns?, maxToolCalls?, maxWallClockMs?}
  catchup_json TEXT NOT NULL,             -- {policy: 'grace'|'run_on_next'|'skip', graceHours: 24, maxOverdueDays: 7}
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  scheduled_for INTEGER NOT NULL,         -- epoch ms UTC (the occurrence this run represents)
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL,                   -- queued|waiting_for_model|waiting_for_lease|running|completed|failed|skipped|missed|interrupted|expired|cancelled
  failure_reason TEXT,
  model_used_json TEXT,                   -- {kind, modelPath|provider+modelId, fallbackUsed: boolean}
  usage_json TEXT,                        -- token usage, cost, duration
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status ON scheduled_task_runs(status);
```

---

## 10. Recurrence Calculation Module (`scheduleCalc.cjs`)

**Pure JS, zero dependencies, fully unit-testable.**

```javascript
// Exports:
function computeNextOccurrence(anchor, recurrence, timezone, after) // returns epoch ms UTC
function evaluateCatchUp(task, now, lastCompletedAnchor) // returns {action: 'run'|'missed'|'skip'|'expired', reason}
function isOverdue(task, now, maxOverdueDays) // boolean
function getOccurrencesInRange(task, start, end) // for debugging/UI
```

**Anchor-based semantics:** `next_run_at` always derived from `startDate` + `n * interval`, never from `last_run_at`. Prevents drift.

**DST handling:**
- Spring forward (02:30 missing) → fire at first instant ≥ intended wall time (03:00).
- Fall back (01:30 ambiguous) → fire once at first instance (standard time).

**Timezone:** Stored as IANA string. `Intl.DateTimeFormat(undefined, {timeZone}).formatToParts()` for wall-clock extraction. UTC storage for `next_run_at`.

---

## 11. Decision Confirmation Needed

Before implementation begins, please confirm the following (from the draft plan §11):

| # | Decision | Recommended Default |
|---|----------|---------------------|
| 1 | PC off at scheduled time | **`grace`, 24h**: execute on activation if missed ≤24h; otherwise record `missed` and advance |
| 2 | VRAM conflict (scheduled model cannot load) | **Skip with notification** — never evict user's loaded model; optional per-task fallback chain |
| 3 | Fallback chain entries | Specific local model, `any-loaded`, cloud provider+model |
| 4 | Startup auto-run cap after long absence | **5** tasks auto-run; rest `skipped` + manual Run now |
| 5 | Permission ceiling for scheduled runs | **Per-task opt-in, default Read Only** |
| 6 | UI placement | **Sidebar section** (next to Memory Palace / Settings) |

---

## 12. File Inventory (New / Modified)

### New Files
| File | Purpose |
|------|---------|
| `src/lib/scheduleCalc.cjs` | Pure recurrence + catch-up math |
| `src/main/scheduledTasks.js` | Store + scheduler core |
| `src/main/chatTurnRunner.js` | Extracted renderer-agnostic turn executor |
| `tests/schedule.test.js` | Unit tests for scheduleCalc (injected clock) |

### Modified Files
| File | Changes |
|------|---------|
| `src/main/db.js` | Add `scheduled_tasks` + `scheduled_task_runs` tables + migrations |
| `src/main/engineLifecycle.js` | Add `acquireTurnLease`/`releaseTurnLease`/`waitForTurnLeaseRelease`/`hasActiveTurnLease` |
| `src/main/engineManager.js` | Minor: ensure `launchModel` reusable by scheduler |
| `src/main/ipcHandlers.js` | Add `scheduled-task:*` handlers |
| `src/preload.js` | Add `scheduledTask` API bindings |
| `main.js` | Initialize scheduler on `app.whenReady()`, register `powerMonitor` resume |
| `src/main/services/notificationService.js` | Add notification types for scheduled tasks (optional) |
| Renderer components | Scheduled Tasks panel + editor + history (React) |

---

## 13. Next Steps

1. **Confirm decisions** in §11 above.
2. **Approve this plan** — then Phase 1 implementation begins.
3. **Phase 1 deliverable:** Working `chatTurnRunner` + turn lease + test demonstrating user turn blocks scheduled model switch.

---

*Assessment complete. Awaiting decision confirmation before implementation.*