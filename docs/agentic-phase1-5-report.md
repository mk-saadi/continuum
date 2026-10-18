# Continuum — Agentic Phase 1.5 Implementation Report

**Subagent completion/result reliability: backend-aware completion classification,
interrupted-stream safety, bounded continuation for every no-visible-content turn, structured
terminal reporting, and minimal child controls.**

- Date: 2026-10-19
- Reference brief: Phase 1.5 (completion and result reliability, audit §18 / 1.5a–1.5c).
- Prior work preserved: **Phase 1.1** (`run_tests`), **Phase 1.2** (durable plans),
  **Phase 1.3A** (long-horizon budgets, unbounded limits), **Phase 1.3B** (deadlines,
  request timeouts, cancellation propagation, terminal contract), **Phase 1.3C** (durable
  continuation, renewable budgets, restart recovery), and **Phase 1.4** (mid-run
  context-compaction + recovery hardening).
- Scope implemented: **Phase 1.5 only.** No second subagent runtime, no new compaction
  framework, no new planning system, no persistence-framework rewrite, no broad UI redesign,
  no daemon/server/cloud infrastructure, no casual-chat memory/compaction change, no
  permission weakening, and **no Phase 1.6/1.7 work**.
- Working tree preserved. **No commits, pushes, stashes, resets, or cleans.** All changes are
  uncommitted working-tree modifications plus new files. Baseline HEAD `c1105ca`.

---

## 1. Stop point and scope

Implementation, deterministic tests, out-of-process restart verification, full-suite
verification, the production build, an Electron UI acceptance run, and this report are
complete. **Phase 1.6 is not started.** Waiting for review.

In scope: harden the *existing* subagent completion/result path so that (a) a turn is only a
success when the provider and the transport both say it finished, (b) a truncated, filtered,
or interrupted turn — with or without visible content — is never reported as completed,
(c) a tool call parsed from a half-received stream is never dispatched, (d) one bounded
continuation covers every no-visible-content shape, (e) the parent and the transcript receive a
structured, truthful terminal/partial verdict, and (f) minimal, safe child controls
(interrupt/continue) are wired to the real runtime.

Out of scope: any rewrite of the agent loop, any new runner/recovery/plan system, and any
unrelated subsystem.

---

## 2. Non-goals and constraints honored

- **One classification.** A single pure module, `src/main/subagents/completion.js`, owns the
  completion verdict. The child agent loop and the one-shot execution manager both call it;
  there is no second "did it finish?" heuristic. The module has no state, no I/O, and no loop
  dependency.
- **Reuse, never replace.** Interrupted / truncated / filtered turns all map onto the
  pre-existing non-renewable-by-default `incomplete_response` stop reason. No new terminal
  status, no new persistence framework, no new retry loop.
- **Budgets, deadlines, cancellation, permissions untouched.** The continuation retry uses the
  existing bounded continuation slot and only escalates the per-request ceiling through the
  existing `escalatedCeiling` path. No budget, timeout, cancellation, permission, model
  selection, compaction, or continuation semantics were changed.
- **No automatic execution.** Minimal child controls only *request* an action on the existing
  Phase 1.3C control surface; recovery never auto-executes.
- **Read-only child unchanged.** The allowlist and `permission_mode = read_only` are never
  widened; the new dispatch gate can only *remove* work, never add it.

---

## 3. Baseline state and reproduction

Independently reproduced (fresh runs, not trusted reports). The pre-change numbers were
captured on the Phase-1.4 working tree; a clean `c1105ca` worktree was *also* run to prove the
identity of the failure set does not depend on the untracked Phase 1.3C/1.4 test files.

| Suite | Result |
| --- | --- |
| Pre-change working tree `node --test tests/*.test.cjs tests/*.test.mjs` | 1,163 tests / 1,136 pass / **27 fail** (pre-existing, unrelated) |
| Clean HEAD `c1105ca` worktree (tracked files only) | 1,113 tests / 1,086 pass / **27 fail** — same 27 identities |
| Focused subagent suites | green except the 2 pre-existing `childAgentLoop` failures |
| `npm run build` | success |

The 27 baseline failures were saved by name (`/tmp/opencode/baseline-failures.txt`) and used as
the identity set for the final regression comparison (§16). Both baseline runs and the final
run fail the **identical 27 test names**; the count only changes because Phase 1.5 adds 12 new
passing tests.

---

## 4. The pipeline under test (untouched flow)

```
parent run
  └─ executionManager / agentLoop dispatch a child
       ├─ providers.streamCompletion.readCompletion(response, onProgress)   per model turn
       │     └─ assembles content / reasoning / tool_calls (+ XML recovery)
       │         and now sets message.streamInterrupted when the SSE body
       │         ends without [DONE] and without a finish reason
       ├─ completion.classifyCompletion({ finishReason, streamInterrupted })  THE verdict
       │     ├─ interrupted  -> refuse to dispatch a half-received tool batch
       │     ├─ truncated/filtered -> incomplete_response, never completed
       │     └─ complete -> normal answer / tool dispatch
       ├─ executionBudget.outcome(state, { …, completionClass })
       │     └─ accounting.completionClass + accounting.evidence + allowance
       └─ sessionManager terminal status + persistence.persistChildRun mirror
```

The child is read-only (allowlisted tools, `permission_mode = read_only`). Phase 1.5 changed
*inputs to the one verdict* and the *reporting of it*; it did not add a parallel finish check.

---

## 5. Audit findings (Phase 1.5 defect inventory)

Four defects were confirmed by source inspection plus targeted deterministic probes. Two were
the pre-planned 1.5a false-completion defects; two were discovered while hardening the same
path and are fixed because they directly cause false or non-resumable terminal states.

1. **D-1 — a non-`length` truncation with visible content was reported `completed`.** The loop
   (and the one-shot manager) special-cased only the literal finish reason `length`. A provider
   that reported `max_tokens` / `max_output_tokens` / `token_limit` (or a `content_filter` /
   `safety` / `blocked` turn) *with* partial text produced a child the parent saw as a successful
   completion. Probe `/tmp/opencode/probe-completion.cjs` before the fix: `max_tokens`+content →
   `outcome=completed`.
2. **D-2 — an interrupted SSE stream was reported `completed`.** `readCompletion` returned
   whatever had arrived when the socket closed. If the body ended with neither `[DONE]` nor a
   finish reason but *had* content (or a partially-parsed tool call), the turn was treated as a
   clean stop. A dropped connection could therefore produce a "completed" child, and — worse —
   a tool call whose argument JSON was cut mid-stream could be dispatched.
3. **D-3 — the bounded continuation only covered *truncated* turns, not clean-but-empty or
   filtered turns.** `reasoning-only` + a clean `stop` is a plausible local-server shape; it
   produced an immediate `empty_response` failure with no single recovery attempt, while a
   `length` turn got one. The retry boundary was tied to the wrong signal.
4. **D-4 — the terminal result did not carry a machine-readable completion verdict.** The parent
   received `outcome`/`stopReason`, but not *why* a partial was partial, and not whether the run
   held usable evidence. A parent (or the transcript UI) had to re-derive it. This made truthful
   reporting brittle and untestable as a contract.

Deferred to §18 (recommended, not implemented): local measured usage via
`stream_options.include_usage` (audit D-7 / 1.5b), and repair-of-obsolete-test expectations
(audit B-1..B-4 / 1.5c) — see §18 for why they are deliberately out of this change.

---

## 6. Fix 1 — one backend-aware completion classifier

**New file:** `src/main/subagents/completion.js` (pure, dependency-free).

```js
classifyCompletion({ finishReason, streamInterrupted }) -> COMPLETION.{COMPLETE,TRUNCATED,FILTERED,INTERRUPTED}
stopReasonFor(class) -> 'completed' | 'incomplete_response'
```

- **Clean vocabulary** → `complete`: `stop`, `end_turn`, `stop_sequence`, `eos`, `eos_token`,
  `completed`, `complete`, **and any missing/unknown reason**. Unknown is treated as complete
  deliberately: several supported local servers omit `finish_reason` on ordinary JSON
  completions, and inventing an incomplete verdict there would break valid answers.
- **Truncation vocabulary** → `truncated`: `length`, `max_tokens`, `max_output_tokens`,
  `max_completion_tokens`, `token_limit`, `length_limit`, `truncated`.
- **Filtered vocabulary** → `filtered`: `content_filter`, `content-filter`, `safety`, `blocked`,
  `prohibited_content`.
- **Interruption outranks every finish reason**: `streamInterrupted === true` → `interrupted`,
  even if a stray finish reason was seen earlier.
- Every non-complete class maps to the existing `incomplete_response` stop reason
  (`stopReasonFor`), so nothing downstream needs a new status.

**Verified (deterministic):** `every backend finish vocabulary classifies truthfully` (§16).

---

## 7. Fix 2 — interrupted-stream detection and the dispatch gate

**File:** `src/main/subagents/providers/streamCompletion.js`.

The SSE reader now tracks whether it saw the protocol end-of-stream marker:

```js
if (data === '[DONE]') { sawDone = true; return; }
…
if (!sawDone && finishReason === null
    && (rawContent || message.reasoning_content || toolCalls.length || message.toolMarkupIncomplete)) {
  message.streamInterrupted = true;
}
```

- An **empty** stream stays a plain empty completion (never mislabelled interrupted).
- A **JSON** body (non-stream) is never flagged; the flag is transport-specific.
- The flag travels on the message, so classification and the dispatch gate share one signal.

**Files:** `src/main/subagents/agentLoop.js`.

When a turn is `interrupted` **and** carries tool calls, the loop dispatches **nothing**. It
commits the assistant batch paired with explicit `[Tool skipped: interrupted stream]` results —
so the persisted transcript stays protocol-valid and replay-safe — and reports the turn as
`malformed_response` with the `interrupted` completion class:

```js
if (streamInterrupted && calls.length) {
  state.blockedCalls += calls.length;
  context.append({ role: 'assistant', content: content || null, tool_calls: calls });
  for (const call of calls) context.append({ role: 'tool', tool_call_id: call.id,
    content: '[Tool skipped: interrupted stream] …' });
  return finish('', stopReason ?? 'malformed_response', false, '…', completion);
}
```

An interrupted stream with visible *content* and no calls is classified normally
(`interrupted` → `incomplete_response` partial).

**Verified (deterministic):** `an SSE stream that ends without [DONE] … is flagged interrupted`,
`an interrupted stream with content is incomplete, never completed`, and
`an interrupted stream carrying a tool call is refused without any dispatch` (§16).

---

## 8. Fix 3 — one bounded continuation for every no-visible-content turn

**File:** `src/main/subagents/agentLoop.js`.

The no-content branch now retries once for **every** shape, not only `length`; a genuinely
truncated turn escalates the per-request ceiling first, through the pre-existing path:

```js
if (incompleteRetries++ < 1) {
  if (completion === COMPLETION.TRUNCATED)
    ceiling = escalatedCeiling(ceiling, state.budgets, state.ledger, estimatePromptTokens(messages, tools)) ?? ceiling;
  pushActivity(session, { type: 'note', turn, text: `No visible answer (${completion}); one bounded continuation…` });
  continue;
}
return finish('', completion === COMPLETION.COMPLETE ? 'empty_response' : 'incomplete_response', false,
  completion === COMPLETION.COMPLETE ? null : `The model stopped without a visible answer (completion=${completion}).`, completion);
```

- The retry slot is the **existing** single bounded continuation; no new loop, no unbounded
  retry. A malformed tool batch from an interrupted stream is handled *before* this branch and
  therefore never enters the retry.
- `empty_response` + its `attemptDiagnostics` are preserved for the clean-but-empty case
  (`subagentFailureDiagnostics.test.cjs` still passes), while a truncated/filtered/interrupted
  no-content turn reports `incomplete_response` with the class in the detail.
- Reasoning-only turns (`reasoning_content` with no visible content) therefore never report
  `completed`.

**Verified (deterministic):** `a clean-but-empty stop is retried once and never becomes a
completed child`, `a transient empty stop recovers on the single bounded continuation`,
`reasoning-only turns never report completed without visible content` (§16).

---

## 9. Fix 4 — the one-shot path shares the same verdict

**File:** `src/main/subagents/executionManager.js` (`completeOneShot`).

The one-shot (file/web) execution previously special-cased only `length`. It now classifies the
turn with the shared module and reports truthfully, while deliberately keeping the existing
empty-response branch (and its diagnostics) intact:

```js
const completion = classifyCompletion({
  finishReason: result?.choices?.[0]?.finish_reason,
  streamInterrupted: result?.choices?.[0]?.message?.streamInterrupted === true });
if (summary) return finish(output, initialReason ?? stopReasonFor(completion), null, completion);
…
if (completion === COMPLETION.TRUNCATED) ceiling = escalatedCeiling(…) ?? ceiling;
```

A visible partial summary with `max_tokens`/`content_filter` is `incomplete_response` and is
**not** retried (a partial answer is real evidence, not an empty turn); a clean answer is still
`completed`.

**Verified (deterministic):** `one-shot completions cannot report a truncated or filtered answer
as complete` (§16).

---

## 10. Fix 5 — structured, truthful terminal reporting

**File:** `src/main/subagents/executionBudget.js` (`outcome`).

`outcome()` gained an optional `completionClass`, surfaced top-level and in `accounting`, plus a
boolean `evidence` (whether usable findings existed). The pre-existing Phase 1.3C allowance and
renewal accounting is unchanged and still reported alongside:

```js
return { …, outcome, stopReason, completionClass, usage,
  accounting: { …totals, …, completionClass: completionClass ?? null, evidence: findings === true,
    allowance: summarizeAllowance(state), renewalCount: state.renewals.length } };
```

- `outcome`/`stopReason` remain the primary contract and are unchanged in meaning. A partial
  stays `partial`; a failure stays `failed`; a timeout stays `timed_out`.
- `completionClass` distinguishes *why* a partial is partial (`truncated` / `filtered` /
  `interrupted`) without re-deriving it from output text.
- `incomplete_response` is deliberately **not** added to `NON_RENEWABLE_STOP_REASONS`, so a
  partial with it can still be continued through an explicit authorized renewal (Phase 1.3C) —
  it is not silently promoted to a hard terminal.

**Verified (deterministic):** `a clean finish with visible content still completes`
(`completionClass === complete`, `accounting.evidence === true`) and the partial cases assert
`completionClass`/`stopReason` (§16).

---

## 11. Minimal child controls (interrupt + continue)

**Files:** `src/main/ipcHandlers.js`, `src/preload.js`,
`src/components/chat/SubagentTranscriptModal.jsx`.

- New IPC `subagent:interrupt` → `index.interrupt`, which stops the active turn at a safe
  boundary and leaves the child **resumable** (status `interrupted`, distinct from
  `cancelled`). Authorization is the owning `parentSessionId`, enforced in the runtime.
- Preload exposes `interruptChild` (feature-detected).
- The transcript modal renders a defensive `ChildControls` section:
  - **Interrupt** only while the child is live (`created`/`waiting`/`running`).
  - **Continue** only when the child is `interrupted`; it first reads
    `getContinuationStatus` and, if `eligibility.requiresRenewal` is set, shows a note
    ("…an authorized renewal is required before it can continue") instead of performing a
    one-click renewal. Continue/renew reuse the Phase 1.3C control surface; no new mechanism.
  - The section is omitted entirely when the host lacks the control bridge.

This is the "minimum child controls integrated" acceptance item. It is intentionally narrow:
no message composer, no budget editor, no background-spawn UI.

**Verified:** build + Electron UI acceptance (§16); the underlying `interrupt`/`continue`
runtime behavior is covered by the Phase 1.3C continuation suites and the out-of-process test
(§15).

---

## 12. Streaming identity and late-response safety

- **Identity is transport-scoped.** `streamInterrupted` is set only by the SSE reader and only
  when the body closed without `[DONE]` *and* without a finish reason *and* had output. JSON
  bodies never carry it; empty streams never carry it.
- **Late responses cannot corrupt terminal state.** Once a turn is terminal, the loop returns
  through `finish` and does not start another generation; the new long-horizon reliability test
  freezes the request count and asserts no post-terminal generation starts (§15). The
  interrupted-call gate likewise refuses work *before* dispatch regardless of when the stream
  ends.
- **Concurrent children stay isolated.** Each child has its own context, budget ledger, and
  transcript; the shared counter is the pre-existing parent aggregate, untouched here.

---

## 13. Parent/child isolation, budgets, and preservation of prior phases

No change to: the child context isolation, the read-only allowlist, the per-child budgets, the
shared aggregate, request timeouts, deadlines, cancellation propagation, model selection, or
mid-run compaction. Phase 1.5 only *classifies* a turn and *reports* it, and can only *block*
work (interrupted-call gate) — never add budget, widen permissions, or start extra generations.

**Verified (focused suites, §16):** `subagentContinuation`, `subagentTimeouts`,
`subagentCompaction`, `subagentCompactionHardening`, `subagentModelBudgets`,
`subagentDispatchConcurrency`, `subagentRuntime`, `subagentRetention`, `childMessaging`,
`subagentTranscript` — all green (174/174 together with the two new Phase 1.5 files).

---

## 14. Local/cloud and provider compatibility

- The finish vocabulary is a **superset** of llama.cpp/OpenAI-compatible, Anthropic
  (`end_turn`/`stop_sequence`), and Responses-style (`max_output_tokens`) spellings, so a
  provider that spells "ran out of room" differently still classifies as truncated.
- Missing/unknown finish reasons stay `complete`; the transport flag is what detects a cut
  stream. This is what keeps ordinary local JSON completions (which commonly omit
  `finish_reason`) working.
- `stream_options.include_usage` (audit D-7 / 1.5b) is **not** added in this change (see §18).

---

## 15. Deterministic reliability test and out-of-process verification

**New long-horizon reliability test** (added to `tests/subagentLongHorizonCompaction.test.cjs`):
24 unique tool turns + one legitimate read-only failure + a truthful final answer, asserting:
a `completed` outcome with `completionClass === complete`; exactly one dispatch per requested
call with **no replay**; the single failure recorded as an error result and survived; and the
request count **frozen** after the terminal answer (no post-terminal work).

**Out-of-process restart recovery** (`tests/subagentOutOfProcessRecovery.test.cjs` +
`tests/fixtures/subagentRestartChild.cjs`): the child's life is deliberately split across two OS
processes.

- **Process A** (the fixture) opens the shared SQLite directory, runs one real delegated
  investigation to a finite tool-call stop (`partial` / `tool_limit`), persists the durable
  continuation record, and exits.
- **Process B** (the test) starts from an empty in-memory runtime against the *same* directory
  and proves the child is listed as recoverable, recovered (never executed), renewed, and
  continued to `completed` — reusing only the Phase 1.3C control surface. It asserts consumption
  survived the restart (never reset) and that exactly one renewal was recorded.

This closes the Phase 1.4 §17 "real restart across processes" limitation for the recovery path.

---

## 16. Focused regression tests and full-suite verification

**New Phase 1.5 tests**

- `tests/subagentCompletionReliability.test.cjs` — 10 tests: pure vocabulary; SSE interruption
  identity; interrupted-call refusal with no dispatch; truncated/filtered/interrupted never
  completed; clean completion; bounded continuation for clean-empty and reasoning-only; one-shot
  truncated/filtered/clean.
- `tests/subagentOutOfProcessRecovery.test.cjs` — 1 out-of-process recovery/continue test.
- `tests/subagentLongHorizonCompaction.test.cjs` — 1 added long-horizon reliability test
  (+ the existing benchmark).

**Focused results**

| Set | Tests | Result |
| --- | --- | --- |
| New 1.5 files + `subagentContinuation` + `subagentTimeouts` + `subagentCompaction` + `subagentCompactionHardening` + `childMessaging` + `subagentTranscript` + `subagentLongHorizonCompaction` + `subagentDispatchConcurrency` + `subagentRuntime` + `subagentRetention` + `subagentModelBudgets` | 174 | 174 / 174 |
| `childAgentLoop` + `subagentReliability` + `subagentBudgets` + `subagentFailureDiagnostics` + `subagentStreaming` | 66 | 64 / 66 (the 2 pre-existing baseline failures) |

**Full-suite regression comparison** (fresh runs; compared by test name against both the
Phase-1.4 working-tree baseline and a clean `c1105ca` worktree)

| Run | Tests | Pass | Fail | New failures vs baseline |
| --- | --- | --- | --- | --- |
| Baseline (clean HEAD `c1105ca`) | 1,113 | 1,086 | 27 | — |
| Baseline (pre-change working tree) | 1,163 | 1,136 | 27 | — |
| Final | 1,175 | 1,148 | 27 | **0** |

The +12 tests are exactly the Phase 1.5 additions. The failure set is **byte-identical** to
the baseline set (compared by name): no baseline failure newly passes and no new failure
appears. The remaining 27 are pre-existing and unrelated, in two families:

- **Environment / Electron mocks that lack `app.getPath`.** Eleven test files fail at load
  because `db.initDatabase` → `legacyDataMigration.repairLegacyAttachmentPaths` reads
  `app.getPath` from a stub (verified directly: `tests/tokenUsage.test.cjs` throws
  `TypeError: Cannot read properties of undefined (reading 'getPath')`); this is the same
  family the audit logged as B-1.
- **Stale expectations tied to the provider now streaming** (audit B-2/3/4), notably the two
  `childAgentLoop` cases (`payload.stream === false` now observes `true`). Both were
  independently reproduced on a clean `c1105ca` worktree and fail there for the same reasons.

`tests/subagentModelSelection.test.cjs` passes 13/13 in this environment (the audit's B-1
"13 fails" was environment-specific and is *not* a current failure), so it is not part of the
27.

**Production build**

`npm run build` → success (1,809 modules; `dist/assets/index-*.js` built), exit 0.

**Electron UI acceptance**

- `tests/subagentModal.ui.cjs` → pass ("Both tool cards retain open modals on success/error and
  allow reopening after completion"), exit 0.
- `tests/subagentAcceptance.ui.cjs` → pass ("real Settings persistence/remount, invalid
  rejection, mode fallback; runtime completed/partial/failed/cancelled and estimated/reserved
  UI"), exit 0.

---

## 17. Supported vs unsupported (explicit statement)

**Supported and verified by deterministic tests in this repo:**

- Every supported finish vocabulary classifies truthfully; unknown/missing reasons complete.
- A truncated (`max_tokens`/`length`), filtered, or interrupted turn with visible content is a
  `partial` with `incomplete_response` and `completionClass` set — never `completed`.
- An SSE stream that ends without `[DONE]`/finish reason is flagged interrupted; a tool call
  from such a stream is never dispatched (paired with explicit skipped results).
- One bounded continuation covers clean-empty, reasoning-only, truncated, filtered, and
  interrupted no-visible-content turns; reasoning-only never completes.
- The one-shot path reports truncated/filtered summaries as `incomplete_response`.
- The terminal result carries `completionClass`, `accounting.evidence`, allowance, and renewal
  count without changing `outcome`/`stopReason` semantics.
- A child persisted by another OS process is recovered, renewed, and continued to completion
  with consumption preserved.

**Not verified (and not claimed):**

- **Live-model completion behavior.** No model backend was loaded. All classification,
  interruption, and continuation claims are about deterministic provider shapes, not the prose
  or finish reason of a real model under load.
- **Real dropped-connection transport.** The interrupted stream is scripted at the SSE-frame
  level; a genuine TCP reset mid-generation was not exercised.
- **Local measured usage (audit D-7 / 1.5b).** Not implemented, so local children still report
  reserved/estimated usage — unchanged from baseline.
- **Repair of obsolete baseline tests (audit B-1..B-4 / 1.5c).** Deliberately deferred; those
  27 failures are pre-existing and out of the Phase 1.5 defect set (§18).

---

## 18. Remaining limitations and recommended next steps (Phase 1.6 boundary)

Recommended (not implemented, to keep Phase 1.5 to confirmed defects):

1. **Local measured usage (audit D-7 / 1.5b).** Add `stream_options.include_usage` to the child
   payload so local children report measured rather than reserved tokens. This is an accounting
   improvement, not a false-completion defect, so it was left out of this reliability change.
   Suggested home: Phase 1.6, with `subagentStreaming`/`subagentBudgets` coverage.
2. **Test-baseline repair (audit B-1..B-4 / 1.5c).** Fix the Electron mocks missing `getPath`
   and the stale `payload.stream === false` expectations (the provider streams now). These are
   unrelated to completion reporting and were not touched.
3. **Live-model completion benchmark.** Run the long-horizon reliability workload against a real
   local model to confirm interruption/truncation detection under genuine transport behavior.
4. **Real dropped-connection acceptance.** A transport-level test that resets the socket
   mid-generation would upgrade the scripted SSE-interruption coverage to end-to-end.

No Phase 1.6 work was started.

---

## Appendix A — Changed files and symbols

| File | Change |
| --- | --- |
| `src/main/subagents/completion.js` | **new** — pure classifier: `COMPLETION`, `classifyCompletion`, `stopReasonFor`, `finishReasonClass`, vocabulary sets |
| `src/main/subagents/providers/streamCompletion.js` | track `sawDone`; set `message.streamInterrupted` on a stream that ends without `[DONE]`/finish reason but with output |
| `src/main/subagents/agentLoop.js` | classify each turn; interrupted-with-calls dispatch gate (explicit skipped results); broadened single bounded continuation; `finish(…, completionClass)` |
| `src/main/subagents/executionManager.js` | `completeOneShot` classifies summary turns; `finish(…, completionClass)` |
| `src/main/subagents/executionBudget.js` | `outcome()` emits `completionClass`, `accounting.completionClass`, `accounting.evidence` |
| `src/main/ipcHandlers.js` | `subagent:interrupt` (Phase 1.3C control surface otherwise unchanged) |
| `src/preload.js` | `interruptChild` (Phase 1.3C calls otherwise unchanged) |
| `src/components/chat/SubagentTranscriptModal.jsx` | defensive `ChildControls` (Interrupt / Continue-with-renewal-note) |
| `tests/subagentCompletionReliability.test.cjs` | **new** — 10 completion/streaming reliability tests |
| `tests/subagentOutOfProcessRecovery.test.cjs` + `tests/fixtures/subagentRestartChild.cjs` | **new** — out-of-process recovery/continue verification |
| `tests/subagentLongHorizonCompaction.test.cjs` | added the long-horizon reliability test |

Pre-existing Phase 1.3B/1.3C/1.4 working-tree changes (unchanged by Phase 1.5) remain present in
`src/main/{compactionCore,db,taskCheckpoints}.js`,
`src/main/subagents/{contextRecovery,continuationManager,index,persistence,sessionManager}.js`,
plus untracked `continuationState.js` and the 1.3C/1.4 test files.

## Appendix B — Key invariants

- One completion classifier; the child loop and the one-shot manager share exactly one verdict.
- A turn is `complete` only when the provider says so AND the transport delivered a finished
  stream; unknown/missing reasons remain complete, the transport flag covers the cut-stream case.
- An interrupted stream never dispatches a tool call; any committed batch is protocol-valid and
  replay-safe.
- Non-complete classes map onto the existing `incomplete_response`; no new terminal status.
- The retry is the single pre-existing bounded continuation; only a truncated turn escalates its
  ceiling.
- `outcome`/`stopReason` semantics are unchanged; `completionClass`/`evidence` are additive.
- The child stays read-only; Phase 1.5 can only block work, never add budget, permissions, or
  generations.
- Recovery never auto-executes; a recovered child re-enters only through the Phase 1.3C control
  surface with an authorized renewal.
