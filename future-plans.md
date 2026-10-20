Here's a consolidated Continuum Improvement Backlog, based on everything we've discussed so far: the original agentic roadmap, the subagent audits, memory optimization, casual/workspace boundaries, concurrent agents, UI/UX, and competitor comparisons.

I've separated existing capabilities, work in progress, and future proposals so we don't accidentally rebuild things Continuum already supports.

# Continuum — Master Improvement Backlog

Reported completed

Phases 1.1, 1.2, 1.3A, 1.3B

In progress

Phase 1.3C

Planned

Phases 1.4–1.7 and future improvements

## 1. Core agentic workspace roadmap

This is the roadmap we agreed to complete first.

| Phase | Improvement                                                 | Status              |
| ----- | ----------------------------------------------------------- | ------------------- |
| 1.1   | Structured `run_tests` verification                         | Completed, reported |
| 1.2   | Persisted task plans with `update_plan`                     | Completed, reported |
| 1.3A  | Long-horizon subagent budgets                               | Completed, reported |
| 1.3B  | Subagent timeouts, cancellation, termination                | Completed, reported |
| 1.3C  | Durable continuation and renewable budgets                  | In progress         |
| 1.4   | Child-context compaction and recovery hardening             | Planned             |
| 1.5   | Completion reporting, streaming reliability, child controls | Planned             |
| 1.6   | Permission-aware safe file deletion                         | Planned             |
| 1.7   | Native web search integrated with web fetch                 | Planned             |

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

High priority after 1.7

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
