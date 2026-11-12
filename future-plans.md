Here's a consolidated Continuum Improvement Backlog, based on everything we've discussed so far: the original agentic roadmap, the subagent audits, memory optimization, casual/workspace boundaries, concurrent agents, UI/UX, and competitor comparisons.

I've separated existing capabilities, work in progress, and future proposals so we don't accidentally rebuild things Continuum already supports.

# Continuum — Master Improvement Backlog

Status snapshot — November 6, 2026

Completed, reported: Phases 1.1–1.7 (full agentic roadmap; implementation reports in docs/), persistent memory optimization (fixed November 2026), and task scheduling (four phases: turn-level model lease, safe model switching with a reusable agent runner, scheduler backend, Tasks UI). Also completed: Git authentication through the host environment, Workspace Write standard outbound networking, the separate Trusted Development networking path, and improved native browser/web tooling.

Outstanding before production — Priority 1:

* Subagent reliability — current focus (November 11, 2026): investigate intermittent partial web-research and direct-page analyses even with configurable execution limits removed.

* Automatic context compaction — fixed (confirmed November 11, 2026).

* Background command suspension and agent resumption — verify the full lifecycle: completion events carry stdout, stderr, exit code, and task ID; the correct session resumes exactly once; cancellation and shutdown are handled; concurrent completions do not cross wires.

* Real scheduler verification with local models — one-time task completes, recurring schedules advance, tasks survive restart, pausing prevents automatic execution, manual runs work while paused, history persists, overdue tasks execute sequentially without duplicates, approval-required work blocks safely.

* Scheduler/model lifecycle edge cases — a scheduled task never unloads a model during an active turn, no switching/lease races, VRAM contention waits and retries instead of skipping, explicit fallback is honored, no silent model substitution, and the configured task permission level reaches tool authorization on every execution.

Outstanding before production — Priority 2:

* Workspace and security edge cases — permission revocation with a dev server running, nested subprocess containment, concurrent tool calls, fresh Isolated-mode startup, reproducible recovery artifacts, production builds rejecting ineligible Trusted Development configurations.

* Primary-profile and packaged-app acceptance — AppImage configuration, packaged prompts and UI rendering, real browser execution in the packaged app, rechecking earlier integration failures.

* Test suite cleanup — separate genuine regressions from stale expectations; prefer targeted suites over broad reruns.

* Licensing audit — dependencies, bundled runtime, redistribution obligations — before public distribution.

* Cross-platform support — Windows and macOS sandbox support is future engineering work; the Linux security model does not transfer automatically.

Proposed, not committed:

* Restore the floating-assistant experience (small floating window, global shortcut, optional always-on-top).

* First-run onboarding (local vs cloud models, BYOK guidance, model directories).

* Hugging Face model hub (search, GGUF filtering, download with progress, registration in the model selector).

* Broader workflow automation (local-first alternative to n8n) — deferred until the scheduler is verified and stable.

## 1. Core agentic workspace roadmap

This is the roadmap we agreed to complete first.

| Phase | Improvement                                                 | Status              |
| ----- | ----------------------------------------------------------- | ------------------- |
| 1.1   | Structured `run_tests` verification                         | Completed, reported |
| 1.2   | Persisted task plans with `update_plan`                     | Completed, reported |
| 1.3A  | Long-horizon subagent budgets                               | Completed, reported |
| 1.3B  | Subagent timeouts, cancellation, termination                | Completed, reported |
| 1.3C  | Durable continuation and renewable budgets                  | Completed, reported |
| 1.4   | Child-context compaction and recovery hardening             | Completed, reported |
| 1.5   | Completion reporting, streaming reliability, child controls | Completed, reported |
| 1.6   | Permission-aware safe file deletion                         | Completed, reported |
| 1.7   | Native web search integrated with web fetch                 | Completed, reported |

### Additional requirements we identified

* Preserve independent parent/child model selection.

* Support multiple local/cloud agents running simultaneously.

* Preserve separate context windows for each agent.

* Maintain accurate cumulative token accounting.

* Support repeated subagent compaction without losing work.

* Distinguish verified completion from incomplete or failed execution.

* Avoid restrictive hidden execution ceilings.

* Keep all execution within the running desktop application.
* Support user mid-run interjections — send a short prompt during an active run without terminating it, so the agent can adjust behavior (e.g., skip unnecessary steps or tool calls). See 6.2 for design details; fits Phase 1.5 scope (child controls).

Important: The subagent audit confirmed that mid-run compaction already works in deterministic tests. Phase 1.4 is therefore primarily about hardening and recovery, not building compaction from scratch.

## 2. Persistent memory optimization

Completed (November 2026) — the persistent memory issues were fixed. The design notes below are retained as background.

This is one of the most substantial improvements we've discussed.

### 2.1 Compact persistent-memory index

Current behavior: Stored memories are injected into the agent's context as short textual entries.

Proposed behavior: Inject only approximately 2–4 descriptive keywords per memory, plus a stable identifier and category where useful.

Illustrative compact memory index

M012 · User fact

desktop AI development

M021 · Preference

minimal UI design

M031 · Project

Continuum architecture

Retrieve complete memory when relevant

Full memory remains in local persistent storage

We discussed these improvements:

* Keep complete memories in local storage; compress only the prompt representation.

* Assign stable IDs to memories for exact retrieval.

* Preserve existing categories such as user facts, preferences, project rules, and tech stacks.

* Allow the agent to retrieve full memories through a dedicated tool.

* Keep the existing safeguard against saving trivial information.

* Continue supporting explicit user requests to save memories.

* Make keyword cues useful for semantic matching, not only exact string matching.

* Apply a total token budget to the memory index if the number of memories grows substantially.

### 2.2 Hybrid memory retrieval

We identified a weakness in purely keyword-driven retrieval: a user might refer to a concept indirectly without repeating a memory's keywords.

The proposed hybrid system would combine:

1. Compact memory cues visible to the model.

2. Agent-initiated searches for complete memories.

3. Lightweight automatic relevance-based retrieval, where useful.

4. Optional full injection of a small number of especially relevant memories.

The objective is low context usage without sacrificing recall accuracy.

We should benchmark token savings, retrieval accuracy, missed memories, and unnecessary retrievals before replacing the current injection approach.

### 2.3 Memory quality and management

Additional future improvements:

* Detect duplicate or near-duplicate memories.

* Update memories when facts change.

* Identify contradictory memories.

* Preserve source/provenance information.

* Distinguish durable facts from temporary information.

* Improve importance ranking.

* Provide user-facing memory inspection and correction.

* Allow users to remove or scope individual memory entries.

Your existing automatic memory-saving behavior should remain selective rather than storing every apparently important message.

## 3. Shared knowledge with casual/workspace boundaries

High priority

Our final decision was:

Do not detach casual-chat memory from workspace knowledge. Share information across the application, but keep execution authority and context ownership separate.

This supports the workflows you described, including research in casual chat followed by execution in a workspace, or one agent debugging another agent's work.

### 3.1 Shared local knowledge, independent contexts

Shared local knowledge

Persistent memory · Chat database · Search · Recent history · Workspace activity

Casual Chat

Conversation, rolling summaries, persona

Workspace A

Project instructions, files, plans

Workspace B

Independent research or debugging

Other Agent

Separate model, budget and execution

### 3.2 Different kinds of information

| Data                     | Sharing policy we discussed                                             |
| ------------------------ | ----------------------------------------------------------------------- |
| Global persistent memory | Shared and retrievable across authorized sessions                       |
| Casual-chat history      | Searchable or retrievable on request                                    |
| Rolling chat summaries   | Owned by the originating conversation                                   |
| Workspace plans          | Owned by the corresponding workspace session; readable where authorized |
| Project instructions     | Applied to their own project, not automatically to all chats            |
| Project skills           | Project-specific availability                                           |
| Project permissions      | Never inherited merely by reading another project                       |
| Agent activity logs      | Available for authorized inspection and debugging                       |
| Source files             | Subject to workspace filesystem permissions                             |
| Persona settings         | Remain attached to the applicable agent/chat                            |

This is a proposed policy. We haven't conducted a source-level cross-session access audit yet.

### 3.3 Memory scope metadata

Rather than establishing separate physical memory databases, add optional logical scopes.

| Scope             | Example                                     |
| ----------------- | ------------------------------------------- |
| Global            | User prefers concise technical explanations |
| Project           | Continuum uses Electron and SQLite          |
| Chat              | Temporary conversation-specific information |
| Creative story    | Fictional characters and worldbuilding      |
| Workspace session | Task-specific decisions and progress        |

The core concept:

Global storage does not mean every memory should automatically influence every agent.

A project-specific memory could still be retrieved from casual chat or another workspace when relevant and authorized.

### 3.4 Context priority and conflict handling

We also discussed defining a clear order of authority.

* Application safety and enforced permissions remain authoritative.

* Active project instructions and rules govern work in that project.

* Session-specific instructions govern their own session.

* Global user preferences apply when compatible.

* Retrieved historical conversation content supplies information, not new execution authority.

This prevents an agent from treating instructions found in another conversation as permission to modify files.

## 4. Cross-chat and cross-agent collaboration

Future improvement

This is particularly important because Continuum supports multiple simultaneously running agents.

### 4.1 Casual chat to workspace handoff

Example:

You research a feature in casual chat, then enter a project workspace and ask:

> "Fetch the last few messages from my research conversation and implement the plan we discussed."

Desired behavior:

* Locate the correct source conversation.

* Retrieve its relevant recent messages.

* Preserve source references.

* Extract the useful plan.

* Apply the current workspace's instructions and permissions.

* Continue without copying the entire conversation into context.

Your recent-chat retrieval mechanism already provides part of this functionality.

### 4.2 Workspace-to-workspace collaboration

Example:

Agent A is implementing a feature.

Agent B is researching or debugging the same project.

Desired behavior:

* Agent B can inspect Agent A's available progress.

* Agent B can retrieve relevant findings, plans, or execution logs.

* Agent B can run authorized tests.

* The two agents maintain separate conversation contexts.

* Neither agent silently changes the other's task state.

### 4.3 Cross-session references

A future enhancement would introduce stable references to:

* Chat IDs.

* Workspace sessions.

* Agent runs.

* Task plans.

* Execution results.

* Verification evidence.

This would reduce ambiguity when a user says "look at what the other agent did."

### 4.4 Concurrent file access protection

We discussed protecting files when multiple agents operate in related workspaces.

Potential improvements:

* Allow concurrent reads.

* Detect overlapping file edits.

* Avoid silent overwrites from stale content.

* Preserve recovery history.

* Coordinate or reject conflicting mutations.

* Avoid automatic merging without review.

This should be investigated rather than implemented as a large new synchronization framework immediately.

## 5. Conversation continuity and creative users

Future improvement

Continuum already has several capabilities that should be preserved:

* Rolling conversation summaries.

* Full-fidelity recent messages.

* Progressive compression of older history.

* Cross-chat search with filters.

* Retrieval of up to 10 recent messages from another chat.

* Persistent global memory.

* Persona customization.

* Tool calls in casual chat.

* Image and video rendering.

* Cloud image/video generation.

* Charts and graphs.

The improvement opportunities we discussed include:

### 5.1 Rolling-summary fidelity

* Check that important information survives multiple compression cycles.

* Distinguish summary information from original messages.

* Preserve retrieval references for compressed history.

* Measure context-token savings.

* Prevent summarization from silently changing established facts.

* Ensure casual-chat compaction remains unobtrusive.

### 5.2 Creative-writing continuity

* Keep character traits, relationships, settings, and timelines consistent across long stories.

* Separate fictional story facts from actual user facts.

* Retrieve relevant story details when needed.

* Avoid filling global persistent memory with temporary roleplay material.

* Preserve persona-specific instructions independently from memory.

### 5.3 Cross-chat retrieval improvements

* Improve relevance ranking.

* Support more precise source selection.

* Identify which chat or session a retrieved result came from.

* Avoid injecting excessive historical messages.

* Distinguish live task progress from historical conversation records.

## 6. Agent execution observability and UI/UX

Future improvement

We discussed making complex workspace activity more understandable without cluttering casual chat.

### 6.1 Unified execution timeline

Potentially combine existing execution events, checkpoints, plans, and subagent records into one understandable view.

Illustrative agent activity

Concept

* Task started

  Workspace and model resolved

* Research completed

  Findings and sources recorded

* Context compacted

  Summary checkpoint preserved

* Tests verified

  Structured verification evidence

* Task finished

  Outcome delivered to parent

Additional UI/UX opportunities:

* Clearer subagent progress and termination reasons.

* Budget consumption and renewal visibility.

* Context-compaction activity.

* Accessible partial results.

* Better tool-output presentation.

* Compact but detailed model settings.

* Responsive chat input and streaming.

* Consistent casual-chat and workspace navigation.

* Potential improvements to the original floating-window idea.

* Accessible controls for viewing/editing memory.

* Preserve custom avatars, agent names, personas, backgrounds, and branding.

### 6.2 User mid-run interjections

Allow the user to send a short prompt while an agent is actively running — for example, noticing unnecessary steps or tool calls and steering the run instead of terminating it. The agent sees the prompt at the next safe boundary and acts accordingly.

Current state: Input is locked during streaming (`ChatInputBar` disables sending; only Stop is available). The existing mid-run questions mechanism is one-directional (agent → user) via `ask_user`; there is no path to push text into a running agent.

Proposed design:

* Interjection queue: Text submitted while streaming is enqueued as a *user interjection*, distinct from normal turns and from `ask_user` answers.
* Boundary injection: At the top of each loop iteration — after tool results are appended, before the next LLM request is built — flush queued interjections into context with a tag (e.g., `[USER INTERJECTION] ...`). The model sees them on its very next turn.
* Persistence: Interjections are stored in the transcript as visually distinct messages and included in token accounting.
* Edge cases: A long-running tool call delays effect until that tool completes; multiple interjections queued before one boundary flush in order; if the run is stopped, queued interjections are discarded (or persisted as unprocessed — decide during implementation).

Scope note: Fits Phase 1.5 ("Completion reporting, streaming reliability, child controls"). Applies to top-level runs and subagent runs alike.

The design goal remains simple on the surface, capable underneath.

## 7. Model selection and routing

Optional future improvement

Continuum already allows child agents to select a model independently of the parent.

Potential improvements:

* Rule-based model selection based on task type.

* Optional local-first routing.

* Restrict sensitive tasks to local models.

* Require authorization before switching to a paid provider.

* Display per-agent model identity.

* Preserve each child's selected model during continuation.

* Track provider-specific token and usage estimates.

* Support provider-aware fallback only under an explicit policy.

We agreed not to introduce complex automatic routing until there's a demonstrated need.

## 8. Security, permissions, and reliability

Ongoing improvement

The audits highlighted areas worth hardening.

| Area                  | Future improvement                                                    |
| --------------------- | --------------------------------------------------------------------- |
| Workspace isolation   | Verify boundaries across all file and tool operations                 |
| Sandbox coverage      | Assess whether protections cover the actual execution paths           |
| Cross-session access  | Read access must not confer write authority                           |
| Concurrent writes     | Detect conflicting file modifications                                 |
| Recovery              | Preserve safe rollback and preview-before-restore                     |
| Model/provider errors | Normalize failures without false success                              |
| Cancellation          | Distinguish logical termination from externally terminated operations |
| Tool permissions      | Maintain consistent enforcement for parents and children              |
| Regression testing    | Repair stale tests and retain deterministic benchmarks                |
| Local-first privacy   | Keep local storage and execution independent of hosted infrastructure |

The current app-level constraints remain non-negotiable:

No CLI product, web app, headless execution service, cloud application backend, persistent daemon, or scheduling system that continues running after the desktop app closes.

Optional cloud model providers are still part of the product.

## 9. Ideas we deliberately deprioritized

Competitor comparisons surfaced several capabilities, but we decided they don't fit Continuum's immediate product direction.

| Feature                                     | Decision                                 |
| ------------------------------------------- | ---------------------------------------- |
| Separate terminal/TUI application           | Not planned                              |
| Browser-based Continuum application         | Not planned                              |
| Independent headless runtime or SDK product | Not planned                              |
| Cloud execution infrastructure              | Not planned                              |
| Persistent background agent daemon          | Not planned                              |
| Full workflow canvas like n8n               | Not a priority                           |
| Plugin marketplace                          | Not a priority                           |
| Enterprise multi-user governance            | Not a priority                           |
| Cross-device synchronization                | Not a priority                           |
| Extensive lifecycle plugin platform         | Optional only if a concrete need emerges |

MCP, local tools, and skills remain important existing extensibility mechanisms.

# Suggested improvement order after Phase 1.7

This is how I would sequence the future work, keeping your app manageable.

2.1

Memory and cross-session architecture audit

Verify existing sharing, retrieval, memory ownership and access boundaries

2.2

Compact persistent-memory index

Keyword cues, stable IDs, semantic relevance and token-budgeted retrieval

2.3

Scoped memory and quality improvements

Deduplication, contradiction handling, provenance and scope metadata

2.4

Cross-agent information sharing

Reliable session references, progress inspection and safe collaboration

2.5

Conversation continuity improvements

Rolling-summary fidelity, history search and creative-writing consistency

2.6

Workspace execution UI/UX

Better progress views, verification evidence, subagent controls and activity timeline

2.7

Desktop chat and creative UX

Persona, memory management, multimodal presentation and floating-window exploration

2.8

Security, concurrency and performance hardening

Conflict detection, isolation checks and long-session performance

These phase numbers are proposals, not yet approved implementation specifications. Several may become smaller or merge depending on the results of the first audit.

## 10. The five most important decisions we've made

1. Continue developing Continuum as a single local-first desktop app, not a general-purpose harness platform.

2. Keep casual chat and workspaces connected through shared local knowledge, rather than physically isolating their memories.

3. Keep active execution contexts separate. Each chat, workspace, task, and child agent retains its own transcript, settings, permissions, and task state.

4. Optimize persistent memory through selective retrieval, potentially using 2–4-word indexed cues instead of injecting every complete memory into the prompt.

5. Preserve authorized cross-agent collaboration, so users can research in one chat, execute in another workspace, and independently verify work from a third session.

The most important future architectural principle is:

> Share knowledge across Continuum. Scope authority to the active task. Retrieve context only when needed.

That gives you the flexibility of a multi-agent workspace without forcing everything into the same context window or requiring separate memory systems.

For now, I'd keep this as the master backlog while Phase 1.3C finishes. After 1.7, the first task should be a read-only audit of persistent memory, cross-chat retrieval, cross-workspace access, and concurrency boundaries before implementing the new memory index.

If you want, I can:

* Detail the current progress and next steps for phase 1.3C

* Explain the hybrid memory retrieval implementation plan

* Describe the enforcement of casual and workspace memory boundary policies

## 11. Competitor, onboarding, and local-model investigation findings (Nov 2026)

This section records what we established in the recent research turns: competitor positioning, the real onboarding friction, how local-engine detection works, and the Hugging Face model-download question. These findings refine, but do not override, the decisions in section 9.

### 11.1 Competitor landscape — verified findings

Research was conducted against the public documentation of the apps we named, plus Hugging Face and LM Studio docs.

| App | Form factor | Local-model mechanism | Bundles an engine? |
| --- | --- | --- | --- |
| opencode (SST) | Terminal CLI + desktop app (TUI-core) | External OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp server) via the AI SDK / Models.dev; BYOK for cloud | No |
| Hermes Agent (Nous Research) | TUI + messaging gateway (Telegram, Discord, Slack, WhatsApp, Email) | Any provider (BYOK); self-improving learning loop (creates skills, persists knowledge, user modeling); cron jobs, parallel sub-agents, sandboxes (Docker/SSH/Modal) | No |
| DeepSeek Harness (dsh) | Local web UI started by one command | `settings.yaml` pointing at a stock `llama-server`, Ollama, or LM-Kit endpoint; trajectory logging; 4 run modes; community `dsh-local-models` addon adds one-click GGUF loading | No |
| pi | Terminal coding agent (badlogic) | "Integrates directly with the llama.cpp router. The router discovers GGUF files and loads models on demand. `/llama` manages the router" (pi.dev docs) | Unclear from official docs — likely app-managed rather than user-installed; not user-facing PATH setup |
| LM Studio | Desktop model runner | Fully bundled engine + one-click weight downloads; its HF model library browses/downloads public models without requiring an HF login (token only for LM Studio Hub / gated content) | Yes (outlier; different product class) |
| Lovable | Cloud prompt-to-app builder (React/TypeScript/Tailwind/Shadcn) | Supabase backend, hosting, GitHub sync, built-in AI connectors, credit-based pricing | N/A (cloud) |

Confirmed consensus: no local agent in the field bundles llama.cpp or model weights. The field norm is BYOK keys plus an external or app-managed local runtime. Continuum not bundling is therefore consistent, not a defect. The differentiating question is management, not bundling: dsh needed a community addon to add one-click GGUF loading; pi built runtime management in; our app currently assists none of: install, weight download, server reachability, or selection.

### 11.2 Positioning verdict

Direct head-on competition with opencode/Hermes/dsh on coding-agent maturity is not recommended. The defensible niche is:

> A local-first, permission-sandboxed, desktop GUI agent workspace: full agent power, no terminal, no cloud dependency, visible control, and file-level recovery.

Verified advantages over the set: local-first storage (SQLite), per-tool permission modes with bubblewrap sandboxing, file-state checkpoint/recovery architecture, and a full desktop GUI (none of the rivals are a conventional desktop app). Verified gaps: no self-improving learning loop (Hermes), no persistent scheduled/autonomous jobs (Hermes, dsh — and this also fits our own section-8 non-negotiable of no post-close daemon), Linux-baseline-only distribution, and the highest onboarding friction in the field.

Closing gaps, in order of leverage: (1) cross-platform packaging via CI, (2) frictionless local-model setup, (3) persistent scheduled jobs (only if compatible with the no-daemon constraint — e.g., while the app is running), (4) learning loop (later phase, most ambitious).

### 11.3 Current onboarding process — traced from source

Key finding: Continuum has no in-app onboarding process. There is no welcome screen, first-run wizard, or checklist; first-run state is never detected. A new user's first usable signal is a silently disabled send button (`disabled={!modelId || streaming || loading}` in `ChatInputBar`).

The actual new-user pipeline:

1. **Pre-install (manual, heavy):** Linux x86_64 only (validated baseline Ubuntu 22.04 / Debian 12; Windows/macOS packaging unvalidated). Developers: clone → `npm ci --ignore-scripts` → Electron install → native rebuild → `npm run dev`. End users: AppImage or `.deb` from the release folder; no public distribution channel documented.
2. **Local inference (separate install):** user must install `llama-server` (llama.cpp) themselves, on the app-visible PATH, and download GGUF weights themselves. Nothing is bundled.
3. **Cloud inference (optional):** Settings → Cloud Providers → endpoint + API key + model ID → test connection → select.
4. **First launch:** boot splash (~650 ms), then the bare chat tab with a disabled send button. No guidance explains why or what to do next.
5. **Local path:** model selector → point at a directory of GGUF files → scan → select → load. If `llama-server` is missing, the user sees a technical spawn error, not a guided fix.

Proposed fixes, in order of leverage:

1. First-run checklist panel (model / provider / sandbox / project status) shown when nothing is configured; turns the dead button into an actionable CTA.
2. Empty-state guidance in the chat when no model is selected: one sentence, one button ("Set up a model").
3. A documented quickstart model (small GGUF + one download command) so the local path works in minutes.
4. Cross-platform packaging (structural; longer arc).

### 11.4 llama.cpp detection — verified from `src/main/engineManager.js`

The app does not ask the user to point at the llama.cpp binary. It resolves by bare name from the app's PATH:

- `ENGINE_BINARY = "llama-server"`; spawned with `childProcess.spawn("llama-server", args, { shell: false })`.
- The model directory selection in the UI is for GGUF files only, not for the engine binary.
- `shell: false` means terminal-only PATH modifications (`.bashrc`, aliases) never reach the lookup; a standard install in `/usr/local/bin` or `/usr/bin` is detected automatically; minimal-PATH desktop-session launches may fail.
- On `ENOENT`/`ENOTFOUND`/`EACCES`, `describeEngineSpawnError()` converts the errno into an actionable message listing every directory actually tried, the failure reason, and a note that shell-only PATH changes do not apply.
- Escape hatch: `CONTINUUM_LLAMA_SERVER` env var (env-only; not exposed in the UI). The app validates it is an executable file and throws a clear error otherwise.

Implication for packaging: a non-technical user who installs the packaged AppImage successfully can still hit the spawn error because llama.cpp is a hidden dependency. Follow-ups: document the install command in the quickstart, and add a local-runtime status probe in the model selector (green/red with the exact fix), surfacing the existing error text before the user attempts a load.

### 11.5 Distribution via CI (GitHub Actions)

Decision direction (from discussion): use GitHub Actions to build AppImage and `.deb` for Linux, `.exe` for Windows, and a macOS build, so non-technical users can install without tooling. This removes the technical onboarding barrier but not the cognitive one (model setup) — the two are complementary fixes. Note: packaging for Windows/macOS is currently unvalidated; builds may need per-OS CI setup work.

### 11.6 Hugging Face model browsing — verified facts

- HF accounts and Hub API tokens are free. Paid tiers (Pro/Team/Enterprise) only raise rate limits; there is no paywall on the Hub API.
- The Hub API (`/api/models` browsing, resolver downloads) works fully anonymously — no account or token required. A free token adds: roughly doubled rate limits (anonymous ≈ 500 API / 3,000 resolver requests per 5-minute window vs ≈ 1,000 / 5,000 signed-in; HF notes limits vary with platform health), access to gated models (e.g., Meta Llama, which requires accepted license terms even for download), and private repos.
- LM Studio's model library browses and downloads public models without an HF login; its token flow is tied to its own hub and gated content.
- Rate limits are not a constraint for a model browser making a handful of listing calls per session.

Recommendation (phased):

1. **Phase 1 — anonymous model browser.** Search/list GGUF repos via `/api/models` (filter by GGUF tag, sort by downloads); stream downloads from the public resolver into the user's models directory. No account, no key, zero friction. This closes the "download weights yourself, blind" gap.
2. **Phase 2 — optional HF token field in Settings.** Framed as "optional, for gated models (e.g., Llama) and higher rate limits", matching how LM Studio frames it.

Decision: do not make an HF key a requirement; it would re-introduce the onboarding friction we are removing.
