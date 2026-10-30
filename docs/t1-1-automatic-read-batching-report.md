# T1.1 — Automatic bounded native read batches

Date: 2026-10-29

## Root cause and scope

T1 preflight could establish that an entire oversized response was safe, but its plan still deferred every position after 24. The parent and child loops tracked these deferred operations and required the model to regenerate them. A 28-read workflow therefore needed three provider requests: original calls, regenerated final four calls, and final continuation.

T1.1 uses the existing executors and provider loops. A safe response is now processed in bounded internal slices, without inference between slices. Successful automatic reads create no deferred results, correction instruction, outstanding-read state, or extra continuation count. Unsafe oversized responses retain full rejection and the initial response plus two correction attempts. Normal batches retain their existing tools and permissions.

The working tree already contained extensive tracked and untracked T1/P2/C9 work. It was preserved in place. No commits, pushes, stash/reset/clean, dependency installation, live database changes, model changes, real inference, or real MCP service calls were performed for this implementation.

## Policy and eligibility

`src/lib/toolBatchPolicy.cjs` centralizes:

- Internal execution slice: **24 operations** maximum.
- Automatically accepted oversized response: **72 operations** maximum.
- Aggregate automatic output stop threshold: **2 MiB**, measured as UTF-8 bytes of actual serialized executor outputs before model-facing projection.
- One concise model instruction: prefer at most 24 calls; larger responses may be accepted only for verified independent reads. The 72 ceiling is not advertised as a target.

Stricter remaining budgets take precedence: the parent casual tool allowance and child task/parent aggregate tool allowances can reject an entire oversized candidate before dispatch. Ordinary batches still use their existing budget gates. Child budgets are cumulative across responses; 72 is not a refill.

Only native `read_project_file` and `list_directory` invocations can qualify. Implementation-backed preflight validates current schemas, argument keys, R2 pagination relationships, concrete real paths, workspace containment, regular-file/directory type, live authorization, and absence of approval requirements. Unknown/MCP, editing, command, LSP, web and uncertain operations reject oversized responses in full. Native activation still uses current advertised schemas and the existing executor manifest/permission checks.

Automatic overflow conservatively excludes image and PDF read invocations: those implementation branches allocate whole-file payloads. Batches of 24 or fewer retain their existing media behavior. Text pages retain R2's 20,000 source-character cap, default 200/max 400 lines and long-line windows; directory results retain the 200-entry cap. Unsupported fields and invalid range combinations fail closed.

## Complete preflight and execution

Finalized logical calls enter the common policy after SSE/JSON/XML collection. Parent IDs must be nonempty and unique, including against previously used IDs; child IDs retain existing validation, and shared overflow planning checks nonempty unique IDs too. Original valid IDs and argument strings remain intact. Existing malformed-argument rejection normalization is retained for Anthropic-compatible serialization.

Before any oversized candidate executes, every invocation must qualify, the total must fit the automatic and applicable remaining ceilings, and the parent task guard must permit continuation. A single failure rejects all calls; no prefix executes.

The existing ordered dispatch loop forms internal slices at offsets 0, 24 and 48. Before each slice it drains pending work, checks task state/output limits and re-preflights the complete next slice. Native reads remain sequential through the existing executor, which means at most 24 operations start between slice boundaries. Every slice finishes before the next begins. Reads are not retried. Individual execution failures produce real errors while other independent reads can continue.

## Authorization, ownership and interruption

Workspace preflight checks the active stream controller, session existence, permission revision, current native tool advertisement, schema, filesystem facts and the ordinary native permission guard with approval requests failing closed. The existing executor independently rechecks current schema/manifests and live permissions.

Child preflight additionally captures the execution owner, registered child session, parent permission revision and child permission revision; changes block further reads. Existing child cancellation/deadline and per-operation execution budget gates remain active.

Before subsequent slices, deletion, permission/ownership changes, revoked availability, disappearing/unsafe targets, cancellation and aggregate output exhaustion prevent pending execution. Completed parent steps keep their actual results. Remaining calls get original-ID `rejected` manifests with explicit **not executed** reasons. Parent execution returns an incomplete outcome without another inference request. Cancellation observed after an executor has returned a real result preserves that actual outcome; cancellation that causes the executor to fail remains an error. Cancellation during initial preflight follows the existing abort path before any operation starts.

Child transcripts retain existing explicit skipped outcomes and committed full tool evidence; interrupted child execution follows its existing stop/finalization rules. Internal slices do not create new model turns or alter task-plan revisions.

## Provider pairing and context protection

The original assistant envelope is followed by one ordered result per original call ID. Completed reads return actual results; no synthetic success or replay is used. OpenAI-compatible, Qwen normalized JSON/XML/SSE and Anthropic tool-use/result conversions use the unchanged common histories. Compact/full native profiles use the same policy.

The output counter checks before each subsequent operation as well as at slice boundaries. Once at or above 2 MiB, it starts no further read. This is a stop threshold, not truncation: the last completed bounded native result may cross it. The full completed result remains in existing execution-step storage; child full evidence remains in the existing context adapter. No new storage or compaction architecture was introduced. The total is also inherently limited by 72 bounded text/directory calls. JSON escaping and metadata count toward measured bytes.

Before any provider continuation, existing complete-payload measurement, active schema/instruction accounting, context fit enforcement, protected pairing and C7–C9 compaction remain in force. Genuine context failures are propagated; completed operations are neither replayed nor silently dropped. Aggregate-output interruption returns incomplete without sending an overlarge continuation.

## Timeline

Actual parent tool steps carry `readBatch` metadata with response identity, internal index and total. Existing stage summaries display, for example, `24 completed in batch 1` and `4 completed in batch 2`. Only real completed steps count; rejected steps remain not executed. There is one step per original operation. Child activity uses existing note events for batch boundaries. No new dashboard or duplicate calls were added.

## Deterministic efficiency fixture

Reproduce with:

```bash
node scripts/audits/t11ReadBatchEfficiency.mjs /absolute/path/to/preserved-T1/src/lib/memoryChat.mjs
```

The fixture injects deterministic provider responses and performs actual reads in a disposable directory. It includes the original final four paths. The baseline module was preserved under `/tmp/t11-baseline` before changing execution behavior. Its dependencies resolve to the installed workspace dependencies.

| Measurement | T1 | T1.1 |
| --- | ---: | ---: |
| Provider requests, including initial request and final continuation | 3 | 2 |
| Model-generated argument bytes | 1056 | 895 |
| Repeated argument bytes | 161 | 0 |
| Estimated generated argument tokens | 264 | 224 |
| Estimated complete request tokens, summed | 5073 | 2223 |
| Tool operations | 28 | 28 |
| Failed operations | 0 | 0 |

Estimates use `ceil(UTF-8 serialized bytes / 4)`, not a tokenizer; these are not exact model-token savings. Complete request measurements include instructions, active schemas and actual results. The evidence JSON records individual request sizes and observed local tool/task times. Injected provider timing and local cache/order effects do **not** support model latency or end-to-end performance claims. The demonstrated efficiency improvement is removal of one redundant provider request and four regenerated argument objects.

## Verification

The initial pre-edit focused baseline passed T1, memory chat and P2 (three files). T1.1 focused tests pass **46 parent/policy cases plus one isolated child integration case**. Cases cover 1/18/24/25/28/30/48/50/72 calls; whole rejection above 72; mixed/edit/MCP/dependency/approval/argument/path rejection; cancellation, deletion, ownership and permission changes; vanished files; actual failed reads; ordered IDs/results; no intermediate inference or duplicate execution; streaming/XML assembly; Anthropic pairing; output and context failure; completion state; stricter budgets and accurate timeline counts. The child integration is isolated from parent fixture state.

A 30-file regression selection was run against both the preserved T1 source and T1.1. **26 files pass in each**, with the same four exact failing test identities below. The selection covers native dispatch/arguments, E1/E2/R2 through agent tools and pagination tests, compact profile, MCP/native permissions, ownership/security, stream collection, C9.1–C9.3, context budgets/dispatch, child budgets/continuation/streaming and compaction history. Compact and full profile runs each pass all three selected files (P2, focused parent suite, child integration). Production `npm run build` passes with the existing Vite large-chunk advisory. `git diff --check` passes.

Baseline failures, also present after the change:

1. `filesystemToolLimits.test.cjs` — **MCP execution applies the cap before serialization**: database not initialized in its fixture.
2. `childAgentLoop.test.cjs` — **spawn_sub_agent with investigate=true runs the loop end to end through the real provider**: sandbox localhost `listen EPERM`.
3. `unifiedToolArchitecture.test.cjs` — **compaction preserves every structural field and validator compiles the complete registry**: existing edit argument diagnostic assertion mismatch.
4. `subagentCompaction.test.cjs` — **running child crosses pressure repeatedly and resumes with early findings without tool replay**: existing assertion expects 22, observes 24.

No unrelated failures were changed or suppressed. Exact identities, counts, selected files and log hashes are in the evidence JSON. The full repository suite and live UI/model acceptance were not run.

## Remaining limitations and real-Qwen acceptance

Preflight and execution cannot make filesystem access atomic across external changes; the existing executor's containment/type/revision checks and real errors remain authoritative. A file replaced by another regular file between slices may be read at its current revision unless the original invocation supplies an expected hash. Disappearing or newly unsafe targets stop the next slice. Aggregate output is measured after completion, so one bounded result can cross the threshold. Automatic overflow covers bounded text and directory reads only. Recovery still follows existing context and provider limits.

For manual acceptance, create a disposable Qwen Workspace project/session, retain current model settings and run in compact and full profiles. Capture one 28-read response whose last four paths are TaskList, ThemeToggle, index.html and vite.config.js. Confirm 24+4 starts, 28 original-ID actual results, one provider continuation, no deferred manifest and no regenerated arguments. Repeat 25/30/48/50/72, then 73 and a mixed 25-call edit/read response; the latter two must execute nothing before correction. Change permissions, cancel/delete the session, change parent ownership or remove a target between slices; verify pending operations are not executed and the task stays incomplete. Check a large-result context case reaches the existing final fit guard and preserves paired evidence. Verify the current plan and unfinished-work handling survive ordinary continuation.

Stop after T1.1. No T2, model context threshold, discovery, scheduling, compaction architecture or task-plan lifecycle changes were implemented.
