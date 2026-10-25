# W6 local compaction runtime diagnosis

Date: 2026-10-25. Scope: focused Workspace candidate runtime/capacity correction on the existing dirty working tree. No commits, resets, active conversation edits, live database writes, or real deletion were performed. Tests use disposable temporary databases.

## Findings and confidence

**Historical cancellation origin is unproven.** The supplied task 4319 terminal line establishes cancellation at the server, not its caller. No original timestamped abort trace, process arguments, server build, startup log, `/props`, or model file was available here. No loaded llama-server process was visible in this execution environment. A real-model reproduction was therefore not attempted against the user's active instance.

**A concrete 120-second defect was found.** Before this correction, `generateWorkspaceCompactCandidate` armed a 120000 ms AbortController timer at candidate entry. Its signal was passed through the owning-loop callback and `llmCheckpointCallback` into local fetch. Expiry aborts the HTTP operation; a server may consequently log task cancellation. Both catch paths then replaced any abort reason with `cancelled-run`. Separately, staged reduction rejected work after 120 seconds using `performance.now()`. Both clocks covered multiple stages, measurement, retries and prefill, not just one generation. These are unsuitable bounds for normal slow local inference. Whether that timer actually cancelled task 4319 cannot be proven. 5708 / 54 is approximately 105.7 seconds of decoding; unrecorded prefill, measurement and prior stages could bring the attempt over 120 seconds. This is compatibility evidence, not attribution. There is no confirmed backend truncation in the supplied evidence.

## Capacity trace

1. `configManager.normalizeLoadConfig` validates integer context/parallel settings; default parallel is 1. The user's reported selected total was 70000. The actual selected parallel value from the failing instance is unavailable.
2. `engineManager.buildLlamaServerArgs` explicitly emits `-c <contextLength>` and `-np <parallel>`, passed as separate arguments to spawn. There is no application-side halving here. The new fixture asserts `-c 70000 -np 2`; it does not claim these were the historical process arguments.
3. llama.cpp owns effective KV allocation, alignment and per-sequence capacity. In the non-unified implementation, context is padded to 256, divided by sequence count and per-sequence padded again. See [upstream context initialization](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-context.cpp). Unified KV modes/builds can behave differently; never infer a verified limit from configuration alone.
4. Exact numerical reconstruction for two slots: ceil(70000/256)*256 = 70144; 70144/2 = 35072 (already aligned). This explains the observed value exactly **if** the instance used two partitioned slots. Original slot count, KV mode, allocated total and binary version remain unverified.
5. Server `/props` advertises `default_generation_settings.n_ctx` as the request capacity and `total_slots` as parallel count. See [upstream server metadata](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp). The application uses the advertised request capacity directly; it does not divide it again. Backend overflow feedback can further lower a known limit.
6. `contextBudget.createPromptMeasurer` refreshes `/props`, measures the serialized prompt through apply-template/tokenize where available, and passes verified request capacity to `createRuntimeBudget`. Unavailable metadata retains the conservative fallback. Runtime metadata now also carries the server's slot count, without deriving an unverified total.
7. C1 arithmetic: 35072 - max(output 1024, reasoning reservation 0) - safety 128 = 33920 usable input; floor(33920 * .90) = 30528 trigger. 31508/33920 = 92.889%. This is compaction pressure, not established overflow: 2412 input tokens remain available.
8. `promptMeasurement` propagates the contract to the UI. The tooltip distinguishes configured total from verified per-request capacity, now displays runtime parallel slots, and explains sharing. Model loading settings explain the effect of concurrent slots. Configured 70000 is never substituted for verified 35072. No unintended parallel default or application-side division was established, so slot allocation was not silently changed.

## Owning loop and abort trace

`memoryChat.compactWorkspace` executes at a safe point after completed tool batches, flushes durable execution steps, and supplies a retained-tail request builder. Casual mode skips this path. IPC owns the active run controller in its sender request map and `activeStreams`; candidate generation gets a subordinate controller, not ownership of the run. W3 guards run identity, permission revision, operation barriers, paired tool results and durable evidence. W2 captures source identity, locks compression, validates references/completion metadata, and produces an inactive candidate. W3 checks prospective fit before a transactional promotion/archive, rebuilds and verifies actual fit, then validates dispatch and continues the existing run with consumed tool identities retained. Existing post-commit compensation remains in place; no tools are re-executed by compaction.

Abort paths now preserve content-free codes:

- Explicit cancel-chat/cancel-session: `user-cancelled`.
- H1 deletion: `deleted-conversation`; pending deletion blocks stale reads/writes, aborts the owner, cancels/awaits candidate settlement, and only then cleans up. The existing human deletion message is retained.
- Owning WebContents destruction: `renderer-destroyed`. Tab cancellation routed through cancel IPC is `user-cancelled`; tab selection itself is not a candidate-owned timeout.
- IPC handler disposal: `ipc-disposed`.
- Candidate inactivity lease expiry: `generation-inactivity-timeout`.
- Unclassified parent abort: `unexpected-abort`; no inference from arbitrary error messages.
- Snapshot/task mutation: existing `concurrent-state-change`, `stale-task-brief`, `stale-candidate` and operation guards; these are not user cancellations.
- HTTP/provider failure: `provider-error`; incomplete SSE/completion: `incomplete-response`; length finish metadata remains `output-truncated`.

W2 diagnostics record abort origin code, stage and transport-signal state. The durable activity allowlist preserves the new codes, and the renderer explains each reason. No prompt text, tool outputs, arbitrary exception message or credentials are added to abort telemetry.

## Runtime correction

The fixed 120-second attempt deadline and staged elapsed-time rejection are removed. A 10-minute no-progress lease bounds prefill, queue waits and inactive transport. Each actual local content/reasoning delta renews the lease; stage entry also renews it. The local candidate callback now requests SSE, consumes reasoning as progress without storing it, assembles only visible candidate JSON, preserves final finish/usage metadata, rejects missing DONE/incomplete or tool-call responses, and cancels/releases the reader on completion/failure. Caller abort still reaches fetch. Local transport already disables undici header/body deadlines; that behavior is retained.

There is intentionally no fixed total wall-clock deadline across progressing stages. Existing stage limit (12 segment layout bound), two-attempt validation limits, cumulative reserved generation allowance (32768 tokens), per-intermediate size bound (4096), final output bound (6144), and source/budget validation bound useful work. A silent stage is bounded by the inactivity lease. Cloud adapters remain non-streaming here and receive the same generous inactivity bound; their token/stage constraints remain intact.

Compaction failure stops request dispatch and carries a recoverable retry message and actual safe reason. It does not send a prospective overflow request or activate a partial candidate. Original messages remain durable. The transaction/verified continuation/compensation algorithm was not redesigned.

## Verification

- Baseline selected W2/W3/W4/C1 files: 4 file entries passed, no failing identities.
- First updated run exposed expectation-only failures: `W2 H1 deletion cancels an active candidate before durable cleanup` expected generic abort instead of `deleted-conversation`; `H1 registered Delete Chat IPC cancels its actual engine request before deleting and rejects stale prepare` expected the old human deletion message. The first expectation was corrected; the second message was preserved with its structured code. Both subsequently passed.
- Final focused regression set: 10/10 file entries passed, zero failures. Includes W2, safe W3, advanced W4, activity, C1 budget/integration/UI, context recovery reliability and H1 deletion.
- Additional renderer-reason/runtime checks: 2/2 file entries passed. Node's runner in this environment reports file entries; these numbers are not individual assertion counts.
- Direct advanced suite before the final startup assertion: 24 individual tests passed. Controlled time advances a local candidate to 240 seconds and verifies commit plus same-run dispatch; separate user/deletion/inactivity fixtures assert unchanged archive bits and no current checkpoint. Multi-segment fixture advances each generation beyond 120 seconds. Pure runtime fixtures simulate 40 minutes of progress across stages without real waits. Existing full parent-loop tests verify completed tool IDs execute once and repeated successful compactions continue the same run. Existing stale checkpoint/source, backend failure and malformed/truncated completion tests remain enforced.
- Final advanced rerun including the explicit startup-argument assertion: passed (one file entry, zero failures). Syntax checks and `git diff --check` passed.
- Production `npm run build`: passed; Vite reports its existing large-chunk advisory.
- Exact regression identities and structured results are recorded in the companion evidence JSON. Temporary TAP/build logs were kept under `/tmp/w6-*`; they are not repository artifacts.

## Files changed for W6

`main.js`; `src/main/workspaceGenerationRuntime.js` (new); `src/main/workspaceCompactCandidate.js`; `src/main/workspaceCompaction.js`; `src/main/workspaceCompactionActivity.js`; `src/main/ipcHandlers.js`; `src/main/sessionDeletion.js`; `src/main/contextBudget.js`; `src/lib/contextDisplay.mjs`; `src/lib/compactionActivity.mjs`; `src/components/ModelSettingsModal.jsx`; `tests/workspaceGenerationRuntime.test.cjs` (new); `tests/workspaceAdvancedCompaction.test.cjs`; `tests/workspaceCompactCandidate.test.cjs`; `tests/workspaceSafeCompaction.test.cjs`; these two W6 documents. Several were pre-existing uncommitted/untracked W2–W5 work; edits are additive to that state. Other pre-existing dirty files are outside this change.

## Remaining limitations

Original runtime args/slot count/build and original cancellation attribution require a fresh captured run; they cannot be recovered from the terminal cancellation line. No real GGUF verification was possible in this environment. A prefill or model stall silent for ten minutes is intentionally terminated, even if it might eventually complete; progress is measured at streamed model deltas, not GPU utilization. A provider or injected callback that ignores AbortSignal cannot be forcibly terminated by JavaScript alone; production fetch honors it. Cloud progress streaming is not added. Candidate semantic completeness remains subject to existing structural/source checks, not a proof of every natural-language fact. Backend crash/failed post-commit compensation retains the existing recovery limitation. No unrelated feature work was added.
