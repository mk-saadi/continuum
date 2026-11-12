// Adapt the bounded child snapshot to the same read-only workspace messages.
const textOf = value => typeof value === 'string' ? value : value?.text ?? '';
function preview(value) {
  const text = textOf(value);
  return value?.truncated ? `${text}\n[Preview shortened for display]` : text;
}
function argsOf(value) {
  const text = textOf(value);
  try { return JSON.parse(text); } catch { return { input: text }; }
}
export function subagentMessages(transcript, task, childId) {
  const live = ['created', 'waiting', 'running'].includes(transcript?.status);
  const turns = transcript?.turns ?? [];
  const activity = transcript?.activity ?? [];
  const messages = [];
  const prompt = task || transcript?.task || textOf(turns.find(turn => turn.role === 'user')?.text);
  if (prompt) messages.push({ id: `${childId}:task`, role: 'user', content: prompt });
  const steps = [];
  let pending = [], assistantTurn = 0;
  const toolOutcomes = activity.filter(event => event.type === 'tool-result');
  let outcomeIndex = 0;
  const hasCalls = turns.some(turn => turn.toolCalls?.length);
  const addThought = (text, id) => { if (text) steps.push({ id, type: 'thought', content: text }); };
  if (!hasCalls) {
    activity.forEach((event, index) => {
      const id = `${childId}:event:${index}`;
      if (event.type === 'thought') addThought(event.text, id);
      if (event.type === 'fetch' || event.type === 'file') steps.push({ id, type: 'tool_call',
        toolName: event.type === 'fetch' ? 'get_single_web_page_content' : 'read_project_file',
        args: event.type === 'fetch' ? { url: event.url } : { path: event.path }, status: 'complete',
        result: event.chars != null ? `${event.chars.toLocaleString()} characters read` : 'Read completed' });
    });
  }
  let lastAnswer = '';
  turns.forEach((turn, index) => {
    if (turn.role === 'assistant') {
      assistantTurn++;
      if (hasCalls) activity.filter(event => event.type === 'thought' && event.turn === assistantTurn)
        .forEach((event, i) => addThought(event.text, `${childId}:thought:${index}:${i}`));
      const body = preview(turn.text);
      if (body) {
        lastAnswer = body;
        steps.push({ id: `${childId}:text:${index}`, type: 'text', content: body });
      }
      pending = (turn.toolCalls ?? []).map((call, i) => {
        const step = { id: `${childId}:tool:${index}:${i}`, type: 'tool_call', toolName: call.name,
          args: argsOf(call.arguments), status: live ? 'running' : 'error',
          error: live ? null : 'No recorded tool result.' };
        steps.push(step);
        return step;
      });
    } else if (turn.role === 'tool') {
      const step = pending.shift();
      if (step) {
        step.result = preview(turn.text);
        step.status = 'complete';
        step.error = null;
        const notExecuted = /^\[Tool skipped:|This call was not executed\./.test(textOf(turn.text)) || textOf(turn.text).includes('This call was not executed.');
        if (notExecuted) step.status = 'deferred';
        else if (/^Error:/.test(textOf(turn.text))) { step.status = 'error'; step.error = textOf(turn.text); }
        const outcome = notExecuted ? null : toolOutcomes[outcomeIndex++];
        if (outcome?.name === step.toolName && outcome.ok === false) {
          step.status = 'error';
          step.error = 'Tool failed';
        }
        try {
          const result = JSON.parse(textOf(turn.text));
          if (result?.error || result?.ok === false || result?.success === false) { step.status = 'error'; step.error = String(result.error || 'Tool failed'); }
        } catch { /* Text results are displayed verbatim. */ }
      }
    } else if (turn.role === 'user' && index !== turns.findIndex(item => item.role === 'user')) {
      steps.push({ id: `${childId}:instruction:${index}`, type: 'text', content: `User instruction:\n${preview(turn.text)}` });
    }
  });
  const progress = live ? transcript?.liveProgress : null;
  if (progress?.type === 'thinking' && !activity.some(event => event.type === 'thought' && event.text === progress.text)) {
    addThought(progress.text, `${childId}:live-thought`);
  }
  const answer = preview(transcript?.result) || (progress?.type === 'responding' ? progress.text : '') || lastAnswer;
  // The final assistant text is rendered below the execution stages, once.
  const last = steps.at(-1);
  if (last?.type === 'text' && last.content === answer) steps.pop();
  messages.push({ id: `${childId}:run`, role: 'assistant', content: answer, executionSteps: steps,
    model: transcript?.model, model_name: transcript?.model, agent_name: 'Sub-agent', streaming: live,
    status: live ? 'running' : transcript?.status === 'completed' ? 'complete' : transcript?.status ?? 'interrupted' });
  return messages;
}
