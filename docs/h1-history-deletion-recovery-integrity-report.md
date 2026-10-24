# H1 — Conversation deletion, durable history and recovery integrity

Date: 2026-10-24, Asia/Dhaka. Machine-readable evidence: [H1 evidence](h1-history-deletion-recovery-integrity-evidence.json).

## 1. Executive summary

**Delete Chat already permanently deleted the conversation and its messages.** The existing immediate SQLite transaction and deletion triggers also removed task briefs, context checkpoints, summaries, plans, steering and attachment references. Those semantics were preserved. Disposable pre-fix tests reproduced missing background-history cleanup and recreation of a deleted identifier after reopening storage.

H1 adds cancellation-before-deletion, authorization revocation, child/background cleanup, chat-linked file-recovery checkpoint cleanup, prepared-context invalidation, mounted-tab invalidation and durable rejection of deleted IDs. No Archive, Trash, storage redesign or W2 implementation was added. Application-level deletion is verified by deterministic fixtures; this is not forensic erasure or certification of every external process/provider.

## 2. Existing Delete Chat implementation

`ChatHistory.jsx` displays the existing confirmation (“and all its messages?”), then `ChatInterface.jsx` calls `palace.api.deleteSession(id)`. `src/preload.js` invokes `session:delete`; the trusted-sender wrapper in `ipcHandlers.js` dispatches to the main process. Originally it only forgot LSP context and called `sessionManager.deleteSession`. That function checks the session/compression lock and executes `DELETE FROM sessions` inside an immediate transaction.

The existing UI disables the sidebar while its current pane is loading/streaming. That does not protect another running tab or a direct IPC request. The original main handler did not cancel the target run. Workspace and Casual Chat share this path; Workspace additionally owns briefs/checkpoints/plans.

## 3. SQLite deletion semantics

`db.initDatabase` opens `memory_palace.db`, enables WAL, `synchronous=FULL`, `foreign_keys=ON` and a 5-second busy timeout. Tests query the actual foreign-key pragma and `foreign_key_check`. Many foreign keys deliberately lack SQL cascades: the rebuilt `sessions_cascade` trigger provides cleanup for legacy and current databases; `attachments_cascade` and `messages_digest_cascade` clean message children. All execute in the same transaction, rather than best-effort asynchronous deletes.

H1 extends the existing trigger for background commands, child history and usage, and inserts a content-free `deleted_sessions(id)` marker. A before-insert trigger rejects reuse of the ID even after restart. This small ledger is necessary because the existing get-or-create IPC otherwise cannot distinguish a genuinely new ID from an old deleted ID. It contains no title, message or task content and is not a user-facing archive. Foreign keys reject late message/brief/context-checkpoint writes; triggers also reject late writes to previously unconstrained background/child/usage/file-recovery tables.

Chat-linked file-recovery checkpoint deletion and refcount/index adjustments run inside the same primary deletion transaction. An injected database abort proves rollback restores the session, messages and checkpoint rows. Recovery in progress blocks deletion rather than removing its manifest underneath a restore.

SQL deletion does **not** guarantee erasure from WAL pages, backups, snapshots, filesystem free space or OS caches. No global VACUUM, secure-delete promise or backup deletion is included.

## 4. Conversation-data ownership matrix

| Actual data | Storage/source | Ownership | Delete Chat behavior |
| --- | --- | --- | --- |
| Conversation, title, model/profile/sampling/memory settings, active leaf | `sessions`; `sessionManager.js`, `profileSettings.js` | Conversation | Row removed |
| Messages, variants, thinking, tool calls/results, execution steps, run IDs | `messages`; `sessionManager.js`, `engineManager.js` | Conversation | Trigger removes all branches, archived and active rows |
| Attachment references | `message_attachments` | Message | Trigger removes references |
| Uploaded attachment bytes | App-data `attachments/`; `fileUploads.js` | Managed pool; paths can be shared by branches/conversations | Bytes retained; no exclusive conversation ownership metadata exists |
| Document extraction/embedding cache | `document_chunks`, keyed by file path/model/chunk | Shared attachment/document cache | Retained with managed pool; not session recovery |
| Original instructions and revisions | `workspace_task_briefs`; `taskBriefs.js` | Workspace conversation | Removed |
| Rolling summaries | `session_summaries` | Conversation | Removed |
| Versioned context checkpoints | `workspace_checkpoints`; `taskCheckpoints.js` | Workspace conversation | Removed, including superseded versions |
| Turn digests/work-log evidence | `workspace_turn_digests`; execution steps | Conversation | Removed |
| Task plan/steps | `workspace_plans`, `workspace_plan_steps` | Conversation | Removed |
| Steering inbox/history | `run_steering_messages` | Conversation/run | Removed after run teardown |
| Context rewind summaries | `context_rewinds` | Conversation/message | SQL cascade removes rows |
| Child transcripts/context/continuation/budget history | `subagent_runs`; `subagents/persistence.js` | Parent conversation/child | Removed; late insert/update denied |
| Background command audit/output | `background_commands`; `backgroundCommands.js` | Conversation/run/workspace | Command stopped/awaited, registry forgotten, SQL rows removed |
| Token/cost usage | `token_usage.chat_id` | Conversation attribution | Removed; late insert denied |
| File before-image checkpoint manifests | `recovery_checkpoints.chat_session_id`; `recoveryStore.js` | Chat-linked capture inside shared workspace journal | Matching manifests/index entries removed with refcount adjustment |
| Workspace journal, index and content-addressed blobs | `recovery_sessions`, `recovery_workspace_index`, `recovery_blobs`, app-data `recovery/blobs/` | Shared workspace/content pool | Retained; existing GC reclaims unreferenced blobs |
| Active controllers, approvals, tool manifests, child attempts, steering runs | `ipcHandlers.js`, `engineManager.js`, subagent stores | Run | Revoked/cancelled/settled before commit; child records evicted |
| Prepared-context estimates | `promptMeasurement.js` process cache | Conversation/model | Invalidated; late cache fill checks deletion guard |
| Idle compression timer/controller/attempt cache | `compressionEngine.js` | Conversation | Timer cancelled, signal aborted, in-flight compression awaited, bookkeeping cleared |
| MCP/native selections | `mcpManager.js`, `nativeToolActivation.js` process maps | Conversation/run | Forgotten; global configured services retained |
| Open tabs/transcript/sidebar | `TabContext.jsx`, `ChatInterface.jsx`, localStorage tab metadata | Renderer conversation references | Deletion event drops matching tab/sidebar rows; restart orphan validation remains |
| Explicit permanent memories | `permanent_memories`, `memory_fts`; `memoryManager.js` | Global/model/project, independently saved | Retained |
| Projects/files/rules/skills/configuration | `projects`, `project_files`, `project_rules`, user workspace and global configuration | Shared or user-owned | Retained; no workspace undo |
| Deletion markers | `deleted_sessions` | Integrity metadata | Retained to reject stale recreation |

No separate conversation-owned temporary-file store or general task-run database was discovered. Child `raw_turns_json` and message execution steps are the actual tool-history stores, not hypothetical new tables.

## 5. Task-brief ownership

Workspace user-message saves capture original instructions and revisions in the message transaction. Brief applicability follows the active branch. Whole-chat deletion removes every revision. Ordinary compaction retains briefs. Casual Chat does not create them. Stale brief inserts fail their session foreign key; original brief text cannot recreate a deleted session through get-or-create.

## 6. Checkpoint ownership

Context checkpoints are versioned, conversation-owned records and are removed by the existing session trigger. File-recovery checkpoints are a separate workspace feature: their nullable `chat_session_id` had no cleanup or foreign key. H1 removes only rows explicitly linked to this chat, maintaining the existing reference index. Shared/null-origin captures and other chats' captures remain. Recovery snapshots never carry executable approval grants.

## 7. Tool-history ownership

Main-agent execution evidence is embedded in message rows/variants. Child history is in `subagent_runs`, including recovery/compaction/continuation JSON. Background output is in `background_commands`. The latter two previously lacked deletion cleanup. H1 removes them and prevents late persistence from inserting them again. No separate history architecture was introduced.

## 8. Attachment behavior

Uploads create UUID-named managed copies under app-data `attachments/`; message saves validate managed paths. Branching may share those paths. Delete Chat already removed attachment references but did not unlink bytes. H1 preserves that policy: it does not infer exclusive ownership from a filename, follow symlinks or remove source/project files. The managed pool and document chunks can retain unreferenced bytes/text. This is an explicit retention limitation, not secure deletion of attachment contents; a future ownership-aware pool GC would be separate work.

## 9. Saved-memory behavior

Permanent memories use global/model/project scopes and an independent save/delete API. They have no conversation-owner column. Explicitly saved memories remain retrievable under their existing policy, even when a similar fact once appeared in a deleted chat. They cannot create session/message rows. No automatic conversation-scoped memory store was found. Conversation summaries/checkpoints are not classified as independent memories and are deleted.

## 10. Active-run cancellation

`sessionDeletion.deleteConversation` validates ID and active sender ownership, installs a pending deletion guard, forgets live authorization revision, aborts the existing controller, cancels compression/children, awaits the actual engine request's cleanup promise, then deletes. New model requests and get-or-create fail while pending. Existing approval and manifest epoch checks reject revoked operations; tool entry points also reject pending/deleted conversations when persistence is initialized. Existing model-loop signals and execution controls are preserved.

The row stays present while cancellation settles. An uncooperative external operation can delay deletion rather than yielding a false success. Child teardown has a 10-second fail-closed deadline; failure leaves durable chat data present. A running operation's already completed external effects cannot be undone.

## 11. Background command cleanup

The existing registry's `closeRun` aborts owned commands and awaits their operation promises. Deletion uses it before forgetting registry records and deleting SQL history. No new launcher/runner was added. Existing U7 foreground/background process-group TERM/KILL policy and authorization monitoring remain intact. The fixture verifies terminal settlement before row removal; command regression suites exercise the actual launcher separately. Deliberately daemonized escaped descendants remain the pre-existing U7 limitation.

## 12. Late-write protection

Deleted IDs are blocked at SQL session insertion and at normal get-or-create/model/tool entry points. Foreign keys protect primary child records. Additional guards cover background, child history, usage and chat-linked recovery inserts. Existing assistant persistence updates cannot recreate a row; missing rows produce an explicit error. An in-flight measurement checks availability before caching. Deletion is serialized per ID without introducing a new task runner.

Markers apply to deletions performed after this migration. H1 does not attempt to infer or retroactively clean historical orphan records from live user data. The database is not an adversarial authorization boundary against arbitrary trusted-main SQL that deliberately removes integrity markers.

## 13. Recovery after deletion

Disposable service close/reopen tests verify absence of messages and rolling state and rejection of stale get-or-create. Checkpoint/brief retrieval has no retained conversation rows to return. Child live records/executions are evicted and durable child recovery rows removed. Old file-recovery checkpoint inserts for the deleted chat are rejected. Other conversations sharing the workspace remain intact. Existing recovery APIs additionally derive the workspace from the current session/project; stale deleted sessions cannot authorize a restore.

## 14. Compaction versus deletion

The existing supported compression API is exercised with a synthetic summarizer: durable message count stays constant, active history shrinks, the rebuilt prompt uses the summary, and subsequent Delete Chat removes both originals and rolling state across service restart. Existing Workspace checkpoint/brief/compression lifecycle suites cover the Workspace equivalent. No permanent deletion API was added to compaction. Internal `archived` flags describe active-context exclusion, not a user archive feature. W1's summary quality, budget-fit, parent live-tail and provider-parity problems are not repaired in H1.

## 15. Renderer/IPC behavior

The confirmation and delete action remain. The main handler now receives the trusted sender explicitly (tested through the registered wrapper). An unrelated sender cannot cancel/delete another sender's active request. Idle chats remain application-owned global history: there is no per-user/per-renderer ACL for every row, and guessing an idle ID is not an account-level isolation guarantee. Malformed IDs and untrusted senders are rejected by existing/main checks.

A `session:deleted` notification removes the matching mounted tab and sidebar entry; other tabs remain. Existing active-chat replacement code and restart orphan validation remain. Notification failure after commit is logged rather than falsely reporting a failed database deletion. No mounted Electron visual interaction test was run; UI compatibility is supported by source inspection, tab-state/restore tests and the production build.

## 16. Files changed

H1 production paths: `src/main/sessionDeletion.js` (new); `db.js`, `sessionManager.js`, `ipcHandlers.js`, `recoveryStore.js`, `backgroundCommands.js`, `compressionEngine.js`, `promptMeasurement.js`, `mcpManager.js`, `nativeToolActivation.js`, `toolPermissions.js`, `tools/agentTools.js`, `subagents/continuationManager.js` under `src/main/`; `src/preload.js`; `src/context/TabContext.jsx`; `src/components/main-app/ChatInterface.jsx`. Tests: `tests/h1HistoryDeletion.test.cjs`, `tests/h1DeletionIpc.test.cjs`. This report and evidence are new.

Initial dirty status/diff were recorded; existing uncommitted work was preserved. No commit/push/stash/reset/clean/restoration occurred. The configured real data directory was identified from configuration only: `/home/mk_saadi/.config/Continuum` (database `memory_palace.db`, attachments and recovery beneath it). No production database was opened or mutated. Tests mock Electron paths into disposable `mkdtemp` roots; full runs redirect HOME/XDG paths under `/tmp/continuum-h1`.

## 17. Focused tests

Focused regression: **254 passed, 0 failed, 1 skipped** across 255 assertions/entries. H1-specific files: **17 history/lifecycle tests + 2 registered IPC tests passed**. Final affected restricted run: all five file entries passed. Exact identities and fixture descriptions are recorded in JSON.

The H1 file exercises primary deletion, restart, rollback, neighbors, recovery manifests, late writes, independent retention, cancellation ordering, foreign ownership, background settlement, child eviction and actual normal compaction. Six named active-phase cases deliberately use the same synthetic controller/settlement contract; they do not claim six separate live provider/tool integrations. The registered IPC fixtures exercise a real engine request waiting on initialization and a real tool approval pending during deletion. The latter verifies the approval cannot later execute its command. Synthetic transports incur no paid/model/account operations.

## 18. Regression comparison

| Run | Tests/entries | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Fresh restricted baseline | 228 | 197 | 31 | 0 |
| Fresh enabled baseline (includes 4 reproduction cases) | 1758 | 1736 | 21 | 1 |
| Final restricted | 230 | 199 | 31 | 0 |
| Final enabled | 1773 | 1755 | 17 | 1 |

Exact comparisons: **0 new restricted failures; 0 new enabled failures**. The enabled pre-existing failure set has 17 identities; the final set has 17. The final failure identity set exactly matches the fresh pre-existing baseline set. The subagent model-selection file independently passed all 14 tests; its five full-suite failures remain classified as run-dependent, not as an H1 fix.

Exact failing identities and diagnostics, rather than just totals, are in the evidence. The enabled baseline included the four newly added pre-fix reproduction cases before production edits; its first two had a fixture pragma API mistake, corrected and rerun directly (two existing behaviors passed, two actual defects failed). Those four cases are explicitly excluded from the pre-existing failure set. Intermediate H1 compatibility regressions were corrected, not classified as pre-existing.

Remaining stable failures include attachment capability fixture setup; cloud/engine/MCP/skill Electron mocks; uninitialized MCP settings fixture; message subtree/statistics assertions; a RAG fixture contacting an unavailable local model; and an obsolete subagent stream-mode assertion. Their fresh baseline failures remain evidence, not automatically harmless. The subagent-model-selection event/time-out failures vary between full runs; the exact observed identities are recorded separately. H1 does not modify these unrelated contracts to make totals green.

## 19. Production build

`npm run build` passed (Vite production bundle). The existing chunk-size warning remains. `git diff --check` passed. No packaging, installation or deployment was performed.

## 20. Remaining limitations

- Managed attachment bytes/document chunks and shared recovery blobs follow existing pool retention. There is no forensic erasure guarantee.
- No real user conversation, live database, paid model or real external MCP mutation was used. Provider-specific non-cooperative cancellation and mounted Electron visuals are not certified.
- Cancellation preserves existing U7 host-process/configuration trust limitations, including escaped detached processes; already completed workspace effects remain.
- Uncooperative main operations may keep deletion pending. Child timeout or active file restore reports failure and retains the conversation.
- No historical orphan sweep or backup cleanup was attempted. Content-free deletion identifiers remain indefinitely to enforce restart integrity.
- The full regression suite retains demonstrably pre-existing failures; total project acceptance is not claimed from a focused green suite.

## 21. Readiness for W2

**W2 should not begin as an accepted implementation phase yet.** H1 narrows and verifies the application deletion/recovery boundary, but does not resolve the pre-existing W1 compaction design/quality gates, U7 execution limitations or unrelated behavioral regression failures. Attachment pool retention and non-cooperative cancellation are explicitly documented rather than represented as stronger privacy/cancellation guarantees. Review those limits against the intended product contract before certifying all H1 acceptance criteria. Stop here: no W2 was implemented.
