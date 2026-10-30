# C9.1 — Semantic working-state compaction

2026-10-29, Asia/Dhaka. Production changes and deterministic verification are complete. Real Qwen extraction quality and real-tokenizer measurements remain unverified. [Machine-readable evidence](c9-1-semantic-compaction-evidence.json).

## Preservation and baseline

The initial working tree already contained C9/P1/P2 tracked and untracked work. Its complete status is recorded in the evidence JSON. Those changes remain in place. C9.1 changes only two production components: `src/main/workspaceCompactCandidate.js` and `src/main/compactionSummary.js`. Test changes are `tests/workspaceCompactCandidate.test.cjs`, the new `tests/c91SemanticCompaction.test.cjs`, and frozen baseline renderer `tests/fixtures/c91C9SummaryBefore.cjs`.

Reviewed the C7, C8, C8-A, C9, P1 and P2 reports and the candidate/evidence, checkpoint, activation, request-building and inspection paths. The initial focused C9/W2/P2 run passed before edits. Wider paired baselines use a disposable source/test copy with C9.1 changes reversed, retaining the preexisting C9/P1/P2 implementation. They are not comparisons against clean HEAD. Direct per-file execution supplies assertion identities; this environment's outer `node --test` reports file wrappers.

No live database was opened, no TaskFlow production file was changed, and no model was loaded, restarted or reconfigured. No commit, push, stash, reset or clean occurred. P2 selection, native tool contracts, MCP, permission policy, triggers, protected rounds, plans and subagents were not changed. Test databases and projects are disposable.

## Root cause and where knowledge was lost

`evidenceFor` converted each source result into its first 256 characters before generation. Even a complete successful read could therefore expose imports and comments while hiding the relevant implementation. The prompt already requested useful findings, but the model often lacked the source text needed to produce them. Assistant messages also remain bounded and are assertions rather than automatic evidence.

The projection put research, completed work, file-read activity and command outcomes together under Progress. It repeated read warnings even when a research finding already represented that read. `retainPriorState` unioned old findings by complete entry, with no explicit supported replacement mechanism. The correction prompt's 900-token instruction encouraged aggressive shortening independently of task complexity.

The path remains: original stored tool result → observation → model-drafted attributed conclusion → source/operation validation → saved structured checkpoint → deterministic Markdown → exact summary-budget gate → existing atomic activation/full-request guard.

## New generation behavior

Successful source observations now expose the complete returned text rather than a blind prefix. Existing `has_more` and truncation flags distinguish a complete returned excerpt from a complete file. Source observations exceeding the existing per-item bound are paged in 8,000-character units through the existing bounded reducer, with offsets, source identity and partial status. The existing 12-stage and reserved-generation-token limits remain unchanged. Distinct source text is not silently dropped.

Long identical text runs in generation input are represented by their text and explicit repeat count. This prevents repetitive source fixtures from exhausting the existing stage limit. Original observations, digests and source history remain unchanged; presentation encoding is labeled. Diagnostics/counts keep their existing complete parsed representation. Command observations retain C9's bounded preview; arbitrary non-diagnostic command text beyond that preview still requires historical retrieval.

Research can include an optional exact `evidenceQuote`. The validator checks that the excerpt occurs in a cited executed operation's observation. A successful source operation or an executed diagnostic failure can support an excerpt; assistant-only references, missing text, fabricated quotes and unexecuted operations cannot. Invalid excerpts trigger the existing one bounded correction and then safe failure.

The generation instructions request functions, behavior, missing functionality, test coverage and uncertainty. They distinguish inspected implementation facts from edits and test verification. Corrections now ask for consolidation within the actual budget while preserving essential knowledge, rather than imposing an unrelated 900-token target.

## Requirements and decisions

Selected authoritative briefs and persistent constraints remain independently retained by the existing brief-selection system. Requirements in the checkpoint retain their brief identities and status. Prior applicable requirements and decisions remain in internal state; untrusted source text does not become instruction authority. No verbose guidance was added to the base system prompt.

The new acceptance fixture explicitly retains restoration metadata and the prohibition on commits. It also keeps the objective, existing implementation, missing category filtering, passing tests, unrun build, current implementation step and exact next action. Natural-language completeness of arbitrary requirement paraphrases is not mechanically proven; the authoritative brief remains available independently.

## Finding validation and completed work

Markdown now separates Verified Findings, Findings and Uncertainty, Completed Work, Current Work and Next Steps where populated. A checked excerpt earns source-support status, not a claim that arbitrary prose is logically proven. Unquoted legacy conclusions remain attributed and uncertain. A read already represented by a finding does not also receive a generic read-activity bullet.

A successful read establishes inspected-source knowledge, not current working-tree identity. Unknown current revisions do not erase that knowledge. The reference guidance calls for current text when an edit needs exact context, the source changed, evidence is incomplete or current-state verification matters. No tool suppression or blanket reread prohibition was introduced.

Completion validation still requires an appropriate successful operation. Passing-test claims in research cannot rely on a file read. Explicit build-passed claims now require a successful build-related command with exit zero, including when placed in Completed Work; passing `npm test` alone cannot certify an unrun build. These checks cover known claim categories, not every possible phrasing.

## Bugs, blockers and incremental updates

Existing blockers, risks, unknowns, failed outcomes and diagnostic examples remain in the Markdown. Explicit structured failure reasons, such as an absent edit match, are retained as bounded historical diagnostic examples even if the draft omits the wording. Latest stored command outcomes remain distinct from earlier failures; original failed results stay retrievable. An edit alone cannot establish a passing test or resolved behavior. Existing passing/failing and resolution regressions remain enabled.

An updated finding can explicitly identify the exact older finding text and source through `supersedes`. Validation requires a known prior finding, a later successful same-path operation and an excerpt supported by that newer operation. Only the identified finding is replaced. Other conclusions from the same read remain, along with all original evidence and historical checkpoint versions. A later failed edit cannot supersede an older finding by borrowing its old quote. Tests cover retaining the replacement through a third compaction.

Absent an explicit supported replacement, prior findings remain conservatively retained. C9.1 does not infer arbitrary semantic equivalence or automatically erase old failures. Pending work continues to be replaced using the current draft under the existing policy.

## Token enforcement and durable evidence

The external 4,999-token gate is unchanged. The complete assembled Markdown, including headings, preface, findings and retrieval guidance, is measured through the authoritative model/template tokenizer before candidate persistence and again before activation. The probe conservatively includes template overhead and an empty user turn. Tool schemas, independent system instructions and selected briefs are excluded from this summary probe, but remain counted by the full-request guard.

Counts of 5,000 or more fail. Missing or estimated tokenizer measurements cannot certify a summary. One bounded correction is allowed; the corrected document is fully revalidated and recounted. Failed correction retains the existing checkpoint and original history. There is no final truncation, wider limit or unbounded retry. Existing Unicode, 4,999/5,000 boundaries, oversize correction, unavailable tokenizer, cancellation and full-context overflow fixtures remain passing.

All original messages, tool arguments/results, source IDs, digests, coverage, evidence records, ownership, permission revisions and activation metadata remain durable. Source observations in internal evidence can now be larger; the Markdown does not embed their catalog or raw text. Exact excerpts and supersession metadata remain internal. Historical retrieval uses `get_recent_chat_history`; completed operations are never replayed to recover evidence.

## Inspector

No UI redesign or UI production change was needed. The existing inspector displays the exact saved Markdown, stored measurement, checkpoint version and validation information, with evidence and technical details expandable. The new finding/current-work headings appear through the existing Markdown renderer. Saved checkpoints are not regenerated when opened. Legacy representations remain inspectable without migration, mutation or activation. The Electron/Xvfb Context panel regression passes; direct Node and sandboxed Electron startup are unsuitable for that harness.

## Identical-boundary comparison

The private `/tmp/c8a-audit` snapshots referenced by C8-A/C9 are absent in this environment. They were not reconstructed from the live database. The historical real-session TaskFlow comparison therefore could not be rerun.

The reproducible quality comparison uses the same saved synthetic TaskFlow source, user constraints, test result and checkpoint boundary for both variants. A frozen C9 renderer receives a deliberately generic scripted draft; C9.1 receives an excerpt-backed scripted draft through production validation. This establishes representational/validation mechanics, not the probability that a real Qwen model extracts these findings. The source finding is deliberately beyond character 256.

| Metric | C9 baseline | C9.1 |
|---|---:|---:|
| Summary tokens, UTF-8 estimate | 428 | 506 |
| Source findings retained | 0 | 2 |
| Requirements retained | 2 | 2 |
| Verified completion claims | 1 | 1 |
| Bugs/blockers retained | 0, fixture has none | 0, fixture has none |
| Specific next steps | 0 | 1 |
| Unsupported claims accepted in new negative fixtures | Not measured | 0 |
| Full request tokens, UTF-8 estimate | 500 | 578 |
| Duplicate nonempty lines | 0 | 0 |
| Retrieval source references | 1 | 2 |
| Current work represented correctly | No | Yes |

The full-request rows measure actual `runMemoryChat` serialized requests for this isolated no-tools continuation fixture. They are not full Workspace schema overhead or exact model tokens. Scripted continuation checks request construction without executing or replaying any completed operation. The test returns a scripted next action; it does not demonstrate model reasoning.

Before excerpt:

```markdown
## Progress
- src/taskLogic.js: recorded read; current revision unverified.
## Next Steps
1. Continue reviewing the implementation.
```

After excerpt:

```markdown
## Verified Findings
- restoreTask retains task metadata; category filtering is missing in the inspected revision.
## Completed Work
- Tests passed (4); build has not run.
## Current Work
- Implement category filtering.
## Next Steps
1. Implement category filtering, add focused tests, then run the unrun npm run build.
```

Both carry the no-commit and metadata-preservation requirements. Full saved examples and metrics are in the evidence JSON.

## Measurements by evidence type

- **Deterministic:** same-boundary comparison above; production source/operation validation, persistence projection and retrieval tests; summary activation boundaries.
- **Scripted model:** nine new C9.1 cases plus existing C7/C8/C9/W2/W3/P2 loops. No real-model behavior claim.
- **Synthetic tokenizer:** the comparison's summary probe reports 502 tokens through the existing test `/apply-template` → `/tokenize` adapter. It is a test double, not real Qwen certification. Boundary doubles accept 4,999 and reject 5,000/5,001.
- **Estimated full Workspace request:** the production safe-commit fixture reports 65,509 → 12,642 estimated tokens, with a 321-token synthetic summary probe. Full request and summary probes use different envelopes and must not be added as exact components.
- **P2 compatibility:** common full/compact coding loops cost 87,325 / 46,812 total estimated input tokens over six requests. Specialized loops cost 102,683 / 75,818 over seven/nine requests. The compact initial request still advertises 16 tools; specialized activation survives checkpoint rebuilding in the existing integration test. These values are fixture runs, not inference/billing measurements.
- **Real tokenizer / real model:** no measurements. No loaded model or tokenizer endpoint was contacted.

## Regression results and baseline failures

Paired direct-file selection: **29/34 baseline files pass; 30/35 final files pass**, including the new semantic suite. There are **no new failing file or extracted subtest identities**. Existing passing coverage includes C7 (15/15), C8, C9, candidate validation (55/55), advanced compaction (26/26), safe compaction (46/46), P2, E1/E2 editing, R2 pagination, task briefs, checkpoints, generation cancellation/deletion, permission isolation, source retrieval and provider serialization. The new semantic suite passes **9/9**. Detailed per-file counts and identities are in JSON.

The unchanged failures are:

1. `c6cAcceptance.test.cjs`: real coding operations across three atomic same-run compactions; sandbox command execution does not produce the expected outcomes.
2. `cloudProviders.test.cjs`: cloud POST survives GET-only fetch override; local-listener sandbox restriction.
3. `workspaceBudgetVerification.test.cjs`: concurrent history change; existing expected error wording differs from Casual recovery wording.
4. `sessionPromptWording.test.cjs`: Workspace continuity wording; existing assertion expects “get the existing plan”.
5. `recentChatHistory.test.cjs`: standalone assertion expects the stale prompt phrase “For recall, retrieve evidence”. Historical evidence retrieval itself passes the compaction/source fixtures.

The Context panel Electron/Xvfb test passes outside the sandbox. Its direct-Node failure and sandboxed Electron startup failure are harness limitations, excluded from comparable direct-file counts. Two candidate tests were updated to assert preservation-aware correction instructions instead of the obsolete 900-token phrase; their retry counts, provider usage and history-preservation assertions remain intact. No safety assertion was removed to obtain a pass.

`npm run build` passes with the existing large-chunk advisory. `git diff --check` passes. No unrelated failing test or implementation was repaired.

## Remaining limitations and real Qwen acceptance

An exact excerpt proves that the cited operation returned that text; it cannot prove every implication of a natural-language conclusion. Missing-feature claims from partial inspections, arbitrary paraphrases, contradictory findings and requirement completeness still need model judgment and, where appropriate, source retrieval. Supported explicit supersession reduces accumulation but does not solve general semantic reconciliation. Distinct large evidence can still exceed existing stage/generation budgets and safely fail. Source observations retained internally can consume more storage than C9's prefixes.

The historical real-session comparison and real-Qwen quality acceptance remain outstanding. To perform acceptance without changing the user's model configuration:

1. Use a new disposable profile/project with an already available permitted Qwen runtime and its matching template/tokenizer. Do not load or restart a model for this test.
2. Use identical saved source revisions, constraints, tool results, tests and checkpoint boundaries for C9 and C9.1. If the private C8-A fixture becomes available, use the existing copy-only audit runner; never mutate production TaskFlow.
3. Investigate restoration/metadata behavior, establish a missing filter and its relevant tests, then compact before implementation. Include a failed edit/test and a later correction so unresolved versus historical failures can be checked.
4. Capture the exact assembled summary and tokenizer probe, complete continued request, methods, source IDs, generation stages and checkpoint version. Require fewer than 5,000 summary tokens and a fitting full request before activation.
5. Ask the continuing agent to identify existing/missing features and choose the unfinished step. Check whether unchanged investigations are reconstructed unnecessarily; allow legitimate current-context reads before edits.
6. Verify historical retrieval, no completed-operation replay, requirements, failed/passing status and source revision distinctions. Repeat through edit/unverified/tested states and with permission changes, cancellation and deleted-session guards in disposable fixtures.
7. Record real-model extraction, continuation behavior and exact-token results separately from scripted tests and estimates. Opening saved versions must not regenerate or activate them.

Work stops at C9.1. No C10, schema redesign, scheduling or lifecycle refactoring was implemented.
