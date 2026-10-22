# Context and compaction audit — 22 October 2026

## Verdict and scope

The screenshot is explained by a real capacity mismatch, followed by a failed recovery attempt. It does not establish that one image consumed a 70,000-token context. The application exposes different notions of context to the header, idle compactor, request guard, and inspection panel. The earlier change to count attachments and remove Workspace's ten-message retention rule addressed only part of the problem and introduced an unsafe idle-retention case.

**Recommendation:** keep the durable history, task briefs, checkpoint evidence validation, atomic commits, and bounded request retry. Redesign the budget/measurement and compaction transaction around one effective request budget and a protected live run. Do not continue adjusting message counts or image allowances independently.

This audit made **no production source changes, setting changes, model reloads, or edits to the user's chats**. It inspected the current working tree, matching packaged backend, the screenshot session through a read-only database connection, existing application logs, and the running server's GET /props response. Reproductions used mocks or disposable databases. No live inference was requested. Source hashes captured at the start and checked at the end show no changes during the audit.

The accompanying [evidence JSON](context-compaction-audit-2026-10-22.evidence.json) records measurements, per-file test results, source hashes, and reproduction outcomes. It excludes conversation bodies, image bytes, provider credentials, and generated checkpoint text.

## 1. What happened in the screenshot

| Quantity | Confirmed value | Meaning |
|---|---:|---|
| Model launch context setting | 70,000 | Total configured context; model settings describe it as shared across concurrent predictions |
| Parallel predictions | 2 | Confirmed in saved configuration, running process arguments, and server properties |
| Server-reported per-slot context | 35,072 | GET /props, default_generation_settings.n_ctx |
| Default output reservation | 1,024 | Request has no explicit positive output cap |
| Safety reservation | 128 | Current guard policy |
| Usable input budget | **33,920** | 35,072 − 1,024 − 128 |
| Rejected input estimate | **35,878** | The screenshot and application log agree |
| Estimated excess over input budget | **1,958** | A modest overage, not proof that the image consumed 70k |
| Header denominator | 70,000 | Configured total instead of usable per-request capacity |
| Idle trigger with that denominator | **52,500** | 75% of 70,000; already beyond this request's capacity |
| Attached images in the saved session | **1** | Confirmed from message_attachments |
| Successful Workspace checkpoints | **0** | No checkpoint or rolling summary persisted for this session |

The model server is actually launched with context 70,000 and two parallel predictions. Its reported slot context is 35,072; the server's reported value, rather than a hand-calculated division, is authoritative. This exactly explains the otherwise surprising 33,920 budget.

The error is raised in the application's preflight guard. Its “approximate-full-request” label means this is an estimate-based rejection, not a server measurement of 35,878 actual image/text tokens. An image makes the current measurer bypass exact template/tokenizer measurement for the entire request.

The saved state reproduces the panel's **7,073** estimate and **1,530** work-log contribution. Rebuilding the prepared prompt read-only produces approximately **36,015** tokens, consistent with the header's 36.0k. Removing just its image part for a diagnostic comparison produces **31,899**. The difference is about **4,116**, principally the fixed 4,096 allowance plus serialization. This comparison does not measure the model's actual image-token count. The rebuilt prepared prompt and the rejected wire request differ slightly because they are different representations; the header builder and wire sanitizer are not identical.

The previous successful turn reported **29,806 actual prompt tokens**, matching the screenshot. That is a previous server request, whereas 36.0k is an estimate of a subsequently prepared request. Neither value is the sum of cumulative prompt work across tool calls.

The checkpoint status is a separate failure: summary/checkpoint recovery did not complete, so the guard could not obtain a usable rebuilt request. The exact discarded checkpoint response is not retained. Consequently, this audit cannot honestly say whether that specific checkpoint failed due to truncation, malformed JSON, a server/transport error, or another exception.

Sources: [engine launch arguments](../src/main/engineManager.js), [runtime capability probing](../src/main/modelCapabilities.js), [request budget and measurement](../src/main/contextBudget.js), [header state](../src/components/MemoryPalace.jsx), [error log and runtime measurements in evidence](context-compaction-audit-2026-10-22.evidence.json).

## 2. System map

| Layer | Current behavior | Main limitation |
|---|---|---|
| Persistence | Full messages, variants, attachments, tool execution steps, briefs, plans, digests, and checkpoints remain in SQLite/on disk | Stored message token estimate covers content text, not the full request |
| Prompt building | Base and session instructions, project context, memories, briefs, checkpoint, rolling summary, active messages, work log, plan; retrieval and live tools enter later | Fixed overhead and later additions differ between projections |
| Header measurement | Rebuilds a prepared prompt; tokenizer measurement for supported text-only requests; otherwise full-request fallback | Displays configured window, ignores returned input budget, and can reuse stale cached limits |
| Idle parent compaction | Renderer schedules a 10-second debounce; checks 75% pressure; targets roughly 38% Workspace / 48% casual after estimator margin | Uses configured total, not runtime slot budget; can operate during a live run |
| Forced parent recovery | Guard calls main IPC recovery; archives eligible historical prefix after summary and validated Workspace checkpoint | Cannot shrink the current run's preserved live tail; failure reason often lost |
| Local request guard | Checks final wire payload, probes slot context, reserves output, allows one recovery and at most one inference retry | Images force an uncalibrated estimate that can reject a request before the server sees it |
| Parent generation callbacks | Local non-streaming summary up to 512 output tokens and checkpoint up to 2,048 | No completion-status checks, structured JSON enforcement, or explicit reasoning controls |
| Child compaction | Transcript adapter preserves complete tool pairs, keeps two recent complete rounds, validates fit before commit, carries prior state | Separate policy from parent; initial engine descriptors can inherit configured rather than runtime capacity |
| Cloud main chat | Header estimate exists | Parent idle compaction is explicitly skipped; parent overflow recovery is disabled |
| Cloud child chat | Adapter supports bounded pressure compaction and provider overflow recovery | Does not imply equivalent protection for the parent cloud conversation |
| Inspection UI | Shows text estimate, last-turn telemetry, checkpoint/brief/history inspection, last observed attempt | Several figures have different meanings; attempt state is transient and lacks root-cause detail |

Task-state checkpoints and filesystem recovery checkpoints are different systems. The startup memory failure fixed earlier concerned filesystem recovery history; this audit concerns prompt context and task-state compaction.

## 3. Findings

Priority P1 means a chat can be blocked, or active task state can disappear from the model-facing prompt. P2 means reliability, diagnosis, performance, or policy is materially weaker than the UI implies. “Reproduced” below means an executed check against current production functions, using mocks or temporary data where appropriate.

### F01 — P1: capacity has multiple sources of truth

**Confirmed in the incident.** The header and idle scheduling use activeModelConfig.contextLength. The guard independently clamps against /props n_ctx. Runtime capability probing already obtains the smaller context but does not make it the shared budget for these consumers. The local child engine descriptor also begins with activeModelConfig.contextLength.

With this configuration, idle compaction waits for 52,500 while ordinary requests have only 33,920 input tokens available. The header makes the request look roughly half full when it is already beyond the guard's permitted input budget. Output reserve and explicit reasoning/output caps can create further divergence even with one prediction slot.

Evidence: src/components/MemoryPalace.jsx:44,198; src/main/compressionEngine.js:383–390; src/main/contextBudget.js:24–31,85–86,125; main.js:383–387; src/main/subagents/modelSelection.js:62. The mock reproduction and live server properties agree exactly on the incident budget.

### F02 — P1: one image changes accounting for the entire request

**Confirmed in code and incident state.** Text-only requests can use server template/tokenizer measurement. Any image_url part bypasses that path. The fallback uses serialized UTF-8 bytes divided by three, role/envelope allowance, and 4,096 tokens per image. It does not inspect image dimensions, detail policy, projector behavior, model patching, or actual resized pixel-token cost.

The frontend correctly resizes uploaded images to at most 1024×1024 and JPEG quality 0.8. That controls image bytes/dimensions, but the fallback does not use those dimensions. It also changes text/schema accounting for the entire request. A single attachment can therefore move a request from a measured count to a substantially different estimate.

This is conservative policy, not a model-specific token count. The guard treats the estimate as a hard preflight limit, so false refusals are possible; this audit did not send the rejected request to establish whether the backend itself would accept it.

Evidence: src/main/contextBudget.js:33–42,90–96,161–164; src/utils/imageUtils.mjs:1; session-accounting and parallel-window results in evidence.

### F03 — P1: parent summarization/checkpoint generation is not a reliable protocol

**Real empty-summary failures observed in logs; additional cases reproduced.** The production callbacks read only choices[0].message.content. They do not inspect finish_reason, distinguish reasoning-only output from a finished answer, reject tool-bearing/incomplete output, or enforce a checkpoint JSON schema/grammar. Checkpoint handling strips an optional Markdown fence and calls JSON.parse. Neither callback supplies explicit reasoning controls or a deterministic temperature.

The 512-token summary and 2,048-token checkpoint limits cover generated tokens, not a guaranteed amount of completed visible content. With a reasoning-capable model, an empty visible content field or incomplete JSON is a credible failure mode. It is not proven to be the exact cause of the screenshot's discarded checkpoint response.

Executed checks using the literal current callbacks showed:

- A reasoning-only response ending with finish_reason=length returns an empty summary; the core subsequently rejects it.
- A non-empty partial summary with finish_reason=length is accepted as a valid summary.
- Truncated checkpoint JSON throws SyntaxError.
- Both requests omit explicit reasoning/structured-output controls.

The child generator already rejects finish_reason=length, tool calls, and incomplete tool markup, illustrating policy drift inside the same app.

Evidence: main.js:752–819; src/main/compactionCore.js:22–40; src/main/subagents/contextRecovery.js:181–192; adversarial callback results.

### F04 — P1: the earlier Workspace retention change can archive live output

**Reproduced; regression in the earlier fix.** Workspace candidates now include all messages except explicitly excluded IDs. Forced recovery supplies those exclusions. The idle scheduler supplies none and the candidate selection does not independently exclude status=in_progress.

The renderer schedules idle compaction while streaming. A quiet interval can let it run before the assistant finishes. The evidence fingerprint prevents a changed snapshot from committing during generation, but it does not prevent a stable in-progress row from being archived, then updated later.

A temporary-database check used the actual createMessagePersistence and checkAndCompressContext functions. Idle compaction succeeded and archived an in-progress row. A subsequent completed update left the row archived. Its new final fact was absent from getActiveMessages. The full record remained stored, but the model-facing prompt lost the update that was never included in the earlier summary/checkpoint.

This means “keep no fixed ten-message tail” needs a live-run safety boundary, not simply zero protected rows.

Evidence: src/components/main-app/ChatInterface.jsx:1133–1137; src/main/compressionEngine.js:372–379,778–782; src/main/engineManager.js:443–484; idle-live-row reproduction results.

### F05 — P1: separate projections can commit a result that still cannot resume

**Confirmed structurally; estimator differences measured.** The request fallback uses UTF-8 bytes/3 plus envelope allowances. Selection/floor/target projections use characters/4 plus image allowances. The read-only session's full prepared estimate was 36,015, while the idle projection of its components was 25,443.

Idle projection disables delegation in its system-prompt builder. It projects the current checkpoint before the new one is generated, and does not recompute the returned target figure against the generated checkpoint. Its bounded extension can finish over target and still commit with a reason flag. The main UI treats compressed=true as success without explaining that flag.

Forced prospective validation omits some eventual rebuilt sections, including the work log/plan and reinserted retrieval/live tail. It only blocks on a returned exact server-template-tokenizer overage; an approximate overage does not veto the commit. The final request guard can therefore still reject after summary/checkpoint/archival have committed. Raw history remains stored, but a committed compression is not proof that the next request will fit.

Evidence: src/main/compressionEngine.js:73–78,155–207,216–241,490–516,566–620,732–740; src/lib/memoryChat.mjs:677–704; measured session-accounting results.

### F06 — P1: prepared-context cache can preserve an obsolete runtime limit

**Reproduced.** The prepared-context cache key contains session, model, and port/model path. Its payload hash excludes engine capacity and server identity. A hit returns before probing runtime properties. The exported invalidation function has no production callers found in src.

An executed check measured a 35,072 context, then changed the supplied engine capacity and fake server to 16,384 with the same session/model/port/payload. The second result still reported 35,072 and performed no second /props query. Engine restart notifications can request a remeasurement and still receive that stale entry.

Separately, frontend measurements only carry a session/model generation guard, not an ordering number for overlapping measurements within that generation. A slower older request can replace a newer result. The header's “fresh” check compares session/model only.

Evidence: src/main/promptMeasurement.js:108–112; src/components/MemoryPalace.jsx:58–72,242; cache reproduction results.

### F07 — P1: checkpoint requirement limits contradict preservation guarantees

**Reproduced.** The validator re-adds missing applicable briefs with their full text, then caps outstandingRequirements at 50 using the generic array-trimming loop. With 51 short briefs it returned ok=true, retained 50, and omitted brief 51.

This does not erase the original brief from storage or from the separate authoritative brief section. It does break the checkpoint's claimed complete coverage and can omit the newest requirement from its status representation.

The same representation repeats every brief's full text inside an 8,000-character checkpoint. Five instructions of 1,700 characters each caused an otherwise minimal checkpoint to fail the cap at 8,910 characters. More summarization cannot shrink those verbatim required strings. The field is named BYTE_CAP, but enforcement uses JavaScript string length rather than UTF-8 bytes.

Evidence: src/main/taskCheckpoints.js:33–49,398–439,668–695; adversarial requirement-count and size-floor results.

### F08 — P1: prompt continuity is not guaranteed by the task brief alone

**Confirmed dataflow; model-quality risk.** Briefs preserve instructions and attachment references, not all observations, decisions, or completed outcomes. Parent summary transport maps only role/content; it does not include persisted execution_steps. The checkpoint has a separate evidence path capped at 12,000 characters, per-message prose capped at 400 characters, and bounded fields. A test-only unique fact in a successful file-read result did not appear in the summary input.

The prior checkpoint is supplied to the next parent checkpoint model as a bounded textual rendering. Parent generation does not enforce preservation of prior decisions/completed work. The child path explicitly passes retainPrior and validates bounded preservation; the parent does not.

For images, earlier details survive only if the vision-aware summary actually records them or prior assistant prose already captures them. Attachment paths remain available, but a path is not the pixels or a reliable record of the model's earlier observations. Archiving everything increases dependence on this imperfect synthesis.

Evidence: src/main/compactionCore.js:8–18,70–119; src/main/taskCheckpoints.js:237–332; src/main/compressionEngine.js:572–580; summary-evidence reproduction. No claim is made that all tool output should be retained verbatim.

### F09 — P1: main-agent recovery cannot compact an indefinitely growing current run

**Confirmed design limitation.** Parent recovery rebuilds the stored historical prefix and preserves history.slice(prefixLength), including the current run's tool pairs and continuations. It avoids replaying tool execution, which is correct, but it does not summarize that live tail. A long autonomous/tool-heavy run can reach an irreducible current-run floor even when old messages are fully compacted.

The child adapter can compact completed rounds within its own run while preserving pair integrity and a recent tail. The parent needs an equivalent run-aware representation if long uninterrupted Workspace work is a goal.

Evidence: src/lib/memoryChat.mjs:677–687; src/main/ipcHandlers.js:749–767; src/main/subagents/contextRecovery.js:204–217,253–271.

### F10 — P1: parent cloud chat has no equivalent recovery path

**Confirmed.** useMemoryPalace.schedule returns immediately for isCloud. The engine handler only installs recoverContext for !cloud. The parent's summary/checkpoint callbacks address the local server. Cloud child adapter support does not cover the main cloud session.

This is not the cause of the local-model screenshot. It is an important scope gap for any claim that Workspace compaction works generally across app providers.

Evidence: src/components/MemoryPalace.jsx:198; src/main/ipcHandlers.js:743; main.js:752–819; src/main/subagents/contextRecovery.js:169–192,274–303.

### F11 — P2: failures are not durable, specific, or actionable enough

**Confirmed in the incident and code.** Checkpoint exceptions are converted to checkpoint-generation-failed without the underlying exception. Validation becomes checkpoint-invalid without returned validation details. The guard then reports a generic context limit error when recovery returns null.

The Context panel keeps only its last observed event in React state; refresh reads do not reconstruct a durable attempt history. Remounts can forget failures. The UI does not distinguish transport failure, empty visible output, output truncation, JSON parsing, evidence/schema validation, non-reducible required state, disabled compaction, or a successfully committed result still above target. Main generation callbacks do not separately log their request usage into the ordinary turn telemetry.

The screenshot's “reduce attachments or start a fresh session” message is therefore not a diagnosis that the one image or session is inherently too large. Its recovery pipeline failed, and the actual cause has been discarded.

Evidence: src/main/compressionEngine.js:582–586; src/main/compactionCore.js:112–113; src/main/ipcHandlers.js:790–801; src/components/ContextPanel.jsx:517,605,618–626,786; main.js:752–819.

### F12 — P2: idle work has incomplete cancellation and engine-identity handling

**Confirmed wiring gap; race consequences need broader live testing.** The idle scheduler accepts an external abort signal, but production scheduling supplies none. It does not forward arbitrary supplied options such as tools/output caps into checkAndCompressContext. Queued/running compaction is not integrated with the main run's active-state boundary. Local generation deliberately has no response deadline, so a hung idle generation can leave the session's compression lock held until the request settles or the app restarts.

Idle callbacks address the mutable global server port/model process. Unlike forced recovery's post-check, idle commit does not validate a stable backend identity. Switching/unloading a model during idle work is not an explicitly managed compaction lifecycle. Repeated new schedules can reattempt a failed state without durable attempt counters/backoff; the timer itself automatically retries temporary database-lock failures, not every model failure.

Evidence: src/main/compressionEngine.js:754–802; src/main/ipcHandlers.js:1294–1312; main.js:752–819; src/main/localEngineFetch.js:5–7. Restart lock clearing works and is discussed below.

### F13 — P2: fixed prompt overhead is large and is not exposed as a budget breakdown

**Measured.** With no external MCP tools supplied to the read-only rebuild, this Workspace exposes 48 native tool schemas totaling 37,540 serialized characters: approximately 12,528 fallback tokens. The base/session instruction sections total roughly 20,425 characters before brief/history/work-log additions. These are substantial fixed costs in a 35,072-slot model.

The Context panel's 7,073 figure excludes most of those fixed costs and the image allowance. It is a content-text/memory/work-log estimate, not an alternative accurate count of the 36k prepared prompt. The label “Current estimate” does not explain that scope. Project context can also contain full context-file contents and an uncapped directory listing by entry count; small message counts do not guarantee a small prompt.

This is not evidence of cross-tab prompt mixing or an image duplication bug. The confirmed incident image count is one. Reducing fixed overhead may be useful, but should follow a measured breakdown and the user's feature requirements.

Evidence: src/main/sessionManager.js:66,199–239; src/main/promptBuilder.js:148–218,449 onward; src/components/ContextPanel.jsx:647–674; session-accounting evidence. Per-component estimates are diagnostic and are not additive exact tokenizer counts.

## 4. Safeguards that are working

- **Recoverability:** originals, execution steps, image files, and historical checkpoints are retained. Active-context archival is not deletion. Failed checkpoint generation/validation ordinarily leaves summary and archival unchanged.
- **Atomic parent commit:** summary, archive flags, and validated Workspace checkpoint are committed together, with summary/brief/evidence consistency checks and guarded archival predicates.
- **Restart recovery:** startup clears stranded is_compressing flags and marks in-progress messages interrupted.
- **Bounded guard:** final local requests are checked, unrelated HTTP errors are distinguished, and one recovery/retry allowance prevents an unbounded overflow loop.
- **No tool replay during recovery:** the current tool transcript is retained rather than rerunning filesystem commands.
- **Evidence validation:** successful-command/file claims need recorded execution evidence. Unsupported model-invented metadata is stripped/demoted. This is useful even though it cannot guarantee summary completeness.
- **Child continuity:** complete tool pairs, raw transcript persistence, budget accounting, prior-checkpoint retention, and long-horizon compaction have dedicated passing tests.
- **Usage telemetry:** peak/last-request input is separated from cumulative prompt work and cache usage. Cached tokens still occupy context; subtracting cache reads from context pressure would be incorrect.

These properties should survive the redesign. The earlier filesystem recovery startup fix should also remain independent of task-state compaction changes.

## 5. Verification and limits of the test evidence

### Existing suites executed

**32 Node test files:** 31 passed, one failed. They produced **290 passing TAP tests**, plus **four passing script-style checks** without TAP counts. Coverage includes the local guard, measurement, parent compaction/lifecycle, briefs/checkpoints, inspection, telemetry, steering, variants, plans, retrieval, reasoning, child budgets, and long-horizon child compaction.

The failing attachments.test.cjs fixture submits PNGs without a verified runtime image capability and is rejected by the current attachment policy before its intended upload assertions. It is an existing audit-run failure, not explained away as a passing image test and not changed here.

**Three isolated Electron UI fixtures:** compressionDispatch.ui.cjs and cloudContext.ui.cjs passed. contextPanel.ui.cjs failed its “no token-savings claims” assertion. That assertion searches all text before “Archived messages,” which now includes the legitimate “Token usage” heading. It does not isolate the compression-status card. This is a test-scoping defect; the audit did not edit the test to make the run green.

### Additional checks executed

1. Read-only live server inspection: two slots, 35,072 context each.
2. Read-only reconstruction of the screenshot session: exactly one attached image, 7,073 text estimate, 1,530 work-log estimate, 33 stored messages, no persisted task checkpoint or rolling summary.
3. Budget mock reproducing 33,920 usable input from a configured 70,000 total.
4. Literal production callback checks for reasoning-only content, accepted truncated summaries, and truncated checkpoint JSON.
5. Validator checks demonstrating 51→50 requirement truncation with ok=true, and an irreducible verbatim-brief size floor.
6. Prepared-context cache check demonstrating a stale limit after capacity changes.
7. Temporary-database check demonstrating idle archival of an in-progress assistant and disappearance of a later final fact from the active prompt.
8. Packaged-source comparison: all seven checked compaction/backend files match the working tree; this is not explained by an old packaged copy of those files.
9. Baseline source-hash verification: no production files changed during the audit.

Passing mocks establish storage/control-flow invariants, not the loaded model's ability to generate complete checkpoints within a fixed cap. Many existing tests return short, valid summary strings and minimal valid checkpoint objects directly, bypassing the production generation callbacks. They therefore miss the very failure visible in real logs. The new adversarial checks explain why many green tests coexist with this incident.

No live summary/checkpoint quality benchmark, exact vision-token measurement, paid provider request, or long autonomous run was performed. The exact failed checkpoint response cannot be reconstructed from the retained evidence. A complete rollout validation would need disposable live-model sessions after a design is approved.

## 6. Recommended decision and implementation order

### Budget contract

Adopt a single per-request budget object: configured total, runtime per-slot limit, output/reasoning reservation, safety margin, usable input, measured/estimated input, confidence/method, model/backend identity, and a component breakdown. Use it for the header, idle trigger, guard, parent/child policies, and diagnostics. Capacity must be refreshed when slot count, model process, template, or output policy changes.

The header should make the usable request capacity visible. It can retain configured total as an advanced detail. An estimate should not look like an exact tokenizer count, and a historical provider usage figure should not be presented as the current prepared prompt.

### Safe Workspace retention

Retain completed work by budget and relevance, not a fixed ten-message count. Protect the active assistant row, pending tool pairs, current run state, and undelivered steering/completions independently of age or token count. Compact completed rounds of the current run only through an adapter that preserves pairing, ownership, and exactly-once tool execution. Do not let an idle timer archive a parked live row.

The task brief remains authoritative for intent, but does not replace observations and execution state. Preserve those through bounded, explicit state records with references to retrievable originals.

### Reliable generation and checkpoint representation

Give compaction requests their own resolved model/output policy. Validate finish reason, visible content, tool absence, JSON structure, and evidence before committing. Use supported structured output when available and a bounded repair/fallback policy otherwise. Handle reasoning-capable models explicitly rather than assuming a 512-token cap guarantees a visible summary. Never accept a known-truncated summary silently.

Replace repeated full-brief text in the checkpoint with validated brief references/status where feasible, while preserving the full authoritative brief records elsewhere. A cap must never report successful full coverage after silently dropping the newest requirement. Prior decisions/outcomes need explicit bounded continuity rules, including a retrievable overflow representation.

### One transaction against the actual resumed prompt

Build the candidate summary/state, rebuild the actual resumed wire request including applicable instructions, tools, checkpoint, work log, plan, retrieval, and protected live tail, then validate useful reduction and fit before commit. Recheck snapshot/backend identity at commit. Report clearly when irreducible instructions/tools consume the available budget.

Use the same estimator when exact measurement is unavailable. Do not silently treat an approximate successful compaction as proof of exact fit. Decide explicitly whether uncertain near-boundary multimodal requests should be sent for authoritative backend validation or rejected conservatively; show that policy rather than hiding it behind a generic attachment error.

### Durable diagnosis and provider parity

Record stage, trigger, before/after budget, candidate IDs/count, model/backend identity, completion status, validation errors, retry count, and outcome for each attempt, with bounded retention and no raw private reasoning. Expose a specific reason and next action. Persist attempt summaries so panel refresh/restart does not erase the explanation. Define the same capability contract for cloud parent sessions rather than implying they inherit child support.

### Acceptance gate before shipping

1. One and two prediction slots, including runtime rounding, use the same limit in header/trigger/guard.
2. Text-only, one image, many images, image tool results, and changing attachment dimensions have explicit measurement confidence and stable capacity accounting.
3. Reasoning-only, truncated, malformed, and schema-invalid compaction replies either recover within bounded policy or leave durable state unchanged with a precise reason.
4. Slow live tools and idle gaps never archive in-progress output; later final facts survive the next prompt.
5. Repeated compactions preserve newly added requirements, earlier decisions, relevant image observations, and references to original evidence; include more than 50 briefs and long instructions.
6. The final resumed request fits after checkpoint growth, tools/retrieval changes, a model reload on the same port, and an edit/branch/variant change.
7. Long parent Workspace runs compact completed live rounds without replaying commands; child guarantees remain intact.
8. Cloud parent behavior is tested or explicitly presented as unsupported.

Changing parallel predictions to one would increase the budget available to one request in this setup, but it is a configuration tradeoff, not a complete compaction fix. Lowering a threshold or changing the image allowance alone leaves the generation, live-retention, projection, cache, and observability failures above unresolved. No such configuration change was made during this audit.
