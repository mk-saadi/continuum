# Subagent Runtime Retention — Phase 3 Performance Report

**Scope:** bound in-memory retention of completed subagent runtime records. Four subagent modules touched (two with new deletion primitives, one coordinator, one hook call), one test file added. No architecture change, no new dependencies, no model calls in new tests. Tree preserved (HEAD `6c961b1`, no commits/stashes/resets). Recovery, palace polling, tab state, history queries, transcripts, and bundle untouched. `/tmp/opencode/` untouched.

## 1. Confirmed retention problem

Three process-global maps grew with every delegation and nothing removed entries:
- `sessions` (`sessionManager.js:49`) — full child context, inbox, activity, result/error, usage/accounting, budget state, compaction state.
- `executions` (`executionStore.js:26`) — one record per attempt incl. result strings and controllers.
- `records` (`continuationManager.js:73`) — driver state incl. engine/fetchImpl handles.
`backgroundStore` was already bounded (settle deletes). Per-session activity was already capped (80); the maps themselves were not.

## 2. Lifecycle / ownership

| Map | Contents | Created at | Terminal states | Post-completion readers | Durable copy |
|---|---|---|---|---|---|
| sessions | context, inbox, activity, result, usage, budget, compaction | `openRun` | failed/cancelled/partial; completed/interrupted continuable | transcript (DB fallback), control calls, interrupt (running only) | `persistChildRun` every settlement → `subagent_runs` |
| executions | controller, result, usage, error | `openRun` + driver turns | all five terminal | interrupt (running lookup), persistence snapshot, transcript counts | mirrored into the run row |
| records | options, driving/scheduled, pendingContinuation | `registerChild` (investigation only) | n/a (control state) | send/resume/interrupt, driver | none (in-memory by design) |
| evicted ids | id strings only | on eviction | n/a | `requireSession` error text | n/a |

Cross-references are all child→parent (id strings; one budget-scope pointer), never parent→child objects — evicting a child cannot strand the parent. Driver closures hold object refs but consult `driving`/`scheduled` flags, which block eviction.

## 3. Policy implemented and rationale

`pruneChildSessions({now, ttlMs, maxCompleted})` in `continuationManager.js` (+ `deleteSession`/`noteEvictedChild`/`wasEvictedChild`, `deleteExecutionsForSession`, `runningSessionIds` index keeping pruning O(sessions+executions), explicit expiry error in `requireSession`, amortized trigger at the end of `openRun` — no timers).
- **Never evict:** created/running/waiting, non-empty inbox, running executions, driving/scheduled drivers, `pendingContinuation` (interrupted turn owed a re-drive), missing/unparseable `completedAt`.
- **Evict:** resting (completed/interrupted/failed/cancelled/partial) older than `ttlMs`, plus oldest-first beyond `maxCompleted` (liveness holds, age waived).
- **Defaults:** TTL 30 min, cap 500 completed, evicted-id registry 1000. Test workloads peak ~120 sessions/file and UI transcripts serve from SQLite after eviction; continuation resumes happen within a working session; control calls on evicted ids throw an explicit expired error (transcript still served). Eviction removes session + its executions + its driver record as one unit.
- No payload surgery: dropping `context` while keeping metadata was rejected — resume needs the full context, and DB fallback already renders identical capped turns.

## 4. Protection summary

Running/waiting/inbox/driving records can never match eligibility (status + flags + running-execution index checked per candidate). `backgroundStore.settle → payloadFor` ordering is safe: pruning runs only at spawn, and a just-settled record is never TTL-eligible. Double settlements are status-guarded no-ops; prune is idempotent. Shutdown drops memory by pre-existing design (documented, unchanged). `describeChild` returns null for evicted ids exactly as for unknown ids today (no internal callers).

## 5. Tests and results

- New `node --test tests/subagentRetention.test.cjs` → **13/13**: eligibility, live/inbox protection, isolation, cancel/fail release, continuation preservation + no-op resume, explicit expiry + persisted transcript, parent refs, durable rows, payload release, 1000-session stress bound, option validation, mocked-model spawn hook, evicted-registry hygiene.
- Existing: session/childMessaging/backgroundExecution/runtime/transcript/compaction/failureDiagnostics/inferenceScheduler → 104/105 (sole failure `background children Step 4 isolation`, A/B-proven pre-existing on pristine HEAD); reliability/budgets/display/toolDisplay/childMessaging → 61/61; dispatchConcurrency → 11/11.
- Pre-existing failures confirmed identical on a pristine HEAD worktree (no stash used): `subagentModelSelection` 13/13 (electron-mock `getPath` gap in test hook), `childAgentLoop` 2 (known stream/live-provider), backgroundExecution 1. None touch changed files.
- `npx vite build` ✓ 8.37s. `git diff --check` clean.

## 6. Before/after measurements (deterministic stress, no model calls)

1050 sessions / 1050 executions (1000 aged completed incl. failures/cancels, 30 running, 20 interrupted-owed, ~60KB payloads) → one `pruneChildSessions` (21–24ms) → **50 sessions / 50 executions**; 1000 + 1000 evicted; all running and owed-continuation preserved. Heap with `--expose-gc`: **76.7 → 8.8 MB** (~68MB of payloads collectible — references genuinely released); without forced GC 82.2 → 81.7 MB (normal GC simply hadn't run; reported as-is, no RSS claim). Evicted transcripts still serve from SQLite with task/result intact; `subagent_runs` rows untouched.

## 7. Remaining risks / next target

- One endlessly-resumed live child can still accumulate executions (per-session attempt history intentionally uncapped — transcript counts depend on it).
- TTL/cap values are reasoned, not telemetered; revisit if continuation-after-30-min becomes a real workflow.
- Interrupted-but-abandoned children occupy the cap until TTL expiry (uniform rule, documented).
- Next most valuable: transcript virtualization / message-list rendering (largest steady-state renderer cost per the earlier audit).
