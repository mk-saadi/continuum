# Workspace Compaction — W1 Audit Report

**Audit scope:** Read-only architecture and reliability audit of Continuum's Workspace auto-compaction system. No production source modified. No live compaction triggered. No user chats altered.

**Date:** 2026-10-23
**Working tree:** Uncommitted changes present in `compactionCore.js`, `compressionEngine.js`, `contextBudget.js`, `promptMeasurement.js`, `ipcHandlers.js`, `MemoryPalace.jsx`, `ContextPanel.jsx`, `ChatInterface.jsx`, and others (see `git status --short`). Report reflects current tree, not committed HEAD.

---

## 1. Executive verdict

**No coherent Workspace compaction feature is fully verified.** C1 (unified runtime budget and 90% trigger) is implemented and partially verified by focused tests (29 passing, 0 new failures). Partial C3 (live-run protection / open-row archival boundary) is present but explicitly gated by missing C2 guarantees. C2 (reliable summary/checkpoint generation, validation, preservation of requirements and evidence, prospective-resumed-fit) is **not completed** — the C3 report confirms the dependency gate failed. No C2 implementation report or evidence file exists in the repo.

The system can support a future Workspace-only compaction policy if rebuilt around:
1. A single per-request budget contract (C1 done).
2. Validated summary/checkpoint protocols (C2 missing).
3. Protected current-run tail + complete-round adapter (C3 partial; full adapter deferred).
4. Workspace-only lifecycle events tied to session ID (C4 not started; UI events exist partially via `session:compression-complete` in `ipcHandlers.js`).

**Under-5K target is not a guaranteed result.** It excludes fixed system/developer instructions (~20k chars), active native/MCP schemas (~12.5k tokens), brief sections, checkpoint sections, work log, plan, and protected live tail. The irreducible floor is well above 5K for realistic Workspace configurations; a 5K task-history portion may be achievable only with very short briefs, minimal tools, and minimal live tail.

---

## 2. What already exists

| Component | Key file(s) | What exists | Verification |
|---|---|---|---|
| Runtime budget contract | `src/main/contextBudget.js` | `createRuntimeBudget`, `atCompactionPressure`, reserve/safety, 90% trigger, capability refresh | Direct code inspection + `contextC1.test.cjs` (29 pass) |
| Request guard / measurement | `src/main/contextBudget.js`, `promptMeasurement.js` | `createPromptMeasurer`, tokenizer/cache, approximate fallback, image allowance 4096, identity checks | Direct inspection + mock reproductions in evidence |
| Idle scheduling | `src/main/compressionEngine.js` | `scheduleIdleCompression`, 10s debounce, `atCompactionPressure` with measured budget, active-row refusal | Direct inspection + `tests/idleCompactionProjection.test.cjs` |
| Forced recovery | `src/main/compressionEngine.js`, `ipcHandlers.js` | `compressContext`, snapshot/commit, brief/checkpoint/evidence guards, prospective measurement gate | Direct inspection; `contextCompaction.test.cjs` |
| Checkpoint structure / validation | `src/main/taskCheckpoints.js`, `compactionCore.js` | JSON schema, evidence index, array caps (50/12/15/...), `validateCheckpoint`, `buildCheckpointInput`, `persistCheckpointRow` | Direct inspection; adversarial checks reproduced (51→50 truncation confirmed) |
| Task briefs | `src/main/taskBriefs.js` | Durable board, applicable-path derivation, `buildTaskBriefSection`, brief identity for commit guard | Direct inspection; `workspaceTaskBriefs.test.cjs` |
| Prompt building / rebuild | `src/main/promptBuilder.js`, `sessionManager.js` | `rebuildChatMessages`, `buildSessionSystemPrompt`, brief/checkpoint/summary/work-log/plan injection, `getActiveMessages`, `messageForModel` | Direct inspection |
| Child transcript adapter | `src/lib/memoryChat.mjs`, `subagents/contextRecovery.js` | Complete pair preservation, bounded round selection, prior-state retention, separate budget adapter | Tests pass; not audited end-to-end here due to scope |
| UI / IPC | `src/components/MemoryPalace.jsx`, `ContextPanel.jsx`, `src/main/ipcHandlers.js`, `preload.js` | Header/context measurement; `session:compression-complete` event; `compressions` not fully exposed as lifecycle schema | Partial; C4 not started |
| Partial C3 protection | `compressionEngine.js` (current changes) | Candidate selection stops at first `in_progress` or excluded; atomic archive predicate refuses `in_progress`; idle refusal preserved | `tests/contextC3LiveProtection.test.cjs`: 5/5 pass; pre-change reproduction 2/5 pass |

---

## 3. What actually works

- **C1 budget and trigger:** Runtime `/props` capacity takes precedence over configured total; reserve (output + reasoning + safety) subtracted; usable input computed; 90% integer trigger set; header and guard use same `budgetContract`. Confirmed by focused tests.
- **Atomic compaction transaction:** Summary update, message archival (`archived=1, is_summarized=1`), checkpoint persistence, brief identity check, evidence fingerprint check, leaf check, and lock release are in one SQLite transaction with rollback on mutation.
- **Evidence-based checkpoint validation:** `validateCheckpoint` verifies required fields, strips untrusted keys, binds sources to evidence index, requires successful steps for `completedWork`, demotes unverified entries to `unknowns`, caps arrays, and reports repair notes.
- **Live-run protection (C3 partial):** The open-row boundary and atomic status guard prevent archiving an in-progress assistant message. Forced recovery stops at the first open/excluded message. Idle scheduler also refuses when any active message is `in_progress`.
- **Durable originals preserved:** Original messages, execution steps, attachments, briefs, summaries, checkpoints, and work logs remain in SQLite after archival.
- **Child continuity (existing):** Child adapter preserves full tool pairs, recent complete rounds, and prior checkpoint with bounded growth; not broken by parent changes.

---

## 4. What is broken / confirmed defects (from F01–F13 mapping)

Status uses exact findings from `docs/context-compaction-audit-2026-10-22.md` (F01–F13) mapped to current tree.

| Finding | Status | Evidence (current source/test) | Remaining work |
|---|---|---|---|
| F01 — capacity has multiple sources of truth | **Partial / Open** | C1 fixes present in `contextBudget.js`, `promptMeasurement.js`, `compressionEngine.js`; header uses `budgetContract`; but stale prepared-context cache can reuse old limit (`cache` in `promptMeasurement.js` keys on session/model/backend without capacity refresh on payload-only hits); no production invalidation callers found | Ensure all consumers (idle scheduler, header, guard, child descriptor) share the same refreshed contract; add cache invalidation on engine restart/slotted change |
| F02 — one image changes accounting | **Confirmed / Not fully fixed** | Image forces approximate-full-request (`contextBudget.js:161–164`); 4096 per image allowance; no vision-token measurement; guard can reject conservative estimate | No exact vision tokenizer available; document conservative policy clearly; consider backend overflow recovery as authoritative validation |
| F03 — parent summarization/checkpoint generation unreliable | **Open / Not fixed** | `main.js` callbacks read only `choices[0].message.content`; no `finish_reason` check; reasoning-only response accepted; truncated JSON throws; no structured-output enforcement; `COMPLETE` vs `length` not rejected | Implement C2: validate finish reason, reject `length`/empty/incomplete, enforce JSON schema/grammar, bounded repair, preserve requirements |
| F04 — idle archival can archive live output | **Partial / C3 addressed narrow case** | C3 adds open-row boundary; but full completed-round adapter deferred; pending approvals/tool results on open row protected only by row preservation; no independent completed-batch verification | Build parent-specific complete-round adapter; verify complete concurrent batches; protect pending approvals/steering/background events |
| F05 — separate projections can commit non-fitting result | **Open** | Forced prospective measurement (`compressionEngine.js:612–636`) only blocks exact tokenizer overage; approximate overage not vetoed; excludes work log/plan/retrieval/live-tail additions; idle projection uses different estimator (chars/4) vs guard (bytes/3) | Unify estimator policy; include full rebuilt sections in pre-commit measurement; make approximate overage reject or document clearly |
| F06 — stale capacity cache | **Partial / Open** | Cache keys miss capacity; same-port model reload can return stale 35,072 after `/props` reports 16,384; no production invalidation callers | Add explicit invalidation on `/props` change or engine identity change; refresh before reuse |
| F07 — checkpoint truncation / size cap | **Confirmed** | `ARRAY_CAPS.outstandingRequirements=50`; with 51 briefs returns `ok=true` after trimming newest; `BYTE_CAP=8000` uses `.length` not UTF-8 bytes; full brief text repeated inside checkpoint | Fix cap enforcement to preserve all brief IDs or report failure; use byte-length enforcement; replace repeated text with brief references where feasible |
| F08 — prompt continuity not guaranteed by brief alone | **Confirmed** | Brief preserves instructions; checkpoint evidence capped at 12k chars; summary is prose synthesis; tool observations and completed outcomes may be lost if not in checkpoint | Ensure execution evidence is retrievable; keep brief authoritative; add bounded retrieval for older observations |
| F09 — growing current-run tail | **Confirmed** | Parent recovery retains `history.slice(prefixLength)` including current-run tool rounds; no summarization of live tail; child adapter handles completed rounds separately | Design parent current-run adapter (C3 deferred) that can compact completed batches within the same run without replaying tools |
| F10 — parent cloud chat has no recovery | **Confirmed** | `useMemoryPalace.schedule` returns immediately for cloud; `recoverContext` installed only `!cloud` in `ipcHandlers.js`; cloud parent has no checkpoint/summary path | Explicitly document as unsupported or implement equivalent cloud adaptation |
| F11 — failures not durable/specific | **Confirmed** | Checkpoint exceptions → `checkpoint-generation-failed`; validation → `checkpoint-invalid` without details; panel keeps only last event; no durable attempt history | Persist structured attempt records with stage/reason/measurement; expose in panel; survive reload |
| F12 — idle cancellation / engine identity incomplete | **Partial** | Idle accepts abort signal but production supplies none; no tools/output caps forwarded; engine identity not validated at commit | Add identity check to idle commit; forward caps; provide cancellation channel |
| F13 — fixed overhead large / not exposed | **Confirmed** | Native schemas ~12.5k tokens; base/session instructions ~20.4k chars; panel shows content-only estimate (7k) not full prepared (~36k) | Add component-breakdown display; expose fixed overhead in dashboard; do not present partial estimate as full request size |

---

## 5. Current architecture diagram (simplified)

```
User message → sessionManager.saveMessage → taskBriefs.captureBriefForUserMessage (Workspace only)
  → promptBuilder.buildSessionSystemPrompt / rebuildChatMessages
    → brief + checkpoint + summary + workLog + plan + system + active messages
      → measurePreparedContext (promptMeasurement) → createPromptMeasurer → /props + /apply-template + /tokenize
        → budgetContract (contextBudget.createRuntimeBudget)
          → guard (contextBudget.createContextGuardedFetch) → recoverContext (compressionEngine.recoverContextOverflow)
            → summarizeCandidates / generateCheckpoint → compactTranscript / checkAndCompressContext
              → atomic DB transaction (archive + summary + checkpoint + brief identity + evidence fingerprint + leaf)
                → rebuilt prompt (rebuildChatMessages with brief/checkpoint/summary) → continuation
```

Key ownership:
- **Budget / measurement:** `contextBudget.js`, `promptMeasurement.js`
- **Lifecycle / scheduling:** `compressionEngine.js` (idle + forced)
- **Checkpoint / evidence:** `taskCheckpoints.js`
- **Brief permanence:** `taskBriefs.js`
- **Prompt construction:** `promptBuilder.js`, `sessionManager.js`
- **UI / events:** `MemoryPalace.jsx`, `ContextPanel.jsx`, `ipcHandlers.js`
- **Child continuity:** `src/lib/memoryChat.mjs`, `subagents/contextRecovery.js`

---

## 6. Runtime budget analysis (key scenarios)

From C1 report and code verification:

| Scenario | Configured | Slots (reported) | Per-slot /props | Reserve (1k out + 128 safe) | Usable input | 90% trigger | Note |
|---|---|---|---|---|---|---|---|
| 100K 1 slot | 100,000 | 1 → 100,000 | 100,000 | 1,152 | 98,848 | 88,963 | Authoritative if `/props` confirms 100k |
| 100K 2 slots | 100,000 | 2 → ~50,000 (or exact) | 50,000 (if reported) | 1,152 | 48,848 | 43,963 | Must use reported per-slot, not divide manually |
| 70K 2 slots (incident) | 70,000 | 2 → 35,072 | 35,072 | 1,152 | 33,920 | 30,528 | C1 verified |
| Changing model / reload | — | — | New /props | — | New | New | Cache must invalidate; current cache key misses capacity |
| Image attached | — | — | Same | Same + 4096/image | Reduced | Reduced | Approximate fallback; exact vision count unknown |

**Critical:** The guard (`createContextGuardedFetch`) measures the actual wire payload with the same backend capacity used for the request. The header (`MemoryPalace.jsx`) and idle scheduler (`compressionEngine.js`) use the same `budgetContract` when measured correctly. Divergence remains possible if the header uses cached/stale measurement or configured total instead of refurbished contract.

---

## 7. Trigger analysis

- **Trigger mechanism:** `atCompactionPressure(budget)` checks `budget.currentInputTokens >= budget.autoCompactionTriggerTokens` (0.90 of usable input).
- **Idle scheduling:** `scheduleIdleCompression` resolves current measurement, checks `atCompactionPressure(measured.budgetContract)`, and runs `checkAndCompressContext` after 10s.
- **Forced recovery:** `recoverContextOverflow` calls `checkAndCompressContext` with `force=true`; no threshold check.
- **Workspace-only policy:** `compressContext` uses `isWorkspace` (from `taskBriefs.isWorkspaceSession`) to decide whether to build checkpoint; casual skips checkpoint. This is an authoritative separator (session `project_id` not null), not a heuristic.
- **Safety:** Active `in_progress` messages block idle and force archival at selection and commit. Status-change during generation rolls back atomically (C3).

---

## 8. Summary / checkpoint reliability

- **Generation callbacks (**`main.js`**):** Read `choices[0].message.content`; no `finish_reason` inspection; no reasoning-only rejection; no tool-bearing rejection; no structured-output enforcement; no bounded repair; no prior-state preservation (`retainPrior` not passed by parent).
- **Validator (**`taskCheckpoints.js`**):** Handles malformed JSON safely (returns `ok: false`); validates schema; binds sources to evidence index; strips untrusted keys; caps arrays; reports repair notes. Strong for what it validates.
- **Evidence:** `collectEvidence` reads `executionSteps`; classifies by `status` and result; binds to message/step IDs. Requires successful step for `completedWork`. Good invocation of durable evidence.
- **Gap:** The draft from model is not reliably complete/valid because the callback doesn't enforce completeness. The validator fixes what it can, but cannot invent missing evidence.

---

## 9. Task brief and evidence architecture

**Durable storage (SQLite):**
- User prompts / attachments: `messages` + `message_attachments`
- Task briefs: `workspace_task_briefs` (append-only, supersedes via `supersedes_id`)
- Checkpoints: `workspace_checkpoints` (current/superseded, binds to summary/leaf/brief/archived IDs / evidence fingerprint)
- Summaries: `session_summaries`
- Execution steps: `messages.execution_steps`
- Plans / work logs: separate tables (`workspace_plans`, `work_digests`)

**Active prompt inclusion:** `rebuildChatMessages` builds from brief (`buildTaskBriefSection`), checkpoint (`buildCheckpointSection`), summary, system, active messages, work log, plan. Original messages preserved; archived messages excluded from active path but stay in DB.

**Compaction preservation:** Brief identity checked at snapshot and commit; brief records stay durable; checkpoint generated from selected candidates + briefs + evidence; summary updated; originals archived.

**Verification needed:** Whether all user instructions survive multiple compactions depends on brief capture (yes, for applicable path messages), checkpoint preservation of requirements (capped at 50; may drop newest if >50), and summary synthesis quality (not guaranteed).

---

## 10. Under-5K target feasibility

**Proposed metric:** `compactedTaskHistoryTokens` = tokens of the active model-facing task-history portion excluding:
- Fixed system/dev instructions (`buildSessionSystemPrompt`)
- Active tool schemas (`getToolContext` output)
- Unavoidable prompt overhead (memory, project context, base rules)
- Protected current-run live tail (open messages + pending pairs)
- Brief section (authoritative, must remain exact or referenced)
- Checkpoint section (structured state, bounded by cap ~8k chars)

**Measured/estimated breakdown (illustrative, from C13 and code):**
- System + instructions + project context: ~20k chars (~5k tokens)
- Tool schemas (native 48 + MCP): ~12.5k tokens
- Brief section (5 short briefs ~500 chars each + wrappers): ~1k tokens; long briefs much more
- Checkpoint (minimal): ~1–2k tokens; with many requirements/decisions approaches cap
- Rolling summary: 512 tokens (idle cap) or more
- Protected live tail (10 messages + execution): ~2–8k tokens depending on content
- Plan + work log: ~0.5–2k tokens
- Retrieval / attachments: variable

**Conclusion:** Even with aggressive summarization and minimal brief/checkpoint, the task-history portion (excluding fixed overhead) can easily exceed 5K when the live tail, brief, and checkpoint are included. The target is feasible only for very short runs with minimal requirements, few tools, and a very short protected tail. It must not be interpreted as permission to drop required state.

**Separate metric:** `totalResumedRequestInputTokens` includes everything above plus reserve; must be verified independently against `usableInputTokens`.

---

## 11. Current-run protection

**Partial (C3):**
- Candidate selection excludes `in_progress` messages at selection and commit.
- Forced recovery stops at first open/excluded message; preserves entire suffix.
- Idle refuses if any active message `in_progress`.
- Atomic rollback if status changes during archival.

**Not implemented:**
- Independent completed-batch verification for parent (child adapter has it).
- Summarization of completed rounds within the current run.
- Protection of pending approvals / undelivered steering / background-command completions / active subagent results when they are not yet part of the open assistant row.
- Explicit exactly-once execution guarantee for tool results after compaction.

---

## 12. Tool-round compaction capability

- **Child adapter:** Completed tool pairs preserved; recent complete rounds retained; long-horizon compaction supported; prior checkpoint preserved boundedly.
- **Parent:** No equivalent adapter. Forced recovery keeps all live history after open row; does not summarize completed batches within the live tail. A very long run can reach irreducible floor (F09 confirmed).
- **Recommendation:** Build parent adapter using child design patterns (not cloning) that verifies complete batches, selects eligible completed rounds, preserves pair integrity, and keeps a small recent complete-round floor.

---

## 13. Prospective-fit behavior

- Forced path builds `buildProspectivePrompt` (brief + checkpoint + summary + system + continuation + retained tail + tools + exclusions).
- Measures with `measurePrompt` (exact tokenizer when available).
- Only exact tokenizer overage vetoes commitment; approximate overage allowed.
- Excludes some rebuilt sections (full retrieval/live-tail additions after measurement, exact work-log/plan sizing differences).
- If committed but final guard rejects, recovery can retry; but committed summary/checkpoint/archive are already persisted.
- **Defect:** A committed compression can still exceed budget after full rebuild if the prospective measurement missed additions or used approximate method.

---

## 14. Workspace / Casual Chat separation

- **Mode selector:** `project_id IS NOT NULL` in session / `isWorkspaceSession` in `taskBriefs.js`. Authoritative; persisted in `sessions`.
- **Compaction isolation:** `compressionEngine.js` uses `isWorkspace` to include/exclude checkpoint; brief section built only for Workspace; casual skips checkpoint and summary-only removal possible.
- **UI isolation:** `session:compression-complete` carries `sessionId`; no evidence of cross-tab leakage in code; events tied to session not global.
- **Risk:** If UI listener is not cleanly scoped to session, stale events could reach another tab. Existing `MemoryPalace.jsx` and `ContextPanel.jsx` use session/model guards, but full lifecycle schema (C4) not implemented.
- **Recommendation:** Implement session-scoped lifecycle events (`compactionstarted`, `compactionprogress`, `compactioncomplete`, `compactionfailed`) emitted only to sender owning that session, with session ID and run ID.

---

## 15. UI and IPC lifecycle

- **Existing:** `session:compression-complete` emitted on complete/failure; carries `sessionId`, `compressed`, `archivedCount`, `reason`, `before`/`after` not fully structured.
- **Missing:** Start/progress events; explicit failure taxonomy; session-scoped delivery; durable attempt history; before/after accurate token measurements (current measurement may be partial/estimated); safe display of summary without hidden reasoning/tool payloads.
- **Recommendation (C4):** Add event schema; emit start when timer fires / forced called; emit progress if multi-pass; emit complete/failure with structured fields; survive tab switch via session-scoped persistence in panel state or DB attempt log; display only safe fields.

---

## 16. Concurrency and cancellation

- **Lock:** SQLite `is_compressing = 1` with `UPDATE ... WHERE is_compressing = 0`; concurrent same-session calls share `inFlight` promise (`compressionEngine.js`).
- **Cancel:** `signal` (AbortController) passes through summarize/checkpoint/measure; final transaction uses `.immediate()` and does not check signal after commit starts. Good for pre-commit; limited post-commit cancellation.
- **Model reload / context change:** `runtimeIdentity` / `port` / `modelPath` checks exist in measurement and commit; but idle commit does not fully validate stable backend identity (F12).
- **Session switch / close:** No explicit handling found for tab close during idle; timer remains until cleared; if session deleted, lock should be cleared on restart (startup code does clear stranded flags).

---

## 17. Comparison with previous findings F01–F13 (status matrix)

See section 4 above for full table. Summary:
- **Fixed / Partial:** F01 (C1), F04 (C3 narrow), F06 (cache keys improved but invalidation missing), F12 (idle boundary improved).
- **Remaining open:** F02 (measure only), F03 (C2 missing), F05 (projection divergence), F07 (caps / size enforcement), F08 (continuity), F09 (current-run adapter), F10 (cloud parity), F11 (durable diagnosis), F13 (breakdown / UI).

---

## 18. Component reuse recommendations

| Phase | Reuse | Do not reuse / replace | Notes |
|---|---|---|---|
| C2 validation | `taskCheckpoints.validateCheckpoint`, evidence index, `cleanString`, `stripUntrusted` | Parent generation callbacks in `main.js` (need redesign, not reuse as-is) | Validator is solid; generation protocol must enforce completeness |
| C2 preservation | `taskBriefs` durable board, `rebuildChatMessages` brief/checkpoint injection | Do not drop brief identity guard | Briefs are authoritative |
| C3 adapter | Child adapter pair-preservation logic, bounded selection, `retainPrior` in `generateCheckpoint` (not passed by parent) | Child adapter code directly (different persistence semantics) | Design parent adapter from principles |
| C4 UI | Existing `session:compression-complete`, header/context hooks | Do not invent new measurement for events; rely on actual `budgetContract` | Use session-scoped event delivery |

---

## 19. Proposed implementation roadmap (phased)

**Priority order justified by audit:** Correctness (C2) > Continuity (C3 full) > UI visibility (C4) > Real verification.

1. **Phase C2 — Reliable generation and validation** (high)
   - Redesign parent `llmSummarizeCallback` and `llmCheckpointCallback` to enforce finish reason, visible content, structured JSON, evidence binding.
   - Implement bounded repair/retry; preserve earlier validated state; report specific failure.
   - Fix array caps / byte enforcement; replace repeated brief text in checkpoint with references.
   - Files: `main.js`, `compactionCore.js`, `taskCheckpoints.js`
   - Tests: adversarial response tests (empty, reasoning-only, truncated, malformed)

2. **Phase C3 — Parent current-run adaptation** (high, depends on C2)
   - Build parent adapter verifying complete concurrent tool batches.
   - Preserve pending approvals, steering, background completions, subagent results independently of open row.
   - Allow bounded compaction of completed batches within live run.
   - Files: `compressionEngine.js`, `memoryChat.mjs` patterns, new adapter module
   - Tests: long-run simulation with completed-round selection

3. **Phase C4 — Workspace-only lifecycle UI and IPC** (medium)
   - Define event schema; emit start/progress/complete/failure tied to session/run.
   - Add durable attempt log (DB or in-memory bounded); display before/after measurements safely.
   - Ensure events survive reload and do not leak to other tabs / Casual Chat.
   - Files: `ipcHandlers.js`, `preload.js`, `MemoryPalace.jsx`, `ContextPanel.jsx`

4. **Phase budget / measurement refinement** (medium, partly C1 done)
   - Unify estimator (approximate vs exact) in projection and guard.
   - Add exact measurement when possible; document approximate clearly.
   - Fix cache invalidation; refresh on engine identity / capacity change.
   - Files: `promptMeasurement.js`, `contextBudget.js`

5. **Phase verification** (high, ongoing)
   - Real disposable-session smoke tests with loaded model (not production chat).
   - Verify 90% trigger with 1-slot and 2-slot backend configurations.
   - Confirm under-5K feasibility only when conditions met; never enforce blindly.
   - Document irreducible floor.

---

## 20. Regression / environment notes

- No production code edited by this audit.
- Existing uncommitted changes preserved (see `git status`).
- Tests executed deterministically: `contextC1.test.cjs` (29 pass), `contextC3LiveProtection.test.cjs` (5 pass), focused regression 17/17 pass.
- Full suite: 219 files, 188 pass, 31 fail (same as baseline; no new failures; no resolved baseline failures).
- Electron UI fixtures (`contextPanel.ui.cjs`, etc.) blocked by sandbox (`Operation not permitted`); not claimed.
- No real llama.cpp smoke performed; no loaded model available in environment.

---

## 21. Limitations

- This is a read-only architecture audit, not an implementation or live-model benchmark.
- Several failure modes (checkpoint generation quality, exact vision token cost, long-run live-tail reduction) require disposable live-model sessions after design approval.
- The exact failed checkpoint from the screenshot session cannot be reconstructed (response not retained); only structural defects confirmed.
- Under-5K target feasibility depends on specific session content and must be verified per-session.

---

## 22. Open questions requiring product decisions

1. Should Workspace compaction be enabled by default, or only after C2 is complete?
2. Should the 5K task-history target be a hard gate, a recommendation, or only reported as a separate metric?
3. Should completed tool rounds within a long live tail be summarized automatically, or only on explicit user request?
4. Should cloud parent chats eventually support equivalent compaction, or remain out of scope explicitly?
5. What is the acceptable failure mode when the resumed request exceeds budget after committed compaction (rollback? notify? retry?)?
6. Should arbitrary image token approximations be treated conservatively (potential false refusal) or sent for authoritative backend validation?

---

## 23. Handoff for first recommended coding phase

**Phase to start:** **C2 — Reliable summary/checkpoint generation**.

**Why:** All other phases depend on validated continuity. Committing compaction with unvalidated generation undermines user data.

**Reusable components:** `compactionCore.generateCheckpoint`, `taskCheckpoints.validateCheckpoint`, `taskBriefs.getApplicableBriefs`, evidence index.

**Files likely affected:** `main.js` (generation callbacks), `compactionCore.js` (summarize/validate/retain), `taskCheckpoints.js` (caps/enforcement/byte measurement).

**Dependencies:** None blocking; can begin independently of C4 or full C3 adapter.

**Acceptance criteria:** Adversarial responses (empty, reasoning-only truncated, malformed JSON, unsupported tool-bearing) either recover with specific reason or leave durable state unchanged; requirements preserved for >50 briefs; checkpoint fits cap with full brief references rather than repeated text.

**Tests needed:** Adversarial deterministic response tests; 51-brief coverage; truncation repair; structured-output validation.

**Rollback:** No DB schema changes needed for C2 alone; generation callbacks can revert independently.

---

*Audit complete. No implementation performed. Ready for separately authorized implementation task.*
