# CONTINUUM A1 — Agentic context, worklog coverage and historical retrieval audit

Date: 2026-10-28, Asia/Dhaka. Audited HEAD: `bd379ceacdc3fb6977d5ed825b61adc0bf66d9b0`. Initial Git status was clean. This is an audit, not a compaction implementation or release certification.

Evidence: [machine-readable captures and results](a1-agentic-context-evidence.json). Reproducer: [disposable audit fixture](a1-agentic-context-fixture.cjs). No production code, TaskFlow files, live database records, model lifecycle or context settings were changed. No Git mutation was performed. Tests and experiments used temporary profiles and databases. The only repository additions are these three audit artifacts.

## Outcome

The reported low context number does **not** establish a compaction failure. The specified chat's recorded telemetry distinguishes a **64,727-token final request** in the resumed coding turn from a **28,156-token request** in the later worklog question. The former turn accumulated **1,127,339 total processed tokens across 20 requests**. These numbers describe different requests and different quantities.

Historical evidence is retained much more completely than the model-facing prompt. All **175 synthetic operations** were accounted for and retrieved through the real authorized native dispatcher. All **176 tool steps actually present in the specified chat snapshot** also retrieved with their exact stored results, using pagination where needed. Neither establishes that an unpersisted operation never existed.

There are three confirmed, bounded follow-ups: incomplete navigation to older tool steps, missing automatic worklog reconstruction for interrupted turns, and contradictory plan-lifecycle instructions. The header is also a prepared-request projection, which can differ materially from the active loop's wire request. There is no evidence supporting time-based or tool-count-based compaction.

## Direct answers

Source references below are repository paths; the pipeline table supplies function names. JSON paths refer to the accompanying evidence file. “Estimate” always means an estimate, not an exact model tokenizer count.

| # | Question and conclusion | Source / verified evidence | Uncertainty, severity and action |
| --- | --- | --- | --- |
| 1 | **Are tool calls counted? Yes, when included in the current request.** IDs, function names and serialized arguments remain in active-loop assistant tool-call messages. Later user turns do not automatically replay these raw calls. | `src/lib/memoryChat.mjs` `sanitizeChatMessages`, request construction and tool settlement; `src/main/contextBudget.js`; `captures` has 1–175 paired calls in final wire bodies. | Exact model token cost unmeasured here. Intended behavior; no fix. |
| 2 | **Are results counted? Yes, the model-facing results actually serialized.** Full stored results do not count merely because they exist in SQLite. | Same captures; `engineManager.truncateToolOutput`; `trimming` shows a missing tail in the wire request and exact stored-tail retrieval. | Media and external tool output can already be normalized before storage. Intended behavior with retrieval limitation F1. |
| 3 | **Reasoning is consumed as output and handled separately.** Parent `reasoning_content`/`reasoning` goes to thought callbacks/steps, not back into the next assistant tool-call message. Cumulative usage can include reasoning without retaining its text in the next input. | `memoryChat.readCompletion`, `settleEntry` and history append; `completionStats.phaseStats` / `mergePhaseStats`; `summary.reasoningReplayed=false`. | Qwen's recorded reasoning count is null/unreported; zero must not be inferred. Provider adapters may differ. No defect established. |
| 4 | **Why approximately 28K after many calls?** New user-turn preparation uses prose, briefs, bounded worklogs and the current plan; it does not replay previous turns' tool transcripts. The 28,156 measurement is a later recall reply, not the 64,727-token coding request. | `promptBuilder.messageForModel`; `recordedChat.messageAccounting` messages 3894 and 3898; active-versus-later-turn captures. | Original historical request bodies were not stored. Intended reduction, not proof of semantic completeness. |
| 5 | **What do worklogs preserve?** Deterministic per-operation descriptions/status/path metadata, available edit counts, command exits, limited excerpts and an issue ledger. They are not a full source-content archive. | `turnDigest.buildEntry`, `buildTurnDigest`; `workLog.recordTurnDigest`; `digests`, `coverage`. | A read summary need not preserve an important fact inside the file. Intended lossy presentation; F1 matters. |
| 6 | **“Omitted for budget” means presentation omission.** Per-digest text is capped at 2,000 characters; the assembled worklog body at 10,000; only four recent digests receive detailed rendering. | `turnDigest` constants and rendering; `workLog.assembleWorkLog`; `recordedChat.digestAnchors`. | Open-issue ledger is separately capped at 20; old issue summaries can also be evicted. Originals remain separate. No compaction change. |
| 7 | **Are all omitted operations stored?** Yes for all completed persisted operations in the tested fixtures and all 176 recorded steps in this chat. No universal guarantee for volatile work before a persistence flush. | `coverage`, `deltaRetrieval`, `recordedChat.operationAccounting`, `restart`. | A hard crash can lose unpublished changes in the IPC's 250ms persistence window. Medium risk/F2; define durable boundaries. |
| 8 | **Can the agent discover and retrieve old evidence?** Exact-ID retrieval works, with branch/ownership/deletion checks and character pagination. Discovery is incomplete: tool-result text is not searched and only 16 tool IDs per source message are listed. | `workspaceEvidence.retrieve`, `agentTools.executeAgentTool`; `navigation`, `pagination`, `denied`. | Other artifacts may happen to expose a missing ID. No dependable enumeration route is supplied beyond 16. Confirmed medium defect F1. |
| 9 | **Are old briefs unnecessarily injected?** Not demonstrated in this chat. There are six selected briefs before the recall question, seven after it, and zero checkpoints. Uncovered unknown briefs are deliberately protected. | `taskBriefs.selectModelBriefs`; `recordedChat.selection`; C6-E regression suite; `compaction.briefSelection`. | The model's claimed nine originals #578–#586 is not an accurate inventory of this chat's stored rows. Post-compaction semantic completeness remains model-dependent. No new brief-selection fix. |
| 10 | **Is the UI meter the wire request?** Not necessarily. Its headline is a prepared projection plus draft estimate. Live actual/peak telemetry is separate; final local dispatch guards the actual normalized payload. | `promptMeasurement.measurePreparedContext`; `MemoryPalace.jsx`; `main-app/Header.jsx`; `contextDisplay.mjs`; final guarded captures. | Historical header payload/count provenance is absent. No exact historical accuracy certification; low usability limitation R1. |
| 11 | **What survived restart?** Message 3892 retains partial prose, run identity, ten tool results and the plan update to revision 8. The next run has a new identity. No digest exists for that interrupted turn. | Read-only recorded snapshot imported into a disposable DB; `recordedChat.interruptedEvidence`, `restartClaim`, `digestAnchors`; `restart`, abrupt-kill regression. | No evidence establishes exactly what volatile reasoning, shell state or unpublished output existed at the crash. Medium F2; not full crash-resumability. |
| 12 | **Is there a genuine continuity defect?** Yes: stored evidence can be difficult to discover, and interrupted-turn tool evidence is not automatically reconstructed into a worklog. No proven deletion of completed stored operations. | F1/F2 reproductions, including tool-only operation 19 and completed-snapshot restart. | Deterministic retrieval correctness is not a semantic model-memory guarantee. Prioritize navigation/reconstruction. |
| 13 | **Is another compaction change necessary?** Not supported by this evidence. Both active-loop growth and bounded later-turn presentation behave as implemented. | Actual `compactAtBoundary` rejects no request below pressure in the 175-round fixture; 175-evidence incremental checkpoint fixture; W2–W7 suites. | More unresolved evidence/constraints can still exhaust capacity. Keep current fit checks; do not add a timer/counter trigger. |
| 14 | **Smallest supported fix?** First provide bounded step navigation/search, then partial-digest reconstruction on interrupted-row recovery, and align plan instructions with session-owned get/update semantics. | Findings F1–F3 below and evidence `findings`. | These are recommendations only. No fix or A2 work has begun. |

## Actual context construction and storage pipeline

| Stage | Implementation and policy |
| --- | --- |
| User requests and durable source | `src/main/sessionManager.js`: `saveMessage`, `activePath`, `getActiveMessages`; `src/main/taskBriefs.js`: `captureBriefForUserMessage`, `getApplicableBriefs`, `activeMessageIds`. Messages/briefs follow active-branch ancestry; archival does not delete original records. |
| Workspace preparation | `src/main/ipcHandlers.js`: `session:prepare-messages` delegates to `src/main/promptBuilder.js` `prepareChatMessages`; `rebuildChatMessages` is also used for recovery and projected compaction. It composes base/system instructions, selected briefs, checkpoint or rolling summary, session instructions, active prose, worklog and plan. Attachments and applicable memory/project instructions contribute where configured. |
| Brief selection | `taskBriefs.coveredBriefMessages`, `selectModelBriefs`, `selectHistoryMessages`, `buildTaskBriefSection`: current, active/persistent, dependencies, standing constraints, attachments and uncovered unknown requirements are protected. Valid source coverage permits old ordinary requirements to be represented by working state. Missing explicit source references fail rather than fabricate. |
| Parent loop | `src/lib/memoryChat.mjs`: `runMemoryChat`, `readCompletion`, `sanitizeChatMessages`, inner `settleEntry`, `compactWorkspace`. Current-run tool-call/result pairs accumulate in memory and enter the next payload. Tool IDs must be unique and calls/results paired. Steering and command-completion notices enter at request boundaries. |
| Parent final local wire | `memoryChat` serializes `requestPayload`; `src/main/localEngineFetch.js` wraps media and context guards; `contextBudget.createContextGuardedFetch` merges system messages via `src/lib/systemMessages.cjs` `mergeSystemMessages`, checks the complete payload, and serializes the normalized body sent to raw fetch. The audit captures **after** these guards. Text-only media guarding does not alter the fixture payload. |
| Cloud serialization | `src/main/cloudProviders.js`: `prepareCloudPayload` / cloud fetch adapter translates OpenAI-style messages/tools into provider-native requests, including Anthropic system/tool-result blocks and reasoning controls. `promptMeasurement.createCloudWorkspaceMeasurer` estimates native composition. This Qwen audit does not certify exact cloud tokenizer or live cloud parity. |
| Tool result formatting and trimming | `src/lib/toolResultFormatter.mjs`: `formatToolResult`, `redactModelContent`; `engineManager.truncateToolOutput` caps serialized model-facing output at 20,000 characters. `settleEntry` stores `displayResult` before guarding model content and appends a `source_step_id` retrieval notice when trimming changes it. Encoded media can be extracted/normalized; a durable “original” is the stored formatter result, not a promise to preserve every transport byte. Filesystem tools may independently paginate or cap their output before this layer. |
| Durable execution | `src/main/executionSteps.js`: `normalizeExecutionSteps`, `readExecutionSteps`; `engineManager.createMessagePersistence`; `ipcHandlers` `persist` and `onExecutionSteps`. Steps preserve IDs, tool, arguments, statuses, results and errors. SQLite transactions persist published snapshots; the owning IPC usually schedules updates on a 250ms timer. The compaction boundary explicitly flushes before source capture. |
| Worklogs | `src/main/turnDigest.js`: `classifyTool`, `buildEntry`, `summarizeRead`, `summarizeEdit`, `summarizeCommand`, `reconcileIssues`, `buildTurnDigest`; `src/main/workLog.js`: `recordTurnDigest`, `recordTurnDigestSafe`, `assembleWorkLog`, `buildWorkLogSection`. Terminal success/interruption/catch paths create digests from persisted steps. JSON retains all digest entries even when rendered text omits them. A process death can bypass these terminal paths. |
| Historical retrieval | `src/main/tools/agentTools.js`: `executeAgentTool` routes `get_recent_chat_history` after `guardTool`; `src/main/workspaceEvidence.js` `retrieve` handles source IDs/history navigation. It reads storage only, never replays a tool. Session availability, READ capability and active-branch membership restrict source lookup. Generic `getRecentChatHistory` is a separate preexisting cross-chat prose-recall API, not a tool-result index; it must not be confused with cross-session source-ID access. |
| Plan | `src/main/workspacePlan.js`: `createPlan`, `updateSteps`, `readPlan`, `compactMutationResult`, `buildPlanSection`. One plan per session, revision incremented in place; create/get return full state, updates return changed steps/progress. Completed plan lines may be omitted from bounded rendering. Plans record intention and reported status, not verification evidence. |
| Candidate generation | `src/main/workspaceCompactCandidate.js`: `snapshot`, `generateWorkspaceCompactCandidate`, `retainPriorState`, draft validation. It binds references to original messages/steps, checks completion and claims, preserves prior source-bound observations, parses only newly eligible evidence after a valid prior checkpoint, and refuses oversized evidence rather than silently dropping it. New evidence has a 48,000-character bound. Generation may use bounded intermediate stages. |
| Checkpoint state | `src/main/taskCheckpoints.js`: `persistCheckpointRow`, `workspaceCompactSection`, `buildCheckpointSection`. Durable integrity/evidence and model-facing working state are different representations. The latter contains objectives, requirements, decisions, files, tests, unresolved items, next actions and selected evidence; full source bindings/evidence remain durable. A validated source reference is not independent proof of the model's interpretation. |
| Safe-point activation | `src/main/workspaceCompaction.js`: `compactAtBoundary`, `perform`, `completedPrefix`, `operationReferences`, `validateSafePoint`, `candidateMessages`. Complete-round boundary → flush/snapshot → generation → prospective full request/fit → atomic archive/checkpoint activation → rebuild/measure → same-run dispatch. Run owner, permission revision, source hashes, branch, deletion, child/background ownership and pairing are guarded. Protected/in-flight material is not arbitrarily discarded. |
| Budget / measurement | `src/main/contextBudget.js`: `reserveTokens`, `createRuntimeBudget`, `atCompactionPressure`, `approximateTokens`, `createPromptMeasurer`, `createContextGuardedFetch`. Runtime per-request capacity is distinct from configured total. Output reservation is max(output, explicit reasoning budget), plus safety; not two output allowances. Pressure is 90% of usable input, after reservations. `/apply-template` and `/tokenize` can measure exact supported text prompts only when schemas are demonstrably included; otherwise fallback is labeled. |
| Usage and header | `src/lib/completionStats.mjs`: `phaseStats`, `mergePhaseStats`, `turnPromptTelemetry` distinguish aggregate input/output from last/peak request input. `src/main/promptMeasurement.js`: `measurePreparedContext` builds a prepared projection with schemas/settings. `src/components/MemoryPalace.jsx` and `main-app/Header.jsx` display it; `src/lib/contextDisplay.mjs` exposes method, reservations, live/last/peak and the projection warning. |
| Child loop | `src/main/subagents/agentLoop.js`: `runInvestigationExecution`; `subagents/contextRecovery.js`: `createChildContextAdapter`, `trimToolResult`, complete rounds and paired validation. Child `rawContext` and active projection are separate; bounded result snippets, checkpoints and summaries replace older active rounds under pressure. `subagents/persistence.js` `persistChildRun` retains raw/projected context, state and continuation metadata. `subagents/sessionManager.js` `rehydrateSession` marks formerly active children interrupted; explicit authorized continuation is needed. Parent receives a child report/handle, not every child's raw message. Parent and child context totals must not be added as one model window. |

Agentic tool rounds therefore have a distinct representation lifecycle from ordinary dialogue. They remain raw in the active loop, can be checkpointed at a safe point, and are represented in subsequent user turns by persisted assistant prose plus bounded digests/checkpoints. `messageForModel({role,content,attachments})` intentionally does not reconstruct execution steps or thought text from old rows. Even ordinary prose can later be archived behind a checkpoint. Storage retention is not equivalent to prompt retention.

## Recorded TaskFlow evidence

The inspected chat is `217b8985-615d-4042-98bf-06135a2cd380`, titled **TaskFlow — C6-E Continuity Test 001**. Only safe SELECTs on a `readonly:true`, `fileMustExist:true`, `query_only=ON` connection were used. No application database initializer or migration ran against live storage. Selected rows were imported into a disposable database before running production builders/retrieval. The JSON records metadata and result hashes rather than copying the whole private chat.

| Assistant message | Persisted tool steps | State | Provider final/peak prompt | Cumulative total tokens |
| --- | ---: | --- | ---: | ---: |
| 3880 | 23 | completed | 31,499 | 391,692 |
| 3886 | 23 | completed | 31,363 | 361,911 |
| 3888 | 46 | completed | 46,499 | 1,451,293 |
| 3890 | 39 | completed | 49,680 | 1,007,860 |
| 3892 | 10 | interrupted | not persisted | not persisted |
| 3894 | 35 | completed | 64,727 | 1,127,339 |
| 3898 | 0 | completed recall reply | 28,156 | 29,112 |

The snapshot contains **176** tool steps, not exactly 174. Its 166 completed-turn steps plus ten interrupted-turn steps have distinct durable identities. An approximate UI count is insufficient to explain the two-step difference; no omitted identity is inferred from that discrepancy. All 176 stored result bodies were checked against paginated native retrieval in the disposable clone. This verifies persisted records, not unknown work that never reached SQLite.

No workspace checkpoint exists for this chat, and its stored messages are unarchived. Briefs before message 3898 are **578, 582, 583, 584, 585, 586**, not every integer in the range 578–586. Brief 588 is the later worklog question. Original briefs are selected because they remain uncovered unknown requirements, with applicable constraints, not because nine records were silently reactivated. Plan revision **10** and its current objective are durable.

Worklog digests exist for messages 3880, 3886, 3888, 3890 and 3894. Their entry counts are 23, 23, 46, 39 and 35. Turns 3–5 report **21, 27 and 32 omitted entries**, matching the reported scale. The assembled four-digest policy omits one older detailed digest. The interrupted message 3892 has **no digest**. Its completed reads nevertheless survive, including the source and test-file ranges and the revision-8 plan update. The resumed model's claim that the coverage map “didn't survive” is therefore not evidence that those reads were deleted: prose and original results are present, while its internal analysis is not reconstructed.

The saved model load configuration says **75,192 configured context**, one parallel slot, updated 2026-10-27. This is not a historical `/props` capacity measurement. Default 1,024 output plus 128 safety would yield 74,040 usable input if that configured number were the actual capacity. Runtime rounding, explicit output/reasoning settings and historical state are not known well enough to equate it to the reported “74.1K.” At 74.1K usable input, the illustrative trigger is approximately 66.7K: 28.1K is far below it and 64,727 is still below it. No historical full capacity contract or serialized request body was retained, so the precise denominator is unverified.

## Final provider-request measurements

The audit uses actual `runMemoryChat` construction, production context/media guards, and captures the final body at the raw-fetch boundary. Inference responses and tool operations are deterministic mocks. A simulated runtime reports 90,112 capacity; tokenizer/template support is unavailable in the fixture, so the application's fallback computes UTF-8 serialized bytes/3 plus 32 per message. This is **not a real Qwen token count**. The simulated budget is 88,960 usable input and a trigger of 80,064, with default 1,024 output plus 128 safety. The actual `compactAtBoundary` callback is exercised at every active-run request and does not generate below pressure.

| Completed rounds, one active run | Serialized bytes | Estimated full-request tokens | Raw calls | Raw results | Automatic pressure |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 20,304 | 6,928 | 1 | 1 | no |
| 10 | 23,277 | 8,495 | 10 | 10 | no |
| 30 | 29,606 | 11,885 | 30 | 30 | no |
| 60 | 39,234 | 17,014 | 60 | 60 | no |
| 100 | 52,029 | 23,839 | 100 | 100 | no |
| 175 | 76,302 | 36,730 | 175 | 175 | no |

Extra round-70 and round-150 captures verify the early finding. A separate equivalent history spreads the same 175 operation outputs over five user turns; the terminal steps/digests are constructed directly through production persistence, not by pretending to have run 175 real commands.

| Operations after separate turns | Serialized bytes | Estimated tokens | Raw prior tool pairs | Rendered worklog block characters | Current plan |
| ---: | ---: | ---: | ---: | ---: | --- |
| 35 | 22,814 | 7,701 | 0 | 2,205 | revision 10 |
| 70 | 25,852 | 8,778 | 0 | 4,226 | revision 10 |
| 105 | 28,328 | 9,667 | 0 | 6,245 | revision 10 |
| 140 | 30,787 | 10,551 | 0 | 8,248 | revision 10 |
| 175 | 31,656 | 10,904 | 0 | 8,565 | revision 10 |

Each `captures[]` entry contains the **complete provider request**, its SHA-256, total exact bytes, estimated tokens, component bytes/characters/estimates, assistant/call/result counts, brief counts, plan revision, checkpoint size, omission reason, budget contract and computed occupancy. System size includes brief/worklog/plan blocks; those nested components must not be summed again. Current user cost is separate from its duplicated authoritative brief. The one-run fixture has one brief, no existing plan/checkpoint/worklog; absent components are zero, not unmeasured. Five-turn fixtures deliberately include a real revision-10 durable plan.

An equivalent five-generation incremental checkpoint experiment retains **35, 70, 105, 140, 175 evidence IDs**. Every generation receives only **35 new evidence records**; previous source coverage is revalidated rather than repeatedly importing all old raw results into generation. Final working-state size is roughly **3.8K chars/4-estimated tokens**, including retained failures; exceeding a soft 2–3K target is permitted. The post-checkpoint provider request is also captured. Candidate source validation and transactional fixture installation are exercised here; the separate W3/W4 tests cover the full owning-loop activation protocol. Manual fixture installation must not be misrepresented as an additional five real-model automatic compactions.

## Coverage, worklog accuracy and continuity

`coverage[]` accounts for every identity `a1-op-1` through `a1-op-175`, its containing message, tool, stored-result hash, direct/raw visibility, matching summary text and retrieval route. Categories overlap:

- All 175 are directly represented by paired call/result messages in the final active-run request.
- All 175 have durable execution steps and durable digest entries in the separate-turn fixture; zero raw pairs are replayed in its later request.
- Only 53 operations have a matching summary string in the final assembled prompt. This is a **text-match measure**, not 53 uniquely attributable IDs: summaries can be shared, and issue-ledger lines can replace individual descriptions. Worklog lines generally do not carry operation IDs.
- All 175 results are exactly retrievable through `executeAgentTool(get_recent_chat_history)` in that fixture. **Missing stored records: zero.** Omissions from rendering are not deletions from execution steps or digest JSON.
- In the equivalent checkpoint fixture, all 175 IDs remain in the validated durable evidence set and all 175 stored results remain retrievable. The model-facing checkpoint is selective; durable checkpoint evidence is not all directly visible.

Fixtures mix source reads, successful edits, rejected edits, failing and passing test commands, plan reads and multiple user turns. Edit outcomes are recorded as supplied by the native result shape; the worklog does not independently inspect the filesystem. Failed edits must not be described as modifications. Command `exitCode` and status distinguish failures from later successes, but only for the shell command actually run: a pipeline ending with `tail` or `echo` can return zero even if an earlier test process failed. The recorded TaskFlow commands contain such pipelines. A deterministic label “tests passed (exit 0)” is not independent validation of every subprocess. This is a shell/result interpretation limit, not evidence that context accounting dropped a failure.

The round-5 synthetic file read contains `TAG_LOSS_EVIDENCE: updateTask resets tags when tags is absent.` It remains directly in the final wire request at rounds 70 and 150. It is **not** preserved semantically in the later-turn read summary, which describes a read rather than the source finding. The native source navigator exposes its first-turn message on the second page and includes operation 5 among that message's first 16 IDs. Exact retrieval then returns the original finding. After checkpointing, source-attributed research retains the finding, and the original remains retrievable after database reopen.

Early failed and passing commands have separate IDs and exit codes; the later edit, failed edit and file paths remain in source results even if their worklog lines disappear. The persistent no-commit instruction and later green-over-blue instruction are present in the later request; the earlier user instruction remains exactly retrievable. This verifies representation and source access, not a live model's interpretation of supersession. Worklog priority/issue resolution is heuristic; semantic proof must cite source results rather than confident prose.

### F1 — Stored evidence can be effectively undiscoverable (medium)

`workspaceEvidence.retrieve(source_history=true)` reads all messages on the branch, filters **message.content only**, returns eight source candidates per page and up to **16 tool IDs** per candidate. It has no tool-ID offset or tool-result-content search. Direct `source_message_id` returns prose only, not an execution-step list.

Operation 19 contains `HIDDEN_TOOL_ONLY_NEEDLE_19` in its read result but not assistant prose. A source-history query returns zero matches. Even after visiting both source pages, that message exposes only its first 16 IDs. Retrieving the message itself does not expose ID 19. The audit succeeds only when supplying `source_step_id=a1-op-19`, which the fixture knows externally. Generic `getRecentChatHistory` also searches prose, so it does not fill this tool-evidence gap.

**Smallest recommendation:** a bounded per-message step-navigation route exposing IDs/tool/path/status, with pagination and bounded tool-evidence query support. Reuse current branch, session, H1 and READ guards. This is a retrieval correction, not a compaction redesign. No implementation was made.

### Retrieval safety and overhead

The real dispatcher verified early/later reads, a successful edit, unsuccessful edit, nonzero exit, passing test, original instruction, historical brief, omitted step, evidence older than 100 rounds and original pre-checkpoint evidence. Small-page concatenation exactly matches whole retrieval; recorded large results are checked across 8,000-character pages. Missing IDs return failure, not fabricated text. Cross-session source IDs, off-branch sources and an H1 tombstone are rejected. Stored-source retrieval does not run commands, edit files, or adopt child execution.

A `source_history` call performs one unbounded session-message SELECT/materialization and an ancestry walk (one parent lookup per ancestor), **before** slicing to eight entries. Query filtering and pagination do not make the database scan bounded. Direct step-ID retrieval without a message ID likewise scans all session rows; supplying both message and step IDs narrows the result lookup. Thus the oldest discoverable finding takes two navigation pages, each with a full-session scan, followed by source retrieval. These are confirmed scaling costs; the audit does not assert a production latency defect or optimize them. No source-history scan occurs merely because an active model request is sent. C6-E delta generation reduces repeated raw-evidence generation scans, while source/hash validation intentionally continues to scale with retained ancestry.

## Restart boundaries and ownership

### F2 — Evidence persists but is not reconstructed automatically (medium)

The audit's disposable reopen matrix uses production `createMessagePersistence` and startup migrations:

| Boundary | Durable outcome | Resumed prompt / availability | Classification |
| --- | --- | --- | --- |
| Before first step snapshot | Assistant identity exists; no tool step/result committed | No source for the synthetic volatile operation | Not persisted; actually unavailable through history |
| Running-step snapshot | Step survives; startup marks it error with restart interruption | Prose survives; step retrievable; no worklog | Persisted but not reconstructed; outcome cannot be treated as successful |
| Completed-step snapshot, before terminal digest | Completed result and run ID survive; message becomes interrupted | Original result retrievable; no raw tool pair or digest in prompt | Persisted and retrievable, but not automatically included |
| Terminal digest committed | Completed message/result and digest survive | Worklog plus prose, original result retrievable | Persisted and reconstructed through bounded digest |

The running-step fixture supplies a result-shaped payload deliberately; the startup error status still prevents treating it as a successful completed operation. The existing `incrementalPersistence.test.cjs` additionally **SIGKILLs a child process without closing SQLite/WAL**, then verifies completed output and thought persistence, running-step error conversion, completed-message survival and idempotent reopen. The new fixture's four close/reopen cases test logical persistence boundaries, not four separate power-loss injections.

The parent runtime's `requests`/`steeringRuns` maps and abort controllers in `ipcHandlers` are volatile. A durable `run_id` identifies the old run; it does not resurrect its loop, local variables, pending promise, model KV state or command process. `backgroundCommands.restore` marks formerly active commands cancelled with unknown outcome and does not restart them; child rehydration marks active children interrupted and requires explicit continuation. User messages, committed plan revision and checkpoints persist independently. New continuation ownership must be acquired under current authorization; it is not transferred by reading files.

The historical interrupted turn lost automatic model visibility of some source contents, not the ten stored operations. Completed reads are durable, while an internal coverage map may have existed only in reasoning or volatile state. Its precise contents cannot now be proved. The IPC's 250ms timer also permits a crash after a tool finishes but before its latest snapshot is durable; the source comment “published snapshot survives” does not remove that publication delay.

**Smallest recommendation:** idempotently create a partial digest/source-navigation anchor for recovered interrupted assistant rows. Separately document and, if required, flush durable tool-completion boundaries. Do not claim general crash-resume or replay operations whose external effects are uncertain.

## Plans are a separate issue

### F3 — Prompt/API lifecycle disagreement (medium)

`workspacePlan.createPlan` checks `workspace_plans.session_id` and rejects every second create, including after all steps complete. There is no task-ID or active-run-ID dimension. `updateSteps` updates the current objective/revision and removes requested step IDs. There is no immutable full-plan revision table. Old create/get/update outputs can preserve historical information, but compact mutation deltas are not a complete independent archive of every prior plan state.

`promptBuilder.buildSessionSystemPrompt` says a finished prior plan is immutable history and to “create a fresh plan for the new objective.” The `update_plan` schema instead says create once, then get/update. The recorded chat has four `PLAN_EXISTS` failures across revisions 2, 3, 5 and 7; after the revision-7 rejection, an update removes previous steps and installs revision 8. This matches the user's observation without attributing it to missing context: revision 10 is accurately rendered in the deterministic prompt fixture and stored in the real chat.

**Smallest recommendation:** align system instructions with the existing one-plan-per-session API and explicitly say to get/update for a new objective. A separate immutable multi-task plan history would be new product work and is outside A1. No plan changes were made.

## Compaction, efficiency and the eight-hour question

An agent **can** run for eight hours without crossing the compaction threshold if its current request remains below pressure. Time and tool count are not capacity. Small results, per-result output limits, multiple separate user turns, bounded worklogs and existing checkpoints can keep active input modest while durable history grows. Cumulative inference work repeatedly charges/processes retained input and therefore can exceed a million tokens even with a much smaller window. Prompt caching reduces repeated computation, not context occupancy.

That does **not** establish that every necessary fact stays salient or discoverable for eight hours. Read summaries may preserve activity without its important content; tool-only findings beyond ID 16 can be difficult to locate; interrupted turns may lack digests; unresolved/persistent evidence and brief overhead can eventually grow. A single uninterrupted active run still accumulates paired tool history unless safe-point compaction or explicit failure rewind replaces it. There is no universal “last N tool rounds only” retention in the parent loop.

| Measurement | Observation and interpretation |
| --- | --- |
| Active-run growth, round 1 → 175 | +55,998 bytes and +29,802 estimated tokens; about **322 bytes / 171 estimated tokens per additional operation** for these small mocked outputs. Not a universal slope. |
| Separate-turn growth, first → fifth | 7,701 → 10,904 estimated tokens; about **801 estimated tokens per additional user turn**, including 35 new operation summaries, new brief/prose and a fixed revision-10 plan. |
| Worklog size | Each stored digest text ≤2,000 characters; assembled worklog body ≤10,000, plus labels/wrappers. Detail retention is four digests. |
| Stored vs active operations | 175 stored/exactly retrievable; 175 raw active-run pairs; zero old raw pairs after later-turn rebuilding; 53 matching worklog descriptions, with identity caveat. |
| Tool-result duplication | Once per raw tool message in the active request. A thought/display step in SQLite does not add another provider tool result. Later requests may duplicate a fact across prose, worklog or checkpoint, but do not replay raw steps by default. |
| Worklog/checkpoint overlap | Possible and intentional: builder includes both; neither deduplicates semantic facts against the other. Incremental checkpoint fixture has no worklogs, so its measured overlap is zero; that is not a universal zero. |
| Task-brief overhead | Single-run brief block is 613 bytes and user request also occurs in dialogue. Separate-turn selected blocks grow to 1,030 bytes. Original uncovered briefs can dominate real histories; successful validated coverage suppresses eligible ordinary old content. |
| Retrieval cost | Source-history pages carry bounded observations/IDs; exact result pages default 4,000 and max 8,000 characters, plus provenance/source metadata. Added retrieved result content counts in the next request just like any tool result. Page count and representative response bodies are recorded. |
| Delta generation | Five generations add 35 evidence IDs each and retain all 175; previous source-bound observations and failure evidence survive. Integrity validation remains proportional to covered source history. |
| Loss / limits | Zero missing **stored fixture operations**. One deliberately unpublished restart operation is unavailable. No claim that all actual crash-time state was stored. |

Trimming occurs **before** next-request budgeting and can happen without any validated checkpoint. The large-read fixture loses the tail finding from active input while preserving the stored full text and an explicit retrieval ID. Successful checkpoint validation is required for archival activation, not for every lossy result trim or worklog omission. This distinction is central: durable retrieval is the fallback for those omissions, and F1 limits its discoverability.

## Regression evidence and limits

Inspected current implementations and historical W2–W7, C6-A–C6-E, H1, recovery, plan and child-retention reports. Reports were treated as context, not current test proof. The combined focused run covered **35 file entries: 29 pass, 6 nonpass**. This is file-level runner accounting, not a count of individual assertions. Complete TAP summaries and direct failure details are in `regressions.logs`.

Passing files cover W2 candidate validation, W3 safe activation, W4 advanced compaction, W5 activity, W6/W7 generation runtime, C6-A/B/D/E, context serialization/dispatch/measurement/telemetry, H1 stored-history deletion, permission revision/isolation, worklog/digest rendering, current plan/compact results, incremental abrupt-crash persistence, background commands/IPC, child transcript/retention/continuation and compaction hardening. The audit fixture separately verifies 175 operation identities, actual native historical dispatch, exact pagination and deletion/branch/session rejection.

| Preexisting/nonpassing identity | Exact observed result |
| --- | --- |
| `tests/c6cAcceptance.test.cjs` — `C6-C real coding operations preserve failing and passing evidence across three atomic same-run compactions` | Expected command exit records `[1,0]`, actual `[]`. Previously reported in C6-E. Does not certify real coding/model acceptance. |
| `tests/h1DeletionIpc.test.cjs` — `H1 real tool approval pending at deletion is invalidated without command execution` | `cancelledByParent`: promise still pending when event loop resolved. First deletion/cancel test passes. Previously reported in C6-E. |
| `tests/contextC3LiveProtection.test.cjs` — `status-only transition during summary generation rolls back all archival and summary writes` | Actual `casual-source-changed` rejection wording differs from legacy expectation. Previously reported in C6-E. |
| `tests/workspaceBudgetVerification.test.cjs` — `concurrent history change during measurement invalidates without partial persistence` | Same Casual recovery wording mismatch. Previously reported in C6-E. |
| `tests/subagentCompaction.test.cjs` — `running child crosses pressure repeatedly and resumes with early findings without tool replay` | Assertion at line 243: expected 22, actual 24. Observed on unchanged production source; underlying cause remains uninvestigated. |
| `tests/subagentOutOfProcessRecovery.test.cjs` — `a child persisted by another OS process is recovered and continued here` | Environment failure: `listen EPERM: operation not permitted 127.0.0.1`. No listener-based cross-process acceptance claimed. |

No assertions were weakened and no test/source repairs were made. An exploratory checkpoint draft initially failed `missing-required-data` because it omitted next actions/blockers despite synthetic failures; the fixture was corrected to supply valid failure state. The production validator was unchanged and correctly rejected that draft. Final long-run fixture passes. No build was needed for this audit. `git diff --check` passes, JSON parses, and only the three audit files are new.

Reproduce deterministic capture and retrieval independently of the live chat:

```sh
node docs/a1-agentic-context-fixture.cjs /tmp/a1-reproduction.json
```

Optional `A1_LIVE_SNAPSHOT` accepts the already selected target-chat table snapshot and imports it into the temporary profile; it never opens the live database. The delivered JSON preserves recorded-chat result hashes, source identities, page counts, selected brief IDs, restart evidence and telemetry. The temporary private snapshot itself is not a deliverable.

Exact real-model tokenizer measurement, historical UI-body equivalence, historical runtime capacity and natural-language semantic retention are **not certified**. No available live tokenizer endpoint was established in this audit environment; no model was launched, unloaded or interrupted to obtain one. The recorded provider telemetry is real persisted evidence; the new long-run requests and checkpoint generations use controlled responses.

A1 stops here. The recommended next action is the small historical-navigation correction, followed by interrupted-turn digest recovery and plan-instruction alignment as separate reviewed work. No A2, compaction redesign, plan refactor or new tool implementation has started.
