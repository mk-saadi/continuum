# Scheduled Task Model Swap Implementation Prompt

## Objective
Implement intelligent model swapping for scheduled tasks: when a scheduled task needs a different local model than what's currently loaded, automatically swap models (unload current, load task model, run task, restore previous) with proper VRAM awareness and turn-lease safety.

## Current State
- `prepareModelForTask` in `src/main/scheduledTasks.js` loads task model alongside existing engines
- `engine-idle-policy` unloads idle models after timeout (default: disabled)
- `preflightGpuFit` warns but doesn't block if VRAM tight (advisory only)
- Scheduled runs wait for `modelLeaseWaitMs` (10 min) for active turns

## Requirements

### Core Swap Logic
1. **Only for local→local**: If task model is cloud, never unload local model
2. **Same model = no-op**: If `task.modelPath === activeModelPath`, use existing engine
3. **VRAM check first**: Before unloading, query GPU memory. If `freeVRAM ≥ taskModelEstimate + safetyMargin`, skip swap and load alongside
4. **Idle check**: Only unload if target model has **no active turn lease** (`!lifecycle.hasActiveTurnLease`)
5. **Wait if busy**: If target model has active turn, wait for lease release (bounded by `modelLeaseWaitMs`, then `vram_conflict` skip)
6. **Atomic swap**: Unload current → load task model → run → unload task → reload previous
7. **Saved preferences**: Both unload/load use each model's saved `loadConfig` (context, gpuOffload, etc.)

### State Tracking
```js
// New scheduler option
unloadIdleForScheduledTask: true | 'vram-pressure' | false  // default false
```
- `true`: always swap when models differ
- `'vram-pressure'`: only swap if preflight says insufficient
- `false`: current behavior (load alongside)

Track in `active` run object:
```js
active.swappedModel = { modelPath, config, wasLoaded };  // for restoration
```

### Preflight Integration
Use existing `preflightGpuFit` + `queryGpuMemory` + `estimateOffloadRequirements`:
- If `fit.status !== 'insufficient'` → load alongside (no swap)
- If `fit.status === 'insufficient'` AND `unloadIdleForScheduledTask !== false` → attempt swap
- If swap not possible (busy, disabled) → `requiresConfirmation: true` / `vram_conflict` skip

### Restoration Guarantees
- `try/finally` in `executeRun` restores previous model even on failure/cancel/shutdown
- If previous model was **not loaded** before task, don't restore (leave unloaded)
- If previous model fails to reload → log warning, don't crash
- Restoration uses previous model's saved `loadConfig` + `mmprojPath`

### Edge Cases to Handle
| Case | Behavior |
|------|----------|
| Task model = already loaded | Use existing, no swap, no restore |
| Cloud task model | Never unload local, run directly |
| Local task model, no model loaded | Load task, no restore needed |
| Previous model unloaded by idle timeout during task | Don't restore (it's already gone) |
| Task model fails to load after unload previous | Report load failure, attempt restore previous |
| App shutdown during task | `markInterruptedSync` handles; restoration best-effort |
| Multiple scheduled tasks queued | Each runs serially; swap/restore per task |
| Task has fallback models | Swap logic applies to each fallback attempt |
| User manually loads model during task | User action wins; scheduler doesn't fight |
| Multi-GPU: task fits on GPU 1, current on GPU 0 | `queryGpuMemory` returns per-GPU; swap only if **target GPU** insufficient |
| Partial offload configured | Preflight respects `gpuOffload` setting; swap only if full offload needed and won't fit |

## Implementation Locations

### 1. `src/main/scheduledTasks.js`
- Add `unloadIdleForScheduledTask` option to `createScheduler`
- New helper: `trySwapForTaskModel(task, activeModelPath, signal)`
  - Returns `{ ok: true, swappedOut: previousModelInfo }` or `{ ok: false, reason }`
- Integrate in `prepareModelForTask` after lease wait, before launch
- Track `active.swappedModel` for restoration in `executeRun` finally block

### 2. `src/main/main.js` (or new module)
- `unloadModel(modelPath, reason)` — already exists as `stopEngine` / IPC `engine:unload`
- `loadModelWithPrefs(modelPath, config)` — wrapper around `launchModel` with saved prefs

### 3. `src/main/gpuMemory.js` (existing)
- `queryGpuMemory()` returns per-GPU free VRAM
- Ensure `estimateOffloadRequirements` uses correct GPU index

## Tests to Add (in `tests/scheduledTasks.test.cjs`)

```js
test('swap: local task model replaces idle loaded model and restores after', async () => { ... })
test('swap: cloud task model never unloads local model', async () => { ... })
test('swap: same model already loaded uses existing engine', async () => { ... })
test('swap: ample VRAM loads alongside without swap', async () => { ... })
test('swap: busy model waits for lease then swaps', async () => { ... })
test('swap: busy model times out → vram_conflict skip', async () => { ... })
test('swap: task model load failure attempts restore previous', async () => { ... })
test('swap: previous model was unloaded during task → no restore', async () => { ... })
test('swap: multi-GPU fits on free GPU → no swap', async () => { ... })
test('swap: disabled option falls back to load-alongside', async () => { ... })
test('swap: fallback model also follows swap logic', async () => { ... })
```

## Config Defaults
```js
const DEFAULT_UNLOAD_IDLE_FOR_TASK = false;  // opt-in only
const DEFAULT_SWAP_WAIT_MS = 10 * 60 * 1000; // reuse modelLeaseWaitMs
```

## Acceptance Criteria
1. All new tests pass
2. Existing scheduled task tests still pass
3. Manual model load/unload still works
4. No regression in `engineLaunch.test.cjs`
5. VRAM pressure scenario: Swift (27B@75k) loaded, Qwen (27B@75k) task → swap occurs, task runs, Swift restored
6. Ample VRAM scenario: small model loaded, large task model fits alongside → no swap

## Out of Scope
- Auto-enable based on VRAM pressure (user must opt in)
- Swapping for manual "Run Now" (only scheduled)
- Moving models between GPUs
- Partial offload as alternative to swap (preflight already handles)

---

**Prompt for agent:** "Implement the above. Start with the option flag and `trySwapForTaskModel` helper, then wire into `prepareModelForTask` and `executeRun` restoration. Add tests. Keep changes minimal and focused."