'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { retrieveMemories, activityQuery } = require('../src/main/memoryRetrieval');
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE permanent_memories (id INTEGER PRIMARY KEY, category TEXT, content TEXT, scope TEXT DEFAULT 'global', always_inject INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, superseded_by INTEGER)`);
  const add = (content, scope = 'global', core = 0) => Number(db.prepare('INSERT INTO permanent_memories(category,content,scope,always_inject) VALUES (?,?,?,?)').run('preference', content, scope, core).lastInsertRowid);
  return { db, add, get: (query, options = {}) => retrieveMemories(db, { modelId: 'model', query, ...options }).memories };
}
test('legacy facts indexed; commit aliases, variants, ranking and common words', () => {
  const { db, add, get } = fixture();
  const git = add('Git author name for commits: mk-saadi (`git config user.name`)');
  add('Favorite pet name: Luna');
  add('Git repository location: /tmp/project');
  assert.equal(get('Commit these changes')[0].id, git);
  assert.equal(get('committing changes')[0].id, git);
  assert.equal(get('name').length, 0);
  assert.equal(get('Cook dinner').length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_keyword_index').get().n, 3);
  db.close();
});
test('scope boundaries and deterministic core priority with shared hard budgets', () => {
  const { db, add, get } = fixture();
  const core = add('Essential fact', 'global', 1);
  const own = add('Git author', 'model');
  add('Git secret', 'other');
  const project = add('Git project policy', 'project');
  assert.deepEqual(get('git').map(m => m.id), [core, own]);
  assert.ok(get('git', { projectId: 'project' }).some(m => m.id === project));
  assert.deepEqual(get('git', { maxCount: 1 }).map(m => m.id), [core]);
  assert.deepEqual(get('git', { maxTokens: 1 }), []);
  add('x'.repeat(3000), 'global', 1);
  assert.ok(get('git').every(m => m.content.length < 3000));
  assert.deepEqual(get('git'), get('git'));
  db.close();
});
test('source edits, deactivation, deletion and invalid or missing indexes repair safely', () => {
  const { db, add, get } = fixture();
  const id = add('Git author');
  get('git');
  db.prepare("UPDATE memory_keyword_index SET data='invalid'").run();
  assert.equal(get('git').length, 1);
  db.prepare('UPDATE permanent_memories SET content=? WHERE id=?').run('Python style', id);
  assert.equal(get('git').length, 0);
  assert.equal(get('py').length, 1);
  db.prepare('UPDATE permanent_memories SET is_active=0 WHERE id=?').run(id);
  assert.equal(get('py').length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_keyword_index').get().n, 0);
  db.prepare('DELETE FROM permanent_memories WHERE id=?').run(id);
  db.exec('DROP TABLE memory_keyword_index');
  assert.deepEqual(get('git'), []);
  db.close();
});
test('activity discovers Git memory once without feeding injected facts back into retrieval', () => {
  const { db, add, get } = fixture();
  add('Git author name: mk-saadi');
  assert.equal(get('Finish the task').length, 0);
  const history = [{ role: 'system', content: 'Python style' }, { role: 'assistant', tool_calls: [{ function: { name: 'git_status', arguments: '{}' } }] }];
  assert.equal(get(activityQuery('Finish the task', history)).length, 1);
  assert.doesNotMatch(activityQuery('', history), /Python/);
  db.close();
});
