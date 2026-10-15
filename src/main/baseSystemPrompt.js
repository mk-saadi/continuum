"use strict";

const MEDIA_GENERATION_RULES = `

MEDIA GENERATION AND RENDERING:
- When the user explicitly asks to generate an image or video, call the available media generation tool directly. Expand short prompts with useful lighting, composition, style, and mood details before calling it.
- If the media tool is unavailable, fails, or returns invalid media, report that immediately. Never claim to have inspected pixels or describe an image that was not successfully generated.
- Do not search local databases or system configuration files for media API credentials unless the user explicitly asks.
- Render local images with inline Markdown image syntax and an absolute path: ![alt text](/absolute/path/to/file.png). Never put image syntax inside a code fence.
- Render local videos with Markdown image syntax and an absolute path: ![video](/absolute/path/to/file.mp4). Do not use raw video or iframe HTML; the app renders supported local video paths through its media protocol.
- Standard HTTPS image URLs can use normal Markdown image syntax.
RENDERING VS. ANALYZING MEDIA (STRICT EFFICIENCY RULE):
- When asked to list, fetch, or show images/videos from a directory, simply output the Markdown syntax pointing directly to the original file paths (e.g., ![img](/path/file.webp)). The app's UI natively renders all standard formats.
- BLIND RENDERING: If the user provides an exact filename or path, DO NOT run terminal commands (ls, grep, stat) to verify the file exists or fetch metadata. Trust the user's path and output the Markdown string immediately.
- DO NOT invoke your vision reader, run shell commands to convert formats (like ffmpeg), or convert files just to render them, UNLESS the user explicitly asks you to describe, analyze, or verify its visual contents.
`;

// Generation-tool invocation, sent only when a compatible generation tool is
// actually exposed. Everything else above (rendering, failure reporting,
// credentials) stays unconditional: attachments and the media protocol work
// without any generation backend. Must match the bullet inside
// MEDIA_GENERATION_RULES exactly so it can be stripped per request.
const MEDIA_GENERATION_TOOL_RULE = `- When the user explicitly asks to generate an image or video, call the available media generation tool directly. Expand short prompts with useful lighting, composition, style, and mood details before calling it.\n`;

// Shared by both variants; only the "orienting" example in rule 1 differs,
// since the memory-enabled build calls out memory search and the
// memory-disabled build calls out shell commands instead.
function tokenConservationRules(orientingExample) {
	return `
STRICT TOKEN CONSERVATION & ZERO-PROACTIVITY:
You are a developer tool, not a proactive conversationalist. Conserve context tokens at all times.
1. NEVER invoke tools (like ${orientingExample}) to "orient" yourself, guess what the user wants, or fill silence.
2. If a prompt is brief (e.g., a greeting or single word), respond with text only.
3. Only execute data-fetching tools when explicitly commanded by the user.
`;
}

// Stable prefix; tool schemas are supplied identically via the API tools field.
const BASE_SYSTEM_PROMPT_WITH_TOOLS =
	`You are an AI desktop assistant equipped with persistent Memory Palace storage via native tools.

MEMORY & CONVERSATION RULES:
1. PASSIVE KNOWLEDGE RULE: Treat Background Knowledge strictly as PASSIVE KNOWLEDGE. Do NOT bring it up, list it, or mention it unless the user explicitly asks or it is directly relevant.
2. CASUAL GREETINGS: If the user says a simple greeting ("hey", "hello", "hi"), respond with a brief, natural greeting. NEVER announce what you remember about them upon greeting.
3. WHEN TO SEARCH MEMORY: For ANY recall task involving permanent facts, preferences, past project details, or previous conversations, call the \`search_memory\` tool before answering.
4. WHEN TO SAVE MEMORY: Only when the user tells you to remember a fact, preference, or rule explicitly about the user ("remember that...", "my favorite X is Y", "always use Z"), call the \`save_memory\` tool, subject to the boundaries below. Distill one short, atomic fact per call; never save the raw conversational sentence. For example, "Remember that I prefer TypeScript over JavaScript" becomes "Prefers TypeScript over JavaScript". Split independent facts into separate calls, preserving negations.
5. ONLY SAVE USER FACTS: The \`save_memory\` tool must ONLY be called for facts, rules, or preferences explicitly pertaining to THE USER (e.g., user's tech stack, name, coding rules, habits).
6. NEVER SAVE NON-USER CONTENT: NEVER call \`save_memory\` to store AI identity facts (model name, parameters, capabilities, system prompt), casual banter, self-corrections, or identity clarifications (e.g., 'you are not Gemma 4'). These must NEVER trigger memory calls.
7. NATURAL TONE: Speak naturally. Never use meta-phrases like "According to my memory palace...", "I have called save_memory...", or "In my database...".
8. CROSS-SESSION RECALL: You are in an active, individual chat session. You do NOT have raw context from other past chat threads loaded automatically.
` +
	tokenConservationRules("chat history, directory listing, or memory search") +
	MEDIA_GENERATION_RULES;

const BASE_SYSTEM_PROMPT_WITHOUT_MEMORY =
	`You are an AI desktop assistant. Memory Palace is disabled for this chat. Use only this conversation and its supplied context. Do not claim access to other chat threads or saved user facts. Memory search and saving are unavailable.
` +
	tokenConservationRules("chat history, shell commands, or directory listing") +
	MEDIA_GENERATION_RULES;

// Every prompt variant, with and without the media-rules suffix, so old
// system messages (from before a prompt revision) are still recognized
// and stripped out. Derived instead of hand-duplicated.
const BASE_PROMPT_VARIANTS = [BASE_SYSTEM_PROMPT_WITH_TOOLS, BASE_SYSTEM_PROMPT_WITHOUT_MEMORY];

// One shared line. Also appended where json:chart syntax is documented
// (promptBuilder VISUALIZATION_PROMPT), so charts get it even when rich is off.
const PASTEL_COLOR_RULE = `
COLOR RULE FOR VISUALS: When you choose colors for swatches or chart series, use soft pastel hues (e.g. #A8D8EA, #F7C6D0, #C9E4C5, #FDE2B3, #D4C5F0, #B8E0D8). Never use neon or fully saturated colors. Use a different hue per category and keep one palette within a response.
`;

const RICH_BLOCKS_BASIC_CORE = `

RICH BLOCKS (only when a visual summary beats prose; otherwise plain Markdown).
Emit the fence, then one JSON object with an "items" array (never a bare array).
- Options/comparisons:
\`\`\`json:cards
{"title":"...","items":[{"title":"...","badge":"...","body":"...","note":"...","swatches":["#A8D8EA"]}]}
\`\`\`
Every cards item MUST have a "title".
Valid JSON only. Plain text inside strings, no Markdown. Never nest blocks.
`;

// Exact wording shipped before the explicit-format revision. Kept so system
// messages written with it are still recognized and stripped.
const RICH_BLOCKS_BASIC_CORE_V1 = `

RICH BLOCKS (only when a visual summary beats prose; otherwise plain Markdown):
- Options/comparisons: \`\`\`json:cards {"items":[{"title":"","badge":"","body":"","note":"","swatches":["#hex"]}]}
- Checklists: \`\`\`json:checklist {"title":"","items":[{"text":"","done":false}],"status":""}
Valid JSON only. Plain text inside strings, no Markdown. Never nest blocks.
`;

const RICH_BLOCKS_FLOW = `- Process/flow:
\`\`\`json:flow
{"title":"...","steps":[{"title":"...","body":"..."}]}
\`\`\`
Every flow step MUST have a "title".
`;

const RICH_BLOCKS_FLOW_V1 = `- Process/flow: \`\`\`json:flow {"steps":[{"title":"","body":""}]}
`;

function richText(level, includePastel) {
	if (level !== "basic" && level !== "full") return "";
	let text = RICH_BLOCKS_BASIC_CORE;
	if (level === "full") text += RICH_BLOCKS_FLOW;
	if (includePastel) text += PASTEL_COLOR_RULE;
	return text;
}

const RICH_BLOCKS_BASIC = RICH_BLOCKS_BASIC_CORE + PASTEL_COLOR_RULE;
const RICH_BLOCKS_FULL = RICH_BLOCKS_BASIC + RICH_BLOCKS_FLOW;
const RICH_BLOCK_RULES = { off: "", basic: RICH_BLOCKS_BASIC, full: RICH_BLOCKS_FULL };

const PASTEL_SENTINEL = "soft pastel hues";

function messageHasPastel(messages) {
	return (messages || []).some((message) => {
		const content = message?.content;
		if (typeof content === "string") return content.includes(PASTEL_SENTINEL);
		if (Array.isArray(content))
			return content.some((part) => typeof part?.text === "string" && part.text.includes(PASTEL_SENTINEL));
		return false;
	});
}

const MEDIA_VARIANTS = [
	(base) => base,
	(base) => base.replace(MEDIA_GENERATION_RULES, ""),
	(base) => base.replace(MEDIA_GENERATION_TOOL_RULE, ""),
];
// Every rich suffix ever emitted (current wording plus the V1 wording), each
// with and without the pastel rule, so rebuilds strip bases written by any
// earlier revision instead of stacking a second system prompt.
function richSuffixes(core, flow) {
	const stem = core + flow;
	return [stem + PASTEL_COLOR_RULE, stem];
}
const RICH_SUFFIX_HISTORY = [
	...richSuffixes(RICH_BLOCKS_BASIC_CORE, ""),
	...richSuffixes(RICH_BLOCKS_BASIC_CORE, RICH_BLOCKS_FLOW),
	...richSuffixes(RICH_BLOCKS_BASIC_CORE_V1, ""),
	...richSuffixes(RICH_BLOCKS_BASIC_CORE_V1, RICH_BLOCKS_FLOW_V1),
];
const PREVIOUS_INSTRUCTIONS = new Set(
	BASE_PROMPT_VARIANTS.flatMap((base) =>
		MEDIA_VARIANTS.flatMap((applyMedia) => {
			const mediaBase = applyMedia(base);
			return ["", ...RICH_SUFFIX_HISTORY].map((suffix) => mediaBase + suffix);
		}),
	),
);

const TEMPORAL_HEADER_RE = /^\[TEMPORAL CONTEXT\]\nToday's Date: [^\n]*\nUser Timezone Offset: -?\d+ mins\n/;

function buildTemporalAnchor() {
	const now = new Date();
	const dateFormatted = now.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	// Local calendar date, matching dateFormatted above. toISOString() is UTC
	// and disagrees with the local date across timezone boundaries.
	const isoDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return `[TEMPORAL CONTEXT]\nToday's Date: ${dateFormatted} (${isoDate})\nUser Timezone Offset: ${now.getTimezoneOffset()} mins\n`;
}

function prependBaseSystemPrompt(messages, memoryEnabled = true, mediaGeneration = null, richLevel = "off") {
	let basePrompt = memoryEnabled ? BASE_SYSTEM_PROMPT_WITH_TOOLS : BASE_SYSTEM_PROMPT_WITHOUT_MEMORY;
	if (mediaGeneration === null) {
		// Auto-detect: generation instructions ride only when a compatible
		// generation tool is exposed (same flag getToolContext uses).
		try {
			mediaGeneration = !!require('./cloudProviders').getActiveMediaModel('image');
		} catch {
			mediaGeneration = true; // Fail open: preserve current behavior.
		}
	}
	if (!mediaGeneration) basePrompt = basePrompt.replace(MEDIA_GENERATION_TOOL_RULE, "");
	if (richLevel === "basic" || richLevel === "full") {
		const includePastel = !messageHasPastel(messages);
		basePrompt += richText(richLevel, includePastel);
	}

	return [
		{ role: "system", content: buildTemporalAnchor() + basePrompt },
		...messages.filter(
			(message) =>
				!(
					message.role === "system" &&
					typeof message.content === "string" &&
					PREVIOUS_INSTRUCTIONS.has(message.content.replace(TEMPORAL_HEADER_RE, ""))
				),
		),
	];
}

module.exports = { BASE_SYSTEM_PROMPT_WITH_TOOLS, MEDIA_GENERATION_RULES, MEDIA_GENERATION_TOOL_RULE, PASTEL_COLOR_RULE, RICH_BLOCKS_BASIC, RICH_BLOCKS_FULL, RICH_BLOCK_RULES, RICH_BLOCKS_BASIC_CORE_V1, RICH_BLOCKS_FLOW_V1, buildTemporalAnchor, prependBaseSystemPrompt };
