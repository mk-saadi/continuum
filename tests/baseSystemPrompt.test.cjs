'use strict';
// Base-prompt consolidation: behavior preserved while duplicated memory and
// media instructions were folded. Run with: node --test tests/baseSystemPrompt.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'base-prompt-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });
const {
  BASE_SYSTEM_PROMPT_WITH_TOOLS,
  MEDIA_GENERATION_RULES,
  buildTemporalAnchor,
  prependBaseSystemPrompt,
} = require('../src/main/baseSystemPrompt');
const { searchMemoryTool } = require('../src/main/tools/searchMemory');

test('memory-enabled variant keeps every required memory behavior', () => {
  const prompt = BASE_SYSTEM_PROMPT_WITH_TOOLS;
  // Search before answering recall tasks (rules 3).
  assert.match(prompt, /call the `search_memory` tool before answering/);
  // Explicit-request gate + atomic facts + example (rule 4).
  assert.match(prompt, /Only when the user tells you to remember/);
  assert.match(prompt, /atomic fact per call/);
  assert.match(prompt, /Prefers TypeScript over JavaScript/);
  // User-scope gate (rule 5).
  assert.match(prompt, /ONLY SAVE USER FACTS/);
  // Identity/banter/correction ban with example (merged rule 6).
  assert.match(prompt, /NEVER SAVE NON-USER CONTENT/);
  assert.match(prompt, /you are not Gemma 4/);
  // Natural tone phrases (rule 7).
  assert.match(prompt, /According to my memory palace/);
  // No automatic cross-session context (rule 8).
  assert.match(prompt, /do NOT have raw context from other past chat threads/);
  // Removed duplicates are covered elsewhere: continuation lives in the
  // always-present search_memory schema; past-conversation recall in rule 3.
  assert.match(searchMemoryTool.description, /continuation cursor|repeat it with the returned cursor/);
  assert.doesNotMatch(prompt, /NEVER SAVE BANTER OR CORRECTIONS/);
});

test('memory-disabled variant discloses no memory capability', () => {
  const prompt = prependBaseSystemPrompt([], false)[0].content;
  assert.match(prompt, /Memory Palace is disabled/);
  assert.match(prompt, /Memory search and saving are unavailable/);
  assert.doesNotMatch(prompt, /search_memory|save_memory/);
});

test('media rendering and failure handling are preserved', () => {
  assert.match(MEDIA_GENERATION_RULES, /!\[alt text\]/);
  assert.match(MEDIA_GENERATION_RULES, /!\[video\]/);
  assert.match(MEDIA_GENERATION_RULES, /Never claim to have inspected pixels/);
  assert.match(MEDIA_GENERATION_RULES, /BLIND RENDERING/);
  assert.match(MEDIA_GENERATION_RULES, /UNLESS the user explicitly asks you to describe, analyze, or verify/);
  assert.match(MEDIA_GENERATION_RULES, /convert files just to render them/);
  assert.match(BASE_SYSTEM_PROMPT_WITH_TOOLS, /STRICT TOKEN CONSERVATION/);
  assert.match(BASE_SYSTEM_PROMPT_WITH_TOOLS, /respond with text only/);
});

test('generation instructions ride only with a generation backend', () => {
  const {
    MEDIA_GENERATION_TOOL_RULE,
    prependBaseSystemPrompt: prepend,
  } = require('../src/main/baseSystemPrompt');
  // Unconfigured test env: no media model, so the invocation bullet is out
  // while rendering and failure handling stay.
  const lean = prepend([], false)[0].content;
  assert.doesNotMatch(lean, /call the available media generation tool directly/);
  assert.match(lean, /Never claim to have inspected pixels/);
  assert.match(lean, /BLIND RENDERING/);
  // Explicitly enabled: byte-identical to the previous always-on text.
  const full = prepend([], false, true)[0].content;
  assert.match(full, /call the available media generation tool directly/);
  assert.ok(full.includes(MEDIA_GENERATION_TOOL_RULE));
});

test('temporal anchor is present and rebuilding never duplicates the base', () => {
  assert.match(buildTemporalAnchor(), /^\[TEMPORAL CONTEXT\]/);
  const once = prependBaseSystemPrompt([{ role: 'user', content: 'hi' }], true);
  assert.equal(once.filter(m => m.role === 'system').length, 1);
  const twice = prependBaseSystemPrompt(once, true);
  assert.equal(twice.filter(m => m.role === 'system').length, 1);
  assert.equal(twice.filter(m => m.role === 'user').length, 1);
  // A stale anchor date on an otherwise current base is still recognized.
  const stale = [{
    role: 'system',
    content: `[TEMPORAL CONTEXT]\nToday's Date: Old Date (2000-01-01)\nUser Timezone Offset: 0 mins\n` +
      BASE_SYSTEM_PROMPT_WITH_TOOLS,
  }, { role: 'user', content: 'hi' }];
  const rebuilt = prependBaseSystemPrompt(stale, true);
  assert.equal(rebuilt.filter(m => m.role === 'system').length, 1);
  assert.match(rebuilt[0].content, /^\[TEMPORAL CONTEXT\]/);
});
