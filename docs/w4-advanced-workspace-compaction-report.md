# W4 — Advanced Workspace Compaction

Date: 2026-10-25 (Asia/Dhaka). Status: **implemented extensions, partial acceptance; full W4 certification withheld**.

## 1. Executive summary

W4 extends W3's existing owning-loop pipeline rather than adding an archival engine. Eligible independently running background commands and detached children can remain live while completed parent history is compacted. W2 now supports bounded, source-bound intermediate reduction and preserves earlier validated source-bound state when later model output omits it. The cloud parent path uses the existing Anthropic/OpenRouter adapters and their actual serializers. Same-run continuation, prospective measurement, atomic activation, source checks and protected complete tool rounds remain in place.

W2 passes 44/44; W3 30/30; new W4 20/20; enabled focused regression 519/519. Broad regression is not green. Idle activation, unknown-capacity cloud compaction and real-model quality are not certified. There was a fresh pre-edit focused baseline and build, but no fresh pre-edit full-suite identity baseline. Five suites executing prohibited Git mutations were excluded. Accordingly criterion 21 and full acceptance cannot be certified.

## 2. W3 baseline and limitations

HEAD is `3be8c9afc5fa946d5dec8e7ece5bae4b526ece50`. W3 existed as uncommitted tracked/untracked changes, including workspaceCompaction.js, workspaceCompactCandidate.js, memoryChat.mjs and IPC integration. All pre-existing changes were retained; no files were restored from HEAD. The initial status is recorded in evidence.

Fresh pre-edit focused baseline: 31 file entries, 27 passing and four failing: childAgentLoop.test.cjs, cloudProviders.test.cjs, subagentOutOfProcessRecovery.test.cjs, subagentSession.test.cjs. W2/W3 and Casual compression entries passed. The wrapper captured exact file identities but not inner failing test names. Baseline production build passed. This is not a fresh full-regression baseline.

W3 rejected active child streams and undelivered background records, had one-shot W2 generation, disabled parent cloud compaction, and required a real owning request for activation. Its commit/continuation owner remains `compactAtBoundary` called at the existing runMemoryChat request boundary.

## 3. Files changed

Production changes made in W4:

- src/main/workspaceCompaction.js — operation barrier, permission/approval checks, request/dispatch revalidation.
- src/main/workspaceCompactCandidate.js — child snapshot identity, bounded intermediate generation, prior-state retention, cooperative deadline and resource accounting.
- src/main/subagents/index.js — persist a detached child's non-executable identity before exposing its handle.
- src/main/cloudProviders.js — extract the existing serializer for shared measurement/transport use.
- src/main/promptMeasurement.js — provider-serialized cloud measurer with known-capacity requirement.
- src/main/ipcHandlers.js — owning cloud Workspace integration through existing authenticated adapters.
- src/lib/memoryChat.mjs — verify a committed Workspace payload immediately before dispatch.

New test: tests/workspaceAdvancedCompaction.test.cjs. New deliverables: this report and its evidence JSON. Other dirty paths in git status predate W4. Evidence includes hashes for W4 production and test files.

## 4. Concurrent operation state model

The barrier binds the owning AbortController/run ID, session/branch/message snapshot, consumed step IDs, protected recent complete rounds, task briefs/plan/current checkpoint, steering rows, background rows, child lifecycle identities, parent permission revision and caller-provided runtime/schema configuration identity. Pending owner approvals/questions, tool-limit prompts and paused loops cannot qualify as safe boundaries.

Command starting/running, completed-undelivered/queued/included, delivered, cancelled and failed remain distinct existing lifecycle states. References contain stable IDs, status, owner and evidence-store identity, with authority explicitly `none`. They cannot recreate a U7 grant. Terminal delivered records need no active-operation reference. Foreign, missing, malformed or non-durable active operations defer while the original request fits, otherwise fail explicitly.

## 5. Parent/subagent coordination

Only detached executions with a completed parent tool step, stable child/execution IDs, matching parent ownership, an independently running background attempt and a persisted subagent_runs identity qualify. Foreground delegation with an unresolved parent call remains blocked. Detached startup now attempts persistence through the existing child persistence module; failure does not invent resumability and leaves compaction closed for that child.

Parent compaction never rewrites child context, changes cancellation ownership or restores child permissions. Child lifecycle transitions are part of the source snapshot. A settlement during generation rejects the candidate. Existing backgroundStore settlement remains the exactly-once consumer; no delivery queue or new child scheduler was introduced.

The full parent-loop child fixture delegates once, completes parent reads, compacts three times while the child remains active, then observes the child result once. A duplicate settlement returns false. The fixture uses synthetic child lifecycle/execution records; it is not real concurrent child-model inference.

## 6. Background-command coordination

Eligible references must match the persisted record, original parent run/session/workspace and the live background registry. Inspection uses the existing backgroundCommands.status ownership check, so a cited command ID cannot adopt another process or a closed owner. Existing revocation, timeouts, cancellation and output storage remain unchanged.

The full parent-loop background fixture launches its synthetic operation once, performs parent work, compacts three times and retrieves the original handle's final result. A separate fixture verifies queued completion is consumed/acknowledged once. Completion during generation prevents commit. No process is stopped to enable compaction. New scenarios use deferred synthetic operations; existing background suites supply the broader process-lifecycle regression coverage.

## 7. Protected protocol-tail handling

W3 still retains the two recent complete tool rounds and all following live messages; earlier non-tool steering is retained verbatim. A current assistant persistence row stays active while consumed tool IDs identify already represented steps. No unresolved call/result pair can cross the archival boundary.

The protocol validator runs on prospective and rebuilt requests. It accepts complete parallel batches with out-of-order results and rejects missing/duplicate results and reused call IDs. Cloud loop fixtures also validate provider-serialized tool pairs. No fake tool results or prose flattening of tool calls were added.

## 8. Long-horizon generation strategy

When a single W2 source request cannot reserve at least 1,024 output tokens, W2 partitions historical message units with their deterministic evidence into disjoint chronological segments. Full authoritative briefs remain outside model paraphrases and are supplied to each segment. Each intermediate document satisfies W2 structural/source validation against only its segment's source messages/evidence. Final merge receives the validated segment documents, original authoritative briefs, prior checkpoint and complete deterministic evidence; final W2 validation and W3 full prospective fit remain mandatory.

Intermediate documents never become current or inactive checkpoint rows. Final checkpoints retain a digest/ID manifest of reduced sources. The original messages/results remain in SQLite. Bounds are 12 stages including merge, one corrective retry per stage, at most 32,768 reserved generated tokens across calls, 4,096 estimated tokens per intermediate, zero source overlap and a 120-second cooperative cancellation deadline. No recursive summarization exists. Transports must honor AbortSignal; arbitrary non-cooperating injected promises are not forcibly terminated.

An oversized brief, single source unit, complete essential evidence set or merge request fails explicitly instead of trimming requirements. W2's pre-existing bounded prose observations remain marked partial; source/structural validation does not prove every natural-language observation was faithfully summarized.

## 9. Repeated compaction behavior

W3's consumedToolIds mechanism remains the execution index. Previous validated requirements, decisions, completed work, research, file operations, commands and tests are carried forward deterministically and deduplicated, then revalidated against original evidence. Latest next actions/in-progress/blocker prose is regenerated; durable failed-command diagnostics remain retrievable independently. Conflicting or corrected claims retain source chronology and remain unverified; semantic supersession is not inferred as fact.

The three-compaction fixture deliberately omits earlier decisions/tests from later model output. The earlier public-API decision, exact failed-test identity, command and exit code remain present in all three checkpoints. The full long-horizon loop performs 11 compactions in one run, with two intermediate segments per compaction and unique tool IDs throughout. State growth is linear in accumulated evidence, not nested checkpoint recursion. It is not constant-cost: archived originals are reprocessed, and a genuinely growing essential state can eventually exceed capacity.

## 10. Anthropic integration

Workspace IPC now installs the same owning-loop hook for cloud parents. Candidate generation uses createCloudFetch with non-streaming response handling, retaining completion metadata for W2 validation. Measurement calls the shared serializer that constructs Anthropic system blocks, tool_use/tool_result blocks, schemas, reasoning/output mapping and cache fields. No ad-hoc HTTP or credential path was added.

Mocked parent inference, candidate generation, commit and final response all pass. The same run ID survives, seven tool calls execute once and serialized pairs remain valid. This is deterministic adapter evidence, not real Anthropic inference.

## 11. OpenRouter integration

The OpenRouter fixture uses the existing OpenAI-compatible adapter with OpenRouter base-URL/cache behavior. The shared serializer preserves tool-call IDs and portable provider fields. Mocked parent inference, candidate generation and same-run continuation pass with seven unique tool calls and valid serialized pairs. Existing provider/IPC suites cover streaming behavior; the W4 mock transport uses JSON responses for deterministic control.

## 12. Provider budget measurements

Known selected provider/model metadata supplies context capacity. Unknown/non-integer capacity cannot certify a compaction fit. The IPC path reports unsupported compaction for that case and retains the pre-existing provider inference path; it does not reactivate legacy cloud archival or manufacture capacity.

Cloud counts are shared estimates over the actual serialized provider request, never GGUF tokenizer counts. Output reservations include provider defaults/mapped output policy. Native/MCP schemas, system/user content, full checkpoint/brief sections and protected messages enter the full measurement. Provider configuration and capacity changes are checked again before dispatch. Exact cloud tokenization and near-boundary real-provider success remain unverified.

## 13. Workspace idle compaction policy

No fabricated owner/run ID or future request was introduced. Existing explicit W2 preparation can persist inactive candidates at eligible inactive states; no idle candidate is promoted without an actual owning request. Because the existing idle API cannot faithfully reconstruct the next run's complete provider/reasoning/schema/permission configuration, idle activation remains unsupported. Active/historical background records can also make the conservative inactive-preparation gate refuse. The next real request can run the normal 90% compaction path independently.

## 14. Session and configuration transitions

Source snapshot checks include session/branch, briefs, message columns, attachment metadata, steering, background and child lifecycle state. The owner signal/run identity, parent permission revision, runtime/provider identity and prepared tool/profile configuration are revalidated. Checks occur during generation, before prospective construction, in the short activation transaction, after rebuilding, and immediately before dispatch. Dispatch also remeasures the actual request to detect capacity/output-contract changes.

Generic W3 transition tests and W4 completion/dispatch-capacity tests pass. This is not an exhaustive mounted-renderer test of every model/provider/tab transition. H1 deletion remains authoritative and no code creates replacement conversations during failure recovery.

## 15. Tool protocol correctness

Incomplete protocol batches fail rather than manufacturing results. Active independent operations qualify only after their parent handle tool has completed. All prospective/actual canonical payloads remain paired; mocked cloud serialized payloads are also checked. Consumed IDs prevent replay within the same current run. Existing command ownership, child execution identity and delivery systems remain authoritative.

## 16. Failure and cancellation handling

New injection cases cover pending owner approval, child/background completion during generation, intermediate provider/JSON failures, source revision, merge interruption, intermediate cancellation and dispatch-capacity change. Existing W2/W3 cases cover completion truncation, source references, permissions/configuration invalidation, deletion, SQLite activation failure, post-commit rebuild failure and compensation.

No long-lived write transaction spans model generation. Activation remains W3's immediate SQLite transaction. Source changes reject stale candidates. Post-commit failure either safely compensates while the snapshot is still owned or prevents dispatch and exposes recoveryRequired. There is no promise of arbitrary process-kill/power-loss automatic resumption or external-effect replay.

The requested complete failure matrix is not claimed: no hard process termination, every provider-stream interruption shape, or every mounted shutdown/transition was injected.

## 17. Same-run continuation evidence

Five full parent-loop scenarios use the production runMemoryChat loop: background, child, long horizon, Anthropic and OpenRouter. Execution IDs, inference request counts, checkpoint outcomes, tool-call arrays and before/prospective/rebuilt estimates are in the JSON evidence. All tools have unique IDs and execute once. The long-horizon fixture starts with 40 historical messages, executes 32 reads and compacts 11 times, including bounded intermediate generation. The background/child loops each compact three times. Cloud loops each compact twice.

## 18. Full-request token measurements

All table values are estimates. The fixture context is 40,000 tokens, with 1,024 output + 128 safety reservation, 38,848 usable input and a 34,963 trigger. Each row shows the final compaction of its scenario; every round is included in JSON.

| Scenario | Rounds | Before | Prospective / rebuilt | Candidate | Compaction generation requests | Tools |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| full-loop-background | 3 | 38,294 | 18,689 / 18,689 | 1,917 | 3 | 15 |
| full-loop-child | 3 | 38,268 | 18,658 / 18,658 | 1,916 | 3 | 15 |
| full-loop-long-horizon | 11 | 41,295 | 21,695 / 21,695 | 4,951 | 33 | 32 |
| cloud-anthropic | 2 | 38,100 | 15,662 / 15,662 | 1,069 | 2 | 7 |
| cloud-openai | 2 | 38,103 | 15,689 / 15,689 | 1,052 | 2 | 7 |

The evidence separately records protected-tail, schema, original brief, intermediate input/output, final generation input/output and candidate estimates, plus mock final output usage metadata. Components overlap and must not be summed as exact token totals. The under-5K target is preservation-aware; the final long-loop candidate is close to the target and may exceed it as necessary evidence grows.

## 19. Performance and overhead

Evidence includes each compaction's elapsed milliseconds, retry count, generation-stage count and full-request estimates. Scenario records include tool/inference counts and cumulative dispatched/generation input estimates. Candidate output usage `80` is scripted mock metadata, not a measured tokenizer result. No cache savings, throughput, GPU speed or paid-provider latency is reported. Duplicate attempts were not injected into these loops: zero duplicate executions is asserted, not an invented count of duplicates prevented.

Long-history segmentation remeasures bounded requests and validates source snapshots repeatedly; its cost is visible in fixture timings. Original evidence reprocessing adds overhead over successive compactions. No production throughput or latency guarantee is made.

## 20. Focused test results

- Fresh pre-edit focused baseline: 27/31 files passed; four exact failing file identities listed in section 2/evidence.
- W2 direct: 44/44 passing.
- W3 direct: 30/30 passing.
- W4 direct: 20/20 passing.
- Enabled focused regression: 519/519 passing, zero skips/failures; includes child recovery, background lifecycle, cloud adapters, H1, U7, Casual compression and idle projection.
- Provider IPC isolated recheck: 10/10 passing.

The 519-case and broad runs preceded the final use of the existing background status/open-owner check and provider diagnostic labels. Subsequent direct W4/W3 runs cover the owner-check refinement, and the final W4 run covers diagnostic labels. Test timing/source-hash scope is explicit rather than presenting every run as byte-identical.

## 21. Full regression comparison

A safety-filtered full Node regression ran all 228 *.test.cjs/*.test.mjs files except five fixtures that actually execute Git commits/stashes/resets in disposable repositories: gitTools, deleteProjectFile, recoveryBoundary, recoveryIpc and recoveryStore. This exclusion follows the request's absolute prohibition, not a passing-test waiver.

Restricted final: **202 passed / 26 failed files**. Localhost-enabled final: **216 passed / 12 failed files**. These are file-level counts, not mixed TAP assertion totals. Every failing inner identity (or script-level source location), exit code and error summary is in JSON.

Enabled failures: attachments, cloudIpc, engineSettings, filesystemToolLimits, lspCodeIntelligence, mcpIpc, messageActions, messageStats, rag, skillImportIpc, skillProposalIpc and subAgentRunner. An isolated lspCodeIntelligence rerun passed 9/9; its broad-run symbol-index assertion remains recorded as a transient failure rather than erased. Existing fixture-contract failures include missing Electron app.getPath, attachment capability policy, settings defaults, message sibling/deletion expectations and the stream-observer expectation. Restricted execution adds localhost/namespace/server restrictions.

There was no fresh pre-edit full-suite capture. Therefore an exact zero-new-full-failure comparison cannot be certified. Historical W3/U7 reports identify many of the same files but are not used as automatic waivers. The fresh focused file-level baseline retains the same four restricted failing files, with no new focused failing files. The earlier post-edit cloud unknown-capacity failure was corrected and its IPC/provider recheck passes; unsupported capacity now explicitly declines compaction certification.

## 22. Production build

Fresh baseline and final `npm run build` passed. Existing Vite large-chunk warning remains. `git diff --check` passes. No distribution packaging was performed. The last provider-label changes affect main-process diagnostics only; the final W4 run validates them.

## 23. Real-model verification limits

No live model, paid inference, external account operation or real conversation store was used. No exact GGUF/cloud tokenizer, real vision observation quality, arbitrary app-kill recovery or hostile detached-process certification is claimed. New concurrent-loop fixtures use synthetic independent operations; existing lifecycle/security tests supply complementary coverage. Structural/source-bound validation does not prove natural-language semantic completeness.

## 24. Remaining W5/W6 scope

No W5 event/UI redesign, W6 real-model certification, scheduler, close-to-tray or system-tray behavior was implemented. Idle activation still requires a faithful future request contract. Large essential state/merge floors remain explicit failures. Broad regression failures, excluded suites and the missing pre-edit full comparison remain verification limitations. W5/W6 readiness is not certified by this patch.

## 25. Readiness decision

The W4 implementation and deterministic evidence demonstrate eligible concurrent-stream compaction, retained ownership/protocol state, bounded staged generation, repeated same-run compaction and provider-native cloud request integration on known-capacity models. W3's architecture remains intact and Casual compaction policy is unchanged.

**Do not claim full W4 acceptance or release readiness.** Criterion 21 lacks a fresh full identity comparison, five suites were deliberately excluded, broad regression retains failures, and exhaustive transition/crash/semantic guarantees remain unverified. Idle activation is intentionally unavailable under the existing API's configuration limitations; unknown cloud capacity cannot certify fit. Work stops at W4.
