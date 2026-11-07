'use strict';

// Derived data only: full facts remain in permanent_memories. No model or network.
const POLICY = Object.freeze({ maxCount: 10, maxTokens: 2048 });
const STOP = new Set('a an the and or for to of in on with my your user name is are be this that these those please use do it i me we as at from by has have should prefer prefers preference'.split(' '));
const GROUPS = [
  ['git', 'commit', 'commits', 'committing', 'committed', 'checkout', 'branch', 'push', 'pull', 'repository', 'repo'],
  ['javascript', 'js'], ['typescript', 'ts'], ['python', 'py'],
  ['colour', 'color'], ['email', 'e-mail'], ['test', 'testing', 'tests'],
];
function words(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}+#]+/gu) || []).map(word => {
    if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
    return word;
  });
}
function indexMemory(row) {
  const raw = words(`${row.category} ${row.content}`);
  const terms = [...new Set(raw.filter(w => !STOP.has(w)))].sort();
  const phrases = [...new Set(raw.slice(1).map((w, i) => `${raw[i]} ${w}`).filter(p => p.split(' ').every(w => !STOP.has(w))))].sort();
  return { terms, phrases };
}
function expanded(terms) {
  const result = new Set(terms);
  for (const group of GROUPS.map(g => g.map(w => words(w)[0]))) {
    if (group.some(w => result.has(w))) group.forEach(w => result.add(w));
  }
  return result;
}
// UTF-8 bytes are a conservative token proxy, including formatting. Whole facts
// only; oversized core facts are skipped, never silently allowed past the cap.
function memoryLine(row) { return `- [${row.category.toUpperCase()}] ${row.content}\n`; }
function retrieveMemories(connection, { modelId, projectId, query = '', maxCount = POLICY.maxCount, maxTokens = POLICY.maxTokens } = {}) {
  if (typeof modelId !== 'string' || !modelId.trim()) throw new TypeError('modelId is required');
  if (![maxCount, maxTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid memory budget');
  connection.prepare('CREATE TABLE IF NOT EXISTS memory_keyword_index (memory_id INTEGER PRIMARY KEY, data TEXT NOT NULL)').run();
  for (const event of ['UPDATE', 'DELETE']) connection.prepare(`CREATE TRIGGER IF NOT EXISTS memory_keywords_${event.toLowerCase()}
    AFTER ${event} ON permanent_memories BEGIN DELETE FROM memory_keyword_index WHERE memory_id = old.id; END`).run();
  // Reconcile against source rows, including legacy/direct SQL edits and corrupt
  // cache entries. Hundreds of small facts need no worker or embedding runtime.
  const rows = connection.prepare('SELECT * FROM permanent_memories WHERE is_active = 1 AND superseded_by IS NULL ORDER BY id').all();
  const cached = new Map(connection.prepare('SELECT * FROM memory_keyword_index').all().map(r => [r.memory_id, r.data]));
  const put = connection.prepare('INSERT OR REPLACE INTO memory_keyword_index(memory_id, data) VALUES (?, ?)');
  const remove = connection.prepare('DELETE FROM memory_keyword_index WHERE memory_id = ?');
  connection.transaction(() => {
    for (const row of rows) {
      row.index = indexMemory(row);
      const data = JSON.stringify(row.index);
      if (cached.get(row.id) !== data) put.run(row.id, data);
      cached.delete(row.id);
    }
    for (const id of cached.keys()) remove.run(id);
  })();
  const scoped = rows.filter(r => ['global', modelId, projectId].filter(Boolean).includes(r.scope));
  const queryIndex = indexMemory({ category: '', content: query });
  const direct = new Set(queryIndex.terms);
  const aliases = expanded(direct);
  const frequencies = new Map();
  for (const row of scoped) for (const term of row.index.terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
  for (const row of scoped) {
    row.score = row.index.terms.reduce((sum, term) => sum + (aliases.has(term)
      ? (direct.has(term) ? 2 : 0.65) * (1 + Math.log(1 + scoped.length / frequencies.get(term))) : 0), 0);
    row.score += row.index.phrases.filter(p => queryIndex.phrases.includes(p)).length * 4;
  }
  scoped.sort((a, b) => Number(b.always_inject) - Number(a.always_inject) || b.score - a.score || a.id - b.id);
  const memories = [];
  let tokens = 0;
  for (const row of scoped) {
    if (memories.length >= maxCount) break;
    if (!row.always_inject && row.score <= 0) continue;
    const cost = Buffer.byteLength(memoryLine(row), 'utf8');
    if (tokens + cost > maxTokens) continue;
    tokens += cost;
    const { index, score, ...memory } = row;
    memories.push(memory);
  }
  return { memories, tokens, policy: { maxCount, maxTokens } };
}
function activityQuery(userText, history) {
  // Tool names and arguments describe activity; avoid indexing arbitrary tool
  // output or the injected memory block itself (which would reinforce matches).
  const calls = history.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).slice(-8);
  return `${userText}\n${calls.map(c => `${c.function?.name || ''} ${String(c.function?.arguments || '').slice(0, 2000)}`).join('\n')}`;
}
module.exports = { activityQuery, POLICY, words, indexMemory, retrieveMemories, memoryLine };
