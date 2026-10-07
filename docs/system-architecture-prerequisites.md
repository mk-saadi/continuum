# Continuum: System Architecture & Prerequisites Report

**Inspection date:** 2026-09-30  
**Application version:** 1.0.0  
**Repository baseline:** `60442cd`, including the current working-tree implementation.

This report describes the source and packaging configuration, not a certified hardware benchmark or a completed cross-platform installer test. Hardware and capacity figures below are planning estimates. The existing local modification to `src/main/ragManager.js` was included in the analysis and left unchanged.

## 1. Architecture

Continuum is an Electron desktop application with a React 18 renderer built by Vite. The renderer accesses main-process services through preload/IPC APIs. The window enables context isolation and disables renderer Node integration; its Electron sandbox setting is explicitly `false`.

| Layer | Implementation and responsibility |
| --- | --- |
| Desktop lifecycle | `main.js`: window creation, startup migration, SQLite initialization, MCP startup, local inference process lifecycle and shutdown. |
| UI and IPC | `src/components/`, `preload.js`, `src/main/ipcHandlers.js`: settings, conversations, uploads, streaming responses and tool dispatch. |
| Local inference | `engineManager.js` and `main.js`: spawn an **external `llama-server` executable**, then use its OpenAI-compatible HTTP API. `hyllama` parses GGUF metadata; it is not the inference runtime used by this application. |
| Cloud inference | `cloudProviders.js`: configurable OpenAI-compatible and Anthropic-compatible endpoints, model IDs and credentials. |
| Context and agents | `promptBuilder.js`, `profileSettings.js`, `settingsResolver.js`, `sessionManager.js`, `memoryManager.js` and `compressionEngine.js`: history, model/chat settings, agent instructions, project files, memory and compaction. |
| Document retrieval | `fileUploads.js` and `ragManager.js`: managed file copies, PDF/text extraction, local Transformers.js embeddings, SQLite chunk/vector storage and cosine retrieval. |
| Tools | `tools/agentTools.js`: project files, shell commands, screenshots and delegation. `mcpManager.js` connects local stdio and remote MCP servers. `nativePlaywright.js` configures the bundled Playwright MCP integration. |
| Persistence | `better-sqlite3`: local `memory_palace.db`, including history, settings, memories, project metadata and document vectors. No database server or separate vector database is required. |

The normal request path is renderer → IPC → context/settings construction → local or cloud model → tool dispatch/retrieval → subsequent model response → persisted conversation. RAG embeddings run locally, but retrieved excerpts and other prompt content can be sent to the selected cloud model. “Local indexing” does not mean cloud document conversations keep all document text on-device.

Delegation is a bounded, tool-free request to the already running local model, not a separate autonomous process or another loaded model. Cloud chat filters out `delegate_task`. The compaction callback supplied by `main.js` also requires a local server; cloud-only operation should not be advertised as having full feature parity without verifying compaction behavior.

## 2. End-user machine requirements

### 2.1 Hardware planning

There is no enforced RAM, VRAM, CPU-model or CUDA minimum in the repository. Actual requirements depend on the external inference build, model architecture, quantization, context length, cache precision, batch sizes and offloaded layers.

| Workload | Practical starting point | Recommended planning target |
| --- | --- | --- |
| Cloud-only chat | Modern 64-bit dual-core CPU, 4 GB system RAM, integrated graphics; no dedicated VRAM | 4 CPU cores and 8 GB RAM; 16 GB when running browsers, indexing documents or developing plugins concurrently |
| Small local GGUF, roughly 1–3B at 4-bit | 4 CPU cores and 8 GB RAM; CPU-only operation can use **0 GB dedicated VRAM** | 16 GB RAM; optional 4–6 GB GPU for suitable models and modest contexts |
| Local 7–8B at 4-bit | 4+ CPU cores and 16 GB RAM for a practical CPU/partial-offload starting point | 6–8 CPU cores, 32 GB RAM and 8–12 GB VRAM for GPU use at modest contexts |
| Local 13–14B at 4-bit | Approximately 24–32 GB RAM for CPU/partial offload | 32–64 GB RAM and 16–24 GB VRAM, depending on context and model |
| Local 27–32B at 4-bit | Approximately 32–64 GB RAM for CPU/partial offload | 64 GB RAM and 24–32+ GB VRAM; large contexts can require considerably more |

These are estimates, not guaranteed fit thresholds. CPU-only inference can be substantially slower. On unified-memory hardware, budget model and application memory together rather than adding a separate VRAM allowance. The CPU must support the instruction set used by the chosen native binaries; the repository does not mandate AVX2 or a particular processor generation.

Model weight size is only part of the memory budget:

`required memory ≈ resident weights + KV cache + compute buffers + embedding/browser/app overhead`

Default load settings are context length **8192**, GPU offload **auto**, **4** threads, evaluation batch **2048**, physical batch **512**, **1** parallel slot, automatic flash attention and **f16** K/V caches. Reduce context/batches or offloaded layers if allocation fails. `mlock` is optional and may require adequate OS locked-memory limits. Switching to cloud inference does not itself unload a local model; unload it or configure the idle timeout to release its resources.

### 2.2 GPU drivers and toolkits

CUDA is optional. Cloud-only chat, CPU inference and the current local embedding path do not require an NVIDIA GPU or CUDA installation.

For NVIDIA acceleration, install a CUDA-enabled `llama-server` build and a driver compatible with that build and GPU. Continuum neither bundles nor pins CUDA or the inference server. NVIDIA lists driver-family baselines of **525+ for CUDA 12.x** and **580+ for CUDA 13.x** under minor-version compatibility; individual binaries, PTX usage and features may require newer drivers. These are compatibility guidelines, not a Continuum-specific driver guarantee. [NVIDIA compatibility documentation](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)

A prebuilt server needs its required runtime libraries, which may accompany the distribution; installing the full CUDA development toolkit is not automatically necessary. Compiling a CUDA server requires the toolkit, compatible C/C++ compiler and CMake. Other builds can use CPU, Metal, HIP or Vulkan with their respective platform requirements. Select the backend when obtaining/building `llama-server`; Continuum does not install it. [llama.cpp build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)

### 2.3 Operating systems and paths

`package.json` explicitly configures Linux **AppImage** and **deb** targets. It does not establish a tested Windows/macOS release matrix or minimum OS versions. Native addons, Electron and the selected Playwright browser must all support the target OS and architecture; separate platform builds and validation are necessary.

Expected Electron profile roots, assuming the application name `Continuum`, are:

| OS | Electron `userData` default |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/Continuum`, or `~/.config/Continuum` when unset |
| macOS | `~/Library/Application Support/Continuum` |
| Windows | `%APPDATA%\Continuum` |

Electron derives these locations from the application name and platform. A diagnostic should display `app.getPath('userData')` rather than reconstructing it. [Electron path documentation](https://www.electronjs.org/docs/latest/api/app#appgetpathname)

| Asset/configuration | Actual location and behavior |
| --- | --- |
| Directory preferences | `<userData>/directories.json` |
| New-install application data | `<userData>/App_Data/`, unless changed in Settings |
| Legacy application data | If `memory_palace.db` already exists directly in `userData`, that root remains the default |
| Database | `<appDataDirectory>/memory_palace.db`, with SQLite WAL/SHM sidecars as needed |
| Uploaded files | `<appDataDirectory>/attachments/` |
| Embedding download cache | `<appDataDirectory>/embedding-models/` |
| Avatars | Managed as application data under `avatars/` |
| Default model directory | `path.join(os.homedir(), 'Desktop', 'LLM_Models')`; a literal Desktop folder, not an OS-localized Desktop lookup |
| MCP configuration | **`path.join(os.homedir(), '.config', 'Continuum', 'mcp_config.json')` on every OS** |
| Agent-created plugins | `<current-project>/mcp-plugins/<server-name>/` |

The MCP path is an important exception: it does not follow macOS/Windows profile conventions or Linux `XDG_CONFIG_HOME`. Changing App Data Directory does not move this central MCP configuration or project-local plugins. Filesystem MCP launches automatically receive the configured model and app-data directories as additional allowed-directory arguments.

Settings → directory controls can change Model Directory or migrate App Data Directory to an empty folder. App-data migration coordinates database access, verifies copied content and relocates stored attachment/vector file references. A startup migration also handles the former `LLM Desktop Assistant` profile and retains the old directory for recovery.

The application account needs read/write access to its data directory, including permission to create SQLite journal files, and read access to models. SQLite uses WAL, foreign keys and a 5000 ms busy timeout. No manual SQLite CLI installation or database provisioning is needed.

### 2.4 Storage budget

| Item | Planning allowance |
| --- | --- |
| Packaged application and native libraries | Reserve 1–2 GB as a starting allowance; measure each actual installer/unpacked release |
| Playwright Chromium/cache | Reserve roughly 0.5–1 GB initially; multiple revisions and browser data increase this |
| Quantized MiniLM embedding model | Published `model_quantized.onnx` is approximately **23 MB**, plus tokenizer/configuration files; reserve 100–200 MB for this cache |
| 1–3B Q4 GGUF | Roughly 1–3 GB per model |
| 7–8B Q4 GGUF | Roughly 4–6 GB per model |
| 13–14B Q4 GGUF | Roughly 8–10 GB per model |
| 27–32B Q4 GGUF | Roughly 16–22 GB per model |
| History, attachments and document vectors | Workload-dependent; retain several GB of free growth space and backup capacity |

GGUF sizes vary by format and architecture; vision projector files require additional space. Use downloaded file sizes for final capacity planning. The MiniLM size comes from the [model publisher’s file listing](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx).

Uploads create managed copies rather than references to the originals. Limits are **10 files**, **20 MiB per file**, and **50 MiB per upload batch**. RAG stores chunk text and embedding arrays as JSON in SQLite; the database can grow substantially beyond the source text size. The current chunker uses 500 characters with 50-character overlap and a 10,000-chunk limit per document. Allow room for both source and destination during data migration and for retained legacy data/backups.

### 2.5 Runtime and build prerequisites

**Packaged end users:** Electron supplies Chromium and its Node runtime. Ordinary chat, PDF extraction and built-in embeddings do not require a separately installed Node.js, Python, npm or compiler. Platform-native libraries still need to load successfully.

**Source development and host-launched Node plugins:** the manifest says Node `>=18.0.0`, but this understates the dependency requirements:

| Component | Declared/runtime requirement |
| --- | --- |
| Continuum manifest | Node `>=18.0.0` |
| `pdf-parse` 2.4.5 | Node `>=20.16.0 <21 || >=22.3.0` |
| Locked `playwright-core` | Node `>=20` |
| MCP SDK 1.30.1 | Node `>=18`; individual servers can require newer versions |
| Pinned Electron 30.5.1 | Embeds Node **20.16.0**, independently of host Node |

For the inspected dependency set, use Node **22.3+ within the 22.x line** as a practical development baseline, subject to the selected plugins’ requirements. Node 20.16 satisfies the listed package engine constraints, but `>=18` alone does not. Plugins relying on unflagged global `crypto` should use Node 20+ at minimum; Web Crypto became available without the experimental global flag in Node 19. [Node globals documentation](https://nodejs.org/docs/latest/api/globals.html), [Electron 30.5.1 runtime versions](https://releases.electronjs.org/release/v30.5.1)

The inspected `node_modules` contains Electron **33.4.11**, while both manifest and lockfile specify **30.5.1**. Local execution therefore does not establish compatibility of a clean locked installation or a packaged release. Electron 30 is also upstream end-of-support, so release maintenance should include a supported runtime upgrade and native-module validation. [Electron release status](https://releases.electronjs.org/release/v30.5.1)

`npm install` runs `electron-builder install-app-deps` to prepare native dependencies for Electron. `better-sqlite3` must match the packaged Electron ABI, OS and architecture. If compatible prebuilts are unavailable, native compilation generally needs Python for node-gyp and platform C/C++ tools: GCC/Clang and make on Linux, Xcode Command Line Tools on macOS, or Visual Studio C++ Build Tools on Windows. These are developer/plugin-build prerequisites, not mandatory end-user installs. [node-gyp installation requirements](https://github.com/nodejs/node-gyp#installation)

The configured production command is `npm run dist` (Vite build followed by electron-builder). The README’s `npm run package` example does not correspond to a defined script.

## 3. Bundled versus external dependencies

“Bundled” below means included in the packaged application resources/dependency tree, sometimes unpacked beside `app.asar`; it does not mean every dependency lives inside a single executable. Inclusion is based on the build configuration, not a fresh installer smoke test.

| Component | Bundled code | External requirement |
| --- | --- | --- |
| Electron, React UI | Yes | Compatible OS/desktop libraries |
| `better-sqlite3` | Yes, including target-specific native addon when packaging succeeds | Writable data directory; no database service |
| `pdf-parse`, PDF.js and dependencies | Yes | PDF must contain extractable text; no Poppler executable |
| `@xenova/transformers` and ONNX runtime dependencies | Yes | Model/tokenizer assets download on first use; writable embedding cache |
| `hyllama` | Yes | User-supplied GGUF files for metadata scanning |
| `@modelcontextprotocol/sdk` | Yes | Runtimes/dependencies of separately configured servers |
| `@playwright/mcp`, `playwright`, transitive `playwright-core` | Yes; Playwright packages explicitly unpacked | Separate matching Chromium browser download/cache and platform libraries |
| Local inference executable | **No** | Install compatible `llama-server`; make it visible on the app’s inherited `PATH`, or use a custom launch command |
| GGUF model and vision projector weights | **No** | Download/provision separately |
| NVIDIA driver/CUDA libraries | **No** | Required only by the selected GPU inference distribution |
| Custom MCP servers, npm/pip dependencies | **No**, unless separately shipped by a plugin | Install in the plugin environment |
| Cloud model service | **No** | Reachable endpoint, account/API key and model access |

No manual `poppler-utils`, `pdftotext`, Python embedding script, PyTorch installation, external embedding service, SQLite server or vector database is needed for built-in document chat. OCR is not implemented: scanned image-only PDFs need preprocessing elsewhere.

**Browser distinction:** Electron bundles a browser for the application UI, but native automation launches a separate Playwright Chromium executable. `nativePlaywright.js` starts the bundled MCP CLI using `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. If its expected browser is missing, it runs `install-browser chromium --no-shell`, with a 180-second timeout, and reuses the cache afterward. Users normally do not manually install Chromium or global Playwright, but the browser binary is **not shipped by this packaging configuration**. Initial network/cache access is required. Linux browser libraries can require separate installation; this code does not run Playwright’s OS dependency installer. [Playwright browser installation documentation](https://playwright.dev/docs/browsers)

Playwright’s usual cache roots are `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS and `%USERPROFILE%\AppData\Local\ms-playwright` on Windows, unless overridden. The expected executable path depends on the Playwright version used by the MCP package. [Playwright browser caches](https://playwright.dev/docs/browsers#managing-browser-binaries)

## 4. External assets and first-run setup

### Local models

1. Obtain a `llama-server` build supporting the desired model architecture and Continuum’s flags, including Jinja templates, reasoning format, cache types and GPU-offload options. The repository does not pin a compatible llama.cpp revision.
2. Ensure the desktop-launched app can locate `llama-server` on its `PATH`; shell-only environment initialization may not reach GUI launches. The standard model loader calls that literal command with `shell: false`. A custom command can specify an absolute executable path.
3. Download a compatible `.gguf` model into any readable directory. The default scan root is `~/Desktop/LLM_Models`; Settings → Model Directory can select another existing absolute directory.
4. Scan and select the model. Scanning is recursive. For vision, place the matching `mmproj*.gguf` alongside the model. The scanner prefers a filename match, or the sole projector in that directory; multiple unmatched projectors are intentionally ambiguous.
5. Choose context, offload and batch settings that fit available memory, then load. The server port defaults to **8080**; Settings can select another port or automatic allocation. A conflicting configured port causes startup to fail.

`model-execution-commands.txt` contains machine-specific examples with absolute paths and custom-fork flags. Those paths and binaries are not portable installation prerequisites.

### Offline embeddings

The active RAG implementation loads `Xenova/all-MiniLM-L6-v2` through `pipeline('feature-extraction', ..., { quantized: true })`, using mean pooling and normalized vectors. The first indexing/query operation downloads assets into the configured embedding cache; subsequent use can work offline with a complete cache. For an offline deployment, populate that cache before disconnecting and test retrieval offline.

Legacy `embeddingPort`, `embeddingModel` and `embeddingApiKey` settings remain in `configManager.js`, but the inspected `ragManager.js` does not use them. An embedding server on port 8081 is not a current prerequisite.

### Cloud providers

In Settings → Cloud Providers, provide a name, base URL, API type, model ID and API key. OpenAI-compatible requests use Bearer authorization; Anthropic-compatible requests use `x-api-key` and the Anthropic version header. Cloud chat does not require GGUF files or `llama-server`.

Saved credentials reside as **unencrypted JSON in SQLite** under `app_settings['cloud-providers']`; there is no `safeStorage`/OS-keychain encryption in this path. Configuration reads sent to the renderer redact stored keys and expose a `configured` flag, although the renderer necessarily handles newly entered credentials. An empty key on editing preserves the existing saved key. Treat database copies/backups as credential-bearing files. HTTP URLs are accepted as well as HTTPS; choose HTTPS for remote providers.

## 5. Agent and MCP environment setup

### Host prerequisites

Project tooling requires a session attached to an existing project directory. The account running Continuum needs permission to read/write that project, create `mcp-plugins/`, update the central MCP configuration, launch child processes and reach any dependency registries/services it uses.

| Server/workflow | Host requirement |
| --- | --- |
| JavaScript/TypeScript MCP server | Node satisfying that server’s requirements; npm/npx or another package manager if used; TypeScript build/run tooling if applicable |
| Python MCP server | Appropriate Python interpreter and dependencies, preferably an explicit virtual-environment executable; pip/uv only when the workflow uses them |
| Git-backed setup | Git when cloning, installing Git dependencies or running repository commands; not required just to connect MCP |
| Native dependency compilation | Platform build tools only when dependencies must compile |
| Remote MCP | Reachable HTTP(S) URL and configured authentication headers; no local Python/Node server required |
| Built-in Playwright MCP | Bundled Electron runtime; no host Node/npm required for this integration |

Local stdio servers inherit `process.env` plus configured `env`, and run with the supplied `command`, `args` and optional `cwd`. Use absolute interpreter/script paths when GUI `PATH` resolution is uncertain. No automatic virtual environment or OS sandbox is created. Remote transports support SSE and streamable HTTP.

### Registration and hot reload

The system prompt instructs the agent to build under the current project’s `mcp-plugins/`, install dependencies, preserve existing configuration entries and atomically merge a server definition. This is a workflow instruction; it is not a dedicated plugin installer.

Example entry to merge into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "project-helper": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/project/mcp-plugins/project-helper/server.mjs"],
      "cwd": "/absolute/project/mcp-plugins/project-helper",
      "enabled": true
    }
  }
}
```

`mcpManager.js` watches the configuration’s parent directory and debounces changes by 150 ms. Added/changed definitions connect or restart; removed definitions close. Invalid intermediate edits preserve existing clients during reload. Server/tool switches affect declarations and dispatch, and MCP tool-list notifications refresh available tools. Startup connections have a 15-second timeout; tool calls use a 60-second timeout.

**Hot reload applies to configuration changes, not plugin source files.** Rewriting a script without changing its definition does not restart it; even a reload with an identical definition keeps the connection. Disable/re-enable the server or change its launch definition after source edits. Native shell commands have a 45-second timeout, which can affect dependency installations or long-running builds.

## 6. Security and execution bounds

### Implemented controls

- `requiresConfirmation()` detects selected SQL, MongoDB and Redis mutation patterns, including `DELETE FROM`, `TRUNCATE`, `DROP`, `UPDATE ... SET`, `deleteMany`, `updateMany` and `FLUSHALL`/`FLUSHDB`.
- It treats recognized ID equality/list predicates as narrow scope, but broad conditions such as `$ne`, `$nin`, `!=`, `NOT IN` or `1=1` trigger rejection even when an ID signal is present.
- `executeAgentTool()` checks native `execute_command` text before calling the shell. A flagged command returns a safety-intercept string instructing the agent to explain the exact data being modified and request explicit permission. The agent can then re-run that exact command with the optional boolean `user_confirmed: true`; only literal `true` bypasses this guard for that call.
- `mcpManager.callTool()` checks `JSON.stringify(args)` with the same guard for every MCP invocation. Flagged payloads throw an intercept error containing a 16-character SHA-256 hash. After explicit permission, the agent calls `approve_mcp_mutation` with that hash and retries. A shared in-memory `approvedMutations` Set grants one dispatch attempt; its entry is deleted synchronously before the server call, including attempts that subsequently fail.
- The session system prompt prohibits loose-filter bulk deletions, requires exact test-created IDs for cleanup, and instructs the agent to present a read-only preview and obtain explicit human confirmation before broader deletion/bulk writes.
- Native file writes and command working directories are project-scoped with traversal/symlink checks. Native reads additionally permit Electron `userData` and OS temporary directories. Managed attachment validation verifies canonical paths inside the attachment directory.
- Disabled MCP servers/tools are omitted from declarations and rejected at dispatch. Server configuration saves use atomic replacement and request file mode `0600` where supported.

### Material limits

1. **The guard is heuristic, not a SQL parser or permission system.** It can miss indirect/encoded/script-based operations, and an ID-shaped predicate is not proof that records were created in the current test run.
2. **MCP payload checking remains heuristic.** The guard checks serialized argument text rather than tool semantics or server implementation. Approvals are keyed only by the exact serialized payload, not the server, tool or session, and remain in process memory until consumed or the process exits. Database MCP servers still need their own authorization/read-only controls.
3. **Confirmation is agent-driven, not independently authenticated.** The optional `user_confirmed: true` argument allows a flagged shell command to execute; `approve_mcp_mutation` grants a single MCP payload attempt. Tool descriptions and intercept messages require explicit user permission, but the runtime does not verify the conversation. Shell confirmation is not retained between calls; MCP confirmation is consumed on dispatch.
4. **A project-scoped working directory does not confine shell access.** `child_process.exec()` can address absolute paths, use the network and mutate anything permitted to the OS account. This capability is also how the instructed plugin workflow updates central configuration outside the project. General shell deletion and other non-database mutations do not receive universal confirmation checks.
5. **MCP servers run with host-account privileges and inherited environment.** Directory allowlists provided to filesystem MCP constrain that server’s API, not all subprocesses or shell commands.
6. **The inference API is intentionally unauthenticated in the standard launch path.** API-key environment variables are removed, custom key flags are stripped, and permissive CORS variables are set. Continuum connects via `127.0.0.1`, but standard arguments do not explicitly pin `--host`; verify the selected server’s actual bind address, especially with custom commands or inherited settings.

These controls reduce common mistakes, but do not establish an OS sandbox or universal human-approval boundary.

## 7. Suggested diagnostic fields

A system diagnostic view should report observations without printing credentials:

| Area | Useful checks |
| --- | --- |
| Runtime | App version, OS/architecture, actual Electron/Node versions, packaged/development mode |
| Paths | Actual `userData`, configured app/model directories, central MCP path and write/read availability |
| Database | Native addon load, database open/write status, WAL status and available disk space |
| Local inference | Executable resolution/version, active model/projector sizes, load settings, port/bind address and startup errors |
| GPU | GPU/VRAM and driver, with compatibility evaluated against the installed inference build rather than a universal CUDA threshold |
| RAG | Embedding cache presence, model-load status, PDF extraction and a small indexing/retrieval check |
| Browser | Expected browser executable, cache availability and a launch smoke test; distinguish missing browser assets from missing OS libraries |
| MCP | Command/interpreter availability, cwd, connection status, disabled tools and config errors; redact environment secrets/headers |
| Cloud | Endpoint, model and key-present status; optional connectivity test without exposing keys |

## 8. Source map and validation scope

Primary repository evidence:

- [Package manifest](../package.json) and [lockfile](../package-lock.json): versions, engines, scripts and packaging.
- [Main process](../main.js), [engine manager](../src/main/engineManager.js), [model scanner](../src/main/modelScanner.js): executable/process boundaries, model discovery and load flags.
- [Directory configuration](../src/main/configStore.js), [settings defaults](../src/main/configManager.js), [directory UI](../src/components/DirectorySettings.jsx), [database](../src/main/db.js), [migration](../src/main/dataMigration.js): paths and persistence.
- [Uploads](../src/main/fileUploads.js), [RAG](../src/main/ragManager.js), [prompt builder](../src/main/promptBuilder.js): managed files, embeddings and prompt contents.
- [MCP manager](../src/main/mcpManager.js), [native Playwright](../src/main/nativePlaywright.js), [agent tools](../src/main/tools/agentTools.js), [safety guard](../src/main/safetyGuards.js), [IPC dispatch](../src/main/ipcHandlers.js): runtime requirements and enforcement boundaries.
- [Cloud providers](../src/main/cloudProviders.js) and [sub-agent runner](../src/main/subAgentRunner.js): credentials, inference routing and delegation limits.

Validation consisted of source/configuration inspection, installed-versus-locked dependency comparison and upstream documentation checks. No application code was changed, model weights downloaded, GPU benchmarks performed, plugin servers registered or new installer built for this report. Bundled native modules and first-run downloads still need release-specific smoke tests on each supported target.
