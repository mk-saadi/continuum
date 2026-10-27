'use strict';
// Audit-only: mocked inference/tools, production composition/storage/retrieval, disposable SQLite.
// Run: node docs/a1-agentic-context-fixture.cjs [output.json]
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert/strict'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-a1-')), load = Module._load;
Module._load = function (n, ...a) { if (n === 'electron')
    return { app: { isReady: () => true, getPath: () => dir }, Notification: { isSupported: () => false } }; return load.call(this, n, ...a); };
const get = n => require(path.join(root, 'src/main', n)), store = get('db');
store.initDatabase(dir);
const sessions = get('sessionManager'), briefs = get('taskBriefs'), builder = get('promptBuilder'), engine = get('engineManager'), budget = get('contextBudget'), logs = get('workLog'), cp = get('taskCheckpoints'), tools = get('tools/agentTools');
const project = get('projectManager').createProject({ name: 'A1 disposable' }), out = { date: '2026-10-28', method: 'Production runMemoryChat + context guarded fetch + media guard final wire JSON serialization; mocked inference and operation outputs; UTF-8 bytes/3 plus message overhead estimate, NOT exact tokens', captures: [], coverage: [], retrieval: [], restart: [] };
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
function save(id, role, text, steps) { return sessions.saveMessage(id, role, text, [], null, null, null, null, null, steps); }
function setup(id) { sessions.getOrCreateSession(id, 'a1-model', project.id); return save(id, 'user', 'Inspect synthetic source. Persistent constraints: do not commit. Old instruction: use blue.'); }
async function native(id, args) { return tools.executeAgentTool({ name: 'get_recent_chat_history', arguments: JSON.stringify(args), sessionId: id, permissionMode: 'read_only' }); }
const defs = tools.agentTools.filter(t => ['read_project_file', 'edit_project_files', 'execute_command', 'update_plan', 'get_recent_chat_history'].includes(t.function.name));
function op(i) { let name, args, result; if (i % 7 === 0) {
    name = 'execute_command';
    args = { command: `npm test -- case-${i}` };
    result = { success: true, exitCode: 0, stdout: `PASS case-${i}` };
}
else if (i % 7 === 1) {
    name = 'execute_command';
    args = { command: `npm test -- case-${i}` };
    result = { success: false, exitCode: 1, stdout: `FAIL case-${i}`, error: 'synthetic assertion failed' };
}
else if (i % 7 === 2) {
    name = 'edit_project_files';
    args = { edits: [{ relative_path: `src/file-${i}.js`, old_text: 'old', new_text: 'new' }] };
    result = { success: false, error: 'old text not found' };
}
else if (i % 7 === 3) {
    name = 'edit_project_files';
    args = { edits: [{ relative_path: `src/file-${i}.js`, old_text: 'old', new_text: 'new' }] };
    result = { success: true, files: [{ path: `src/file-${i}.js`, linesAdded: 1, linesRemoved: 1 }] };
}
else if (i % 7 === 4) {
    name = 'update_plan';
    args = { action: 'get' };
    result = { success: true, revision: 10, plan: { revision: 10 } };
}
else {
    name = 'read_project_file';
    args = { relative_path: `src/file-${i}.js` };
    result = { success: true, content: i === 5 ? 'TAG_LOSS_EVIDENCE: updateTask resets tags when tags is absent.' : i === 19 ? 'HIDDEN_TOOL_ONLY_NEEDLE_19' : `source-${i}: export const value = ${i};` };
} return { id: `a1-op-${i}`, name, args, result }; }
function size(x) { const s = typeof x === 'string' ? x : JSON.stringify(x); return { bytes: Buffer.byteLength(s), characters: s.length, estimatedTokensChars4: Math.ceil(s.length / 4) }; }
function measure(request, label, round) { const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), calls = request.messages.flatMap(m => m.tool_calls || []), results = request.messages.filter(m => m.role === 'tool'); const contract = budget.createRuntimeBudget({ runtimeContextTokens: 90112, payload: request, currentInputTokens: budget.approximateTokens(request) }); const part = (a, b) => { const start = system.indexOf(a), end = system.indexOf(b, start); return start < 0 ? '' : system.slice(start, end < 0 ? undefined : end + b.length); }; return { label, round, fullRequest: { ...size(request), estimatedTokens: budget.approximateTokens(request), sha256: hash(request) }, system: size(system), toolDefinitions: size(request.tools || []), currentUser: size(request.messages.filter(m => m.role === 'user').at(-1) || ''), taskBriefs: { count: (system.match(/\[Brief #/g) || []).length, ...size(part(briefs.SECTION_MARKER, briefs.SECTION_END)) }, plan: { revision: (system.match(/Revision: (\d+)/)?.[1] ?? null), ...size(part('[WORKSPACE TASK PLAN]', '[END OF WORKSPACE TASK PLAN]')) }, checkpoint: size(system.match(/\[WORKSPACE CHECKPOINT\][^\n]*\n\{[^\n]*\}/)?.[0] ?? ''), recentAssistant: { count: request.messages.filter(m => m.role === 'assistant').length, ...size(request.messages.filter(m => m.role === 'assistant')) }, toolCalls: { count: calls.length, ...size(calls) }, toolResults: { count: results.length, ...size(results) }, worklog: size(part(logs.WORKLOG_MARKER, logs.WORKLOG_END)), compaction: { eligible: budget.atCompactionPressure(contract), reason: budget.atCompactionPressure(contract) ? 'estimated input reaches pressure threshold' : 'estimated input below threshold', contract }, request }; }
(async () => {
    try {
        const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
        const wire = infer => budget.createContextGuardedFetch(get('modelCapabilities').createMediaGuardedFetch(async (url, options) => {
            const route = new URL(url).pathname;
            if (route === '/props')
                return Response.json({ model_path: 'a1-model', chat_template: 'a1 synthetic runtime', default_generation_settings: { n_ctx: 90112 } });
            if (route === '/apply-template')
                return new Response('', { status: 404 });
            assert.equal(route, '/v1/chat/completions');
            return infer(url, options);
        }));
        const dispatch = options => runMemoryChat({ ...options, fetchImpl: wire(options.fetchImpl) });
        // Same active run: capture the actual NEXT request after N completed operations.
        setup('single');
        let index = 0, latestSteps = [], stats;
        const row = save('single', 'assistant', '');
        await dispatch({ modelId: 'a1-model', baseUrl: 'http://fixture.invalid', projectId: project.id, messages: builder.rebuildChatMessages({ sessionId: 'single', modelId: 'a1-model' }), chatTools: defs, maxAutoTurns: 180, workspaceCompaction: async (boundary) => get('workspaceCompaction').compactAtBoundary({ ...boundary, sessionId: 'single', modelId: 'a1-model', owner: { signal: new AbortController().signal, runId: 'a1-run' }, messageId: row.id, isCurrent: () => true, generate: () => assert.fail('Below threshold must not compact'), measure: async (payload) => { const normalized = { ...payload, messages: require('../src/lib/systemMessages.cjs').mergeSystemMessages(payload.messages) }, tokens = budget.approximateTokens(normalized), contract = budget.createRuntimeBudget({ runtimeContextTokens: 90112, payload: normalized, currentInputTokens: tokens }); return { tokens, method: 'approximate-full-request', limit: 90112, budget: contract.usableInputTokens, budgetContract: contract }; } }), guardToolContent: engine.truncateToolOutput, onExecutionSteps: s => { latestSteps = s; sessions.saveMessage('single', 'assistant', 'Audit operations', [], null, null, null, row.id, null, s); }, onStats: s => stats = s, executeTool: async (c) => op(Number(c.id.split('-').at(-1))).result, fetchImpl: async (_u, o) => { const request = JSON.parse(o.body); if ([1, 10, 30, 60, 70, 100, 150, 175].includes(index))
                out.captures.push(measure(request, 'single-active-run', index)); const i = ++index, operation = op(i), done = i > 175; return Response.json({ usage: { prompt_tokens: budget.approximateTokens(request), completion_tokens: 20, total_tokens: budget.approximateTokens(request) + 20 }, choices: [{ message: done ? { content: 'Finished synthetic operations [TASK COMPLETE]' } : { reasoning_content: `PRIVATE_REASONING_${i}`, tool_calls: [{ id: operation.id, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.args) } }] }, finish_reason: done ? 'stop' : 'tool_calls' }] }); } });
        assert.equal(latestSteps.filter(s => s.type === 'tool_call').length, 175);
        logs.recordTurnDigest({ sessionId: 'single', assistantMessageId: row.id });
        out.singleStats = stats;
        // Five separate user turns with the same 175 outputs and terminal digest creation.
        setup('multi');
        get('workspacePlan').updatePlan('multi', { action: 'create', objective: 'Synthetic audit plan', steps: [{ description: 'Inspect synthetic sources' }] });
        for (let revision = 1; revision < 10; revision++)
            get('workspacePlan').updatePlan('multi', { action: 'update', objective: `Synthetic audit plan revision ${revision + 1}` });
        const multiRows = [];
        for (let turn = 0; turn < 5; turn++) {
            if (turn)
                save('multi', 'user', turn === 4 ? 'After round 140 explain the earlier tag-loss finding and cite original evidence. Supersede blue: use green.' : `Continue synthetic task ${turn + 1}.`);
            const steps = Array.from({ length: 35 }, (_, j) => { const o = op(turn * 35 + j + 1); return { id: o.id, type: 'tool_call', toolName: o.name, args: o.args, result: o.result, status: o.result.success === false ? 'error' : 'complete' }; });
            const m = save('multi', 'assistant', `Finished synthetic turn ${turn + 1}; inspect earlier sources for details.`, steps);
            multiRows.push(m);
            logs.recordTurnDigest({ sessionId: 'multi', assistantMessageId: m.id });
            let request;
            await dispatch({ modelId: 'a1-model', baseUrl: 'http://fixture.invalid', projectId: project.id, messages: builder.rebuildChatMessages({ sessionId: 'multi', modelId: 'a1-model' }), chatTools: defs, fetchImpl: async (_u, o) => { request = JSON.parse(o.body); return Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }); } });
            out.captures.push(measure(request, 'after-separate-user-turn', 35 * (turn + 1)));
        }
        out.digests = logs.getDigestRows('multi').rows.map(r => ({ id: r.id, messageId: r.assistant_message_id, digest: r.digest }));
        // All identities via the actual authorized native dispatcher, not direct helper.
        const active = out.captures.find(c => c.label === 'single-active-run' && c.round === 175).request;
        const rebuilt = out.captures.filter(c => c.label === 'after-separate-user-turn').at(-1).request;
        for (let i = 1; i <= 175; i++) {
            const o = op(i), r = await native('multi', { source_step_id: o.id, length: 8000 });
            assert.ok(r.source?.stepId === o.id, JSON.stringify(r));
            const exact = JSON.parse(r.text);
            assert.deepEqual(exact.result, o.result);
            const digest = out.digests[Math.floor((i - 1) / 35)].digest, entry = digest.entries[(i - 1) % 35];
            out.coverage.push({ operationId: o.id, messageId: multiRows[Math.floor((i - 1) / 35)].id, tool: o.name, directInActiveRun: active.messages.some(m => m.tool_call_id === o.id), directInLaterTurn: rebuilt.messages.some(m => m.tool_call_id === o.id), durableDigestEntry: true, summaryVisibleInOwnDigest: digest.text.includes(entry.summary), summaryVisibleInLaterPrompt: JSON.stringify(rebuilt).includes(entry.summary), checkpoint: false, retrievable: true, retrievalRoute: { source_step_id: o.id }, storedResultSHA256: hash(exact.result) });
        }
        for (const i of [1, 2, 3, 5, 7, 19, 170])
            out.retrieval.push({ operation: i, result: await native('multi', { source_step_id: `a1-op-${i}`, length: 8000 }) });
        out.navigation = { olderPage: await native('multi', { source_history: true, offset: 8 }), hiddenQuery: await native('multi', { source_history: true, query: 'HIDDEN_TOOL_ONLY_NEEDLE_19' }), all: await native('multi', { source_history: true }), messageOnly: await native('multi', { source_message_id: multiRows[0].id }), hiddenIdKnown: await native('multi', { source_step_id: 'a1-op-19' }) };
        assert.equal(out.navigation.hiddenQuery.total, 0);
        assert.ok(!out.navigation.all.items.flatMap(i => i.toolStepIds).includes('a1-op-19'));
        assert.ok(out.navigation.hiddenIdKnown.text.includes('HIDDEN_TOOL_ONLY_NEEDLE_19'));
        const b = briefs.getAllBriefs('multi')[0];
        out.retrieval.push({ originalInstruction: await native('multi', { source_message_id: b.message_id }), historicalBrief: await native('multi', { source_brief_id: b.id }) });
        out.denied = { crossChat: await native('single', { source_message_id: multiRows[0].id }), missing: await native('multi', { source_step_id: 'missing-op' }) };
        assert.equal(out.denied.crossChat.success, false);
        store.db.prepare('UPDATE sessions SET active_leaf_id=? WHERE id=?').run(multiRows[0].id, 'multi');
        out.denied.offBranch = await native('multi', { source_message_id: multiRows[4].id });
        assert.equal(out.denied.offBranch.success, false);
        store.db.prepare('UPDATE sessions SET active_leaf_id=? WHERE id=?').run(multiRows[4].id, 'multi');
        const firstPage = await native('multi', { source_step_id: 'a1-op-5', length: 23 });
        let paged = firstPage.text, next = firstPage.nextOffset, pages = 1;
        while (next !== null) {
            const p = await native('multi', { source_step_id: 'a1-op-5', offset: next, length: 23 });
            paged += p.text;
            next = p.nextOffset;
            pages++;
        }
        assert.equal(paged, (await native('multi', { source_step_id: 'a1-op-5', length: 8000 })).text);
        out.pagination = { pages, exact: true, firstPage };
        // Large output is stored in full, trimmed before budgeting without a checkpoint.
        setup('large');
        let n = 0, largeRequest;
        const lm = save('large', 'assistant', '');
        await dispatch({ modelId: 'a1-model', baseUrl: 'http://fixture.invalid', projectId: project.id, messages: builder.rebuildChatMessages({ sessionId: 'large', modelId: 'a1-model' }), chatTools: defs, guardToolContent: engine.truncateToolOutput, onExecutionSteps: s => sessions.saveMessage('large', 'assistant', 'Large read', [], null, null, null, lm.id, null, s), executeTool: async () => 'x'.repeat(30000) + 'TRIMMED_TAIL_FINDING', fetchImpl: async (_u, o) => { largeRequest = JSON.parse(o.body); return Response.json({ choices: [{ message: ++n === 1 ? { tool_calls: [{ id: 'large-read', type: 'function', function: { name: 'read_project_file', arguments: '{"relative_path":"synthetic.js"}' } }] } : { content: 'Done [TASK COMPLETE]' }, finish_reason: n === 1 ? 'tool_calls' : 'stop' }] }); } });
        const lr = await native('large', { source_step_id: 'large-read', offset: 29800, length: 1000 });
        assert.match(lr.text, /TRIMMED_TAIL_FINDING/);
        assert.ok(!JSON.stringify(largeRequest).includes('TRIMMED_TAIL_FINDING'));
        out.trimming = { request: largeRequest, tail: lr, checkpoint: cp.getLatestCheckpoint('large') };
        // Generate a source-validated checkpoint on a small source set, then test original retrieval.
        setup('compact');
        const cm = save('compact', 'assistant', 'Early tag finding', [{ id: 'compact-early', type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: 'tags.js' }, result: op(5).result }]);
        const w2 = get('workspaceCompactCandidate');
        const generated = await w2.generateWorkspaceCompactCandidate({ sessionId: 'compact', modelId: 'a1-model', capacityTokens: 90112, persist: false, generate: async (request) => { const input = JSON.parse(request.messages[1].content), draft = { objective: 'Retain tag finding', briefIds: input.briefs.map(b => b.id) }; for (const key of w2.ARRAY_KEYS)
                draft[key] = []; draft.research = [{ text: op(5).result.content, sources: [{ messageId: cm.id, stepId: 'compact-early' }] }]; return { choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] }; } });
        assert.ok(generated.ok, JSON.stringify(generated));
        store.db.transaction(() => { cp.persistCheckpointRow({ sessionId: 'compact', modelId: 'a1-model', checkpoint: { ...generated.candidate, lifecycle: 'w3-current' }, briefIdentity: briefs.getBriefIdentity('compact') }); store.db.prepare('UPDATE messages SET archived=1 WHERE session_id=?').run('compact'); })();
        save('compact', 'user', 'Continue reviewing tags.');
        out.compaction = { activation: 'Audit installs validated candidate transactionally; full W3 activation covered by regression suite', candidate: generated.candidate, diagnostics: generated.diagnostics, original: await native('compact', { source_step_id: 'compact-early' }), briefSelection: briefs.buildTaskBriefSection('compact'), workingState: cp.buildCheckpointSection('compact') };
        setup('delta');
        let firstDelta;
        out.incremental = [];
        for (let turn = 0; turn < 5; turn++) {
            const steps = Array.from({ length: 35 }, (_, j) => { const o = op(turn * 35 + j + 1); return { id: o.id, type: 'tool_call', toolName: o.name, status: o.result.success === false ? 'error' : 'complete', args: o.args, result: o.result }; });
            const m = save('delta', 'assistant', `Delta operations ${turn + 1}`, steps);
            firstDelta ??= m;
            const result = await w2.generateWorkspaceCompactCandidate({ sessionId: 'delta', modelId: 'a1-model', capacityTokens: 90112, persist: false, generate: async (request) => {
                    const input = JSON.parse(request.messages[1].content), draft = { objective: 'Preserve synthetic historical evidence', briefIds: input.briefs.map(b => b.id) };
                    for (const key of w2.ARRAY_KEYS)
                        draft[key] = [];
                    draft.nextActions = ['Investigate synthetic failures'];
                    draft.blockers = ['Synthetic failures remain unresolved'];
                    draft.research = [{ text: op(5).result.content, sources: [{ messageId: firstDelta.id, stepId: 'a1-op-5' }] }];
                    return { choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] };
                } });
            assert.ok(result.ok, JSON.stringify(result));
            store.db.transaction(() => { cp.persistCheckpointRow({ sessionId: 'delta', modelId: 'a1-model', checkpoint: { ...result.candidate, lifecycle: 'w3-current' }, briefIdentity: briefs.getBriefIdentity('delta') }); store.db.prepare('UPDATE messages SET archived=1 WHERE session_id=?').run('delta'); })();
            out.incremental.push({ completedOperations: (turn + 1) * 35, evidenceIds: result.candidate.evidence.map(e => e.stepId), diagnostics: result.diagnostics, workingState: cp.buildCheckpointSection('delta') });
        }
        out.deltaRetrieval = [];
        for (let i = 1; i <= 175; i++) {
            const r = await native('delta', { source_step_id: `a1-op-${i}`, length: 8000 });
            assert.equal(r.source?.stepId, `a1-op-${i}`);
            out.deltaRetrieval.push({ operationId: r.source.stepId, retrievable: true });
        }
        save('delta', 'user', 'Explain the original tag-loss finding with source evidence.');
        await dispatch({ modelId: 'a1-model', baseUrl: 'http://fixture.invalid', projectId: project.id, messages: builder.rebuildChatMessages({ sessionId: 'delta', modelId: 'a1-model' }), chatTools: defs, fetchImpl: async (_u, o) => { const request = JSON.parse(o.body); out.captures.push(measure(request, 'after-five-validated-checkpoints', 175)); return Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }); } });
        // Restart at committed and uncommitted boundaries through production persistence/startup migration.
        for (const boundary of ['before-first-snapshot', 'running-snapshot', 'completed-snapshot', 'terminal-digest']) {
            const id = 'restart-' + boundary;
            setup(id);
            const p = engine.createMessagePersistence({ sessionId: id, modelId: 'a1-model', runId: 'old-owner' });
            const operation = { id: 'restart-op', type: 'tool_call', toolName: 'execute_command', status: boundary === 'running-snapshot' ? 'running' : 'complete', args: { command: 'synthetic npm test' }, result: { success: true, exitCode: 0, stdout: 'RESTART_PASS' } };
            if (boundary !== 'before-first-snapshot')
                p.update({ content: 'Persisted partial prose', executionSteps: [operation], status: boundary === 'terminal-digest' ? 'completed' : 'in_progress' });
            if (boundary === 'terminal-digest')
                logs.recordTurnDigest({ sessionId: id, assistantMessageId: p.messageId });
            store.closeDatabase();
            store.initDatabase(dir);
            const stored = store.db.prepare('SELECT * FROM messages WHERE id=?').get(p.messageId);
            out.restart.push({ boundary, messageId: p.messageId, status: stored.status, steps: get('executionSteps').readExecutionSteps(stored), retrieved: await native(id, { source_step_id: 'restart-op' }), prompt: builder.rebuildChatMessages({ sessionId: id, modelId: 'a1-model' }), digestCount: logs.getDigestRows(id).rows.length });
        }
        out.afterRestart = { old175: await native('multi', { source_step_id: 'a1-op-5' }), preCompaction: await native('compact', { source_step_id: 'compact-early' }) };
        store.db.prepare('INSERT INTO deleted_sessions(id) VALUES(?)').run('multi');
        out.denied.deleted = await native('multi', { source_step_id: 'a1-op-5' });
        assert.equal(out.denied.deleted.success, false);
        if (process.env.A1_LIVE_SNAPSHOT) {
            const snapshot = JSON.parse(fs.readFileSync(process.env.A1_LIVE_SNAPSHOT, 'utf8')), id = 'live-clone';
            sessions.getOrCreateSession(id, 'a1-model', project.id);
            for (const table of ['messages', 'workspace_task_briefs', 'workspace_turn_digests', 'workspace_checkpoints', 'workspace_plans', 'workspace_plan_steps', 'workspace_brief_lifecycle'])
                for (const original of snapshot[table]) {
                    const row = { ...original, session_id: id }, keys = Object.keys(row);
                    store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
                }
            store.db.prepare('UPDATE sessions SET active_leaf_id=? WHERE id=?').run(3898, id);
            const all = snapshot.messages.flatMap(m => get('executionSteps').readExecutionSteps(m).filter(s => s.type === 'tool_call').map(s => ({ message: m.id, step: s })));
            const recovered = [];
            for (const { message, step } of all) {
                const r = await native(id, { source_step_id: step.id, length: 8000 });
                assert.equal(r.source?.stepId, step.id);
                let body = r.text, next = r.nextOffset, pageCount = 1;
                while (next !== null) {
                    const page = await native(id, { source_step_id: step.id, offset: next, length: 8000 });
                    body += page.text;
                    next = page.nextOffset;
                    pageCount++;
                }
                assert.deepEqual(JSON.parse(body).result, step.result);
                recovered.push({ messageId: message, operationId: step.id, tool: step.toolName, status: step.status, pages: pageCount, exactStoredResultVerified: true, resultBytes: Buffer.byteLength(JSON.stringify(step.result ?? null)), retrievable: true, resultSHA256: hash(step.result ?? null) });
            }
            const selection = [];
            for (const leaf of [3894, 3898]) {
                store.db.prepare('UPDATE sessions SET active_leaf_id=? WHERE id=?').run(leaf, id);
                selection.push({ leaf, selectedBriefIds: briefs.selectModelBriefs(id).map(b => b.id), worklog: logs.buildWorkLogSection(id) });
            }
            out.recordedChat = { source: 'Explicit readonly query_only SQLite snapshot; imported only this chat into disposable DB. No live model or database initialization.', sessionId: '217b8985-615d-4042-98bf-06135a2cd380', title: 'TaskFlow — C6-E Continuity Test 001', messageAccounting: snapshot.messages.map(m => { const stats = JSON.parse(m.stats || 'null'); return { id: m.id, parentId: m.parent_id, role: m.role, status: m.status, archived: m.archived, runId: m.run_id, toolCount: get('executionSteps').readExecutionSteps(m).filter(s => s.type === 'tool_call').length, stats: stats ? { totalTokens: stats.totalTokens, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens, lastPromptTokens: stats.lastPromptTokens, peakPromptTokens: stats.peakPromptTokens, promptRequests: stats.promptRequests, cachedTokens: stats.cachedTokens, uncachedInputTokens: stats.uncachedInputTokens, reasoningTokens: stats.reasoningTokens, scope: stats.scope } : null }; }), operationAccounting: recovered, checkpointCount: snapshot.workspace_checkpoints.length, briefs: snapshot.workspace_task_briefs.map(b => ({ id: b.id, messageId: b.message_id, characters: b.content_text.length })), selection, plan: snapshot.workspace_plans, planFailures: all.filter(x => x.step.toolName === 'update_plan' && x.step.result?.success === false).map(x => ({ messageId: x.message, operationId: x.step.id, result: x.step.result })), interruptedEvidence: all.filter(x => x.message === 3892).map(x => ({ operationId: x.step.id, status: x.step.status, tool: x.step.toolName, hasResult: x.step.result != null })), digestAnchors: snapshot.workspace_turn_digests.map(d => ({ id: d.id, messageId: d.assistant_message_id, entries: JSON.parse(d.digest_json).entries.length, omitted: JSON.parse(d.digest_json).omitted })), restartClaim: snapshot.messages.find(m => m.id === 3894).content.slice(0, 400) };
        }
        out.continuity = { earlyFindingOperation: 'a1-op-5', round70Direct: JSON.stringify(out.captures.find(c => c.round === 70 && c.label === 'single-active-run').request).includes('TAG_LOSS_EVIDENCE'), round150Direct: JSON.stringify(out.captures.find(c => c.round === 150 && c.label === 'single-active-run').request).includes('TAG_LOSS_EVIDENCE'), laterTurnFindingTextVisible: JSON.stringify(rebuilt).includes('TAG_LOSS_EVIDENCE'), findingInCheckpoint: JSON.stringify(out.incremental.at(-1).workingState).includes('TAG_LOSS_EVIDENCE'), originalRetrievedExactly: out.coverage[4].retrievable, afterRestart: out.afterRestart.old175.source.stepId === 'a1-op-5', persistentNoCommitVisible: JSON.stringify(rebuilt).includes('do not commit'), supersedingInstructionVisible: JSON.stringify(rebuilt).includes('use green'), navigationPagesToEarliestOperation: 2, toolReplayDuringRetrieval: 0 };
        out.summary = { operations: 175, retrievable: out.coverage.filter(x => x.retrievable).length, missing: 0, sameRunVisible: out.coverage.filter(x => x.directInActiveRun).length, laterTurnRawVisible: out.coverage.filter(x => x.directInLaterTurn).length, laterTurnSummariesVisible: out.coverage.filter(x => x.summaryVisibleInLaterPrompt).length, digestEntries: out.digests.reduce((s, d) => s + d.digest.entries.length, 0), reasoningReplayed: JSON.stringify(active).includes('PRIVATE_REASONING_'), sourceHistoryFullScansPerNavigationCall: 1 };
        fs.writeFileSync(process.argv[2] || '/tmp/a1-fixture.json', JSON.stringify(out, null, 2));
        console.log(JSON.stringify(out.summary));
    }
    finally {
        store.closeDatabase();
        Module._load = load;
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
