# 🚀 LLM-Electron: The Ultimate Local AI Desktop Assistant

A high-performance, privacy-first desktop AI assistant built with **Electron**, **React**, and **Vite**. Experience the power of local large language models (LLMs) with a sophisticated agentic workflow, long-term memory, and seamless tool integration.

---

## ✨ Key Features

### 🤖 Agent Harness & Project Management
*   **Custom Agents:** Create specialized AI personas with unique system prompts, avatars, and sampling parameters. Each agent is a distinct entity optimized for specific tasks.
*   **Project Contexts:** Organize your work into **Projects**. Attach files (text/PDF) to a project to provide deep, persistent context that the assistant can reference across different chats within that project.
*   **Agentic Workflow:** Seamlessly switch between agents and manage multiple specialized personas for complex tasks.

### 🧠 Intelligent Memory Palace
*   **Permanent Memory:** Store critical facts, preferences, and rules that persist across all conversations. Use "Always Inject" to ensure the assistant never forgets your most important instructions.
*   **Dynamic Context Summarization (Compaction):** Never hit a context limit again. The system automatically monitors token usage and performs **intelligent context compaction**, summarizing older messages into a concise summary to free up space while preserving essential history.
*   **Memory Scoping:** Define memories that are global or scoped to specific models/agents for granular control.

### 🛠️ Extensible Tooling (MCP)
*   **Model Context Protocol (MCP):** Full support for MCP via `stdio` and `SSE`. Extend your assistant's capabilities by connecting it to external tools, databases, and services using the industry-standard protocol.
*   **Native Tools:** Built-in support for filesystem interaction, media handling, and more.

### 🔒 Privacy & Performance (Local-First)
*   **Local Inference:** Powered by `llama.cpp` (via `hyllama`), keeping your data on your machine. No cloud, no leaks, just pure privacy.
*   **SQLite Backbone:** All chat history, metadata, and memory are stored in a highly optimized local `SQLite` database for lightning-fast retrieval and rock-solid reliability.

### 🎨 Premium User Experience
*   **Custom Branding:** Each agent features unique **branding and avatars**, making your AI workspace feel personal and organized.
*   **Advanced Settings Modal:** Granular control over:
    *   **Model Profiles:** Configure system prompts, memory settings, and sampling parameters per model.
    *   **Memory Management:** Toggle global or session-specific memory and compaction settings.
    *   **Server Config:** Fine-tune local engine connections and offline document chat embeddings.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Runtime** | [Electron](https://www.electronjs.org/) |
| **Frontend** | [React](https://reactjs.org/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/) |
| **Inference Engine** | `llama.cpp` (via `hyllama`) |
| **Database** | [SQLite](https://www.sqlite.org/) |
| **Protocol** | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |

---

## 🚀 Getting Started

### Prerequisites
*   [Node.js](https://nodejs.org/) (LTS recommended)
*   [pnpm](https://pnpm.io/) (Preferred package manager)

### Installation & Development

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/mk-saadi/llm-electron.git
    cd llm-electron
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

3.  **Run in development mode:**
    ```bash
    pnpm dev
    ```

### Building for Production

To create a production-ready executable:

```bash
# Build the project
pnpm build

# Package for your current OS (Linux/macOS/Windows)
pnpm package
```

---

## 📂 Project Structure

*   `src/main/`: Core logic, including `agentManager`, `projectManager`, `memoryManager`, and `compressionEngine`.
*   `src/components/`: React components for the user interface.
*   `src/hooks/`: Custom React hooks for state management and side effects.
*   `docs/`: Detailed documentation on chat history, file attachments, and offline chat.
*   `tests/`: Comprehensive test suite (Unit, Integration, and UI tests).

---

## 🤝 Contributing

Contributions are welcome! Whether it's a bug fix, a new feature, or improved documentation, please feel free to open a Pull Request.

1.  Fork the project.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

**Built with ❤️ for local AI enthusiasts.**
