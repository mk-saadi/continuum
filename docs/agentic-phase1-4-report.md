# Continuum — Agentic Phase 1.4 Implementation Report

**Mid-run subagent context-compaction hardening, recovery-safe compaction, durable
aggregate identity, and a long-horizon deterministic benchmark.**

- Date: 2026-10-19
- Reference brief: Phase 1.4 (context compaction + recovery hardening).
- Prior work preserved: **Phase 1.1** (`run_tests`), **Phase 1.2** (durable plans),
  **Phase 1.3A** (long-horizon budgets, unbounded limits), **Phase 1.3B** (deadlines,
  request timeouts, cancellation propagation, terminal contract), and **Phase 1.3C**
  (durable continuation, renewable budgets, restart recovery).
- Scope implemented: **Phase 1.4 only.** No second compaction mechanism, no second
  task-plan/checkpoint framework, no casual-chat compaction or memory-system changes, no
  daemon/server/cloud infrastructure, no broad UI, no automatic restart execution, and
  **no Phase 1.5 work**.
- Working tree preserved. **No commits, pushes, stashes, resets, or cleans.** All changes
  are uncommitted working-tree modifications plus new files. Baseline HEAD `c1105ca`.

---

## 1. Stop point and scope

Implementation, deterministic tests, full-suite verification, the production build, and
this report are complete. **Phase 1.5 is not started.** Waiting for review.

In scope: harden the *existing* mid-run subagent context-compaction and recovery system so
that (a) a recovered child is re-attached to its own raw history instead of duplicating it,
(b) a recovered child keeps its original finite aggregate rather than silently receiving a
fresh one, (c) repeated compaction does not eventually fail permanently, (d) failure modes
(cancel/timeout/malformed/empty/persistence) leave the last valid transcript intact and
never advertise false success, and (e) a single child can run a long-horizon workload with
many compactions, a budget suspension, an authorized renewal, and an accurate terminal
result.

Out of scope: any rewrite of the compaction pipeline, any new runner, any new
plan/checkpoint framework, and any unrelated subsystem.

---

## 2. Non-goals and constraints honored

- **One compaction mechanism.** The only flow used is the pre-existing
  `contextRecovery.createChildContextAdapter` →
  `compressionEngine.checkAndCompressContext({ transcriptAdapter })` →
  `compactionCore.compactTranscript`. Phase 1.4 changed *inputs and safeguards* to that
  flow; it did not add a parallel engine.
- **Workspace compaction untouched.** `compactionCore.generateCheckpoint`'s retention path
  is activated only when a caller passes `retainPrior`. The Workspace path
  (`compressionEngine` line ~555) never passes it, so the change is child-only.
- **No broad changes** to casual-chat compaction, the memory system, or UI.
- **No automatic execution.** Restart recovery still only rebuilds a child; it never runs it.

---

## 3. Baseline state and reproduction

Independently reproduced before any change (fresh runs, not trusted reports):

| Suite | Result |
| --- | --- |
| Full suite `node --test tests/*.test.cjs tests/*.test.mjs` | 1,147 tests / 1,120 pass / **27 fail** (pre-existing, unrelated) |
| Focused subagent suites | 228 / 228 pass |
| Core 1.3 continuation + compaction suites | 105 / 105 pass |
| `npm run build` | success |

The 27 baseline failures were saved by name (`/tmp/opencode/failing-baseline.txt`) and used
as the identity set for the final regression comparison (§16).

---

## 4. The pipeline under test (untouched flow)

```
parent run
  └─ contextRecovery.createChildContextAdapter(session, messages, state, …)
       ├─ prepare(payload)                     per model turn
       │    └─ compressionEngine.checkAndCompressContext({ transcriptAdapter })
       │         └─ compactionCore.compactTranscript({ adapter, payload, force })
       │              ├─ adapter.snapshot()      candidates / pinned / checkpoint / evidence
       │              ├─ adapter.measure()       exact or fallback token estimate
       │              ├─ summarizeCandidates()   rolling summary
       │              ├─ generateCheckpoint()    structured, evidence-validated state
       │              └─ adapter.commit()        atomically replace active transcript + persist
       ├─ append(message)                      live turns, records raw identity
       └─ commit() → persistence.persistChildRun(session)   terminal mirror
```

The child is read-only (allowlisted tools, `permission_mode = read_only`). Compaction is
shared with Workspace by design, but the child adds `retainPrior`, evidence-linked
checkpoint validation, and a transcript adapter.

---

## 5. Audit findings (Phase 1.4 defect inventory)

Four defects were confirmed by inspection plus targeted probes. Two were the pre-planned
Phase 1.4 fixes; two were discovered by the Step 8 benchmark and fixed because they
directly cap a child's horizon.

1. **D-1 — recovery duplicated the child's own raw history.** `recoverChild` restored
   `row.context` and `row.rawContext` as *new objects* with no `WeakMap` identity, then
   `createChildContextAdapter` re-recorded the restored active projection. Probe
   (`/tmp/opencode/probe-recovery-raw.js`) showed raw history growing `8 → 14` entries on
   recovery, with duplicated assistant `tool_calls` and tool results polluting the
   evidence index. Untested by the existing suite: recovery test 29 never ran a
   post-recovery turn.
2. **D-2 — recovery reset the shared aggregate.** `recoverChild` rebuilt `budgetState`
   with a fresh `createParentRunBudget()`; only `scopeId` was persisted. After a restart, a
   renewed child could therefore be granted more than the pre-restart remaining aggregate
   (the per-invocation rail restarted at zero). The `aggregate_tool_limit` stop itself was
   non-renewable, so this was bounded and explicit-action-gated — but still a real safety
   gap.
3. **D-3 — unbounded checkpoint retention eventually failed compaction permanently.** For a
   child, `generateCheckpoint` unioned every prior checkpoint array entry into each new
   draft. Once any array exceeded the validator's `ARRAY_CAPS`, `validateCheckpoint`
   trimmed it, the fail-closed check saw a `trimmed to …` repair, and returned
   `checkpoint-preservation-too-large` → the child stopped with a terminal
   `compaction_failed`. Probe (`/tmp/opencode/probe-lh.js`) reproduced a permanent stop
   after 15 successful compactions (~18 tool calls remaining in a 150-call budget). This is
   exactly "repeated-compaction reliability" and it capped the Phase 1.4 long-horizon goal.
4. **D-4 — a non-material proactive compaction was terminal.** A pressure-triggered
   compaction that could not reduce the active context by ≥ 10 % returned
   `no-material-reduction`, which `prepare` converted into a permanent `compaction_failed`
   **even though the context still fit** (`before.tokens + before.reserve ≤ limit`). Probe
   (`/tmp/opencode/probe3.js`) reproduced this at the start of a renewed phase.

Findings deferred to Phase 1.5 (recommended, not implemented): a persisted
failed-approaches field (audit D-9 / §1.4c) and a rolling-summary size guard (§18). The
existing checkpoint validator already ties claims to resolvable evidence, so no
reimplementation was needed there (§10).

---

## 6. Fix 1 — restart recovery raw-identity re-attachment

**File:** `src/main/subagents/contextRecovery.js`.

Added a recovery-only identity re-attachment before anything is recorded:

- `rawSignature(message)` — a stable signature (tool → `tool_call_id`; assistant →
  `role + call ids + content`; system/user → `role + content`). Signatures are used only
  during recovery and never leave it.
- `buildRawIdIndex(rawContext)` — buckets existing raw ids by signature (skipping entries
  without a safe-integer id).
- `claimRawId(index, message)` — shifts one matching id in transcript order so repeated
  signatures pair deterministically.

The seed loop now claims each non-derived, not-yet-mapped active message against the index
and records only genuinely unmatched messages:

```js
const rawIndex = buildRawIdIndex(session.rawContext);
for (const m of messages) {
  if (isDerived(m) || session.rawMessageIds.has(m)) continue;
  const claimed = claimRawId(rawIndex, m);
  if (claimed !== null) { session.rawMessageIds.set(m, claimed); continue; }
  record(m);
}
```

No schema change; in-process sessions keep object identity and are unaffected. Only
post-restart sessions benefit, which is precisely the defect.

**Verified (deterministic):** `restart recovery re-attaches raw identity` and
`post-recovery compaction archives the restored foundation` (§16). Post-fix the raw
history, tool-result count, and assistant-call count are unchanged by recovery, and a
post-recovery compaction continues the same `version` chain.

---

## 7. Fix 2 — durable shared-aggregate identity

**Files:** `src/main/subagents/continuationState.js`,
`src/main/subagents/continuationManager.js`.

- `serializeBudgetState` now persists a `scope` snapshot
  `{ id, toolCalls, maxToolCalls }` alongside the existing `scopeId`.
- `restoreScope` reads it defensively; `deserializeBudgetState` rebuilds the scope from the
  snapshot when the caller does not supply a live one.
- `continuationManager.recoverChild` now calls `acquireRecoveredScope(row.budget)` instead
  of `createParentRunBudget()`. The resolver:
  1. reuses a **live** scope with the same id (a sibling of the same parent invocation owns
     the authoritative counter);
  2. reuses a process-local registry entry (bounded to 256) — one reconstructed scope per
     id, so recovered siblings compete for the same allowance rather than each getting a
     copy;
  3. rebuilds `{ id, toolCalls, maxToolCalls }` from the snapshot;
  4. falls back to a configured (`createParentRunBudget`, never "unlimited") aggregate only
     for legacy rows written before Phase 1.4 that carry no snapshot.

Because the reconstructed `maxToolCalls` is the **original** ceiling and `toolCalls` is the
**consumed** count at the last safe boundary, a post-restart renewal can grant only
`maxToolCalls − toolCalls` (bounded further by the remaining aggregate), which is exactly
the pre-restart remaining.

**Verified (deterministic):** `durable budget state persists and restores …`,
`restart recovery keeps the original finite aggregate …`,
`a recovered child at its aggregate ceiling cannot dispatch tools`, and
`recovered siblings … share one reconstructed aggregate` (§16).

---

## 8. Fix 3 — bounded checkpoint retention (repeated-compaction reliability)

**Files:** `src/main/compactionCore.js` (`generateCheckpoint`),
`src/main/taskCheckpoints.js` (exports `ARRAY_CAPS`).

The child-only `retainPrior` merge is now **bounded to the checkpoint schema's own
per-array caps**:

- A prior checkpoint that *already* exceeds a cap is treated as an anomaly and still fails
  closed (`checkpoint-preservation-too-large`). This preserves the existing safety test
  ("large checkpoint that would drop essential prior entries refuses archival") and its
  intent.
- Otherwise the merge keeps the fresh draft's entries first, fills the remainder with the
  **most recent** prior entries, and — only when it must drop entries — records one
  explicit, deduplicated consolidation note in `unknowns` so nothing is lost silently. The
  raw child history remains authoritative and is never pruned.
- `prioritizeRetained` makes the drop order safe: still-**open** outstanding requirements >
  unknown requirements > done; **verified** decisions before unverified; active
  `inProgress` before other history.

Steady state: arrays stabilise at their caps, the checkpoint stays well under
`CHECKPOINT_BYTE_CAP`, and compaction can run indefinitely. Probe (`/tmp/opencode/probe2.js`)
ran 80 compactions / 320 tool calls at both 8 192 and 32 768 windows with **no failure**.

---

## 9. Fix 4 — non-material proactive compaction is a no-op, not a failure

**File:** `src/main/subagents/contextRecovery.js` (`prepare`).

`no-material-reduction` is now treated like `below-threshold` / `protected-context-too-large`
for a proactive (non-forced, still-fitting) compaction: the payload passes through
unchanged. Forced compaction (overflow recovery) and a context that genuinely does not fit
(`before.tokens + before.reserve > limit`) still surface honestly — the former as a bounded
`ContextBudgetError`, the latter as an honest context stop. This removes a false terminal
stop without weakening the overflow path.

---

## 10. Fidelity and source/verification preservation

The existing checkpoint contract was verified, not replaced:

- `validateCheckpoint` requires `completedWork[].sources` to resolve to **successful** tool
  steps; unresolvable claims are demoted.
- `decisions[].verified = true` requires resolvable sources; unverified claims are demoted
  to `unknowns`.
- Every applicable brief id is retained or re-appended as open (repair, never loss).
- Compaction is transactional: candidates are summarised and a checkpoint generated
  *before* anything is committed; `adapter.commit` replaces the active transcript and
  persists only on success.

**Verified (deterministic):** `unverified claims … are demoted`, and
`repeated compaction preserves decisions, requirements and never rewrites completed work`
(§16). The rolling summary is bounded by the summariser contract plus the
`prospective-prompt-exceeds-budget` fit check (§18).

---

## 11. Context pressure and overflow handling

- Pressure-triggered compaction fires at 75 % (78 % for a server tokenizer) and is
  opportunistic: if it cannot materially reduce a still-fitting context it is a no-op
  (Fix 4) and the turn proceeds.
- A confirmed backend context-overflow triggers the existing bounded
  compact-and-retry (one retry); a second confirmed overflow produces an honest
  `context_exhausted` partial, never a false completion.
- Genuinely oversized contexts (`before.tokens + reserve > limit`, or a forced compaction
  that fails) surface as a truthful `ContextBudgetError`.

These behaviours are exercised by the pre-existing compaction suite (26 tests, all green)
and were re-validated unchanged.

---

## 12. Compaction failure safety

Each failure mode leaves the last valid transcript intact and never advertises success:

| Failure | Result | Verified by |
| --- | --- | --- |
| Cancellation during checkpoint generation | no commit, version unchanged, raw/active intact | `cancellation during checkpoint generation …` |
| Checkpoint provider error after a good summary | fail closed, exactly 2 requests, no retry storm | `checkpoint provider error after a successful summary …` |
| Empty summary | rejected (`invalid-summary-or-transcript`), no archive | `an empty summary is rejected without archiving` |
| Malformed checkpoint | rejected (`malformed-checkpoint`), nothing persisted | `a malformed checkpoint never commits …` |
| Persistence failure during commit | in-memory compaction valid, `durableResumable = false` | `persistence failure during compaction …` |
| Late response after cancel | no commit (pre-existing suite) | `subagentCompaction` |

---

## 13. Phase 1.3C continuation compatibility

The compaction changes are transparent to the 1.3C continuation contract:

- `serializeBudgetState`/`deserializeBudgetState` remain the single source of durable
  budget state; the new `scope` field is additive.
- A post-recovery turn uses the normal `runInvestigationExecution` loop with the restored
  context; compaction integrated cleanly (proven by the benchmark's phase 2, which runs
  after a suspension and renewal).
- The existing 34-test continuation suite (including eligibility, renewal, durable verdict,
  false-resumable refusal, and recovery) passes unchanged.

**Verified:** `tests/subagentContinuation.test.cjs` 34/34; benchmark suspension →
renewal → continuation → completion.

---

## 14. Local/cloud model compatibility

- Compaction uses the child's own effective window
  (`state.budgets.contextLength`), so a local child and a cloud-derived window compact at
  their own thresholds.
- Engine routing identity is unchanged across recovery, continuation, and compaction.
- The child tool allowlist and `permission_mode = read_only` are enforced before execution
  and are never widened by compaction or recovery.

**Verified:** `compaction triggers on the child's own context window, not a fixed size`
(8 192 vs 131 072) and `compaction and execution never widen the child read-only tool
allowlist` (§16); the pre-existing cloud-metadata test remains green.

---

## 15. Long-horizon deterministic benchmark (Step 8)

`tests/subagentLongHorizonCompaction.test.cjs` runs **one child** through the real loop,
real budget ledger, real compaction pipeline and real authorized renewal. The transport is
scripted and tool execution is stubbed, so **no provider tokens are spent**; usage is
synthetic and the benchmark is a workload, not a fidelity claim.

Observed (this run):

```
[phase1.4 benchmark] toolCalls=176 requests=186 simulatedInputTokens=4092000 compactions=4 outcome=completed
```

Required thresholds — all met:

- ≥ 150 tool calls → **176**
- ≥ 150 model requests → **186**
- > 2,000,000 simulated cumulative tokens → **4,092,000**
- ≥ 3 mid-run compactions → **4**
- budget-exhausted suspension at a finite tool-call limit → **`tool_limit` at 150**
- authorized renewal (`maxToolCalls: 200`, audited, monotonic) → **granted 50, consumption preserved**
- continued execution after renewal → **phase 2 completed**
- accurate terminal result → **`completed`**, objective/finding retained, read-only
  constraint retained, 176 unique tool calls (no replay), raw evidence fully retained.

---

## 16. Focused regression tests and full-suite verification

**New Phase 1.4 tests**

- `tests/subagentCompactionHardening.test.cjs` — 15 tests: recovery identity (D-1),
  durable aggregate (D-2), checkpoint bounding (D-3), non-material no-op behaviour (D-4),
  failure safety, fidelity/verification preservation, window and permission boundaries.
- `tests/subagentLongHorizonCompaction.test.cjs` — 1 long-horizon benchmark.

**Focused results**

| Set | Tests | Result |
| --- | --- | --- |
| `subagentCompaction` + `subagentContinuation` + `subagentCompactionHardening` + `childMessaging` + `subagentLongHorizonCompaction` | 92 | 92 / 92 |
| `subagentCompaction` + `subagentContinuation` + `subagentCompactionHardening` + `childMessaging` + `subagentModelSelection` + `subagentBudget` | 104 | 104 / 104 |

**Full-suite regression comparison** (two consecutive runs, identical result)

| Run | Tests | Pass | Fail | New failures vs baseline |
| --- | --- | --- | --- | --- |
| Baseline (pre-change) | 1,147 | 1,120 | 27 | — |
| Final, run 1 | 1,163 | 1,136 | 27 | **0** |
| Final, run 2 | 1,163 | 1,136 | 27 | **0** |

The +16 tests are exactly the two new files. The failure set is byte-identical to the
baseline set (compared by test name); **no baseline failure newly passes and no new failure
appears.** An earlier, heavier benchmark configuration transiently starved two
timing-sensitive `subagentModelSelection` polls under parallel load; the benchmark was
lightened to a realistic large-window (131 072) run, and the two subsequent full runs are
clean.

**Production build**

`npm run build` → success (1,809 modules; `dist/assets/index-*.js` built), exit 0.

> Note: an in-harness Electron acceptance run was not executed in this session. The build
> and the full deterministic + integration suites are the acceptance evidence for Phase 1.4.

---

## 17. Supported vs unsupported (explicit statement)

**Supported and verified by deterministic tests in this repo:**

- Recovery re-attaches raw identity; raw history, evidence and tool results are not
  duplicated (mock transport).
- Recovery preserves the original finite aggregate; renewal cannot exceed the remaining
  aggregate; recovered siblings share one aggregate.
- Repeated compaction does not fail permanently; the checkpoint stays bounded with an
  explicit consolidation note and never silently discards open requirements or verified
  decisions.
- A non-material proactive compaction is a no-op; genuine overflow still fails honestly.
- Failure modes (cancel/timeout/empty/malformed/persistence) leave the last valid transcript
  intact and never advertise false success.
- One child runs 176 tool calls / 186 requests / 4 compactions / 4.09 M simulated tokens
  across a suspension and an authorized renewal to a correct completion.

**Not verified (and not claimed):**

- **Live-model summary fidelity.** No model backend was loaded, so the quality of a real
  provider's summaries/checkpoints under load is not asserted. All fidelity claims above
  are about the deterministic pipeline and its validation, not about model prose quality.
- **Real provider long-horizon behaviour.** Cumulative tokens in the benchmark are
  synthetic; real rate limits, real tokenizer variance, and multi-hour wall-clock behaviour
  were not exercised.
- **Real restart across processes.** Recovery is exercised through the real persistence +
  `recoverChild` path within one process; a genuine OS-level restart was not performed.

---

## 18. Remaining limitations and recommended next steps (Phase 1.5 boundary)

Recommended (not implemented, to avoid touching shared surfaces in Phase 1.4):

1. **Failed-approaches / dead-end preservation** (audit D-9 / §1.4c). Best added as an
   optional structured field the checkpoint prompt can request, without changing the
   shared `WORKSPACE_CHECKPOINT_PROMPT` semantics for Workspace.
2. **Rolling-summary size guard.** A live model whose summary grows monotonically can
   eventually exhaust the window; the system currently reports that truthfully as
   `context_exhausted`. A bounded summary budget (or a periodic full replacement) would
   convert that honest failure into continued operation.
3. **Real restart acceptance.** Add an out-of-process restart test that persists a child,
   restarts, recovers, and continues — closing the only "not verified" item in §17 that is
   mechanically testable.
4. **Live-model fidelity benchmark.** Run the long-horizon workload against a real local
   model to measure summary/checkpoint fidelity (distinct from the deterministic benchmark).

No Phase 1.5 work was started.

---

## Appendix A — Changed files and symbols

| File | Change |
| --- | --- |
| `src/main/subagents/contextRecovery.js` | `rawSignature` / `buildRawIdIndex` / `claimRawId` + recovery seed loop (D-1); `prepare` treats `no-material-reduction` as a proactive no-op (D-4) |
| `src/main/subagents/continuationState.js` | `serializeBudgetState` persists `scope`; `restoreScope`; `deserializeBudgetState` rebuilds the scope (D-2) |
| `src/main/subagents/continuationManager.js` | `recoveredScopes` registry, `snapshotScope`, `liveScopeById`, `acquireRecoveredScope`; `recoverChild` uses it (D-2) |
| `src/main/compactionCore.js` | bounded, priority-aware `retainPrior` merge + `CHECKPOINT_CONSOLIDATION_NOTE` + `prioritizeRetained`/`retainedPriority` (D-3) |
| `src/main/taskCheckpoints.js` | exports `ARRAY_CAPS` |
| `tests/subagentCompactionHardening.test.cjs` | new — 15 focused tests |
| `tests/subagentLongHorizonCompaction.test.cjs` | new — 1 long-horizon benchmark |

Pre-existing 1.3C working-tree changes (unchanged by Phase 1.4) remain present in
`src/main/db.js`, `src/main/ipcHandlers.js`, `src/main/subagents/{executionBudget,index,persistence,sessionManager}.js`,
`src/preload.js`, plus untracked `continuationState.js` and `tests/subagentContinuation.test.cjs`.

## Appendix B — Key invariants

- One compaction engine; one continuation state module; one budget ledger per child and one
  shared counter per parent invocation.
- Compaction commits atomically; a failed or cancelled compaction changes nothing.
- Raw child history is authoritative and is never pruned by compaction; the checkpoint is a
  bounded, evidence-validated projection of it.
- A recovered child is never executed automatically and never silently gains allowance.
- The child remains read-only at every point; compaction and recovery never widen the
  allowlist or permission mode.
