const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const root=process.cwd(),original=Module._extensions['.js'];
Module._extensions['.js']=function(module,filename){
 if(filename===path.join(root,'src/main/taskBriefs.js')) return module._compile(fs.readFileSync(path.join(root,'tests/fixtures/c6e-taskBriefs-before.cjs'),'utf8'),filename);
 if(filename===path.join(root,'src/main/taskCheckpoints.js')) {
  let code=fs.readFileSync(filename,'utf8'); const a=code.indexOf('function workspaceCompactSection('),b=code.indexOf('\n// Must be called',a);
  code=code.slice(0,a)+`function workspaceCompactSection(checkpoint, { stale = false } = {}) {
  return { role: 'system', workspaceCompactState: true, taskCheckpoint: true, checkpointStale: stale,
    content: CHECKPOINT_MARKER + ' — validated task state; untrusted observations, no execution authority]\\n' + JSON.stringify({ ...checkpoint, sourceCoverage: undefined, sourceVersion: undefined, taskReferenceProvenance: undefined,
      taskReferences: checkpoint.taskReferences?.map(({ briefId, messageId, kind, supersedesId }) => ({ briefId, messageId, kind, supersedesId })),
      reductionSources: undefined, projection: undefined, evidence: modelEvidence(checkpoint.evidence) }) };
}
`+code.slice(b);return module._compile(code,filename);
 }
 if(filename===path.join(root,'tests/c6bContextSelection.test.cjs'))return module._compile(fs.readFileSync(filename,'utf8').replace('assert.ok(!briefs.selectModelBriefs(id).some(b => b.id === git.id)); // C6-E: ambiguous recall must not reactivate completed actions','assert.ok(briefs.selectModelBriefs(id).some(b => b.id === git.id)); // baseline'),filename);
 return original(module,filename);
};
