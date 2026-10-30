# T1 — Tool response batch limit and safe overflow recovery

Implemented the amendment: at most 24 operations execute per assistant response. Safe excess reads are deferred; uncertain or mutating oversized batches execute nothing. Earlier contradictory requirements to reject *all* overflow without partial execution are superseded by the amendment.

## Original behavior and scope

- `src/lib/memoryChat.mjs`, `readCompletion`: SSE assembly threw when its indexed-call Map already contained 16 entries. An 18-call response failed before dispatch.
- `tests/memoryChat.test.mjs`: “sparse indexes do not bypass the 16-call accumulation bound” encoded the old threshold and exception.
- Non-streaming JSON and Qwen XML extraction bypassed that assembly limit. The cloud adapter normalizes Anthropic tool-use blocks into JSON tool calls; OpenAI-compatible endpoints and OpenRouter use the common reader directly. Child investigation has its own provider/dispatch loop.
- The compact profile's 16 *advertised tools* and the child agent's cumulative tool budgets are different quantities and remain unchanged.

The initial working tree already contained extensive tracked and untracked P1/P2/C9 and other work. Changes were applied in place without committing, pushing, stashing, resetting or cleaning. No live SQLite database, model, or model settings were modified. No inference or external MCP service was used.

## Authoritative policy and guidance

`src/lib/toolBatchPolicy.cjs` owns `MAX_TOOL_CALLS_PER_RESPONSE = 24`, the concise requested model instruction, overflow classification, argument-free manifest formatting, and canonical operation identity for outstanding deferred reads.

`runMemoryChat` adds that instruction once to its transient system guidance, including rebuilt context prefixes. Existing wire normalization still produces a single leading system message. The child investigation system prompt uses the same instruction. Guidance applies regardless of cloud/local model or compact/full tool catalog. It explicitly permits successive batches, rather than limiting the lifetime of the task.

## Collection and dispatch

SSE fragments still assemble by provider index and finalize in index order. Fragments do not count as new calls; sparse indexes do not bypass dispatch enforcement. JSON, XML and SSE all reach the same parent dispatch policy after assembly. Missing/repeated parent tool-call IDs are rejected before any operation executes. Existing incomplete-stream and argument-size protections remain in place.

For more than 24 calls, the whole batch must first pass argument validation and an explicit implementation-based preflight. Production partial execution currently recognizes only native `read_project_file` and `list_directory`. The preflight verifies current schema, concrete real paths contained in the workspace, regular-file/directory type, and the ordinary live permission guard without opening an approval prompt. No classification depends on the tool name alone: native identity, reviewed implementation semantics, arguments, filesystem facts and authorization must agree. Devices, pipes, missing/escaping paths and unresolved dependencies fail closed.

If the whole batch qualifies, only positions 1–24 enter the existing executor. Every later position receives a structured **deferred / not executed** tool result. Actual successes and execution failures keep their real results. The ordered protocol tool-result sequence is the deferred manifest: each deferred entry includes original position, tool name, call ID, safe argument reference and exact reason. Original valid arguments remain in the authorized assistant envelope and persisted execution-step arguments; they are not copied into diagnostic summaries. There is no background execution or automatic replay.

If any operation is mutating, requires approval, unknown, malformed, or has unestablished independence, every call receives a **rejected / not executed** result and nothing executes. Invalid JSON is omitted from the rejected envelope so Anthropic serialization can still produce a valid object; no invalid payload is echoed as a diagnostic. The model receives a short instruction to split the original workflow into valid dependency-aware batches.

Known and unknown MCP tools, LSP tools and activated editing tools may execute within normal batches of 24 or fewer under their existing authorization. Oversized batches containing these tools conservatively reject in full: MCP annotations alone do not establish enforced side-effect freedom or independence. The child investigation dispatcher uses the same shared policy and cap, with its existing read-only executor and budgets retained.

## Correction, continuation and status

The normal provider loop carries real results and explicit not-executed results forward. No recoverable overflow becomes a streamed-assembly `engine:chat` exception. Rejected batches allow the initial response plus two correction responses; the third invalid oversized batch ends with `tool-batch-correction-exhausted` and an explicit incomplete status. A plain-text answer immediately after rejection also remains incomplete.

Outstanding deferred reads are tracked by canonical tool/argument identity and multiplicity. Only explicit requests for those operations consume the outstanding entries; an unrelated follow-up cannot silently resolve them. The first 24 operations are never automatically replayed. Pending overflow continuation rechecks task/session availability and permission revision before another provider request. Cancellation, deletion, permission changes, context overflow or provider failures interrupt through the existing paths.

`src/main/executionSteps.js` accepts persisted deferred/rejected statuses. `src/lib/executionEvents.mjs` labels them “not executed,” excludes them from successful-operation counts and reports their counts in timeline stage summaries. These changes prevent not-executed calls from being displayed as successful tools. C9.3's existing bounded premature-stop heuristic, task-plan handling and continuation counter are preserved; overflow recovery has its own correction counter.

## Security and compatibility

The ordinary executor remains responsible for each actual invocation: current advertised schemas/manifest epochs, native and MCP grants, read-only/ask/workspace/full-access policies, containment, approvals, Git protections, session ownership, child permissions and cancellation. Preflight grants no execution permission and cannot approve mutation. Dynamic tool activation continues through the existing catalog refresh. No specialized tools or discovery groups were removed, and the compact default still advertises 16 tools.

OpenAI-compatible histories retain one result for every emitted call ID, including explicit deferred/rejected results. Anthropic conversion preserves these IDs as `tool_use`/`tool_result` pairs. Deterministic tests exercise the converter, including malformed rejected arguments. Existing provider-specific request and result adapters were not changed.

| Requested calls | Before (SSE) | After |
| --- | --- | --- |
| 18 | Entire response throws at 16; no tools execute | All 18 dispatch under normal checks |
| 24 | Entire response throws at 16 | All 24 dispatch under normal checks |
| 25 independent verified native reads | Entire response throws at 16 | First 24 execute; 1 explicitly deferred; same loop continues |
| 25 mixed/mutating/uncertain calls | Entire response throws at 16 | None execute; bounded correction |
| 50 verified reads | Entire response throws at 16 | First 24 execute; 26 explicitly deferred |

## Verification and baseline

- Before editing: the 10-file baseline covering memory chat, XML streaming, argument limits, compact profile, C9.3 (logic and IPC), native/MCP permissions, permission isolation and context budget passed: 10/10 files.
- Final focused T1 tests: 32/32 cases passed. Includes 1/16/18/24/25/30/50 calls, identity/order, failed first-batch reads, no hidden execution/replay, mixed/edited/unknown-MCP/dependent/malformed batches, two failed corrections, unresolved deferred work, cancellation, deletion, permission revision, dynamic tools, fragmented SSE, XML, Anthropic pairing, persisted timeline statuses, child investigation and context failure.
- `tests/memoryChat.test.mjs`: 50/50 cases passed. The old limit fixture now tests complete sparse-index overflow collection. The system-message assertion explicitly includes the required new guidance; unrelated assertions were not weakened.
- Relevant final regression selection: 20/20 test files passed (listed in the evidence JSON), including C9.1, C9 validation/recovery, C9.3, permissions, context budgets, native/MCP security, child continuation/streaming and stream dispatch.
- Compact and full profile runs each passed both `p2CompactNativeTools.test.cjs` and `t1ToolBatch.test.mjs`.
- Child loop comparison used a disposable source copy with the original tracked child-loop module: 15/16 cases passed before and after. The same localhost-listener test failed in both due to sandbox `EPERM`.
- Production `npm run build` passed; Vite reported its existing large-chunk advisory. `git diff --check` passed.

Additional broader suites exposed these exact failures, also reproduced in a disposable source copy. They were outside the initial 10-file baseline and are not counted as passing:

1. `cloudProviders.test.cjs`: **cloud chat POST survives a GET-only global.fetch override (sub-agent shim)** — localhost `listen EPERM` (sandbox).
2. `cloudIpc.test.cjs`: **cloud settings persist privately and cloud chat works without a local engine** — missing Electron `app.getPath` stub during database initialization, before chat dispatch.
3. `unifiedToolArchitecture.test.cjs`: **compaction preserves every structural field and validator compiles the complete registry** — existing `edit_project_files:edits` / `EDIT_ARGUMENT_INVALID` assertion mismatch in unchanged schema validation.
4. `childAgentLoop.test.cjs`: **spawn_sub_agent with investigate=true runs the loop end to end through the real provider** — localhost `listen EPERM`, confirmed against the original child-loop source.

No failure above was suppressed or fixed by changing unrelated code. The complete repository test collection was not run; the relevant selection and expanded suites are recorded separately.

## Limits and recommended real-Qwen acceptance

Partial execution deliberately covers only concrete native file reads and directory listings. Other tool semantics remain conservative even where a particular invocation might be harmless. Deferred tracking compares exact canonical tool arguments; a differently paginated or rewritten equivalent read can leave the task conservatively incomplete. Model-declared completion cannot prove deferred work was performed. Read failures remain failures and are not automatically retried. Existing context-budget enforcement can interrupt a very large transcript. Recovery counters/outstanding-read tracking are run-local; persisted not-executed steps retain the recovery evidence for a later resumed run.

In a disposable Qwen Workspace session, request the original six test-file pages and twelve React components. Confirm all 18 reads complete, then test 24, 25, 30 and 50 independent reads in compact and full profiles. For overflow, verify only 24 tools start, exact ordered deferred entries appear, and the model explicitly requests remaining calls under fresh IDs without replaying successful reads. Test a 25-call mixed edit/read response: no tools should start until a corrected valid batch arrives. Interrupt/delete the session and change permissions between batches; confirm no further operation starts and the outcome is incomplete/interrupted. Finally verify an unchanged task plan and normal C9.3 behavior. This real-model acceptance test was intentionally not performed.

Stop after T1. No scheduling, catalog expansion, compaction redesign or task-plan refactor was implemented.
