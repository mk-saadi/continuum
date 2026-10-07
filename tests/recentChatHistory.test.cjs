// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/recentChatHistory.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-chat-history-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const { getToolContext, buildSessionSystemPrompt } = require('../src/main/promptBuilder');
const run = (args = {}, sessionId = 'current') => executeAgentTool({ name: 'get_recent_chat_history', arguments: JSON.stringify(args), sessionId });
(async () => {
  try {
    initDatabase();
    db.prepare("INSERT INTO projects(id, name) VALUES ('project', 'New project')").run();
    const session = db.prepare('INSERT INTO sessions(id, title, project_id) VALUES (?, ?, ?)');
    session.run('global', 'Global chat', null);
    session.run('project', 'Project chat', 'project');
    session.run('current', null, null);
    const insert = db.prepare('INSERT INTO messages(session_id, role, content, created_at, archived, is_summarized) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('global', 'user', 'Discussed lunar gardening', '2026-09-01 10:00:00', 1, 1);
    insert.run('project', 'assistant', 'Python tracing notes', '2026-09-02 10:00:00', 0, 0);
    insert.run('global', 'user', 'the literal topic_name', '2026-09-03 10:00:00', 0, 0);
    insert.run('global', 'assistant', 'topicXname', '2026-09-04 10:00:00', 0, 0);
    insert.run('global', 'system', 'Internal instructions', '2026-09-05 10:00:00', 0, 0);
    insert.run('global', 'assistant', '  ', '2026-09-06 10:00:00', 0, 0);
    insert.run('current', 'user', 'Current message', '2026-09-07 10:00:00', 0, 0);
    const recent = await run();
    assert.equal(recent.length, 4);
    assert.deepEqual(recent.map(row => row.content), ['topicXname', 'the literal topic_name', 'Python tracing notes', 'Discussed lunar gardening']);
    assert.equal(recent[2].session_title, 'Project chat');
    assert.equal(recent[3].created_at, '2026-09-01 10:00:00');
    assert.deepEqual((await run({ query: 'The LUNAR python absent' })).map(row => row.content), ['Python tracing notes', 'Discussed lunar gardening']);
    assert.equal((await run({ query: 'topic_name' })).length, 1, 'LIKE underscores are literal');
    for (const query of ['', 'the a is', 'missingkeyword', 'Current']) {
      assert.deepEqual(await run({ query, limit: 2 }), recent.slice(0, 2), 'Fallback preserves limit and session exclusion');
    }
    const included = await run({ exclude_current_session: false, limit: 1 });
    assert.equal(included[0].session_id, 'current');
    assert.equal(included[0].session_title, 'Untitled chat');
    assert.deepEqual(await run({ limit: 1 }, null), included);
    assert.ok((await run({}, 'project')).some(row => row.session_id === 'global'));
    for (const args of [{ query: 42 }, { query: 'bad\0' }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '2' }, { exclude_current_session: 'false' }]) {
      assert.equal((await run(args)).success, false);
    }
    for (const sessionId of [null, 'current', 'project']) {
      for (const enabled of [true, false]) {
        assert.equal(getToolContext([], enabled, sessionId).tools.filter(tool => tool.function.name === 'get_recent_chat_history').length, 1);
      }
    }
    assert.match(buildSessionSystemPrompt({ sessionId: 'current', modelId: 'model' }).content, /CROSS-SESSION MEMORY:.*1-2 word keywords/);
    for (let i = 0; i < 12; i++) insert.run('global', 'user', `Extra ${i}`, '2026-09-08 10:00:00', 0, 0);
    const limited = await run();
    assert.equal(limited.length, 5);
    assert.equal(limited[0].content, 'Extra 11', 'Timestamp ties use newest ID');
    assert.equal((await run({ limit: 10 })).length, 10);
    assert.equal((await run({ limit: 12 })).success, false);
    db.prepare('DELETE FROM messages').run();
    assert.deepEqual(await run({ query: 'anything' }), []);
    console.log('Recent cross-session history: search, fallback, exclusion, defaults, validation, tool registration and prompt passed.');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
