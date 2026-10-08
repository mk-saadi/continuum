// Run: node --test tests/skillProposalStepArgs.test.mjs
// B1: execution-step `args` must stay the canonical structured object on every
// path that feeds SkillProposalCard or session save; only display text is capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { compactMessageForDisplay, compactStepsForDisplay, TOOL_DISPLAY_LIMIT } from '../src/lib/toolDisplay.mjs';
import { runDesktopChat } from '../src/lib/desktopChat.mjs';

const require = createRequire(import.meta.url);
const { normalizeExecutionSteps } = require('../src/main/executionSteps.js');

const instructions = `# Large skill\n\n${'Repeatable step with details.\n'.repeat(800)}`;
const proposal = { name: 'large-skill', description: 'Keeps a long workflow', instructions };
assert.ok(JSON.stringify(proposal).length > 10_000, 'fixture must exceed the display cap');

const proposeStep = (overrides = {}) => ({
  id: 'skill-step',
  type: 'tool_call',
  toolName: 'propose_skill',
  serverName: 'native',
  status: 'complete',
  args: proposal,
  ...overrides,
});

test('normalizeExecutionSteps accepts canonical structured args for a large propose_skill step', () => {
  const steps = normalizeExecutionSteps([proposeStep()]);
  assert.equal(typeof steps[0].args, 'object');
  assert.notEqual(steps[0].args, null);
  assert.deepEqual(steps[0].args, proposal);
  assert.equal(steps[0].args.instructions, instructions);
  assert.ok(JSON.stringify(steps[0].args).length > 10_000);
});

test('normalizeExecutionSteps still rejects stringified step args', () => {
  const corrupted = [{ ...proposeStep(), args: JSON.stringify(proposal) }];
  assert.throws(() => normalizeExecutionSteps(corrupted), /Invalid tool step/);
});

test('display compaction keeps propose_skill args structured while capping display text', () => {
  const step = proposeStep({ result: 'r'.repeat(TOOL_DISPLAY_LIMIT + 5_000) });

  const [live] = compactStepsForDisplay([step]);
  assert.equal(typeof live.args, 'object');
  assert.deepEqual(live.args, proposal);
  // Display-only fields still get capped for chat state.
  assert.ok(live.result.length < step.result.length);
  assert.match(live.result, /truncated in chat/);

  // The same compaction runs after completion and on history load.
  const message = compactMessageForDisplay({ role: 'assistant', content: '', executionSteps: [step] });
  assert.equal(typeof message.executionSteps[0].args, 'object');
  assert.deepEqual(message.executionSteps[0].args, proposal);
  assert.match(message.executionSteps[0].result, /truncated in chat/);
});

test('small tool steps keep their previous compacted shape', () => {
  const small = {
    id: 'small-step',
    type: 'tool_call',
    toolName: 'read_file',
    status: 'complete',
    args: { path: 'src/main.js' },
    result: 'file contents',
  };
  const [compacted] = compactStepsForDisplay([small]);
  assert.equal(compacted.args, small.args, 'small args pass through untouched');
  assert.deepEqual(compacted.args, { path: 'src/main.js' });
  assert.equal(compacted.result, 'file contents');
  assert.equal(compacted.status, 'complete');
});

test('live step-update snapshots stay structured through the renderer path', async () => {
  const oldWindow = globalThis.window;
  let listener, requestId, finish;
  const snapshots = [];
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => {}; },
    run: payload => { requestId = payload.requestId; return new Promise(resolve => { finish = resolve; }); },
  } };
  try {
    const chat = runDesktopChat({ modelId: 'test', messages: [], onExecutionSteps: steps => snapshots.push(steps) });
    listener({ requestId, type: 'step-update', executionSteps: [proposeStep({ status: 'pending' })] });
    await new Promise(resolve => setTimeout(resolve, 80)); // step snapshots flush after 50 ms
    assert.ok(snapshots.length >= 1, 'step-update snapshot reached the renderer');
    const [step] = snapshots[0];
    assert.equal(typeof step.args, 'object');
    assert.deepEqual(step.args, proposal);
    // ChatInterface compacts every snapshot before storing it in message state.
    assert.deepEqual(compactStepsForDisplay(snapshots[0])[0].args, proposal);
    finish({ text: '', executionSteps: snapshots[0] });
    await chat;
    assert.deepEqual(snapshots.at(-1).at(-1).args, proposal);
  } finally { globalThis.window = oldWindow; }
});
