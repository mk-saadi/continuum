'use strict';
// Synthetic structural replay. No historical TaskFlow content or private logs.
function operations(count = 207) {
  return Array.from({ length: count }, (_, i) => {
    const page = i % 11;
    const lines = Array.from({ length: Math.min(120, 1057 - page * 100) }, (_, n) => `${page * 100 + n + 1}: synthetic source observation function fixture_${page * 100 + n}() { return ${page * 100 + n}; }`).join('\n');
    const command = i % 11 === 0;
    const edit = !command && i % 13 === 0;
    return { id: `op-${i}`, type: 'tool_call', status: 'complete',
      toolName: command ? 'execute_command' : edit ? 'write_project_file' : 'read_project_file',
      args: command ? { command: `node --test synthetic-${i % 3}.test.cjs` } : { relative_path: 'synthetic.test.cjs', offset: page * 100, limit: 120 },
      result: command ? { exitCode: i % 22 === 0 ? 1 : 0, stdout: `${'ok synthetic assertion\n'.repeat(300)}\n${i % 22 === 0 ? 'not ok 7 - synthetic buried failure' : '# pass 300'}\n${'ok tail\n'.repeat(300)}` }
        : edit ? { success: true } : { content: lines, total_lines: 1057, has_more: page < 10, revision: i < 104 ? 'revision-a' : 'revision-b' } };
  });
}
function adapter({ mode = 'valid', calls = [] } = {}) {
  return async request => {
    calls.push({ maxTokens: request.max_tokens, hasTools: !!request.tools?.length });
    const selectedMode = Array.isArray(mode) ? mode[Math.min(calls.length - 1, mode.length - 1)] : mode;
    if (selectedMode === 'provider-error') throw Object.assign(Error('synthetic provider failure'), { code: 'provider-error' });
    const input = JSON.parse(request.messages[1].content);
    const draft = { objective: 'Complete synthetic reliability task', briefIds: input.briefs.map(b => b.id),
      ...Object.fromEntries(require('../../src/main/workspaceCompactCandidate').ARRAY_KEYS.map(key => [key, []])),
      blockers: ['Synthetic failure requires inspection.'], nextActions: ['Inspect stored failures; do not replay completed edits.'] };
    if (selectedMode === 'unsupported') draft.completedWork = [{ text: 'All tests passed', sources: [{ messageId: -1, stepId: 'missing' }] }];
    if (selectedMode === 'invalid-structured') draft.research = [{ text: 'Synthetic invalid finding', sources: [] }];
    if (selectedMode === 'unsupported-finding') draft.research = [{ text: 'Synthetic unsupported finding', evidenceQuote: 'Invented source excerpt',
      sources: [{ messageId: input.evidence[0]?.messageId ?? -1, stepId: input.evidence[0]?.stepId ?? 'missing' }] }];
    if (selectedMode === 'typical') draft.unknowns = ['Synthetic uncertainty. '.repeat(80)];
    if (selectedMode === 'oversized') draft.unknowns = ['Synthetic detail. '.repeat(request.max_tokens)];
    if (selectedMode === 'maximum') {
      let low=0,high=request.max_tokens*3;
      while(low<high) {
        const size=Math.ceil((low+high)/2);draft.unknowns=['x'.repeat(size)];
        const count=require('../../src/main/contextBudget').approximateTokens({model:request.model,messages:[{role:'assistant',content:JSON.stringify(draft)}]});
        if(count<=request.max_tokens)low=size;else high=size-1;
      }
      draft.unknowns=['x'.repeat(low)];
    }
    const content = ['empty','zero-token'].includes(selectedMode) ? '' : selectedMode === 'invalid' ? '{' : JSON.stringify(draft);
    return { choices: [{ message: { content }, finish_reason: selectedMode === 'truncated' ? 'length' : 'stop' }],
      usage: { completion_tokens: selectedMode==='maximum'?request.max_tokens:Math.ceil(Buffer.byteLength(content) / 3) } };
  };
}
module.exports = { operations, adapter };
