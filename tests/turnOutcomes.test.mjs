import test from 'node:test';
import assert from 'node:assert/strict';
import { getTurnOutcomes } from '../src/lib/executionEvents.mjs';

const askStep = (id, args = {}, extra = {}) => ({
  id,
  type: 'tool_call',
  toolName: 'ask_user',
  status: 'complete',
  args: { question: 'Which style?', options: ['Line charts', 'Bar charts'], ...args },
  result: null,
  ...extra,
});
const skillStep = (id, args = {}, extra = {}) => ({
  id,
  type: 'tool_call',
  toolName: 'propose_skill',
  status: 'complete',
  args: { name: 'render-generated-media-as-png', description: 'd', instructions: 'i', ...args },
  result: null,
  ...extra,
});
const decisions = (map) => (stepId) => map[stepId] ?? '';

test('answered question matching an option names the option', () => {
  const outcomes = getTurnOutcomes(
    [askStep('q1', {}, { result: 'Line charts' })],
    { getSkillDecision: decisions({}) },
  );
  assert.deepEqual(outcomes.map((o) => o.label), ['Question answered · Line charts']);
});

test('answered question with free text reports a custom response', () => {
  const outcomes = getTurnOutcomes(
    [askStep('q1', {}, { result: 'Surprise me' })],
    { getSkillDecision: decisions({}) },
  );
  assert.deepEqual(outcomes.map((o) => o.label), ['Question answered · Custom response']);
});

test('errored question reports cancellation', () => {
  const outcomes = getTurnOutcomes(
    [askStep('q1', {}, { status: 'error', error: 'Question cancelled.' })],
    { getSkillDecision: decisions({}) },
  );
  assert.deepEqual(outcomes.map((o) => o.label), ['Question cancelled']);
});

test('live and dead pending questions produce no outcome', () => {
  const live = askStep('q1', {}, { status: 'running', result: null });
  assert.deepEqual(
    getTurnOutcomes([live], { pendingQuestions: { q1: { question: 'Which style?' } } }),
    [],
    'live request above the composer suppresses the entry',
  );
  assert.deepEqual(
    getTurnOutcomes([live], { getSkillDecision: decisions({}) }),
    [],
    'non-terminal step with no live request is a dead run, reported nowhere as answered',
  );
});

test('skill decisions report approval only for stored outcomes', () => {
  const steps = [skillStep('s1'), skillStep('s2'), skillStep('s3')];
  const outcomes = getTurnOutcomes(steps, {
    getSkillDecision: decisions({ s1: 'registered', s2: 'declined' }),
  });
  assert.deepEqual(
    outcomes.map((o) => o.label),
    [
      'Skill registration approved · render-generated-media-as-png',
      'Skill registration declined · render-generated-media-as-png',
    ],
  );
});

test('sequential interactions keep chronological order', () => {
  const outcomes = getTurnOutcomes(
    [
      askStep('q1', {}, { result: 'Line charts' }),
      skillStep('s1'),
      askStep('q2', {}, { result: 'Anything' }),
    ],
    { getSkillDecision: decisions({ s1: 'registered' }) },
  );
  assert.deepEqual(
    outcomes.map((o) => o.label),
    [
      'Question answered · Line charts',
      'Skill registration approved · render-generated-media-as-png',
      'Question answered · Custom response',
    ],
  );
});

test('unrelated tools and throwing decision readers are ignored safely', () => {
  const outcomes = getTurnOutcomes(
    [
      { id: 't1', type: 'tool_call', toolName: 'execute_command', status: 'complete', args: { command: 'ls' }, result: { exitCode: 0 } },
      { id: 't2', type: 'thought', content: 'hmm' },
      skillStep('s1'),
    ],
    { getSkillDecision: () => { throw new Error('storage unavailable'); } },
  );
  assert.deepEqual(outcomes, []);
});

test('long values are truncated without breaking the label', () => {
  const long = 'x'.repeat(500);
  const outcomes = getTurnOutcomes(
    [askStep('q1', { options: [long] }, { result: long })],
    { getSkillDecision: decisions({}) },
  );
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0].label.startsWith('Question answered · '));
  assert.ok(outcomes[0].label.length < 120);
});
