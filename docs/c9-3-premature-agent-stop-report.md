# C9.3 — Failed compaction and premature parent-agent stop

2026-10-29, Asia/Dhaka. The parent loop could end on intermediate narration or a reasoning-only response and classify the run as completed. Scripted reproductions confirm this defect. A focused, bounded continuation and incomplete-outcome repair is implemented. Compaction validators, settings, schemas, thresholds and protected rounds are unchanged. [Structured evidence](c9-3-premature-agent-stop-evidence.json).

## Incident identity and evidence access

The matching session is `421ac69f-be7d-4e41-961d-5a7f6b4020b1` (`rio`), project `b62f8ed9-c325-4858-bdba-58f507f1e389` (`testing new workspace update`). The latest October 29 run is **`8041d529-12c6-4862-9d14-32a4f0ba27e0`**, assistant message **4012**, created `2026-10-29 02:03:00` UTC (08:03 Dhaka), following user message 4011, `continue`. The engineering requirements are in message 3973 and durable brief 619. The stored model path identifies Qwen3.8-27B-GSQ-RCO IQ3_S MTP. The older C9.2 incident, message 3974/run `50a002c9-196b-4ed5-bef9-1c59beddf7d7`, is distinct.

The live database was copied to `/tmp/c93-audit`; there was no source WAL file. SQL inspection used the disposable copy. A retrospective prompt reconstruction opened that copy with `readonly:true`, injected its connection without application initialization, and prohibited network/inference. No live database was initialized, migrated or written. No model inference or tokenizer endpoint was called. No commits, push, stash, reset or clean occurred. Preexisting changes remain; evidence records their status.

## What happened

| Attempt | Persisted identity | Diagnostic | Measured boundary | Result |
|---|---|---|---|---|
| 1 | sequence 46, `fa8d359c-6208-4d14-8b4b-68e22a44b8d4` | `unsupported-finding-claim` | 49,568 | `continued`, no checkpoint |
| 2 | sequence 47, `121dce00-5adc-46a8-a722-32c91bb6f2d6` | `unsupported-completion-claim` | 52,933 | `continued`, no checkpoint |

Attempt 1 ran 02:10:40.699–02:13:48.989 UTC; attempt 2 ran 02:16:40.075–02:18:39.602 UTC. Both store usable input 54,400, trigger 48,960, method `server-template-tokenizer`, `targetMet:false`, `continued:true`. Both show `generationStages:0`; this is a default activity field on rejected generation, **not proof that generation never occurred**. Full metadata, source-version hashes and anchor IDs are in JSON.

There are **zero checkpoint rows and zero session summary rows** for this session. No checkpoint remained active or became active. A reduced subsequent prepared count cannot establish activation.

The persisted codes explain the validation categories: the first did not satisfy source-backed finding validation; the second did not satisfy evidence-backed completion validation. Production validation requires an exact supplied excerpt for cited findings, successful edit evidence for implementation, and suitable executed command evidence for verification/build. However, rejected candidate text, exact citations, correction responses, feedback and stage membership were not persisted. Thus the exact unsupported statements and whether either rejection was a false positive are **unknown**. No source-attribution bug has been established; weakening or changing validation would be speculative.

Safe continuation is intentional. For optional pressure compaction, `workspaceCompaction.js` rejects the candidate, rebuilds the authoritative original prefix and paired live tail, measures fit, checks ownership/session/cancellation/permissions and revalidates immediately before dispatch. A rejected candidate is never activated. Forced overflow still fails closed. The measured boundaries fit within 54,400; continued activity is consistent with that guarded fallback. Existing C9.2 tests exercise the actual rejected-finding validator, identical-boundary generation suppression and fallback checks.

## Requests, requirements and plan

Actual parent provider-reported prompt sizes, in order, are:

`11,578 → 16,682 → 24,652 → 29,840 → 36,886 → 43,328 → 46,360 → 49,642 → 52,933`.

There are nine persisted parent requests. The final request is also the peak, with 2,619 completion tokens. Total parent usage is 311,901 prompt and 16,590 completion tokens. Boundary measurement 49,568 and dispatched usage 49,642 are different observations, not interchangeable counts. The final 52,933 dispatch matches the second boundary measurement. Mapping these to fallback boundaries follows the current pre-dispatch source path; historical wire payloads and dispatch timestamps are not stored.

The user-reported approximately 12.4K **prepared** context afterward is not an additional dispatched provider request. No tenth request is recorded. Its exact original measurement payload is unavailable, so this audit does not claim to reproduce that count. Once a run ends, ordinary reconstructed context can omit the large in-flight tool tail; that is a plausible source explanation for a smaller count, not evidence of checkpoint activation.

Durable brief 619 retains all **10,955 characters** of the original engineering request. Briefs 618 and 625 retain the greeting and `continue`. The durable plan remains revision 1 with eight steps, zero completed, step 1 in progress and seven pending. There are no brief lifecycle supersessions. A read-only retrospective `rebuildChatMessages` includes all three briefs verbatim, `0/8 completed`, and Phase 8. It produces 11 messages and 37,477 content characters (9,370 approximate text tokens, **not** a full-template token measurement). Both normal and fallback source paths insert the authoritative brief and durable plan; scripted rebuilt-request tests retain both.

**No requirements-loss defect is confirmed.** Storage and retrospective reconstruction retain the requirements and plan. Their exact contents in each historical wire request cannot be proven without saved payloads. No context-reconstruction change was made.

## Final response and termination

Message 4012 is persisted as `completed`. It contains 581 characters of visible progress narration, ending:

> Baseline verified: 133 tests pass (127 taskLogic + 6 themeLogic). Let me quickly check the CSS for responsive behavior and the remaining UI styling before finalizing my audit.

This is a historical model statement; stored command output separately supports the baseline test run. It is not proof of the eight-phase task's completion. The visible text accumulates narration across requests; it is not a complete engineering report.

The run has 29 recorded tool operations, including file reads, directory/git inspection, native-tool listing and two commands (environment check and baseline tests). It contains no implementation edit. The last recorded step is `thought_9_37`, with no subsequent tool operation. Its reasoning discusses possible defects and ends at **“28. **ThemeToggle aria-pressed semantics:**”**. The JSON includes the visible output, last reasoning excerpt and last tool identity.

Historical provider finish reason and request `max_tokens` were not saved in `stats.raw`; that field contains usage/timings only. Output truncation is therefore **unverified**. The abrupt final reasoning suggests truncation or another model termination limitation, but neither 2,619 completion tokens nor a successful transport return proves `length`, `stop`, or a specific limit. No missing finish reason has been invented. Future requests now retain finish reason and configured output limit.

The confirmed source path is `readCompletion` → `runMemoryChat`'s no-tool-call branch → drain late background results/steering → return accumulated text. Before this repair there was no unfinished-task check there. A normally resolved call then caused `engine:chat` to persist `completed`, emit `task-outcome:completed`, return a completed message and publish a non-partial digest. WorkspaceTimeline labels a non-streaming, non-interrupted message “Completed.” Consequently the UI accurately reflected the supplied backend status, but that status **incorrectly conflated response termination with task completion**. No tool calls were manufactured or lost to explain the terminal branch; absence of a terminal call is supported by the final recorded thought and reproduced mechanism, not a retained raw provider response.

## Focused repair

- `taskContinuation.mjs` recognizes a narrow premature-stop signal: an active plan with pending/in-progress work paired with future-work narration, empty visible output or explicit truncation. A plan alone is insufficient. Questions, blockers, user stop instructions and provider safety/reasoning stops do not trigger task recovery.
- IPC binds recovery to a plan created/changed during the run or an explicit request to resume work. An unrelated new question with an old open plan does not authorize recovery. Any live steering disables recovery against the old task scope. Cancellation is checked again after asynchronous state reads; deleted sessions fail closed; changed permission revision prevents recovery.
- Recovery adds **at most two requests per run**, never replenished by tool execution. It appends the accepted response and a runtime continuation instruction to the existing history. Existing request measurement, compaction, tool advertisements, permission checks and cancellation paths run again normally. Completed commands/edits are not replayed; no synthetic tool call or completion claim is generated.
- Repeated narration, empty output, truncation or mere acknowledgments after recovery yields an explicit incomplete notice and structured reason. Permission changes identify that reason. Safety stops and reasoning-loop stops do not recover and also report incomplete. The existing persisted/renderer status `interrupted` is used, with `incompleteTask` on the outcome/result; digests are partial and success notifications are suppressed. No schema migration is needed.
- Valid final reports and legitimate short answers remain valid no-tool responses, including with a stale open plan. This heuristic does not certify their semantic truth or prove all work finished. It fixes the demonstrated intermediate/empty-response path, not general natural-language completion verification.
- `readCompletion` exposes both streaming and JSON finish reasons. Per-request raw stats retain `finishReason` and `maxTokens` for future audits. The existing raw-stats test now asserts these fields.

No model configuration, native schema, compaction threshold, protected-round policy or validator changed. No speculative repair was made for unavailable rejected quotes or historical payloads.

## Validation and limits

The evidence JSON maps all 15 requested coverage areas to focused tests. `c93PrematureStop` uses a long eight-step task, scripted responses and a rejected-compaction fallback protocol; `workspaceSafeCompaction` separately exercises real candidate validation and measured safe fallback, identical rejection suppression, retained briefs/plan/checkpoint/history, overflow, cancellation, deletion and permission changes. The combined loop fixture does not pretend to recreate Qwen's missing candidate prose. P2 activation, C9.1 semantic summaries and synthetic 4,999 acceptance / 5,000 correction-or-rejection boundaries retain their production tests.

A disposable before-source copy preserves preexisting C9/P2 work and restores only the initially clean parent-loop/IPC files. New tests fail against that source and pass with the repair. Existing focused tests pass before and after. The exact per-file results and failure names are in JSON. An initial baseline-copy harness failure was a missing `src/preload.js`; copying the unchanged preload fixed it. An intermediate current-source failure was the expected raw-stats shape change; its assertion was updated to require the new finish metadata. Neither was hidden as an unrelated product regression.

Final focused selection: **299/299 assertions across 14 files**. Before source: **289 pass, 10 fail**, with all ten failures confined to the new C9.3 tests (nine loop assertions and one IPC test). Production build and `git diff --check` pass; per-file results are in the evidence. The build retains its existing chunk-size advisory. No real Qwen inference, live restart, deployment or historical run resumption occurred.

Remaining unverified: exact rejected claims and attribution, exact historical wire requirements/plan visibility, original output finish reason/limit and truncation cause, the approximately 12.4K prepared measurement, natural-language completion truth beyond the bounded heuristic, and behavior against real Qwen after repair. These require new authorized evidence capture; this investigation stops after the focused repair and validation.
