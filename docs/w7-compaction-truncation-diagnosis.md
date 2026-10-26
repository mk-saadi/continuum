# W7: compaction truncation diagnosis

Date: 2026-10-26. Scope: W7 only. No live Qwen success is claimed.

## What is established

`workspaceCompactCandidate.completedContent()` raises `output-truncated` on a provider finish reason of `length`, `max_tokens`, or `model_length`, **before** parsing JSON, validating sources, persisting a candidate, or activating a checkpoint. This is generation exhaustion metadata, not the final candidate's measured size check. An exhausted response is rejected even if its visible text happens to be complete JSON. Adapter-native `provider_stop_reason: max_tokens` now also wins over an incorrectly normalized `stop`.

The code contained three interacting budgeting defects:

1. Final generation reserved `min(6144, floor(capacity * .4), capacity - input - 128)`. Staging only started when fewer than 1,024 output tokens remained. Consequently, an almost-full input could request a large structured checkpoint with only 1,024–6,143 output tokens.
2. Local requests did not disable optional template reasoning. Hidden reasoning advances the W6 progress lease but consumes generation tokens without contributing visible JSON. Removing the deadline in W6 correctly exposed output exhaustion rather than solving it.
3. The schema prompt had no concise output target. Both intermediate (maximum 4,096) and final (maximum 6,144) generation retried exhaustion with the same cap and generic validation feedback. The intermediate visible-size rejection did not permit a corrective retry.

**Limit of retrospective attribution:** the supplied 32,486-token number describes the prepared agent request. Candidate generation builds a different request from durable briefs, capped message excerpts, evidence and prior checkpoint. It is not evidence that the failing candidate request had that input size. No original generation envelope, per-stage cap, completion usage or reasoning split was supplied. The exact original failing stage and reasoning share cannot honestly be recovered. The certain immediate rejection is explicit provider exhaustion; the budgeting defects are reproduced deterministically below. New diagnostics make the next real failure attributable.

## Focused correction

Only two production modules changed:

- `src/main/workspaceCompactCandidate.js`: stage before generation whenever the full desired output allowance cannot fit. After reduction, require that allowance rather than falling back to a tiny final cap. Every actual request, including correction instructions, remains measured against the verified capacity and 128-token safety reserve. Impossible protected input still fails before generation; an oversized merge fails without attempting a doomed final generation.
- Local intermediate and final requests explicitly send `chat_template_kwargs: {enable_thinking: false}` before template measurement. Cloud requests keep their provider contract. This is a request to templates supporting optional thinking, not a guarantee for every Qwen variant or installed server build. The [llama.cpp server contract](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) documents chat template arguments and reasoning controls.
- The prompt requests compact JSON, short phrases, absent sections as empty arrays and a soft 1,800-visible-token target. Authoritative briefs and deterministic source evidence remain retained separately. Necessary facts must never be dropped to meet this target; over-5K essential candidates remain supported if they fit.
- One correction per stage requests a complete document with a tighter 900-visible-token target, consolidation of repeated prose, and citations instead of copied evidence. It preserves facts and source identity. Intermediate overflow now permits that correction. There is no recursive reduction, unbounded retry or larger aggregate generation allowance. If essential state cannot fit, compaction fails with original history preserved.
- `src/main/workspaceGenerationRuntime.js`: retain only counts of hidden reasoning and visible characters alongside the existing completion metadata and provider usage. Reasoning text is never stored in the result. The SSE contract still requires `[DONE]`, completion metadata, no tool invocation, and a complete document. Interrupted streams are never salvaged.

Diagnostics emit one bounded `[workspace-compaction-generation]` record per candidate operation, including failures that previously lost candidate diagnostics at the boundary. Fields include stage, stage-local attempt index, configured output tokens, provider-reported actual output tokens when present, allowlisted finish category, elapsed milliseconds, rejection code/stage, visible/reasoning character counts when streamed, and measured final candidate tokens. Counts are not represented as exact tokenizer measurements. Unknown provider usage stays null. No prompt, history, source text, reasoning text, file data, credentials or provider error message is logged. Existing stage/reservation limits bound the number of attempt records.

## Controlled before/after and cost

The deterministic reported-size fixture uses a **synthetic compaction input** of 32,486 tokens and verified capacity 35,072:

| Behavior | Before | After |
| --- | --- | --- |
| Final requested allowance | 2,458 | 6,144 |
| Input handling | Direct final request | Two disjoint intermediates, then final |
| Reasoning setting | Template default | Optional thinking disabled |
| Controlled finish | `length`, rejected | `stop` on all three stages |
| Provider-reported fixture tokens | 2,458 exhausted | 700 per stage, 2,100 total |
| Activation | None | Validated inactive candidate; promotion separately verified by W3/W4 suites |

These token counts are intentionally supplied by a controlled provider; they are not measured Qwen costs. Each fixture callback completes in roughly 0–1 ms; the machine-readable artifact records actual callback timings and suite durations. The corrected staged request reserves 4,096 + 4,096 + 6,144 = 14,336 tokens, below the existing 32,768 aggregate reservation ceiling. Reserving tokens is distinct from consuming them. Staging can cost more than a direct successful generation; this change does not claim a real latency improvement.

A separate controlled test exhausts all 6,144 requested tokens on the first final attempt, receives the changed size contract, and succeeds with 700 fixture tokens on its only retry (6,844 reported total). Persistent exhaustion still fails after two attempts. An intermediate visible document exceeding 4,096 estimated tokens receives one corrective attempt. A fully completed final candidate whose measured size exceeds capacity fails without activation or truncation of essential fields.

The runtime tests complete a reasoning stream after **330 virtual seconds**, with progress every 30 seconds, and exercise a **2,400-virtual-second** multi-stage lease. These use an injected clock, not wall-clock waits or inference throughput. The existing ten-minute inactivity lease remains; no 120-second or total-operation deadline was introduced.

## Runtime capacity and parallelism

`buildLlamaServerArgs()` passes configured `contextLength` through `-c` and configured `parallel` through `-np`. `contextBudget.createPromptMeasurer()` reads `/props.default_generation_settings.n_ctx` as per-request runtime capacity and records `/props.total_slots`. It does not substitute configured total context or divide verified capacity again.

A deterministic `/props` fixture with `n_ctx: 35072` and `total_slots: 2` produces exactly 35,072 capacity, 33,920 usable input and 30,528 trigger at a 1,024 output reserve and 128 safety reserve. Two partitioned slots explain the reported figures if total allocation rounds 70,000 upward to 70,144 (256 alignment), then splits into 35,072 per slot. This remains conditional on the actual process arguments, KV layout and server build, which were not inspected live. W6 already explains shared slots in model settings and the context tooltip, so no additional settings changes or silent parallelism changes were needed.

## Startup transport noise

The process owner is registered and `server-starting` is emitted before the model becomes ready. Context reporting probes `/props`, then may try `/apply-template` and fallback tokenization; UI refreshes can repeat measurement while loading. `createTrackedFetch()` records each `ECONNREFUSED` as `server-unavailable` with `serverTerminated: false`. These are compatible with expected pre-listen probes, not proof of process exit. The actual warmup request waits for both loaded and listening markers.

A controlled test refuses two early `/props` probes, then succeeds; both transport records remain nontermination events and request leases balance to zero. Without the original event/probe trace, those particular launch events cannot be attributed conclusively. No events are suppressed or relabeled as exits, and S1 is unchanged.

## Safety and regression evidence

Direct execution of the test files exercises individual assertions (rather than relying only on file-level `node --test` summaries in this environment). The evidence JSON records per-suite counts and durations. Coverage includes:

- W2 strict completion/source validation, malformed/empty/reasoning-only responses, persistent exhaustion, bounded correction, intermediate overflow, final candidate size, impossible protected input, prior state and all authoritative brief references.
- W3/W4 original history on failure, atomic promotion and rollback, same-run continuation, completed-tool identity, no duplicate execution, multi-stage cancellation and repeated compaction.
- W5 activity projection and failure handling; W6 progressing long streams, cancellation origins, inactivity, incomplete streams and exact runtime capacity with multiple slots.
- H1 deletion during generation and tombstone integrity.
- Existing engine launch, S1 lifecycle/startup, E1 editing and notification sound regressions.

Build: `npm run build` passed (existing Vite large-chunk advisory). Both modified production modules pass `node --check`. `git diff --check` passed. The pre-existing working tree, including E1, S1 and sound changes, was preserved. No commit, push, stash, reset, clean, live database modification or model termination was performed. Tests use temporary databases.

## Remaining real-model validation

Repeat the original local Qwen run using the installed llama.cpp build, without changing parallelism. Capture the new content-free attempt records to verify actual stage, output allowance, usage, reasoning counts, finish reason, elapsed time and rejection point. Confirm the template honors `enable_thinking: false`; a mandatory-thinking template can still exhaust the cap and must fail safely. Record `-c`, `-np`, `/props` and server build for capacity attribution. Validate atomic promotion, same-run continuation and absence of repeated completed tools in that actual run. Real latency/token savings and live Qwen success remain unverified.

# Additional finding: Casual Chat overflow (separate recovery follow-up)

## Findings and confidence

The Casual Chat report (`Context: 61.5K / 33.9K`, followed by `55676 server-template-tokenizer input tokens; budget 34432`) is a distinct **input overflow**, not Workspace's `output-truncated`. The application already has a pre-dispatch recovery hook. However, its Casual summarizer cannot reliably recover a backlog whose summarization input itself exceeds capacity. A deterministic test reproduces that failure with eligible older history and a small protected tail; it is therefore incorrect to infer that every such error means the user's protected content is irreducible.

No production behavior changed for this investigation. Fixing the missing bounded input-reduction pipeline requires a separate Casual recovery phase, including transactional and summary-completeness work, rather than expanding W7's Workspace fix.

## Actual path traced

1. **Scheduling and idle work.** `ChatInterface.jsx` schedules after message changes once streaming stops; `MemoryPalace.jsx` also schedules after a completed assistant save. The renderer's 250 ms scheduling debounce leads through `sessionAPI.scheduleIdleCompression` and `session:trigger-compression` to a main-process **10-second** debounce. Scheduling acknowledges queued work, not successful compression. Main-process measurement refreshes the runtime capacity before pressure checks. Cloud sessions are excluded, and Workspace idle activation is explicitly excluded. Stale measurements, in-progress messages, disabled compaction, a busy compression flag and unchanged attempted prompt identity can prevent work.
2. **Idle selection.** `compressionEngine.compressContext()` retains the last **ten message rows**, not ten user/assistant turn pairs, and protects the suffix starting at an in-progress/excluded row. Earlier eligible rows can be summarized and archived. Selection initially targets 65% of capacity, followed by the Casual projected target of 50% less the 2% estimator margin. Projection uses estimates; idle success does not certify exact fit of a future request with new draft text, RAG, tools or attachments. Extra selection extensions are capped at two. Existing summary-drop behavior can remove a bloated derived summary when the projection regains target; raw archived messages remain stored. This existing policy was not changed or used as a new recovery shortcut.
3. **Why Send remains available.** `ChatInterface` supplies `canSubmit` from chat/model/API availability and loading state; `ChatInputBar` additionally checks streaming, loading and draft/attachment presence. Neither gates Send on context occupancy or successful idle compression. This allows potentially recoverable requests to reach the authoritative main-process guard, but also allows repeated submissions after recovery failure. An idle failure records the attempted prompt identity **before** generation; the same unchanged identity is not automatically retried, avoiding repeated expensive failure but leaving no autonomous successful recovery. State changes can permit another attempt. Rapid submission can precede the idle timer entirely.
4. **Pre-dispatch guard.** `memoryChat.mjs` supplies `contextRecovery` to `localEngineFetch`. `contextBudget.createContextGuardedFetch()` measures the actual normalized request and, if input exceeds budget, invokes that hook **before any inference dispatch**. It also handles a recognized backend HTTP 400 overflow if initial counting admitted the request. Only one recovery is allowed for a guarded request; the rebuilt request is remeasured. A null/unchanged/still-too-large rebuild fails. Thus the source does not support the conclusion that Casual always skips recovery.
5. **Forced recovery.** Local non-Workspace `engine:chat` registers `recoverContext` in `ipcHandlers.js`. `recoverContextOverflow()` cancels a pending idle timer, awaits running compression, then forces compression. The immutable floor is checked before generation: system instructions, tools, applicable brief/checkpoint sections, protected tail and output reserve. The old summary is correctly excluded from that pre-generation immutable floor because a replacement can reduce it. With eligible history and a fitting floor, forced selection chooses **all eligible older rows in one batch**.
6. **The nested failure.** `main.js`'s `llmSummarizeCallback` serializes `oldSummary` plus that entire batch through `compactionCore.summaryUserContent()`. Message content has already been expanded with `messageForModel()`, including attachment text and vision inputs. The callback invokes the same guarded `localEngineFetch`, with `max_tokens: 512` on idle and forced Casual paths, but **without its own `contextRecovery` or measured input chunking**. If this summary input is too large, the nested guard throws immediately. It never reaches model inference, and cannot generate a smaller summary by itself. The outer guard propagates `CONTEXT_BUDGET_EXCEEDED`; this error code is deliberately not wrapped into a new generic failure. The recovery IPC path reports the failure through `session:compression-complete`.
7. **Commit safety.** Summarization and prospective checks precede the archival transaction. Forced recovery projects and, when available, exactly measures the prospective rebuilt prompt. A fitting candidate is committed with summary/archive updates together and source/leaf/tail revalidation. On the reproduced nested failure no archive bit, raw message content or summary changes, and `is_compressing` is released. The guard still remeasures the rebuilt actual request, including the live paired transcript and reinserted retrieval context. Failure after a valid compaction can leave a committed derived summary/archive state, but raw messages remain durable; this is distinct from a failed pre-commit summary generation. There is no new message deletion or silent clipping in this investigation.

## Budget reconciliation

With verified capacity **35,072**, `reserveTokens()` uses `max(output cap, explicit reasoning budget) + 128`:

| Request | Output reservation | Safety | Usable input |
| --- | ---: | ---: | ---: |
| Prepared-context header with default/1,024 output reserve | 1,024 | 128 | 33,920 |
| Casual summary request with explicit `max_tokens: 512` | 512 | 128 | 34,432 |

The discrepancy is exactly **512 tokens**, not a second context capacity or permission to use configured 70K. The error budget is strongly consistent with the nested summarizer. An ordinary chat request explicitly configured for a 512-token cap could produce the same budget; the original request trace is needed to establish which request failed in that live case.

The header's 61.5K and error's 55,676 need not count the same content. The header uses a prepared next-request projection plus an estimated draft count (or a labeled legacy fallback). A summary request wraps older message/attachment content and the prior summary in JSON while excluding the protected tail and normal chat scaffolding. Snapshot freshness, drafts and request shape must be recorded before treating the difference as a counting defect. No capacity relaxation is justified by either number.

## Excess historical input and repeated generation

The known defect is **input budgeting**, even though summary output is capped at 512. Force mode submits every selected old message at once. A single oversized old attachment or old summary can also exceed the summary input budget independently. Workspace W7's new staged candidate generator and optional-thinking suppression do not apply to this separate Casual callback.

For idle compression, `compactionCore.summarizeCandidates()` can regenerate an expanding prefix from the original summary until its target is met or candidates run out. Its default `maxPasses` is Infinity: message count makes the selection loop finite, but there is no explicit aggregate token/stage allowance comparable to Workspace W7. Extra projected-fit passes then merge only the next disjoint batch, up to two passes. Forced mode selects all candidates immediately, so it does not repeatedly regenerate expanding prefixes within that initial call. Across submissions, failed forced attempts can resend the same oversized batch because there is no stage-aware corrective strategy.

A separate correctness risk belongs in the follow-up: the current Casual `main.js` callback returns `choices[0].message.content` without checking finish reason or validating summary completeness. Optional reasoning remains at the template default. Nonempty text is not proof that an exhausted summary is complete. This was not changed during the additional investigation.

## Recoverable versus protected content

- **Recoverable:** eligible old rows or a replaceable prior summary dominate context while the system/tools/protected recent suffix fits. These need measured, bounded summarization inputs. The reproduced fixture has twenty large old rows and ten small recent rows; an intentionally synthetic fitting summary permits archival of the twenty older rows while retaining all thirty original contents.
- **Protected under current policy:** fewer than eleven rows, a huge recent attachment, in-progress suffix, oversized mandatory system/tool input, or a recent-ten-row floor that cannot fit even with no summary. Current compression must refuse rather than erase or silently shorten them. Changing the ten-row retention policy requires separate design and explicit safety tests; it should not be conflated with fixing old-history batching.
- **Not yet proven irreducible:** projection refusal based on approximate counts, recovery disabled/busy/stale, summary input overflow, provider failure or an oversized generated summary. Outcomes must expose their precise stage and component sizes rather than recommend a fresh session indiscriminately. Forced floor gates are conservative estimator-based checks, not semantic proofs of uncompressibility.

## Verification and recommended next phase

Added `tests/w7CasualRecovery.test.cjs` (two tests) without modifying production code. It verifies both exact budgets and reproduces the nested error using actual `createContextGuardedFetch`, `recoverContextOverflow`, source expansion/selection and summary serialization with deterministic tokenizer responses. The test confirms one outer recovery attempt, all twenty old rows in the summary batch, zero outer/summary inference dispatches, unchanged original rows and no summary on failure, and a released compression flag. A subsequent synthetic fitting candidate archives only the old twenty rows; all thirty original message contents remain intact. This demonstrates recoverability, not live Qwen success.

Also reran `contextOverflowRecovery.test.cjs` (10 tests, including actual main IPC recovery and rollback), `contextRecoveryReliability.test.cjs` (14) and `idleCompactionProjection.test.cjs` (18). **44 tests pass**, including the two new investigation tests. Durations are in the evidence JSON. `git diff --check` passes. Production behavior is unchanged, so the prior W7 build result remains applicable; no new build or live inference is claimed.

Recommended separate Casual recovery phase:

1. Record bounded content-free request kind (`chat`, `idle-summary`, `forced-summary`), stage, measured input/capacity/output reserve, selected/retained row counts, result code and timing. Expose pending/recovering/failed state and component-specific explanations without treating recoverable historical overflow as immutable protected input.
2. Plan disjoint summary batches using the **actual expanded serialized summary request**, measured runtime capacity, output and safety reserves. Bound stage count and aggregate generation cost. Include old-summary reduction; stop early with an explicit reason for a single source that cannot fit. Never clip essential content merely to force success.
3. Validate completion metadata and concise summary contracts; apply supported local reasoning controls deliberately. Avoid resending a failed oversized batch without changing conditions. Do not auto-retry provider/cancellation failures indefinitely.
4. Stage all derived summaries before archival. Revalidate source/branch/runtime identity, exactly measure the final rebuilt chat request with its real reservation, then commit atomically. Preserve cancellation, H1 tombstones, permission rules, raw history and paired completed-tool identity. Test source changes and failure at every stage.
5. Add end-to-end cases at the reported 35,072 capacity with two slots: >60K recoverable backlog, huge old summary, expanded older attachment, genuinely oversized protected recent content, idle/forced race, unchanged-failure deduplication, cancellation and model change. Confirm no duplicate tool execution, no history loss, and successful same-run dispatch. Validate with the actual Qwen/llama.cpp build afterward.

This recommendation deliberately leaves the substantial Casual recovery redesign outside W7. The additional finding does not weaken runtime checks, substitute configured 70K, alter user parallelism or change unrelated behavior.
