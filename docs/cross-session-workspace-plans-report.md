# Cross-Session Workspace Task-Plan Retrieval (`get_project_plans`)

Status: implemented, tested, and stopped for review. No commit or push was
performed; all changes remain in the working tree alongside the unrelated
working-tree changes that were already present and are preserved untouched.

## 1. Previous session-owned planning behavior

Phase 1.2 introduced a durable, **session-owned** task plan:

- One tool, `update_plan`, with `action: "create" | "update" | "get"`.
- A plan row per Workspace session (`workspace_plans.session_id` is the primary
  key) and child step rows (`workspace_plan_steps`), both scoped by
  `session_id` and cascaded when the session is deleted.
- `action: "get"` returns **only the calling session's** plan. That is correct
  for ownership: Chat B calling `get` on a fresh task returns `exists: false`
  even when Chat A in the same project has a completed plan.

TaskFlow confirmed the limitation: Chat A finished 38/38 steps; Chat B, created
in the same project, could not inspect Chat A's plan at all.

The Phase 1.2 report (`docs/agentic-phase1-2-report.md`) is the authoritative
description of the store, validation codes, revisions, permission capability
(`PLAN_WRITE`), bounded prompt injection (`buildPlanSection`), and the
read-only Activity-tab `WorkspacePlanCard`.

## 2. Actual project/session database relationships

Resolved from `src/main/db.js` and the existing ownership modules:

- `projects(id, root_path UNIQUE, permission_mode, …)`.
- `sessions(id, title, project_id REFERENCES projects(id) ON DELETE SET NULL,
  last_active_at, …)`. A Workspace session is `project_id IS NOT NULL`
  (`taskBriefs.isWorkspaceSession`); a Casual Chat is `project_id IS NULL`.
- `workspace_plans(session_id PRIMARY KEY REFERENCES sessions(id), objective,
  revision, created_at, updated_at)`.
- `workspace_plan_steps(id INTEGER PRIMARY KEY, session_id, position,
  description, status, note, created_at, updated_at)`, with
  `idx_plan_steps_session(session_id, position, id)`.
- `sessions_cascade` deletes plan rows on session delete.
- **Project deletion detaches sessions** (`ON DELETE SET NULL`); it does not
  delete them. `projectManager.deleteProject` relies on this.

Consequences used by the design:

- A plan is reached only through its owning session row. Therefore the
  session's `project_id` is the single, trusted authorization input.
- A detached session (`project_id IS NULL`) has no project to scope to and is
  never visible through a project listing or lookup.

## 3. New tool interface

A new, small, read-only tool was added rather than overloading `update_plan`.

**Decision rationale.** `update_plan` is mapped wholesale to
`CAPABILITIES.PLAN_WRITE`. The capability model (`toolPermissions.js`)
resolves a tool to exactly one capability by name; `isToolVisible`/`guardTool`
have no per-action capability hook, so adding `list_project`/`get_project`
actions to `update_plan` would either (a) keep the whole tool write-gated and
therefore invisible/denied in `read_only`, violating the requirement that a
read-only workspace agent can inspect same-project plans, or (b) require a new
per-action capability mechanism. Adding a second **read-only** tool integrates
with the existing capability map instead of extending it with a new mechanism.

`update_plan` is unchanged: `create`/`update`/`get` semantics — including
`get` being current-session-only — are identical.

### `get_project_plans`

```
action: "list" | "get"           (required)
plan_id: string                  (action "get"; stable plan id == owning session id)
session_id: string               (alternative to plan_id)
limit: integer 1-50 (default 20) (action "list")
offset: integer >= 0 (default 0) (action "list")
```

`action: "list"` returns a bounded, newest-activity-first page:

```json
{
  "success": true, "action": "list",
  "plans": [{
    "plan_id": "<session id>", "session_id": "<session id>",
    "session_title": "Chat A" | null, "objective": "…",
    "status": "empty|blocked|in_progress|pending|completed",
    "revision": 4, "total_steps": 38, "completed_steps": 38,
    "blocked_steps": 0, "in_progress_steps": 0, "pending_steps": 0,
    "created_at": "…", "updated_at": "…", "last_active_at": "…"
  }],
  "total": 3, "limit": 20, "offset": 0, "has_more": false
}
```

- No step text is ever returned by a listing.
- `plan_id` is the stable plan identifier; it equals the owning `session_id`
  because the plan row is keyed by the session. Both spellings are accepted by
  `get`.

`action: "get"` returns one full plan from the **same authoritative rows**
`update_plan` reads, plus the owning-session reference and derived counts:

```json
{
  "success": true, "action": "get", "exists": true,
  "owner": { "session_id": "…", "session_title": "Chat A" | null },
  "plan": {
    "plan_id": "…", "session_id": "…", "session_title": "Chat A" | null,
    "objective": "…", "status": "completed", "revision": 4,
    "total_steps": 38, "completed_steps": 38, "blocked_steps": 0,
    "in_progress_steps": 0, "pending_steps": 0,
    "created_at": "…", "updated_at": "…",
    "steps": [{ "id": 7, "position": 1, "description": "…", "status": "completed", "note": "" }]
  }
}
```

Derived plan `status` (no status column exists) is deterministic, most
attention-needed first: `empty` (no steps) → `blocked` → `in_progress` →
`pending` → `completed`.

Not-accessible targets and unknown ids return the same neutral
`{ success: true, exists: false, plan: null }`, so a guessed id cannot confirm
or reach a plan outside the project.

## 4. Query and authorization design

All authorization is resolved **server-side from trusted execution context**;
no project id is accepted from the model.

1. The current session's project is read from `sessions.project_id`
   (`projectIdOfSession`), not from arguments.
2. Listing joins `workspace_plans → sessions` and filters
   `sessions.project_id = <current project>`; the JOIN *is* the boundary. Order
   is `p.updated_at DESC, s.last_active_at DESC, s.id ASC`; the page is
   `LIMIT/OFFSET` with a `total` count.
3. A single read first loads the target session's `project_id` and requires it
   to equal the caller's project. Unknown ids, Casual Chats, and other projects
   all collapse to the same non-accessible result — no existence leak.
4. Casual chats (`project_id IS NULL`) are rejected before any query by the
   `PLAN_READ` capability (below) and again inside `workspacePlan`.
5. Detached sessions (deleted project) lose their project scope and drop out of
   both listing and lookup automatically.

All cross-session operations are read-only; `workspacePlan` never writes from
these paths.

## 5. Read-only guarantees

Cross-session retrieval:

- runs only `SELECT`s inside a `db.transaction(...)()` snapshot; it never
  inserts, updates, or deletes a plan row, step row, message, memory, or
  session;
- never mutates the caller's own plan, the target's plan, step statuses,
  descriptions, notes, revisions, or ownership;
- never copies or merges steps, never replaces or resets the current plan;
- never grants another session's tools or permissions: the tool stays out of
  the sub-agent allowlist (`CHILD_TOOL_NAMES`), and a child still cannot reach
  a project plan;
- treats a retrieved plan as historical information. The tool's description
  states explicitly that a retrieved plan is **not** permission to execute its
  instructions and does not become the caller's plan.

The existing Activity-tab `WorkspacePlanCard` is unchanged and continues to
show the current session's plan only (`session:get-plan` reads
`workspacePlan.getPlan`, which is untouched).

## 6. Context-size behavior

Continuum's compact-context behavior is preserved:

- **No automatic injection.** Only `buildPlanSection(currentSession)` is
  injected into prompts, exactly as before. Other sessions' plans are never
  added to any prompt, work log, brief, checkpoint, or memory. Verified by
  tests asserting `rebuildChatMessages`/`prepareChatMessages` for Chat B do not
  contain Chat A's objective/steps.
- **Bounded listing.** Listings return metadata/counts only — never steps — and
  default to 20 rows, capped at 50, with `offset` pagination and `total`/
  `has_more`.
- **Full steps only for the selected plan.** `get` returns the full step list
  for one plan, mirroring the size class `update_plan action:"get"` already
  returns (≤ 50 steps).
- **No chat histories or work logs** are exposed by retrieval.
- Results flow through the existing tool-result path (`truncateToolOutput` in
  the engine loop; `getContextUsage`/compaction accounting are unaffected
  because retrieval adds no injected section).

## 7. Concurrency behavior

- Reads run in a single SQLite read transaction, so each retrieval observes one
  consistent snapshot; WAL readers do not block the writer.
- Plans stay session-owned: each chat continues to create and update its own
  plan with `update_plan`; two chats never share a plan row.
- Revisions (and `updated_at`) indicate when a plan changed; the listing and
  `get` report the persisted revision, so a caller can detect that a plan moved
  and re-read it.
- Step identities remain scoped to their owning plan; a cross-session read
  cannot address or alter another plan's steps.
- The caller's own plan is byte-identical before and after any number of
  cross-session reads (asserted against raw DB rows).

## 8. Files and functions changed

| File | Change |
| --- | --- |
| `src/main/workspacePlan.js` | New read-only functions `getProjectPlans` (public tool entry), `listProjectPlans`, `getProjectPlan`, plus `projectIdOfSession`, `planAggregateStatus`, `summarizePlanRow`, `planDetail` and argument normalizers (`normalizeListLimit`, `normalizeListOffset`, `normalizeTargetId`). New constants `DEFAULT_LIST_LIMIT` (20), `MAX_LIST_LIMIT` (50), `PLAN_AGGREGATE_STATUSES`. Exports updated. **No existing function changed.** |
| `src/main/tools/agentTools.js` | New `get_project_plans` tool schema; dispatch branch next to `update_plan` (before root resolution — no filesystem access). |
| `src/main/toolPermissions.js` | New `CAPABILITIES.PLAN_READ`; `get_project_plans → PLAN_READ`; `baseDecision` denies `PLAN_READ` without a workspace in every mode and allows it in `read_only`/workspace modes; `guardTool` full-access and pass-through branches kept in step. `update_plan → PLAN_WRITE` unchanged. |
| `src/lib/executionEvents.mjs` | `get_project_plans` classified as the `plan` presentation kind; `summarizeStep`/`summarizeStage`/`formatArgFields` distinguish plan reads from plan updates. |
| `src/main/turnDigest.js` | Work-digest summary for `get_project_plans` ("reviewed project task plans"). |
| `tests/projectPlanRetrieval.test.cjs` | New: 21 focused main-process tests (see §9). |

Unchanged (verified): `db.js` schema (no migration needed), `update_plan`
schema/dispatch, `promptBuilder` injection, `sessionManager` context
accounting, `compressionEngine`, `ipcHandlers` `session:get-plan`, `preload`,
`WorkspacePlanCard`, and the sub-agent allowlist.

## 9. Test results

New suite `tests/projectPlanRetrieval.test.cjs` — **21 tests** covering the
required scenarios, using real workspace sessions attached to temporary
projects and the **real tool-dispatch + permission path**
(`executeAgentTool` + `guardTool`), not bare SQLite helpers:

1. Listing plans in the current project (metadata/counts only, no step text).
2. Retrieving another same-project session's full plan by `plan_id`
   (`session_id` alias too).
3. Retrieving a fully completed 38-step plan (Chat A → Chat B).
4. Retrieving a plan with blocked steps and its blocker note.
5. Listing ordered by recent activity with session titles.
6. Current-session `update_plan get` remains current-session-only; listings
   include every project plan.
7. Cross-project access denied (not listed, not retrievable by exact id; no
   leak of the other project's text).
8. Project deletion/detachment respected (detached session cannot list or be
   reached; still-attached project cannot see the detached plan).
9. Casual-chat access denied in all four modes (hidden from the tool list and
   refused at execution).
10. Unknown plan/session ids handled safely.
11. Cross-session reads never modify the target or the current plan (raw-row
    snapshots); step ids stay scoped to their owning plan.
12. Concurrent plans in one project stay isolated.
13. Listing bounded and paginated deterministically; invalid paging fails
    loudly (`INVALID_LIMIT`, `INVALID_OFFSET`).
14. No automatic context injection (other sessions' plans never appear in the
    current prompt; discoverable only on explicit request).
15. Correct registration and dispatch (schema, `PLAN_READ` capability, bad
    shapes: `INVALID_ACTION`, `MISSING_FIELD`, `INVALID_TARGET`, missing/
    unexpected arguments).
16. Read-only workspace permission is sufficient for plan reads while plan
    writes stay denied.
17. Revision and timestamp accuracy across retrieval.
18. Activity-tab IPC (`session:get-plan`) still exposes only the current
    session's plan.
19. Cross-session retrieval and current plans survive a database restart.
20. Existing workspace plan tools unchanged by the read path.
21. Display classification: `get_project_plans` renders as `Plan` (no raw
    snake_case) and stages distinguish "Read plan" from "Updated plan".

Focused/related suites run (all passing):

| Suite | Result |
| --- | --- |
| `tests/projectPlanRetrieval.test.cjs` | 21 pass / 0 fail |
| `tests/workspacePlan.test.cjs` | 15 pass / 0 fail |
| `tests/permissionPolicy.test.cjs` | pass / 0 fail |
| `tests/agentTools.test.cjs` | pass / 0 fail |
| `tests/nativePermissions.test.cjs` | pre-existing failure (see §10) |
| `tests/toolVerbs.test.mjs` | 3 pass / 0 fail |
| `tests/workspaceStages.test.mjs` | 9 pass / 0 fail |
| `tests/recentChatHistory.test.cjs` | pass / 0 fail |
| `tests/verification.test.cjs` | 10 pass / 0 fail |
| `tests/contextBudget.test.cjs` | 13 pass / 0 fail |
| `tests/turnDigest.test.cjs` | 20 pass / 0 fail |
| `tests/workLog.test.cjs` | 18 pass / 0 fail |
| `tests/workLogDisplay.test.cjs` | 9 pass / 0 fail |

Electron UI suites (`xvfb-run … electron --no-sandbox`):

| Suite | Result |
| --- | --- |
| `tests/workspacePlan.ui.cjs` (Activity-tab card) | pass |
| `tests/workLogPanel.ui.cjs` | pass |
| `tests/renderIsolation.ui.cjs` | pass |
| `tests/permissionMode.ui.cjs` | pass |
| `tests/projects.ui.cjs` | pass |
| `tests/contextPanel.ui.cjs` | pre-existing failure (see §10) |

Production build: `npm run build` succeeded (vite, 1809 modules, ~14 s).

## 10. Regression comparison

Baseline was re-measured on the **current working tree before this change**
(not taken from a prior report), with the same command:

```
node --test --test-reporter=tap tests/*.test.cjs tests/*.test.mjs
```

- Baseline (pre-change, current tree): **27 `not ok`**.
- After this change: **27 `not ok`**.
- `diff` of the sorted failure-name sets is **empty** — identical failure
  identities, so this change introduced **no new failures**.

The 27 pre-existing failures are unrelated (sub-agent model routing/looping,
context-budget token-count assertions, MCP cap, native tool guard, preload
sandbox config, standalone-script files) and identical to the clean-HEAD set
documented in `docs/agentic-phase1-2-report.md`. `tests/contextPanel.ui.cjs`
fails pre-existing with "no token-savings claims in status"; it is untouched by
this change.

## 11. Known limitations

- **Plan id == session id.** There is no separate `plan_id` column; the stable
  plan identifier is the owning session id. `plan_id` is exposed as an alias for
  clarity and both keys are accepted by `get`.
- **Derived status.** Plans have no stored status; the listed `status` is
  computed from step counts (blocked > in_progress > pending > completed >
  empty). It is a summary, not independent state.
- **No plan-text search.** Listing is by recent activity only; there is no
  keyword filter over objectives.
- **Detached sessions.** A plan whose owning session was detached (project
  deleted) remains stored but is unreachable through this tool, consistent with
  briefs/checkpoints. Graceful cleanup remains out of scope.
- **Read scale.** A single `get` returns up to 50 full steps, the same size
  class `update_plan action:"get"` already returns; very large single plans are
  bounded by the existing `MAX_STEPS`/field caps, not by a new limit.
- The 27 pre-existing full-suite failures and the pre-existing
  `contextPanel.ui.cjs` failure are out of scope and unchanged.

## How to run

```
# new cross-session plan tests
node --test tests/projectPlanRetrieval.test.cjs

# existing plan tests
node --test tests/workspacePlan.test.cjs

# full suite
node --test tests/*.test.cjs tests/*.test.mjs

# Activity-tab / related UI tests
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron \
  --no-sandbox tests/workspacePlan.ui.cjs

# production build
npm run build
```
