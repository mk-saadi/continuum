// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/spotlightHistory.integration.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotlight-history-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db');
(async () => {
  try {
    database.initDatabase();
    const { db } = database;
    const sessions = require('../src/main/sessionManager');
    const { searchMessages } = require('../src/main/messageSearch');
    const { searchMessagePage } = await import('../src/lib/spotlightMessageSearch.mjs');
    db.prepare("INSERT INTO sessions(id, model_id, title) VALUES ('old', 'model', 'Historical chat'), ('recent', 'model', 'Recent chat')").run();
    const old = sessions.saveMessage('old', 'user', 'How to say prayer in quran, from start to end?', [], null, null).id;
    sessions.editMessage(old, 'A different branch');
    const variant = sessions.saveMessage('recent', 'assistant', 'Current response', [], null, null).id;
    db.prepare('UPDATE messages SET variants = ?, active_variant_index = 0 WHERE id = ?').run(JSON.stringify([{content:'Current response'}, {content:'Archived variant needle'}]), variant);
    const insert = db.prepare("INSERT INTO messages(session_id, role, content) VALUES ('recent', 'user', ?)");
    db.transaction(() => { for (let index = 0; index < 700; index++) insert.run(`Unrelated newer message ${index}`); })();
    let passes = 0;
    const result = await searchMessagePage(async ({query, cursor}) => {
      // Force short slices deterministically, independent of machine speed.
      const realNow = Date.now;
      let now = realNow();
      try {
        Date.now = () => now++;
        passes++;
        return searchMessages(db, query, {cursor, includeVariants:true, deadline:now + 8});
      } finally { Date.now = realNow; }
    }, 'prayer in quran');
    assert(passes > 1);
    assert.equal(result.cursor, null);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, old);
    assert(!sessions.loadSession('old').messages.some(message => message.id === old));
    sessions.selectMessageBranch('old', old);
    assert(sessions.loadSession('old').messages.some(message => message.id === old));
    const variants = searchMessages(db, 'Archived variant needle', { includeVariants:true });
    assert.equal(variants.matches[0].id, variant);
    assert.equal(variants.matches[0].saved_variant_index, 1);
    const noMatch = await searchMessagePage(async ({query,cursor}) => searchMessages(db, query, {cursor,includeVariants:true}), 'absent needle');
    assert.deepEqual(noMatch, {matches:[],cursor:null});
    console.log('Historical search: old messages across chats and time slices, inactive branches, saved variants, and exhausted searches passed.');
  } finally {
    database.closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, {recursive:true,force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
