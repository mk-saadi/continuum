'use strict';

// Cross-session, same-project workspace task-plan retrieval (get_project_plans).
//
// These tests exercise the real tool-dispatch and permission path — not just
// the SQLite helpers — across two or more real workspace sessions attached to
// the same temporary project, and verify the read-only, same-project boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-plan-'));
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
const { rebuildChatMessages, prepareChatMessages, getToolContext } = require('../src/main/promptBuilder');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, CAPABILITIES } = require('../src/main/toolPermissions');

const MODEL = 'model';
let projectSeq = 0;

// A fresh project with its own root, so listing totals stay isolated per test.
function newProject(name) {
  const root = path.join(directory, `ws-${projectSeq++}`);
  fs.mkdirSync(root, { recursive: true });
  return projects.createProject({ name, root_path: root });
}

function workspaceSession(projectId, id = crypto.randomUUID(), title = null) {
  sessions.getOrCreateSession(id, MODEL, projectId);
  if (title) sessions.updateSession(id, 'title', title);
  return id;
}

function casualSession(id = crypto.randomUUID()) {
  sessions.getOrCreateSession(id, MODEL, null);
  return id;
}

// The actual tool path (schema validation + permission guard + dispatch).
function tool(sessionId, args, permissionMode = 'workspace_write') {
  return executeAgentTool({
    name: 'get_project_plans',
    arguments: JSON.stringify(args),
    sessionId,
    permissionMode,
  });
}

function snapshotPlan(owner) {
  return {
    plan: db.prepare('SELECT * FROM workspace_plans WHERE session_id = ?').get(owner) ?? null,
    steps: db.prepare('SELECT * FROM workspace_plan_steps WHERE session_id = ? ORDER BY id').all(owner),
  };
}

test('list returns bounded summaries of the plans in the current project', () => {
  const project = newProject('list');
  const a = workspaceSession(project.id, undefined, 'Chat A');
  const b = workspaceSession(project.id, undefined, 'Chat B');
  plan.updatePlan(a, {
    action: 'create',
    objective: 'Ship parser',
    steps: [{ description: 'First part' }, { description: 'Second part', status: 'completed' }],
  });
  plan.updatePlan(b, { action: 'create', objective: 'Write docs', steps: [{ description: 'Draft', status: 'in_progress' }] });

  const res = plan.getProjectPlans(a, { action: 'list' });
  assert.equal(res.success, true);
  assert.equal(res.action, 'list');
  assert.equal(res.total, 2);
  assert.equal(res.plans.length, 2);
  assert.equal(res.has_more, false);

  const byId = new Map(res.plans.map((row) => [row.plan_id, row]));
  assert.ok(byId.has(a) && byId.has(b));
  const rowA = byId.get(a);
  assert.equal(rowA.session_id, a);
  assert.equal(rowA.session_title, 'Chat A');
  assert.equal(rowA.objective, 'Ship parser');
  assert.equal(rowA.total_steps, 2);
  assert.equal(rowA.completed_steps, 1);
  assert.equal(rowA.pending_steps, 1);
  assert.equal(rowA.status, 'pending');

  // A listing carries metadata and counts only — never step text.
  assert.equal(Object.hasOwn(rowA, 'steps'), false);
  assert.doesNotMatch(JSON.stringify(res), /First part|Second part|Draft/);
  assert.deepEqual(plan.PLAN_AGGREGATE_STATUSES, ['empty', 'blocked', 'in_progress', 'pending', 'completed']);
});

test('a chat can retrieve another same-project chat\'s full plan by plan_id', async () => {
  const project = newProject('get');
  const owner = workspaceSession(project.id, undefined, 'Owner');
  const reviewer = workspaceSession(project.id, undefined, 'Reviewer');
  const created = plan.updatePlan(owner, {
    action: 'create',
    objective: 'Goal A',
    steps: [{ description: 'Step 1' }, { description: 'Step 2', status: 'blocked', note: 'needs key' }],
  }).plan;

  const res = await tool(reviewer, { action: 'get', plan_id: owner });
  assert.equal(res.success, true);
  assert.equal(res.exists, true);
  assert.equal(res.owner.session_id, owner);
  assert.equal(res.owner.session_title, 'Owner');
  assert.equal(res.plan.plan_id, owner);
  assert.equal(res.plan.objective, 'Goal A');
  assert.deepEqual(
    res.plan.steps.map((step) => [step.id, step.description, step.status, step.note]),
    created.steps.map((step) => [step.id, step.description, step.status, step.note]),
  );

  // session_id is accepted as an alias for the stable plan identity.
  const alias = plan.getProjectPlans(reviewer, { action: 'get', session_id: owner });
  assert.equal(alias.exists, true);
  assert.equal(alias.plan.plan_id, owner);
});

test('a fully completed 38-step plan is discoverable and returned in full', async () => {
  const project = newProject('completed');
  const owner = workspaceSession(project.id, undefined, 'Chat A');
  const steps = Array.from({ length: 38 }, (_, index) => ({ description: `Task ${index + 1}` }));
  const created = plan.updatePlan(owner, { action: 'create', objective: 'Big job', steps }).plan;
  const done = plan.updatePlan(owner, {
    action: 'update',
    steps: created.steps.map((step) => ({ id: step.id, status: 'completed' })),
  });
  assert.equal(done.changed_steps.length, 38);

  const reviewer = workspaceSession(project.id, undefined, 'Chat B');
  const row = plan.getProjectPlans(reviewer, { action: 'list' }).plans.find((item) => item.plan_id === owner);
  assert.equal(row.status, 'completed');
  assert.equal(row.total_steps, 38);
  assert.equal(row.completed_steps, 38);
  assert.equal(row.blocked_steps, 0);
  assert.equal(row.revision, done.revision);

  const res = await tool(reviewer, { action: 'get', plan_id: owner });
  assert.equal(res.exists, true);
  assert.equal(res.plan.steps.length, 38);
  assert.equal(res.plan.completed_steps, 38);
  assert.ok(res.plan.steps.every((step) => step.status === 'completed'));
});

test('a plan with blocked steps reports the blocker and blocker note', async () => {
  const project = newProject('blocked');
  const owner = workspaceSession(project.id);
  plan.updatePlan(owner, {
    action: 'create',
    steps: [
      { description: 'Deploy', status: 'blocked', note: 'waiting on credentials' },
      { description: 'Done', status: 'completed' },
    ],
  });
  const reviewer = workspaceSession(project.id);
  const row = plan.getProjectPlans(reviewer, { action: 'list' }).plans.find((item) => item.plan_id === owner);
  assert.equal(row.status, 'blocked');
  assert.equal(row.blocked_steps, 1);
  assert.equal(row.completed_steps, 1);

  const res = await tool(reviewer, { action: 'get', plan_id: owner });
  const blocked = res.plan.steps.find((step) => step.status === 'blocked');
  assert.equal(blocked.note, 'waiting on credentials');
  assert.equal(res.plan.blocked_steps, 1);
  assert.equal(res.plan.status, 'blocked');
});

test('listing orders by recent plan activity and carries session titles', () => {
  const project = newProject('order');
  const older = workspaceSession(project.id, undefined, 'Older');
  const newer = workspaceSession(project.id, undefined, 'Newer');
  plan.updatePlan(older, { action: 'create', steps: [{ description: 'x' }] });
  plan.updatePlan(newer, { action: 'create', steps: [{ description: 'y' }] });
  // Pin timestamps so ordering is deterministic at second resolution.
  db.prepare('UPDATE workspace_plans SET updated_at = ? WHERE session_id = ?').run('2020-01-01 00:00:00', older);
  db.prepare('UPDATE workspace_plans SET updated_at = ? WHERE session_id = ?').run('2021-06-01 00:00:00', newer);

  const res = plan.getProjectPlans(older, { action: 'list' });
  assert.deepEqual(res.plans.map((row) => row.plan_id), [newer, older]);
  assert.equal(res.plans[0].session_title, 'Newer');
  assert.equal(res.plans[1].updated_at, '2020-01-01 00:00:00');
});

test('update_plan get stays current-session-only; listings include every project plan', () => {
  const project = newProject('current');
  const a = workspaceSession(project.id);
  const b = workspaceSession(project.id);
  plan.updatePlan(a, { action: 'create', objective: 'A only', steps: [{ description: 'A step' }] });

  const own = plan.updatePlan(b, { action: 'get' });
  assert.equal(own.success, true);
  assert.equal(own.exists, false);
  assert.equal(own.plan, null);

  plan.updatePlan(b, { action: 'create', objective: 'B only', steps: [{ description: 'B step' }] });
  assert.equal(plan.updatePlan(b, { action: 'get' }).plan.objective, 'B only');

  const res = plan.getProjectPlans(b, { action: 'list' });
  assert.deepEqual(res.plans.map((row) => row.objective).sort(), ['A only', 'B only']);
});

test('plans from another project are never listed or retrievable', async () => {
  const projectA = newProject('cross-a');
  const projectB = newProject('cross-b');
  const a = workspaceSession(projectA.id);
  const b = workspaceSession(projectB.id);
  plan.updatePlan(a, { action: 'create', objective: 'Project A secret', steps: [{ description: 'secret step' }] });
  plan.updatePlan(b, { action: 'create', objective: 'Project B', steps: [{ description: 'b step' }] });

  const fromA = plan.getProjectPlans(a, { action: 'list' });
  assert.equal(fromA.total, 1);
  assert.equal(fromA.plans[0].plan_id, a);
  assert.doesNotMatch(JSON.stringify(fromA), /Project B/);

  // B cannot read A's plan even by A's exact session id.
  const cross = await tool(b, { action: 'get', plan_id: a });
  assert.equal(cross.success, true);
  assert.equal(cross.exists, false);
  assert.equal(cross.plan, null);
  assert.doesNotMatch(JSON.stringify(cross), /Project A secret|secret step/);
});

test('a detached session (deleted project) cannot list or be reached', async () => {
  const projectA = newProject('detach-a');
  const projectB = newProject('detach-b');
  const a = workspaceSession(projectA.id);
  const b = workspaceSession(projectB.id);
  plan.updatePlan(a, { action: 'create', steps: [{ description: 'a' }] });
  plan.updatePlan(b, { action: 'create', steps: [{ description: 'b' }] });

  // Deleting project B detaches (preserves) its chats: project_id -> NULL.
  projects.deleteProject(projectB.id);
  const detached = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(b);
  assert.equal(detached.project_id, null);

  // The detached chat's own plan remains stored but is no longer reachable.
  assert.equal(plan.getPlan(b), null);
  const fromDetached = await tool(b, { action: 'list' });
  assert.equal(fromDetached.success, false);
  assert.match(fromDetached.error, /project workspace/i);

  // The still-attached project cannot see the detached plan either.
  const fromA = plan.getProjectPlans(a, { action: 'list' });
  assert.deepEqual(fromA.plans.map((row) => row.plan_id), [a]);
  const cross = await tool(a, { action: 'get', plan_id: b });
  assert.equal(cross.exists, false);
  assert.doesNotMatch(JSON.stringify(cross), /b/);
});

test('casual chats cannot list or read project plans in any mode', async () => {
  const project = newProject('casual');
  const owner = workspaceSession(project.id);
  plan.updatePlan(owner, { action: 'create', steps: [{ description: 'owner' }] });
  const casual = casualSession();

  // Hidden from the model's tool list wherever it could not execute.
  for (const mode of ['read_only', 'workspace_write', 'ask_approval', 'full_access']) {
    assert.equal(isToolVisible('get_project_plans', { permissionMode: mode, project: null }), false, mode);
  }

  for (const mode of ['workspace_write', 'ask_approval', 'read_only', 'full_access']) {
    const res = await tool(casual, { action: 'list' }, mode);
    assert.equal(res.success, false, mode);
    assert.match(res.error, /project workspace/i, mode);
  }

  // A casual session has no plan of its own and never appears in a listing.
  assert.equal(plan.getPlan(casual), null);
  assert.doesNotMatch(JSON.stringify(plan.getProjectPlans(owner, { action: 'list' })), new RegExp(casual));
});

test('unknown plan and session ids are handled safely', async () => {
  const project = newProject('unknown');
  const caller = workspaceSession(project.id);
  plan.updatePlan(caller, { action: 'create', steps: [{ description: 'mine' }] });

  const res = await tool(caller, { action: 'get', plan_id: crypto.randomUUID() });
  assert.equal(res.success, true);
  assert.equal(res.exists, false);
  assert.equal(res.plan, null);

  // A genuine same-project session that simply has no plan is reported clearly.
  const noPlan = workspaceSession(project.id);
  const res2 = await tool(caller, { action: 'get', plan_id: noPlan });
  assert.equal(res2.success, true);
  assert.equal(res2.exists, false);
  assert.equal(res2.owner.session_id, noPlan);
  assert.match(res2.message, /no plan/i);
});

test('cross-session reads never modify the target or the current plan', async () => {
  const project = newProject('readonly');
  const owner = workspaceSession(project.id);
  const reader = workspaceSession(project.id);
  const ownerPlan = plan.updatePlan(owner, {
    action: 'create',
    objective: 'Owner work',
    steps: [{ description: 'One', status: 'in_progress' }, { description: 'Two', status: 'blocked', note: 'wait' }],
  }).plan;
  const readerPlan = plan.updatePlan(reader, {
    action: 'create',
    objective: 'Reader work',
    steps: [{ description: 'Only step' }],
  }).plan;

  const beforeOwner = snapshotPlan(owner);
  const beforeReader = snapshotPlan(reader);

  for (let i = 0; i < 3; i++) {
    assert.equal(plan.getProjectPlans(reader, { action: 'list' }).success, true);
    assert.equal((await tool(reader, { action: 'get', plan_id: owner })).plan.revision, ownerPlan.revision);
  }

  assert.deepEqual(snapshotPlan(owner), beforeOwner);
  assert.deepEqual(snapshotPlan(reader), beforeReader);
  assert.equal(plan.getPlan(owner).revision, ownerPlan.revision);
  assert.equal(plan.getPlan(reader).revision, readerPlan.revision);
  // Step identities stay scoped to their owning plan.
  const ownerIds = new Set(plan.getPlan(owner).steps.map((step) => step.id));
  assert.ok(plan.getPlan(reader).steps.every((step) => !ownerIds.has(step.id)));
});

test('concurrent plans in one project stay isolated', () => {
  const project = newProject('concurrent');
  const a = workspaceSession(project.id);
  const b = workspaceSession(project.id);
  const planA = plan.updatePlan(a, { action: 'create', steps: [{ description: 'A1' }, { description: 'A2' }] }).plan;
  const planB = plan.updatePlan(b, { action: 'create', steps: [{ description: 'B1' }] }).plan;

  plan.updatePlan(a, { action: 'update', steps: [{ id: planA.steps[0].id, status: 'completed' }] });
  plan.updatePlan(b, { action: 'update', steps: [{ id: planB.steps[0].id, status: 'blocked', note: 'b blocked' }] });

  const listed = new Map(plan.getProjectPlans(a, { action: 'list' }).plans.map((row) => [row.plan_id, row]));
  assert.equal(listed.get(a).completed_steps, 1);
  assert.equal(listed.get(a).blocked_steps, 0);
  assert.equal(listed.get(b).completed_steps, 0);
  assert.equal(listed.get(b).blocked_steps, 1);

  assert.equal(plan.getPlan(a).steps[0].status, 'completed');
  assert.equal(plan.getPlan(b).steps[0].status, 'blocked');
  assert.equal(plan.getPlan(b).steps[0].note, 'b blocked');
});

test('listing is bounded and paginates deterministically', () => {
  const project = newProject('paging');
  const owner = workspaceSession(project.id);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = workspaceSession(project.id);
    plan.updatePlan(id, { action: 'create', steps: [{ description: `plan ${i}` }] });
    db.prepare('UPDATE workspace_plans SET updated_at = ? WHERE session_id = ?')
      .run(`2021-01-0${i + 1} 00:00:00`, id);
    ids.push(id);
  }

  const page1 = plan.getProjectPlans(owner, { action: 'list', limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.plans.length, 2);
  assert.equal(page1.has_more, true);
  assert.deepEqual(page1.plans.map((row) => row.plan_id), [ids[4], ids[3]]);

  const page2 = plan.getProjectPlans(owner, { action: 'list', limit: 2, offset: 2 });
  assert.deepEqual(page2.plans.map((row) => row.plan_id), [ids[2], ids[1]]);
  assert.equal(page2.has_more, true);

  const page3 = plan.getProjectPlans(owner, { action: 'list', limit: 2, offset: 4 });
  assert.deepEqual(page3.plans.map((row) => row.plan_id), [ids[0]]);
  assert.equal(page3.has_more, false);

  // The default page is bounded too.
  assert.equal(plan.getProjectPlans(owner, { action: 'list' }).limit, plan.DEFAULT_LIST_LIMIT);

  // Invalid paging fails loudly and never silently widens.
  assert.equal(plan.getProjectPlans(owner, { action: 'list', limit: 100 }).code, 'INVALID_LIMIT');
  assert.equal(plan.getProjectPlans(owner, { action: 'list', limit: 0 }).code, 'INVALID_LIMIT');
  assert.equal(plan.getProjectPlans(owner, { action: 'list', offset: -1 }).code, 'INVALID_OFFSET');
});

test('no other session\'s plan is injected into context automatically', () => {
  const project = newProject('injection');
  const a = workspaceSession(project.id);
  const b = workspaceSession(project.id);
  plan.updatePlan(a, { action: 'create', objective: 'INJECTMARKER_ALPHA', steps: [{ description: 'alpha step' }] });
  plan.updatePlan(b, { action: 'create', objective: 'INJECTMARKER_BETA', steps: [{ description: 'beta step' }] });

  // The current session's own plan is injected; the other session's is not.
  const sectionB = plan.buildPlanSection(b);
  assert.match(sectionB.content, /INJECTMARKER_BETA/);
  assert.doesNotMatch(sectionB.content, /INJECTMARKER_ALPHA|alpha step/);

  const rebuilt = JSON.stringify(rebuildChatMessages({ sessionId: b, modelId: MODEL }));
  const prepared = JSON.stringify(prepareChatMessages({ sessionId: b, modelId: MODEL, userText: 'continue' }));
  assert.doesNotMatch(rebuilt, /INJECTMARKER_ALPHA|alpha step/);
  assert.doesNotMatch(prepared, /INJECTMARKER_ALPHA|alpha step/);

  // It is discoverable only when explicitly requested.
  const tools = getToolContext([], true, b, 'workspace_write').tools.map((entry) => entry.function.name);
  assert.ok(tools.includes('get_project_plans'));
  const listed = plan.getProjectPlans(b, { action: 'list' });
  assert.match(JSON.stringify(listed), /INJECTMARKER_ALPHA/);
});

test('get_project_plans is registered as a read-only same-project tool through the real dispatcher', async () => {
  const project = newProject('registration');
  const owner = workspaceSession(project.id);
  const caller = workspaceSession(project.id);
  plan.updatePlan(owner, { action: 'create', steps: [{ description: 'shared' }] });

  const definition = agentTools.find((entry) => entry.function.name === 'get_project_plans');
  assert.ok(definition, 'tool is registered');
  assert.deepEqual(definition.function.parameters.properties.action.enum, ['list', 'get']);
  assert.deepEqual(definition.function.parameters.required, ['action']);

  assert.equal(capabilityOf('get_project_plans'), CAPABILITIES.PLAN_READ);
  assert.equal(capabilityOf('update_plan'), CAPABILITIES.PLAN_WRITE);

  // Bad shapes fail loudly through the dispatcher, never silently.
  assert.equal((await tool(caller, { action: 'explode' })).code, 'INVALID_ACTION');
  assert.equal((await tool(caller, { action: 'get' })).code, 'MISSING_FIELD');
  assert.equal((await tool(caller, { action: 'get', plan_id: 123 })).code, 'INVALID_TARGET');
  const missing = await executeAgentTool({ name: 'get_project_plans', arguments: '{}', sessionId: caller, permissionMode: 'workspace_write' });
  assert.equal(missing.success, false);
  assert.match(missing.error, /Missing action/);
  const extra = await executeAgentTool({
    name: 'get_project_plans',
    arguments: JSON.stringify({ action: 'list', bogus: true }),
    sessionId: caller,
    permissionMode: 'workspace_write',
  });
  assert.equal(extra.success, false);
  assert.match(extra.error, /Unexpected tool argument/);
});

test('read-only workspace permission is sufficient for same-project plan reads', async () => {
  const project = newProject('readonly-perm');
  const owner = workspaceSession(project.id);
  const reader = workspaceSession(project.id);
  plan.updatePlan(owner, { action: 'create', objective: 'read me', steps: [{ description: 'one' }] });

  assert.equal(isToolVisible('get_project_plans', { permissionMode: 'read_only', project }), true);
  assert.equal(isToolVisible('get_project_plans', { permissionMode: 'workspace_write', project }), true);
  assert.equal(isToolVisible('update_plan', { permissionMode: 'read_only', project }), false);

  const readOnlyTools = getToolContext([], true, reader, 'read_only').tools.map((entry) => entry.function.name);
  assert.ok(readOnlyTools.includes('get_project_plans'));
  assert.ok(!readOnlyTools.includes('update_plan'));

  const res = await tool(reader, { action: 'get', plan_id: owner }, 'read_only');
  assert.equal(res.success, true);
  assert.equal(res.exists, true);
  assert.equal(res.plan.objective, 'read me');

  // A read-only agent still cannot write a plan, in this or any session.
  const writeAttempt = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'create', steps: [{ description: 'nope' }] }),
    sessionId: reader,
    permissionMode: 'read_only',
  });
  assert.equal(writeAttempt.success, false);
  assert.match(writeAttempt.error, /Read Only/);

  const externalWrite = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'create', steps: [{ description: 'nope' }] }),
    sessionId: owner,
    permissionMode: 'read_only',
  });
  assert.equal(externalWrite.success, false);
});

test('revision and timestamp bookkeeping stays accurate across retrieval', async () => {
  const project = newProject('revision');
  const owner = workspaceSession(project.id, undefined, 'Chat A');
  const reader = workspaceSession(project.id);
  const created = plan.updatePlan(owner, { action: 'create', steps: [{ description: 'a' }, { description: 'b' }] }).plan;
  const rowBefore = db.prepare('SELECT revision, created_at, updated_at FROM workspace_plans WHERE session_id = ?').get(owner);
  assert.equal(rowBefore.revision, created.revision);

  const listed = plan.getProjectPlans(reader, { action: 'list' }).plans.find((item) => item.plan_id === owner);
  const detail = (await tool(reader, { action: 'get', plan_id: owner })).plan;
  assert.equal(listed.revision, rowBefore.revision);
  assert.equal(listed.updated_at, rowBefore.updated_at);
  assert.equal(listed.created_at, rowBefore.created_at);
  assert.equal(detail.revision, rowBefore.revision);
  assert.equal(detail.updated_at, rowBefore.updated_at);

  const updated = plan.updatePlan(owner, { action: 'update', steps: [{ id: created.steps[0].id, status: 'completed' }] });
  assert.equal(updated.revision, rowBefore.revision + 1);
  const listedAfter = plan.getProjectPlans(reader, { action: 'list' }).plans.find((item) => item.plan_id === owner);
  assert.equal(listedAfter.revision, updated.revision);
  assert.equal(listedAfter.completed_steps, 1);
});

test('the Activity-tab IPC still exposes only the current session plan', async () => {
  const { EventEmitter } = require('node:events');
  const { registerIpcHandlers } = require('../src/main/ipcHandlers');
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => null });
  try {
    const project = newProject('ipc');
    const a = workspaceSession(project.id);
    const b = workspaceSession(project.id);
    plan.updatePlan(a, { action: 'create', objective: 'A objective', steps: [{ description: 'A step' }] });
    plan.updatePlan(b, { action: 'create', objective: 'B objective', steps: [{ description: 'B step' }] });

    const invoke = (channel, payload) => ipcHandlers.get(channel)({ sender: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} }) }, payload);
    const forA = await invoke('session:get-plan', { sessionId: a });
    const forB = await invoke('session:get-plan', { sessionId: b });
    assert.equal(forA.objective, 'A objective');
    assert.equal(forB.objective, 'B objective');
    assert.notDeepEqual(forA, forB);
  } finally {
    dispose();
  }
});

test('cross-session retrieval and current plans survive a database restart', async () => {
  const project = newProject('restart');
  const a = workspaceSession(project.id, undefined, 'Restart A');
  const b = workspaceSession(project.id, undefined, 'Restart B');
  const created = plan.updatePlan(a, {
    action: 'create',
    objective: 'Persist me',
    steps: [{ description: 'P1' }, { description: 'P2', status: 'in_progress' }],
  }).plan;
  plan.updatePlan(b, { action: 'create', objective: 'B work', steps: [{ description: 'B1' }] });

  closeDatabase();
  initDatabase();

  const restored = plan.getPlan(a);
  assert.deepEqual(restored, created);
  const listed = plan.getProjectPlans(b, { action: 'list' });
  assert.equal(listed.total, 2);
  const res = await tool(b, { action: 'get', plan_id: a });
  assert.equal(res.exists, true);
  assert.equal(res.plan.steps.length, 2);
  assert.equal(res.plan.steps[1].status, 'in_progress');
  assert.match(plan.buildPlanSection(b).content, /B work/);
});

test('the new tool is classified for display without a raw snake_case verb', async () => {
  const { toolKind, toolVerb, summarizeStage, summarizeStep } = await import('../src/lib/executionEvents.mjs');
  const read = { type: 'tool_call', toolName: 'get_project_plans', status: 'complete', args: { action: 'get', plan_id: 'abc' } };
  assert.equal(toolKind(read), 'plan');
  assert.equal(toolVerb(read), 'Read plans');
  assert.doesNotMatch(toolVerb(read), /_/);
  assert.equal(summarizeStep(read).summary, 'get · abc');
  assert.equal(summarizeStage({ events: [read] }).title, 'Read plan');
  const update = { type: 'tool_call', toolName: 'update_plan', status: 'complete', args: { action: 'update' } };
  assert.equal(summarizeStage({ events: [update] }).title, 'Updated plan');
  assert.equal(summarizeStage({ events: [read, { ...read, toolName: 'get_project_plans' }] }).title, 'Read 2 project plans');
});

test('existing workspace plan tools are unchanged by the read path', async () => {
  const project = newProject('no-regression');
  const id = workspaceSession(project.id);

  const created = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'create', steps: [{ description: 'Via tool' }] }),
    sessionId: id,
    permissionMode: 'workspace_write',
  });
  assert.equal(created.success, true);
  const updated = await executeAgentTool({
    name: 'update_plan',
    arguments: JSON.stringify({ action: 'update', steps: [{ id: created.plan.steps[0].id, status: 'in_progress' }] }),
    sessionId: id,
    permissionMode: 'workspace_write',
  });
  assert.equal(updated.success, true);
  assert.equal(updated.changed_steps[0].status, 'in_progress');
  assert.equal(updated.revision, 2);

  // Writing still requires a workspace and write permission; reading a plan
  // never upgrades a write-only tool's visibility.
  assert.equal(isToolVisible('update_plan', { permissionMode: 'read_only', project }), false);
  assert.ok(agentTools.some((tool) => tool.function.name === 'update_plan'));
  assert.ok(agentTools.some((tool) => tool.function.name === 'run_tests'));

  // The read tool never appears for a casual chat in the assembled tool set.
  const casual = casualSession();
  const casualTools = getToolContext([], true, casual, 'ask_approval').tools.map((entry) => entry.function.name);
  assert.ok(!casualTools.includes('get_project_plans'));
  assert.ok(!casualTools.includes('update_plan'));
});
