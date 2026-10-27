# Continuum 🌊

Continuum is a local-first desktop AI assistant combining local GGUF models, cloud providers, and an agentic development workspace in one Electron application. Chat, work on code, execute tools, manage long conversations, track usage, and review or recover workspace changes with configurable permissions.

## Overview

**Casual Chat** is for conversation, attachments, rich responses, and persistent history. **Agentic Workspace** adds a project directory, native development tools, task plans, and permission-controlled execution. Model capabilities and your configuration determine which workflows are available.

Conversations, memories, settings, and usage records are stored locally in SQLite. Local inference runs on your machine; cloud requests send their contents to the selected provider. External tools, web access, and model-asset downloads can also use the network.

## Features

### Local & Cloud Models

- Discover GGUF files from configured model directories, select a model, and load it through an external `llama-server` (llama.cpp), with `hyllama` providing GGUF support.
- Configure OpenAI-compatible and Anthropic-compatible chat endpoints, including OpenRouter and custom endpoints. Provider settings expose key-presence status to the UI rather than saved raw keys.
- Set model profiles and per-chat sampling, generation limits, and supported reasoning/thinking controls. Local load settings include context size; runtime-aware context reporting helps distinguish configured capacity from the active engine's capacity.
- Select cloud models independently of the loaded local engine. Returning to a still-running local model can reuse it, but idle unloading, explicit unloads, model changes, or engine failures can require a reload. Engine load/unload controls and lifecycle diagnostics expose these transitions.

Provider compatibility, token reporting, and reasoning controls vary by endpoint and model. See [reasoning compatibility](docs/reasoning-controls-compatibility-report.md) and [engine lifecycle validation](docs/s1-engine-startup-lifecycle-report.md).

### Casual Chat & Agentic Workspace

Chat supports branches, saved response variants, regeneration, history search, in-chat find, and JSON/Markdown/text export. Project attachments provide shared context; [offline document chat](docs/offline-document-chat.md) adds local embedding-based retrieval after its model assets are available.

In a Workspace, agents can inspect directories, read and create files, edit source, run commands and tests, and review Git changes. Multi-step tool execution, task plans, activity tracking, tool-status cards, and failure diagnostics make progress visible. Agents can request input or approval and continue across successful context compactions; completion without intervention is not guaranteed.

Attachments include images, audio, video, PDFs, and documents, subject to format and model support. Responses render Markdown tables, highlighted code, cards, progress flows, interactive charts, color swatches, and inline media. Attaching a format does not imply every model can interpret it. See [attachment handling](docs/file-attachments.md) and [chat history](docs/chat-history.md).

### Coding Tools & File Operations

**Reliable File Editing and Recovery.** Native tools provide unique string replacement, guarded file writes, unified patches, and batches of up to 20 replacements. Exact matching comes first, with conservative formatting-tolerant matching for supported source, including CSS and candidate-local JSX/TSX checks. Ambiguous or unsafe matches reject rather than guessing.

Argument validation identifies the failing edit; diagnostics include bounded source excerpts, candidate locations, patch-context errors, revision conflicts where available, and guidance for a narrow reread and retry. Recovery capture accompanies eligible writes. Batches validate before writing, with guarded per-file writes and best-effort rollback on write failure—not a filesystem-wide transaction. These safeguards cannot establish that generated code is correct. See [editing reliability](docs/e2-editing-reliability-report.md).

**Large-File Navigation.** Text reads return bounded pages by default, with explicit line ranges, total line counts, continuation positions, and source revision hashes. Optional revision checks detect stale pages; Unicode-safe character windows make unusually long lines inspectable. Source reads stay inside the workspace, including resolved symlinks. Agents can use edit diagnostics to read just the relevant range before retrying.

Returned content is bounded, but each text page can scan the whole file internally for hashing, line counting, and binary detection. This is not constant-time random access. See [large-file reading](docs/r2-large-file-pagination-report.md).

### Memory & Automatic Compaction

Persistent memories store facts, preferences, and rules, with global or model/agent scope and optional always-injected entries.

Continuum monitors context pressure and budgets requests against available runtime capacity. Workspace compaction runs at safe boundaries and compresses older state into lightweight working checkpoints: current objectives, active constraints, unresolved work, decisions, and essential evidence references. Later cycles incrementally incorporate newly eligible evidence instead of repeatedly summarizing every old tool result.

Original messages and tool evidence remain in local SQLite storage until separately deleted. Source-specific historical retrieval lets agents recover older details when needed instead of carrying the entire history in every request. Successful compaction can continue the same run through multiple cycles. Checkpoints are not perfect semantic memory, have no guaranteed token size, and compaction can fail or require intervention. Casual Chat has a separate summary/recovery path with its own support limits.

See [lightweight Workspace context](docs/c6e-lightweight-workspace-context-report.md) and [Casual Chat recovery](docs/c5-casual-context-recovery-report.md).

### Workspace Recovery

Workspace recovery checkpoints preserve **file state**; context checkpoints preserve **agent working state**. They serve different purposes.

A content-addressed blob store, manifests, and recovery journal capture eligible workspace changes. Native edits use targeted capture; shell and MCP operations use boundary scans. Review recovery history, inspect file diffs, pin checkpoints, preview restores, and configure retention/storage limits.

Coverage can be partial: exclusions, file-size limits, unsupported paths, scan caps, or intervening changes can leave files uncaptured or prevent a safe restore. Review coverage warnings and restore previews. Recovery cannot undo external actions or guarantee recovery of arbitrary commands or an interrupted agent run. See [recovery architecture](docs/workspace-recovery-architecture.md).

### Subagents & MCP

Delegate scoped investigations, file analysis, or web extraction to child agents, with model selection, execution/token budgets, parent/child coordination, and result collection. Child transcripts and completed-run metadata persist in SQLite; completed in-memory contexts can be pruned under retention settings. Investigation tools are restricted, and specialized file/web tasks have narrower execution paths.

Children have context-management support, but parent-level self-compaction parity and real-model reliability are not established universally. Active jobs and budget ledgers are not restored after application restart. See [subagent execution and limits](docs/subagents.md).

Connect MCP servers over **stdio, SSE, or Streamable HTTP**. Configuration watching supports hot reload and tool registration/discovery. Agents can create and register server code, subject to permissions, available dependencies, and successful server startup; setup is not guaranteed to be automatic. Native Playwright browser tools are also available and require a compatible browser installation. See [MCP configuration](MCP.md).

### Usage & Cost Analytics

- **Per response:** prompt/completion tokens, reasoning and cache categories when reported, processed-token and generation metrics where available, and recorded charges. Accounting can aggregate multiple model requests in a tool-using response.
- **Per conversation:** latest-response cost, recorded chat spending, usage history, and partial-coverage indicators.
- **Usage & Logs:** token histories/charts with model, project, and time filters, alongside diagnostic engine logs.
- **Usage & Costs:** recorded spending, provider/model/workspace filters, spending over time, conversation and subagent attribution, cloud token usage, cache savings when calculable, and historical pricing evidence. Dashboard time buckets are labelled UTC.

Provider-reported charges take precedence over rate-based estimates. Estimates use available pricing evidence; unknown charges remain unknown. A `≥` subtotal indicates incomplete cost coverage, not exact lifetime spending. Local inference has no cloud-provider charge; that is distinct from a measured zero-priced cloud request. Token categories and statistics depend on provider telemetry, and recorded history is not a substitute for a provider invoice.

See [cost accounting](docs/cloud-cost-estimation-report.md) and [spending dashboard](docs/cloud-spending-dashboard-report.md).

### Customization & Notifications

Choose from **22 themes** across 11 light/dark families, custom backgrounds with surface translucency, and agent avatars/personas with their own prompts and model settings. Per-chat controls override model defaults for sampling, supported thinking settings, and memory/context behavior.

Configure desktop notifications for completion, errors, context overflow, and requests for input. Notification sounds have completion, interruption, and attention cues, volume controls, event toggles, and previews.

Image generation tools support configured OpenRouter or OpenAI-compatible image endpoints and a separately running Stable Diffusion API. Results are saved locally and displayed inline. Backend availability and permissions still apply. Video-provider defaults exist in settings; a released native video-generation backend is not established by the current implementation.

## Safety & Permissions

Permissions are enforced per tool and session; these descriptions are not a universal operating-system security guarantee.

| Mode | Behavior |
| --- | --- |
| **Read Only** | Allows classified reads, read-only child delegation, and existing plan inspection; blocks edits and arbitrary shell commands. |
| **Ask for Approval** | Allows reads and ordinary contained workspace edits; asks for opaque commands, external mutations, and actions requiring additional review. It does not prompt for every tool call. |
| **Workspace Write** | Allows contained edits, task-plan updates, and commands with an available workspace sandbox. Package installation/publication, uncontained execution, and consequential actions have additional review gates. Connected MCP actions may run without individual prompts under this mode's policy. |
| **Full Access** | Authorizes ordinary tools and host command execution without the usual approval gates. Tool-specific workspace requirements, path restrictions, and Git inspection containment still apply. |

Contained shell and Git profiles use **Linux bubblewrap** with explicit filesystem mounts. Offline shell execution and Git inspection isolate networking; authorized Git remote operations use a different network profile. Missing sandbox support fails closed for contained operations or requires review where policy permits; there is no silent host fallback. Extra SDK/runtime paths may need configuration.

Git inspection remains read-only and sandboxed in every mode. Workspace staging uses explicit files and confines filters; outside Full Access, commit review includes the staged diff and invalidates approval if staged content or branch state changes. Publication has additional review. Full Access permits unrestricted staging. See [permission and containment details](docs/permissions.md).

Database safeguards detect recognized dangerous mutations and broad-scope filters, with preview/scoped-approval paths where policy requires them. Detection is heuristic; Workspace Write MCP policy and Full Access change approval behavior. Do not assume every destructive query always prompts. Tool-output secret redaction is also heuristic and does not cover all content paths or prevent all disclosure.

## Architecture / Tech Stack

| Layer | Implementation |
| --- | --- |
| Desktop | Electron 44.7.0; preload/IPC boundary between renderer and main-process services |
| Interface | React 18, Vite 6, Tailwind CSS 4, Recharts, Markdown/code rendering |
| Inference | External llama.cpp `llama-server`, `hyllama` GGUF support, OpenAI/Anthropic-compatible APIs |
| Persistence | SQLite through `better-sqlite3`; local history, memory, execution and usage records |
| Agent services | Native tools, context budgeting/compaction, task plans, recovery, subagents |
| Integrations | MCP SDK, native Playwright browser automation, TypeScript language-server tools |

## Getting Started

### Prerequisites

- **Node.js ≥ 22.12** for the documented development/release workflow. The package's `engines` field still says ≥20; Electron 44 build tooling requires the higher development baseline.
- **Linux x86_64:** approved baseline Ubuntu 22.04 LTS / Debian 12 or newer. Packaging was validated on the development host; execution on those minimum distributions remains unverified. See [Linux release validation](docs/migration-electron44-release-build.md).
- Desktop runtime libraries are required. Native builds may need Python, make, and a C/C++ toolchain when compatible prebuilds are unavailable. Linux contained execution needs bubblewrap and working namespaces.
- For local inference, separately install a compatible `llama-server` on the inherited `PATH` or configure the engine launch command, and supply GGUF weights (plus vision projector weights when needed). Hardware/RAM/VRAM requirements depend on the model and load settings.
- Cloud inference needs a configured provider endpoint and usually an API key. MCP servers need their own runtimes/dependencies; Playwright needs matching browser assets and OS libraries. Offline document embeddings download assets on first use.

Model weights and the local inference executable are not bundled. No provider environment variable is required for basic startup; configure directories, engine settings, and providers in the application. Cross-platform source availability does not establish validated Windows/macOS packaging support.

### Installation

```bash
git clone https://github.com/mk-saadi/continuum.git
cd continuum
npm ci --ignore-scripts
npm exec --no -- install-electron
npm rebuild --foreground-scripts
```

Keep this order: install locked dependencies, explicitly install Electron, then run native dependency lifecycle/rebuild scripts.

### Development

```bash
npm run dev
```

This starts Vite and launches Electron after port 5173 is available. Configure model directories and load a local model, or add a cloud provider, before starting inference.

### Building & Packaging

```bash
# Build the renderer
npm run build

# Build and package with electron-builder
npm run dist
```

Linux targets are AppImage and Debian packages under `release/`. These commands do not establish validation on every OS or distribution.

## Development Status

Continuum is actively developed. Editing, pagination, compaction, permissions, recovery, and accounting have deterministic regression coverage, but that does not establish universal real-model or platform reliability. Recent context and edit-recovery reports explicitly retain real-model acceptance gaps and known baseline/environment test failures.

Local performance depends on hardware and model; cloud features require provider access. Compaction and corrective tool use depend partly on model behavior, recovery coverage can be incomplete, and native sandboxing is platform-dependent. Persistent scheduled autonomous jobs, arbitrary crash-resumable tasks, and work after application shutdown are not documented as implemented capabilities.

See the [README accuracy audit](docs/readme-v2-audit.md) for source evidence and documentation gaps, and [release readiness](docs/migration-electron44-release-readiness.md) for packaging limits.

## Testing

Tests use Node's built-in runner, with unit, integration, and Electron/UI suites:

```bash
npm test

# A focused suite using Electron's Node runtime for Electron/native-module compatibility
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/recoveryStore.test.cjs

# Example Linux UI suite; requires Xvfb and compatible browser/runtime dependencies
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoveryCard.ui.cjs
```

Some suites require Electron's native-module runtime, sandbox/network support, or browser assets. `--no-sandbox` above belongs to the isolated UI test harness. The full suite is not claimed to pass in every environment; consult the linked feature reports for tested scope and known failures.

## Project Structure

- `main.js`, `preload.js`: desktop lifecycle, local engine process, and renderer IPC bridge.
- `src/main/`: agent orchestration, local/cloud inference, context budgeting/compaction, memory, task checkpoints, workspace recovery, and usage accounting.
- `src/main/tools/`: native file/edit, history/memory, image, web, and language-server tools.
- `src/main/subagents/`: child execution, models, budgets, and context management.
- `src/components/`: chat, Workspace, recovery, rich responses, and settings/usage interfaces.
- `src/hooks/`, `src/lib/`: renderer state hooks and shared policies/formatters.
- `tests/`: unit, integration, UI suites, and fixtures.
- `docs/`: architecture, feature verification, performance, and release reports.

## Contributing

Contributions are welcome. Fork the repository, create a focused branch, and open a pull request with a clear description and relevant validation. Use conventional-commit style messages and identify platform or model requirements when reporting issues.

## License

Distributed under the MIT License. See [LICENSE](LICENSE).
