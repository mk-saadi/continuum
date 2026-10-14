# Session Handoff — Continuum (llm-electron)
Date: 2026-10-13. Tree state: clean, HEAD `6c961b1` pushed to `origin/main`.
Rule for next session: verify `git status` is clean before starting; never
commit/push unless the user explicitly asks.

## What this project is
Continuum — local-first Electron desktop AI assistant (Electron 44, React,
llama.cpp via llama-server, MCP, SQLite `memory_palace.db`). Main agent +
read-only subagent runtime, workspace/casual chats, permission modes
(read_only / workspace_write / ask_approval / full_access).

## Recently completed (all committed in 6c961b1 unless noted)
1. **Token/context telemetry**: header shows tokenizer-measured usage with
   measured-vs-estimate labels; last/peak request + cumulative workload
   tooltips; per-request phase stats; `promptMeasurement.js` +
   `contextDisplay.mjs`.
2. **Prompt optimization**: base + session wording cuts (~10% base,
   ~6% whole-prompt, tokenizer-verified); legacy-estimate fallback kept.
3. **Minimal casual composition**: capability-conditioned protocols,
   just-in-time guardrail reminders (systemMessages.cjs shared helper),
   ask_user hidden when disabled, delegate_task shadowed, media-gen
   conditional. Event-driven re-measure (no polling); stale-measure fixes.
4. **Subagent reliability**: raised generation ceilings (inv 2048 / file
   3072 / web 1024), cumulative task budgets (auto policy + Custom hard
   limits in Settings → General), adaptive retry on length-truncation,
   loop/stuck failsafes, repeat-call guard, child compaction design noted.
5. **Subagent observability**: "Show sub-agent activity" button + live modal
   (turns, thinking, tool calls, usage), `childSessionId` linkage through
   executeAgentTool → runtime, `subagent_runs` DB table (input, full output,
   thoughts, tools, agent/model, total tokens, duration, timestamps).
6. **Edit tools** (latest code change): `move_project_file`,
   `edit_project_files` (atomic multi-file), `apply_patch` (unified diff,
   no deletes) — all WORKSPACE_WRITE, containment-gated via `writeTargets()`,
   turn-reset + checkpoint-evidence wired. `write_project_file` now atomic.
   `delete_file` deliberately NOT added (see open threads).
7. **Packaging fix**: `src/lib/**/*.cjs` added to electron-builder files
   (AppImage crashed without `systemMessages.cjs`).
8. **Keyless local providers** (user's own change, preserved): LM
   Studio/Ollama without API keys in `cloudProviders.js`.

## Benchmark saga (user-run, same Qwen3.8-27B)
- Round 1 (retrieval): OpenCode won (correct + cheapest). Continuum 54 files
  then 57 on rerun (nondeterministic summarization); DeepSeek 56 twice
  (systematic miss).
- Round 2 (3 sequential subagents + synthesis): Continuum fastest AND
  accurate — 12.5 min vs 23 (ocd) vs 56 (dsh). DeepSeek's 179k tokens were
  ~80% cache hits; OpenCode cheapest honest tokens.
- Round 3 (Gemma 4 26B QAT via LM Studio-as-cloud): fast (400s) but sloppy —
  17/20 lines, hallucinated `compactionCore.js`, wrong Sidebar-vs-TabBar.
- Standing conclusion: correctness first (OpenCode most consistent),
  Continuum fastest, DeepSeek cheapest per real token but least reliable.

## Verified subagent failure modes (all with evidence)
- 10-call limit deaths on broad tasks (ocd uses 23–37 calls per agent).
- Reasoning-only turns mistaken for answers; thinking saturates 1024-token
  caps → `finish_reason=length` → futile identical retries.
- Single-slot (`-np 1`) contention + KV thrash across parallel children.
- Server ignores thinking_budget params (probed live); only max_tokens works.

## Open threads (awaiting user approval — do NOT start unprompted)
1. **Subagent upgrade package**: 25 calls/12 turns + child context
   compaction (port parent machinery) + budget notices/forced final turn.
   Full plan already presented to user.
2. **`delete_project_file`**: proposed design (always-prompt except
   full_access, refuse non-empty dirs unless recursive) — user asked, no
   approval to implement yet.
3. **Git read-only tools** (`git_status/diff/log`, maybe blame) — recommended
   as next feature; user asked "git or lsp?", answer given: git first.
   Not started.
4. **LSP**: assessed as 2–3× subagent effort; do diagnostics-loop first.
5. **Qwen 3.6 35B A3B test**: user plans same 20-line audit on it. Note:
   ~20 GB file won't fully fit 16 GB VRAM (partial offload). Stock instruct
   likely beats the "Aggressive" uncensored build for discipline.
6. **Qwen retest tonight** (user said they'd rerun subagents on Qwen).

## Environment & test notes
- `npm test` is broken on Node 22 (bare dir arg); use
  `node --test tests/*.cjs tests/*.mjs`. UI tests need display/Electron app
  mode (fail headless — environmental).
- Known pre-existing failures (do NOT "fix" unasked): messageStats
  siblings, mcpIpc ×2, replyVariants, subAgentRunner isolation,
  childAgentLoop harness + 2× stream assertions (concurrent streaming work),
  subagentModelSelection + tokenUsage (need `app.getPath` mock; broken by
  concurrent uncommitted db.js migration work — check whether that landed).
- 16 GB VRAM fits ONE model: Qwen 27B (~13 GB) XOR Spark 4B. Never run two
  llama-servers (OOM-kills, observed twice). Server dying when idle is
  likely the app's idle-unload, not a bug.
- main-process code loads once at app start; renderer hot-reloads. After
  main-process edits the user must RESTART the app (dev `electron .`) or
  they will test stale code — this confusion already happened once.
- Other agent sessions edit this repo concurrently (seen: streaming
  progress, attachment pipeline, db migration). Check `git status` + recent
  mtimes before assuming breakage is yours; bisect via worktree if needed.
- Local models on disk: Qwen3.8-27B-GSQ-RCO (main), Spark-X2.5-4B-Q8_0
  (fast experiments, :8081), Qwen3.6-35B-A3B (untested).
- User's harness discipline: 3 runs each, medians, correctness first;
  abbreviations cnt/ocd/dsh. Enforce it — they once tried to drop to 2.
