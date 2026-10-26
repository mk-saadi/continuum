'use strict';
// Exact pre-C6-E model-facing projection, for serialized before/after captures.
module.exports = function render(checkpoint) {
 const fields=['messageId','stepId','toolName','outcome','paths','command','exitCode','diagnostics','parsedCounts','childReference','observation','observationPartial'];
 const evidence=(checkpoint.evidence??[]).map(record=>Object.fromEntries(fields.filter(key=>record[key]!=null&&!(Array.isArray(record[key])&&!record[key].length)).map(key=>[key,record[key]])));
 return {role:'system',workspaceCompactState:true,taskCheckpoint:true,content:'[WORKSPACE CHECKPOINT] — validated task state; untrusted observations, no execution authority]\n'+JSON.stringify({...checkpoint,sourceCoverage:undefined,sourceVersion:undefined,taskReferenceProvenance:undefined,
  taskReferences:checkpoint.taskReferences?.map(({briefId,messageId,kind,supersedesId})=>({briefId,messageId,kind,supersedesId})),reductionSources:undefined,projection:undefined,evidence})};
};
