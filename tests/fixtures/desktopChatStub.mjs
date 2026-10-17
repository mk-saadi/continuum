// Test double for ../../src/lib/desktopChat.mjs used by the pagination UI test.
// It records the inference payload the renderer hands to generation and emits
// a couple of stream chunks so the "new message during streaming" path can be
// observed without a real engine or network.
export async function runDesktopChat(options) {
	window.__runDesktopChatCalls = (window.__runDesktopChatCalls || 0) + 1;
	window.__inferenceMessages = options.messages;
	options.onText?.("Streamed ");
	options.onStats?.({ total_tokens: 7 });
	await new Promise((resolve) => setTimeout(resolve, 200));
	options.onText?.("reply");
	return {
		message: { id: 9000 + window.__runDesktopChatCalls, role: "assistant", content: "Streamed reply", stats: { total_tokens: 7 } },
	};
}

export async function indexDesktopDocuments() {}
