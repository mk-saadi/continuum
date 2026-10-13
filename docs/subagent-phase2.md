# Phase 2 — child-context compaction report

Implemented 2026-10-13, Asia/Dhaka. Phase 2 only. No commit, push, reset, stash, Phase 3 UI, or parent delegation-guidance changes. Phase 0 artifacts and Phase 1 evidence are unchanged; existing dirty-tree work was preserved. The starting run reconfirmed the Phase 1 baseline rather than assuming it.

## Architecture audit and extraction

Primary compaction path remains `main.js` callbacks → `ipcHandlers` idle/overflow wiring → `compressionEngine.checkAndCompressContext` → DB snapshot/lock → oldest eligible primary message rows (last ten protected) → rolling summary → Workspace checkpoint validation → projected full-prompt fit → atomic archive/summary/checkpoint commit. Workspace retains branch-aware task briefs and execution-step evidence. Casual chats use the same summary engine without Workspace checkpoints. Parent `runMemoryChat` retains paired live tool interactions separately from the rebuilt historical prefix, avoiding side-effect replay.

The primary idle trigger still uses stored `getContextUsage` at >75% and targets 65%; its estimate excludes some real prompt overhead. Forced recovery projects instructions/brief/checkpoint/tools/tail/output reserve and can measure through `/props`, `/apply-template`, `/tokenize`. It preserves old rows, refuses bad/no-saving candidates, validates identity/evidence at commit, and fails closed on protected floors. Primary DB/session/UI/local callback coupling remains in the existing engine wrapper, not copied into children.

Extracted only shared candidate generation and canonical prompts: `compactionCore.summarizeCandidates`, `generateCheckpoint`, existing checkpoint validator/renderer and the adapter engine's pressure/fit/commit pipeline. The primary caller now invokes these helpers with the same options and transaction predicates. Child `contextRecovery.createChildContextAdapter` enters the existing compression entry point with its own transcript adapter; this branch never acquires a parent-session DB lock or uses parent memories/briefs/leaf pointers. The old independent child-local prose-only recovery was removed.

| Changed file | Reason |
| --- | --- |
| `src/main/compactionCore.js` (new) | Shared Workspace summary selection, checkpoint candidate generation, prompt constants and adapter pressure/fit orchestration |
| `src/main/compressionEngine.js` | Reuse extracted helpers; add independent transcript-adapter entry branch; preserve primary persistence/lock/revalidation |
| `main.js` | Reference identical extracted Workspace prompt strings rather than duplicated literals |
| `src/main/taskCheckpoints.js` | Inject child-local message-existence lookup; retain primary DB lookup by default |
| `src/main/subagents/contextRecovery.js` | Independent raw/active child adapter, pair validation, pinned instructions, selected-provider drafts, targeted excerpts, pressure measurement and safe commit |
| `src/main/subagents/agentLoop.js` | Pre-request compaction; raw-before-projection recording; one post-slot overflow retry; recheck reporting/shared ceilings after compaction |
| `src/main/subagents/executionBudget.js` | Defer guarded-transport input/context admission to its actual measurement; retain all existing counters/reservations |
| `src/main/contextBudget.js` | Mark confirmed overflow and recognize known compatible/cloud codes without changing primary retry bound |
| `src/main/cloudProviders.js`, child local/cloud providers | Narrow error-response classification hook and child confirmed-overflow errors; selected transport remains unchanged |
| `src/main/db.js`, child `persistence.js` | Nullable raw/active/compaction history fields, idempotent migration and safe-boundary upserts |
| child `index.js` | Bounded raw/active inspection previews and compaction event metadata |
| `tests/subagentCompaction.test.cjs` (new) | 26 deterministic compaction/isolation/accounting/provider/retention tests |
| `tests/contextDispatch.test.mjs` | Replace old prose-only child recovery assertions with pressure-driven shared checkpoint/raw-history expectations; keep parent tests |
| `docs/subagents.md`, this report, `subagent-phase2-evidence.json` | Current architecture, policy, exact validation and live-resumption evidence |

## Current behavior

Exact-measured request pressure triggers at 78%; estimated pressure at 75%, including real instructions, schemas, history, next output and margin. Local exact measurement is attempted near pressure; cloud/unknown capacities remain labeled estimates/fallbacks. No interval trigger or new setting. Existing selected-model/global compactionEnabled is honoured. The adapter preserves all permanent instructions/user constraints and two recent complete tool rounds, carries prior summary/checkpoint forward, validates evidence against its own raw IDs, and refuses dropped essential prior entries. It requires safe prospective fit and max(128 tokens, 10%) savings before committing.

Summary/checkpoint drafts are two tools-disabled generations, capped at 512/1024 output tokens, using the same child's scheduler/model/provider and lifetime budget. Their output room plus at least 256 for resumed/reporting work must fit, and three request slots must remain. Completed tools are never executed during reconstruction. Confirmed overflow gets one compact-and-retry outside the held inference slot; a second overflow/non-compressible tail returns truthful partial/failure. Generic provider errors are not guessed to be overflow. Failed generation/validation never changes active state; failed compaction is not retried through another finalization summary.

Tool results are recorded in raw history before targeted model projection. Small outputs stay intact; large results retain structured metadata, head/tail and task/error/value snippets, with explicit omission notice. Native upstream caps remain authoritative. Raw means the native result actually returned, not unlimited original files. Newest-first checkpoint evidence requests are bounded; full raw evidence remains available to validation. Summaries can be semantically imperfect even when schema/references validate; fixture oracles and future live follow-up remain necessary.

Raw full turns, active full context and compaction state are stored separately in the child's own subagent_runs row. Existing turns_json remains a capped inspection preview. Version/fingerprint checks and cancellation protect commits; two child records and the parent have independent state. Storage writes are best-effort as before; jobs still do not recover across restarts. Compaction adds no token/request/tool/aggregate refill. The 40-call aggregate and eight-request Automatic investigation policy remain unchanged and unoptimized by live evidence.

## Executed validation

- Starting host: `node --test tests/*.test.cjs tests/*.test.mjs` — 659 tests, 627 passed, 32 failed.
- Final host, same command — 685 tests, 653 passed, 32 failed; identical failing names, no new or resolved baseline failures.
- New deterministic suite: `node tests/subagentCompaction.test.cjs` — 26 passed, zero failed. Existing test-runner behavior may wrap CJS files as file-level entries in restricted runs; this direct command records actual case counts.
- Focused: `node --test tests/subagentCompaction.test.cjs tests/subagentReliability.test.cjs tests/subagentBudgets.test.cjs tests/subagentRuntime.test.cjs tests/subagentTranscript.test.cjs tests/subagentStreaming.test.cjs tests/contextCompaction.test.cjs tests/contextOverflowRecovery.test.cjs tests/compressionLifecycle.test.cjs tests/contextDispatch.test.mjs` — ten test-file entries passed, zero failed.
- `npm run build` — passed; existing chunk-size warning. `git diff --check` — passed.

Deterministic coverage includes pressure before overflow, repeated compactions with retained early values/actions/pending work, valid pairing, parent/child isolation, concurrent adapters, cloud metadata/model routing, selected-model disable, JSON/SSE budget regressions, summary/checkpoint failures, incomplete protocols, cancellation, insufficient token/request reserves, Unicode excerpts, bounded evidence requests, durable raw versus active context, one classified overflow retry, and no tool replay. A running child fixture crosses pressure at least twice, then completes with early findings and nine tool executions exactly once. These are mocked results, not live model measurements.

The same 32 pre-existing failures remain: incomplete Electron/mock migration setup, outdated streaming assertions, and existing attachment/UI/MCP/message/RAG failures. Their names/locations and before/after counts are retained in the JSON evidence. No unrelated failing assertions were repaired. Browser interaction was not validated.

## Live blocker and review

No live acceptance ran. Host process/listener inspection showed Continuum but no loaded inference process/listener; default endpoint health failed with curl exit 7. This does not claim that every remote provider is unavailable; cloud live credentials/transports were not exercised. No substitute model or fabricated benchmark result was used. The detailed twelve-file fixture, settings, prompt, oracle criteria and recordkeeping steps are in docs/subagents.md. All Phase 0 live rows remain unexecuted.

Before Phase 3, review actual provider limit adherence, 75/78% pressure thresholds and estimation confidence, draft fidelity/caps, protected checkpoint growth, raw-history storage, the unchanged 40-call parent ceiling and request reporting reserve. Broad audits can still hit independent tool/turn/token limits after compaction; context reduction is not a budget extension. Shared checkpoint caps deliberately stop rather than lose essential state. Recognition of unknown provider overflow shapes and durable job recovery remain limitations. No Phase 3 work was started.
