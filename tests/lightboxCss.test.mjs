import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("markdown rhythm rules do not reset the lightbox dialog margins", async () => {
	const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");

	// The media lightbox is rendered as a direct child of .assistant-markdown.
	// These resets must skip dialogs or the dialog's margin:auto collapses to
	// the bottom edge of the viewport.
	assert.match(
		css,
		/\.assistant-markdown > :not\(dialog\):first-child\s*\{\s*margin-top:\s*0;/,
	);
	assert.match(
		css,
		/\.assistant-markdown > :not\(dialog\):last-child\s*\{\s*margin-bottom:\s*0;/,
	);
	assert.doesNotMatch(
		css,
		/\.assistant-markdown > :last-child\s*\{\s*margin-bottom:\s*0;/,
	);
});
