"use strict";

const { prependBaseSystemPrompt } = require("./baseSystemPrompt");
const fs = require("node:fs");
const path = require("node:path");
const { getProject } = require("./projectManager");
const { validateAttachments, attachmentName } = require("./fileUploads");
const { db } = require("./db");
const { getSessionAgent } = require("./agentManager");
const { getCoreMemories } = require("./memoryManager");
const { nativeTools } = require("./nativeTools");
const { agentTools, hasProjectWorkspace } = require("./tools/agentTools");
const {
	getOrCreateSession,
	saveMessage,
	getActiveMessages,
	getSessionSummary,
	getRegenerationTarget,
} = require("./sessionManager");

const memoryTools = [
	...nativeTools.map(({ function: { name, description, parameters } }) => ({
		name,
		description,
		input_schema: parameters,
	})),
	{
		name: "save_memory",
		description:
			"Extract and save a concise, atomic fact, preference, or rule ABOUT THE USER to long-term memory. DO NOT save raw conversational strings, banter, or any facts/corrections regarding the AI model's identity or architecture.",
		input_schema: {
			type: "object",
			properties: {
				category: {
					type: "string",
					description:
						"Category: 'preference', 'tech_stack', 'project_rule', 'user_fact'. user_fact: Facts strictly about the user (e.g. location, role, background). NEVER use for AI model facts.",
				},
				content: {
					type: "string",
					description:
						"The distilled, normalized fact. Examples: 'Favorite color: black', 'Prefers package manager: pnpm', 'OS: macOS'. NEVER include conversational phrases like 'remember that' or 'from now on'.",
				},
				always_inject: { type: "boolean", default: true },
			},
			required: ["category", "content"],
			additionalProperties: false,
		},
	},
];

const VISUALIZATION_PROMPT = [
	"### Visualizations & Charting",
	"Continuum has a native, client-side rendering engine for charts, diagrams, and data visualizations via Mermaid.js.",
	"- NEVER run terminal commands (`execute_command`), write Python scripts, or install `matplotlib`/`pip` packages to create charts or images.",
	"- When asked for graphs, charts, flowcharts, architecture diagrams, sequence maps, or data trends, output a ```mermaid code block directly in your response text.",
	"",
	"Supported Mermaid Chart Types:",
	"1. Bar / Line Charts (XY Chart):",
	"   ```mermaid",
	"   xychart-beta",
	"       title \"Dhaka Monthly Temperature (°C)\"",
	"       x-axis [Jun, Jul, Aug, Sep]",
	"       y-axis \"Temp (°C)\" 0 --> 40",
	"       bar [33, 31, 32, 30]",
	"       line [33, 31, 32, 30]",
	"   ```",
	"2. Pie Charts:",
	"   ```mermaid",
	"   pie title Weather Distribution",
	"       \"Sunny\" : 60",
	"       \"Rainy\" : 30",
	"       \"Cloudy\" : 10",
	"   ```",
	"3. Flowcharts & Sequence Diagrams:",
	"   ```mermaid",
	"   graph TD",
	"       A[Start] --> B(Fetch Data)",
	"       B --> C{Success?}",
	"       C -->|Yes| D[Render Chart]",
	"       C -->|No| E[Log Error]",
	"   ```",
].join("\n");

const SUB_AGENT_PROTOCOL = [
	"### Sub-Agent Delegation Protocol",
	"You have access to the `spawn_subagent` tool. It runs one focused task in a completely isolated, throwaway model context and returns ONLY a distilled summary to your main context. Source pages and files do not enter your main conversation history.",
	"",
	"#### 1. MANDATORY Delegation Triggers (Do NOT do these in Main Context):",
	"- **Web Page Scraping & Reading:** NEVER call `get_single_web_page_content` or `get-single-web-page-content` to read a full URL in the main context. ALWAYS call `spawn_subagent` with one URL and a specific question. The sub-agent fetches the page and returns a short answer, not raw HTML.",
	"- **Multi-Source Research:** When comparing benchmarks, documentation, or web links, call `spawn_subagent` separately for each URL or source, then compare the returned summaries in the main context.",
	"- **Large File / Log Inspection:** Delegate files longer than 500 lines and raw log inspection. Provide project-relative paths in `target_files`; request only the relevant findings. If an isolated task exceeds its budget, narrow the files or question rather than loading the whole source into main context.",
	"",
	"#### 2. Allowed Main Context Actions (Do NOT delegate):",
	"- Read small, specific files under 100 lines when needed for an immediate code edit.",
	"- Use a simple `full-web-search` search, when that tool is available, to get brief search-result snippets. Delegate full-page reading after choosing a result.",
	"- Run quick builds or tests with `execute_command` when needed.",
	"",
	"#### 3. Sub-Agent Invocation Pattern:",
	"Call `spawn_subagent` with a single-purpose `task`. Include a `constraint` that limits length and forbids raw HTML, boilerplate, or full file dumps. Use `expected_output` to specify the format. For web research, include exactly one URL in `task` or the `url` field. For file research, supply `target_files`. Await the summary before continuing; do not paste source content into main history.",
	"",
	"Example correct invocation:",
	"```json",
	"{",
	"  \"tool\": \"spawn_subagent\",",
	"  \"arguments\": {",
	"    \"task\": \"Inspect https://example.com/benchmarks and extract Llama 3.1 70B MMLU and HumanEval scores.\",",
	"    \"constraint\": \"Return only the relevant metrics. No raw HTML or boilerplate.\",",
	"    \"expected_output\": \"A markdown table with exact numbers and a two-sentence summary.\"",
	"  }",
	"}",
	"```",
].join("\n");

function buildSystemPrompt({ modelId, memoryEnabled = true }) {
	if (typeof modelId !== "string" || !modelId.trim() || modelId.includes("\0")) {
		throw new TypeError("modelId must be a non-empty string without null characters.");
	}
	if (typeof memoryEnabled !== "boolean") throw new TypeError("memoryEnabled must be a boolean.");
	let coreMemoriesText = "";
	if (memoryEnabled) {
		coreMemoriesText = getCoreMemories(modelId)
			.map(({ category, content }) => `- [${category}]: ${content}`)
			.join("\n");
	}

	return {
		role: "system",
		content: `[BACKGROUND KNOWLEDGE & USER PREFERENCES]
${coreMemoriesText || (memoryEnabled ? "No background memories saved yet." : "Automatic background memory injection is disabled.")}

`,
	};
}

// Read only two entry levels; Dirents deliberately avoid following directory symlinks.
function workspaceTree(rootPath) {
	const excluded = new Set(["node_modules", ".git", "dist", "build"]);
	function walk(directory, depth, prefix = "") {
		let entries;
		try {
			entries = fs
				.readdirSync(directory, { withFileTypes: true })
				.filter((entry) => !excluded.has(entry.name))
				.sort(
					(a, b) =>
						Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
				);
		} catch {
			return [];
		}
		return entries.flatMap((entry, index) => {
			const last = index === entries.length - 1;
			const line = `${prefix}${last ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}`;
			return [
				line,
				...(entry.isDirectory() && depth > 1
					? walk(path.join(directory, entry.name), depth - 1, `${prefix}${last ? "    " : "│   "}`)
					: []),
			];
		});
	}
	return [rootPath, ...walk(rootPath, 2)].join("\n");
}

function buildProjectContext(sessionId) {
	const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId);
	if (!session?.project_id) return "";
	const project = getProject(session.project_id);
	const sections = [];
	if (project.description) sections.push(`[PROJECT GOAL]\n${project.description}`);
	if (project.custom_instructions) sections.push(`[PROJECT INSTRUCTIONS]\n${project.custom_instructions}`);
	if (project.files.length) {
		sections.push(
			`[PROJECT CONTEXT FILES]\n${project.files
				.map(
					(file) =>
						`[File: ${file.file_name}]\nPath: ${file.file_path}\n${file.content ?? ""}\n[End of File]`,
				)
				.join("\n\n")}`,
		);
	}
	let isDirectory = false;
	try {
		isDirectory = !!project.root_path && fs.statSync(project.root_path).isDirectory();
	} catch {
		/* Workspace may be offline. */
	}
	if (isDirectory) {
		for (const name of ["AGENTS.md", "PROJECT.md"]) {
			try {
				const guidelines = fs.readFileSync(path.join(project.root_path, name), "utf8");
				sections.push(`[REPOSITORY GUIDELINES]\n${guidelines}`);
				break;
			} catch {
				/* Try the fallback if the preferred file is absent or unreadable. */
			}
		}
		sections.push(`[WORKSPACE STRUCTURE]\n${workspaceTree(project.root_path)}`);
	}
	return sections.join("\n\n");
}

function buildSessionSystemPrompt({ sessionId, modelId, delegationAvailable = true }) {
	const effective = require("./profileSettings").getSessionSettings(sessionId, modelId).effective;
	const prompt = effective.memoryEnabled ? buildSystemPrompt({ modelId }) : { role: "system", content: "" };
	const agent = getSessionAgent(sessionId);
	if (effective.systemPrompt)
		prompt.content += `\n\n[${agent ? `ACTIVE AGENT: ${agent.name}` : "ASSISTANT INSTRUCTIONS"}]\n${effective.systemPrompt}`;
	const projectContext = buildProjectContext(sessionId);
	if (projectContext) prompt.content += `\n\n${projectContext}`;
	const mcpManager = require('./mcpManager');
	let serverNames = [];
	try {
		const config = JSON.parse(fs.readFileSync(mcpManager.configPath, 'utf8'));
		serverNames = Object.keys(config.mcpServers || {});
	} catch { /* MCP manager reports malformed or unavailable configuration separately. */ }
	if (serverNames.length) prompt.content += `\n\nAvailable dynamic tools (MCP servers): ${serverNames.map(name => JSON.stringify(name)).join(', ')}. MCP servers are off by default to save context unless enabled in the UI or for this chat. If you need a server to fulfill the user's request, call \`manage_mcp_servers\` with action \`enable\` and its server name first. You can also disable a server or restart it if it times out. Its tools appear in your schema on the next turn.`;
	prompt.content +=
		"\n\nCROSS-SESSION MEMORY: You have access to the `get_recent_chat_history` tool. If the user asks about previous topics, past chats, or what you were just talking about in another/global session, use `get_recent_chat_history` to pull recent messages before answering. When using search queries, provide short, broad 1-2 word keywords to cast a wide net.";
	prompt.content += `\n\nBROWSER AUTOMATION: The Playwright MCP server provides browser tools when enabled. In a project, start local development servers with execute_command, then enable \`playwright-native\` using \`manage_mcp_servers\` if browser testing is needed. Use browser_snapshot to read the accessibility tree if navigation returns a snapshot file link. If the integration reports a setup error, report that limitation instead of claiming browser access.`;
	prompt.content += `\n\nAGENTIC EXTENSIBILITY: When asked to create an MCP server, build it inside the \`mcp-plugins/\` directory. Once the code is written, you MUST automatically edit \`mcp_config.json\` to register the new server's execution command, then call \`manage_mcp_servers\` to enable it for this chat.
The central config file is ${JSON.stringify(require("./mcpManager").configPath)}. Read and merge its existing entries; preserve unrelated servers and options. Use the existing JSON format: {"mcpServers":{"server-name":{"command":"python","args":["/absolute/project/path/mcp-plugins/server-name/server.py"],"cwd":"/absolute/project/path","enabled":true}}}. Build mcp-plugins/ under the current project. Use execute_command from the project to read and atomically update the central config at its absolute path. Use absolute script paths and an explicit cwd. Install required dependencies before enabling the server.`;
	prompt.content += `\n\n[AUTONOMY RULES]
CRITICAL: Never output plain status text (e.g., 'Let me check...', 'I will now run...') without invoking a tool call in the same response. You must keep issuing tool calls until the requested objective is fully resolved or you require user clarification.
CRITICAL: When using \`str_replace_editor\`, do NOT rewrite the entire file. You must make small, surgical replacements. If adding tests, replace a specific anchor at the bottom of the file rather than replacing the whole document.
When the objective is fully resolved, end your final response with [TASK COMPLETE]. When you need user clarification, end with a direct question and a question mark (?). Do not claim completion before the work is finished.`;
	prompt.content += `\n\n[SAFETY RULES]
CRITICAL: Never run bulk deletion queries (e.g. deleteMany, DELETE FROM ... WHERE) using loose property filters such as {"source": {"$ne": "manual"}} or "source != 'manual'" against any database collection. Filters using $ne/!= on optional fields also match documents where the field is entirely absent, and can silently delete unrelated production data.
When cleaning up test data, restrict deletions explicitly to the specific document _ids (or equivalent primary keys) created during the current test run — collect and store those ids as you create the records, and delete only by that exact id list.
Before executing any delete/bulk-write operation outside of that id-scoped pattern, first run a read-only count/preview of what the filter would match and report it, then require explicit human confirmation before proceeding with the actual deletion.`;
	prompt.content += `\n\n${VISUALIZATION_PROMPT}`;
	if (delegationAvailable) prompt.content += `\n\n${SUB_AGENT_PROTOCOL}`;

	return { ...prompt, memoryContext: true };
}

function prepareChatMessages({
	sessionId,
	modelId,
	userText,
	memoryEnabled = true,
	regenerate = false,
	attachments = [],
	regenerateLast = false,
}) {
	if (typeof regenerate !== "boolean") throw new TypeError("Invalid regenerate flag.");
	if (!Array.isArray(attachments)) throw new TypeError("attachments must be an array.");
	if (
		typeof userText !== "string" ||
		(!userText.trim() && !attachments.length && !regenerate) ||
		userText.includes("\0")
	) {
		throw new TypeError("Provide a message or an attachment; text cannot contain null characters.");
	}
	if (typeof memoryEnabled !== "boolean") {
		throw new TypeError("memoryEnabled must be a boolean.");
	}

	// Prompt construction and history reads use one consistent snapshot.
	return db
		.transaction(() => {
			getOrCreateSession(sessionId, modelId);

			if (regenerateLast) getRegenerationTarget(sessionId);
			else if (!regenerate) saveMessage(sessionId, "user", userText, attachments);
			else if (getActiveMessages(sessionId).at(-1)?.role !== "user")
				throw new Error("No user message to regenerate.");
			const effective = require("./profileSettings").getSessionSettings(sessionId, modelId).effective;
			const systemPrompt = buildSessionSystemPrompt({ sessionId, modelId });
			const summary = getSessionSummary(sessionId);
			const activeSessionMessages = (
				regenerateLast ? getActiveMessages(sessionId).slice(0, -1) : getActiveMessages(sessionId)
			)
				.filter((message) => !message.is_summarized && !message.archived)
				.map(messageForModel);

			return prependBaseSystemPrompt(
				[
					...(summary
						? [{ role: "system", content: `[EARLIER CONVERSATION SUMMARY]:\n${summary}` }]
						: []),
					systemPrompt,
					...activeSessionMessages,
				],
				effective.memoryEnabled,
			);
		})
		.immediate();
}

function messageForModel({ role, content, attachments = [] }) {
	if (role !== "user" || !attachments.length) return { role, content };
	const files = validateAttachments(attachments);
	const attachmentContext = [];
	const images = [];
	for (const { file_path, mime_type } of files) {
		const header = `[Attached File: ${attachmentName(file_path)}]`;
		const isText = mime_type.startsWith("text/") || mime_type === "application/json";
		if (isText && fs.statSync(file_path).size < 50 * 1024) {
			const raw = fs.readFileSync(file_path, "utf-8");
			// Use a longer fence if the attached document contains Markdown fences.
			const fence = "`".repeat(
				Math.max(3, ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length + 1)),
			);
			attachmentContext.push(`${header}\n${fence}\n${raw}\n${fence}\n[End of Attached File]`);
		} else {
			attachmentContext.push(`${header}\nAbsolute path: ${file_path}\n[End of Attached File]`);
		}
		if (mime_type.startsWith("image/")) {
			images.push({
				type: "image_url",
				image_url: { url: `data:${mime_type};base64,${fs.readFileSync(file_path, "base64")}` },
			});
		}
	}
	const text = `${attachmentContext.join("\n\n")}\n\nUser Prompt: ${content}`;
	return { role, content: images.length ? [{ type: "text", text }, ...images] : text };
}

function getToolContext(mcpTools = [], memoryEnabled = true, sessionId = null, permissionMode) {
	const sessionTools = hasProjectWorkspace(sessionId) || ['ask_approval', 'full_access'].includes(permissionMode)
		? agentTools
		: agentTools.filter((tool) => ["get_recent_chat_history", "approve_mcp_mutation", "manage_mcp_servers"].includes(tool.function.name));
	const tools = [
		...(memoryEnabled ? memoryTools : []).map(({ name, description, input_schema }) => ({
			type: "function",
			function: { name, description, parameters: input_schema },
		})),
		...sessionTools,
		...mcpTools,
	].filter((tool) => memoryEnabled || !["search_memory", "save_memory"].includes(tool.function.name));
	// Model tokenizers and chat templates differ; explicitly report an estimate.
	const estimate = (value) => (value.length ? Math.ceil(JSON.stringify(value).length / 4) : 0);
	return {
		tools,
		pluginTokens: estimate(mcpTools),
		toolTokens: estimate(tools),
		tokenCountMethod: "characters/4",
	};
}

module.exports = {
	buildProjectContext,
	buildSessionSystemPrompt,
	getToolContext,
	memoryTools,
	buildSystemPrompt,
	prepareChatMessages,
	messageForModel,
};
