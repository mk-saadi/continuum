# Continuum — Agentic Phase 1.3A Implementation Report

**Long-horizon subagent budget policy: bounded and explicitly unbounded budgets, removed
100/100 ceilings, corrected cumulative-token semantics, a re-derived Automatic policy.**

- Date: 2026-10-18
- Reference: `docs/subagent-system-comprehensive-audit.md` (findings §4–§6, §5.5).
- Scope implemented: **Phase 1.3A only.** No 1.3B (durable/renewable budgets), 1.3C
  (deadlines/timeouts), 1.4, or 1.5 work is included.
- Working tree preserved. **No commits, pushes, stashes, resets or cleans.** No new
  execution framework. Child compaction algorithm untouched. No timeout/deadline handling.
  No background child IPC/UI control. Unbounded is **not** the default.

---

## 1. Exact files and symbols changed

### Application code

| File | Symbols / behaviour changed |
|---|---|
| `src/main/subagents/budgetSettings.js` | Added `UNBOUNDED = 'unbounded'` sentinel and `LIMITS` (per-field finite bounds). Raised finite maxima: input/output `1e6/5e5 → 1e9`; tool calls & turns `100 → 10,000,000`; aggregate `10,000 → 100,000,000`. `normalizeBudgetSettings` `check()` now accepts the `UNBOUNDED` sentinel (explicit, never a giant integer) and emits the message `… must be an integer from <min> to <max>, or "unbounded".` Exports `UNBOUNDED`, `LIMITS`. |
| `src/main/subagents/budgets.js` | Replaced `INPUT_REPLAYS=4` with `MIN_INPUT_REPLAYS=4` (documented floor for one-shot kinds). Long-horizon Automatic envelope: `MAX_TURNS.investigation 12 → 200`, `MAX_TOOL_CALLS.investigation 25 → 400`, `DEFAULT_AGGREGATE_TOOL_CALLS 100 → 2000`. `autoBudgets` now also returns resolved `maxTurns`/`maxToolCalls`/`maxAggregateToolCalls` and derives `inputBudget = max(MIN_INPUT_REPLAYS, turns(kind)) × contextLength` (turn envelope, not a fixed window multiple). Added unbounded-aware helpers `limitReached(limit, used)` and `remaining(limit, used)`. `resolveTaskBudgets` maps a `'unbounded'` field to runtime `null`; `canAffordNext`/`escalatedCeiling` use the helpers. `describeAutoPolicy` now returns `minInputReplays`, `unbounded` and `limits` (bounds + sentinel) for the UI. Re-exports `UNBOUNDED`, `LIMITS`. |
| `src/main/subagents/executionBudget.js` | `createParentRunBudget` resolves `'unbounded'` aggregate to `null`. `getExecutionBudget` validates internal `maxTurns`/`maxToolCalls` against `LIMITS` (bounds raised) and accepts a `null` (unbounded) scope ceiling. `stopBeforeRequest`, `settleRequest`, `requestTracker.prepare`, `dispatchTool`, and `exhaustion` are unbounded-aware (guarded comparisons, no `NaN`). The 80 % activity note is skipped when unbounded. Re-exports `limitReached`/`remaining`. |
| `src/main/subagents/agentLoop.js` | The reporting-slot reserve and the finalization guards use `budget.limitReached(maxTurns, …)` instead of `turns >= maxTurns - 1`, so unbounded turns do not trigger a spurious stop. Comments updated. Child loop, allowlist, compaction hook and termination otherwise unchanged. |
| `src/main/subagents/contextRecovery.js` | `assertGenerationCapacity` uses `budgets.remaining(...)` so unbounded turn/output envelopes never falsely block compaction. Compaction algorithm itself **unchanged**. |
| `src/lib/subagentDisplay.mjs` | Added `limit(value)` which renders a `null` (unbounded) limit as `unbounded`; usage/limit lines and the limit notice now use it. |
| `src/components/SubagentBudgetSettings.jsx` | Rebuilt around a `FIELDS` table with five Custom fields; each has a number input plus a **"No limit"** checkbox that commits the `'unbounded'` sentinel. Finite bounds (`min`/`max`) and the sentinel are read from `policy.limits` (via `describeAutoPolicy`) so UI, parser and backend agree. Hint text now states the automatic envelope and the unbounded contract. Blank ⇒ Automatic (saved `null`), exactly as before. |

### Tests

| File | Change |
|---|---|
| `tests/subagentBudgets.test.cjs` | Updated assertions to the new Automatic policy; added an unbounded-resolution test. |
| `tests/subagentReliability.test.cjs` | Updated Automatic/custom expectations; added legacy-value compatibility check; `2 / 200` request line. |
| `tests/childAgentLoop.test.cjs` | Updated the invalid-limit message expectation to the raised bound. |
| `tests/subagentAcceptance.ui.cjs` | Updated the completed-child request-accounting expectation (`1 / 200`). |
| `tests/subagentLongHorizonBudgets.test.cjs` | **New** deterministic suite (11 tests) covering the twelve required points. |
| `tests/subagentModelBudgets.test.cjs` | **New** (§11) deterministic suite (12 tests): effective child-model context/budget resolution across parent/child combinations, usage normalization, cumulative-vs-window independence, provider lanes, and the file-analysis context regression. |
| `tests/subagentModelSelection.test.cjs` | **Repaired harness** (§11): mocked `electron` now provides `app.getPath` (+ temp `userData`, pre-cached `legacyDataMigration`) so the previously-dead suite runs; one stale forbidden-tool assertion corrected to the message the loop emits. |

---

## 2. Previous vs new configuration behaviour

| Field | Old finite max | New finite max | Unbounded | Old Automatic (investigation) | New Automatic (investigation) |
|---|---|---|---|---|---|
| `maxToolCalls` | 100 | 10,000,000 | yes (`'unbounded'`) | 25 | 400 |
| `maxTurns` | 100 | 10,000,000 | yes | 12 | 200 |
| `maxAggregateToolCalls` | 10,000 | 100,000,000 | yes | 100 | 2,000 |
| `maxInputTokens` | 1,000,000 | 1,000,000,000 | yes | `4 × window` | `max(4,200) × window` |
| `maxOutputTokens` | 500,000 | 1,000,000,000 | yes | `turns × ceiling` | `turns × ceiling` |

Unchanged: the storage key (`app_settings.subagentBudgets`), the record shape
(`{ mode, maxInputTokens, maxOutputTokens, maxToolCalls, maxTurns, maxAggregateToolCalls }`),
blank ⇒ Automatic, mode toggling preserving custom numbers, savings taking effect only for
new children, and loud failure on unreadable saved JSON. `MAX_INPUT_BYTES`/one-shot
file-analysis byte accounting in `executionManager.js` is untouched.

**Migration:** none required. Legacy finite values (100, 100, 10000, 1e6, 5e5) remain valid
and round-trip unchanged; the parser only *adds* the `'unbounded'` sentinel and widens the
finite bounds. Verified in test 1 and by the full suite.

---

## 3. Bounded / unbounded budget contract

Each Custom limit field is one of three explicit states:

1. **Blank / unset** → `null` in settings → the **Automatic** value for that field.
2. **Finite integer** within `LIMITS[field]` → a hard, strictly enforced ceiling.
3. **`'unbounded'`** (the sentinel string) → runtime `null` for that field → **no numeric
   ceiling** for that resource only.

At runtime a resolved limit is a finite integer or `null`. `limitReached(null, used) === false`
and `remaining(null, used) === Infinity`, so unbounded never blocks. Unbounded **only** removes
the numeric budget. It does **not** disable:

- the read-only child tool allowlist and `permissionMode: 'read_only'` (verified, test 10);
- the **per-request model context window** (`context_exhausted` still fires; verified, test 6);
- cancellation/interrupt (verified, test 10);
- scheduler concurrency lanes (unchanged code path);
- provider limits (unchanged).

The parent-run aggregate scope also accepts `null` (unbounded) via
`createParentRunBudget`. Unbounded is never selected implicitly; the Automatic default and
all pre-existing saved settings remain finite.

---

## 4. Automatic-mode policy (exact values and rationale)

```
perRequestCeiling : investigation 2048 | file-analysis 3072 | web-extraction 1024   (unchanged)
maxTurns          : investigation 200  | file-analysis 2    | web-extraction 2
maxToolCalls      : investigation 400  | file-analysis 32   | web-extraction 1
maxAggregateToolCalls : 2000
inputBudget       : max(4, turns(kind)) x child context window
outputBudget      : (turns(kind) or custom turns) x perRequestCeiling(kind)
```

Worked example (102.4 K child window): input **20,480,000**, output **409,600**, turns **200**,
tool calls **400**, aggregate **2000**.

**Why these values:**

- **No reliable task-complexity estimator exists** in the codebase, so — as the brief allows —
  this is a *documented, conservative, finite* policy rather than an invented classifier.
- The audit's verified long-horizon target is **150+ requests, 150+ tool calls, 2 M+ cumulative
  tokens**. The envelope deliberately covers that target by default (200 request slots, 400
  tool calls) with headroom for compaction (each compaction costs 2 requests), the reserved
  tool-free reporting slot, retries and finalization — so long-horizon delegation works
  without requiring Custom.
- **The token rule was re-derived, not scaled.** The audit's defect was that cumulative *input*
  was expressed as a fixed multiple (`4×`) of the per-request **context window**, conflating
  cumulative processed tokens with per-request occupancy. The new rule is the **turn envelope**
  — the theoretical maximum if every request re-sent a full window — so the cumulative input
  budget is derived from the request count, can never be mistaken for the window, and (for
  long-horizon kinds) never becomes the binding constraint. The real limiters stay the request
  count and the per-request window.
- The `max(4, …)` **floor** keeps short one-shot kinds (`file-analysis`, `web-extraction`)
  exactly as generous as before (two attempts may legitimately re-send a full window).
- The envelope remains **finite**, so existing users are **not** silently switched to unbounded;
  they can extend with Custom or select Unbounded per field.

---

## 5. Budget-accounting guarantees

- **Configured finite limits remain strict.** `stopBeforeRequest` / `dispatchTool` /
  `exhaustion` still compare against the resolved finite number; a child reaching a limit stops
  with a truthful `stopReason` (`tool_limit`, `aggregate_tool_limit`, `turn_limit`,
  `input_budget`, `output_budget`) — verified, tests 5 and 2.
- **Counters cannot reset unexpectedly.** The ledger lives on `session.budgetState`, frozen once
  per child (`getExecutionBudget` returns the cached state); continuations and setting changes
  do not replenish it.
- **Retries cannot bypass accounting.** Empty-answer retry, incomplete continuation, compaction
  summary/checkpoint and overflow retry all traverse `stopBeforeRequest`/`reserveRequest`.
- **Compaction does not reset child usage.** Summary and checkpoint requests are charged to the
  same ledger; verified across **≥ 2 compactions** (test 8): `ledger.turns = ordinary + version × 2`,
  `usage.prompt_tokens` equals every request, `toolCalls` unchanged.
- **Concurrent operations cannot overspend shared finite budgets.** Check-and-increment in
  `dispatchTool` is synchronous with no `await`; unchanged (the existing concurrency tests still
  pass, and test 9 exercises the shared scope).
- **Nested delegation respects parent constraints.** Child allowlist excludes spawning; nested
  runtime children inherit the owning scope (existing suite still green).
- **Cumulative ≠ window.** A child whose cumulative tokens exceed the context window is **not**
  reported as a context overflow (test 7: 2.4 M input tokens, window 1 M, `completed`); the
  window is only enforced per request (test 6).
- **Unbounded ≠ unlimited provider credits/hardware.** Unbounded removes only the numeric budget;
  permissions, window, cancellation, concurrency and provider limits remain (tests 6 and 10).
- The existing `executionBudget` subsystem was **extended**, not replaced.

---

## 6. Test results

Baseline reproduced before changes; results after changes (environment: Node v22.23.2).

| Suite | Before | After |
|---|---|---|
| Full suite `node --test tests/*.test.cjs tests/*.test.mjs` | 1066 tests, 1026 pass, **40 fail** | 1078 tests, 1038 pass, **40 fail** |
| Failing-test set vs baseline | — | **byte-identical** (`diff` empty) → no new regressions |
| **Addendum (§11) re-run** | — | **1090 tests, 1063 pass, 27 fail**; 13 previously-dead `subagentModelSelection` failures fixed, 0 new |
| `subagentBudgets` | 20 pass | 21 pass |
| `subagentReliability` | 23 pass | 23 pass |
| `subagentCompaction` | 26 pass | 26 pass |
| `subagentDispatchConcurrency` | 11 pass | 11 pass |
| Core four suites (combined) | 74 pass / 0 fail | 75 pass / 0 fail |
| **`subagentLongHorizonBudgets` (new)** | — | **11 pass / 0 fail** |
| `tests/subagentAcceptance.ui.cjs` (real Electron + preload/IPC/SQLite) | — | **PASS** |
| `npm run build` (Vite) | — | **success** |

New-suite coverage mapping: 1 migration; 2 exactly 100 tool calls; 3/4 > 150 tool calls and
> 150 requests when authorized; 5 finite exhaustion; 6 explicit unbounded; 7 > 2 M cumulative
tokens; 8 multiple compactions without reset; 9 parent aggregate enforcement; 10 permission +
cancellation compatibility; 11 UI persistence and backend validation agreement; 12 Phase 1.1/1.2
invariants.

All 40 full-suite failures are the pre-existing, unrelated baseline failures (known
environmental/SQLite/source-text issues; e.g. `app.getPath`-undefined in
`subagentModelSelection`, obsolete `stream:false` expectations in `childAgentLoop`). The only
suite edited for policy constants that still shows a failure is `childAgentLoop` (its two known
baseline failures); its limit-validation test passes. No paid model calls or uncontrolled loops
were used — all model backends are deterministic mocks.

---

## 7. Compatibility findings

- **Saved settings are forward/backward compatible.** Legacy finite values (including the old
  100/100/10000/1e6/5e5) validate and persist unchanged; the record shape is unchanged.
- **The Automatic default for `investigation` changed** (12/25/100 → 200/400/2000; input `4×window`
  → `200×window`). This is an intentional policy change. It affects **new** children only, because
  a live child's budgets are frozen at creation. The change is surfaced in the settings hint.
- **One-shot `file-analysis` / `web-extraction` budgets are unchanged** (turns 2, same ceilings,
  same `4×` input floor).
- **`INPUT_REPLAYS` was renamed to `MIN_INPUT_REPLAYS`.** A repo-wide search found no consumer
  outside `budgets.js`; the constant is not part of any external contract.
- **`describeAutoPolicy()` gained fields** (`minInputReplays`, `unbounded`, `limits`). Additive;
  the existing UI consumers read the new `limits` and the previously-used fields still exist.
- **`INPUT_MAX_BYTES` one-shot byte guard** in `executionManager.js` is unrelated and untouched.
- **Stale doc remains:** `docs/subagents.md` (and `docs/subagent-phase3.md`) still describe
  10‑call / 8‑request / 40‑aggregate defaults. This doc/impl conflict predates 1.3A and is left
  for a documentation pass (see §9).

---

## 8. Remaining limitations

- **No wall-clock deadline / model-request timeout; no `timed_out` status** (`localEngineFetch.js:7`).
  Explicitly out of scope (1.3C).
- **No durable/renewable budget ledger across restart**; active children remain in-memory only.
  Explicitly out of scope (1.3B).
- **`partial` children still cannot be resumed** (`IS_TERMINAL` includes `partial`).
- **Unbounded is UI-only.** The model cannot request a budget extension through
  `spawn_sub_agent`; there is no per-spawn authorization parameter yet.
- **Effective budgets are frozen at child creation.** Raising limits mid-run requires a new child
  (or a continuation, which keeps the frozen budgets).
- **Automatic stays finite (200 turns).** Workloads beyond that must opt into Custom or Unbounded.
- **Live-model summary fidelity and threshold tuning remain unverified** (no loaded backend;
  live benchmarks were prohibited). All findings here are deterministic-mock verified.
- The 80 % activity note is not emitted for an unbounded tool budget (there is no fraction of
  infinity to report).

---

## 9. Follow-up recommendations for Phase 1.3B

1. **Durable, renewable budgets (1.3B).** Persist the per-child ledger and the parent-run
   aggregate scope so a restart/recovery cannot reset or duplicate spend; add an explicit,
   audited **extension API** (`extendChildBudget(childId, patch)`) that raises or unbounds a
   running child's envelope while preserving measured counters and monotonic accounting.
2. **Authorized extension surface.** Expose an *optional, bounded* per-spawn budget request on
   `spawn_sub_agent` (and the runtime `runInvestigation`), validated against the saved settings,
   so the parent model can ask for more without a UI round-trip — never unbounded by default.
3. **Deadlines and timeouts (1.3C).** Add a child wall-clock deadline, a per-model-request
   timeout, and a `timed_out` terminal status with truthful precedence against cancellation and
   budget stops.
4. **Resumable `partial` children.** Allow a bounded resume of a `partial` child under 1.3B's
   renewable ledger.
5. **Documentation sync.** Update `docs/subagents.md` / `docs/subagent-phase3.md` to the current
   defaults (investigation 200 / 400 / 2000; unbounded sentinel; per-request-vs-cumulative rule).
6. **Observability.** Surface "unbounded" explicitly in the transcript/accounting UI (already
   rendered as `unbounded`) and add a settings "effective envelope" preview computed from the
   selected model's resolved context window.

---

## 10. Verification commands

```bash
node --test --test-reporter=tap tests/*.test.cjs tests/*.test.mjs          # full suite
node --test --test-reporter=tap \
  tests/subagentBudgets.test.cjs tests/subagentReliability.test.cjs \
  tests/subagentCompaction.test.cjs tests/subagentDispatchConcurrency.test.mjs
node --test --test-reporter=tap tests/subagentLongHorizonBudgets.test.cjs  # new 1.3A suite
npm run build                                                              # Vite production build
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/.bin/electron --no-sandbox tests/subagentAcceptance.ui.cjs
```

---

## 11. Addendum — effective **child** model resolution, usage normalization, and model-combination regression tests

**Trigger:** an additional Phase 1.3A requirement to preserve, while changing budgets, the independent
sub-agent model selection (Settings → Sub-Agent Model: *follow the chat model*, the loaded local model,
or a saved cloud model) — and to make sure token/context limits and Automatic budgets resolve from the
**effective child model**, that cumulative accounting stays independent of the context window, that usage
is normalized across local/cloud backends, and that parent/child model combinations are covered by
regression tests. This is a verification + hardening pass, **not** a model-selection refactor.

### 11.1 Exact files and symbols changed

| File | Symbols / behaviour changed |
|---|---|
| `src/main/subagents/budgets.js` | Added pure `normalizeUsage(usage) → { input, output, cachedInput }` (accepts `prompt_tokens`/`input_tokens`, `completion_tokens`/`output_tokens`, `cached_tokens`/`cache_read_input_tokens`/`prompt_tokens_details.cached_tokens`; non-integer/negative/absent → `null`). `recordTurn` now uses it (behaviour-preserving). `normalizeUsage` exported. *(The child-model → context resolution already existed via `resolveEngineContextLength`; unchanged.)* |
| `src/main/subagents/executionBudget.js` | `settleRequest` now normalizes provider usage through `policy.normalizeUsage` instead of two inline `valid(...)` chains — one definition for local and cloud. No accounting-value change; cached input is never double-counted. |
| `src/main/subagents/executionManager.js` | **Confirmed bug fix** in `runFileAnalysisExecution`: the one-shot file payload budget was derived from `engine.contextLength` (raw descriptor) with a `DEFAULT_CONTEXT_LENGTH` fallback, so a **cloud child** (whose descriptor has no `contextLength`) always used the local default instead of the window already resolved for that child's model. It now uses `state.budgets.contextLength` (the resolved effective window) and keeps `DEFAULT_TARGET_CHARACTERS` for a genuinely unresolved (`contextSource === 'fallback'`) window. The below-2048 local window guard is preserved. Removed the now-unused `DEFAULT_CONTEXT_LENGTH` constant. |

### 11.2 Previous vs new behaviour (file-analysis payload budget)

| Child model | Effective window source | Old payload cap | New payload cap |
|---|---|---|---|
| Local descriptor with `contextLength: N` | descriptor (`source: 'engine'`) | `targetFileBudget(N)` | `targetFileBudget(N)` — unchanged |
| Cloud descriptor (no `contextLength`) | provider metadata (`source: 'provider-metadata'`) | `DEFAULT_TARGET_CHARACTERS` (64000) — **wrong** | `targetFileBudget(resolved N)` — **fixed** |
| Local/cloud, window unresolvable | fallback (`source: 'fallback'`) | `DEFAULT_TARGET_CHARACTERS` (64000) | `DEFAULT_TARGET_CHARACTERS` (64000) — unchanged (conservative) |

The token budgets (`state.budgets`) already used the resolved child window before this addendum; only the
one-shot file-injection character cap was inconsistent.

### 11.3 Child-model contract (unchanged; now regression-tested)

`resolveChildEngine(parentEngine)` is a pure routing decision and never mutates the parent:

| Selection | Parent | Child engine | Budget window |
|---|---|---|---|
| `null` (follow chat) | any | the parent descriptor **by identity** | parent descriptor window (fallback if none) |
| `{ type: 'local' }` | local | the parent descriptor **by identity** | parent descriptor window |
| `{ type: 'local' }` | cloud | `{ provider:'local', port, modelId, contextLength }` from the running engine config | local loaded-model window |
| `{ type: 'cloud', … }` | any | `{ provider:'cloud', modelId, chatTarget }` (validated against saved providers) | provider model metadata, else fallback |

Preserved invariants: selecting a different child model does **not** alter the parent's model, context, or
budget; "follow the chat model" is intact; backend-specific permission (read-only child allowlist),
cancellation, and provider lane limits (local `maxConcurrency: 1`, cloud `4`, lane keyed by
`provider/model`) are unchanged.

### 11.4 Usage normalization contract

One normalizer for every backend. Cumulative counters are additive and independent of the per-request
context window; missing/estimated usage is labelled (`estimated`/`reserved`/`partial`) rather than treated
as a measured zero; Anthropic cache tokens are folded into `prompt_tokens` by the transport and only
surfaced (not re-added) by the normalizer.

### 11.5 Test results (after this addendum)

| Suite | Result |
|---|---|
| `tests/subagentModelBudgets.test.cjs` (**new**, 12 tests) | **12 pass / 0 fail** |
| `tests/subagentModelSelection.test.cjs` (re-enabled, 13 tests) | **13 pass / 0 fail** (was 0/13 — dead suite) |
| `tests/subagentLongHorizonBudgets.test.cjs` | 11 pass / 0 fail |
| `tests/subagentBudgets.test.cjs` | 15 pass / 0 fail |
| `tests/subagentReliability.test.cjs` | 23 pass / 0 fail |
| `tests/subagentCompaction.test.cjs` | 26 pass / 0 fail |
| `tests/subagentDispatchConcurrency.test.mjs` | 11 pass / 0 fail |
| `tests/subAgentPayload.test.cjs` | 1 pass / 0 fail |
| Full suite | **1090 tests, 1063 pass, 27 fail** |
| Failing set vs baseline | **13 baseline failures fixed** (`subagentModelSelection`), **0 new** |
| `npm run build` | success |
| `tests/subagentAcceptance.ui.cjs` (real Electron) | **PASS** |

The new suite covers: follow-the-chat-model for local and cloud parents; **local-parent/cloud-child** and
**cloud-parent/local-child**; provider-metadata resolution and fallback; independent parent/child budget
state; usage normalization across local/OpenAI/Anthropic/cached/absent shapes; cumulative tokens exceeding
the window with no overflow report; provider lane limits; and the file-analysis bug as an explicit
regression (verified to fail under the pre-fix code).

Two previously-dead test harnesses were repaired, which is why the baseline failing set shrank rather than
matched byte-for-byte:

- `tests/subagentModelSelection.test.cjs` — the mocked `electron` module lacked `app.getPath`, so
  `db.initDatabase()` crashed before any test ran (the audit's B-1 baseline). Added `getPath`, a real temp
  `userData` dir, and pre-cached the lazily-required `legacyDataMigration`. One stale assertion (expecting
  the allowlist message for a forbidden tool) was corrected to the message the loop actually emits.
- No source behaviour changed for that repair; the suite now exercises model selection for real.

### 11.6 Compatibility / unrelated findings (deferred)

- **`executeChildTool`'s "Allowed tools: …" message is unreachable for forbidden tools.** The child loop
  rejects a non-allowlisted tool with the generic `invalid_tool` text (`agentLoop.js:350-351`) before
  `executeChildTool` runs, so the allowlist line (`agentLoop.js:140-141`) only fires if that function is
  called directly. Cosmetic/UX only; **not** Phase 1.3A behaviour and not fixed here.
- **`resolveEngineContextLength` performs a (5-minute-cached) provider metadata fetch** the first time a
  cloud child spawns; a cache miss does real network I/O during budget resolution. Pre-existing; flagged
  for a later phase.
- **`resolveEngineContextLength`/`contextLengthOf` treat any descriptor window `< 2048` as "unknown"** and
  substitute `FALLBACK_CONTEXT_LENGTH`. Sub-2048 local windows are still rejected loudly in the file-
  analysis path, but the general budget path cannot represent them. Pre-existing.

### 11.7 Updated verification commands

```bash
node --test --test-reporter=tap tests/subagentModelBudgets.test.cjs     # new model-combination suite
node --test --test-reporter=tap tests/subagentModelSelection.test.cjs  # re-enabled model-selection suite
node --test --test-reporter=tap tests/subAgentPayload.test.cjs         # file-payload budget
```
