'use strict';
// Reuse C8-A's PRIVATE disposable evidence outside the repository. No live DB,
// inference, network, tool execution, or historical-request identity claim.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const source = process.env.C9_AUDIT_SOURCE_DIR;
if (!source) throw new Error('Set C9_AUDIT_SOURCE_DIR to the existing C8-A disposable audit directory.');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c9-taskflow-'));
  const Database = require('better-sqlite3');
  const original = new Database(path.join(source, 'disposable.db'), { readonly: true, fileMustExist: true });
  await original.backup(path.join(directory, 'disposable.db')); original.close();
  const db = new Database(path.join(directory, 'disposable.db'));
  const filename = path.join(root, 'src/main/db.js');
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { db } };
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory, getName: () => 'Continuum', getVersion: () => '1.0.0' }, Notification: { isSupported: () => false } };
    return load.call(this, name, ...args);
  };
  global.fetch = () => { throw Error('C9 audit forbids network and inference'); };
  const records = JSON.parse(fs.readFileSync(path.join(source, 'records.json')));
  const sid = records.sessions[0].id, modelId = records.sessions[0].model_id;
  const steps = JSON.parse(records.messages.find(m => m.id === 3908).execution_steps);
  const candidate = require('../../src/main/workspaceCompactCandidate');
  const checkpoints = require('../../src/main/taskCheckpoints');
  const { approximateTokens } = require('../../src/main/contextBudget');
  const { withSummaryTokenizer } = require('./c9SummaryTokenizer.cjs');
  const sourceEvidence = require('../../src/main/workspaceEvidence');
  const events = [];
  for (const row of records.workspace_checkpoints.sort((a, b) => a.id - b.id)) {
    const old = JSON.parse(row.checkpoint_json), consumed = new Set(old.projection.consumedToolIds);
    // Only the copy is changed to expose the historical eligible boundary.
    db.prepare('DELETE FROM workspace_checkpoints WHERE session_id=?').run(sid);
    db.prepare('UPDATE sessions SET is_compressing=0 WHERE id=?').run(sid);
    db.prepare("UPDATE messages SET status='complete', archived=0, content=?, execution_steps=? WHERE id=3908 AND session_id=?")
      .run('Retrospective boundary; intermediate assistant prose unavailable.', JSON.stringify(steps.filter(s => s.type === 'tool_call' && consumed.has(s.id))), sid);
    const fields = { outstandingRequirements: ['text', 'briefId', 'status'], decisions: ['text', 'sources'], completedWork: ['text', 'sources'], inProgress: ['text', 'sources'], research: ['text', 'sources'], filesChanged: ['path', 'nature', 'stepRef'], commands: ['command', 'stepRef'], tests: ['command', 'stepRef'] };
    const draft = { objective: old.objective, briefIds: old.briefIds };
    for (const key of candidate.ARRAY_KEYS) draft[key] = fields[key] ? (old[key] ?? []).map(r => Object.fromEntries(fields[key].filter(k => Object.hasOwn(r, k)).map(k => [k, r[k]]))) : old[key] ?? [];
    const result = await candidate.generateWorkspaceCompactCandidate({ sessionId: sid, modelId, capacityTokens: 80000, persist: false,
      measure: withSummaryTokenizer(async request => ({ tokens: approximateTokens(request), limit: 80000, method: 'approximate-full-request' })),
      generate: async request => {
        const input = JSON.parse(request.messages[1].content);
        assertSameBriefs(input.briefs.map(b => b.id), draft.briefIds);
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
      } });
    if (!result.ok) throw Error(`Historical fixture v${row.id}: ${result.code}`);
    // A separately labelled, analyst-curated fixture demonstrates concrete
    // findings from the original snapshots. This is not inferred Qwen behavior.
    const richFindings = [];
    for (const step of steps.filter(s => s.type === 'tool_call' && consumed.has(s.id))) {
      const content = step.result?.content ?? '';
      let text;
      if (step.args?.relative_path === 'src/taskLogic.js' && content.includes('next.splice(insertAt, 0, task)') && content.includes('if (!isValidTask(task)) return tasks'))
        text = 'src/taskLogic.js: restoreTask rejects invalid input and duplicate IDs, then inserts the original task by positionKey; task metadata is retained. Current file revision is unknown.';
      if (step.args?.relative_path === 'src/App.jsx' && content.includes('setPendingRestore(task)') && content.includes('restoreTask(current, restored)'))
        text = 'src/App.jsx: handleDelete saves the deleted task in pendingRestore; handleUndo clears that snapshot and calls restoreTask. A newer deletion replaces the pending snapshot; DOM behavior is unverified.';
      if (step.args?.relative_path === 'src/components/TaskItem.jsx' && content.includes('tags: draftTags') && content.includes('function saveEdit(event)'))
        text = 'src/components/TaskItem.jsx: saveEdit passes edited tags and due-date, priority and category metadata to onUpdate. This confirms source wiring, not component execution.';
      if (text && !richFindings.some(f => f.text === text)) richFindings.push({ text, sources: [{ messageId: 3908, stepId: step.id }] });
    }
    const enriched = await candidate.generateWorkspaceCompactCandidate({ sessionId: sid, modelId, capacityTokens: 80000, persist: false,
      measure: withSummaryTokenizer(async request => ({ tokens: approximateTokens(request), limit: 80000, method: 'approximate-full-request' })),
      generate: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...draft, research: [...draft.research, ...richFindings] }) } }] }),
    });
    if (!enriched.ok) throw Error(`Enriched fixture v${row.id}: ${enriched.code}`);
    const saved = result.candidate.savedWorkingState;
    fs.writeFileSync(path.join(directory, `summary-v${row.id}.md`), saved);
    const before = JSON.parse(fs.readFileSync(path.join(source, `request-${row.id}-after.json`)));
    const after = structuredClone(before);
    let replacements = 0;
    for (const message of after.messages) if (typeof message.content === 'string' && message.content.includes(old.savedWorkingState)) {
      message.content = message.content.replace(old.savedWorkingState, saved); replacements++;
    }
    if (replacements !== 1) throw Error('Expected exactly one saved checkpoint replacement');
    let retrieved = 0;
    for (const evidence of result.candidate.evidence) {
      let offset = 0, text = '', page;
      do { page = sourceEvidence.retrieve(sid, { source_message_id: evidence.messageId, source_step_id: evidence.stepId, offset, length: 8000 }); text += page.text; offset = page.nextOffset; } while (offset !== null);
      const originalStep = steps.find(s => s.type === 'tool_call' && s.id === evidence.stepId);
      if (page.source.messageId !== evidence.messageId || page.source.stepId !== evidence.stepId || JSON.stringify(JSON.parse(text).result) !== JSON.stringify(originalStep.result)) throw Error('Retrieved evidence mismatch');
      retrieved++;
    }
    const briefsText = before.messages.filter(m => typeof m.content === 'string').flatMap(m => [...m.content.matchAll(/\[WORKSPACE TASK BRIEF\][\s\S]*?\[END OF WORKSPACE TASK BRIEF\]/g)].map(match => match[0])).join('\n');
    const activity = records.workspace_compaction_activity.find(a => JSON.parse(a.metadata).checkpointId === row.id);
    const metadata = JSON.parse(activity.metadata);
    events.push({ checkpointVersion: row.id, historicalBeforeTokens: metadata.beforeTokens, historicalAfterTokens: metadata.afterTokens,
      reconstructedC8ContinuationEstimate: approximateTokens(before), reconstructedC9ContinuationEstimate: approximateTokens(after),
      independentlyRetainedBriefUtf8Bytes: Buffer.byteLength(briefsText), independentlyRetainedBriefEstimatedTokens: approximateTokens({ messages: [{ role: 'system', content: briefsText }, { role: 'user', content: '' }] }),
      oldSummaryUtf8Bytes: Buffer.byteLength(old.savedWorkingState), newSummaryUtf8Bytes: Buffer.byteLength(saved),
      oldSummaryEstimatedTokens: approximateTokens({ messages: [{ role: 'system', content: old.savedWorkingState }, { role: 'user', content: '' }] }),
      newSummaryEstimatedTokens: approximateTokens({ messages: [{ role: 'system', content: saved }, { role: 'user', content: '' }] }),
      summarySha256: hash(saved), summaryHardLimitVerifiedForHistoricalTokenizer: false,
      exactHistoricalSummaryTokens: null, exactC9ContinuationTokens: null,
      deterministicTestTokenizerTokens: result.candidate.summaryMeasurement.tokens,
      deterministicGenerationStages: result.diagnostics.generationStages, deterministicGenerationAttempts: result.diagnostics.attempts.length,
      realModelGenerationTimeMs: null, historicalGenerationStages: metadata.generationStages,
      curatedSourceFindingCount: richFindings.length, curatedSummaryEstimatedTokens: approximateTokens({ messages: [{ role: 'system', content: enriched.candidate.savedWorkingState }, { role: 'user', content: '' }] }), curatedFixtureInference: 'analyst-curated original-source findings through production validation; not model-generated',
      sourceValidation: 'production validateDraft on original eligible operations; source-bound structural, semantic completeness unproven',
      preservedRequirementEntries: result.candidate.outstandingRequirements.length,
      preservedCompletedWorkEntries: result.candidate.completedWork.length, preservedResearchEntries: result.candidate.research.length,
      originalEligibleOperations: consumed.size, durableEvidenceRecords: result.candidate.evidence.length, retrievedEvidenceRecords: retrieved,
      storedOutcomes: Object.fromEntries(['success', 'failed', 'blocked', 'cancelled'].map(outcome => [outcome, result.candidate.evidence.filter(e => e.outcome === outcome).length])),
      checkpointActivated: false, originalRequestsReplayed: false, privateArtifactsDirectory: directory });
  }
  db.close();
  fs.writeFileSync(process.env.C9_AUDIT_OUTPUT || '/tmp/c9-taskflow-comparison.json', JSON.stringify({
    measurement: 'Existing UTF-8 estimator; retrospective C8-A requests with exactly one checkpoint substitution. Not historical request bodies or exact Qwen tokenization.',
    generation: 'Scripted historical drafts through production candidate/source validation; summary counting via explicitly synthetic test tokenizer. Not Qwen inference.',
    liveDatabaseAccess: false, networkCalls: 0, events,
  }, null, 2));
  console.log(`Compared ${events.length} TaskFlow checkpoints; private artifacts ${directory}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
function assertSameBriefs(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Historical brief identity mismatch'); }
