"use strict";

const { prependBaseSystemPrompt } = require("./baseSystemPrompt");
const fs = require("node:fs");
const path = require("node:path");
const { getProject } = require("./projectManager");
const { validateAttachments, attachmentName } = require("./fileUploads");
const { db } = require("./db");
const { getSessionAgent } = require("./agentManager");
const { getRecentPermanentMemories } = require("./memoryManager");
const { nativeTools } = require("./nativeTools");
const { saveMemoryTool } = require('./tools/saveMemory');
const { agentTools, hasProjectWorkspace } = require("./tools/agentTools");
const { getAppSettings } = require("./configManager");
const { askUserTool } = require('./engineManager');
const { activeProjectSkills } = require('./skillsManager');
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
	saveMemoryTool,
];

const VISUALIZATION_PROMPT = [
	"### Visualizations & Charting Protocol",
	"Use the interactive chart renderer only for numerical data. Describe processes and structures with concise text, lists, or tables.",
	"",
	"#### STRICT DECISION MATRIX:",
	"1. Is the output numerical data over time, categories, or metrics (for example, weather, stocks, benchmarks, or statistics)?",
	"   --> MANDATORY: Use INTERACTIVE RECHARTS (`json:chart`).",
	"2. Is the output a process, system architecture, database schema, workflow, or sequence?",
	"   --> Explain the structure with a clear list, table, or ordinary code block when useful.",
	"",
	"---",
	"",
	"#### Interactive Data Charts (`json:chart`)",
	"Trigger: Numerical metrics, time series, percentages, and comparative statistics.",
	"Output Format: Strictly valid JSON wrapped inside a ```json:chart code block.",
	"Supported types: `bar`, `line`, `area`, and `pie`. Pie charts use one series with one data row per slice.",
	"",
	"Schema & Example:",
	"```json:chart",
	"{",
	"  \"type\": \"bar\",",
	"  \"title\": \"Dhaka Temperature & Rainfall (June - Sept)\",",
	"  \"xAxisKey\": \"date\",",
	"  \"series\": [",
	"    { \"key\": \"temp\", \"label\": \"Mean Temp (°C)\", \"color\": \"#3b82f6\" },",
	"    { \"key\": \"precip\", \"label\": \"Precipitation (mm)\", \"color\": \"#f97316\" }",
	"  ],",
	"  \"data\": [",
	"    { \"date\": \"Jun 1\", \"temp\": 31, \"precip\": 12 },",
	"    { \"date\": \"Jun 2\", \"temp\": 32, \"precip\": 5 }",
	"  ]",
	"}",
	"```",
	"",
	"CRITICAL RULES FOR `json:chart`:",
	"- Do NOT put comments inside the JSON payload.",
	"- Ensure all numbers are actual integers or floats (for example, `31`), never numeric strings (for example, `\"31\"`).",
	"- Ensure `xAxisKey` matches the exact property key in every `data` object, and every series `key` matches a numeric property in those objects.",
	"",
	"---",
	"",
	"#### ABSOLUTE FORBIDDEN ACTIONS:",
	"- NEVER write Python scripts, run `matplotlib`, install `pip` packages, or execute terminal commands (`execute_command`) to generate PNG/JPG chart images.",
	"- Keep `json:chart` blocks strictly valid JSON. Use ordinary Markdown for non-numerical structures.",
].join("\n");

const SUB_AGENT_PROTOCOL = [
	"### Sub-Agent Delegation Protocol",
	"You have access to the `spawn_subagent` tool for focused public web research. It returns a concise answer from one URL in an isolated model context.",
	"",
	"#### 1. MANDATORY Delegation Triggers (Do NOT do these in Main Context):",
	"- **Web Page Scraping & Reading:** NEVER call `get_single_web_page_content` or `get-single-web-page-content` to read a full URL in the main context. ALWAYS call `spawn_subagent` with one URL and a specific question. The sub-agent fetches the page and returns a short answer, not raw HTML.",
	"- **Multi-Source Research:** When comparing benchmarks, documentation, or web links, call `spawn_subagent` separately for each URL or source, then compare the returned summaries in the main context.",
	"- **Local Files and Logs:** Never use `spawn_subagent` or `delegate_task` to search, read, inspect, or parse workspace files, repositories, or logs. Use `execute_command` with `rg`, `grep -n`, `sed`, or `find` instead.",
	"",
	"#### 2. Allowed Main Context Actions (Do NOT delegate):",
	"- Search and read local files directly with `execute_command` when available.",
	"- Use a simple `full-web-search` search, when that tool is available, to get brief search-result snippets. Delegate full-page reading after choosing a result.",
	"- Run quick builds or tests with `execute_command` when needed.",
	"",
	"#### 3. Sub-Agent Invocation Pattern:",
	"Call `spawn_subagent` with a single-purpose `task` and exactly one public URL in `task` or the `url` field. Use `constraint` and `expected_output` to keep the answer short. Never pass local file paths or `target_files`.",
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

function buildSystemPrompt({ modelId, memoryEnabled = true, globalMemoryEnabled, projectId, allowMidRunQuestions = false }) {
	if (typeof modelId !== "string" || !modelId.trim() || modelId.includes("\0")) {
		throw new TypeError("modelId must be a non-empty string without null characters.");
	}
	if (typeof memoryEnabled !== "boolean") throw new TypeError("memoryEnabled must be a boolean.");
	if (globalMemoryEnabled !== undefined && typeof globalMemoryEnabled !== "boolean") throw new TypeError("globalMemoryEnabled must be a boolean.");
	if (typeof allowMidRunQuestions !== 'boolean') throw new TypeError('allowMidRunQuestions must be a boolean.');
	const canInjectMemory = memoryEnabled && (globalMemoryEnabled ?? require('./profileSettings').getProfileSettings().memoryEnabled);
	const recentMemories = canInjectMemory
		? getRecentPermanentMemories(modelId, { projectId, limit: 5 }) : [];
	const permanentMemoryContext = recentMemories.length
		? `### RECENT PERMANENT MEMORIES:\n${recentMemories.map(({ category, content }) => `- [${category.toUpperCase()}] ${content}`).join('\n')}\n(For older rules or preferences, call search_memory with target: 'permanent'.)`
		: 'No background memories saved yet.';
	const memorySection = canInjectMemory
		? `[BACKGROUND KNOWLEDGE & USER PREFERENCES]\n${permanentMemoryContext}\n\n` : '';

	return {
		role: "system",
		content: `${memorySection}${allowMidRunQuestions ? `### MID-RUN CLARIFICATIONS (ENABLED)
- If you encounter an ambiguous choice, missing variable, or high-impact decision (e.g., running build scripts or overwriting files), you MAY pause execution and ask the user for direct input before proceeding.
- Call the \`ask_user\` tool or end your turn with a clear question to request input.` : `### MID-RUN CLARIFICATIONS (DISABLED - AUTONOMOUS EXECUTION)
- Do NOT interrupt the execution loop or pause to ask questions mid-run.
- If faced with ambiguity, select the safest, most reasonable technical default and proceed with execution.
- Complete all tool steps until the task objective is resolved. Summarize any assumptions made or follow-up questions in your final completion response.`}
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

function buildSessionSystemPrompt({ sessionId, modelId, delegationAvailable = true, userText = '' }) {
	const manualMcp = getAppSettings().mcpMode === 'manual';
	const profiles = require('./profileSettings');
	const effective = profiles.getSessionSettings(sessionId, modelId).effective;
	const projectId = sessionId && db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id;
	const prompt = buildSystemPrompt({ modelId, projectId, memoryEnabled: effective.memoryEnabled,
		globalMemoryEnabled: profiles.getProfileSettings().memoryEnabled, allowMidRunQuestions: effective.allowMidRunQuestions });
	const agent = getSessionAgent(sessionId);
	if (effective.systemPrompt)
		prompt.content += `\n\n[${agent ? `ACTIVE AGENT: ${agent.name}` : "ASSISTANT INSTRUCTIONS"}]\n${effective.systemPrompt}`;
	const projectContext = buildProjectContext(sessionId);
	if (projectContext) prompt.content += `\n\n${projectContext}`;
	if (projectId) {
		const skills = activeProjectSkills(projectId);
		if (skills.length) {
			prompt.content += `\n\n[AVAILABLE PROJECT SKILLS]\n${skills.map(skill => `@${skill.id}: ${skill.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}\nMention a skill by @name to use it. If the user's task matches a skill's purpose, call use_skill with its ID to load its full instructions before acting.`;
			for (const skill of skills) {
				const escaped = skill.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const explicit = new RegExp(`(^|[^\\w])@${escaped}(?![\\w-])`, 'i').test(userText);
				const triggered = skill.triggers.some(trigger => trigger.length >= 4 && userText.toLowerCase().includes(trigger.toLowerCase()));
				if (explicit || triggered)
					prompt.content += `\n\n[SKILL: ${skill.id}]\n${skill.instructions}\n[END SKILL]`;
			}
		}
	}
	const mcpManager = require('./mcpManager');
	let serverNames = [];
	try {
		const config = JSON.parse(fs.readFileSync(mcpManager.configPath, 'utf8'));
		serverNames = Object.keys(config.mcpServers || {});
	} catch { /* MCP manager reports malformed or unavailable configuration separately. */ }
	if (!manualMcp && serverNames.length) prompt.content += `\n\nAvailable dynamic tools (MCP servers): ${serverNames.map(name => JSON.stringify(name)).join(', ')}. MCP servers are off by default to save context unless enabled in the UI or for this chat. If you need a server to fulfill the user's request, call \`manage_mcp_servers\` with action \`enable\` and its server name first. You can also disable a server or restart it if it times out. Its tools appear in your schema on the next turn.`;
	prompt.content +=
		"\n\nCROSS-SESSION MEMORY: You have access to the `get_recent_chat_history` tool. If the user asks about previous topics, past chats, or what you were just talking about in another/global session, use `get_recent_chat_history` to pull recent messages before answering. When using search queries, provide short, broad 1-2 word keywords to cast a wide net.";
	prompt.content += "\n\nSKILL PROPOSALS: After completing a complex task, if you found a reusable workflow that would help with future work, call `propose_skill` with a concise name, description, and complete instructions. The user decides whether to register it.";
	prompt.content += manualMcp
		? `\n\nBROWSER AUTOMATION: The Playwright MCP server provides browser tools only when enabled in Settings. In a project, start local development servers with execute_command if available. Use browser_snapshot to read the accessibility tree if navigation returns a snapshot file link. If the integration is unavailable, report that limitation instead of claiming browser access.`
		: `\n\nBROWSER AUTOMATION: The Playwright MCP server provides browser tools when enabled. In a project, start local development servers with execute_command, then enable \`playwright-native\` using \`manage_mcp_servers\` if browser testing is needed. Use browser_snapshot to read the accessibility tree if navigation returns a snapshot file link. If the integration reports a setup error, report that limitation instead of claiming browser access.`;
	if (!manualMcp) prompt.content += `\n\nAGENTIC EXTENSIBILITY: When asked to create an MCP server, build it inside the \`mcp-plugins/\` directory. Once the code is written, you MUST automatically edit \`mcp_config.json\` to register the new server's execution command, then call \`manage_mcp_servers\` to enable it for this chat.
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
			const systemPrompt = buildSessionSystemPrompt({ sessionId, modelId, userText });
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
	const manualMcp = getAppSettings().mcpMode === 'manual';
	const projectId = sessionId && db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id;
	const sessionTools = hasProjectWorkspace(sessionId) || ['ask_approval', 'full_access'].includes(permissionMode)
		? agentTools
		: agentTools.filter((tool) => ["get_recent_chat_history", "approve_mcp_mutation", "manage_mcp_servers", "propose_skill", ...(projectId ? ['use_skill'] : []), 'generate_image'].includes(tool.function.name));
	const imageGenerationConfigured = !!require('./cloudProviders').getActiveMediaModel('image');
	const availableSessionTools = sessionTools.filter(tool => tool.function.name !== 'generate_image' || imageGenerationConfigured);
	const tools = [
		askUserTool,
		...(memoryEnabled ? memoryTools : []).map(({ name, description, input_schema }) => ({
			type: "function",
			function: { name, description, parameters: input_schema },
		})),
		...availableSessionTools.filter(tool => (projectId || tool.function.name !== 'use_skill') && (!manualMcp || tool.function.name !== 'manage_mcp_servers')),
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
