# Agentic Phase 1.2 — Durable Task Plan (`update_plan`)

Status: implemented, tested, and stopped for review. No commit or push was performed;
all changes remain in the working tree.

## 1. Objective

Give the Workspace agent a structured, persistent task plan it can create and update
incrementally across turns, and survive conversation compaction, session switching, and
application restart — without touching canonical messages, permanent memory, checkpoints,
or the work log.

Deliverable: a single tool, `update_plan`, a durable per-Workspace-session store, bounded
context injection, a read-only UI card, and focused tests.

## 2. Scope and constraints honored

- Phase 1.1 (`run_tests`) preserved and untouched; see §9.
- No subagent reliability, file deletion, or native web-search work.
- Permanent memory and its context injection were not redesigned.
- No unrelated inference / transcript / UI-performance code was modified.
- Task plans are **not** written to permanent memory and do **not** modify canonical
  messages.
- No plan is invented for Casual Chat sessions.
- No commit, push, or destructive Git command.

## 3. Step 1 findings — what already existed

Inspection of the workspace/session/task-brief/checkpoint/work-log/compaction/tool/UI
architecture established:

- **Workspace identity** is a session with `project_id IS NOT NULL`. Briefs
  (`workspace_task_briefs`), checkpoints (`workspace_checkpoints`), and turn digests
  (`workspace_turn_digests`) are all keyed by `session_id`, early-return for Casual Chat,
  and cascade when a session is deleted. This is the correct ownership model for a plan.
- **No reusable plan/checklist store exists.** The durable `checklist_state` table was
  dropped at `src/main/db.js:192`, and the `json:checklist` rich block was removed from
  the current prompt. Only `cards` and `flow` remain. The legacy checklist text in
  `RICH_BLOCKS_BASIC_CORE_V1` is retained solely for stripping old system prompts, so it
  was deliberately left untouched.
- **Persistence owner**: the Workspace session. A plan belongs to the same entity that
  owns briefs/checkpoints/digests; this yields per-tab correctness, restart persistence,
  and cascade-on-delete for free.
- **Context injection** happens in `prepareChatMessages` and `rebuildChatMessages`; the
  work log is injected last (measured prefix reuse). The plan follows it.
- **Compaction** (`compressionEngine`) projects an idle prompt from the same builders and
  has explicit `memoryTokens` / `workLogTokens` accounting; the plan needed the same
  token accounting so projections stay accurate.
- **Tool registration** lives in `agentTools.js` (`define(...)`), with permission
  capabilities in `toolPermissions.js` (`CAPABILITIES`, `capabilityOf`, `baseDecision`,
  `guardTool`) as the single source of truth for visibility and executability.

Conclusion: extend existing session infrastructure rather than build a second planning
system, and add the smallest schema that supports stable step identities.

## 4. Design

### 4.1 Ownership and durability

A plan is owned by a Workspace session. One plan row per session; steps are child rows
scoped by `session_id`. Casual sessions have no plan at every entry point.

New minimal tables (`src/main/db.js`):

```sql
CREATE TABLE workspace_plans (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
  objective  TEXT NOT NULL DEFAULT '',
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_plan_steps (
  id          INTEGER PRIMARY KEY,           -- stable identity
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  position    INTEGER NOT NULL,              -- display order, renumbered 1..N
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','in_progress','completed','blocked')),
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_plan_steps_session ON workspace_plan_steps(session_id, position, id);
```

- A new table was genuinely necessary: no durable task-progress store existed, the old
  `checklist_state` was removed, and reusing briefs/checkpoints would conflate an
  append-only verification checkpoint with mutable, per-step progress.
- Each update runs in one synchronous SQLite transaction (`.immediate()`), with no
  debounce, so a shutdown cannot lose a committed step.
- Step ids are global DB primary keys, but **every read and write also filters by
  `session_id`**. Two tasks can therefore never collide even if a model reuses a "local"
  step number.
- `sessions_cascade` deletes both tables; deleting a session removes its plan.

### 4.2 Tool interface — `update_plan`

One tool with `action: "create" | "update" | "get"`:

- `create` — requires a non-empty `steps` array. Errors if a plan already exists.
- `update` — incremental entries plus optional removals/objective:
  - entry with `id` → revise `description` / `status` / `note`;
  - entry without `id` → append a new step (requires `description`);
  - `remove_step_ids` → remove steps in the same call;
  - optional `objective`;
  - optional `expected_revision` → optimistic stale-write guard.
  Prefer incremental updates; the model never needs to resend the whole plan.
- `get` — returns the current plan; used on resume when the model is unsure.

Steps carry a stable `id`, an ordering `position`, a `description`, a `status`, and an
optional `note`. Statuses: `pending`, `in_progress`, `completed`, `blocked`.

### 4.3 Validation (fail loudly, never corrupt)

`src/main/workspacePlan.js` normalizes and validates before any write. A rejected request
returns `{ success: false, error, code }` and leaves the prior plan byte-identical.
Representative codes:

`INVALID_SESSION`, `INVALID_ARGUMENTS`, `INVALID_ACTION`, `INVALID_STEPS`,
`INVALID_STEP`, `UNEXPECTED_STEP_ID`, `MISSING_FIELD`, `INVALID_FIELD`,
`FIELD_TOO_LONG`, `INVALID_STATUS`, `INVALID_STEP_ID`, `DUPLICATE_STEP_ID`,
`EMPTY_STEP_UPDATE`, `EMPTY_UPDATE`, `UNKNOWN_STEP`, `CONFLICTING_STEP`,
`BLOCKED_NOTE_REQUIRED`, `PLAN_EXISTS`, `PLAN_NOT_FOUND`, `STALE_PLAN`,
`TOO_MANY_STEPS`, `PLAN_REQUIRES_WORKSPACE`, and `PLAN_PERSISTENCE_FAILED`.

Rules of note:

- `blocked` requires a non-empty concise explanation (`note`); an existing note satisfies
  it on a later status change.
- Descriptions/notes/objective are whitespace-collapsed and length-capped
  (500 / 600 / 500 chars); at most 50 steps.
- A step cannot be updated and removed in the same call.
- `expected_revision` mismatch → `STALE_PLAN`.
- Any unexpected DB error is wrapped as `PLAN_PERSISTENCE_FAILED`
  (`"Plan update was not saved: …"`); the transaction rolls back and **no UI event is
  emitted**, so a failed write is never presented as durable.

### 4.4 Permissions

New capability `CAPABILITIES.PLAN_WRITE` (`'plan_write'`), mapped for `update_plan`:

- denied without a workspace (Casual Chat) in every mode, including `full_access`
  (full access does not create a workspace);
- allowed autonomously in `workspace_write`, `ask_approval`, and `full_access`;
- denied in `read_only`;
- child agents stay read-only and `update_plan` is not in `CHILD_TOOL_NAMES`.

`baseDecision` and `guardTool` were kept in step so visibility and executability cannot
disagree in any mode. This also avoids rejecting legitimate workspace plan writes for
lack of a `writeTargets` file set.

### 4.5 Context injection and compaction

- `buildPlanSection(sessionId, { contextWindowLimit })` renders a bounded section
  (`PLAN_CHAR_CAP = 4000`, ~1,000 tokens) tagged `workspacePlan: true`,
  `planRevision`, `planStepCount`, `planTokens`.
- It is injected **last** in both `prepareChatMessages` and `rebuildChatMessages`
  (after the work log) to maximize reusable token prefix.
- Budget behavior: completed steps are folded first (oldest first) with an explicit
  "Omitted for budget" line; unfinished steps are never dropped, and only their
  descriptions are shortened. Blocker notes are re-appended after the shortened
  description so an explanation is never cut by the ellipsis. A progress summary always
  keeps completed work distinguishable.
- `getContextUsage` now returns `planTokens`, included in `totalTokens`.
  `compressionEngine.projectIdlePrompt` accepts/adds `planTokens` at all three call
  sites, mirroring `workLogTokens`, so idle-compaction projections stay accurate.
- Compaction reads the persisted plan but **never writes it**; a generated summary can
  neither advance nor complete a step. The same persisted source of truth is re-injected
  after compaction — the plan is not reconstructed from the model's summary.

### 4.6 UI

Read-only `WorkspacePlanCard` (`src/components/chat/WorkspacePlanCard.jsx`), mounted at
the top of the Activity tab of `RightSidebar` for workspace sessions. It shows the
objective, a progress summary and bar, each step with its status, the in-progress step
(`aria-current="step"`), blocked steps with their explanation, and the plan revision.

- Loads on mount/session change, then stays current from the `session:plan-updated`
  push.
- Filters every event by `sessionId` before touching state, and uses a request counter to
  discard stale in-flight reads, so a slow response can never show a previous task's plan
  after a tab/session switch.
- `memo`-wrapped; unrelated tabs do not re-render.
- Handles loading / empty / completed / error (with retry) states.
- Manual editing is intentionally unsupported this phase (only a manual Refresh), so
  manual interaction cannot conflict with agent updates.
- Reuses existing Tailwind tokens and React hooks; no new state-management dependency.

A `Plan (approx)` token row was added to `ContextPanel` next to the work-log row.

Presentation classification: `executionEvents.mjs` gains a `plan` kind/verb
(`'Plan'`, "Updated plan"), argument fields, and `run_tests` was added to its
`COMMAND_TOOLS`; `turnDigest.js` summarizes a plan tool call as "updated the task plan".

## 5. Files changed

New:

| File | Purpose |
| --- | --- |
| `src/main/workspacePlan.js` | Store, validation, stable ids, revisions, bounded prompt renderer. |
| `src/components/chat/WorkspacePlanCard.jsx` | Read-only Activity-tab plan card. |
| `tests/workspacePlan.test.cjs` | 14 focused main-process tests (incl. IPC push). |
| `tests/workspacePlan.ui.cjs` | Electron UI test: states, live update, tab isolation, stale switch. |

Modified (Phase 1.2):

| File | Change |
| --- | --- |
| `src/main/db.js` | `workspace_plans`, `workspace_plan_steps`, index, cascade deletes. |
| `src/main/tools/agentTools.js` | `update_plan` schema + dispatch before root resolution. |
| `src/main/toolPermissions.js` | `PLAN_WRITE` capability, mapping, casual/read-only/full-access denial. |
| `src/main/promptBuilder.js` | Plan section injected last in both builders; workspace autonomy rule. |
| `src/main/sessionManager.js` | `planTokens` in `getContextUsage` and `totalTokens`. |
| `src/main/compressionEngine.js` | `planTokens` projection plumbing at all three call sites. |
| `src/main/ipcHandlers.js` | `session:get-plan`; `session:plan-updated` push from both tool paths. |
| `src/preload.js` | `getPlan(sessionId)` / `onPlanUpdated(cb)` (returns unsubscribe). |
| `src/lib/executionEvents.mjs` | `plan` kind/verb/fields; `run_tests` in `COMMAND_TOOLS`. |
| `src/main/turnDigest.js` | Plan tool-call summary; `run_tests` classified as `command`. |
| `src/components/RightSidebar.jsx` | Mount the plan card in the Activity tab. |
| `src/components/ContextPanel.jsx` | `Plan (approx)` token row. |
| `tests/toolVerbs.test.mjs` | `update_plan → 'Plan'` verb invariant. |

Phase 1.1 files preserved (unchanged by this phase, verified by tests): the `run_tests`
schema/dispatch/classifier in `agentTools.js`, `FILE_OPS_TOOL_NAMES` in
`systemMessages.cjs`, and `COMMAND_TOOLS` in `taskCheckpoints.js`.

## 6. Tests added

`tests/workspacePlan.test.cjs` (14 tests):

1. Create persists a durable plan with stable, ordered ids (`get` returns it).
2. Incremental updates revise only requested fields and bump the revision.
3. 18 invalid-update cases each return the expected code and leave the plan unchanged;
   a valid update still works afterward.
4. Step ids are task-scoped: one task cannot update another task by id (reusing a local
   number cannot overwrite).
5. Blocked → resumed keeps the explanation and reports the current status.
6. Add/remove compacts positions without renumbering ids.
7. The plan is injected as a pure prompt suffix, counts in `getContextUsage`, and
   survives `checkAndCompressContext` byte-identical (compaction creates a checkpoint but
   never advances a step; messages are not edited).
8. The rendered section is bounded (≤ 4000 chars), omits completed lines first, keeps
   every unfinished step id, and preserves blocker notes.
9. Plan writes never touch canonical messages or permanent memory.
10. `update_plan` is a workspace-only `PLAN_WRITE` tool, visible only where executable,
    and runs through the real dispatcher; casual/read-only/malformed calls fail cleanly.
11. Casual sessions have no plan and are refused in every mode (incl. `full_access`).
12. Session delete cascades both tables; branching does not copy the plan.
13. Main-process IPC: `agent:execute-tool` creates a plan and pushes
    `session:plan-updated`; `session:get-plan` reads it (null for casual); a failed update
    pushes nothing.
14. Restart: a real mid-transaction failure (abort trigger) is reported as
    `PLAN_PERSISTENCE_FAILED` with no durable change; after close/reopen the plan is
    restored and re-injected with the same revision.

`tests/workspacePlan.ui.cjs` (Electron + esbuild, three render scenarios):

- **tabs**: two plan cards on one page; correct statuses, blocker note, in-progress
  marker, progressbar; a live `onPlanUpdated` for tab A updates A only — tab B's DOM and
  `React.Profiler` render count are unchanged; an unknown-session event renders nothing.
- **states**: `getPlan` failure → error + Retry → success; session switch → empty state;
  all-completed plan → "All steps completed." and full progress.
- **switch**: loading state, then a fast switch to a new session whose read resolves
  immediately; the slower previous-session response is ignored and never displayed.

## 7. Test execution

Environment note: `npm test` (`node --test tests/`) fails in this environment with
`MODULE_NOT_FOUND …/tests`. Suites were run explicitly:

```
node --test tests/*.test.cjs tests/*.test.mjs
```

| Run | Result |
| --- | --- |
| `node --test tests/workspacePlan.test.cjs` | 14 pass / 0 fail |
| `node --test tests/verification.test.cjs` (Phase 1.1) | 10 pass / 0 fail |
| full suite (166 files) | 1066 tests, 1026 pass, 40 fail |
| clean HEAD baseline (`/tmp/opencode/llm-head`), same command | 40 fail — **identical set** |
| `npm run build` | succeeded (vite, ~11 s) |
| `tests/workspacePlan.ui.cjs` | passed |
| `tests/workLogPanel.ui.cjs` | passed |
| `tests/renderIsolation.ui.cjs` | passed |
| `tests/contextPanel.ui.cjs` | pre-existing failure (same in baseline) |

The 40 full-suite failures are pre-existing and unrelated (subagent model routing,
context-budget token-count assertions, MCP cap, native tool guard, preload sandbox
`chatAPI`, and standalone-script files). `diff` of the sorted failure sets between the
current tree and clean HEAD is empty, so Phase 1.2 introduced **no new failures**.

## 8. Metrics

- **Plan correctness**: create/update/get with stable ids, incremental edits, position
  compaction, and 18 rejected invalid shapes — all verified.
- **Persistence / restoration**: turn-to-turn, across compaction, and across a real
  close/reopen of the SQLite file; a mid-transaction failure is reported as not saved and
  rolls back.
- **Tab association**: one plan per session; live events are filtered by `sessionId`;
  branch sessions get no plan; unrelated tabs do not re-render (Profiler-counted).
- **Post-compaction context**: the resumed prompt contains the current plan
  (revision-matched) and not the summary.
- **UI responsiveness**: read-only card, memoized, no polling; updates arrive by push.

## 9. Phase 1.1 preservation

Confirmed by inspection and tests:

- `run_tests` schema, `runScopedCommand`/`structureVerification` classifier, and its
  `status`/`success`/`failure_excerpt`/`recovery*` shape are intact in `agentTools.js`.
- `run_tests → 'command'` mapping present in `turnDigest.js` and
  `executionEvents.mjs`; `run_tests` present in `taskCheckpoints.js` `COMMAND_TOOLS` and
  `systemMessages.cjs` `FILE_OPS_TOOL_NAMES`.
- `tests/verification.test.cjs` passes 10/10.
- `run_tests` remains a `LOCAL_EXECUTION` capability (asserted in the new test).

No Phase 1.1 or pre-existing working-tree change was discarded or overwritten.

## 10. Limitations and explicit non-goals

- **Manual plan editing** is not supported this phase; the card is read-only with a
  manual Refresh only.
- **Branching does not copy the plan.** This matches checkpoints (durable progress state)
  rather than briefs; the branch starts plan-free and the agent can create one.
- **Project deletion** detaches sessions (project becomes NULL) rather than deleting
  them; the plan rows remain stored but are no longer read/injected, consistent with
  briefs/checkpoints. Graceful project-delete cleanup is out of scope.
- The plan section is hard-capped; in a pathological case (≈50 blocked steps with
  600-char notes) the tail may be truncated by the final hard bound, though normal
  trimming preserves blocker notes.
- The 40 pre-existing full-suite failures are out of scope and unchanged.
- The Electron UI test runs outside `npm test`, like the other `*.ui.cjs` suites.

## 11. How to run

```
# main-process plan tests
node --test tests/workspacePlan.test.cjs

# full suite
node --test tests/*.test.cjs tests/*.test.mjs

# plan UI test
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron \
  --no-sandbox tests/workspacePlan.ui.cjs

# production build
npm run build
```
