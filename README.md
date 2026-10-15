# Continuum 🌊

A high-performance, privacy-first desktop AI assistant built with **Electron**, **React**, and **Vite**. Run local large language models (LLMs) side-by-side with cloud providers — all inside a sophisticated agentic workspace with long-term memory, self-extending tooling, and built-in safety rails.

---

## ✨ Key Features

### 🔀 Dual Inference: Local + Cloud
*   **Local Engine:** Powered by `llama.cpp` (via `hyllama`) — your data never leaves your machine.
*   **Cloud Providers:** Connect any **OpenAI- or Anthropic-compatible** endpoint (plus DeepSeek). Save API keys in Settings → Cloud Providers; the UI only ever sees configuration status, never raw keys.
*   **Simultaneous Loading:** Local GGUF models and cloud providers coexist. Switching to a cloud model leaves your loaded GGUF resident in VRAM — switching back reuses it instantly with zero reload cost.

### 🤖 Agent Harness & Project Management
*   **Custom Agents (Avatars):** Create specialized AI personas, each with its own system prompt, branding, avatar, and sampling parameters.
*   **Project Contexts:** Organize work into Projects. Attach files (text/PDF) to a project for deep, persistent context shared across every chat in that project.
*   **Sub-Agent Delegation:** Offload scoped research tasks to background sub-agents while the main conversation stays responsive. Sub-agent model, budgets, and retention are configurable; completed child contexts are pruned automatically with transcripts preserved in SQLite.
*   **Branches, Variants & Regeneration:** Fork any message into a new branch, regenerate replies, and flip between saved variants without losing history.

### 📊 Rich Responses: Cards, Flows, Charts
*   **Rich Blocks:** The assistant renders option cards and progress flows directly in chat.
*   **Interactive Charts:** Numerical answers arrive as toggleable bar/line/area/pie charts (pastel palettes that stay readable in all 16 themes).
*   **Faithful Rendering:** GFM tables, syntax-highlighted code with copy buttons, local image/video playback, LaTeX-arrow normalization, and inline color swatches for hex/rgb/hsl literals.

### 🧠 Intelligent Memory Palace
*   **Permanent Memory:** Facts, preferences, and rules that persist across all sessions — with optional "always inject" for mission-critical instructions. Memories can be global or scoped to specific models/agents.
*   **Dynamic Context Summarization (Compaction):** Token usage is continuously monitored; older messages are intelligently summarized into a compact digest before the context window fills, preserving essential history without manual intervention.
*   **Workspace Continuity:** Task briefs and resumable checkpoints preserve objectives, decisions, files changed, and next actions across compressions and restarts.

### 🛟 Workspace Recovery
*   **Crash-Safe Sessions:** A content-addressed recovery journal (blob store, manifests, checkpoints) snapshots workspace files as the agent works. Shell and MCP writes are boundary-scanned; restores preview before applying.
*   **Review & Restore UI:** Browse recovery history, inspect per-file diffs, pin checkpoints, and restore with one click. Retention and storage usage are configurable.
*   **Cache-Token Telemetry:** The Context tab breaks down prompt/completion/cache tokens per turn, so you can see prompt caching working.

### 🛠️ Extensible Tooling (MCP) — Including Self-Registration
*   **Model Context Protocol:** Full MCP support via `stdio` and `SSE`. Connect external tools, databases, and services using the industry-standard protocol.
*   **Agentic Extensibility:** The assistant can *build its own tools*. When asked to create an MCP server, it writes the code under `mcp-plugins/`, registers it in `mcp_config.json`, and the server hot-reloads into its toolbelt — no manual setup required.
*   **Native Tools:** Built-in filesystem access, media handling, memory operations, and a native Playwright browser-automation suite (no external MCP dependency needed).

### 🛡️ Safety Rails

*   **Git tools:** Status, diff, log, show, branch listing, and blame run in a Linux bubblewrap sandbox with a read-only filesystem and no network. Workspace staging allows explicit files only and confines Git filters to the workspace. These operations fail closed when bubblewrap or its required namespaces are unavailable.
*   **Commit review:** Outside Full Access, commit approval includes the staged diff; changed staged content or branch state requires a new approval. Approved commits retain normal identity, signing, and hook configuration and execute with the existing approved-command permissions. Full Access also permits unrestricted staging. Inspection remains sandboxed in every mode.
*   Dangerous database mutations (`DELETE FROM`, `TRUNCATE`, `DROP TABLE`, `deleteMany()`, broad-scope filters like `$ne` / `!=` / `1=1`) are detected before execution and **require explicit human confirmation**.
*   Bulk writes outside an id-scoped pattern trigger a read-only preview first — preventing accidental destruction of important data during autonomous agent operations.

### 🔒 Privacy & Performance (Local-First)
*   All chat history, metadata, memories, and settings live in a local **SQLite** database — lightning-fast retrieval, zero cloud dependency for core functionality.
*   One-time automatic migration handles legacy data directories transparently on startup.

### 🎨 Premium User Experience
*   **16 Themes + Custom Backgrounds:** Eight hand-built light/dark families (Mochi, Lilac, Matcha, Ember, Tokyo Night, Gruvbox, Solarized, plus defaults) with per-surface translucency over your own wallpaper.
*   **Custom Branding:** Each agent carries unique branding and avatars across the interface.
*   **Chat Controls (Right Sidebar):** Per-chat overrides for Agent & Persona, Sampling parameters, Thinking Budget, and Memory & Context — with one-click reset to model defaults.
*   **Chat Power Tools:** In-chat find (Ctrl+F), text selection actions, AI-generated titles, chat export (JSON/Markdown/Text), full-text history search, and per-model capability overrides.
*   **Rich Attachments:** Images, audio, video, PDFs, and documents via picker, paste, or drag-and-drop. Local media renders inline through a sandboxed media protocol.
*   **Media Generation:** Ask any chat model for an image and it invokes the image tool itself — routed to OpenRouter, any OpenAI-compatible images endpoint, or keyless local Stable Diffusion. Results save to your data directory and render inline like any other image. (Video defaults exist in settings; generation arrives with a supported video backend.)
*   **Advanced Settings Modal:** Granular control over model profiles, cloud provider credentials, memory/compaction toggles, engine connections, and offline document chat embeddings.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Runtime** | [Electron](https://www.electronjs.org/) |
| **Frontend** | [React](https://reactjs.org/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/) |
| **Inference Engine** | `llama.cpp` (via `hyllama`) + OpenAI/Anthropic-compatible cloud APIs |
| **Database** | [SQLite](https://www.sqlite.org/) |
| **Protocol** | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |
| **Browser Automation** | Playwright (native integration) |

---

## 🚀 Getting Started

### Prerequisites
*   [Node.js](https://nodejs.org/) ≥ 22.12 for development and release builds (required by Electron 44 tooling).
*   Linux x86_64: Ubuntu 22.04 LTS / Debian 12 or newer. See [Linux support and release validation](docs/migration-electron44-release-build.md); package execution on these minimum distributions remains unverified.

### Installation & Development

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/mk-saadi/continuum.git
    cd continuum
    ```

2.  **Install dependencies:**
    ```bash
    npm ci --ignore-scripts
    npm exec --no -- install-electron
    npm rebuild --foreground-scripts
    ```

3.  **Run in development mode:**
    ```bash
    npm run dev
    ```

### Building for Production

```bash
# Build the project
npm run build

# Build and package for your current OS (Vite build + electron-builder)
npm run dist
```

---

## 🧪 Development Notes

Tests use Node's built-in test runner. For suites that touch Electron-specific modules (SQLite ABI), run them under Electron's Node runtime:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/<suite>.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/<ui-suite>.cjs
npm run build
```

---

## 📂 Project Structure

*   `src/main/`: Core logic — `agentManager`, `projectManager`, `memoryManager`, `compressionEngine`, `cloudProviders`, `safetyGuards`, `mcpManager`, `nativePlaywright`, `recoveryStore`/`recoveryBoundary` (workspace recovery), `taskBriefs`/`taskCheckpoints`.
*   `src/components/`: React components for the user interface, including `RichBlocks` (cards/flows), `InteractiveChart`, and `chat/` timeline, recovery, and find widgets.
*   `src/hooks/`: Custom React hooks for state management and side effects.
*   `docs/`: Detailed documentation on chat history, file attachments, offline document chat, recovery architecture, and performance reports.
*   `tests/`: Comprehensive test suite (unit, integration, and UI tests).

---

## 🤝 Contributing

Contributions are welcome! Whether it's a bug fix, a new feature, or improved documentation:

1.  Fork the project.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes using conventional-commit style messages.
4.  Push to the branch and open a Pull Request.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

**Built with ❤️ for local AI enthusiasts.**
