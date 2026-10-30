const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plan-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace);
const originalLoad = Module._load;
const ipcHandlers = new Map();
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      ipcMain: {
        handle: (channel, handler) => ipcHandlers.set(channel, handler),
        removeHandler: (channel) => ipcHandlers.delete(channel),
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showOpenDialogSync: () => undefined },
      shell: { openPath: async () => '' },
      nativeImage: { createFromPath: () => ({}) },
    };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const plan = require('../src/main/workspacePlan');
const { prepareChatMessages, rebuildChatMessages, getToolContext } = require('../src/main/promptBuilder');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, CAPABILITIES } = require('../src/main/toolPermissions');
const compression = require('../src/main/compressionEngine');

const project = projects.createProject({ name: 'Plan Project', root_path: workspace });
const MODEL = 'model';
const LIMIT = 2600;

function workspaceSession(id = crypto.randomUUID()) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function casualSession(id = crypto.randomUUID()) {
  sessions.getOrCreateSession(id, MODEL, null);
  return id;
}

function serializePrompt(prompt) {
  return prompt
    .map((message) => `${message.role}:${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
    .join('\n');
}

test('create persists a durable plan with stable, ordered step ids', () => {
  const id = workspaceSession();
  const result = plan.updatePlan(id, {
    action: 'create',
    objective: '  Ship   the parser ',
    steps: [
      { description: ' Inspect   the repo ' },
      { description: 'Implement', status: 'in_progress' },
      { description: 'Deploy', status: 'blocked', note: ' Wait  for credentials ' },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.action, 'create');
  assert.equal(result.plan.objective, 'Ship the parser');
  assert.equal(result.plan.revision, 1);
  assert.deepEqual(
    result.plan.steps.map((step) => [step.position, step.description, step.status, step.note]),
    [
      [1, 'Inspect the repo', 'pending', ''],
      [2, 'Implement', 'in_progress', ''],
      [3, 'Deploy', 'blocked', 'Wait for credentials'],
    ],
  );
  assert.ok(result.plan.steps.every((step) => Number.isSafeInteger(step.id) && step.id > 0));
  assert.equal(new Set(result.plan.steps.map((step) => step.id)).size, 3);
  assert.deepEqual(plan.getPlan(id), result.plan);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_plan_steps WHERE session_id = ?').get(id).n, 3);
  assert.equal(db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(id).revision, 1);

  // `get` is the documented resume path and returns the persisted plan.
  const fetched = plan.updatePlan(id, { action: 'get' });
  assert.equal(fetched.success, true);
  assert.equal(fetched.exists, true);
  assert.deepEqual(fetched.plan, result.plan);
});

test('incremental updates revise only the requested step fields and bump the revision', () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    steps: [{ description: 'A' }, { description: 'B' }, { description: 'C' }],
  }).plan;
  const [a, b, c] = created.steps;

  const result = plan.updatePlan(id, {
    action: 'update',
    expected_revision: created.revision,
    steps: [
      { id: a.id, status: 'completed' },
      { id: c.id, description: 'C revised', note: 'context retained' },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.revision, created.revision + 1);
  // Compact mutation result: only the two touched steps, in plan order.
  assert.deepEqual(result.changed_steps.map((step) => step.id), [a.id, c.id]);
  assert.deepEqual(result.changed_steps.map((step) => step.change), ['updated', 'updated']);
  assert.equal(result.changed_steps[0].status, 'completed');
  assert.equal(result.changed_steps[1].description, 'C revised');
  assert.equal(result.changed_steps[1].note, 'context retained');
  assert.deepEqual(result.progress, { total: 3, completed: 1, in_progress: 0, pending: 2, blocked: 0 });

  const after = plan.getPlan(id);
  const byId = new Map(after.steps.map((step) => [step.id, step]));
  assert.equal(byId.get(a.id).status, 'completed');
  assert.equal(byId.get(b.id).description, 'B');
  assert.equal(byId.get(b.id).status, 'pending');
  assert.equal(byId.get(c.id).description, 'C revised');
  assert.equal(byId.get(c.id).note, 'context retained');
  assert.deepEqual(after.steps.map((step) => step.id), [a.id, b.id, c.id]);
  assert.deepEqual(after.steps.map((step) => step.position), [1, 2, 3]);
});

test('invalid updates fail loudly and never partially mutate the plan', () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    steps: [{ description: 'A' }, { description: 'B' }],
  }).plan;
  const [a, b] = created.steps;
  const before = plan.getPlan(id);

  const cases = [
    [{ action: 'update', steps: [{ id: 999999, status: 'completed' }] }, 'UNKNOWN_STEP'],
    [{ action: 'update', steps: [{ id: a.id, status: 'done' }] }, 'INVALID_STATUS'],
    [{ action: 'update' }, 'EMPTY_UPDATE'],
    [{ action: 'update', steps: [{ id: a.id }] }, 'EMPTY_STEP_UPDATE'],
    [{ action: 'update', steps: [{ id: a.id, status: 'blocked' }] }, 'BLOCKED_NOTE_REQUIRED'],
    [{ action: 'update', steps: [{ status: 'pending' }] }, 'MISSING_FIELD'],
    [{ action: 'update', remove_step_ids: [999999] }, 'UNKNOWN_STEP'],
    [{ action: 'update', remove_step_ids: [a.id, a.id] }, 'DUPLICATE_STEP_ID'],
    [{ action: 'update', steps: [{ id: String(a.id), status: 'pending' }], remove_step_ids: [a.id] }, 'CONFLICTING_STEP'],
    [{ action: 'create', steps: [{ description: 'x' }] }, 'PLAN_EXISTS'],
    [{ action: 'create', steps: [{ id: 1, description: 'x' }] }, 'UNEXPECTED_STEP_ID'],
    [{ action: 'create', steps: [{ description: '   ' }] }, 'MISSING_FIELD'],
    [{ action: 'create', steps: [] }, 'INVALID_STEPS'],
    [{ action: 'create', steps: 'no' }, 'INVALID_STEPS'],
    [{ action: 'explode' }, 'INVALID_ACTION'],
    [{}, 'INVALID_ACTION'],
    [[], 'INVALID_ARGUMENTS'],
    [{ action: 'update', steps: [{ id: b.id, status: 'blocked', note: 'blocked!' }], expected_revision: 999 }, 'STALE_PLAN'],
  ];

  for (const [args, code] of cases) {
    const result = plan.updatePlan(id, args);
    assert.equal(result.success, false, JSON.stringify(args));
    assert.equal(result.code, code, JSON.stringify(args));
    assert.equal(typeof result.error, 'string', JSON.stringify(args));
    assert.ok(result.error.length > 0, JSON.stringify(args));
    assert.deepEqual(plan.getPlan(id), before, `plan changed after ${code}`);
  }

  // The plan still accepts a valid update after every rejected attempt.
  const recovered = plan.updatePlan(id, { action: 'update', steps: [{ id: a.id, status: 'completed' }] });
  assert.equal(recovered.success, true);
  assert.equal(recovered.revision, before.revision + 1);
});

test('step ids are task-scoped: one task cannot update another task by id', () => {
  const first = workspaceSession();
  const second = workspaceSession();
  const firstPlan = plan.updatePlan(first, {
    action: 'create',
    steps: [{ description: 'A1' }, { description: 'A2' }],
  }).plan;
  const secondPlan = plan.updatePlan(second, {
    action: 'create',
    steps: [{ description: 'B1' }, { description: 'B2' }],
  }).plan;
  const beforeFirst = plan.getPlan(first);
  const beforeSecond = plan.getPlan(second);

  const cross = plan.updatePlan(second, {
    action: 'update',
    steps: [{ id: firstPlan.steps[0].id, status: 'completed' }],
  });
  assert.equal(cross.success, false);
  assert.equal(cross.code, 'UNKNOWN_STEP');
  assert.deepEqual(plan.getPlan(first), beforeFirst);
  assert.deepEqual(plan.getPlan(second), beforeSecond);

  // The owning task still resolves its own id normally.
  const own = plan.updatePlan(first, {
    action: 'update',
    steps: [{ id: firstPlan.steps[0].id, status: 'completed' }],
  });
  assert.equal(own.success, true);
  assert.equal(plan.getPlan(first).steps[0].status, 'completed');
  assert.equal(plan.getPlan(second).steps[0].status, secondPlan.steps[0].status);
});

test('blocked then resumed keeps the explanation and reports the current status', () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    steps: [{ description: 'Deploy' }],
  }).plan;
  const stepId = created.steps[0].id;

  const blocked = plan.updatePlan(id, {
    action: 'update',
    steps: [{ id: stepId, status: 'blocked', note: 'Waiting for credentials' }],
  });
  assert.equal(blocked.success, true);
  assert.equal(blocked.changed_steps[0].status, 'blocked');
  assert.equal(blocked.changed_steps[0].note, 'Waiting for credentials');
  assert.deepEqual(blocked.progress, { total: 1, completed: 0, in_progress: 0, pending: 0, blocked: 1 });

  const resumed = plan.updatePlan(id, {
    action: 'update',
    steps: [{ id: stepId, status: 'in_progress' }],
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.changed_steps[0].status, 'in_progress');
  // The blocker note survives a status change and stays visible in the result.
  assert.equal(resumed.changed_steps[0].note, 'Waiting for credentials');
  assert.deepEqual(resumed.progress, { total: 1, completed: 0, in_progress: 1, pending: 0, blocked: 0 });

  const section = plan.buildPlanSection(id);
  assert.match(section.content, /\[in_progress\] \(id \d+\) Deploy — Waiting for credentials/);
  assert.match(section.content, /0 blocked/);
});

test('new steps append and removals compact positions without renumbering ids', () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    steps: [{ description: 'One' }, { description: 'Two' }, { description: 'Three' }],
  }).plan;
  const [one, two, three] = created.steps;

  const result = plan.updatePlan(id, {
    action: 'update',
    remove_step_ids: [two.id],
    steps: [{ description: 'Four' }, { id: three.id, description: 'Three revised' }],
  });
  assert.equal(result.success, true);

  // Only the revised and added steps are echoed, with stable ids and the new
  // positions they received after the removal compacted the list.
  const four = result.changed_steps.find((step) => step.description === 'Four');
  assert.ok(four);
  assert.equal(four.change, 'added');
  assert.deepEqual(result.changed_steps.map((step) => [step.id, step.position, step.change]), [
    [three.id, 2, 'updated'],
    [four.id, 3, 'added'],
  ]);
  assert.deepEqual(result.removed_step_ids, [two.id]);

  const after = plan.getPlan(id);
  assert.deepEqual(
    after.steps.map((step) => [step.id, step.position, step.description]),
    [
      [one.id, 1, 'One'],
      [three.id, 2, 'Three revised'],
      [four.id, 3, 'Four'],
    ],
  );
  assert.ok(!after.steps.some((step) => step.id === two.id));
});

test('the plan is injected as a bounded suffix and survives compaction unchanged', async () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    objective: 'Keep the plan',
    steps: [
      { description: 'Gather context', status: 'completed' },
      { description: 'Implement', status: 'in_progress' },
      { description: 'Deploy', status: 'blocked', note: 'Waiting for credentials' },
      { description: 'Polish', status: 'pending' },
    ],
  }).plan;
  sessions.saveMessage(id, 'user', 'Implement the feature.');
  for (let i = 0; i < 24; i++) {
    sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Turn${i} `.padEnd(400, 'x'));
  }

  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const planBlocks = prompt.filter((message) => message.workspacePlan === true);
  assert.equal(planBlocks.length, 1);
  assert.equal(prompt[prompt.length - 1].workspacePlan, true);
  assert.match(planBlocks[0].content, /\[completed\]/);
  assert.match(planBlocks[0].content, /\[in_progress\]/);
  assert.match(planBlocks[0].content, /\[blocked\]/);
  assert.match(planBlocks[0].content, /Waiting for credentials/);
  assert.match(planBlocks[0].content, /Keep the plan/);

  // The plan block is a pure suffix: removing it leaves an exact prefix.
  const full = serializePrompt(prompt);
  const withoutPlan = serializePrompt(prompt.filter((message) => message.workspacePlan !== true));
  assert.ok(full.startsWith(withoutPlan));
  assert.ok(full.length > withoutPlan.length);

  // The plan contributes to the context estimate but is not counted as messages.
  const usage = sessions.getContextUsage(id, MODEL);
  assert.ok(usage.planTokens > 0);
  assert.ok(usage.totalTokens >= usage.planTokens);

  const beforePlan = plan.getPlan(id);
  const beforeMessages = sessions.loadSession(id).messages.map((message) => ({
    id: message.id,
    content: message.content,
    archived: message.archived,
  }));

  const result = await require('./fixtures/w3Compaction.cjs').compact({ sessionId: id, modelId: MODEL });
  assert.equal(result.compressed, true);

  // Compaction never advances or completes a step, and never edits messages
  // beyond the archival flags it owns.
  assert.deepEqual(plan.getPlan(id), beforePlan);
  const afterMessages = sessions.loadSession(id).messages;
  assert.deepEqual(
    afterMessages.map((message) => ({ id: message.id, content: message.content })),
    beforeMessages.map(({ id: messageId, content }) => ({ id: messageId, content })),
  );

  const resumed = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const resumedBlocks = resumed.filter((message) => message.workspacePlan === true);
  assert.equal(resumedBlocks.length, 1);
  assert.equal(resumedBlocks[0].planRevision, beforePlan.revision);
  assert.match(resumedBlocks[0].content, /\[blocked\]/);
  assert.match(resumedBlocks[0].content, /Waiting for credentials/);
  assert.doesNotMatch(resumedBlocks[0].content, /Summary after compaction/);

  const prepared = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Continue.' });
  assert.equal(prepared.filter((message) => message.workspacePlan === true).length, 1);
});

test('the rendered plan is bounded while keeping unfinished steps and blocker notes', () => {
  const id = workspaceSession();
  const long = 'D'.repeat(490);
  const steps = [];
  for (let i = 0; i < 8; i++) steps.push({ description: `${long}C${i}`, status: 'completed' });
  for (let i = 0; i < 6; i++) steps.push({ description: `${long}P${i}` });
  for (let i = 0; i < 3; i++) steps.push({ description: `${long}I${i}`, status: 'in_progress' });
  for (let i = 0; i < 3; i++) {
    steps.push({ description: `${long}B${i}`, status: 'blocked', note: `Blocker ${i}` });
  }
  const created = plan.updatePlan(id, { action: 'create', steps });
  assert.equal(created.success, true);

  const section = plan.buildPlanSection(id);
  assert.ok(section.content.length <= plan.PLAN_CHAR_CAP, `${section.content.length} > ${plan.PLAN_CHAR_CAP}`);
  assert.ok(section.content.endsWith(plan.PLAN_END));
  assert.match(section.content, /Omitted for budget: \d+ completed step\(s\)\./);
  assert.doesNotMatch(section.content, /\[completed\]/);
  for (const step of created.plan.steps.filter((item) => item.status !== 'completed')) {
    assert.match(section.content, new RegExp(`\\(id ${step.id}\\)`), `missing step ${step.id}`);
  }
  for (let i = 0; i < 3; i++) {
    assert.match(section.content, new RegExp(`Blocker ${i}`), `missing blocker ${i}`);
  }
  // Completed work stays distinguishable through the progress summary.
  assert.match(section.content, /8\/20 completed/);
});

test('plan writes never touch canonical messages or permanent memory', () => {
  const id = workspaceSession();
  sessions.saveMessage(id, 'user', 'Do the task.');
  sessions.saveMessage(id, 'assistant', 'Working.');
  const messagesBefore = sessions.loadSession(id).messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
  }));
  const memoriesBefore = db.prepare('SELECT COUNT(*) AS n FROM permanent_memories').get().n;

  const created = plan.updatePlan(id, { action: 'create', steps: [{ description: 'A' }] }).plan;
  plan.updatePlan(id, {
    action: 'update',
    steps: [{ id: created.steps[0].id, status: 'in_progress' }],
  });

  assert.deepEqual(
    sessions.loadSession(id).messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    messagesBefore,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM permanent_memories').get().n, memoriesBefore);
});

test('update_plan is a workspace-only PLAN_WRITE tool and runs through the dispatcher', async () => {
  const id = workspaceSession();
  const casual = casualSession();
  assert.ok(agentTools.some((tool) => tool.function.name === 'update_plan'));
  assert.ok(agentTools.some((tool) => tool.function.name === 'run_tests'));
  assert.equal(capabilityOf('update_plan'), CAPABILITIES.PLAN_WRITE);
  assert.equal(capabilityOf('run_tests'), CAPABILITIES.LOCAL_EXECUTION);

  assert.equal(isToolVisible('update_plan', { permissionMode: 'workspace_write', project }), true);
  assert.equal(isToolVisible('update_plan', { permissionMode: 'ask_approval', project }), true);
  assert.equal(isToolVisible('update_plan', { permissionMode: 'read_only', project }), false);
  assert.equal(isToolVisible('update_plan', { permissionMode: 'ask_approval', project: null }), false);

  const workspaceTools = getToolContext([], true, id, 'workspace_write').tools.map((tool) => tool.function.name);
  assert.ok(workspaceTools.includes('update_plan'));
  const casualTools = getToolContext([], true, casual, 'ask_approval').tools.map((tool) => tool.function.name);
  assert.ok(!casualTools.includes('update_plan'));

  const created = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'create', steps: [{ description: 'Via tool' }] }),
    sessionId: id,
    permissionMode: 'workspace_write',
  });
  assert.equal(created.success, true);
  assert.equal(created.plan.steps[0].description, 'Via tool');

  const updated = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({
      action: 'update',
      steps: [{ id: created.plan.steps[0].id, status: 'in_progress' }],
    }),
    sessionId: id,
    permissionMode: 'workspace_write',
  });
  assert.equal(updated.success, true);
  assert.equal(updated.changed_steps[0].status, 'in_progress');
  assert.equal(updated.revision, 2);
  assert.equal(updated.progress.total, 1);

  const readOnly = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'get' }),
    sessionId: id,
    permissionMode: 'read_only',
  });
  assert.equal(readOnly.success, false);
  assert.match(readOnly.error, /Read Only/);

  const inCasual = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'get' }),
    sessionId: casual,
    permissionMode: 'ask_approval',
  });
  assert.equal(inCasual.success, false);
  assert.match(inCasual.error, /project workspace/i);

  const casualFull = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'get' }),
    sessionId: casual,
    permissionMode: 'full_access',
  });
  assert.equal(casualFull.success, false);
  assert.match(casualFull.error, /project workspace/i);

  const malformed = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({
      action: 'update',
      steps: [{ id: created.plan.steps[0].id, status: 'bogus' }],
    }),
    sessionId: id,
    permissionMode: 'workspace_write',
  });
  assert.equal(malformed.success, false);
  assert.equal(malformed.code, 'INVALID_STATUS');
  assert.equal(plan.getPlan(id).steps[0].status, 'in_progress');
});

test('the update_plan schema tells the model exactly what to pass', () => {
  const tool = agentTools.find((t) => t.function.name === 'update_plan').function;
  const text = tool.description;
  // The two failures a weaker model hit: an id on create, and a second create
  // once a plan already exists. The schema must name both and the recovery.
  assert.match(text, /NEVER include "id" in a step when creating/);
  assert.match(text, /UNEXPECTED_STEP_ID/);
  assert.match(text, /PLAN_EXISTS/);
  assert.match(text, /action "update"/);
  assert.match(text, /action "get"/);
  // Concrete, copyable call shapes for both write actions.
  assert.match(text, /\{"action":"create"/);
  assert.match(text, /\{"action":"update"/);
  // The per-field hints repeat the rules where the model actually fills them.
  const step = tool.parameters.properties.steps.items.properties;
  assert.match(step.id.description, /NEVER include "id" when action is "create"/);
  assert.match(tool.parameters.properties.steps.description, /no "id"/);
  assert.match(step.description.description, /required on create/i);
  assert.match(step.note.description, /required when status is blocked/i);
});

test('casual sessions have no plan and the tool refuses with a clear error', () => {
  const id = casualSession();
  assert.equal(plan.getPlan(id), null);
  assert.equal(plan.buildPlanSection(id), null);
  const result = plan.updatePlan(id, { action: 'create', steps: [{ description: 'Nope' }] });
  assert.equal(result.success, false);
  assert.equal(result.code, 'PLAN_REQUIRES_WORKSPACE');
  assert.equal(db.prepare('SELECT 1 FROM workspace_plans WHERE session_id = ?').get(id), undefined);
  // More permissive modes do not invent a workspace: a casual chat stays casual.
  assert.equal(isToolVisible('update_plan', { permissionMode: 'full_access', project: null }), false);
});

test('deleting a session cascades its plan; branching does not copy it', () => {
  const source = workspaceSession();
  const created = plan.updatePlan(source, {
    action: 'create',
    steps: [{ description: 'Keep' }],
  }).plan;
  const message = sessions.saveMessage(source, 'user', 'Branch here.');
  const branched = sessions.branchChat(source, message.id).sessionId;

  assert.ok(sessions.loadSession(branched));
  assert.equal(plan.getPlan(branched), null);
  assert.equal(plan.getPlan(source).steps[0].id, created.steps[0].id);

  sessions.deleteSession(source);
  assert.equal(db.prepare('SELECT 1 FROM workspace_plans WHERE session_id = ?').get(source), undefined);
  assert.equal(db.prepare('SELECT 1 FROM workspace_plan_steps WHERE session_id = ?').get(source), undefined);
  assert.equal(plan.getPlan(branched), null);
});

test('the main-process plan IPC reads state and pushes durable updates', async () => {
  const { EventEmitter } = require('node:events');
  const { registerIpcHandlers } = require('../src/main/ipcHandlers');
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => null });
  try {
    const id = workspaceSession();
    const sent = [];
    const sender = Object.assign(new EventEmitter(), {
      send: (channel, payload) => sent.push({ channel, payload }),
      isDestroyed: () => false,
    });
    const event = { sender };
    const invoke = (channel, payload) => ipcHandlers.get(channel)(event, payload);

    const created = await invoke('agent:execute-tool', {
      requestId: 'plan-ipc',
      sessionId: id,
      name: 'update_plan',
      arguments: JSON.stringify({ action: 'create', steps: [{ description: 'IPC step' }] }),
      permissionMode: 'workspace_write',
    });
    assert.equal(created.success, true);
    const updateEvent = sent.find((entry) => entry.channel === 'session:plan-updated');
    assert.ok(updateEvent);
    assert.equal(updateEvent.payload.sessionId, id);
    assert.equal(updateEvent.payload.plan.steps[0].description, 'IPC step');

    const read = await invoke('session:get-plan', { sessionId: id });
    assert.equal(read.steps[0].description, 'IPC step');
    const casual = casualSession();
    assert.equal(await invoke('session:get-plan', { sessionId: casual }), null);

    // A failed update sends no event, so the card keeps the last durable plan.
    sent.length = 0;
    const failed = await invoke('agent:execute-tool', {
      requestId: 'plan-ipc-2',
      sessionId: id,
      name: 'update_plan',
      arguments: JSON.stringify({
        action: 'update',
        steps: [{ id: created.plan.steps[0].id, status: 'bogus' }],
      }),
      permissionMode: 'workspace_write',
    });
    assert.equal(failed.success, false);
    assert.equal(sent.filter((entry) => entry.channel === 'session:plan-updated').length, 0);
    assert.equal(plan.getPlan(id).steps[0].status, 'pending');
  } finally {
    dispose();
  }
});

test('the plan survives restart, and a failed write is reported as not saved', () => {
  const id = workspaceSession();
  const created = plan.updatePlan(id, {
    action: 'create',
    objective: 'Restart',
    steps: [{ description: 'A' }, { description: 'B', status: 'in_progress' }],
  }).plan;
  const firstId = created.steps[0].id;
  const before = plan.getPlan(id);

  // Real mid-transaction failure: the trigger aborts the step UPDATE, so the
  // whole plan transaction must roll back and report a persistence error.
  db.prepare(`CREATE TRIGGER plan_fail_test BEFORE UPDATE ON workspace_plan_steps
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`).run();
  try {
    const failed = plan.updatePlan(id, {
      action: 'update',
      steps: [{ id: firstId, status: 'completed' }],
    });
    assert.equal(failed.success, false);
    assert.equal(failed.code, 'PLAN_PERSISTENCE_FAILED');
    assert.match(failed.error, /not saved/i);
    assert.match(failed.error, /simulated disk failure/);
  } finally {
    db.prepare('DROP TRIGGER plan_fail_test').run();
  }
  assert.deepEqual(plan.getPlan(id), before);

  // Restart restores the same durable plan and injects it into the prompt.
  const messagesBefore = sessions.loadSession(id).messages.length;
  closeDatabase();
  initDatabase();
  const restored = plan.getPlan(id);
  assert.deepEqual(restored, before);
  assert.equal(restored.steps[1].status, 'in_progress');
  const block = rebuildChatMessages({ sessionId: id, modelId: MODEL })
    .find((message) => message.workspacePlan === true);
  assert.ok(block);
  assert.equal(block.planRevision, before.revision);
  assert.match(block.content, /Objective: Restart/);
  assert.equal(sessions.loadSession(id).messages.length, messagesBefore);
});

test('R4 consecutive tasks preserve revision history, reject stale and explicit unfinished replacement', () => {
 const id = workspaceSession();
 assert.equal(plan.planState(id).exists, false);
 assert.match(plan.buildPlanStateSection(id).content, /action="create"/);
 const first = plan.updatePlan(id, { action: 'create', objective: 'first', steps: [1,2,3].map(n => ({ description: `step ${n}`, status: 'completed' })) }).plan;
 const duplicate = plan.updatePlan(id, { action: 'create', steps: [{ description: 'wrong' }] });
 assert.equal(duplicate.code, 'PLAN_EXISTS'); assert.equal(duplicate.existing_plan.revision, 1);
 assert.equal(plan.planState(id).fully_completed, true);
 const next = plan.updatePlan(id, { action: 'update', transition: 'new_task', expected_revision: 1, objective: 'second', steps: [{ description: 'new work' }] });
 assert.equal(next.success, true); assert.equal(next.revision, 2); assert.equal(plan.getPlan(id).steps[0].status, 'pending');
 const historic = JSON.parse(db.prepare('SELECT snapshot FROM workspace_plan_history WHERE session_id=? AND revision=1').get(id).snapshot);
 assert.deepEqual(historic, first);
 const blocked = plan.updatePlan(id, { action: 'update', transition: 'new_task', expected_revision: 2, objective: 'third', steps: [{ description: 'distinct' }] });
 assert.equal(blocked.code, 'UNFINISHED_PLAN'); assert.equal(plan.getPlan(id).revision, 2);
 const superseded = plan.updatePlan(id, { action: 'update', transition: 'supersede', expected_revision: 2, objective: 'third', steps: [{ description: 'distinct' }] });
 assert.equal(superseded.revision, 3);
 assert.equal(plan.updatePlan(id, { action: 'update', expected_revision: 2, objective: 'stale' }).code, 'STALE_PLAN');
 const other = workspaceSession(); plan.updatePlan(other, { action: 'create', steps: [{ description: 'private' }] });
 assert.equal(plan.updatePlan(other, { action: 'update', steps: [{ id: first.steps[0].id, status: 'pending' }] }).code, 'UNKNOWN_STEP');
 for (const rebuild of [prepareChatMessages, rebuildChatMessages]) {
  const messages = rebuild({ sessionId: id, modelId: MODEL, userText: 'a distinct task' });
  const state = messages.find(m => m.workspacePlanState);
  assert.match(state.content, /Revision: 3/); assert.ok(state.content.length < 1300);
 }
 const archived = JSON.parse(db.prepare('SELECT snapshot FROM workspace_plan_history WHERE session_id=? AND revision=2').get(id).snapshot);
 assert.equal(archived.objective, 'second'); assert.equal(archived.steps[0].status, 'pending');
});

test('R4 directory root aliases retain containment', async () => {
 const id = workspaceSession();
 const results = [];
 for (const args of [{}, { relative_path: '' }, { relative_path: '.' }]) results.push(await executeAgentTool({ name: 'list_directory', arguments: JSON.stringify(args), sessionId: id, permissionMode: 'workspace_write' }));
 assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]); assert.ok(Array.isArray(results[0].entries));
 const escape = await executeAgentTool({ name: 'list_directory', arguments: JSON.stringify({ relative_path: '\0' }), sessionId: id, permissionMode: 'workspace_write' });
 assert.equal(escape.success, false);
});

test('R4 deterministic model loop refreshes plans across three tasks and preserves failed verification', async () => {
 const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
 const { structureVerification } = require('../src/main/tools/agentTools');
 const id = workspaceSession();
 const response = delta => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
 const requests = [];
 async function turn(objective, transition) {
  let round = 0;
  const expected = plan.getPlan(id)?.revision;
  const args = expected ? { action: 'update', expected_revision: expected, ...(transition ? { transition } : {}), objective, steps: [{ description: objective }] } : { action: 'create', objective, steps: [1,2,3].map(n => ({ description: `${objective} ${n}` })) };
  await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: MODEL, messages: [{ role: 'system', content: 'Fixture rules' }, { role: 'user', content: objective }],
   chatTools: agentTools.filter(t => ['update_plan', 'run_tests'].includes(t.function.name)), memoryTools: [],
   getSessionPlanState: () => plan.buildPlanStateSection(id),
   executeTool: async call => {
    if (call.name === 'run_tests') return structureVerification({ command: 'node --test fail.cjs | tail -5' }, { exitCode: 0, stdout: '1..1\nnot ok 1 - broken\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n' }, null, 1000, '.');
    const result = await executeAgentTool({ name: call.name, arguments: call.arguments, sessionId: id, permissionMode: 'workspace_write' });
    assert.equal(result.success, true, JSON.stringify(result)); return result;
   },
   fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body); requests.push(payload);
    const text = JSON.stringify(payload.messages);
    if (round++ === 0) {
     assert.ok(text.includes(expected ? `revision\\\":${expected}` : 'No plan exists'));
     return response({ tool_calls: [{ index: 0, id: 'plan', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify(args) } }] });
    }
    assert.ok(text.includes(`revision\\\":${plan.getPlan(id).revision}`));
    if (round === 2) return response({ tool_calls: [{ index: 0, id: 'verify', type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ command: 'fixture' }) } }] });
    assert.match(text, /failed/); assert.doesNotMatch(text, /Verification passed/);
    return response({ content: 'Verification failed; reported accurately.' });
   },
  });
 }
 await turn('first');
 const current = plan.getPlan(id);
 plan.updatePlan(id, { action: 'update', expected_revision: current.revision, steps: current.steps.map(s => ({ id: s.id, status: 'completed' })) });
 await turn('second', 'new_task');
 await turn('revised second');
 assert.equal(plan.getPlan(id).objective, 'revised second');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_plan_history WHERE session_id=?').get(id).n, 3);
 assert.equal(requests.length, 9);
 const steps = [{ id: 'r4-check', type: 'tool_call', toolName: 'run_tests', status: 'complete', args: { command: 'node --test x | tail -1' }, result: { success: false, status: 'inconclusive', exitCode: 0, stdout: '# pass 1' } }];
 assert.equal(require('../src/main/taskCheckpoints').classifyStepOutcome(steps[0]), 'failed');
 const digest = require('../src/main/turnDigest').buildTurnDigest(steps, { turnSeq: 1 });
 assert.doesNotMatch(digest.text, /tests passed/);
 assert.match(digest.text, /inconclusive|failed/);
});

test('R4 memory worker searches without Electron and reports missing databases explicitly', async () => {
 const { Worker } = require('node:worker_threads');
 db.prepare("INSERT INTO permanent_memories(category,content,scope) VALUES ('rule','r4 worker sentinel','global')").run();
 const databasePath = require('../src/main/db').getDatabasePath();
 async function search(file, request) {
  const worker = new Worker(path.resolve(__dirname, '../src/main/memorySearchWorker.js'), { workerData: { databasePath: file, request } });
  try { return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); }
  finally { await worker.terminate(); }
 }
 const found = await search(databasePath, { query: 'r4 worker sentinel', modelId: MODEL, target: 'all' });
 assert.equal(found.error, undefined); assert.match(found.result, /worker sentinel/);
 const missing = await search(path.join(directory, 'missing.db'), { query: 'sentinel', modelId: MODEL });
 assert.match(missing.error, /exist|open/i);
});

test('R4 deletion invalidates live plan guidance and cascades archived history', () => {
 const id = workspaceSession();
 plan.updatePlan(id, { action: 'create', steps: [{ description: 'old', status: 'completed' }] });
 plan.updatePlan(id, { action: 'update', expected_revision: 1, transition: 'new_task', objective: 'new', steps: [{ description: 'new' }] });
 assert.equal(plan.planState(id).revision, 2);
 db.prepare('DELETE FROM sessions WHERE id=?').run(id);
 assert.equal(plan.buildPlanStateSection(id), null);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_plan_history WHERE session_id=?').get(id).n, 0);
 assert.equal(plan.updatePlan(id, { action: 'update', objective: 'stale' }).success, false);
});

for (const mode of ['partial', 'degraded']) test(`R4 ${mode} checkpoint rebuild refreshes durable plan identity`, () => {
 const id = workspaceSession();
 plan.updatePlan(id, { action: 'create', objective: 'current objective', steps: [{ description: 'current work', status: 'completed' }] });
 sessions.saveMessage(id, 'user', 'Start a separate task.');
 const projection = { archiveIds: [], checkpoint: { savedWorkingState: `${mode} checkpoint: historical objective`, status: mode, limitations: [mode] } };
 const messages = rebuildChatMessages({ sessionId: id, modelId: MODEL, compactionProjection: projection });
 const state = messages.find(m => m.workspacePlanState);
 assert.match(state.content, new RegExp(`Plan ID: ${id}`)); assert.match(state.content, /fully completed: true/);
 plan.updatePlan(id, { action: 'update', transition: 'new_task', expected_revision: 1, objective: 'separate objective', steps: [{ description: 'fresh work' }] });
 const resumed = rebuildChatMessages({ sessionId: id, modelId: MODEL, compactionProjection: projection });
 assert.match(resumed.find(m => m.workspacePlanState).content, /Revision: 2/);
 assert.match(resumed.find(m => m.workspacePlanState).content, /separate objective/);
});
