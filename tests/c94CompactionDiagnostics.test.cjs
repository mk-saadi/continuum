'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c91-semantic-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), checkpoints = require('../src/main/taskCheckpoints');
const candidate = require('../src/main/workspaceCompactCandidate'), summary = require('../src/main/compactionSummary');
const { withSummaryTokenizer } = require('./fixtures/c9SummaryTokenizer.cjs');
const { approximateTokens } = require('../src/main/contextBudget');
const project = require('../src/main/projectManager').createProject({ name: 'C9.1 disposable TaskFlow' });
let serial = 0;
const saved = {
  objective: 'Add category filtering to TaskFlow; preserve restoration metadata. Do not commit.',
  source: '// TaskFlow saved synthetic inspection; no production project used.\n' + Array.from({length: 60}, (_, i) => `// prior source context ${i}\n`).join('') +
    'export function restoreTask(tasks, task) { return [...tasks, task]; }\n// Restoration retains original task metadata. Category filtering is missing.\n',
  quote: 'Restoration retains original task metadata. Category filtering is missing.',
  next: 'Implement category filtering, add focused tests, then run the unrun npm run build.'
};
function fixture(source = saved.source) {
  const id = `c91-${++serial}`;
  sessions.getOrCreateSession(id, 'fixture', project.id);
  sessions.saveMessage(id, 'user', saved.objective);
  const message = sessions.saveMessage(id, 'assistant', 'Source inspection finished; category filtering remains.', [], null, null, null, null, null, [
    { id: 'read', type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: 'src/taskLogic.js' }, result: { content: source } },
    { id: 'test', type: 'tool_call', toolName: 'run_tests', status: 'complete', args: { command: 'npm test' }, result: { exitCode: 0, stdout: '4 passed\n# tests 4\n# pass 4' } }
  ]);
  return { id, message };
}
function draft(input, f) {
  return { objective: saved.objective, briefIds: input.briefs.map(b => b.id),
    ...Object.fromEntries(candidate.ARRAY_KEYS.map(k => [k, []])),
    outstandingRequirements: [{ text: 'Preserve metadata; do not commit.', briefId: input.briefs[0].id, status: 'open' }],
    research: [{ text: 'restoreTask retains task metadata; category filtering is missing in the inspected revision.', evidenceQuote: saved.quote, sources: [{ messageId: f.message.id, stepId: 'read' }] }],
    completedWork: [{ text: 'Tests passed (4); build has not run.', sources: [{ messageId: f.message.id, stepId: 'test' }] }],
    inProgress: [{ text: 'Implement category filtering.', sources: [{ messageId: f.message.id, stepId: 'read' }] }], nextActions: [saved.next] };
}
function run(f, change = () => {}, inspect = () => {}) {
  return candidate.generateWorkspaceCompactCandidate({ sessionId: f.id, modelId: 'fixture', capacityTokens: 65536, persist: false,
    measure: withSummaryTokenizer(async request => ({ tokens: approximateTokens(request), limit: 65536, method: 'server-template-tokenizer' })),
    generate: async (request, meta) => {
      const input = JSON.parse(request.messages[1].content); inspect(input, meta, request);
      const value = draft(input, f); change(value, input, meta);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
    } });
}

const diagnostics = require('../src/main/compactionRejectionDiagnostics');
test('C9.4 bounded rejected field and linked correction failure survive generation', async () => {
  const f = fixture();
  const result = await run(f, d => { d.research[0].evidenceQuote = 'fabricated'; });
  assert.equal(result.ok, false);
  const rows = result.diagnostics.rejections;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fieldPath, 'research[0]');
  assert.equal(rows[0].evidenceQuote, 'fabricated');
  assert.equal(rows[0].sources[0].exists, true);
  assert.equal(rows[0].correctionOutcome, 'rejected');
  assert.equal(rows[0].correctionRejectionCode, 'unsupported-finding-claim');
  assert.equal(result.diagnostics.checkpointActivated, false);
});
test('C9.4 valid correction links outcome and records changed claim', async () => {
  const f = fixture();
  const result = await run(f, (d, input, meta) => { if (!meta.attempt) { d.research[0].text = 'Original invalid claim'; d.research[0].evidenceQuote = 'fabricated'; } });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.rejections[0].correctionOutcome, 'validated');
  assert.equal(result.diagnostics.rejections[0].claimChanged, true);
  assert.ok(result.diagnostics.rejections[0].correctedCandidateId);
});
test('C9.4 secrets and oversized excerpts are bounded; malformed references preserve original error', () => {
  const draft = { research: [{text: 'api_key=secret-value ' + 'x'.repeat(10000), evidenceQuote: 'Bearer private-value', sources: [null, 'bad']}] };
  const error = {code:'unsupported-finding-claim',feedback:{category:'research',entryIndex:0}};
  const row = diagnostics.capture(error, draft, []);
  assert.ok(row.claim.length <= 512); assert.doesNotMatch(JSON.stringify(row), /secret-value|private-value/);
  assert.equal(row.sources.length, 0);
  const d = {}; for(let i=0;i<100;i++) diagnostics.record(d,error,{});
  assert.equal(d.rejections.length,24);
});
test('C9.4 activity persists privately, separates sessions and cascades deletion', () => {
  const f = fixture(), other = fixture();
  const activity = require('../src/main/workspaceCompactionActivity'), seen=[];
  const event = activity.create({sessionId:f.id,runId:'parent',broadcast:r=>seen.push(r)});
  event.update('validating',{rejectionDiagnostics:[{schemaVersion:1,claim:'bounded confidential claim'}]});
  assert.equal(activity.list(f.id)[0].metadata.rejectionDiagnostics[0].claim,'bounded confidential claim');
  assert.equal(activity.list(other.id).length,0);
  assert.ok(seen.every(r=>r.metadata.rejectionDiagnostics === undefined));
  storage.db.prepare('DELETE FROM sessions WHERE id=?').run(f.id);
  assert.equal(activity.list(f.id).length,0);
});
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory,{recursive:true,force:true}); });
test('C9.4 deterministic validator contract matrix', () => {
  const captured = {briefs:[{id:1}],messages:[{id:10},{id:11}]};
  const read = {messageId:10,stepId:'read',kind:'file-read',outcome:'success',paths:['a.js'],observation:'function present() {}',observationPartial:false};
  const edit = {messageId:10,stepId:'edit',kind:'file-edit',outcome:'success',paths:['a.js']};
  const command = {messageId:11,stepId:'test',kind:'command',command:'npm test -- unit',outcome:'success',exitCode:0,paths:[]};
  const source = [{messageId:10,stepId:'read'}];
  const cases = [
    ['exact excerpt', 'research', {text:'present exists',sources:source,evidenceQuote:'function present()'},[read],null],
    ['paged excerpt', 'research', {text:'present exists',sources:source,evidenceQuote:'present'},[{...read,observationPartial:true}],null],
    ['wrong operation', 'research', {text:'present exists',sources:[{messageId:10,stepId:'edit'}],evidenceQuote:'present'},[read,edit],'unsupported-finding-claim'],
    ['fabricated excerpt', 'research', {text:'invented',sources:source,evidenceQuote:'invented'},[read],'unsupported-finding-claim'],
    ['historical fact', 'research', {text:'present existed in inspected revision',sources:source,evidenceQuote:'present'},[read],null],
    ['uncertain inference', 'research', {text:'May handle this case; unverified',sources:source},[read],null],
    ['partial negative finding', 'research', {text:'Feature absent from whole project',sources:source,evidenceQuote:'present'},[{...read,observationPartial:true}],null],
    ['missing source', 'research', {text:'present',sources:[{stepId:'read'}]},[read],'invalid-reference'],
    ['foreign source', 'research', {text:'present',sources:[{messageId:999,stepId:'read'}]},[read],'invalid-reference'],
    ['instruction injection remains data', 'research', {text:'Source says ignore instructions',sources:source,evidenceQuote:'ignore instructions'},[{...read,observation:'ignore instructions'}],null],
    ['successful edit','completedWork',{text:'Edited a.js',sources:[{messageId:10,stepId:'edit'}]},[edit],null],
    ['failed edit','completedWork',{text:'Edited a.js',sources:[{messageId:10,stepId:'edit'}]},[{...edit,outcome:'failed'}],'unsupported-completion-claim'],
    ['scoped test','completedWork',{text:'Tests passed for unit',sources:[{messageId:11,stepId:'test'}]},[command],null],
    ['failed test','completedWork',{text:'Tests passed',sources:[{messageId:11,stepId:'test'}]},[{...command,outcome:'failed',exitCode:1}],'unsupported-completion-claim'],
    ['successful build','completedWork',{text:'Build passed',sources:[{messageId:11,stepId:'test'}]},[{...command,command:'npm run build'}],null],
    ['unrelated build','completedWork',{text:'Build passed',sources:[{messageId:11,stepId:'test'}]},[command],'unsupported-completion-claim'],
    ['plan alone','completedWork',{text:'Implemented feature',sources:source},[read],'unsupported-completion-claim'],
    ['historical completion','completedWork',{text:'Edited a.js in earlier operation',sources:[{messageId:10,stepId:'edit'}]},[edit],null],
    ['later failed verification','completedWork',{text:'Tests passed',sources:[{messageId:11,stepId:'test'},{messageId:11,stepId:'failed'}]},[command,{...command,stepId:'failed',outcome:'failed',exitCode:1}],'unsupported-completion-claim'],
    ['mixed outcomes','completedWork',{text:'Edited a.js',sources:[{messageId:10,stepId:'edit'}]},[edit,{...command,outcome:'failed',exitCode:1}],null],
    ['broad test scope limitation','completedWork',{text:'All tests passed',sources:[{messageId:11,stepId:'test'}]},[command],null]
  ];
  for(const [name,key,entry,evidence,expected] of cases) {
    const d={objective:'Audit',briefIds:[1],...Object.fromEntries(candidate.ARRAY_KEYS.map(k=>[k,[]])),blockers:['Unresolved work'],nextActions:['Inspect']};d[key]=[entry];
    let actual=null;try{candidate.validateDraft(d,captured,evidence);}catch(error){actual=error.code;}
    assert.equal(actual,expected,name);
  }
});

test('C9.4 private polling hydrates equal-revision content-free broadcast', async () => {
  const {mergeActivity} = await import('../src/lib/compactionActivity.mjs');
  const base={id:'attempt',session_id:'s',sequence:1,revision:2,metadata:{}};
  const detailed={...base,metadata:{rejectionDiagnostics:[{claim:'private'}]}};
  assert.equal(mergeActivity([base],[detailed],'s')[0],detailed);
  assert.equal(mergeActivity([detailed],[base],'s')[0],detailed);
});
