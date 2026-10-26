'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = process.env.C6B_SOURCE_ROOT || path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c6b-request-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const get = name => require(path.join(root, 'src/main', name));
const storage = get('db'); storage.initDatabase(directory);
const sessions = get('sessionManager'), briefs = get('taskBriefs');
const project = get('projectManager').createProject({ name: 'C6-B request capture' });
(async () => {
  const captures = [];
  try {
    const { runMemoryChat } = await import(pathToFileURL(path.join(root, 'src/lib/memoryChat.mjs')));
    for (const count of [1,5,20,50]) {
      const id = `fixture-${count}`;
      sessions.getOrCreateSession(id, 'fixture-model', project.id);
      sessions.saveMessage(id, 'user', 'Persistent constraint: never publish.');
      const historical = [];
      for (let i = 0; i < count; i++) {
        const m = sessions.saveMessage(id, 'user', `Historical task ${i}: ${'Implement an isolated completed widget. '.repeat(20)}`);
        historical.push(briefs.getAllBriefs(id).at(-1));
        storage.db.prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(m.id);
      }
      sessions.saveMessage(id, 'assistant', 'CRITICAL_C6B_FACT: feature list is offline export, retry queue, and audit view.');
      sessions.saveMessage(id, 'user', historical.map(b => `[workspace-brief #${b.id} state=completed]`).join('\n') + '\nCurrent task: inspect the current implementation.');
      let request;
      await runMemoryChat({ modelId: 'fixture-model', baseUrl: 'http://fixture.invalid', projectId: project.id,
        messages: get('promptBuilder').rebuildChatMessages({ sessionId: id, modelId: 'fixture-model' }),
        chatTools: get('tools/agentTools').agentTools.filter(t => ['read_project_file','get_recent_chat_history'].includes(t.function.name)),
        fetchImpl: async (_url, options) => {
          request = JSON.parse(options.body);
          return Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] });
        } });
      captures.push({ count, request });
    }
    fs.writeFileSync(process.env.C6B_REQUEST_OUTPUT, JSON.stringify(captures, null, 2));
  } finally { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
