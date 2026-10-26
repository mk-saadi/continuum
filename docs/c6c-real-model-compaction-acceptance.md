# C6-C — Real-model compaction acceptance

2026-10-26, Asia/Dhaka.

**PARTIAL — Controlled tests pass, real-model testing incomplete**

No Gemma or Qwen inference was performed. Controlled acceptance scenarios passed, including real disposable file edits and failing/passing Node tests, but these do not establish real-model semantic retention or inference reliability. The focused regression set retains two known assertion failures and one known cancellation. No new production defect was demonstrated; no production code was changed.

## Preservation and environment

The current working tree, including all earlier tracked/untracked C5/C6-A/C6-B, notification, lifecycle and editing work, was authoritative. Starting status, complete tracked diff and file hashes were saved under `/tmp/continuum-c6c`. Final hash comparison found **zero modified or missing preexisting files** in the captured source/artifact manifest (dependencies, Git internals, build/release outputs excluded). The only repository additions are this report, its evidence JSON and `tests/c6cAcceptance.test.cjs`. No commit, push, stash, reset, clean, live conversation/database edit, model unload, permission/settings change or user file deletion occurred. Tests created disposable profiles/databases/projects and removed only their own temporary fixtures. The requested build regenerated ignored build output.

Read C6-A/C6-B reports and evidence before testing. Existing baseline comparison uses C6-B's recorded final results against the unchanged authoritative production sources, rather than treating HEAD as the baseline. All forty shared suites have identical failing identities and exit codes.

The available binary `/home/mk_saadi/llamacpp-faall-build/bin/llama-server` reports `0.4.0-dev`, build **10899**, commit **d7680c67b**, GNU 13.3.0, Linux x86_64. Header-only GGUF inspection confirmed:

| Discovered model (not inferred with) | Quantization | File bytes | Architecture | Declared model context |
|---|---|---:|---|---:|
| lmstudio-community/gemma-4-26B-A4B-it-QAT-GGUF/gemma-4-26B-A4B-it-QAT-Q4_0.gguf | Q4_0, filename; GGUF file type 2 | 14,439,363,264 | gemma4 | 262,144 |
| unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-IQ4_NL.gguf | IQ4_NL, filename; GGUF file type 25 | 18,040,888,288 | qwen35moe | 262,144 |

Full paths, names and embedded template SHA-256 values are in the evidence. Gemma's embedded template has 18,682 characters; Qwen's has 8,057. Both mention thinking controls. These are metadata observations, not verification of server-selected templates, supported grammar dialects or effective runtime capacity.

Socket creation returned EPERM inside the sandbox, and CUDA discovery failed there. An authorized outside-sandbox probe successfully bound an ephemeral loopback port and found an RTX 5060 Ti with **712 MiB free**. The memory snapshot showed **15 GiB RAM, 2.4 GiB available, 8.9 GiB swap already used**. No running llama-server was visible. Loading these 14.4/18.0 GB models under those conditions would compete with user workloads; no weight load or server launch was attempted, and no process was stopped. No models were downloaded and no paid inference was used.

Consequently configured runtime context, effective request context, parallel slots, actual template, reasoning setting, real available output allowance and template/tokenizer validation are **not measured**. Model-declared context must not be substituted for those fields. Sufficient free capacity in a separate application/server instance remains the real-inference blocker.

## Controlled acceptance results

### Casual

All 18 C5 recovery tests passed. A restored history already above effective input capacity generated four bounded summary stages, activated atomically, preserved original rows and dispatched the new question exactly once. The fixture's legacy single-summary input was 101,299 tokens against a 34,432 budget; the final serialized chat measured 2,236 against a usable 33,920 budget. These are **synthetic endpoint counts**, not real tokenizer measurements. The configured 70,000 versus simulated runtime 35,072 distinction was maintained.

The suite also passed below-budget single dispatch, successive compression cycles, threshold gating, disjoint oversized-source splitting, protected-content refusal, source/runtime changes, deletion, non-cooperative late completion after cancellation, incomplete output and prospective over-budget rollback. Structured-output tests separately passed fenced/BOM/trailing-comma normalization without regeneration, one bounded schema correction, persistent rejection and temporary tokenizer recovery. No history was deleted to obtain a passing result.

A genuine multi-turn conversation containing preferences, facts, decisions, references, open questions and a later correction **has not been evaluated by a real model**. The scripted summary fixture cannot establish semantic accuracy, natural context growth or correction retention.

### Workspace coding and three compactions

New `tests/c6cAcceptance.test.cjs` uses the production `runMemoryChat`, persistence, W2 validation, W3 atomic activation and stored-evidence retrieval with a controlled provider. Its equivalent small JavaScript TaskFlow project contains a real duplicate-ID bug after deletion and an early unique `C6C_CRITICAL` source comment requiring monotonic IDs.

The run reads the file, executes a real Node test that exits **1**, edits `tasks.length + 1` to `nextId++` through the production file-edit tool, reads the changed file, executes the same real test that exits **0**, rechecks the source and retrieves the original stored read. All eight scripted tool calls have unique IDs. Read repetitions are intentional post-edit/post-verification checks; no claim about model forgetting is inferred from them. The test's subprocess adapter launches the actual Node command in its disposable workspace; it does not claim coverage of production shell authorization, which the existing permission suites exercise separately.

Three forced compactions activate and continue in **the same run**, with the early fact and failing operation ID checked in actual serialized subsequent requests. Original failing output, passing output and the applied edit remain retrievable; four explicit stored-result retrievals occur without rerunning an original operation. Exit status is checked independently of tool invocation success.

| Cycle | Before input estimate | After input estimate | Boundary wall time (ms) | Candidate input estimate | Reserved output |
|---:|---:|---:|---:|---:|---:|
| 1 | 18,383 | 11,782 | 115.65 | 2,094 | 6,144 |
| 2 | 19,090 | 12,101 | 54.34 | 2,425 | 6,144 |
| 3 | 20,780 | 13,832 | 65.14 | 2,553 | 6,144 |

Each uses one generation stage, zero corrective retries and zero duplicate executions. Wall times include controlled draft construction, database/validation and request rebuilding; they are **not model inference latency**. Actual generated output tokens and hidden reasoning are unavailable, not zero. Generation diagnostics and request byte counts are retained in JSON.

The first harness attempt intentionally forcing a short history was safely refused with `no-meaningful-reduction`. A later scripted draft omitting unresolved state alongside failed evidence was safely refused with `missing-required-data`. The final fixture supplies realistic long source documentation, respects the two protected tool rounds and includes the required unresolved diagnostic state. Neither refusal justified weakening production checks. Sandbox Node subprocess EPERM was resolved by running this fixture outside the sandbox; the initial attempt is not counted as a passing real command test.

### Continuity, incremental history and task briefs

C6-B's 16 tests passed again. Two separate below-threshold runs each completed **20 tool rounds**, performed 21 boundary checks, created no checkpoint and duplicated no operations. Actual serialized requests after rounds **5/10/15/20** retained the early fact directly, or exposed a stored source selector for the truncated tail. Paged retrieval recovered the tail without rerunning a read. Earlier failing diagnostics remain visible after later success. Separate tests recover original MCP bodies and parent-recorded child reports, enforce bounds/branch/session ownership and refuse deleted sources.

The existing full parent-loop long-horizon test completed **11 atomic compactions**, continued the same run and kept unique executed tool IDs. Its first context estimate fell from 61,046 to 4,124; later activations also reduced input, ending with 34,966 to 21,910. The separate eleven-cycle incremental fixture verifies exclusion of covered immutable archived messages/evidence, preservation of unresolved and contradictory observations, and original evidence references. Its first candidate input estimate was 1,920; cycle eleven was 2,233. Mutable current-run message IDs can recur; exclusion of already archived immutable history is a separate invariant, not a claim that every source ID disappears after its first appearance.

Fresh request-capture fixtures record complete serialized provider JSON for 1/5/20/50 historical briefs. Lifecycle tests cover active, persistent, completed, superseded, unknown legacy and transitive dependency cases, an archived assistant feature list, reopening and original brief retrieval. Leading explicit lifecycle directives remain authoritative. Completed/superseded Git requests cannot become standing authorization; dependency material is labeled historical data. Byte counts/hashes are exact; all input-token estimates remain approximate.

## Failure recovery and invariants

| Scenario exercised separately in existing suites | Result and scope |
|---|---|
| Malformed wrapper; recoverable schema | Controlled PASS; deterministic normalization or bounded correction |
| Unsupported completion claim | Controlled PASS; rejection and source-bound correction, no invented successful outcome |
| Truncation; interrupted stream; missing DONE | Controlled PASS; never normalized into successful completion |
| Temporary tokenizer failure | Controlled PASS; recovery or refusal of persistent estimates |
| Stale snapshot; user cancellation; deletion | Controlled PASS; no candidate activation from invalid source/owner |
| Permission/runtime revision | Controlled PASS; dispatch/activation invalidated |
| Model/server disconnection | Controlled PASS; simulated transport failure and real loopback transport tests |
| Insufficient protected context | Controlled PASS; safe refusal without oversized dispatch |
| Failed optional candidate | Controlled PASS only with authoritative fixture fit and state validation |
| Mandatory overflow | Controlled PASS; no optional fallback or oversized dispatch |

These results come from C5, C6-A, W2–W7, context recovery and permission suites, not real model fault injection. The separate H1 pending-approval IPC test remains cancelled as described below; broad deletion coverage must not obscure it. Failed generation preserves durable source/history. Same-run and long-horizon fixtures show no completed-operation replay. Progress watchdog tests allow virtual 300-second progressing inference; no hard wall-clock cancellation, larger limits/retries or policy changes were introduced.

## Regression and performance limits

Forty-six existing suite files plus the new coding fixture were run directly: **586 TAP-reported tests, 583 passed, two failed, one cancelled**. Two additional legacy scripts pass direct assertions without TAP counts. This is a focused backend regression run, not a whole-repository or renderer certification.

The exact existing nonpassing identities match C6-B:

1. `contextC3LiveProtection`: `status-only transition during summary generation rolls back all archival and summary writes` — expects `/Messages changed/`, receives `casual-source-changed` and the useful newer recovery explanation.
2. `workspaceBudgetVerification`: `concurrent history change during measurement invalidates without partial persistence` — expects the older session-history error text, receives the same Casual source-change explanation.
3. `h1DeletionIpc`: `H1 real tool approval pending at deletion is invalidated without command execution` — unresolved-promise cancellation. Its companion IPC test and separate H1 history suite pass.

The initial sandbox-only local transport run also failed two loopback tests with EPERM. All three `localEngineFetch` tests pass outside the sandbox. The evidence preserves both runs. No failure was relabeled as a passing unrelated test, and no baseline assertion was changed.

`npm run build` passed (8.55 seconds; existing large-chunk advisory). `git diff --check` passed. Every shared C6-B suite retained its recorded failing identity set and exit code. Relevant S1 lifecycle, agent-loop continuity, context-budget, permissions, work-log and child retention suites passed.

The JSON embeds controlled stage diagnostics, output reservations, before/after counts, completed tool IDs, full brief request captures and measured local fixture boundary times. Fixture `server-template-tokenizer` labels and fixture `usage` values must not be mistaken for real tokenizer or provider usage. No actual inference output tokens, hidden-reasoning cost, real compaction latency or model throughput was measured. There is no stage-level evidence of a slow real-model compaction to diagnose.

## Reproduction

Run from the repository, using a shell permitted to spawn disposable subprocesses and bind loopback for transport tests:

```sh
C6C_EVIDENCE_OUTPUT=/tmp/c6c-coding.json node tests/c6cAcceptance.test.cjs
C5_EVIDENCE_OUTPUT=/tmp/c6c-casual.json node tests/c5CasualRecovery.test.cjs
C6B_EVIDENCE_OUTPUT=/tmp/c6c-selection.json node tests/c6bContextSelection.test.cjs
W4_EVIDENCE_OUTPUT=/tmp/c6c-advanced.json node tests/workspaceAdvancedCompaction.test.cjs
C6B_REQUEST_OUTPUT=/tmp/c6c-requests.json node tests/fixtures/c6bRequestCapture.cjs
C6B_INCREMENTAL_OUTPUT=/tmp/c6c-incremental.json node tests/fixtures/c6bIncrementalCapture.cjs
node tests/localEngineFetch.test.cjs
npm run build
git diff --check
```

The evidence lists every other directly executed regression file, result, elapsed suite time and local log location. Temporary `/tmp/continuum-c6c` logs are session-local; the durable JSON embeds acceptance captures and regression identities.

## Remaining application-side acceptance — not executed

Do the following for Gemma, then Qwen, when sufficient independent capacity is available. Do not unload user models to create that capacity.

1. Create a separate application profile and TaskFlow directory. From this repository after building:

   ```sh
   c6c_profile=$(mktemp -d /tmp/continuum-c6c-profile.XXXXXX)
   c6c_workspace=$(mktemp -d /tmp/continuum-c6c-taskflow.XXXXXX)
   XDG_CONFIG_HOME="$c6c_profile/config" XDG_CACHE_HOME="$c6c_profile/cache" \
     NODE_ENV=production ./node_modules/.bin/electron . --user-data-dir="$c6c_profile/user-data"
   ```

   Verify the database and configuration paths point inside that profile before creating conversations. Add only the disposable workspace. Select the existing Gemma GGUF **in this profile**, use the recorded binary and a free dedicated port. Configure one parallel slot and a supported 32,768 context as a starting test configuration, with thinking disabled where supported. Repeat in another fresh profile for Qwen. Do not edit the user's ordinary profile/settings or connect test conversations to a user-owned server. Record the actual launch arguments and model path, backend build, `/props`, effective slot context, `/apply-template` and `/tokenize` responses, request `max_tokens` and thinking controls. If the profile cannot run independently, stop and record the limitation.

2. In Casual, send these as separate turns, with ordinary assistant replies between them: “Use concise replies and Celsius”; “Project beacon is TASKFLOW-C6C; deadline November 4”; “Decision: keep offline export”; “Reference docs/queue-design.md”; “Open question: should IDs survive restart?”; then “Correction: deadline is November 6, replacing November 4.” Add realistic nonessential project discussion until measured pressure reaches the configured trigger. Capture requests and resulting summary. Ask for all six retained categories, deadline and unresolved restart question. Compare the resulting summary and answer manually with the original turns; require November 6 as current and no invented answer to the restart question. Verify one ordinary dispatch of the pending request, lower post-activation utilization and at least one further cycle. Close/reopen an over-budget disposable conversation and repeat first-send recovery. Separately create protected content that cannot fit and require a useful refusal, unchanged originals and no oversized dispatch.

3. Recreate the queue source/test from `tests/c6cAcceptance.test.cjs` in the disposable project. Ask: “Inspect the queue and test, reproduce duplicate IDs after deletion, apply the smallest fix, run tests and report exact outcomes. Preserve monotonic IDs and do not publish.” Require actual failing output followed by actual passing verification. Check that the agent distinguishes a completed invocation from exit-code success and retrieves the original early `C6C_CRITICAL` finding. Use realistic long file/test outputs to reach pressure; do not alter source facts or delete history to force a pass. Require at least one checkpoint plus same-run real inference continuation. Continue to three compactions, inspect prior unresolved state, incremental source identities and evidence, and verify no completed operation IDs are replayed. Eleven real cycles are unnecessary.

4. In a separate below-threshold Workspace conversation, perform twenty distinct completed tool rounds. Inspect the serialized provider body after rounds 5/10/15/20. Include an early read fact, a fact beyond the truncation boundary, failing diagnostic, later passing test, MCP response body and parent-recorded subagent report where those tools are available. Retrieve each original with `get_recent_chat_history` using recorded `source_message_id`/`source_step_id`, `offset` and `length`; require stored reads, not rerunning the source operation. Record unavailable MCP/subagent coverage explicitly.

5. Add multiple briefs. Record IDs, then send leading directives such as `[workspace-brief #123 state=completed]` and `[workspace-brief #124 state=persistent]` using the actual IDs, followed by a new active task. Include a superseded task, unknown legacy brief and a later request referring to an archived assistant feature list. Inspect the full serialized request for active constraints/dependencies and absence of unrelated completed instructions. Retrieve original briefs via `source_brief_id`. Confirm historical Git text supplies no standing execution authority.

6. Keep the controlled replay suites for wrappers/schema errors, unsupported claims, finish=length and interrupted streams. In separate disposable application attempts exercise temporary tokenizer failure, provider disconnection, cancellation, deletion, source mutation and permission revision during generation. Require no activation after invalidation, original history preservation and no oversized mandatory dispatch. Change permissions only in the disposable test profile. Keep cancellation effective; do not impose a fixed timeout on inference that is making progress.

7. For each real attempt save exact prepared/candidate input counts, measurement provenance, reservations, provider output/reasoning usage if reported, stage count/times, corrections, history processed, before/after utilization, source retrievals and duplicate operation IDs. Save model/template identity and stream completion metadata. Require semantic retention as well as schema validity. Upgrade the verdict only after real Casual compression and real same-run Workspace continuation satisfy all acceptance invariants. Neither this procedure nor model availability itself is a passing test.

C6-C ends here. No architecture redesign or unrelated feature work is included.
