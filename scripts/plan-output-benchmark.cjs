'use strict';

// Deterministic Phase 2.0E plan-output benchmark.
//
// Runs entirely against a temporary SQLite database with the real
// workspacePlan module. No model, provider, network, or paid inference call is
// involved. "Previous" reconstruction is exact: before Phase 2.0E every
// successful update returned `{ success, action: 'update', exists: true, plan }`
// where `plan` was the same readPlan() record still available from SQLite.
//
// Usage: node scripts/plan-output-benchmark.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-output-benchmark-'));
const root = path.join(directory, 'workspace');
fs.mkdirSync(root);
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      ipcMain: { handle: () => {}, removeHandler: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showOpenDialogSync: () => undefined },
      shell: { openPath: async () => '' },
      nativeImage: { createFromPath: () => ({}) },
    };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const plan = require('../src/main/workspacePlan');

const MODEL = 'benchmark-model';
const chars = (value) => JSON.stringify(value).length;
const approxTokens = (count) => Math.ceil(count / 4);
const pct = (before, after) => Number((((before - after) / before) * 100).toFixed(2));
const realisticStep = (index) => ({
  description: `Step ${index + 1}: implement a representative part of the task with enough detail to look realistic.`,
});

function main() {
  initDatabase();
  const project = projects.createProject({ name: 'plan-output-benchmark', root_path: root });
  // Each case starts with empty plan tables so auto-assigned step ids begin at
  // 1 and character counts do not drift with the width of ids from earlier
  // cases. The temporary database is never shared with a real workspace.
  const resetPlans = () => db.transaction(() => {
    db.prepare('DELETE FROM workspace_plan_steps').run();
    db.prepare('DELETE FROM workspace_plans').run();
    db.prepare('DELETE FROM sessions').run();
  })();
  const newSession = () => {
    const id = crypto.randomUUID();
    sessions.getOrCreateSession(id, MODEL, project.id);
    return id;
  };

  const sizes = [];
  for (const count of [5, 20, 38, 50]) {
    resetPlans();
    const id = newSession();
    const steps = Array.from({ length: count }, (_, index) => realisticStep(index));
    const created = plan.updatePlan(id, { action: 'create', objective: 'Benchmark objective', steps });
    const getResponse = plan.updatePlan(id, { action: 'get' });
    const mutation = plan.updatePlan(id, {
      action: 'update',
      expected_revision: created.plan.revision,
      steps: [{ id: created.plan.steps[0].id, status: 'completed' }],
    });

    const createChars = chars(created);
    const getChars = chars(getResponse);
    const latest = plan.getPlan(id);
    // Previous behavior returned the post-commit plan; reconstruct it exactly.
    const previousUpdateChars = chars({ success: true, action: 'update', exists: true, plan: latest });
    const optimizedUpdateChars = chars(mutation);
    const blocked = plan.updatePlan(id, {
      action: 'update',
      steps: [{ id: created.plan.steps[1].id, status: 'blocked', note: 'Waiting for credentials' }],
    });

    sizes.push({
      steps: count,
      create_chars: createChars,
      get_chars: getChars,
      previous_update_chars: previousUpdateChars,
      optimized_update_chars: optimizedUpdateChars,
      previous_update_tokens_approx: approxTokens(previousUpdateChars),
      optimized_update_tokens_approx: approxTokens(optimizedUpdateChars),
      reduction_percent: pct(previousUpdateChars, optimizedUpdateChars),
      contains_revision: mutation.revision === latest.revision,
      contains_changed_step: mutation.changed_steps.length === 1
        && mutation.changed_steps[0].id === created.plan.steps[0].id
        && mutation.changed_steps[0].status === 'completed',
      contains_progress: mutation.progress.total === count
        && mutation.progress.completed === 1
        && mutation.progress.pending === count - 1,
      contains_blocker: blocked.changed_steps.length === 1
        && blocked.changed_steps[0].status === 'blocked'
        && blocked.changed_steps[0].note === 'Waiting for credentials'
        && blocked.progress.blocked === 1,
    });
  }

  // 38-step workflow: one create followed by one mutation per completed step.
  resetPlans();
  const workflow = newSession();
  const workflowSteps = Array.from({ length: 38 }, (_, index) => realisticStep(index));
  const workflowCreated = plan.updatePlan(workflow, {
    action: 'create', objective: 'Workflow benchmark', steps: workflowSteps,
  });
  let previousCumulative = chars(workflowCreated);
  let optimizedCumulative = chars(workflowCreated);
  for (const step of workflowCreated.plan.steps) {
    const mutation = plan.updatePlan(workflow, { action: 'update', steps: [{ id: step.id, status: 'completed' }] });
    // Old behavior echoed the post-commit plan on every single-step update.
    previousCumulative += chars({ success: true, action: 'update', exists: true, plan: plan.getPlan(workflow) });
    optimizedCumulative += chars(mutation);
  }
  const workflowFinal = plan.getPlan(workflow);

  const report = {
    note: 'ASCII-character counts. Tokens are a chars/4 approximation, not billed provider tokens.',
    max_steps: plan.MAX_STEPS,
    hundred_step_plan_supported: false,
    mutation_responses: sizes,
    workflow_38_steps: {
      response_count: 39,
      previous_cumulative_chars: previousCumulative,
      optimized_cumulative_chars: optimizedCumulative,
      previous_cumulative_tokens_approx: approxTokens(previousCumulative),
      optimized_cumulative_tokens_approx: approxTokens(optimizedCumulative),
      reduction_percent: pct(previousCumulative, optimizedCumulative),
      final_revision: workflowFinal.revision,
      final_completed_steps: workflowFinal.steps.filter((step) => step.status === 'completed').length,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

try {
  main();
} finally {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
}
