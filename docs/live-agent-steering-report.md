# Phase 2.1 — Live Agent Steering

**Status:** implementation, deterministic verification, regression comparison, UI verification, and production build complete.

**Date:** 20 October 2026

**Phase boundary:** this report and its code stop at Phase 2.1. Phase 2.2 was not started.

---

## 1. Objective and scope

Phase 2.1 lets a user submit an instruction while a **main-agent run is still executing**, without cancelling, restarting, or duplicating the run. The instruction is delivered to the model at the next safe model-request boundary, and the UI reports whether it is queued, in flight, delivered, withdrawn, or undelivered.

The delivered capability is deliberately narrow:

- main-agent runs only; sub-agent runs remain isolated and cannot be steered;
- one text instruction at a time, up to 4,000 characters;
- delivery only immediately before a model request, never in the middle of a streamed response or a tool execution;
- a bounded continuation when an instruction arrives during the final answer;
- durable, inspectable status in SQLite;
- no new execution engine, no second chat loop, and no background daemon.

Steering is an **out-of-band instruction attached to one already-running turn**. It is not a new conversation turn, and it is not replayed into later turns.

## 2. Constraints and non-goals honored

| Requirement | Result |
| --- | --- |
| One chat engine, one model/tool loop | Met. `runMemoryChat` remains the only main-agent loop; steering is a callback boundary inside it. |
| No automatic run restart | Met. Steering never aborts or recreates the run. |
| No direct child-agent steering | Met. The sub-agent loop in `src/main/subagents/agentLoop.js` is unchanged and receives no steering hooks. |
| No hosted or external queue | Met. The queue is the existing SQLite database plus in-memory run ownership. |
| No background daemon | Met. No process or timer owns steering; it exists only while a run exists. |
| No mid-tool or mid-stream injection | Met. Instructions enter `history` only at the top of the request loop or immediately before final-answer return. |
| Never bypass permissions | Met. Steered tool calls go through the existing permission/approval path. |
| Never falsely mark applied | Met. `delivered` means the model transport accepted a request containing the instruction; it does not claim the model obeyed it. |
| Preserve existing work | Met. No commit, push, stash, reset, clean, or unrelated file rewrite was performed. |
| No paid inference in tests | Met. Every new test uses deterministic in-process mocks. |

**Non-goals:** editing a previously delivered instruction, steering sub-agents, steering across app restarts, replays of steering in later turns, a second composer or modal, and an unbounded continuation chain.

## 3. Existing behavior audited before implementation

The audit identified four existing mechanisms that could have been misused:

1. **`engine:chat` / `runMemoryChat`** — the main run is created in `src/main/ipcHandlers.js`, keyed in `activeStreams` by session, and executed by `runMemoryChat` in `src/lib/memoryChat.mjs`.
2. **Post-run prompt queue** — `promptQueue` / `Ctrl+Shift+Enter` stores prompts to send **after** the current turn. It is a different feature and was preserved unchanged.
3. **Sub-agent loop** — `src/main/subagents/agentLoop.js` has its own isolated execution and was not touched by steering.
4. **Message persistence** — normal turns are persisted through `sessionManager` / `engineManager`. Steering was deliberately kept out of that path.

The audit also confirmed that `runMemoryChat` already has a clean notion of a request boundary: the top of its `while (executionState === 'running')` loop, where `requestPayload` is snapshotted from `history`.

## 4. Architecture and reuse decision

New file: `src/main/runSteering.js` (338 lines).

Existing infrastructure reused:

| Existing module | Reuse |
| --- | --- |
| `src/main/db.js` | Same SQLite connection, schema template, transactions, and session cascade trigger. |
| `src/main/ipcHandlers.js` → `activeStreams` | Trusted in-memory source of the executing run. |
| `src/main/engineManager.js` → `notifyChatOutcome` / persistence | Run outcome and assistant persistence are untouched. |
| `src/lib/memoryChat.mjs` | Steering is added as optional callbacks; all non-steering paths remain byte-identical. |
| `src/preload.js` `chatAPI` | Steering methods live beside the existing chat bridge methods. |

**Why a dedicated table instead of inserting into `messages`.** A steering row in `messages` could be mistaken for a new user turn, alter the active branch, be replayed by normal prompt construction, or produce a second assistant reply on reload. `run_steering_messages` is a separate audit/lifecycle table. The instruction is injected into the **in-memory** run history only.

## 5. Steering lifecycle and states

The queue uses five states:

| State | Meaning | Terminal |
| --- | --- | --- |
| `queued` | Persisted and waiting for a safe checkpoint. | No |
| `claimed` | Selected for the next request; the transport has not confirmed acceptance. | No |
| `delivered` | Included in a request whose transport returned a response. | Yes |
| `undelivered` | The run ended, the request failed, or startup found an orphan. | Yes |
| `cancelled` | Explicitly withdrawn by the user before delivery. | Yes |

**Why `claimed` is necessary.** A request can be in flight when the process dies. Marking the row `delivered` before the transport returns would over-claim; leaving it `queued` would let a recovery path replay it. `claimed` makes the crash window explicit. On startup every surviving `queued` or `claimed` row is marked `undelivered` with the reason:

> The application closed before delivery could be confirmed.

`cancelled` is allowed only from `queued`. Once a row is claimed, withdrawal is rejected because the request may already contain it.

## 6. Persistence and schema migration

`src/main/db.js` adds one additive table:

```sql
CREATE TABLE IF NOT EXISTS run_steering_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued', 'claimed', 'delivered', 'undelivered', 'cancelled')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  delivered_at TEXT,
  delivery_request_id TEXT,
  failure_reason TEXT,
  UNIQUE(session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_steering_session
  ON run_steering_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_steering_run_state
  ON run_steering_messages(session_id, run_id, state);
```

Backward compatibility:

- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` add the structure to an existing database without rewriting any existing table.
- The follow-up adds one nullable `messages.run_id` column through `ALTER TABLE messages ADD COLUMN run_id TEXT`. Existing replies keep `NULL` and simply have no additional-prompts footer; no row is rewritten.
- The `sessions_cascade` trigger now also deletes `run_steering_messages` for a deleted session.
- Startup reconciliation runs inside the existing initialization transaction, after schema creation.

The index deliberately does not reference `rowid`: SQLite rejects `CREATE INDEX ... (rowid)`. Insertion order is still obtained with `ORDER BY rowid`, which is stable for this table.

`messages.run_id` is intentionally **not** a foreign key to a runs table: the run registry is in-memory and ephemeral, while the id is retained only to group delivered steering instructions with the reply they shaped. It is never used by prompt construction.

## 7. Delivery boundaries in the model loop

`runMemoryChat` receives three optional callbacks:

- `takeSteeringInstructions()` — claim the next batch;
- `markSteeringDelivered(ids, requestId)` — confirm transport acceptance;
- `markSteeringUndelivered(ids, reason)` — report a failed or abandoned batch.

At the **top of every request iteration**, before `requestPayload` is built:

1. If no batch is already in flight, ask for queued instructions.
2. Inject each as a genuine `user` message:

   ```
   User steering instruction received during this run:
   <instruction>
   ```

3. Snapshot `history` into the request payload.
4. After `send()` returns a successful response, mark the batch `delivered`.
5. If `send()` throws before acceptance, mark the batch `undelivered` and rethrow.

A single `steeringBatch` guard prevents the same instruction from being read twice. The instruction is never injected while streamed text, tool arguments, or tool results are being produced.

## 8. Final-answer race and bounded continuation

An instruction can arrive after the final request snapshot but before the model has finished answering. That is the only remaining safe point.

After a response with **no tool calls**:

1. Check the queue once more, immediately before the final return.
2. If instructions arrived:
   - push the model's answer as an `assistant` message;
   - inject the new instructions as `user` messages;
   - continue the loop.
3. If the continuation cap is reached, do not claim more; return the answer and let run finalization mark the remaining rows `undelivered`.

The cap is `maxSteeringContinuations`, default **8**, validated to 1–100. This prevents an instruction-per-final-answer loop from keeping a run alive indefinitely.

This path also guarantees that `onStats` runs only on a true return, so token/cost accounting still reports one completed turn containing all request phases.

## 9. Context compaction and prompt integrity

`history` is the only transcript modified by steering. `prefixLength` marks the historical prefix; context recovery rebuilds that prefix and preserves:

```js
const tail = history.slice(prefixLength);
history.splice(0, history.length, ...rebuiltPrefix, ...tail);
```

Steering instructions are always appended after `prefixLength`, so they survive compaction together with the current run's tool transcript. A deterministic test forces `recoverContext` and asserts that the rebuilt request still contains the steering message and the tool result.

Steering is **not** written into `messages`, so:

- it cannot become a new visible conversation turn;
- it cannot corrupt the active branch;
- normal prompt construction cannot replay it in a later turn;
- the persisted assistant answer remains the durable record of the run.

## 10. Permissions, approvals, and sub-agent isolation

- Steering is plain user text. Any tool the model chooses because of it enters the existing permission guard (`src/main/toolPermissions.js`) and the existing approval UI.
- No permission mode is inferred from the renderer, and no steering IPC path calls a tool directly.
- The sub-agent loop receives no steering hooks. Child runs keep their own model, tools, budgets, and transcript.
- Task plans, work logs, checkpoints, execution steps, streaming, and token accounting are unchanged.

## 11. IPC and preload contract

### Main-process channels

| Channel | Payload | Result |
| --- | --- | --- |
| `steering:submit` | `{ sessionId, runId, content, idempotencyKey }` | `{ record, duplicate }` |
| `steering:active` | `{ sessionId }` | `{ sessionId, runId }` or `null` |
| `steering:history` | `{ sessionId, limit? }` | ordered array of records |
| `steering:cancel` | `{ sessionId, runId, steeringId }` | updated record |

### Preload (`window.chatAPI`)

```js
steer({ sessionId, runId, content, idempotencyKey })
getActiveRun(sessionId)
getSteeringHistory(sessionId, limit)
cancelSteering({ sessionId, runId, steeringId })
onSteering(callback)
```

Events use `steering:updated`. Submission includes the content; later state transitions omit it because the renderer already has it from the submit response or history read. This prevents status events from becoming a second copy of the instruction.

## 12. Session and run ownership validation

A renderer cannot steer another session merely by supplying its id.

- The **run id is minted in the main process** with `crypto.randomUUID()` and announced on `engine:stream-status`.
- `steeringRuns` is a trusted main-process map of `runId → { runId, sessionId, sender, controller }`.
- `resolveSteeringRun` requires:
  1. a known run id;
  2. the supplied session id to match the run;
  3. the invoking `event.sender` to be the sender that started the run;
  4. the controller not to be aborted;
  5. `activeStreams.get(sessionId)` to still be that controller.
- Submission, cancellation, and active-run lookup all use this check.
- `steering:history` requires a valid, existing session. It is a read of data the trusted renderer can already load through the session APIs.
- Every channel passes through the existing `isTrustedSender` gate before dispatch.

`steering:cancel` additionally verifies that the row's `run_id` matches the supplied active run **before** mutating it.

## 13. Input validation and limits

| Control | Limit / behavior |
| --- | --- |
| Content | Non-empty after trim; no NUL; ≤ 4,000 characters |
| Idempotency key | Non-empty; no NUL; ≤ 128 characters |
| Duplicate key | Same `(session_id, idempotency_key)` returns the existing row, `duplicate: true` |
| Pending queue | ≤ 20 `queued` + `claimed` rows per run |
| History read | 50 by default; clamped to 200 |
| Batch claim | Atomic transaction, ordered by `rowid` |
| Delivery request | One request id per claimed batch, recorded in `delivery_request_id` |

An IPC retry cannot duplicate an instruction, and a claim cannot be consumed twice.

## 14. Renderer composer behavior

`ChatInputBar` remains fully editable while `streaming` is true.

- **Enter** during execution steers the run instead of submitting a new turn.
- **Steer** is a distinct action from **Stop**:
  - Steer is an outlined accent button and requires non-empty text;
  - Stop is a separate button and remains available even with an empty draft.
- The draft is **not** cleared by the composer. The parent clears it only after `steering:submit` resolves, and `clearSubmitted(text, sessionId)` still refuses to clear if the user typed something newer.
- On failure, the draft remains and the error is shown in the steering panel.
- `Ctrl+Shift+Enter` still queues a prompt for after the run, preserving the previous feature.
- The idle Send button is unchanged in function.

## 15. Steering status panel and live events

`ChatInterface` tracks the run id from `engine:stream-status` and the session's steering history.

The compact panel above the composer:

- shows the current run's instructions while the run is active;
- **disappears when the run finishes once every instruction was delivered or withdrawn**; a delivered instruction is a transient acknowledgement, not a permanent chat artifact;
- keeps only `undelivered` rows visible after completion, so a real failure is never hidden;
- labels each state as Queued, Delivering…, Delivered, Not delivered, or Withdrawn;
- shows the failure reason for undelivered rows;
- allows **Withdraw** only while a row is still queued;
- merges live `steering:updated` events without erasing known content;
- survives a tab switch by reloading persisted history;
- resolves an already-running session through `steering:active`;
- has a chevron on the `Steering` header that rotates to indicate the collapsed state.

No modal, second composer, or new theme variable was introduced.

### Additional prompts on the completed reply

Once a run finishes, everything the user contributed mid-run moves from the transient status panel into a compact footer at the bottom of the reply it helped produce:

- the heading is **Additional prompts**;
- when steering instructions are present, a one-line explanation says they were sent while the task was running;
- delivered steering instructions are listed in submission order;
- `queued`, `undelivered`, and `cancelled` steering rows are never shown as if they shaped the answer;
- **the questions the agent asked** are listed with the question text and the answer the user gave (`Answered: …`), and a cancelled question is reported as such;
- **the skill-registry decisions** are listed with the proposed skill name, its description, and the approved/declined outcome;
- only resolved interactions are shown: a live/pending question or an undecided skill proposal produces no entry;
- the footer is hidden while the reply is streaming and is absent when there is nothing to list;
- the footer survives reloads because `messages.run_id` links the reply to the persisted steering rows, and questions/skills are re-derived from the reply's recorded steps;
- regeneration updates the reply's run association, and the active reply variant selects its own run so switching variants cannot show another run's prompts;
- no per-prompt database write, new chat message, or prompt-construction change is involved.

The footer is implemented once in `src/components/AdditionalPrompts.jsx` and used by both Casual Chat and Workspace mode. The resolved-interaction rows are rendered by the existing `TurnOutcomes` component, which is now hosted inside the footer rather than as a separate row beneath the reply, so the completed task keeps a single consolidated record.

## 16. Failure handling and truthful status

| Failure | Status outcome |
| --- | --- |
| Transport throws before acceptance | `undelivered` with the transport reason |
| HTTP request fails | `undelivered` after the existing retry path exhausts |
| Transport returns a response | `delivered`; streaming failure afterward does not retract it |
| Run ends with queued rows | `undelivered` with the run-end reason |
| Run is stopped with queued rows | `undelivered` with the stop reason |
| A claimed row survives a crash | `undelivered` with the explicit ambiguity reason |
| User withdraws a queued row | `cancelled` |
| User tries to withdraw a claimed row | Rejected; it may already be in the request |

A steering read or status-write failure is logged and never breaks an otherwise healthy run.

## 17. Crash recovery and startup reconciliation

No main-agent run survives an application restart in this architecture. Therefore every `queued` or `claimed` row found at startup is an orphan:

```sql
UPDATE run_steering_messages
SET state = 'undelivered',
    failure_reason = 'The application closed before delivery could be confirmed.'
WHERE state IN ('queued', 'claimed');
```

The rows are retained for inspection. They are never attached to a later run and are never described as delivered. A deterministic test simulates both a never-claimed row and an in-flight row, reopens the database, and verifies both become `undelivered`.

## 18. Concurrency and multi-session isolation

- A session has at most one active main run because `activeStreams` is keyed by session.
- Steering rows are scoped by `(session_id, run_id)` and by an owning sender.
- Two sessions can run concurrently; each has its own queue, run id, status events, and history.
- A claim transaction takes only rows for its own session and run.
- Finalization deletes the in-memory run registration **before** closing the durable queue, so a late submission cannot be queued after reconciliation.

## 19. Files and functions modified

| File | Change |
| --- | --- |
| `src/main/runSteering.js` | **New.** Queue persistence, lifecycle, validation, history, recovery. |
| `src/main/db.js` | Additive steering table, indexes, session cascade, startup reconciliation, additive `messages.run_id`. |
| `src/lib/memoryChat.mjs` | Optional steering hooks; boundary claim/inject; confirm/fail; final-answer continuation; continuation cap. |
| `src/main/ipcHandlers.js` | Run id minting, steering run registry, four IPC handlers, status events, finalization ordering, preload-facing ownership checks, reply/run association. |
| `src/main/engineManager.js` | Persists the producing run id on each assistant reply. |
| `src/main/messageVariants.js` | Carries the producing run id into each reply variant. |
| `src/preload.js` | Five `chatAPI` steering methods. |
| `src/components/ChatInputBar.jsx` | Editable-during-run steering, separate Steer/Stop, Enter-to-steer, placeholder. |
| `src/components/main-app/ChatInterface.jsx` | Run tracking, submit/withdraw flows, auto-hiding status panel with collapse chevron, completed-reply prompt footer with resolved interactions. |
| `src/components/AdditionalPrompts.jsx` | **New.** Shared completed-reply "Additional prompts" footer (steering instructions + questions + skills). |
| `src/components/chat/TurnOutcomes.jsx` | Renders structured question/skill interactions (question text, answer, skill detail) inside the footer. |
| `src/components/chat/WorkspaceTimeline.jsx` | Passes steering instructions and resolved interactions to the shared footer. |
| `src/lib/executionEvents.mjs` | `getTurnInteractions` (structured questions/skills); `getTurnOutcomes` becomes its label projection; `activeStepsOf` exported. |
| `src/lib/steeringDisplay.mjs` | **New.** Tested display helpers: state labels, event/history merge, post-run visibility filter, delivered prompts by run, active-variant run selection. |
| `tests/liveSteering.test.cjs` | **New.** Persistence, ordering, idempotency, cancellation, finalization, recovery, cascade. |
| `tests/liveSteeringLoop.test.mjs` | **New.** Loop boundaries, final-answer race, cap, transport failure, compaction survival, no-hook baseline. |
| `tests/liveSteeringIpc.test.cjs` | **New.** Real IPC handlers, run ownership, idempotency, cancellation, delivery events, reply/run persistence. |
| `tests/steeringDisplay.test.mjs` | **New.** Post-run hiding, non-regressing history merge, content preservation, footer filtering, variant selection. |
| `tests/liveSteering.ui.cjs` | **New.** Composer steering UI. |
| `tests/steeringPrompts.ui.cjs` | **New.** Completed-reply additional-prompts footer. |

No dependency was added.

## 20. Deterministic test additions

All new tests use local mocks; none calls a paid or local inference server.

- **Persistence (9 tests):** queued submission, duplicate idempotency, ordered claims, cross-run isolation, confirmed delivery, failed delivery, finalization of queued vs claimed rows, withdrawal rules, history scoping, validation/limits, session cascade, startup recovery.
- **Loop integration (7 tests):** unchanged behavior without hooks, boundary injection after a tool result, submission ordering, final-answer continuation, continuation cap, transport failure, context-recovery survival.
- **IPC integration (1 end-to-end scenario):** real `engine:chat` with a held first request; generating run id; stranger sender rejected; wrong session/run rejected; duplicate key suppressed; withdrawal from owner only; continuation delivery; idle event; post-run rejection.
- **Steering display (10 tests):** active-run filtering, delivered/cancelled hiding after completion, undelivered retention, non-regressing event/history merge, content preservation, state labels, delivered-prompt filtering, missing-run handling, active-variant run selection.
- **Turn interactions (+3 tests in the existing suite):** structured question/answer/skill entries, free-text and cancelled questions, and labels staying the projection of the structured interactions.
- **Renderer (2 Electron scenarios):** editable composer with separate Steer/Stop, Enter steering, draft preservation, busy disable, queue shortcut, whitespace rejection; completed-reply footer with heading, explanation, ordered instructions, multi-line preservation, question text + answer, skill registry text, cancelled questions, and empty-state hiding.

Added test files/functions: **30 Node tests** across `liveSteering.test.cjs` (9), `liveSteeringLoop.test.mjs` (7), `liveSteeringIpc.test.cjs` (1), `steeringDisplay.test.mjs` (10), and three added cases in `turnOutcomes.test.mjs`, plus the two Electron scenarios.

Commands:

```bash
node --test tests/liveSteering.test.cjs tests/liveSteeringLoop.test.mjs \
  tests/liveSteeringIpc.test.cjs tests/steeringDisplay.test.mjs tests/turnOutcomes.test.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/liveSteering.ui.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/steeringPrompts.ui.cjs
```

Result:

- Node steering/footer tests: **38 / 38 passed** (27 steering + 11 turn interactions).
- Renderer steering and footer tests: **passed**.
- Existing composer UI test (`tests/chatInputPerformance.ui.cjs`): **passed**, confirming the new buttons did not break the original idle/streaming behavior.
- `tests/replyVariants.test.cjs`: **passed**, including the run id carried into variants and across reload.

## 21. Full-suite regression comparison and production build

`npm test` is still broken on this Node 22 environment (bare directory argument), so the established command was used:

```bash
node --test tests/*.test.cjs tests/*.test.mjs
```

| Run | Total | Passed | Failed |
| --- | --- | --- | --- |
| Pre-change baseline | 1,424 | 1,396 | 28 |
| Phase 2.1 core (before UI follow-up) | 1,441 | 1,413 | 28 |
| Phase 2.1 + auto-hide/chevron follow-up | 1,448 | 1,418 | 30 |
| Phase 2.1 + additional-prompts follow-up | 1,451 | 1,424 | 27 |
| Phase 2.1 + questions/skills-in-footer follow-up (final) | 1,454 | 1,429 | 25 |

- Added tests: **30 Node tests** (27 steering/footer + 3 turn-interaction) plus two Electron renderer scenarios.
- The core run matched the baseline failure identities exactly: **same 28 failures**, compared by name, not by count.
- Across every post-change run the failing set stayed within the same pre-existing group: the 28 baseline identities plus, intermittently, cases from `tests/subagentModelSelection.test.cjs`. A name comparison of the final run found **no new failure identity**; the 25 failures are a subset of the baseline (the flaky cases 6, 7, and 8 happened to pass).
- The variable count (25–30) comes entirely from `tests/subagentModelSelection.test.cjs`, whose timing cases 6, 7, 8, 10, and 11 alternate between pass and fail across runs ("the child never reached the cloud model", "the messaged child never finished its turn"). No steering, display, footer, interaction, or variant test ever failed.

Production build:

```bash
npm run build
```

Result: **passed** (Vite 6.4.3, 1,822 modules). Only the existing chunk-size warning remains.

## 22. Limitations, risks, and phase boundary

**Limitations**

1. **Delivery means transport acceptance, not obedience.** The UI never claims the model followed the instruction.
2. **No true mid-tool injection.** An instruction submitted during a long tool call waits for the next request boundary. This is intentional safety, not a queue failure.
3. **One unavoidable micro-race.** An instruction submitted after the final queue check and before the return is marked `undelivered`; it is not silently applied.
4. **Steering is not replayed in later turns.** It is run-scoped and auditable in `run_steering_messages`, but the next turn's prompt is built from persisted messages only.
5. **Continuation cap.** After 8 final-answer continuations, further instructions remain undelivered for that run.
6. **No idle steering.** If no run is active, the composer sends a normal turn; the existing post-run queue remains the mechanism for sending after the current turn.
7. **History growth.** Steering rows are removed only when their session is deleted; there is no automatic retention policy yet.
8. **Child agents remain isolated.** Direct sub-agent steering was explicitly out of scope.

**Risks reviewed**

- Permissions cannot be bypassed by steering.
- Session/run ownership is enforced from trusted memory, not renderer-supplied identity.
- Status is never upgraded optimistically; the ambiguous crash window is explicit.
- Token accounting remains single-writer because `onStats` is deferred past continuations.
- Context recovery preserves in-run steering because it lives in the tail.

**Phase boundary:** implementation stops here. Phase 2.2 was not started, and no code was committed or pushed.
