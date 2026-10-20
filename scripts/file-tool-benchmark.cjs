'use strict';

// Deterministic Phase 2.0F file-tool efficiency benchmark.
//
// Uses the real agentTools dispatcher over a temporary SQLite database and
// temporary workspace. No model, provider, network, or paid inference call is
// involved. "Previous" shapes reconstruct the pre-2.0F contract exactly for
// the same calls:
//   - write_project_file returned only { success, recoveryCheckpointId }
//   - read_project_file returned only { content }
// Character counts are JSON.stringify lengths. Tokens are a chars/4
// approximation, not billed provider tokens.
//
// Usage: node scripts/file-tool-benchmark.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tool-benchmark-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace);
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

const { initDatabase, closeDatabase } = require('../src/main/db');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');
const { executeAgentTool } = require('../src/main/tools/agentTools');

const MODEL = 'benchmark-model';
const TEST_OUTPUT_CHARS = 180; // identical fixed verification output in both workflows
const chars = (value) => JSON.stringify(value).length;
const approxTokens = (count) => Math.ceil(count / 4);
const pct = (before, after) => Number((((before - after) / before) * 100).toFixed(2));

function syntheticContent(size) {
	const line = 'export const deterministicValue = 42; // representative filler line\n';
	if (size <= 0) return '';
	return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

async function main() {
	initDatabase();
	const project = projects.createProject({ name: 'file-tool-benchmark', root_path: workspace });
	const session = 'file-tool-benchmark-chat';
	sessions.getOrCreateSession(session, MODEL, project.id);
	const call = (name, args) => executeAgentTool({
		name,
		arguments: args,
		sessionId: session,
		permissionMode: 'workspace_write',
	});

	const cases = [
		{ id: 'tiny', size: 8 },
		{ id: 'small', size: 200 },
		{ id: 'medium', size: 10000 },
		{ id: 'near_read_limit', size: 19500 },
		{ id: 'over_read_limit', size: 25000 },
	];
	const results = [];

	for (const testCase of cases) {
		const initial = syntheticContent(testCase.size);
		const edited = `${initial.slice(0, Math.max(0, initial.length - 24))}/* edited marker */\n`;
		const external = `${edited}/* external change */\n`;
		const relative = `src/${testCase.id}.js`;

		await call('write_project_file', { relative_path: relative, content: initial });

		// 1. Read the file.
		const firstRead = await call('read_project_file', { relative_path: relative });
		const previousFirstRead = { content: firstRead.content };

		// 2. Edit the file.
		// 3. Receive committed file metadata.
		const write = await call('write_project_file', { relative_path: relative, content: edited });
		const previousWrite = { success: true, recoveryCheckpointId: write.recoveryCheckpointId };

		// 4-5. Conditional check: unchanged.
		const unchanged = await call('read_project_file', {
			relative_path: relative,
			if_content_hash: write.content_hash,
		});
		const previousUnchangedReread = { content: edited };

		// 6. Run tests (fixed identical output in both workflows).
		// 7. Modify the file externally.
		fs.writeFileSync(path.join(workspace, relative), external);
		// 8-9. Conditional check: changed content must be returned.
		const changed = await call('read_project_file', {
			relative_path: relative,
			if_content_hash: write.content_hash,
		});
		const previousChangedReread = { content: external };

		const previousWorkflowChars = chars(previousFirstRead) + chars(previousWrite)
			+ chars(previousUnchangedReread) + TEST_OUTPUT_CHARS + chars(previousChangedReread);
		const newWorkflowChars = chars(firstRead) + chars(write)
			+ chars(unchanged) + TEST_OUTPUT_CHARS + chars(changed);

		results.push({
			case: testCase.id,
			content_bytes: Buffer.byteLength(initial, 'utf8'),
			read_limit_applied: firstRead.truncated === true,
			previous_write_chars: chars(previousWrite),
			new_write_chars: chars(write),
			write_metadata_overhead_chars: chars(write) - chars(previousWrite),
			previous_full_reread_chars: chars(previousUnchangedReread),
			new_conditional_unchanged_chars: chars(unchanged),
			conditional_unchanged_savings_chars: chars(previousUnchangedReread) - chars(unchanged),
			conditional_unchanged_reduction_percent: pct(chars(previousUnchangedReread), chars(unchanged)),
			previous_changed_reread_chars: chars(previousChangedReread),
			new_conditional_changed_chars: chars(changed),
			conditional_changed_delta_chars: chars(previousChangedReread) - chars(changed),
			unchanged_not_modified: unchanged.not_modified === true,
			unchanged_has_content: Object.hasOwn(unchanged, 'content'),
			changed_has_fresh_content: changed.not_modified === false
				&& changed.content_hash !== write.content_hash
				&& (changed.truncated
					? external.startsWith(changed.content.slice(0, 20000))
					: changed.content === external),
			previous_workflow_chars: previousWorkflowChars,
			new_workflow_chars: newWorkflowChars,
			workflow_savings_chars: previousWorkflowChars - newWorkflowChars,
			workflow_reduction_percent: pct(previousWorkflowChars, newWorkflowChars),
			previous_workflow_tokens_approx: approxTokens(previousWorkflowChars),
			new_workflow_tokens_approx: approxTokens(newWorkflowChars),
			workflow_token_savings_approx: approxTokens(previousWorkflowChars) - approxTokens(newWorkflowChars),
		});
	}

	// Repeated edit/verify cycles on one medium file: every cycle writes, then
	// verifies with a conditional read instead of a second full transfer.
	const repeatedPath = 'src/repeated.js';
	const repeatedInitial = syntheticContent(10000);
	await call('write_project_file', { relative_path: repeatedPath, content: repeatedInitial });
	let previousCumulative = chars({ content: repeatedInitial });
	let newCumulative = chars(await call('read_project_file', { relative_path: repeatedPath }));
	const cycles = 10;
	let body = repeatedInitial;
	for (let index = 0; index < cycles; index += 1) {
		body = `${body.slice(0, body.length - 1)}${index % 10}/* cycle ${index} */\n`;
		const write = await call('write_project_file', { relative_path: repeatedPath, content: body });
		const read = await call('read_project_file', {
			relative_path: repeatedPath,
			if_content_hash: write.content_hash,
		});
		previousCumulative += chars({ success: true, recoveryCheckpointId: write.recoveryCheckpointId });
		previousCumulative += chars({ content: body });
		newCumulative += chars(write);
		newCumulative += chars(read);
	}

	const totals = results.reduce((totals, entry) => ({
		previousWorkflowChars: totals.previousWorkflowChars + entry.previous_workflow_chars,
		newWorkflowChars: totals.newWorkflowChars + entry.new_workflow_chars,
	}), { previousWorkflowChars: 0, newWorkflowChars: 0 });

	const report = {
		note: 'ASCII/UTF-8 JSON character counts. Tokens are a chars/4 approximation, not billed provider tokens.',
		fixtures: cases.map((entry) => ({ case: entry.id, content_bytes: entry.size })),
		per_case: results,
		repeated_cycles: {
			cycles,
			previous_cumulative_chars: previousCumulative,
			new_cumulative_chars: newCumulative,
			savings_chars: previousCumulative - newCumulative,
			reduction_percent: pct(previousCumulative, newCumulative),
			previous_tokens_approx: approxTokens(previousCumulative),
			new_tokens_approx: approxTokens(newCumulative),
			token_savings_approx: approxTokens(previousCumulative) - approxTokens(newCumulative),
		},
		all_cases_workflow: {
			previous_chars: totals.previousWorkflowChars,
			new_chars: totals.newWorkflowChars,
			savings_chars: totals.previousWorkflowChars - totals.newWorkflowChars,
			reduction_percent: pct(totals.previousWorkflowChars, totals.newWorkflowChars),
			previous_tokens_approx: approxTokens(totals.previousWorkflowChars),
			new_tokens_approx: approxTokens(totals.newWorkflowChars),
			token_savings_approx: approxTokens(totals.previousWorkflowChars) - approxTokens(totals.newWorkflowChars),
		},
		honesty: {
			conditional_reads_can_increase_output_when: [
				'content changed, so current content must still be returned with metadata',
				'the file is tiny and the metadata is larger than the saved content',
			],
			character_reduction_is_not: 'measured cloud-token savings',
			write_hash_proves: 'observed committed bytes at verification time, not code correctness',
		},
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	return report;
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		closeDatabase();
		fs.rmSync(directory, { recursive: true, force: true });
	});
