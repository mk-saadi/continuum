// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/chatHistorySearch.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-search-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db, searchChatHistory, searchMemory } = require('../src/main/db');
const { executeMemoryTool } = require('../src/main/memoryToolExecutor');
const { getToolContext } = require('../src/main/promptBuilder');
try {
  initDatabase();
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('old');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('new');
  const insert = db.prepare('INSERT INTO messages(session_id, role, content, archived) VALUES (?, ?, ?, ?)');
  insert.run('old', 'user', 'Discussed lunar gardening', 1);
  insert.run('new', 'assistant', 'Lunar gardening needs water', 0);
  assert.deepEqual(searchChatHistory('lunar gardening'), [
    { session_id: 'old', role: 'user', content: 'Discussed lunar gardening' },
    { session_id: 'new', role: 'assistant', content: 'Lunar gardening needs water' },
  ]);
  assert.equal(searchChatHistory('"lunar gardening"').length, 2);
  for (const query of ['', '  ', '"', 'missing', 'lunar OR missing', "' OR 1=1 --"]) {
    assert.deepEqual(searchChatHistory(query), []);
  }
  for (const query of [undefined, null, {}, 42, 'lunar\0']) {
    assert.throws(() => searchChatHistory(query), TypeError);
  }
  for (let i = 0; i < 12; i++) insert.run('old', 'user', `orchard note ${i}`, 0);
  assert.equal(searchChatHistory('orchard').length, 10);
  assert.ok(!getToolContext().tools.some(tool => tool.function.name === 'search_chat_history'));
  const tools = getToolContext().tools.filter(tool => tool.function.name === 'search_memory');
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].function.parameters.required, ['query']);
  const fact = db.prepare('INSERT INTO permanent_memories(category, content, scope, is_active, superseded_by) VALUES (?, ?, ?, ?, ?)');
  const firstFact = fact.run('preference', 'Enjoys lunar gardening', 'global', 1, null).lastInsertRowid;
  fact.run('project_rule', 'Lunar greenhouse', 'model', 1, null);
  fact.run('preference', 'Lunar hidden model fact', 'other', 1, null);
  fact.run('preference', 'Lunar inactive fact', 'global', 0, null);
  fact.run('preference', 'Lunar superseded fact', 'global', 1, firstFact);
  fact.run('preference', 'Uses lunar_100% effort', 'global', 1, null);
  fact.run('preference', 'Uses lunarX1000 effort', 'global', 1, null);
  const combined = searchMemory('lunar', 'model');
  assert.match(combined, /Facts found:\n- \[preference\]: Enjoys lunar gardening/);
  assert.match(combined, /Lunar greenhouse/);
  assert.doesNotMatch(combined, /hidden model|inactive|superseded/);
  assert.match(combined, /Past Chat Context found:\n\[Session: old\]/);
  assert.match(searchMemory('arden', 'model'), /Enjoys lunar gardening/);
  assert.match(searchMemory('project_rule', 'model'), /Lunar greenhouse/);
  const literal = searchMemory('lunar_100%', 'model');
  assert.match(literal, /Uses lunar_100% effort/);
  assert.doesNotMatch(literal, /lunarX1000/);
  for (const query of [null, {}, 42, 'lunar\0']) assert.throws(() => searchMemory(query, 'model'), TypeError);
  assert.throws(() => searchMemory('lunar', ''), TypeError);
  const result = executeMemoryTool({ name: 'search_memory', modelId: 'model', arguments: '{"query":"lunar"}' });
  assert.equal(result, combined);
  assert.match(result, /\[Session: old\] user:\nDiscussed lunar gardening/);
  assert.match(result, /\[Session: new\] assistant:\nLunar gardening needs water/);
  assert.equal(executeMemoryTool({ name: 'search_memory', modelId: 'model', arguments: { query: 'missing' } }),
    'Facts found:\nNone.\n\nPast Chat Context found:\nNone.');
  db.prepare('DELETE FROM messages WHERE session_id = ?').run('old');
  assert.equal(searchChatHistory('lunar').length, 1);
  closeDatabase();
  initDatabase();
  assert.equal(searchChatHistory('lunar').length, 1);
  console.log('Chat history search, registration, and execution checks passed.');
} finally {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}
