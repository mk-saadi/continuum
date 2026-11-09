# Conversation compaction replacement

Date: November 8, 2026 (Asia/Dhaka).

The production lifecycle is: summarize older conversation, atomically save one summary and a retained boundary, keep recent conversation, and continue the same run. Original messages, attachments and tool results remain stored and visible in ordinary history.

This replaces the implementation audited in [the original audit](auto-compaction-audit-2026-11-08.md). That audit and its evidence describe the previous implementation, not acceptance results for this replacement.

## Implementation map and phase record

| Phase | Production integration | Result |
| --- | --- | --- |
| 1. Map and contract | `conversationCompaction.js`: complete units, full-request measurement, tool-free generation, source guard and save callback | One shared core; adapters own storage and transport. |
| 2. Main chat | `promptBuilder.js` → `ipcHandlers.js` → `memoryChat.mjs` → `mainChatCompaction.js` | Workspace/casual and local/cloud enter the same owning model-request boundary. The IPC path rebuilds persisted history, preserving regeneration exclusions. |
| 3. Investigations | `subagents/contextRecovery.js`, `agentLoop.js`, existing scheduler/provider/budget modules | One summary, including bounded stages when needed. Every dispatched generation remains in the child's existing lifetime ledger. |
| 4. Migration and UI | `conversation_compactions`, existing child persistence, `ContextPanel.jsx`, `CompactionActivity.jsx` | Legacy input migrates without inference. One summary panel is available in both workspace and casual chat. |
| 5. Cleanup and acceptance | Updated deterministic production-path tests; historical snapshots outside the application bundle | Old generators, schemas, correction loops, section measurement, task-brief capture, work-log injection and idle compaction ownership are retired. Verification results are recorded below and in the companion JSON. |

The core's contract is deliberately small: supply the current request and prior summary, measure a complete request, generate one response envelope, verify that the source is still current, and atomically save the replacement. It has no tool executor, semantic evidence validator, checkpoint generator, model registry or configuration subsystem.

## Request, trigger and retention policy

Before compaction, the model gets ordinary branch history. Afterwards it gets current system/project instructions, the current durable plan, one summary, recent conversation and pending input, plus current tool schemas. Active attachments and retrieved document context remain in the request. Transient runtime warnings are conversational data rather than permanently protected instructions. A synthetic continuation user turn is added when a retained assistant/tool tail needs a user turn for strict templates.

The proactive trigger is **90% of usable input**. Usable input is effective capacity minus the application's output reservation and proportional safety allowance. An estimated input count receives an additional **5% input headroom**; the estimate remains explicitly labelled. Header budget metadata uses the same trigger calculation.

Retain the most recent complete units toward **20% of usable input**, with a minimum of two units and a ceiling of half the available units. This ceiling lets a small conversation still reduce history when instructions or tool schemas occupy most of the window. An assistant tool call and all its results form one indivisible unit. The current run's earlier settled rounds are eligible; the entire open assistant row is not protected indefinitely.

A summary reserves **10% of effective capacity, bounded to 64–2,048 output tokens**. Ordinary continuation requests keep their configured output limit. The existing reservation is `max(output, reasoning)` plus `min(128, ceil(capacity / 100))` safety tokens; reasoning is not reserved twice. The default output allowance, when no positive cap is supplied, remains the application's existing capacity-relative default. Provider serialization determines cloud-specific output fields.

There is no minimum percentage saving. Every committed replacement must be strictly smaller and fit the effective request budget. Proactive failure can defer while the original still fits. The unchanged rejected source/request/capacity is remembered for the owning run or child, preventing repeated automatic generation. An explicit confirmed-overflow recovery can make one fresh attempt.

## Counting and transports

Local requests reuse runtime capacity discovery and template/tokenizer measurement when available, with the established labelled full-request estimate otherwise. Effective capacity honors a lower configured user ceiling. Capacities are reread when preparing subsequent requests.

Cloud requests use the actual provider serializer and its complete-request estimate. Provider model metadata already incorporates user context overrides. Unknown metadata uses the existing conservative fallback rather than introducing a blocking counting service. Cloud compaction never requires `server-template-tokenizer`. Children refresh the selected model's applicable capacity without resetting their lifetime token, request or shared tool allowances. A reported smaller overflow window bounds the recovery request.

Both transports classify known context-overflow responses and allow one compaction-and-retry for that request. A second overflow stops. Recovery rebuilds inference context only; it neither re-appends the user's message nor executes completed tools again. Main compaction runs between settled model rounds. Child compaction runs after scheduler settlement, outside the occupied inference lane.

Cached input occupies context. Provider-reported usage is retained through the existing accounting paths. Main summary attempts are recorded separately in `compaction_generations`, including failed/unknown attempts and reserved output. Reported input/output counts also enter normal token history. A returned summary request and a committed compaction are distinct counters. Children charge successful, rejected, interrupted and staged requests to the same existing lifetime ledger, and preserve request, input and output allowance for resuming or reporting. Once a child starts compaction, request and shared tool reservations are saved before dispatch; response settlement is saved immediately. A failed pre-dispatch accounting write prevents the effect, while a failed later summary write retains the already charged usage.

## Generation and coverage

The normal case is one ordinary, tool-free Markdown generation using the selected conversation model. Its prompt asks for the objective, applicable constraints, decisions and rationale, necessary completed work, active work/blockers, important exact details, pending questions and next actions. It gives newer corrections precedence and asks the model to consolidate the previous summary and remove obsolete state. It treats all supplied history and results as data.

Staging selects the largest fitting disjoint prefix of complete units using complete-request measurements. Coverage advances only after a complete response. No source is skipped or silently truncated. An oversized legacy summary can be fed through bounded, Unicode-safe summary fragments before the new conversation units. Media stays in native input parts rather than being serialized as base64 text.

Empty, tool-calling, interrupted and output-truncated responses cannot commit. There are no wording corrections, mandatory citations, evidence unions or separate checkpoint requests. A single historical tool round that cannot fit even by itself causes an explicit deferred/failure result; its raw history remains intact. There is no silent partial-coverage success.

## Durability, branches and restart

Main state consists of one summary, source-path fingerprints and the retained wire tail in one SQLite row. The source includes the active run's partial assistant row. Its completed-step boundary and content boundary let later settled rounds, final prose and background-result updates rejoin context after restart. Source paths and variant identities prevent an unrelated branch from reusing a summary. Regeneration excludes summaries that covered the replaced reply. The owning run is bound to its original branch before asynchronous work begins.

Generation rechecks cancellation, source identity, ownership/configuration and request fit before committing. Summary/boundary persistence is atomic. A failed write preserves the original history and does not report durable success. Main activity records show compacting, completed, deferred or failed. Cancellation prevents continuation.

Children persist summary, boundary, retained context, original raw records and accounting through the existing child persistence transaction. A failed compaction or migration write restores the prior projection; charged generation usage is not rolled back. Raw identities are reattached after restart using the retained boundary, avoiding duplicate records or matching a repeated old signature from the summarized prefix. Execution-only stop instructions expire on continuation; raw records remain available.

`read_child_history` retrieves a bounded page from that child's own raw integer IDs, with offset pagination. It accepts no parent, sibling or arbitrary session selector. The normal advertised-schema validation, ownership check and lifetime/shared tool counter gates still apply. Trimmed results advertise their own original raw ID, preserving valid JSON where applicable.

## Migration

Opening or rebuilding an old chat requires no model call. A legacy rolling summary and branch-applicable workspace checkpoint become input to the single summary representation. Archive flags identify the old covered prefix, but no old message is rewritten. If no usable prior artifact exists, all original branch history remains available. Checkpoints anchored to an unrelated branch are excluded.

Legacy child summary/checkpoint representations consolidate into one persisted summary projection even for short or compaction-disabled children. This representation migration spends no inference and does not reset compaction versions, lifetime budgets or shared counters. Later model compaction replaces that migration input with one new Markdown summary.

Old tables, brief records, tool evidence, inspection records and archive flags remain for compatibility and scoped retrieval. New requests and edits no longer create task briefs, and chat completion no longer creates compaction work logs. Prompt construction does not inject either. Original messages remain ordinary chat history. Historical inspection helpers remain available for old records; active generation never calls their evidence validators.

## Verification and limitations

The companion evidence JSON records exact commands, file-level suite results, baseline comparison and unresolved failures. Deterministic tests use scripted model responses and explicitly synthetic measurements; none are presented as real tokenizer certification.

Active coverage includes all six local/cloud main/child combinations; workspace and casual long runs; repeated child compaction; staged and unsuccessful usage accounting; previous-summary consolidation; retained corrections; tool pairing; real temporary-project read/edit/test/retrieval operations; single overflow recovery and second-overflow stop; cancellation; source mutation; failed persistence; branch/variant exclusion; migration; disabled compaction; restart; isolated raw-history retrieval; and rendered UI status/session races.

The separate-process child restart test passes when localhost test-server permissions are available. The rendered summary panel and activity tests require Electron window/process permissions; sandbox-only launch errors are recorded separately from assertions.

Live-model acceptance is unverified: no running local model server was available, and paid cloud inference was not used. The complete repository has pre-existing failing suites; this change does not claim a globally green repository. Summary fidelity is delegated to the selected model, so deterministic lifecycle acceptance does not certify every model's summaries. Oversized indivisible historical units and oversized protected instructions/tools/attachments can still require reducing the request or starting a new conversation; originals are retained.

### Recorded results

- Final replacement acceptance: **39/39 suites, 520 assertions passed** (`node scripts/audits/compactionAcceptance.cjs /tmp/compaction-focused-final.json`). This includes the actual temporary-project coding exercise, child process restart, and permission-isolation integration.
- Full repository run: **270/312 files passed**, with 42 failing (`node scripts/audits/compactionAcceptance.cjs --all /tmp/compaction-all-final.json`). It exposed a child permission-snapshot regression; that was fixed and its suite passes in the final acceptance run. The **41 remaining failing suites also fail at baseline**; no newly failing suite remains unresolved. The broad run was not repeated after the permission fix.
- Untouched baseline: **286/338 files passed, 52 failed**, including both CJS and ESM suites. Totals differ because dedicated retired-behavior suites are preserved as inert historical snapshots, while replacement suites are active. Compare file identities, not total counts.
- Production build passed. The existing Vite chunk-size warning remains.
- Both rendered Electron checks passed: `tests/contextPanel.ui.cjs` and `tests/compactionActivity.ui.cjs` (run under `xvfb-run`, with `ELECTRON_RUN_AS_NODE` unset and local Electron process permissions).
- `git diff --check` passed. No live model or paid provider acceptance was performed.

The [companion evidence](auto-compaction-replacement-2026-11-08.evidence.json) contains file-level results, failing assertion excerpts, baseline comparison, UI assertions and production source hashes. Historical tests are mapped to current lifecycle assertions in `scripts/audits/historical-compaction/README.md`.
