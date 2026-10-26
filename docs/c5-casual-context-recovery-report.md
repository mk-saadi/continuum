# C5 — Casual Chat Context Overflow Recovery

Date: 2026-10-26. Local Casual Chat only. Deterministic providers and temporary databases; live Qwen success is not claimed.

## Outcome and proven root cause

Casual Chat now reduces long historical input through bounded, measured summary stages and verifies the **actual prospective chat request before activating** summary/archive changes. The original user request is dispatched once after successful recovery. Protected recent rows, raw history, conversation identity, permission rules and Workspace W2–W7 remain intact.

The original problem was not simply “compression was never attempted.” `memoryChat` already attached a recovery hook to `createContextGuardedFetch`. An over-budget local request invoked `engine:chat`'s recovery callback before inference. Forced compression then selected **all eligible older rows**, expanded attachments, and submitted them plus the old summary to a single nested summarization fetch. That fetch had `max_tokens: 512`, no input partitioning, and no nested recovery. Its own context guard could reject it before any summary generation. The new question consequently failed despite reducible old history.

The W7 investigation reproduced the supplied error signature with 55,676 controlled summary-input tokens and a 34,432 input budget. C5 additionally compares the old single-summary wire shape with the corrected pipeline using the same larger restored fixture: the old shape measures **101,299 tokens against 34,432**, whereas four corrected summary stages measure **30,610, 30,685, 30,686 and 10,524**, each below **33,920**. The final serialized chat measures **2,236** against **33,920** and dispatches once. All figures in this comparison use a deterministic tokenizer endpoint, not Qwen's tokenizer or measured inference throughput.

The original live envelope was not supplied, so the exact original failing request cannot be recovered retrospectively. Its budget strongly identifies the old 512-token summary path; an ordinary chat explicitly capped at 512 could produce the same budget. The source defect and deterministic reproduction are proven independently of that attribution limit.

## Lifecycle trace

- **Restoration and history:** saved conversations rebuild through `sessionManager` and `promptBuilder`, combining the existing summary, active branch/history, system/memory context and provider-compatible message content. The renderer's prepared-context measurement is a projection, not a successful compression certificate. Merely restoring a session does not await idle compression before enabling Send.
- **Idle compression:** renderer message/stream completion changes schedule `session:trigger-compression`, with a main-process 10-second debounce. Pressure is measured against the refreshed runtime budget. In-progress work, disabled compaction, stale measurement, lock contention or a previously attempted identical prompt can defer/suppress idle work. Scheduling acknowledges queued work. An idle failure is not a submission barrier.
- **Submission and measurement:** Send availability depends on chat/model/API/loading/streaming and draft presence. The local fetch guard measures the serialized request against runtime `/props` capacity, invokes one recovery callback before dispatch when needed, and remeasures after recovery. Recognized backend overflow also has one bounded recovery opportunity. No configured-context substitution was added.
- **Protected state:** Casual compression retains the newest ten message **rows**, plus the suffix beginning at an in-progress/excluded row. The newly saved user question is in the retained suffix. These are not ten conversation turn pairs. Workspace checkpoint generation is not used for Casual memory.
- **Recovery and persistence:** recovery waits for an existing compression owner, then uses the existing forced compression path. Required fixed costs and protected content are checked first. Summary stages remain inactive until prospective measurement and source checks pass. Summary updates and archival flags commit in one existing SQLite transaction; no raw message is deleted.
- **Renderer meter:** `MemoryPalace` uses measured prepared input plus estimated draft tokens when available, otherwise a labeled fallback. It refreshes after compressed-state events. It does not treat a stale estimate or configured total context as permission to dispatch.

## Changes

### Measured staged Casual memory

Added `src/main/casualSummary.js`, called by the existing `main.js` summary callback. It deliberately does not create Workspace checkpoints, permissions, execution owners or new database tables.

The output is a strict JSON object with six arrays: `instructions`, `facts`, `preferences`, `decisions`, `openQuestions` and `references`. The prompt requests concise factual memory, a soft 400-visible-token target, source references where relevant, and no invented verification. It explicitly requires an `overflow` refusal instead of dropping essential memory merely to meet the target.

Each summary request reserves 1,024 output tokens and uses `chat_template_kwargs.enable_thinking: false`. The helper requires runtime-reported capacity and the server-template/tokenizer count. It plans disjoint source prefixes using measured requests. An oversized **string** source, including an old summary, is partitioned losslessly with source IDs and offsets; no source substring is silently clipped. An indivisible or uncountable source fails explicitly. Prior memory is carried into each subsequent stage. Token-counting/template probes can inspect an oversized candidate, but inference is only sent for a measured fitting request.

Each helper operation permits at most **16 stages / 16,384 reserved output tokens**. It does not retry the same exhausted summary. Initial idle selection now performs one pass instead of regenerating growing source prefixes; at most two existing selection extensions remain, each summarizing the next disjoint batch plus carried memory. Thus an idle compression can make up to three bounded helper calls. Forced recovery uses one bounded helper operation. Stage reservations are not reported as consumed tokens.

Only complete `stop` responses containing the required JSON schema can become memory. Length exhaustion, missing completion metadata, tool output, interrupted SSE, invalid/empty JSON memory, declared essential-memory overflow, unavailable counting and cancellation fail closed. The local adapter requires the terminal SSE marker. The existing W6 progress-renewed inactivity lease is reused, with no total wall-clock deadline or 120-second cancellation timer.

Bounded, content-free stage diagnostics label `requestKind: casual-summary`, stage, measured input, runtime capacity, usable summary budget, output reservation, finish category, provider-reported completion usage when available, elapsed milliseconds and controlled failure category. They do not print conversation/source text, reasoning text, file contents, raw errors or credentials. Preflight failures also propagate typed errors through the existing IPC completion/error path.

### Exact pre-commit dispatch validation

`memoryChat.mjs` now supplies a `prepareRecovery` callback that materializes the request before activation: rebuilt prefix, retrieved context, live paired transcript, refreshed tools, sampling and reasoning fields. It does not mutate the running history during preparation.

`ipcHandlers.js` measures that materialized request through the existing server-template/tokenizer path. Strict Casual recovery refuses unavailable/approximate counts instead of swallowing measurement errors or treating them as fit. It captures runtime/model/settings/tool-policy identity and revalidates it before commit. The materialized payload is reused after successful activation, avoiding a second independent retrieval/settings rebuild between validation and dispatch. The existing local fetch guard still performs its final measurement before sending.

The compression transaction rechecks cancellation, H1 availability, summary identity, branch/source identity, selected rows and protected tail. The new source identity reads **durable rows directly**, including attachment metadata and branch/model identity; it does not trust the active-history cache for concurrency detection. This is conservative: unrelated concurrent durable message changes can safely abort recovery rather than permit stale activation.

A failed prospective fit has no archival/summary writes. Protected-content failures now identify protected recent messages, current attachments/instructions/tools and provide an actionable reduce-current-input or fresh-chat explanation. Distinct `casual-*` failures survive the outer guard rather than being collapsed into a generic context error.

### Cancellation and old summaries

Forced compression now owns a linked cancellation controller registered with the existing session compression lifecycle. User cancellation and H1 deletion can interrupt every summary stage and measurement; a non-cooperative late completion is checked again before activation. Deletion waits for that owner to settle before durable cleanup. Runtime generation changes or settings changes also refuse activation. No unload/stop behavior was added.

Oversized saved summaries can now be reduced even when no older message rows are eligible, with `archivedCount: 0`. C5 removes the old idle shortcut that dropped a derived summary just to regain the projected target. It preserves or validates a replacement memory instead. Raw historical rows remain searchable/retained throughout. Small summaries may still be reconsidered when forced recovery requires it; work remains bounded.

## Budget reconciliation

There is one authoritative per-request capacity: runtime `/props.default_generation_settings.n_ctx`. The configured 70K may be shared across slots and is not substituted for verified 35,072. No `-c`, `-np`, parallelism or capacity arithmetic changed.

| Purpose | Runtime capacity | Output reserve | Safety | Usable input |
| --- | ---: | ---: | ---: | ---: |
| Original default prepared chat meter | 35,072 | 1,024 | 128 | 33,920 |
| Original Casual summary | 35,072 | 512 | 128 | 34,432 |
| C5 Casual summary | 35,072 | 1,024 | 128 | 33,920 |

The reported discrepancy is exactly the difference in output reservations. C5's summary budget now matches the default chat reserve and is labeled separately in diagnostics. An explicit larger chat output/reasoning budget can intentionally give chat a smaller usable input budget; it is evaluated on its own actual payload. Reasoning is included within generated output reservation, not added as an independent second output allocation.

## Preservation guarantees and limits

- Raw messages, content and variants are never deleted to force fit. Failed generation, counting, source checks or commit roll back/no-op all derived changes. A failed new send can leave its newly saved user question durable, exactly once, which is distinct from corrupting older history.
- Successful activation updates summary and archival flags together. Concurrent history, attachments, branch, model/configuration changes, deletion and cancellation refuse stale activation.
- The original user question and current run's paired tool transcript remain in the request. Existing dispatch tests confirm no repeated completed tool execution, no duplicated steering and refreshed retrieval/settings/tools after recovery.
- No permission behavior, agent tools, Workspace W2–W7 architecture, parallel setting, live database or model process was changed. Existing S1, E1, N1 and W7 work-tree modifications are preserved. No commit, push, stash, reset or clean was performed.
- Natural-language semantic completeness is not mechanically proven. The schema, explicit refusal contract, known-fact fixtures and durable originals provide safeguards, not a claim that every real-model summary is perfect. Real facts must be checked in Qwen validation.
- A transport/backend failure **after** valid activation is not part of the SQLite transaction and cannot atomically roll inference back. Durable raw history remains intact. Runtime checks can conservatively refuse a changing model; no retry of the original successful dispatch is introduced.

## Tests and verification

`tests/c5CasualRecovery.test.cjs`: **18 tests pass**. They cover:

- Below-budget requests, threshold crossing and first send from restored oversized history without relying on idle success.
- Large old history with a short new question, measured staged inputs, exact prospective payload fit, one user question and one original-chat dispatch.
- Multiple successful compactions, prior-memory carry, old-summary/string partition coverage and unchanged raw originals.
- Protected recent overflow before generation, output exhaustion, malformed/incomplete completion contracts and essential-memory refusal.
- Cancellation during an active stage, non-cooperative late completion, deletion during forced recovery and released locks.
- Source mutation during measurement, model/runtime unavailability/change, failed or over-budget exact measurement and unavailable source counting.

Focused regressions cover context guard/measurement, idle selection, actual main IPC overflow recovery, memory/tool dispatch, H1 history deletion, Workspace W2/W3/W4/W5/W6/W7, S1, E1, notification sounds and engine launch. Current results: **352 TAP tests pass, zero assertion failures, one independent H1 fixture cancellation**, plus two passing assertion scripts. Per-suite counts/durations are in the evidence JSON.

The cancellation identity is `H1 real tool approval pending at deletion is invalidated without command execution`, `cancelledByParent / ERR_TEST_FAILURE: Promise resolution is still pending but the event loop has already resolved`. Its first H1 IPC sibling passes. The same one-pass/one-cancellation outcome reproduces in an isolated `/tmp` control with `memoryChat.mjs`, `contextBudget.js`, `compressionEngine.js` and `ipcHandlers.js` restored to HEAD, retaining the other current work-tree files. This is a comparative control, **not an exact captured pre-C5 snapshot**. The fixture waits for an approval event that never arrives; it was not changed or represented as a passing permission test. The new C5 deletion-during-recovery test and all 17 H1 history-deletion tests pass.

Intentional old/new test contract changes:

- Idle cap assertions move from 512 to 1,024; forced callbacks now receive their owned signal.
- “Drop overflowing summary” fixtures become “preserve or validate replacement summary” fixtures.
- Recovery can replace an existing summary without newly archiving rows, so the background/forced ordering fixture now verifies that supported outcome.
- Source/runtime change detection retains the existing `context changed` wording while exposing the more specific C5 failure code.

The W7 Casual investigation fixture is retained as a historical failure reproduction using the old callback shape; it still proves the original defect independently of the now-replaced production callback. No C5-specific new failure remains in the focused suites.

`npm run build` passed in 7.73 seconds, with the existing Vite large-chunk advisory. `node --check` passed for `main.js` and all changed production modules. `git diff --check` passed. Tests use isolated temporary databases/providers; no live conversations or inference sessions were accessed.

## Remaining limitations and real Qwen validation

The ten-row protected policy is unchanged; genuinely oversized protected input still requires reducing current attachments/tools/instructions or continuing in a fresh chat. Uncountable vision sources and unavailable exact template/tokenizer support fail closed during recovery. Extremely long histories or growing essential memory can hit the 16-stage bound; C5 does not silently trim them or expand into a recursive archive redesign. Cloud recovery is unchanged.

Repeat the original conversation with the installed Qwen/llama.cpp build, especially the first send after restoration. Record actual `-c`/`-np`, `/props` capacity/slots, stage counts/input/output usage, finish reasons and elapsed time. Confirm the template honors optional-thinking suppression and returns complete structured JSON. Verify the final original request fits verified per-request capacity and sends once, then verify factual instructions/preferences/open questions/references across multiple cycles. Exercise cancellation, deletion and model change in that runtime. Mocked completion counts (80 per stage, 320 total in the controlled four-stage fixture) and millisecond callback timings are not real inference costs or evidence of live Qwen success.

Stop after C5; no unrelated features implemented.
