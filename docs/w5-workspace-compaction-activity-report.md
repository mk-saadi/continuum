# W5 — Workspace compaction activity and live progress

Date: 2026-10-25, Asia/Dhaka. **Implementation delivered; full W5 acceptance is not certified.** Evidence: [machine-readable results](w5-workspace-compaction-activity-evidence.json).

## 1. Executive summary

Workspace owning-loop compaction now produces durable, conversation-owned activity. Its current phase appears inline between the tools preceding and following the attempt. Completion includes W3's verified complete-request counts and their measurement method; continuation remains an observation of the original run's dispatch. Deferred, failed and cancelled attempts remain distinct. Casual receives neither activity records nor cards, and its compression path remains intact.

Focused verification passes: W2 44/44, W3 30/30, W4 20/20 and new W5 26/26. The actual W4 long-history parent loop verifies eleven separate completed attempts, same-run continuation, matching full-request measurements and zero duplicate tool executions. The mounted Electron fixture passes activity, counter, missed-broadcast, tab isolation and cleanup checks. Full regression remains non-green, and the fresh pre-edit runner did not retain inner failure identities. Those limitations prevent certification of every acceptance criterion.

## 2. Existing UI/activity architecture

`ChatInterface` renders virtualized `WorkspaceMessage` rows. Each assistant run uses `WorkspaceTimeline`'s existing `splitStages`, `StageSection`, `ToolEventCard` and final response. SQLite message execution steps remain the execution record; the new projection never inserts fake tool calls or rewrites steps. `useMemoryPalace` owns context measurements. Its existing compression channel still refreshes usage, while W5 uses verified resumed-request measurements during a live run.

Main-process `workspaceCompaction.compactAtBoundary` remains the safe-point owner. W2 generates/validates; W3 performs prospective measurement, transactional activation and post-commit rebuilding; W4 retains independent-operation barriers and staged generation. Existing trusted IPC registration/data-access checks and preload APIs are extended rather than replaced.

## 3. Files changed and existing work

Initial Git status, exact W5 file inventory and SHA-256 hashes are in evidence. Existing dirty W2/W3/W4 files were extended in place. No commit, push, stash, reset, clean or restoration of user work occurred.

Production changes:

- `src/main/workspaceCompactionActivity.js`: content-free persistence, safe codes, terminal-write retry and startup reconciliation.
- `src/main/db.js`: additive event-store installation/reconciliation at database initialization.
- `src/main/workspaceCompaction.js`: lifecycle observation around existing runtime boundaries; verified measurement contract for the counter.
- `src/main/workspaceCompactCandidate.js`: optional, exception-isolated progress observations around actual generation/validation, including intermediate stages.
- `src/main/ipcHandlers.js`: trusted list route and sender-owned broadcast closure.
- `src/preload.js`: read/subscription bridge with one native listener and session fan-out.
- `src/lib/memoryChat.mjs`: records continuation immediately before existing dispatch; executes no additional action.
- `src/lib/compactionActivity.mjs`, `src/hooks/useCompactionActivity.js`: revision merging, anchors, reconnect polling and cleanup.
- `src/components/chat/CompactionActivity.jsx`, `WorkspaceTimeline.jsx`, `src/components/main-app/ChatInterface.jsx`: compact inline rendering and persisted-ID linkage during streaming.
- `src/components/MemoryPalace.jsx`: verified full-request counter update and suppression of the old Workspace summary notice.

Tests: new `workspaceCompactionActivity.test.cjs`, `compactionActivity.ui.cjs`, `fixtures/compactionActivity.jsx`; additive W4 loop assertions and optional overrides in `fixtures/w3Compaction.cjs`.

## 4. Event lifecycle

Each qualifying attempt has a main-process UUID, session, run, owning assistant message, tool anchor, durable ordering sequence, monotonic revision, timestamps, status and safe diagnostic code. States are `started`, `generating`, `validating`, `checking-fit`, `committing`, `completed`, `deferred`, `failed`, `cancelled`. Requests below pressure do not create noise. Disabled compaction retains existing behavior.

Success is written only after the existing W3 `committed-and-verified` result. A candidate or successful model response cannot produce success. Duplicate terminal updates are ignored; the sole permitted terminal refinement is the same completed event's `continued` observation. Diagnostic codes use an explicit runtime-code allowlist; arbitrary exception messages/stacks are never sent to the renderer.

## 5. Durable event storage and write-failure policy

The additive `workspace_compaction_activity` table has a unique attempt ID, sequence primary key and session foreign key with `ON DELETE CASCADE`. Its small JSON metadata contains only permitted measurements, stage count, checkpoint identity, continuation and W3 source-version hash. It contains no checkpoint document, prompt, task prose, tool arguments/output, credentials or reasoning.

Every broadcast follows the event transaction. If initial persistence fails, the service emits no volatile event and lets compaction proceed. If a terminal write fails, its known facts are retained for retry on the next list request; continuation merges with pending measurements rather than losing them. Activity failure cannot roll back, weaken or turn W3 activation into a successful runtime result.

Startup inspects a recorded checkpoint ID or W3's existing sourceVersion/run binding. A current checkpoint alone does not prove post-commit verification. Unfinished durable attempts become cancelled with `interrupted-commit-unverified` or `interrupted-before-verified-commit`; neither is inferred successful. This preserves uncertainty rather than inventing a failure of the compaction algorithm. Durable completed events survive reopen unchanged.

## 6. IPC event stream

`workspace:compaction-activity-list` runs inside existing trusted-sender/data-access enforcement. Runtime broadcasts use a closure bound to the invoking sender, rechecking its trust and lifetime before each send. Activity cannot be produced by a renderer invoke. The preload exposes `memoryPalace.listCompactionActivity(sessionId)` and `onCompactionActivity(sessionId, callback)`.

One native activity listener fans out to session-specific subscribers. Cleanup is idempotent; the last subscriber removes the native listener. VM tests exercise the actual preload with twenty sessions and verify routing and listener removal. A throwing broadcast does not affect durable state. Best-effort transport is supplemented by durable list reconciliation.

## 7. Workspace timeline rendering

A compact native disclosure presents phase/outcome, successful before/after complete-request counts and percentage reduction. Details show usable input capacity, threshold, method, stage count, timestamp and safe reason. No checkpoint contents or stack traces are displayed. The existing theme variables supply text, borders, focus and error colors. Success labels use primary text for legibility across themes. There is no spinning animation, invented percentage or global compaction toast.

The existing virtualized assistant row and tool cards remain in use. Streaming drafts retain the main-process message ID separately from their temporary rendering ID so live events attach immediately. Variant run identity prevents activity from an older regenerated reply appearing on another variant.

## 8. Ordering guarantees

Attempts are ordered by durable sequence. Each records the last durable execution-step ID at its start. The renderer splits existing step groups at that anchor and inserts a single activity disclosure, followed by subsequent tools and the final response. Reload therefore reconstructs the position rather than appending old events at the end. No timestamps are fabricated for tools that lack them.

Repeated attempts retain different UUIDs even at the same anchor. Duplicate/out-of-order deliveries cannot downgrade revisions or create duplicate cards. The mounted fixture checks `before.js → compaction → after.js`; the real long-history loop checks eleven distinct events and unchanged tool-execution uniqueness.

## 9. Live progress and rendering cost

Actual W2 generation and validation boundaries supply progress, including intermediate summarization stages. Repeated identical state/metadata updates are coalesced before writing/broadcasting. Bounded W4 stages prevent unbounded low-level traffic. No numerical completion percentage is fabricated.

A 2.5-second read repairs missed broadcasts or subscription failure. Concurrent reads are prevented. Unchanged snapshots retain React state identity, avoiding a pane render on every poll. Snapshot reconciliation removes deleted records while preserving newer IPC revisions; unmount cancels observation only, never the owning run.

## 10. Context counter and measurement accuracy

Cards use `diagnostics.beforeTokens` and post-commit `actualTokens`, never candidate size. Both measurement methods are retained. A successful synthetic fixture measured **39,889 → 3,693 estimated complete-request tokens (90.7% less)**. These are fixture results, not promised real-model reductions. The eleven-compaction fixture's complete-request pairs and stage counts are in evidence.

The existing counter now accepts the actual verified resumed-request count and budget contract. It invalidates pending prefix measurements instead of replacing the full live request with a shorter prepared prefix during compaction. Normal end-of-turn measurement remains unchanged. A separate session model identifier handles provider-native model names safely. The mounted real `useMemoryPalace` hook checks the count, estimated confidence, normalized model identity and absence of the old Workspace notice. Failed/deferred events never provide an artificial after-count.

## 11. Failure and deferred display

Actual operation-barrier deferrals map to an operation-still-completing explanation. Irreducible/prospective overflow identifies required state that cannot safely be reduced. Recognized validation codes explain preserved original history; provider codes identify unavailable generation. Other allowlisted codes get a concise generic outcome and safe code, rather than an invented reason. Unknown provider-supplied text becomes `compaction-error`.

Failure injections cover start/generation boundary, provider/schema/prospective errors, transactional stages, post-commit rebuilding, event insert/update failure and IPC callback failure. Tests assert no false completed outcome and no invented reduction. The existing W3 compensation and W4 concurrency checks remain authoritative.

## 12. Session/tab isolation

Session-scoped preload delivery, hook revision merging, owning message/run filtering and disposal prevent cross-chat cards. Mounted checks switch A/B, reopen A, duplicate/reorder deliveries, miss an update and unmount, verifying one listener and eventual cleanup. Persisted events rebuild after DB reopen. Polling recovers missed transport updates without running tools or cancelling the agent.

Existing W3/W4 tests cover cancellation, source/model/configuration changes, independent-child/background settlement and dispatch revalidation. W5 adds actual event assertions in the full background, child and long-history loops. Not every production tab/model transition has a full inference Electron end-to-end test.

## 13. H1 deletion compatibility

Real isolated `sessionManager.deleteSession` removes activity via the owning foreign key. Late updates affect no row; late creation selects only an existing Workspace owner, and H1 tombstones separately prevent reuse. Reopen preserves deletion; `foreign_key_check` remains empty. Renderer snapshot reconciliation removes records after missed deletion notifications. H1 cancellation, deletion triggers and resurrection policy were not changed. No real conversation or live database was touched.

## 14. U7 authorization compatibility

No authorization, grant, tool dispatch, permission revision or sandbox policy changed. Activity records contain no executable authority. Main-process sender checks remain authoritative; source references and checkpoint IDs cannot restore grants. The enabled broad U7 suite passes 14/14. The UI has no API that requests compaction, resumes tools or creates a new run from an event.

## 15. Casual non-regression

Activity creation selects only sessions with a project owner, and only Workspace owning loops call this service. The UI hook is disabled for Casual; cards live exclusively in `WorkspaceTimeline`. The temporary/persisted message-ID update is Workspace-only. Shared MemoryPalace behavior changes only for the verified Workspace commit diagnostic; normal Casual notices and measurement refresh remain unchanged. W2/W3/W4 Casual and existing compression regression suites pass among the included files. No Casual prompt overhead or model-loop algorithm was added.

## 16. Deterministic integration tests

New W5 tests pass **26/26**, with exact identities in evidence. They use the real W3 producer and W2 generator against disposable SQLite databases, not only static props. Tests cover successful verification, transactional/post-commit failure, provider/schema/prospective errors, cancellation, no-reducible-history deferral, durable revision ordering, write and broadcast failures, metadata retention during retry/continuation, database reopen, interrupted reconciliation, deletion, late writes, eleven distinct attempts, Casual exclusion, rendering-order helpers, exact/estimated labels and actual preload fan-out.

Existing W4 full-loop tests now additionally assert that activity count equals actual compaction count, IDs are unique, all events belong to the original run/message, continuation is recorded and post-commit measurements match. The long-history loop asserts exactly eleven completed events. Existing tests verify staged generation and unchanged tool execution/child settlement behavior. Some intermediate-generation failure injection remains service-level W2 coverage rather than a separate mounted W5 failure scenario.

## 17. Renderer tests and accessibility

`compactionActivity.ui.cjs` passes its eleven mounted checks: started display, execution order, unique event, native accessible disclosure/status, honest measurements, real context-counter hook, expansion, missed-update recovery, isolated tab switch, reopen and cleanup. Light/dark screenshots at 420×800 were inspected; files and hashes are recorded in evidence. Native summary controls preserve keyboard activation and focus without programmatic focus theft; status text uses a polite live region. Rows have list-item semantics. No motion is introduced.

Existing `tabContextPersistence.ui.cjs` and `compressionDispatch.ui.cjs` pass. `tabSwitchIsolation.ui.cjs` fails its unchanged shell-level assertion that only one chat re-renders after a status update (observed three). That harness stubs every changed W5 renderer leaf. `preloadSandbox.integration.cjs`, run with Chromium sandbox enabled, fails its existing API-shape expectation: it expects `chatAPI.getChildTranscript`, while the source exposes that method under `api`. W5's actual activity bridge is independently VM-tested. Neither unrelated harness assertion was modified to manufacture acceptance. The restricted Electron launch itself was blocked by the environment; the activity fixture passed with a virtual display and host permission.

## 18. Regression comparisons

Fresh before-edit production build and restricted file-level regression were completed before production edits. The baseline used explicit test file discovery, excluding the same five Git-mutating suites as W4. The `node --test` subprocess runner suppressed inner test identities; failing per-file logs were empty. That is a verification limitation, not proof of exact-test stability.

| Run | File entries | Passing | Failing |
| --- | ---: | ---: | ---: |
| Fresh pre-edit restricted | 228 | 202 | 26 |
| Final restricted | 229 | 203 | 26 |
| Earlier enabled final | 229 | 218 | 11 |
| Latest enabled final | 229 | 217 | 12 |

Restricted failing file sets are identical: **zero new file identities**. No fresh pre-edit localhost-enabled baseline exists, so zero new exact inner failures cannot be certified. The latest enabled run additionally observed `backgroundCommands.test.cjs`'s `real dispatcher returns promptly, captures running output, finite success/nonzero and exactly-once events`; its independent rerun passes 19/19. This run-dependent failure remains disclosed, not declared fixed. Enabled failures and available assertion locations/test names are in evidence. Other enabled failures are attachments, cloud IPC, engine defaults, filesystem limits, MCP IPC, message deletion/stats, RAG, skill import/proposal and subagent runner fixtures.

Excluded explicitly: `deleteProjectFile.test.cjs`, `gitTools.test.cjs`, `recoveryBoundary.test.cjs`, `recoveryIpc.test.cjs`, `recoveryStore.test.cjs`. They contain known Git mutations; their isolation from the user's repository was not independently proven, so they were not run. This is not full-suite acceptance. Focused H1, U7, Workspace, context, tab and compression files are included in the broad inventories. Intermediate new-test fixture failures were corrected and the final W5 suite rerun green.

## 19. Production build

Fresh baseline and final `npm run build` pass. The existing Vite chunk-size warning remains. JavaScript syntax checks and `git diff --check` pass. No packaging, deployment, dependency installation, commit or push occurred.

## 20. Remaining limitations

No real local/GGUF, exact tokenizer or paid provider inference occurred. Complete-request metadata is runtime-derived, while synthetic fixture numbers remain explicitly estimated. Producer integration and mounted projection tests are complementary; there is no full production Electron inference-to-card end-to-end certification. Crash reconciliation is tested through durable evidence and database reopen, not power-loss injection.

A complete event-store start-write failure can omit an activity attempt; a persistent terminal-write outage can delay final display until retry/restart. Runtime history safety takes precedence, with no volatile false-success broadcast. Interrupted commits lacking durable verification remain explicitly uncertain. The five exclusions, missing exact pre-edit baseline identities, enabled timing failure and existing UI harness failures prevent a claim that every acceptance criterion is satisfied.

## 21. W6 readiness

W5 provides a durable, recoverable activity projection for the existing Workspace runtime. W6 was not implemented. No scheduling, tray behavior, new inference architecture, compaction algorithm replacement or unrelated development was added. Full acceptance still requires the stated regression/harness verification gaps to be resolved independently.
