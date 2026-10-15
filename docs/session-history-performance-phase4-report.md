# Session History and Attachment Queries — Phase 4 Performance Report

**Scope:** cut session-history database work (attachment/sibling N+1, duplicate variants parsing) and duplicate listing IPCs across mounted tabs. Four app files touched (two new), one test file added. No architecture change, no new dependencies. Tree preserved (HEAD `6c961b1`, no commits/stashes/resets). Recovery, palace polling, subagent retention untouched. `/tmp/opencode/` untouched.

## 1. Confirmed root causes (all verified in current source)

- **`withAttachments` (`sessionManager.js`) ran per-message queries plus double parsing:** one `SELECT * FROM message_attachments WHERE message_id = ?` per message against a table with **no index** (full scan each), one siblings `SELECT` per message, and `parseVariants()` called **twice** per message (lines 377/379) plus three object spreads.
- **`loadSession` siblings N+1:** one `SELECT id … WHERE session_id/role/parent_id` per message on top of the chain walk.
- **N duplicate listings at startup:** every mounted `ChatInterface` (one per tab, all mounted hidden) calls `session:get-all` on mount, plus `TabContext` hydration — N+1 identical full listings (sessions + exact `SUM(estimated_tokens)` aggregation, which ChatHistory displays per chat and must stay exact).
- `getAllSessions` itself is 2 queries (folders + sessions with one GROUP BY); the duplication, not the query, was the problem. `getFullChatHistory` already batched attachments — the in-tree precedent followed.

## 2. Files changed and why

- **`src/main/db.js` (+4):** `idx_message_attachments_message ON message_attachments(message_id, id)` (`CREATE INDEX IF NOT EXISTS` — safe on existing DBs). Eliminates full-table scans backing both old and new attachment reads.
- **`src/main/sessionManager.js`:** `attachmentsByMessage()` — one chunked `IN` query (500-id chunks for variable limits), global `ORDER BY id` preserving per-message order, `[]` for empty; `withAttachments` calls `parseVariants` **once** and derives `content` from it (proven identical across legacy/variants/execution-steps shapes — the second call re-parsed the same data); `executionSteps` still reads the live column (mid-stream freshness preserved); `siblingIdGroups()` — one narrow `SELECT id, role, parent_id` grouped in JS with identical keying/ordering. Chain-walk `SELECT * by id` intentionally kept (depth-bounded, PK-indexed; a full-table alternative would punish giant sessions).
- **`src/lib/sessionGroups.mjs` (new) + 2 call sites (`ChatInterface.refreshHistory`, `TabContext` hydration):** shares only the **in-flight** listing promise — concurrent mounts collapse N→1 IPC; the slot clears on settle so sequential refreshes always hit the DB fresh (zero staleness risk, no invalidation protocol, failures retry). All 10 existing mutation-site refreshes kept (each is one legitimate post-write reload).
- Token aggregation kept exact (displayed per chat; estimates forbidden).

## 3. Before/after (deterministic fixtures, same generation both runs)

200-message session (50 attachments): **602 → 204 queries, 40 → 16ms** (attachments 200→1, siblings 200→1; remaining 200 are the kept chain-walk PK gets). 50-message: 152→54, 8→5ms. `getActiveMessages` (200): 401→202, 24→16ms. Listing: N concurrent mounts → 1 IPC (unit-proven); sequential behavior byte-identical.

## 4. Tests and results

- New `node --test tests/sessionHistoryPerf.test.cjs` → **9/9**: dedup sharing/freshness/failure-retry/missing-API; batched association/order/shape matrix (legacy, steps, variants+active-index, thinking/tool-calls) with a per-message-read oracle; empty transcript; 200-message bound with query-count pins (attachments = 1, siblings = 1, total < 250 vs 602 baseline); exact aggregates/ordering/folders.
- Existing: sessionHistory, messageBranches, recentChatHistory, replyVariants, contextTelemetry, agentTools, recoveryStore (20/20), recoveryBoundary (20/20) pass.
- Pre-existing failures, unchanged (A/B-proven on pristine HEAD where applicable): `messageStats` (legacy `siblings` expectation), `tokenUsage` (electron-mock `getPath` gap).
- `npx vite build` ✓ 8.13s. `git diff --check` clean.

## 5. Remaining work (deferred)

Transcript virtualization + Markdown/Prism caching (parsing now dominates loads — evidence above supports its priority), chain-walk batching for very deep sessions, per-turn full transcript reload after sends (kept deliberately this phase), right-sidebar `runtime` prop memo. `getFullChatHistory` untouched (export path, already batched).
