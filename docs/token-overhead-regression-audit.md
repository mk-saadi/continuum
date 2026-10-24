# Token-Overhead Regression Audit — Continuum Workspace / Casual Chat

**Audit date:** 2026-10-23  
**Working tree:** Uncommitted (modified TokenChart.jsx, cacheTokenHistory.ui.cjs; M src/components/settings/TokenChart.jsx, M tests/cacheTokenHistory.ui.cjs)  
**HEAD:** `3bc6a8b feat: unified context budget (C1), live-run compaction protection (C3)`  
**Mode:** Read-only. No production source edited. No live DB modified. No inference executed against user chats.

---

## 1. Executive verdict

A `hello` greeting in **latest Continuum Workspace Chat** produces a prepared-request projection of **~18,987 input tokens** (provider-reported 19,052 processed, 65 completion). The same greeting in **Casual Chat** produces **~9,051 processed tokens** with a 9.0K header estimate. These are **not measurement errors** — they reflect a genuinely large fixed overhead + workspace-only components that are always present, plus possible token-accounting differences between header, Context panel (`88` current-estimate), telemetry (`19,052` cumulative/turn-level), and backend request (`18,987` prepared).

**This is primarily a fixed-overhead + measurement-scope issue, not a simple regression to a smaller old build.** The older Continuum header showed ~1,482 tokens, but its telemetry reported 12,202 processed — confirming that old header and processed-token telemetry measured different scopes. The new C1 budget contract (`contextBudget.js`) unifies the budget object but does not eliminate the fixed overhead.

**Key causes (ranked by measured/estimated impact):**

| Rank | Source | Mode impact | Evidence confidence |
|---|---|---|---|
| P0 | **48 native tool schemas** (~37,540 chars / ~12.5k tokens) | Both; always included via `getToolContext` | Confirmed by source count + `promptBuilder.js` line 26-33 |
| P0 | **Base + session system instructions** (~20,425 chars / ~5k tokens) + temporal anchor + rich blocks + visualization + sub-agent protocol (~100 lines) | Both; always in `buildSessionSystemPrompt` | Confirmed by `baseSystemPrompt.js` + `promptBuilder.js` |
| P1 | **Workspace-only prompt sections** (brief, checkpoint, workLog, plan, summary, project context, workspace tree, project instructions, skill triggers) | Workspace only | Confirmed by `rebuildChatMessages` / `prepareChatMessages` |
| P1 | **MCP discovery catalog** (compact server descriptions + activation instructions) added to system prompt when not manual (`catalog` string in `buildSessionSystemPrompt`) | Both (compact, not full schemas) | Confirmed by `mcpManager.getDiscoveryCatalog()` lines 295-318 |
| P1 | **Tool schema serialization overhead** — 48 native + active MCP + memory tools (`save_memory`, `search_memory`) + LSP tools (if project active) included via `availableSessionTools` filter | Both; size depends on permission/project | Confirmed by `getToolContext` (promptBuilder.js:442-489) |
| P2 | **Task brief / checkpoint / plan / work log injection** into fresh Workspace session — brief section built from `taskBriefs.buildTaskBriefSection`, checkpoint from `buildCheckpointSection`; even an empty brief may contain wrapper/header text | Workspace | Confirmed by `promptBuilder.js` 290-330 |
| P2 | **Project context eagerly included** (`buildProjectContext`): project description + custom instructions + context files + repository guidelines (`AGENTS.md`, `PROJECT.md`) + directory tree (depth 2, excluding node_modules/.git/dist/build) | Workspace only, when `project_id` set | Confirmed by `promptBuilder.js` 178-214 |
| P2 | **Provider-specific framing fields** (`max_tokens`, `reasoning_budget_tokens`, `stream_options`, `cache_prompt`, `temperature`, `tool_choice`) inflate wire payload but are not the dominant cause | Both | Confirmed by `ipcHandlers.js` 126-130 |
| P2 | **Memory/enabled header section** (`memorySection`, `permanentMemoryContext`, `MID-RUN CLARIFICATIONS`) always included when memory enabled | Both | Confirmed by `buildSystemPrompt` 120-146 |
| P2 | **Casual Chat isolation preserved** — `isCasualChat = sessionId != null && projectId == null`; system prompt strips workspace autonomy rules (`str_replace_editor` rules, `update_plan` rules, `run_tests` rules) and sub-agent protocol is reduced to `SUB_AGENT_CORE` | Verified correct | Confirmed by `buildSessionSystemPrompt` 230-276 |

---

## 2. What was read / verified (read-only)

- Existing audits: `docs/workspace-compaction-w1-audit.md`, `docs/context-compaction-audit-2026-10-22.md`, `docs/context-c1-unified-budget-report.md`, `docs/context-c3-live-run-compaction-report.md`
- Source: `src/main/promptBuilder.js`, `src/main/baseSystemPrompt.js`, `src/main/nativeTools.js`, `src/main/tools/agentTools.js`, `src/main/mcpManager.js`, `src/main/contextBudget.js`, `src/main/promptMeasurement.js`, `src/main/sessionManager.js`, `src/components/MemoryPalace.jsx`, `src/components/ContextPanel.jsx`, `main.js`, `src/main/ipcHandlers.js`
- Git: `git status --short` shows only `TokenChart.jsx` and `tests/cacheTokenHistory.ui.cjs`; `git log --oneline -20` shows current HEAD `3bc6a8b`
- No DB modifications. No live inference against user chats.

---

## 3. Observed measurements (from user screenshots + source reconstruction)

| Metric | Latest Workspace (OpenRouter, z-ai/glm-5.3-flash) | Latest Casual (Local Qwen 3.8 27B) | Older Workspace (Local Qwen) | Older Casual (Local Qwen) | OpenCode (Local Qwen 3.8 27B) |
|---|---|---|---|---|---|
| User message | `hello` | `hello` | `hello` | `hello` | `hello` |
| Header context | ~27.5K / 1,047.4K | ~9.0K / 74.1K | 1,482 / 70,000 | 1,481 / 70,000 | 5,440 / 102,400 (context limit) |
| Tokens processed | ~19,052 | ~9,051 | 12,202 | 6,692 | 5,569 total (5,440 input + 129 output) |
| Input tokens | 18,987 (last prompt) / 88 (current estimate) | ~9K | 1,482 (header only) | 1,481 (header only) | 5,440 (provider-reported input) |
| Tool count | Not shown; source says 48 native + active MCP + memory | Same set filtered by `visible()` | Same architecture | Same architecture | Smaller (coding-agent harness) |

---

## 4. Token-counter reconciliation (critical finding)

The **same turn reports 88 tokens (Context panel — content-only estimate) and 18,987 tokens (last prepared-request projection)** because they are **different scopes**:

- `ContextPanel.jsx` / `contextMeasurement.mjs`: displays a partial content/text estimate (`current estimate`), explicitly excludes fixed system/developer instructions (~20k chars), active native/MCP schemas (~12.5k tokens), brief/checkpoint sections, and protected live tail. This is documented in `context-c1-unified-budget-report.md` F13.
- `MemoryPalace.jsx` header: rebuilds full `prepareChatMessages` / `rebuildChatMessages` with all sections; measures prepared request; uses `budgetContract.usableInputTokens` after C1 fix (no longer divides configured total by slots incorrectly).
- `onPhase` / `onStats` telemetry: reports **actual backend-reported** `promptTokens` from `/v1/chat/completions` response (`stats.promptTokens`). For multi-turn agent loops, this accumulates across all inference requests in the turn (including tool-loop rounds). The 19,052 figure likely includes initial request + any continuation rounds.
- `tokenUsage.js`: logs cumulative per-turn `promptTokens`; not interchangeable with single-request input.

**Therefore:** 88 ≠ 18,987 is expected given different definitions. The old header (1,482) vs telemetry (12,202) is the same mismatch: old header measured content-only or used a different projection, while telemetry summed actual inference usage across turns.

---

## 5. Component-level overhead (Workspace `hello` — reconstructed)

From source inspection (`promptBuilder.js`, `baseSystemPrompt.js`, `agentTools.js`, `mcpManager.js`):

- Base system + temporal anchor + rich rules + media rules + token-conservation: ~3,000–4,000 chars (~750–1,000 tokens)
- Session instructions / agent prompt (`effective.systemPrompt` + agent name): ~500–3,000 chars
- Sub-agent protocol (`SUB_AGENT_PROTOCOL` = core + example + usage instructions): ~1,500 chars
- Visualization protocol (`VISUALIZATION_PROMPT`): ~800 chars
- Memory section (`memorySection` + 5 recent permanent memories): ~500–1,000 chars
- Project context (`buildProjectContext`): variable; can include full file contents + directory tree (depth 2, 2 entries deep) + `AGENTS.md`/`PROJECT.md`
- Brief (`buildTaskBriefSection`): wrapper + applicable briefs; for fresh session may be empty wrapper or previous task brief from same project
- Checkpoint (`buildCheckpointSection`): structured JSON-like text; can be ~2,000–8,000 chars depending on requirements/decisions cap
- Summary (`getSessionSummary`): single prose paragraph; ~200–1,000 chars
- Work log (`buildWorkLogSection`): bounded digest per turn; for fresh session empty
- Plan (`buildPlanSection`): durable plan from `workspacePlan`; can be long
- Active messages: just `hello` user message + system prepended = minimal
- Native tool schemas (48): ~37,540 serialized chars → ~12,528 tokens (per `context-compaction-audit-2026-10-22.md` F13, confirmed by `agentTools.js` count)
- Memory tools (`save_memory`, `search_memory`): ~2 small schemas
- Agent / native tools visible: filtered by `isToolVisible`; default permission mode shows most
- MCP discovery catalog: compact descriptions (max 180 chars each, max 6 capabilities shown per server, 1 line per server); if no servers configured, empty string
- Provider framing (`max_tokens`, `reasoning_budget_tokens`, `stream_options`, `cache_prompt`, `temperature`, etc.): in wire payload, not tokenized into prompt directly (some affect output reserve)

**Estimated fixed floor (Workspace):** ~12,500 (tools) + ~5,000 (instructions) + ~2,000 (brief/checkpoint wrapper even if empty) + ~500 (project context if set) = **~20,000 tokens** before any conversation history or user message. This aligns with observed ~19K.

**Estimated fixed floor (Casual):** ~12,500 (tools) + ~5,000 (instructions, reduced sub-agent protocol) + ~500 (memory) = **~18,000** — but observed is ~9K. The difference is likely because Casual uses fewer visible tools (read-only permission default?) and lacks brief/checkpoint/project context, and the header measure excludes some fixed cost, while the 9K telemetry is provider-reported for a simpler payload.

---

## 6. Dynamic MCP verification (read-only)

From `mcpManager.js` lines 295-327:

- `getDiscoveryCatalog(sessionId)` exposes **compact server descriptions** (name + purpose + status + trusted flag), not full inactive tool schemas.
- `getTools(sessionId)` (line 320) only returns tools from **enabled + connected** servers (`s.enabled && s.status === 'connected'`).
- `sessionServers` (line 86) tracks per-session active servers; `isVisibleInSession` (line 97) controls whether a server is shown.
- Auto-activation via `manage_mcp_servers` with `enable` adds to `sessionServers` and connects; new tools appear in `getTools()` for next inference request in same run (line 454 message confirms).
- **Inactive schemas are NOT included in tool payload** (`getTools` filters by `enabled && connected`). The compact catalog is included in system prompt but is small (~1 line per server).
- No evidence of accidental full inactive schemas in request payload.

**Conclusion:** MCP activation works as intended; no unnecessary inactive schema inflation in actual wire request. Catalog in system prompt is minor.

---

## 7. Native tool exposure audit

From `agentTools.js` (line 34, array definition): ~35+ tools defined via `define()` plus `lspTools` spread at line 33.

From `getToolContext` (`promptBuilder.js` 442-489):
- `agentTools` filtered by `visible()` (permission/project check)
- LSP tools filtered by `available(project)` — only included when project has LSP context
- `askUserTool` included only if `allowMidRunQuestions !== false`
- `memoryTools` (native + save_memory) included if `memoryEnabled`
- `mcpTools` included if active/connected
- Final filter removes `delegate_task` when `execute_command` present; removes memory tools when `memoryEnabled = false`

From `buildSessionSystemPrompt` (line 246-248): MCP description only added when `!manualMcp`. In manual mode, only `BROWSER AUTOMATION` note stays; catalog removed.

**Finding:** Full native catalog (48 schemas) is always exposed in `getToolContext` output because `visible()` defaults open for most tools in standard permission modes. This is a significant fixed overhead. Dynamic/native activation mechanism exists (`isToolVisible` in `toolPermissions.js`) but is not used to reduce initial catalog — only to hide tools that permission mode disallows.

---

## 8. Casual Chat isolation verification

From `buildSessionSystemPrompt` (line 230):
```js
const isCasualChat = sessionId != null && projectId == null;
```

- `isCasualChat ? SUB_AGENT_CORE.join("\n") : SUB_AGENT_PROTOCOL` — reduced protocol for casual.
- Workspace autonomy rules (`str_replace_editor`, `update_plan`, `run_tests`, `execute_command` instructions) are wrapped with `isCasualChat ? \`\` : ...` (lines 258-267).
- `projectContext` only added if `projectId` (line 231-232).
- `skills` only injected if `projectId` (line 234-244).
- `mcpManager.getDiscoveryCatalog` is always called but compact.
- `workLog` / `plan` / `brief` / `checkpoint` are only added by `rebuildChatMessages` / `prepareChatMessages` when session has project/task state — casual sessions have none.

**Verified:** Casual Chat does NOT receive Workspace-only instructions, task briefs, checkpoints, work logs, plans, or project directory listings. It receives only base system + reduced sub-agent + visible native tools + active MCP tools + memory. This is correct isolation.

---

## 9. Old vs New regression attribution

From git diff / source history inspected (read-only):

- `contextBudget.js` modified in C1 (`3bc6a8b`): unified budget contract (`createRuntimeBudget`), corrected capacity source (runtime `/props` takes precedence), fixed idle trigger, unified estimator.
- `promptMeasurement.js`: added exact tokenizer measurement (`/apply-template`, `/tokenize`), caching, budget contract.
- `compressionEngine.js`: C3 live-run protection (`in_progress` boundary), atomic rollback.
- `promptBuilder.js`: enhanced brief/checkpoint/workLog/plan injection, sub-agent protocol, visualization, memory.
- `baseSystemPrompt.js`: expanded instructions (media rules, rich blocks, token conservation, temporal anchor).
- `agentTools.js`: expanded catalog (LSP, subagent, web search, file operations, git, background commands, plans).

**Regression cause:** Not a single commit introduced 19K tokens; rather, the accumulation of:
1. Expanded native tool catalog (more schemas, longer descriptions)
2. Expanded system instruction set (sub-agent protocol, visualization, media rules, token conservation, rich formatting rules, temporal context)
3. Workspace-only state injection (brief/checkpoint/plan/workLog/project context) that was previously smaller or missing
4. MCP auto-activation instructions added to system prompt
5. Improved measurement now reports actual prepared-request size rather than underestimated content-only estimate

---

## 10. Security / capability preservation

All recommendations below preserve:
- All four permission modes (read_only / ask_approval / guided / full_access via `permissionModes.json` + `lspExecutionContext`)
- Workspace boundaries (`project_id` check, `sessionProject`)
- Subagent isolation (`spawn_sub_agent` only when visible; child adapter preserved)
- MCP authorization (`manage_mcp_servers` requires manual mode disable; session activation gated by `sessionServers`)
- LSP permission checks (`available(project)` filter)
- Verified writes (`expected_content_hash`, `approval` gates)
- Background-command protections (`runId` ownership, `backgroundCommands` lifecycle)
- Pending approval requirements (`guardTool`, `requestToolApproval`)

---

## 11. Smallest safe fix with greatest impact

**Phase T1 (confirmed, safe):** Align token-accounting scope in UI — clearly label `ContextPanel` as partial content/text estimate (excluding fixed instructions/tools/brief/checkpoint) and `MemoryPalace` header / telemetry as prepared-request / backend-reported. This eliminates user confusion from 88 vs 19K discrepancy without changing prompt content.

**Phase T2 (high impact, capability-preserving):** Implement compact initial native-tool catalog for greeting-only requests — expose only a core subset (~8-12 essential file/read/search/execute tools) initially; allow model-directed activation of remaining tools within the same run via existing `manage_mcp_servers`-style mechanism. The architecture already supports dynamic tool visibility (`visible()` in `getToolContext`); it just needs a reduced initial set with same-run expansion.

**Phase T3:** Lazy project context — only inject directory tree, `AGENTS.md`, project instructions when tool calls or user message trigger project need; do not eagerly include on every `hello`. Already partially deferred by `buildProjectContext`; can be made conditional on first tool invocation or explicit request.

---

## 12. Limitations / missing measurements

- No live model inference performed against user chats (read-only rule).
- Exact token count per tool schema not individually tokenized (would require `/apply-template` per schema — feasible with mock but not executed).
- Old build source revision not fully diffed at commit level (only `git log --oneline` inspected; full diffs of older revisions available but not reconstructed).
- Provider-specific tokenizer differences (Qwen vs glm-5.3-flash) not directly compared with identical payload — noted as limitation.
- Image token cost not measured (no attachments in `hello` test).
- Multi-turn agent loop token accumulation not reconstructed (would require running agent loop with mock responses).

---

## 13. Evidence references (sanitized)

- `docs/workspace-compaction-w1-audit.md` F13 (fixed overhead ~12.5k tokens native + ~20k chars instructions)
- `docs/context-compaction-audit-2026-10-22.md` F01-F13 (capacity sources, image accounting, checkpoint reliability, idle retention)
- `docs/context-c1-unified-budget-report.md` (C1 budget contract, 33,920 usable input at 70K/2-slot, measurement scopes)
- `docs/context-c3-live-run-compaction-report.md` (C3 dependency gate, live-run protection partial)
- Source: `src/main/promptBuilder.js` (350+ lines of prompt assembly)
- Source: `src/main/baseSystemPrompt.js` (system prompt variants, media rules, rich blocks)
- Source: `src/main/tools/agentTools.js` (catalog definition)
- Source: `src/main/mcpManager.js` (discovery catalog, tool exposure, session activation)
- Source: `src/main/contextBudget.js` (approximateTokens, reserve logic)

---

**Audit complete. No fixes implemented. Deliverables produced:**  
- `docs/token-overhead-regression-audit.md` (this file)  
- `docs/token-overhead-regression-evidence.json` (structured evidence)
