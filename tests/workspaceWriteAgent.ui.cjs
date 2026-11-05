'use strict';
// Genuine already-running local model -> renderer preload -> engine:chat ->
// normal guard/native dispatcher. No model/backend/approval substitution.
const { _electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const resume = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
  let root;
  if (resume) {
    assert.equal(path.dirname(path.dirname(resume.workspace)), os.tmpdir(), 'resume only a disposable test workspace');
    root = path.dirname(resume.workspace);
  } else root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-real-agent-'));
  const workspace = path.join(root, 'workspace');
  if (!resume) { fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'real-agent-fixture', version: '1.0.0', scripts: { build: 'node source.cjs' } }));
  fs.mkdirSync(path.join(workspace, 'local-dependency'));
  fs.writeFileSync(path.join(workspace, 'local-dependency/package.json'), JSON.stringify({ name: 'local-dependency', version: '1.0.0' }));
  }
  const models = await (await fetch('http://127.0.0.1:8080/v1/models')).json();
  const model = models.data[0].id;
  const env = { ...process.env, NODE_ENV: 'production' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: require('electron'), args: ['scripts/local-development-main.cjs'], chromiumSandbox: true, env });
  const evidence = { ...(resume || {}), workspace, model: path.basename(model), genuineModel: true, provider: 'keyless existing loopback endpoint', checks: {} };
  let page;
  try {
    page = await application.firstWindow(); await page.waitForFunction(() => !!window.chatAPI?.run);
    const setup = await application.evaluate((_electron, { workspace, model, resumeSession }) => new Promise((resolve, reject) => setImmediate(() => {
      try {
        const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/main.js');
        if (resumeSession) { resolve({ sessionId: resumeSession, project: req('./src/main/toolPermissions').sessionProject(resumeSession) }); return; }
        const project = req('./src/main/projectManager').createProject({ name: 'Genuine agent '+workspace.split('/').at(-2), root_path: workspace, permissionMode: 'workspace_write' });
        const sessionId = 'real-agent-' + Date.now();
        req('./src/main/sessionManager').getOrCreateSession(sessionId, 'cloud:acceptance-loopback:'+model, project.id);
        req('./src/main/sessionManager').updateSession(sessionId, 'title', 'Genuine local model workflow');
        resolve({ sessionId, project });
      } catch (error) { reject(error); }
    })), { workspace, model, resumeSession: resume?.sessionId });
    assert.equal(setup.project.root_path, workspace);
    evidence.sessionId = setup.sessionId;
    await page.evaluate(async ({ sessionId, model }) => {
      await window.api.setWorkspaceNetwork({ version: 2, policy: 'isolated' });
      await window.api.saveCloudProvider({ id: 'acceptance-loopback', name: 'Existing local model acceptance', baseUrl: 'http://127.0.0.1:8080/v1', apiType: 'openai', category: 'text', apiKey: '' });
      await window.api.saveSessionMemorySettings(sessionId, model, { memoryEnabled: false, compactionEnabled: false });
      await window.api.saveSamplingParams(sessionId, model, { max_tokens: 1024, temperature: 0.1 });
    }, { sessionId: setup.sessionId, model: 'cloud:acceptance-loopback:'+model });
    await page.reload();
    const history = page.getByRole('button', { name: 'Toggle chat history', exact: true });
    if (await history.getAttribute('aria-expanded') !== 'true') await history.click();
    const projects = page.getByRole('button', { name: 'Projects', exact: true });
    if (await projects.isVisible()) await projects.click();
    else {
      const summary = page.locator('summary').filter({ hasText: /^Projects \(/ });
      if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click();
      await page.getByRole('button', { name: 'All projects', exact: true }).click();
    }
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: setup.project.name, exact: true }) }).click();
    await page.locator('button.project-chat').filter({ hasText: 'Genuine local model workflow' }).click();
    const close = page.getByRole('button', { name: 'Close model selector', exact: true });
    if (await close.isVisible()) await close.click();
    await page.evaluate(sessionId => {
      window.agentAcceptance = { approvals: [], steps: [], events: [] };
      window.chatAPI.onToolApproval(event => {
        if (!event.resolved) { window.agentAcceptance.approvals.push(event); window.chatAPI.respondToToolApproval(event.requestId, event.approvalId, 'deny'); }
      });
      window.chatAPI.onStreamStatus(event => { if (event.sessionId === sessionId) { if (event.status === 'generating') { window.agentAcceptance.started = true; window.agentAcceptance.done = false; } else if (window.agentAcceptance.started) window.agentAcceptance.done = true; } });
      window.chatAPI.onStepUpdate(event => window.agentAcceptance.steps.push(event));
      window.chatAPI.onEvent(event => window.agentAcceptance.events.push(event));
    }, setup.sessionId);
    const prompt = `Complete this six-step coding task autonomously in the current workspace. Use execute_command in six separate calls, in exactly this order (activate the commands tool group first if necessary):
1. cat package.json
2. printf 'console.log(42)\n' > source.cjs
3. npm install --offline --no-audit --no-fund ./local-dependency
4. npm run build
5. printf 'console.log(43)\n' > source.cjs
6. npm run build
Do not combine or omit steps. Do not delegate or use MCP, memory, external downloads, or other filesystem locations. The local dependency is already present. After the sixth tool result, report both build outputs and that Isolated disables terminal downloads.`;
    assert.equal(await page.locator('select[aria-label="Tool permission mode"]').inputValue(), 'workspace_write');
    let result = resume?.run;
    if (!resume) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    for (let i = 0; i < 300 && !(await page.evaluate(() => window.agentAcceptance.done)); i++) await delay(1000);
    if (!(await page.evaluate(() => window.agentAcceptance.done))) await page.evaluate(sessionId => window.chatAPI.cancelSession(sessionId), setup.sessionId);
    result = await page.evaluate(() => window.agentAcceptance);
    }
    evidence.run = result;
    assert.equal(result.done, true, 'genuine local model run must complete within five minutes');
    assert.equal(result.approvals.length, 0);
    assert.equal(result.error, undefined);
    assert.match(fs.readFileSync(path.join(workspace, 'source.cjs'), 'utf8'), /43/);
    // Stream updates are the same progress-card data delivered to the renderer.
    let steps = result.steps.flatMap(event => event.executionSteps || []);
    let commands = new Map(steps.filter(step => step.name === 'execute_command' || step.toolName === 'execute_command').map(step => [step.id, step]));
    if (commands.size === 5 && [...commands.values()].at(-1)?.args.command.includes('console.log(43)')) {
      evidence.modelFollowup = 'Initial model response omitted the final build; the real UI requested it explicitly.';
      await page.evaluate(() => { window.agentAcceptance.done = false; window.agentAcceptance.started = false; });
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('The final build was omitted. Run exactly one execute_command now: npm run build. Then report its real output.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      for (let i = 0; i < 120 && !(await page.evaluate(() => window.agentAcceptance.done)); i++) await delay(1000);
      result = await page.evaluate(() => window.agentAcceptance);
      evidence.run = result;
      steps = result.steps.flatMap(event => event.executionSteps || []);
      commands = new Map(steps.filter(step => step.toolName === 'execute_command').map(step => [step.id, step]));
    }
    if (resume) {
      const persisted = await application.evaluate((_electron, sessionId) => new Promise((resolve, reject) => setImmediate(() => {
        try {
          const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/main.js');
          const rows = req('./src/main/db').db.prepare('SELECT execution_steps FROM messages WHERE session_id = ? AND execution_steps IS NOT NULL').all(sessionId);
          resolve(rows.flatMap(row => JSON.parse(row.execution_steps)).filter(step => step.toolName === 'execute_command' && step.status === 'complete'));
        } catch (error) { reject(error); }
      })), setup.sessionId);
      assert.deepEqual(persisted.map(step => step.args.command), [...commands.values()].map(step => step.args.command));
      assert.ok(persisted.every(step => step.result?.exitCode === 0 && step.result?.commandEnvironment?.sandboxed));
      evidence.resumedVisualAndStopAcceptance = true;
    }
    evidence.commandCards = [...commands.values()];
    assert.equal(commands.size, 6, 'six distinct model-driven command cards required');
    assert.ok([...commands.values()].every(step => step.result?.exitCode === 0 && step.result?.commandEnvironment?.sandboxed === true));
    evidence.buildOutputs = [...commands.values()].filter(step => step.args.command === 'npm run build').map(step => step.result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(evidence.buildOutputs, ['42', '43']);
    evidence.checks = { noApprovalInterruptions: true, sourceCorrection: true, localDependency: fs.existsSync(path.join(workspace, 'node_modules/local-dependency/package.json')), progressEvents: result.steps.length };
    assert.ok(result.steps.length > 0, 'real tool progress events required');
    const cards = page.locator('[aria-label="Tool execution"], [aria-label="Tool executions"]');
    assert.ok(await cards.count() > 0, 'actual renderer must display tool progress cards');
    await cards.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'agent-flow.png') });
    await page.evaluate(() => { window.agentAcceptance = { approvals: [], steps: [], events: [], started: false, done: false }; });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Run exactly one execute_command with command "sleep 30". Do not combine it with other commands.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    for (let i = 0; i < 90; i++) {
      const pending = await page.evaluate(() => window.agentAcceptance.steps.flatMap(event => event.executionSteps || []).some(step => step.toolName === 'execute_command' && step.args?.command === 'sleep 30'));
      if (pending) break;
      await delay(1000);
    }
    assert.ok(await page.evaluate(() => window.agentAcceptance.steps.flatMap(event => event.executionSteps || []).some(step => step.toolName === 'execute_command' && step.args?.command === 'sleep 30')), 'actual model must start the cancellation fixture command');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    for (let i = 0; i < 20 && !(await page.evaluate(() => window.agentAcceptance.done)); i++) await delay(500);
    evidence.cancellation = await page.evaluate(() => window.agentAcceptance);
    assert.equal(evidence.cancellation.done, true);
    assert.equal(evidence.cancellation.approvals.length, 0);
    evidence.checks.actualUiStop = true;
    evidence.passed = true;
  } finally {
    fs.writeFileSync(path.join(root, 'agent-evidence.json'), JSON.stringify(evidence, null, 2));
    fs.mkdirSync('.continuum-local/real-agent', { recursive: true });
    fs.copyFileSync(path.join(root, 'agent-evidence.json'), '.continuum-local/real-agent/agent-evidence.json');
    console.log('REAL_AGENT_EVIDENCE', path.join(root, 'agent-evidence.json'), 'passed', evidence.passed === true);
    await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
