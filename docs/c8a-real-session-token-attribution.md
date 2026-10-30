# C8-A — Real-session compaction token attribution
Audit date: 2026-10-28, Asia/Dhaka. Repository baseline: `cd36852`; initial working tree clean. **Audit only: no production source, TaskFlow, live records, model configuration or checkpoint activation changed. No commit or push.**

## Findings
The 25K–29K continuation is primarily outside the working checkpoint. The four real measured continuations are 24,893 / 29,017 / 27,474 / 28,069 tokens. The recorded checkpoint-removal probes still cost 21,892 / 25,785 / 23,819 / 23,858. Two protected rounds carry large file/test results; the reconstructed currently authorized native schema set is also substantial. Worklogs and a session-owned plan were absent at all four compaction boundaries.

Qwen did **not** produce a 25K–29K summary. Saved working states are only 10,049–13,619 UTF-8 bytes. Their prose-bearing fields are 3,265–4,517 bytes, including prior retained state and provenance. Exact raw model draft sizes and generated/reasoning usage per compaction are unavailable. Much of checkpoint growth is deterministic evidence presentation, rather than expanding new research.

There are real efficiency opportunities: byte-identical user/brief duplication, generic findings that do not prevent unchanged rereads, and retained raw previews for evidence not cited by the research block. These do not establish a safe 17K continuation. **Feasibility is D for every event: insufficient evidence for an exact minimum.** Evidence strongly supports the existing fixed/protected policy as the immediate limit; claiming A, B or C conclusively would require a valid minimized request with the historical schema/runtime configuration.

## Identity and preservation
| Identity | Value |
| --- | --- |
| Workspace | `b62f8ed9-c325-4858-bdba-58f507f1e389` — testing new workspace update |
| Conversation | `f6094b50-b461-4f51-a642-ac138ba6247d` — TaskFlow — C7 Real-Model Compaction 0032 |
| Ancestry | User `3907` → assistant/active leaf `3908`; one user turn, one completed assistant turn |
| Parent run | `bb6aa4c4-99e0-4377-b964-9dbb576f5781` across all checkpoints and final answer |
| Authoritative brief | `593`, original; content equals message 3907 exactly; source coverage digest verified |
| Stored model | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` |
| Title disambiguation | One exact-title match in this workspace; workspace ID, model, ancestry and both supplied measurements agree |

The supplied model spelling says **RCQ**; the durable record says **RCO**. This discrepancy is retained explicitly. The match is supported by durable identities and measurements, not title alone. UI v10–v13 means checkpoint row IDs 10–13, not 10–13 checkpoints in this session; JSON `version: 2` is the checkpoint format version.

The application data directory was established from `${HOME}/.config/Continuum/directories.json`, corroborated by `configStore.js` and `db.js`: `${HOME}/.config/Continuum/memory_palace.db`. Live reads used Python SQLite URI `mode=ro`, `PRAGMA query_only=ON`, and read transactions. No application initializer, migration, activity installer or mutating read helper ran against live storage. Necessary session rows, schemas and selected builder inputs were copied into `/tmp/c8a-audit/disposable.db`; production builders received only this disposable connection. No private database or request body was copied into the repository.

The target session/project/messages/checkpoints/activity/brief/lifecycle/plan/steps/summary records compare byte-for-byte as structured records before and after inspection. Canonical snapshot SHA-256: `b084a1a42be8374a6672be8bb172e89d8b3ac14f08230293a19a9eb7344ce4b5`; after hash identical. This verifies the selected historical records, rather than claiming a whole live database file cannot change independently. JSON contains content hashes, counts and IDs, never raw conversation text, source contents or tool outputs.

## Available historical events
All four stored activities are completed; no failed/cancelled/deferred attempts for this conversation exist in the durable activity table. No other checkpoint rows exist for it. Unpersisted attempts cannot be ruled out. v10–v12 are superseded; v13 is current. All checkpoints have zero archived messages, one covered user-message source, and incremental consumed operation IDs inside the same in-progress assistant turn.

| UI version | Status | Created UTC | Covered operations / evidence | Archived messages | Stages | Target/status |
| --- | --- | --- | --- | --- | --- | --- |
| v10 | superseded | 2026-10-27 22:49:39 | 18 / 18 | 0 | 1 | 17,000 / exceeded |
| v11 | superseded | 2026-10-27 22:52:17 | 21 / 21 | 0 | 1 | 17,000 / exceeded |
| v12 | superseded | 2026-10-27 22:54:29 | 27 / 27 | 0 | 1 | 17,000 / exceeded |
| v13 | current | 2026-10-27 22:57:13 | 35 / 35 | 0 | 1 | 17,000 / exceeded |

Dates above are stored UTC. Activity completion spans 2026-10-28 04:49:40–04:57:14 in Asia/Dhaka. The event IDs, sequences 22–25, exact start/end timestamps, boundary operation IDs, source-version hashes, coverage digests and complete protected/covered operation lists are in the JSON.

| Version | Before | After | Saved | Reduction | Headroom to 39,744 | New rounds / ops before next | Main retained costs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v10 | 45,045 | 24,893 | 20,152 | 44.74% | 14,851 | 3 / 4 | Fixed instructions/schemas plus protected results |
| v11 | 40,839 | 29,017 | 11,822 | 28.95% | 10,727 | 3 / 10 | Fixed instructions/schemas plus protected results |
| v12 | 41,434 | 27,474 | 13,960 | 33.69% | 12,270 | 3 / 4 | Fixed instructions/schemas plus protected results |
| v13 | 42,332 | 28,069 | 14,263 | 33.69% | 11,675 | unavailable / unavailable | Fixed instructions/schemas plus protected results |

Whole before/after counts are historical `server-template-tokenizer` measurements, not estimates. Usable input 44,160 and trigger 39,744 are durable in every event. Configured approximately 45,192 and runtime approximately 45,312 are supplied observations; their exact historical capacity metadata was not persisted here. The current remembered model load config instead says 75,192. It was neither applied nor changed. The audit does not substitute that later setting into historical capacity calculations.

Generation success, activation, dispatch and continuation have separate evidence. Validated source-bound checkpoints and completed postcommit activities support generation and atomic activation; current/superseded rows alone would not prove them. `continued: true` is set immediately before fetch, so alone proves only a dispatch attempt. The accepted response usage sequence independently contains exact after-count matches: request indices 15, 18, 21 and 24 report 24,893 / 29,017 / 27,474 / 28,069. Later operations and the terminal successful response remain in the same run. No per-dispatch request bodies/timestamps were retained; this mapping is corroborated by boundary order and 31 reconstructed tool batches plus one terminal response matching 32 accepted usage entries.

Generated output and reasoning tokens per compaction are **unavailable**. The parent run’s completion token counts belong to its 32 normal requests and cannot be assigned to the separate summary-generation calls. Every event records one generation stage, not a durable per-attempt draft/usage trace.

## Historical versus retrospective measurements
No original historical serialized provider request or advertisement manifest is present in the examined storage. A completed assistant row aggregates visible prose, tool steps and usage; it is not a complete replayable request trace. Reconstructing a request is not resuming execution. The audit did not execute any saved operation or call inference.

Reconstruction used production `rebuildChatMessages`, task-brief selection, `workspaceCompactSection`, current authorized `getToolContext`, provider `sanitizeChatMessages`/system coalescing, result formatting/redaction, and the existing 20,000-character result guard. The disposable session plan and final-turn digest were excluded because they were created after the events. All original checkpoint strings are used verbatim. Each before-boundary reconstruction uses the prior checkpoint and operations not yet consumed; each after-boundary uses the new checkpoint and remaining two batches. IDs and call/result pairing are preserved.

Limits: the current 45-tool native catalog is a retrospective assumption, historical MCP advertisements are unavailable, effective custom/profile/memory inputs and repository guidelines are current snapshots, and intermediate assistant prose is not partitioned per round. The five applicable memory records predate this run but their historical injection is not separately recorded. Stored private reasoning is excluded from continuation history. No live tokenizer endpoint was contacted: an immutable matching historical runtime/template/schema identity was unavailable and the remembered capacity differs. All new counts use `contextBudget.approximateTokens` (UTF-8 serialized bytes/3, rounded up, plus 32/message); they are conservative estimates, never exact Qwen counts. The temporal anchor was generated in Asia/Dhaka on the same local calendar date, not recovered byte-for-byte.

| Version | Historical before | Reconstructed before estimate | Historical after | Reconstructed after estimate | Reconstructed after JSON bytes |
| --- | --- | --- | --- | --- | --- |
| 10 | 45045 | 49611 | 24893 | 29208 | 87047 |
| 11 | 40839 | 44794 | 29017 | 33270 | 99138 |
| 12 | 41434 | 46493 | 27474 | 32437 | 96253 |
| 13 | 42332 | 46399 | 28069 | 32061 | 95510 |

Differences of approximately 4K–5K between reconstructed and real totals are not attributed to an invented hidden component: conservative estimator/template differences, historical configuration/schema uncertainty and missing prose prevent reconciliation. JSON records all request hashes and byte sizes. No exact additive historical token partition is claimed.

### Non-overlapping accounting of reconstructed JSON
The following partition sums exactly in **bytes**, including residual JSON/merge overhead. Token columns below are byte/3 estimates with independent rounding; estimator message allowances are separate. Base system here includes safety/delegation/customization and current applicable memory context. There is no separate developer-role message. Protected-round bytes include protocol envelopes, arguments and results, which must not be added again. Brief bytes include their source-navigation text; checkpoint bytes include its retrieval/evidence metadata.

| Distinct contribution | v10 bytes | v11 bytes | v12 bytes | v13 bytes |
| --- | --- | --- | --- | --- |
| systemInstructions | 11275 | 11275 | 11275 | 11275 |
| toolSchemas | 33709 | 33709 | 33709 | 33709 |
| activeBriefs | 5234 | 5234 | 5234 | 5234 |
| checkpoint | 11160 | 11511 | 13532 | 15142 |
| protectedRounds | 21330 | 33069 | 28159 | 25810 |
| currentUser | 3935 | 3935 | 3935 | 3935 |
| worklog | 0 | 0 | 0 | 0 |
| plan | 0 | 0 | 0 | 0 |
| otherJsonAndMergeOverhead | 404 | 405 | 409 | 405 |

No session attachments, historical brief rows, separate persistent-lifecycle brief, worklog or session-owned plan were present at these boundaries. Persistent constraints are inside brief 593 and independently in checkpoint requirements. Historical plans from other conversations occur as **tool-result content**, especially `get_project_plans`, and are not counted as an injected current plan. Provider template token overhead is unavailable; reconstructed JSON overhead and role allowance do not measure it.

### Ablations — overlapping diagnostic measurements
Each variant removes exactly one named category from a disposable normalized request and remeasures it with the existing estimator. None was dispatched. Removing schemas, user text, system safety or protocol pairs is diagnostic, not a proposed valid continuation. These costs overlap and must not be summed. Source-navigation and argument/result costs are subsets of other categories. Generic production regex ablations may leave some navigation outside a named brief block; therefore whole-brief partition bytes and its block ablation differ.

| Removed component | v10 est. savings | v11 | v12 | v13 |
| --- | --- | --- | --- | --- |
| system | 4017 | 4017 | 4017 | 4017 |
| toolSchemas | 11236 | 11235 | 11236 | 11236 |
| currentUser | 1312 | 1311 | 1312 | 1312 |
| taskBriefs | 1489 | 1489 | 1490 | 1489 |
| activeBriefs | 1331 | 1330 | 1331 | 1331 |
| sourceNavigation | 657 | 656 | 657 | 657 |
| checkpoint | 3720 | 3837 | 4511 | 5047 |
| protectedToolRounds | 7239 | 11184 | 9678 | 8765 |
| rawToolArguments | 55 | 50 | 116 | 56 |
| toolResults | 6892 | 10744 | 8786 | 8320 |
| historicalBriefs | 0 | 0 | 0 | 0 |
| persistentBriefs | 0 | 0 | 0 | 0 |
| worklogs | 0 | 0 | 0 | 0 |
| plan | 0 | 0 | 0 | 0 |
| attachments | 0 | 0 | 0 | 0 |

Zero for historical/persistent brief categories means no separate matching block, not absence of authoritative constraints. The source-retrieval instructions remain necessary; their numerical ablation does not authorize removal.

## Exact saved working-state analysis
String character/UTF-8 sizes and hashes are exact for the saved representation. The recorded isolated component counts include their request/template envelopes. Importantly, activity persistence saves **only the numeric component counts**, discarding each component’s method/confidence. The event-wide tokenizer label cannot prove those isolated counts were exact; a strict template may reject a system-only or tool-only probe and force estimation. The same caveat applies to `irreducibleContextTokens`, whose own method was not saved. The whole after count remains explicitly tokenizer-measured.

| Version | Saved characters / UTF-8 bytes | Recorded isolated checkpoint count* | Recorded no-checkpoint probe* | Whole after minus probe* | Deterministic field-value bytes | Merged prose-bearing field-value bytes |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 10045 / 10049 | 3919 | 21892 | 3001 | 6433 | 3265 |
| 11 | 10422 / 10426 | 4036 | 25785 | 3232 | 5885 | 4190 |
| 12 | 12238 / 12242 | 4710 | 23819 | 3655 | 7701 | 4190 |
| 13 | 13615 / 13619 | 5247 | 23858 | 4211 | 8751 | 4517 |

*Historical recorded or derived values; component-specific methods unavailable. Do not add isolated counts to full-request totals or call their difference a certified exact tokenizer attribution. Field-value byte sums exclude outer keys/envelopes. “Merged prose” includes generated and prior retained content plus provenance; it is not the raw Qwen draft.

Per-field byte/3 estimates below are descriptive and non-additive to request totals. Empty arrays consume two bytes; zero semantic content is shown as “empty”. Exact field bytes/hashes are in JSON.
| Checkpoint field | v10 estimate | v11 | v12 | v13 |
| --- | --- | --- | --- | --- |
| objective | 47 | 47 | 47 | 47 |
| outstandingRequirements | 248 | 248 | 248 | 248 |
| decisions | 153 | 153 | 153 | 153 |
| completedWork | 255 | 374 | 374 | 374 |
| filesChanged | empty | empty | empty | empty |
| commands | empty | 62 | 62 | 171 |
| tests | empty | empty | empty | empty |
| inProgress | 64 | 64 | 64 | 64 |
| blockers | empty | empty | empty | empty |
| risks | 32 | 32 | 32 | 32 |
| unknowns | 45 | 45 | 45 | 45 |
| nextActions | 69 | 69 | 69 | 69 |
| research | 176 | 304 | 304 | 304 |
| pending | 34 | 34 | 34 | 34 |
| limitations | 74 | 74 | 74 | 74 |
| retrieval | 53 | 53 | 53 | 53 |
| evidence | 1903 | 1720 | 2326 | 2676 |
| storedEvidence | 81 | 81 | 81 | 81 |

Objective/requirements, decisions, in-progress description, unknowns and next actions remain unchanged. Research grows from two to three findings at v11, then stays identical through v13. Completed-work claims grow from two to three at v11, then stay identical. The findings mainly report that files were inspected, working changes existed, CSS selectors existed and test blocks were found; they do not preserve a feature-by-feature implementation assessment or the precise missing test. All nine requirements remain marked open. Important constraints about dependencies/runtime configuration and preserving existing changes are independently retained; they must stay authoritative even if repeated.

The evidence ledger grows 18 → 21 → 27 → 35 records. Model-facing evidence views are 14 / 13 / 19 / 21, with 12 / 10 / 14 / 16 raw previews of exactly 256 characters. None of these remaining previews is cited by the research list, so C8’s existing research-backed preview replacement does not apply. Earlier successfully summarized research references already have compact views. Some repeated completed-work sources still retain previews: resemblance to a completed-work claim alone does not prove their content has been summarized adequately. Full raw tool results are not embedded in the checkpoint; previews are partial and originals remain retrievable.

The model-facing evidence field is approximately 1,903 / 1,720 / 2,326 / 2,676 byte-estimated tokens. This deterministic catalog is the largest checkpoint field. The complete saved state grows 35.6% in bytes from v10 to v13, but its new semantic findings barely grow after v11. No prior `savedWorkingState` is nested inside a later checkpoint or worklog. Source IDs intentionally recur for continuity and provenance; repeated references alone are not unnecessary evidence.

## Protected tool rounds
Two rounds means two assistant tool-call **batches**, not two operations. Persisted thought separators delimit 31 inferred batches, and each consumed-ID boundary retains the last two. The activity anchors and 32 response usage entries corroborate this grouping. There is no durable explicit round-index manifest, so counts are marked reconstructed/corroborated, not newly invented historical counters.

| Version | Protected batches / operations | Recorded isolated context count* | Reconstructed result bytes | Largest reconstructed result | Args bytes total | All protected IDs absent from covered set? |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 2 / 2 | 7340 | 20218 | 15387 | 152 | yes |
| 11 | 2 / 3 | 11346 | 31328 | 14784 | 140 | yes |
| 12 | 2 / 7 | 9859 | 25244 | 14358 | 327 | yes |
| 13 | 2 / 3 | 8927 | 23919 | 15474 | 156 | yes |

*Individual measurement methods unavailable. Reconstructed protected-round ablations are separately estimated above. Full operation IDs, names, stored/model sizes, hashes, argument sizes and coverage checks are in JSON.

### v10 protected operations
| Operation ID | Tool | Reconstructed result bytes | Argument bytes |
| --- | --- | --- | --- |
| `VaEsSOvhzeg1JaNezXv0JbzzJBlNQyQg` | execute_command | 4831 | 78 |
| `nYjoa1yE3LoVBtdKbRryCHESUofsyGnu` | read_project_file | 15387 | 74 |

### v11 protected operations
| Operation ID | Tool | Reconstructed result bytes | Argument bytes |
| --- | --- | --- | --- |
| `y8Pqk4GuceFNiaUqtm8nweYgqVR4t3Cw` | read_project_file | 14784 | 73 |
| `VKJynSXs8mzYZTniOMXGManE3D7uue6t` | read_project_file | 8362 | 36 |
| `mlWrJB5C4on0GdBnWhP1KM6xzAK0nNg5` | read_project_file | 8182 | 31 |

### v12 protected operations
| Operation ID | Tool | Reconstructed result bytes | Argument bytes |
| --- | --- | --- | --- |
| `klPqeBPk60tkB1Vl0WJIG0mdvpOmLr2J` | read_project_file | 7030 | 47 |
| `pORnjh7GsgDXWyVNcc1DnFbr5jIO65B5` | read_project_file | 1235 | 47 |
| `CWdZFeXST8AWevCtCNQT3hYjId6va7rK` | read_project_file | 1025 | 47 |
| `BVqEjJre3Ah5my08zKrNsYVaECb0Xsr6` | git_status | 457 | 2 |
| `HfIZJus5FThQT81R7hHsuoX63SFAJRBC` | execute_command | 759 | 48 |
| `71ThGOnbkeJvWdUYzeHp2S5woGpBSh7A` | read_project_file | 14358 | 71 |
| `TJBJuNUAqHES7ykkArhZSSOGJacvkJZX` | execute_command | 380 | 65 |

### v13 protected operations
| Operation ID | Tool | Reconstructed result bytes | Argument bytes |
| --- | --- | --- | --- |
| `y60PGhuoSp3lkacNUNJp0QFX6XjCxxOm` | read_project_file | 15474 | 74 |
| `dkjNrdrDXQa8EXGcnymIsZ9aCFHem1Gm` | execute_command | 1125 | 54 |
| `lN8fYBjpHtWnXFFQbCk9uYE5Vnge1zUs` | get_project_plans | 7320 | 28 |

v10 retains a test-index command and a 703–1005 test-file read. v11 retains a 370–703 test read plus a batch rereading task logic/App. v12 retains a five-operation component/status/package batch plus a two-operation test/CSS batch. v13 retains a 700–1005 test read plus CSS excerpts and a project-plan listing. None is in flight or an unresolved mutation; their results may still be essential to deciding or editing the next step. No protected operation is already source-covered by its new checkpoint, although many paths and feature topics overlap earlier findings. Keeping these pairs remains mandatory under current policy.

No protected result crossed the engine’s 20,000-character truncation threshold in reconstruction. Large test reads reach approximately 14–15.5 KB each. Default file reads were already limited to 200 lines by the file tool; metadata reports `has_more` and `next_start_line`, not engine truncation. The compact checkpoint observations are separately capped to 256 characters. These different limits must not be conflated.

At the next checkpoint, earlier protected IDs become covered as new batches finish. Newly covered identities are 3 / 6 / 8 for v11 / v12 / v13; all prior covered IDs persist. These are distinct from 4 / 10 / 4 newly completed operations, because the moving protected boundary retains different batch sizes. Original operation IDs remain durable; nothing was replayed by checkpoint activation.

### Disposable alternatives
| Version | Current continuation estimate | Two batches with reference-only result bodies | Older checkpoint evidence with reference-only views | Without duplicate user turn |
| --- | --- | --- | --- | --- |
| 10 | 29208 | 22491 | 27740 | 27855 |
| 11 | 33270 | 22788 | 32032 | 31917 |
| 12 | 32437 | 24262 | 30738 | 31083 |
| 13 | 32061 | 24003 | 30037 | 30708 |

The protected reference-only scenario keeps call/result IDs and pairing but replaces substantive result bodies with source IDs/hashes. It saves approximately 6.7K / 10.5K / 8.2K / 8.1K estimated tokens. **It changes the two-full-round safety policy and has not been validated as a continuation.** Pair integrity is necessary but does not establish semantic sufficiency. No active or in-flight pair is proposed for removal. The checkpoint reference-only scenario is also a broad upper-bound diagnostic: uncited evidence could be essential, so 1,238–2,024 estimated savings are not all proven safe. The current two full rounds remain unchanged.

## Worklog, plan and duplication
The target’s sole digest, ID 166, was created at 23:00:11 UTC with assistant 3908’s terminal completion, after v13. The session plan was first created at 22:58:44 UTC, after v13 at 22:57:13; its steps 272–276 were updated after final tests/build. Every saved checkpoint has `plan: null`. The agent had fetched another session’s plan via `get_project_plans`, but no session-owned plan existed yet. Injecting today’s final worklog/plan into a historical request would falsely blame approximately 3.8K characters of later state.

| Duplication | Evidence | Classification | Estimated opportunity / risk |
| --- | --- | --- | --- |
| User instruction and current brief | Same 3,808-character content/hash; message 3907 and brief 593 | Intentional authority preservation; duplicate model-facing text | ~1.35K diagnostic full-turn savings; retain full brief and valid user-role stub before considering single-copy text |
| Requirements repeated in brief/checkpoint | Nine open requirements including independent constraints | Authority preservation / continuity | Do not delete user authority; no proven safe count |
| Generic completed-work/research plus evidence previews | 12–16 256-character previews; uncited by research | Some redundant state; some uncertain semantic need | Broad reference scenario 1.2K–2.0K; requires source-backed findings |
| Identical prior findings across checkpoints | Hashes unchanged for research/completedWork after v11 | Necessary continuity, not all historical versions injected | Zero proven savings from deleting old checkpoints |
| Worklog / injected plan | Absent at boundaries | No duplication to remove | 0 |
| Project plan listing repeated | Same arguments/results in early and v13 listing | Potential inefficient navigation; current plan status retrieval may be useful | No safe omission proven; listing result remains protected at v13 |

A content duplicate is not automatically unnecessary. The smallest independently testable optimization is keeping exactly one full copy of the same authoritative user text when the source-bound current brief is still supplied, while retaining a strict-template user continuation and all attachment/revision semantics. The audit does not establish that change as already safe.

## Compaction frequency and target feasibility
| Transition | New completed batches / operations | New model-result bytes / estimated tokens | Recorded total increase | Initial headroom |
| --- | --- | --- | --- | --- |
| v10→v11 | 3 / 4 | 43660 / 14554 | 15946 | 14851 |
| v11→v12 | 3 / 10 | 34274 / 11425 | 12417 | 10727 |
| v12→v13 | 3 / 4 | 38611 / 12871 | 14858 | 12270 |

No new user instruction arrived: all events belong to one user/assistant turn. Large new test/source reads consume the available 10.7K–14.9K headroom within three batches. Some of this is repeated already-read content, with new operation identities; there genuinely is newly eligible protocol history each time. C8’s unchanged-ID guard therefore correctly does not classify these as unchanged evidence. Stable semantic findings are regenerated/retained while the evidence ledger and protected window move. This explains frequency without assuming the trigger itself is wrong.

| Version | Recorded without-checkpoint cost* | Checkpoint-removal deficit to 17K | Smallest validated measured continuation | Feasibility |
| --- | --- | --- | --- | --- |
| 10 | 21892 | 4892 | 24893 | D — exact minimum unavailable |
| 11 | 25785 | 8785 | 29017 | D — exact minimum unavailable |
| 12 | 23819 | 6819 | 27474 | D — exact minimum unavailable |
| 13 | 23858 | 6858 | 28069 | D — exact minimum unavailable |

*Recorded probe, individual method unavailable. It includes instructions, schemas, active/user requirements, selected history and protected state; its name “irreducible” is a policy-retained cost, not proof every sentence is mandatory. Removing the checkpoint is not itself a valid continuation.

A strict mandatory baseline cannot be certified numerically: historical schema contents and per-component methods are missing, and semantic removal of eligible history was not validated. The smallest defensible **validated observed** continuations are the after values in the table, not theoretical minima. No valid ≤17K variant was demonstrated. A depends on a valid safe reconstruction that is unavailable; B requires a separately validated protection-policy change that this audit did not perform; C would overclaim intrinsic necessity from the probe alone. Thus D is the honest classification for each event, with strong support that current fixed and protected costs exceed the target. A practical expectation is the observed 25K–29K range for this setup; no exact lower target or trigger adjustment is justified yet.

## Agent-operation review
Six identical-argument reads returned byte-identical results after the first compaction: task logic 1–200 and 201–378, App 1–200 and 201–224, TaskItem and TaskList. They total 33,623 stored serialized-result bytes (approximately 11K byte-estimated tokens accumulated over multiple rounds, not a simultaneous post-compaction saving). All occur before this run’s first edit. Equal returned hashes support unchanged source for these ranges; they do not prove no external edit ever occurred between reads.

Classification: harmless but inefficient, plausibly encouraged by insufficient checkpoint findings. The checkpoint says files were read but leaves feature implementation and test completeness unknown. This supports a missing-information mechanism, not proof of Qwen’s internal cause. Reads of later test ranges and the 24-line App tail are necessary inspection or tool-output pagination, not automatically errors. Search/CSS verification and initial Git/package checks are reasonable. The stored tool records show no use of source-history retrieval to recover exact old results; fresh project reads may be appropriate before edits, but repeated entire inspected ranges were costly.

The agent attempted to update plan-step IDs from another session, received a scoped “no plan” error, then created its own plan. This is a plan-identity confusion, not a checkpoint activation replay; user scope guards prevented the stale update. One successful source edit occurred, then `run_tests` for npm test and build each exited 0; the recorded output reports 130/130 tests passed. This is historical TaskFlow evidence, not tests rerun by the auditor. No duplicate consequential edit/test command execution caused by compaction is visible. Repeated plan retrieval/Git status are read-only checks, not unsafe replay. Individual findings and operation hashes are in JSON without private outputs.

## Architecture review and focused verification
Reviewed W2 source-bound candidates and prior-state retention; W3 atomic promotion/rollback, paired protected window and same-run ownership; W4 incremental operation evidence; W5 durable activity projection; W6 cancellation/deletion and permission revision guards; W7 bounded generation; C6-E brief selection and source coverage; C7 evidence stages and live occupancy; C8 deterministic target refinement and exact working-state persistence. Also reviewed worklog/plan assembly, H1 session deletion checks, historical inspection scoping and tool-result truncation. This was a source-path review, not a claim every subsystem received a new integration test.

Relevant implementation anchors: `src/main/workspaceCompaction.js:29` (two batches), `:269` (exact string persistence), `:272` (component probes), `:276` (checkpoint removal), `:312` (postcommit rebuild); `src/main/workspaceCompactionActivity.js:9` (numeric-only persisted whitelist); `src/main/workspaceCompactCandidate.js:248` (prior union), `:373` (coverage integrity), `:474` (exclude prior display/ledger), `:549` (source coverage); `src/main/taskCheckpoints.js:860` (saved representation), `:875` (evidence selection/refinement); `src/main/promptBuilder.js:198` (rebuild), `:213`/`:220` (worklog/plan); `src/lib/memoryChat.mjs:710` (boundary rebuild), `:728` (dispatch), `:982`/`:1027` (paired round/result guard); `src/main/contextBudget.js:67` (estimator), `:140`/`:157` (template path/fallback); `src/main/sessionDeletion.js:5` and `workspaceCompaction.js:40` (deletion/permission guards). Source hashes are retained in JSON.

Direct deterministic execution passed **36 tests**: C8 effective compaction 5/5, C6-E lightweight context 13/13, worklog 18/18. These use disposable fixtures and mock generation/tokenizers; none calls the real model. An outer `node --test` invocation reported file wrappers, so actual assertion counts come from direct file execution. Commands:
```sh
node tests/c8EffectiveCompaction.test.cjs
node tests/c6eLightweightContext.test.cjs
node tests/workLog.test.cjs
git diff --check
```
No production build, live model inference, migration, TaskFlow test rerun or source repair was performed. JSON structural/partition/pairing/coverage/identity checks and selected-record before/after comparison passed. All four saved strings exactly match the current production renderer when its saved-string shortcut is removed. All 101 checkpoint evidence bindings resolve to original operation IDs and match their production output digest and character count (zero mismatches). The two audit files are the only repository additions.

## Ranked minimal next actions
| Rank | Recommendation | Impact | Continuity risk / complexity |
| --- | --- | --- | --- |
| 1 | Separately validate one full source-bound copy of duplicated user/brief text; retain user stub and constraints | ~1.35K estimated, modest extra headroom | Low–moderate / small; strict-template, revision and attachment tests required |
| 2 | Improve specificity of existing findings: feature/test status, source locations, inspected ranges and unresolved gaps | May avoid repeated 34KB of reads; future savings unproven | Moderate semantic risk / small targeted prompt-quality validation |
| 3 | Only then reference older successfully summarized previews through existing C8 evidence rules | Broad upper-bound ~1.2K–2.0K estimated | Moderate / small; no removal of uncited essential diagnostics |
| 4 | Persist component methods/confidence and redacted schema/batch hashes in a separate authorized task | Resolves audit uncertainty; no token savings itself | Low / small |
| 5 | Keep tool authorization, source integrity and two-full-round protection; plan around observed 25K–29K until a valid smaller continuation is measured | Honest expectation, no invented exact minimum | No policy change |

The smallest next implementation candidate is the byte-identical user/brief single-copy case with a preserved user continuation and source-bound full brief. It cannot by itself achieve 17K. The highest likely frequency benefit is avoiding repeated large reads through more useful source-bound findings; validate that separately before changing evidence policy. No automatic reduction of protected rounds, tools, authoritative briefs, output limits or source validation is recommended.

## Required final component summary
Each row says “unavailable” for missing exact historical component tokens. Parenthetical estimates are retrospective, not real-model measurements. Isolated recorded probes are not additive; potential savings are overlapping scenarios, not a safe minimum. “Other” includes the duplicated current-user text, JSON/role allowance and unavailable historical prose/template differences. Source identities: base prompt/profile/project snapshot; current schema hash; brief 593/message 3907; checkpoint row ID; listed protected operation IDs; worklog/plan absent by chronology.

### v10 — historical total 24,893
| Component | Measured tokens | Necessary? | Safely reducible? | Potential savings |
| --- | --- | --- | --- | --- |
| System instructions | unavailable (estimate 3,759) | Required safety/custom authority | No broad safe deletion proven | unavailable |
| Tool schemas | unavailable (estimate 11,237) | Authorized contracts; historical catalog unavailable | No removal of tools proposed | unavailable |
| Active briefs | unavailable (estimate 1,745) | Yes, authoritative | Preserve full active requirements | 0 proven |
| Checkpoint | unavailable; isolated recorded 3,919 (method unavailable); estimate 3,720 | Yes, validated continuity | Only after semantic/source validation | 1,468 estimated reference scenario; unproven safe |
| Protected rounds | unavailable; isolated recorded 7,340 (method unavailable); estimate 7,110 | Yes, two full paired batches | No under current policy | 0 authorized |
| Worklog | 0 — absent | N/A | N/A | 0 |
| Plan | 0 — absent | N/A | N/A | 0 |
| Other | unavailable; current-user estimate 1,312, JSON estimate 135 | User authority/protocol required | Duplicate full user text is candidate; keep user stub | ≤1,353 estimated; requires validation |

### v11 — historical total 29,017
| Component | Measured tokens | Necessary? | Safely reducible? | Potential savings |
| --- | --- | --- | --- | --- |
| System instructions | unavailable (estimate 3,759) | Required safety/custom authority | No broad safe deletion proven | unavailable |
| Tool schemas | unavailable (estimate 11,237) | Authorized contracts; historical catalog unavailable | No removal of tools proposed | unavailable |
| Active briefs | unavailable (estimate 1,745) | Yes, authoritative | Preserve full active requirements | 0 proven |
| Checkpoint | unavailable; isolated recorded 4,036 (method unavailable); estimate 3,837 | Yes, validated continuity | Only after semantic/source validation | 1,238 estimated reference scenario; unproven safe |
| Protected rounds | unavailable; isolated recorded 11,346 (method unavailable); estimate 11,023 | Yes, two full paired batches | No under current policy | 0 authorized |
| Worklog | 0 — absent | N/A | N/A | 0 |
| Plan | 0 — absent | N/A | N/A | 0 |
| Other | unavailable; current-user estimate 1,312, JSON estimate 135 | User authority/protocol required | Duplicate full user text is candidate; keep user stub | ≤1,353 estimated; requires validation |

### v12 — historical total 27,474
| Component | Measured tokens | Necessary? | Safely reducible? | Potential savings |
| --- | --- | --- | --- | --- |
| System instructions | unavailable (estimate 3,759) | Required safety/custom authority | No broad safe deletion proven | unavailable |
| Tool schemas | unavailable (estimate 11,237) | Authorized contracts; historical catalog unavailable | No removal of tools proposed | unavailable |
| Active briefs | unavailable (estimate 1,745) | Yes, authoritative | Preserve full active requirements | 0 proven |
| Checkpoint | unavailable; isolated recorded 4,710 (method unavailable); estimate 4,511 | Yes, validated continuity | Only after semantic/source validation | 1,699 estimated reference scenario; unproven safe |
| Protected rounds | unavailable; isolated recorded 9,859 (method unavailable); estimate 9,387 | Yes, two full paired batches | No under current policy | 0 authorized |
| Worklog | 0 — absent | N/A | N/A | 0 |
| Plan | 0 — absent | N/A | N/A | 0 |
| Other | unavailable; current-user estimate 1,312, JSON estimate 137 | User authority/protocol required | Duplicate full user text is candidate; keep user stub | ≤1,354 estimated; requires validation |

### v13 — historical total 28,069
| Component | Measured tokens | Necessary? | Safely reducible? | Potential savings |
| --- | --- | --- | --- | --- |
| System instructions | unavailable (estimate 3,759) | Required safety/custom authority | No broad safe deletion proven | unavailable |
| Tool schemas | unavailable (estimate 11,237) | Authorized contracts; historical catalog unavailable | No removal of tools proposed | unavailable |
| Active briefs | unavailable (estimate 1,745) | Yes, authoritative | Preserve full active requirements | 0 proven |
| Checkpoint | unavailable; isolated recorded 5,247 (method unavailable); estimate 5,048 | Yes, validated continuity | Only after semantic/source validation | 2,024 estimated reference scenario; unproven safe |
| Protected rounds | unavailable; isolated recorded 8,927 (method unavailable); estimate 8,604 | Yes, two full paired batches | No under current policy | 0 authorized |
| Worklog | 0 — absent | N/A | N/A | 0 |
| Plan | 0 — absent | N/A | N/A | 0 |
| Other | unavailable; current-user estimate 1,312, JSON estimate 135 | User authority/protocol required | Duplicate full user text is candidate; keep user stub | ≤1,353 estimated; requires validation |

## Remaining unknowns and stop boundary
Exact historical system/schema contents, MCP advertisements, per-round visible prose, template overhead, component methods, raw generated drafts, compaction reasoning usage, per-request timestamps and a validated minimized continuation are unavailable. No exact theoretical minimum or guarantee of safely fitting 17K is invented. The evidence supports fixed instructions/tool schemas plus large protected results as the main retained costs, and repeated reads as the main frequency amplifier. Checkpoint growth contributes less and is largely deterministic evidence. C8-A stops here; no C9, protection-policy change or implementation is included.
