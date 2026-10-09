import test from "node:test";
import assert from "node:assert/strict";
import {
	firstPromptTitle,
	extractCompletionText,
	sanitizeChatTitle,
} from "../src/lib/chatTitle.mjs";

test("only the first prompt names the chat", () => {
	assert.equal(
		firstPromptTitle("Fix the flaky login test"),
		"Fix the flaky login test",
		"the first prompt becomes the placeholder title",
	);
	const long = "x".repeat(60);
	assert.equal(firstPromptTitle(long).length, 48, "placeholder is capped at 48 chars");
	assert.equal(firstPromptTitle("   padded   "), "padded", "whitespace is trimmed");
});

test("later prompts, edits and retries never touch the title", () => {
	assert.equal(
		firstPromptTitle("Another prompt", { hasMessages: true }),
		null,
		"a transcript with messages means the title is locked",
	);
	assert.equal(firstPromptTitle("Edited", { edit: true, hasMessages: true }), null, "edit never renames");
	assert.equal(firstPromptTitle("Retried", { retry: true }), null, "retry never renames");
	assert.equal(firstPromptTitle(""), null, "empty text never renames");
	assert.equal(firstPromptTitle("   "), null, "whitespace-only text never renames");
	assert.equal(firstPromptTitle(undefined), null, "non-string text never renames");
	assert.equal(firstPromptTitle(42), null, "non-string text never renames");
});

test("completion text is extracted from every provider shape", () => {
	assert.equal(extractCompletionText("Plain string"), "Plain string");
	assert.equal(
		extractCompletionText({ choices: [{ message: { content: "From chat content" } }] }),
		"From chat content",
	);
	assert.equal(
		extractCompletionText({
			choices: [{ message: { content: [{ type: "text", text: "Part one" }, "part two"] } }],
		}),
		"Part one\npart two",
		"array-of-parts content is joined",
	);
	assert.equal(
		extractCompletionText({ choices: [{ text: "Legacy text" }] }),
		"Legacy text",
		"legacy choices[0].text still works",
	);
	assert.equal(
		extractCompletionText({ choices: [{ message: { content: "" } }, {}], output_text: "Responses shape" }),
		"Responses shape",
		"Responses-style output_text is the fallback",
	);
	assert.equal(extractCompletionText({ choices: [] }), "", "a shapeless result yields empty text");
});

test("model decorations are stripped from the generated title", () => {
	assert.equal(sanitizeChatTitle('"Quarterly report"'), "Quarterly report", "surrounding quotes");
	assert.equal(sanitizeChatTitle("Title: Deploy pipeline"), "Deploy pipeline", "Title: prefix");
	assert.equal(sanitizeChatTitle("**Title:** Fix login bug"), "Fix login bug", "bold Title: prefix");
	assert.equal(sanitizeChatTitle("## Q3 roadmap\nwith more detail"), "Q3 roadmap", "heading + later lines");
	assert.equal(sanitizeChatTitle("\n\n  Spaced out  \n"), "Spaced out", "blank lines and padding");
	assert.equal(
		sanitizeChatTitle({ choices: [{ message: { content: "> Quoted: chat summarization" } }] }),
		"Quoted: chat summarization",
		"a completion result is extracted before sanitizing",
	);
});

test("unusable generations return null so the existing title stays", () => {
	assert.equal(sanitizeChatTitle(""), null, "empty reply");
	assert.equal(sanitizeChatTitle("   \n  "), null, "blank reply");
	assert.equal(sanitizeChatTitle('"\'`'), null, "decorations only");
	assert.equal(sanitizeChatTitle({ choices: [{ message: { content: "" } }] }), null, "empty completion");
	assert.equal(sanitizeChatTitle(null), null, "missing completion");
});

test("long titles are capped at 60 characters on a word boundary", () => {
	const words = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
	const title = sanitizeChatTitle(words);
	assert.ok(title.length <= 60, `expected <= 60 chars, got ${title.length}`);
	assert.equal(title.includes(" "), true, "cut kept whole words");
	assert.equal(title, title.trim(), "no stray whitespace");
	const noSpace = "字".repeat(80);
	assert.equal(sanitizeChatTitle(noSpace).length, 60, "non-spaced scripts get a hard cap");
});
