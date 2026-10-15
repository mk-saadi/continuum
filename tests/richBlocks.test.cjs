'use strict';
// Rich blocks prompt levels + pastel dedup + stripping.
// Run with: node --test tests/richBlocks.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-blocks-'));
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

const base = require('../src/main/baseSystemPrompt');
const profiles = require('../src/main/profileSettings');

test('richLevel off/basic/full produce expected text', () => {
  const off = base.prependBaseSystemPrompt([{ role: 'user', content: 'hi' }], true, true, 'off')[0].content;
  assert.doesNotMatch(off, /RICH BLOCKS/);
  assert.doesNotMatch(off, /soft pastel hues/);
  const basic = base.prependBaseSystemPrompt([{ role: 'user', content: 'hi' }], true, true, 'basic')[0].content;
  assert.match(basic, /RICH BLOCKS/);
  assert.match(basic, /json:cards/);
  assert.doesNotMatch(basic, /json:checklist/);
  assert.doesNotMatch(basic, /json:flow/);
  assert.match(basic, /soft pastel hues/);
  const full = base.prependBaseSystemPrompt([{ role: 'user', content: 'hi' }], true, true, 'full')[0].content;
  assert.match(full, /json:flow/);
  assert.match(full, /soft pastel hues/);
  // Explicit shape teaching: object with items, required keys.
  assert.match(basic, /"items"/);
  assert.match(basic, /MUST have a "title"/);
  assert.match(full, /"steps"/);
  assert.match(full, /MUST have a "title"/);
});

test('V1-worded rich bases are still recognized and stripped', () => {
  const { BASE_SYSTEM_PROMPT_WITH_TOOLS, RICH_BLOCKS_BASIC_CORE_V1, RICH_BLOCKS_FLOW_V1, PASTEL_COLOR_RULE, buildTemporalAnchor } = base;
  const legacy = BASE_SYSTEM_PROMPT_WITH_TOOLS + RICH_BLOCKS_BASIC_CORE_V1 + RICH_BLOCKS_FLOW_V1 + PASTEL_COLOR_RULE;
  const msgs = [
    { role: 'system', content: buildTemporalAnchor() + legacy },
    { role: 'user', content: 'hi' },
  ];
  const out = base.prependBaseSystemPrompt(msgs, true, true, 'full');
  assert.equal(out.filter((m) => m.role === 'system').length, 1, 'legacy V1 base was not stripped');
  assert.match(out[0].content, /MUST have a "title"/, 'new wording applied after strip');
});

test('pastel rule appears exactly once when chart docs and rich blocks combine', () => {
  const { buildSessionSystemPrompt } = require('../src/main/promptBuilder');
  const sessions = require('../src/main/sessionManager');
  const id = `rich-${Date.now()}`;
  sessions.getOrCreateSession(id, 'cloud:prov:model');
  const session = buildSessionSystemPrompt({ sessionId: id, modelId: 'cloud:prov:model', userText: '' });
  assert.match(session.content, /soft pastel hues/);
  for (const level of ['basic', 'full']) {
    const out = base.prependBaseSystemPrompt(
      [{ role: 'system', content: session.content }, { role: 'user', content: 'hi' }],
      true, true, level,
    );
    const combined = out.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const count = (combined.match(/soft pastel hues/g) || []).length;
    assert.equal(count, 1, `level ${level} produced ${count} pastel rules`);
  }
  // Chart docs alone (rich off) still carry the pastel rule.
  const { rebuildChatMessages } = require('../src/main/promptBuilder');
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: '/local/model.gguf', userText: '' });
  const text = rebuilt.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.equal((text.match(/soft pastel hues/g) || []).length, 1);
});

test('PREVIOUS_INSTRUCTIONS strips old system messages for every combination', () => {
  for (const mem of [true, false]) {
    for (const media of [true, false]) {
      for (const level of ['off', 'basic', 'full']) {
        const once = base.prependBaseSystemPrompt([{ role: 'user', content: 'hi' }], mem, media, level);
        const twice = base.prependBaseSystemPrompt(once, mem, media, level);
        assert.equal(twice.filter((m) => m.role === 'system').length, 1, `${mem}/${media}/${level} duplicated`);
        // Old level is still recognized after switching to full.
        const switched = base.prependBaseSystemPrompt(once, mem, media, 'full');
        assert.equal(switched.filter((m) => m.role === 'system').length, 1, `${mem}/${media}/${level}->full duplicated`);
      }
    }
  }
});

test('richBlocks defaults to off local / full cloud and is overridable', () => {
  assert.equal(profiles.resolveRichLevel(null, '/models/foo.gguf'), 'off');
  assert.equal(profiles.resolveRichLevel(null, 'cloud:openai:gpt-4'), 'full');
  profiles.saveProfileSettings('/models/rich-test.gguf', { richBlocks: 'basic' });
  assert.equal(profiles.resolveRichLevel(null, '/models/rich-test.gguf'), 'basic');
  profiles.saveProfileSettings('cloud:prov:model-x', { richBlocks: 'off' });
  assert.equal(profiles.resolveRichLevel(null, 'cloud:prov:model-x'), 'off');
  assert.throws(() => profiles.saveProfileSettings('/m', { richBlocks: 'vivid' }), /Invalid richBlocks/);
  profiles.saveProfileSettings('/models/rich-test.gguf', null);
  profiles.saveProfileSettings('cloud:prov:model-x', null);
});

test('chart renderer uses pastel defaults and preserves explicit colors', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'InteractiveChart.jsx'), 'utf8');
  for (const hex of ['#A8D8EA', '#F7C6D0', '#C9E4C5', '#FDE2B3', '#D4C5F0', '#B8E0D8']) {
    assert.ok(source.includes(hex), `missing pastel ${hex}`);
  }
  assert.doesNotMatch(source, /#3b82f6/);
  assert.match(source, /darken\(item\.color\)/);
});
