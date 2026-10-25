'use strict';

// Phase 2.0E — compact plan mutation results.
//
// These tests exercise the real tool-dispatch path (schema validation,
// permission guard, workspacePlan persistence) and assert that plan updates
// return only the touched steps plus authoritative progress, while creation,
// explicit retrieval, cross-session reads, persistence, compaction, the
// Activity-tab push, and concurrent sessions keep their complete behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-plan-'));
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
const workLog = require('../src/main/workLog');
const { buildTurnDigest } = require('../src/main/turnDigest');
const compression = require('../src/main/compressionEngine');
const { rebuildChatMessages } = require('../src/main/promptBuilder');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const MODEL = 'model';
let projectSeq = 0;

function newProject(name) {
  const root = path.join(directory, `ws-${projectSeq++}`);
  fs.mkdirSync(root, { recursive: true });
  return projects.createProject({ name, root_path: root });
}

function workspaceSession(projectId, id = crypto.randomUUID()) {
  sessions.getOrCreateSession(id, MODEL, projectId);
  return id;
}

function tool(sessionId, args, permissionMode = 'workspace_write') {
  return executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify(args),
    sessionId,
    permissionMode,
  });
}

function readTool(sessionId, args, permissionMode = 'read_only') {
  return executeAgentTool({
    name: 'get_project_plans',
    arguments: JSON.stringify(args),
    sessionId,
    permissionMode,
  });
}

function create(sessionId, steps, objective = 'Objective') {
  return tool(sessionId, { action: 'create', objective, steps });
}

function stepDescriptions(steps) {
  return steps.map((step) => step.description);
}

test('single-step status update returns only the touched step and authoritative progress', async () => {
  const project = newProject('single-status');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'UNCHANGED_ALPHA pending' },
    { description: 'UNCHANGED_BETA pending' },
    { description: 'TOUCHED_GAMMA pending' },
  ]);
  const target = created.plan.steps[2];

  const result = await tool(id, {
    action: 'update',
    expected_revision: created.plan.revision,
    steps: [{ id: target.id, status: 'completed' }],
  });

  assert.equal(result.success, true);
  assert.equal(result.action, 'update');
  assert.equal(result.exists, true);
  assert.equal(result.plan_id, id);
  assert.equal(result.revision, created.plan.revision + 1);
  assert.equal(Object.hasOwn(result, 'plan'), false);
  assert.equal(result.changed_steps.length, 1);
  assert.deepEqual(
    {
      id: result.changed_steps[0].id,
      position: result.changed_steps[0].position,
      description: result.changed_steps[0].description,
      status: result.changed_steps[0].status,
      note: result.changed_steps[0].note,
      change: result.changed_steps[0].change,
    },
    {
      id: target.id,
      position: 3,
      description: 'TOUCHED_GAMMA pending',
      status: 'completed',
      note: '',
      change: 'updated',
    },
  );
  assert.deepEqual(result.progress, {
    total: 3,
    completed: 1,
    in_progress: 0,
    pending: 2,
    blocked: 0,
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /UNCHANGED_ALPHA|UNCHANGED_BETA/);
});

test('single-step blocker update preserves the blocker note and status', async () => {
  const project = newProject('single-blocker');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'Deploy service' },
    { description: 'Unrelated pending work' },
  ]);
  const target = created.plan.steps[0];

  const result = await tool(id, {
    action: 'update',
    steps: [{ id: target.id, status: 'blocked', note: 'Waiting for credentials' }],
  });

  assert.equal(result.success, true);
  assert.equal(result.changed_steps.length, 1);
  assert.equal(result.changed_steps[0].status, 'blocked');
  assert.equal(result.changed_steps[0].note, 'Waiting for credentials');
  assert.deepEqual(result.progress, {
    total: 2,
    completed: 0,
    in_progress: 0,
    pending: 1,
    blocked: 1,
  });
});

test('multi-step updates report every affected step once, in plan order', async () => {
  const project = newProject('multi');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'UNTOUCHED_ONE' },
    { description: 'TOUCHED_TWO' },
    { description: 'TOUCHED_THREE' },
    { description: 'UNTOUCHED_FOUR' },
  ]);
  const [one, two, three, four] = created.plan.steps;

  // Request order is reversed; the result must follow plan order.
  const result = await tool(id, {
    action: 'update',
    steps: [
      { id: three.id, status: 'completed' },
      { id: two.id, description: 'TOUCHED_TWO revised', note: 'context added' },
      { description: 'ADDED_FIVE' },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.changed_steps.length, 3);
  assert.deepEqual(result.changed_steps.map((step) => [step.id, step.change]), [
    [two.id, 'updated'],
    [three.id, 'updated'],
    [result.changed_steps[2].id, 'added'],
  ]);
  assert.deepEqual(
    result.changed_steps.map((step) => [step.position, step.description, step.status, step.note]),
    [
      [2, 'TOUCHED_TWO revised', 'pending', 'context added'],
      [3, 'TOUCHED_THREE', 'completed', ''],
      [5, 'ADDED_FIVE', 'pending', ''],
    ],
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /UNTOUCHED_ONE|UNTOUCHED_FOUR/);
  assert.ok(!stepDescriptions(result.changed_steps).includes(one.description));
  assert.ok(!stepDescriptions(result.changed_steps).includes(four.description));
  assert.deepEqual(result.progress, {
    total: 5,
    completed: 1,
    in_progress: 0,
    pending: 4,
    blocked: 0,
  });
});

test('creation still returns the complete initial plan with stable ids', async () => {
  const project = newProject('create');
  const id = workspaceSession(project.id);
  const result = await create(id, [
    { description: 'First' },
    { description: 'Second', status: 'in_progress' },
    { description: 'Third', status: 'blocked', note: 'needs key' },
  ], 'Create objective');

  assert.deepEqual(Object.keys(result), ['success', 'action', 'exists', 'plan']);
  assert.equal(result.action, 'create');
  assert.equal(result.plan.objective, 'Create objective');
  assert.equal(result.plan.revision, 1);
  assert.deepEqual(
    result.plan.steps.map((step) => [step.position, step.description, step.status, step.note]),
    [
      [1, 'First', 'pending', ''],
      [2, 'Second', 'in_progress', ''],
      [3, 'Third', 'blocked', 'needs key'],
    ],
  );
  assert.ok(result.plan.steps.every((step) => Number.isSafeInteger(step.id) && step.id > 0));
  assert.equal(new Set(result.plan.steps.map((step) => step.id)).size, 3);
  assert.ok(result.plan.createdAt && result.plan.updatedAt);
});

test('current-session get still returns the complete plan, ordered steps, notes, and revision', async () => {
  const project = newProject('get');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'Gather context', status: 'completed' },
    { description: 'Implement', status: 'in_progress' },
    { description: 'Deploy', status: 'blocked', note: 'Waiting for credentials' },
    { description: 'Polish' },
  ], 'Full read objective');

  const fetched = await tool(id, { action: 'get' });
  assert.equal(fetched.success, true);
  assert.equal(fetched.action, 'get');
  assert.equal(fetched.exists, true);
  assert.deepEqual(Object.keys(fetched.plan), [
    'objective', 'revision', 'createdAt', 'updatedAt', 'steps',
  ]);
  assert.equal(fetched.plan.objective, 'Full read objective');
  assert.equal(fetched.plan.revision, created.plan.revision);
  assert.deepEqual(fetched.plan.steps.map((step) => step.position), [1, 2, 3, 4]);
  assert.deepEqual(fetched.plan.steps.map((step) => step.id), created.plan.steps.map((step) => step.id));
  assert.equal(fetched.plan.steps[2].status, 'blocked');
  assert.equal(fetched.plan.steps[2].note, 'Waiting for credentials');
  assert.equal(fetched.plan.steps[0].createdAt, created.plan.steps[0].createdAt);
  assert.equal(fetched.plan.updatedAt, created.plan.updatedAt);
});

test('cross-session plan retrieval still returns the full historical plan read-only', async () => {
  const project = newProject('cross-read');
  const owner = workspaceSession(project.id);
  const reader = workspaceSession(project.id);
  const created = await create(owner, [
    { description: 'Owner step one', status: 'completed' },
    { description: 'Owner step two', status: 'blocked', note: 'owner blocker' },
  ], 'Owner objective');
  await tool(owner, {
    action: 'update',
    steps: [{ description: 'Owner step three' }],
  });

  const beforeOwner = {
    plan: db.prepare('SELECT * FROM workspace_plans WHERE session_id = ?').get(owner),
    steps: db.prepare('SELECT * FROM workspace_plan_steps WHERE session_id = ? ORDER BY position').all(owner),
  };

  const listed = await readTool(reader, { action: 'list' });
  assert.equal(listed.success, true);
  const row = listed.plans.find((item) => item.plan_id === owner);
  assert.equal(row.objective, 'Owner objective');
  assert.equal(row.total_steps, 3);
  assert.equal(row.completed_steps, 1);
  assert.equal(row.blocked_steps, 1);
  assert.equal(Object.hasOwn(row, 'steps'), false);

  const detail = await readTool(reader, { action: 'get', plan_id: owner });
  assert.equal(detail.exists, true);
  assert.equal(detail.owner.session_id, owner);
  assert.equal(detail.plan.plan_id, owner);
  assert.deepEqual(detail.plan.steps.map((step) => step.description), [
    'Owner step one', 'Owner step two', 'Owner step three',
  ]);
  assert.equal(detail.plan.steps[1].note, 'owner blocker');
  assert.equal(detail.plan.revision, created.plan.revision + 1);

  // Reading never mutates the target plan (including its revision).
  const afterOwner = {
    plan: db.prepare('SELECT * FROM workspace_plans WHERE session_id = ?').get(owner),
    steps: db.prepare('SELECT * FROM workspace_plan_steps WHERE session_id = ? ORDER BY position').all(owner),
  };
  assert.deepEqual(afterOwner, beforeOwner);
  assert.equal((await tool(reader, { action: 'get' })).exists, false);
});

test('cross-project plans remain invisible to listings, reads, and plan ids', async () => {
  const projectA = newProject('isolation-a');
  const projectB = newProject('isolation-b');
  const a = workspaceSession(projectA.id);
  const b = workspaceSession(projectB.id);
  await create(a, [{ description: 'PROJECT_A_SECRET_STEP' }], 'Project A secret');
  await create(b, [{ description: 'PROJECT_B_STEP' }], 'Project B');

  const listA = await readTool(a, { action: 'list' });
  assert.equal(listA.total, 1);
  assert.doesNotMatch(JSON.stringify(listA), /PROJECT_B_STEP/);

  const cross = await readTool(b, { action: 'get', plan_id: a });
  assert.equal(cross.success, true);
  assert.equal(cross.exists, false);
  assert.equal(cross.plan, null);
  assert.doesNotMatch(JSON.stringify(cross), /PROJECT_A_SECRET_STEP|Project A secret/);
});

test('completed plans report complete progress and stay complete across retrieval', async () => {
  const project = newProject('completed');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'One' },
    { description: 'Two' },
    { description: 'Three' },
  ]);
  const result = await tool(id, {
    action: 'update',
    steps: created.plan.steps.map((step) => ({ id: step.id, status: 'completed' })),
  });
  assert.deepEqual(result.progress, {
    total: 3,
    completed: 3,
    in_progress: 0,
    pending: 0,
    blocked: 0,
  });
  const fetched = await tool(id, { action: 'get' });
  assert.ok(fetched.plan.steps.every((step) => step.status === 'completed'));
  const listed = await readTool(id, { action: 'list' });
  assert.equal(listed.plans.find((row) => row.plan_id === id).status, 'completed');
});

test('plans with blocked steps keep blocker notes discoverable after compact updates', async () => {
  const project = newProject('blocked');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'Deploy', status: 'blocked', note: 'Waiting for credentials' },
    { description: 'Write docs' },
  ]);
  const resumed = await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[1].id, status: 'in_progress' }],
  });
  assert.equal(resumed.progress.blocked, 1);
  const fetched = await tool(id, { action: 'get' });
  assert.equal(fetched.plan.steps[0].status, 'blocked');
  assert.equal(fetched.plan.steps[0].note, 'Waiting for credentials');
});

test('revision increments once per committed mutation and matches SQLite exactly', async () => {
  const project = newProject('revision');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  assert.equal(created.plan.revision, 1);
  assert.equal(db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(id).revision, 1);

  const first = await tool(id, { action: 'update', steps: [{ id: created.plan.steps[0].id, status: 'in_progress' }] });
  assert.equal(first.revision, 2);
  assert.equal(db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(id).revision, 2);

  const second = await tool(id, { action: 'update', objective: 'New objective' });
  assert.equal(second.success, true);
  assert.equal(second.revision, 3);
  assert.equal(second.changed_steps.length, 0);
  assert.equal(second.objective, 'New objective');
  assert.equal(db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(id).revision, 3);
});

test('stale revisions are rejected without changing the plan or reporting success', async () => {
  const project = newProject('stale');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  const before = plan.getPlan(id);
  const first = await tool(id, {
    action: 'update',
    expected_revision: created.plan.revision,
    steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
  });
  assert.equal(first.success, true);

  const stale = await tool(id, {
    action: 'update',
    expected_revision: created.plan.revision,
    steps: [{ id: created.plan.steps[1].id, status: 'completed' }],
  });
  assert.equal(stale.success, false);
  assert.equal(stale.code, 'STALE_PLAN');
  assert.equal(stale.revision, undefined);
  assert.equal(plan.getPlan(id).revision, before.revision + 1);
  assert.equal(plan.getPlan(id).steps[1].status, 'pending');
});

test('failed mutations return explicit errors and leave persisted state byte-identical', async () => {
  const project = newProject('fail');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  const before = plan.getPlan(id);
  const cases = [
    [{ action: 'update', steps: [{ id: 99999999, status: 'completed' }] }, 'UNKNOWN_STEP'],
    [{ action: 'update' }, 'EMPTY_UPDATE'],
    [{ action: 'update', steps: [{ id: created.plan.steps[0].id, status: 'blocked' }] }, 'BLOCKED_NOTE_REQUIRED'],
  ];
  for (const [args, code] of cases) {
    const result = await tool(id, args);
    assert.equal(result.success, false, code);
    assert.equal(result.code, code);
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(plan.getPlan(id), before, code);
  }
});

test('a cancelled mutation reports failure and never commits a partial update', async () => {
  const project = newProject('cancelled');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  const before = plan.getPlan(id);
  const controller = new AbortController();
  controller.abort();
  const result = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({
      action: 'update',
      steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
    }),
    sessionId: id,
    permissionMode: 'workspace_write',
    signal: controller.signal,
  });
  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(plan.getPlan(id), before);
});

test('compact results are derived from committed SQLite rows', async () => {
  const project = newProject('persistence');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  const result = await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[0].id, status: 'blocked', note: 'persisted blocker' }],
  });
  const row = db.prepare('SELECT id, position, description, status, note FROM workspace_plan_steps WHERE id = ?')
    .get(created.plan.steps[0].id);
  assert.deepEqual({ ...result.changed_steps[0] }, {
    id: row.id,
    position: row.position,
    description: row.description,
    status: row.status,
    note: row.note,
    change: 'updated',
  });
  assert.equal(row.note, 'persisted blocker');
  const stored = db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(id);
  assert.equal(result.revision, stored.revision);
});

test('the latest compact revision and full plan survive an app/database restart', async () => {
  const project = newProject('restart');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B', status: 'in_progress' }]);
  const updated = await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
  });
  const before = plan.getPlan(id);

  closeDatabase();
  initDatabase();

  const restored = plan.getPlan(id);
  assert.deepEqual(restored, before);
  assert.equal(restored.revision, updated.revision);
  const fetched = await tool(id, { action: 'get' });
  assert.equal(fetched.plan.revision, updated.revision);
  assert.equal(fetched.plan.steps[0].status, 'completed');
  assert.equal(fetched.plan.steps[1].status, 'in_progress');
});

test('context compaction preserves the authoritative plan and latest revision', async () => {
  const project = newProject('compaction');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'Gather context', status: 'completed' },
    { description: 'Implement', status: 'in_progress' },
    { description: 'Deploy', status: 'blocked', note: 'Waiting for credentials' },
  ], 'Compaction objective');
  await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[1].id, note: 'halfway' }],
  });
  sessions.saveMessage(id, 'user', 'Continue the task.');
  for (let i = 0; i < 24; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Turn${i} `.padEnd(400, 'x'));
  const before = plan.getPlan(id);

  const result = await require('./fixtures/w3Compaction.cjs').compact({ sessionId: id, modelId: MODEL });
  assert.equal(result.compressed, true);
  assert.deepEqual(plan.getPlan(id), before);

  const resumed = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const block = resumed.find((message) => message.workspacePlan === true);
  assert.ok(block);
  assert.equal(block.planRevision, before.revision);
  assert.match(block.content, /Implement/);
  assert.match(block.content, /Deploy/);
  assert.match(block.content, /Waiting for credentials/);
});

test('work-log digests remain accurate for compact plan mutations', async () => {
  const project = newProject('worklog');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }, { description: 'B' }]);
  const updated = await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
  });
  const digest = buildTurnDigest([{
    type: 'tool_call',
    id: 'call-1',
    toolName: 'update_plan',
    status: 'complete',
    args: { action: 'update', steps: [{ id: created.plan.steps[0].id, status: 'completed' }] },
    result: updated,
  }], { turnSeq: 1 });
  assert.match(digest.text, /updated the task plan/);
  assert.doesNotMatch(digest.text, /UNKNOWN/);

  sessions.saveMessage(id, 'user', 'Do the work.');
  const assistant = sessions.saveMessage(id, 'assistant', 'Done.', [], null, null, null, null, null, [{
    type: 'tool_call',
    id: 'call-1',
    toolName: 'update_plan',
    status: 'complete',
    args: { action: 'update' },
    result: updated,
  }]);
  const recorded = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id });
  assert.ok(recorded);
  const section = workLog.buildWorkLogSection(id);
  assert.match(section.content, /updated the task plan/);
});

test('the Activity-tab push still receives the complete plan after a compact update', async () => {
  const { EventEmitter } = require('node:events');
  const { registerIpcHandlers } = require('../src/main/ipcHandlers');
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => null });
  try {
    const project = newProject('activity');
    const id = workspaceSession(project.id);
    const created = await executeAgentTool({
      name: 'update_plan',
      arguments: JSON.stringify({
        action: 'create',
        objective: 'Activity objective',
        steps: [
          { description: 'Activity one' },
          { description: 'Activity two', status: 'blocked', note: 'activity blocker' },
        ],
      }),
      sessionId: id,
      permissionMode: 'workspace_write',
    });
    const sent = [];
    const sender = Object.assign(new EventEmitter(), {
      send: (channel, payload) => sent.push({ channel, payload }),
      isDestroyed: () => false,
    });
    const event = { sender };
    const invoke = (channel, payload) => ipcHandlers.get(channel)(event, payload);

    const result = await invoke('agent:execute-tool', {
      requestId: 'compact-activity',
      sessionId: id,
      name: 'update_plan',
      arguments: JSON.stringify({
        action: 'update',
        steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
      }),
      permissionMode: 'workspace_write',
    });
    assert.equal(result.success, true);
    assert.equal(result.changed_steps.length, 1);
    assert.equal(Object.hasOwn(result, 'plan'), false);

    const pushed = sent.find((entry) => entry.channel === 'session:plan-updated');
    assert.ok(pushed);
    assert.equal(pushed.payload.sessionId, id);
    assert.equal(pushed.payload.plan.revision, result.revision);
    assert.equal(pushed.payload.plan.objective, 'Activity objective');
    assert.deepEqual(pushed.payload.plan.steps.map((step) => step.description), [
      'Activity one', 'Activity two',
    ]);
    assert.equal(pushed.payload.plan.steps[0].status, 'completed');
    assert.equal(pushed.payload.plan.steps[1].note, 'activity blocker');

    // A failed mutation still sends no event and leaves the card's state intact.
    sent.length = 0;
    const failed = await invoke('agent:execute-tool', {
      requestId: 'compact-activity-fail',
      sessionId: id,
      name: 'update_plan',
      arguments: JSON.stringify({ action: 'update', steps: [{ id: 99999999, status: 'completed' }] }),
      permissionMode: 'workspace_write',
    });
    assert.equal(failed.success, false);
    assert.equal(sent.filter((entry) => entry.channel === 'session:plan-updated').length, 0);
    assert.equal(plan.getPlan(id).steps[0].status, 'completed');
  } finally {
    dispose();
  }
});

test('concurrent sessions keep independent plans, revisions, and compact results', async () => {
  const project = newProject('concurrent');
  const a = workspaceSession(project.id);
  const b = workspaceSession(project.id);
  const planA = await create(a, [{ description: 'A1' }, { description: 'A2' }], 'Plan A');
  const planB = await create(b, [{ description: 'B1' }], 'Plan B');

  const updateA = await tool(a, {
    action: 'update',
    steps: [{ id: planA.plan.steps[0].id, status: 'completed' }],
  });
  const updateB = await tool(b, {
    action: 'update',
    steps: [{ id: planB.plan.steps[0].id, status: 'blocked', note: 'b blocked' }],
  });

  assert.equal(updateA.plan_id, a);
  assert.equal(updateB.plan_id, b);
  assert.equal(updateA.changed_steps[0].description, 'A1');
  assert.equal(updateB.changed_steps[0].description, 'B1');
  assert.equal(updateB.changed_steps[0].note, 'b blocked');
  assert.equal(updateA.revision, 2);
  assert.equal(updateB.revision, 2);
  assert.equal(plan.getPlan(a).steps[0].status, 'completed');
  assert.equal(plan.getPlan(b).steps[0].status, 'blocked');
  assert.equal(plan.getPlan(b).steps[0].note, 'b blocked');
  assert.notEqual(plan.getPlan(a).steps[0].id, plan.getPlan(b).steps[0].id);
});

test('subagent children still cannot create, update, or read plans', () => {
  assert.equal(CHILD_TOOL_NAMES.includes('update_plan'), false);
  assert.equal(CHILD_TOOL_NAMES.includes('get_project_plans'), false);
});

test('large plans stay bounded and the documented 50-step limit is enforced', async () => {
  const project = newProject('large');
  const id = workspaceSession(project.id);
  const steps = Array.from({ length: plan.MAX_STEPS }, (_, index) => ({
    description: `Step ${index + 1}: ${'D'.repeat(120)}`,
  }));
  const created = await create(id, steps);
  assert.equal(created.plan.steps.length, 50);

  const result = await tool(id, {
    action: 'update',
    steps: [{ id: created.plan.steps[49].id, status: 'completed' }],
  });
  assert.equal(result.changed_steps.length, 1);
  assert.equal(result.progress.total, 50);
  assert.ok(JSON.stringify(result).length < 1000, 'a one-step mutation stays small for a 50-step plan');
  assert.doesNotMatch(JSON.stringify(result), /Step 1:/);

  const tooMany = await create(workspaceSession(project.id), Array.from({ length: 51 }, (_, index) => ({
    description: `Overflow ${index}`,
  })));
  assert.equal(tooMany.success, false);
  assert.equal(tooMany.code, 'TOO_MANY_STEPS');
  assert.equal(plan.MAX_STEPS, 50, '100-step plans are not supported by design');
});

test('compact responses are deterministic in step and removal ordering', async () => {
  const project = newProject('deterministic');
  const id = workspaceSession(project.id);
  const created = await create(id, [
    { description: 'D1' }, { description: 'D2' }, { description: 'D3' }, { description: 'D4' },
  ]);
  const [d1, d2, d3, d4] = created.plan.steps;
  const result = await tool(id, {
    action: 'update',
    remove_step_ids: [d4.id, d2.id],
    steps: [{ id: d3.id, status: 'completed' }, { id: d1.id, status: 'in_progress' }],
  });
  assert.deepEqual(result.changed_steps.map((step) => step.id), [d1.id, d3.id]);
  assert.deepEqual(result.removed_step_ids, [d2.id, d4.id]);
  assert.deepEqual(Object.keys(result), [
    'success', 'action', 'exists', 'plan_id', 'revision', 'changed_steps', 'progress', 'removed_step_ids',
  ]);
});

test('backwards-compatible success/action/exists/error semantics are preserved', async () => {
  const project = newProject('compat');
  const id = workspaceSession(project.id);
  const created = await create(id, [{ description: 'A' }]);
  assert.equal(created.success, true);
  assert.equal(created.action, 'create');
  assert.equal(created.exists, true);
  assert.ok(created.plan);

  const updated = await tool(id, { action: 'update', steps: [{ id: created.plan.steps[0].id, status: 'in_progress' }] });
  assert.equal(updated.success, true);
  assert.equal(updated.action, 'update');
  assert.equal(updated.exists, true);
  assert.equal(updated.plan_id, id);

  const fetched = await tool(id, { action: 'get' });
  assert.equal(fetched.success, true);
  assert.equal(fetched.action, 'get');
  assert.equal(fetched.exists, true);
  assert.ok(fetched.plan);

  const failed = await tool(id, { action: 'explode' });
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'INVALID_ACTION');
  assert.equal(typeof failed.error, 'string');

  // The schema now documents the compact update contract without removing the
  // create/get guidance the model relies on.
  const schema = require('../src/main/tools/agentTools').agentTools
    .find((entry) => entry.function.name === 'update_plan').function.description;
  assert.match(schema, /returns only changed_steps/);
  assert.match(schema, /unchanged steps are not echoed/);
});

test('measured compact output is substantially smaller than the previous full-plan response', async () => {
  // The pre-2.0E update response was exactly `{ success, action, exists, plan }`
  // where plan was the same authoritative readPlan() record. Reconstruct that
  // historical shape from SQLite for an exact, deterministic comparison.
  const sizes = [];
  for (const count of [5, 20, 38, 50]) {
    const project = newProject(`size-${count}`);
    const id = workspaceSession(project.id);
    const steps = Array.from({ length: count }, (_, index) => ({
      description: `Step ${index + 1}: implement a representative part of the task with enough detail to look realistic.`,
    }));
    const created = await create(id, steps, 'Benchmark objective');
    const result = await tool(id, {
      action: 'update',
      steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
    });
    const fullPlan = plan.getPlan(id);
    const legacy = { success: true, action: 'update', exists: true, plan: fullPlan };
    const before = JSON.stringify(legacy).length;
    const after = JSON.stringify(result).length;
    sizes.push({
      steps: count,
      before,
      after,
      reduction: Number((((before - after) / before) * 100).toFixed(2)),
    });
    assert.ok(after < before / 2, `${count}-step update must be less than half the old response`);
    assert.equal(result.revision, fullPlan.revision);
    assert.equal(result.progress.total, count);
    assert.equal(result.changed_steps[0].status, 'completed');
  }
  assert.deepEqual(sizes.map((entry) => entry.steps), [5, 20, 38, 50]);
  // A five-step plan is the worst case for the ratio (fixed progress costs),
  // but every representative size still shrinks by at least two thirds.
  assert.ok(sizes.every((entry) => entry.reduction > 65), JSON.stringify(sizes));
});
