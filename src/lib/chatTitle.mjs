// Chat titles are named once: the FIRST prompt names the chat. The tab shows
// that prompt as an instant placeholder, an AI-generated title replaces it
// after the first reply, and later prompts/edits/retries never touch it again.
// The database side is locked by sessionManager (first-message title guard +
// the snapshot check behind session:generate-title), so a manual rename always
// wins over a generated title.

// One-shot instruction for the title completion.
export const TITLE_SYSTEM_PROMPT =
	"You name chats. Given the user's opening message, reply with a short title of at most six words "
	+ "that captures what the user wants, in the user's own language. "
	+ "Reply with the title only: no quotes, no prefix, no explanation.";

// The instant placeholder title: the first prompt of a brand-new chat only.
// Edits, retries, empty text and any transcript that already has messages
// return null — after the first prompt the title is locked.
export function firstPromptTitle(text, { edit = false, retry = false, hasMessages = false } = {}) {
	if (edit || retry || hasMessages) return null;
	const prompt = typeof text === "string" ? text.trim() : "";
	if (!prompt) return null;
	return prompt.slice(0, 48);
}

// Visible text of one non-streaming completion, tolerating the shapes
// providers actually send: string content, array-of-parts content, the legacy
// choices[0].text, and the Responses-style output_text.
export function extractCompletionText(result) {
	if (typeof result === "string") return result;
	const choice = Array.isArray(result?.choices) ? result.choices[0] : undefined;
	const raw = choice?.message?.content;
	let text = "";
	if (typeof raw === "string") text = raw;
	else if (Array.isArray(raw)) {
		text = raw
			.map((part) => {
				if (typeof part === "string") return part;
				if (
					part &&
					typeof part.text === "string" &&
					(part.type === undefined || part.type === "text" || part.type === "output_text")
				)
					return part.text;
				return "";
			})
			.join("\n");
	}
	if (!text.trim() && typeof choice?.text === "string") text = choice.text;
	if (!text.trim() && typeof result?.output_text === "string") text = result.output_text;
	return text;
}

// One clean title from raw model output (a string or a whole completion
// result): first non-empty line only, "Title:"/"#"/quote decorations stripped,
// whitespace collapsed, capped at 60 characters on a word boundary. Returns
// null when nothing usable remains — callers then keep the existing title.
export function sanitizeChatTitle(raw) {
	const text = typeof raw === "string" ? raw : extractCompletionText(raw);
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part) || "";
	const title = line
		.replace(/^[\s>*"'“”‘’`#]+/, "")
		.replace(/^(?:\*\*)?\s*title\s*(?:\*\*)?\s*[:—–-]\s*/i, "")
		.replace(/^[\s>*"'“”‘’`#]+/, "")
		.replace(/[\s>*_'"“”‘’`.:,;!?…-]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title) return null;
	if (title.length <= 60) return title;
	const head = title.slice(0, 60);
	const lastSpace = head.lastIndexOf(" ");
	return (lastSpace > 20 ? head.slice(0, lastSpace) : head).trim();
}
