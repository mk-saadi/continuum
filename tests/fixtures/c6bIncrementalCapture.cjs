'use strict';
// Run against the reconstructed pre-change tree or current source with identical
// disposable data. Estimates are deliberately labeled; no latency assertions.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const root = process.env.C6B_SOURCE_ROOT || path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c6b-incremental-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const get = name => require(path.join(root, 'src/main', name));
const storage = get('db'); storage.initDatabase(directory);
const sessions = get('sessionManager'), checkpoints = get('taskCheckpoints'), w2 = get('workspaceCompactCandidate');
const project = get('projectManager').createProject({ name: 'incremental capture' });
sessions.getOrCreateSession('fixture', 'fixture-model', project.id);
sessions.saveMessage('fixture', 'user', 'Inspect configuration and preserve the unresolved issue.');
(async () => {
  const rows = [];
  try {
    for (let round = 1; round <= 11; round++) {
      sessions.saveMessage('fixture', 'assistant', `Observation ${round}: ` + 'historical source statement '.repeat(30), [], null, null, null, null, null,
        [{ id: `step-${round}`, type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: 'config.js' }, result: round === 1 ? 'CRITICAL_CAPTURE: offline export requires a retry queue.' : `config observation ${round}` }]);
      const inputs = [];
      const result = await w2.generateWorkspaceCompactCandidate({ sessionId: 'fixture', modelId: 'fixture-model', capacityTokens: 65536, persist: false,
        generate: async request => {
          const input = JSON.parse(request.messages[1].content); inputs.push(input);
          const draft = { objective: 'Inspect configuration', briefIds: input.briefs.map(b => b.id) };
          for (const key of w2.ARRAY_KEYS) draft[key] = [];
          draft.nextActions = ['Resolve remaining config issue'];
          return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
        } });
      if (!result.ok) throw new Error(JSON.stringify(result));
      rows.push({ round, inputTokens: result.diagnostics.inputTokens, method: result.diagnostics.measurement,
        originalMessagesPresented: inputs.flatMap(i => i.messages).map(m => m.id), evidenceRecordsPresented: inputs.reduce((n,i) => n+i.evidence.length,0),
        generationStages: inputs.length, criticalFindingInCheckpoint: JSON.stringify(result.candidate).includes('CRITICAL_CAPTURE'),
        archivedHistoryCharacters: inputs.reduce((n,i) => n+i.messages.filter(m => m.id < round+1).reduce((sum,m) => sum+m.text.length,0),0),
        checkpointEvidenceCharacters: JSON.stringify(result.candidate.evidence).length });
      storage.db.transaction(() => {
        checkpoints.persistCheckpointRow({ sessionId: 'fixture', checkpoint: { ...result.candidate, lifecycle: 'w3-current' }, briefIdentity: get('taskBriefs').getBriefIdentity('fixture') });
        storage.db.prepare('UPDATE messages SET archived = 1 WHERE session_id = ?').run('fixture');
      })();
    }
    fs.writeFileSync(process.env.C6B_INCREMENTAL_OUTPUT, JSON.stringify(rows, null, 2));
  } finally { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
