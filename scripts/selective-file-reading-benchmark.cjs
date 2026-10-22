'use strict';
// Phase 2.5A selective-file-read benchmark. Real executeAgentTool dispatcher,
// real temporary workspace, no model/provider/network. Output is JSON on
// stdout; every number below is measured on this machine at run time.
//
// Usage: node scripts/selective-file-reading-benchmark.cjs [output.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-read-benchmark-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace);
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === 'electron') {
		return {
			app: { isReady: () => true, getPath: () => directory },
			ipcMain: { handle: () => {}, removeHandler: () => {} },
		};
	}
	return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');

const chars = (value) => JSON.stringify(value).length;
const tokens = (count) => Math.ceil(count / 4);
const pct = (before, after) => Number((((before - after) / before) * 100).toFixed(2));
const ms = (value) => Number(value.toFixed(3));

async function timed(fn) {
	const started = performance.now();
	const value = await fn();
	return { value, elapsedMs: ms(performance.now() - started) };
}

async function responsiveness(fn) {
	let last = performance.now();
	let maxDelay = 0;
	let ticks = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxDelay = Math.max(maxDelay, now - last - 1);
		last = now;
		ticks += 1;
	}, 1);
	const started = performance.now();
	const value = await fn();
	const elapsedMs = performance.now() - started;
	clearInterval(timer);
	return { value, elapsedMs: ms(elapsedMs), maxTimerDelayMs: ms(maxDelay), ticks };
}

function numbered(count, prefix = 'export const value') {
	const lines = [];
	for (let index = 1; index <= count; index += 1) lines.push(`${prefix}${index} = ${index};`);
	return `${lines.join('\n')}\n`;
}

async function main() {
	initDatabase();
	const project = projects.createProject({ name: 'selective-read-benchmark', root_path: workspace });
	const session = 'selective-read-benchmark-chat';
	sessions.getOrCreateSession(session, 'benchmark-model', project.id);
	const call = (name, args) => executeAgentTool({
		name, arguments: args, sessionId: session, permissionMode: 'workspace_write',
	});

	const fixtures = {
		small_100: numbered(100),
		medium_4000: numbered(4000),
		large_50000: numbered(50000),
		very_long_line: `${'x'.repeat(1000000)}\n`,
	};
	for (const [name, content] of Object.entries(fixtures)) {
		fs.writeFileSync(path.join(workspace, `${name}.js`), content);
	}

	const readSchema = agentTools.find((tool) => tool.function.name === 'read_project_file').function;
	const schemaChars = chars(readSchema);
	const cases = [];
	for (const [name, content] of Object.entries(fixtures)) {
		const relative = `${name}.js`;
		const requestedStart = name === 'very_long_line' ? 1
			: name === 'medium_4000' ? 2000
				: name === 'large_50000' ? 25000 : 50;
		const requestedEnd = name === 'very_long_line' ? 1
			: name === 'medium_4000' ? 2099
				: name === 'large_50000' ? 25199 : 149;
		const full = await timed(() => call('read_project_file', { relative_path: relative }));
		const range = await timed(() => call('read_project_file', {
			relative_path: relative, start_line: requestedStart, end_line: requestedEnd,
		}));
		const fullChars = chars(full.value);
		const rangeChars = chars(range.value);
		cases.push({
			fixture: name,
			file_bytes: Buffer.byteLength(content, 'utf8'),
			file_lines: content === fixtures.very_long_line ? 1 : content.split('\n').length - 1,
			full_read: {
				latency_ms: full.elapsedMs,
				returned_chars: fullChars,
				estimated_tokens: tokens(fullChars),
				truncated: full.value.truncated === true,
				content_chars: typeof full.value.content === 'string' ? full.value.content.length : null,
			},
			range_read: {
				start_line: range.value.start_line ?? null,
				end_line: range.value.end_line ?? null,
				requested_end_line: range.value.requested_end_line ?? null,
				actual_start_line: range.value.actual_start_line ?? null,
				actual_end_line: range.value.actual_end_line ?? null,
				latency_ms: range.elapsedMs,
				returned_chars: rangeChars,
				estimated_tokens: tokens(rangeChars),
				content_chars: typeof range.value.content === 'string' ? range.value.content.length : null,
				total_lines: range.value.total_lines ?? null,
				has_more: range.value.has_more ?? null,
				truncated: range.value.truncated === true,
				truncation_reason: range.value.truncation_reason ?? null,
				outcome: range.value.success === false ? range.value.code ?? 'error' : 'success',
				line_number: range.value.line_number ?? null,
				line_bytes: range.value.line_bytes ?? null,
				suggested_next_start_line: range.value.suggested_next_start_line ?? null,
			},
			range_vs_full: {
				chars_saved: fullChars - rangeChars,
				reduction_percent: fullChars > 0 ? pct(fullChars, rangeChars) : null,
			},
		});
	}

	const largeContent = fixtures.large_50000;
	const largeResponsive = await responsiveness(() => call('read_project_file', {
		relative_path: 'large_50000.js', start_line: 25000, end_line: 25199,
	}));
	const fullResponsive = await responsiveness(() => call('read_project_file', { relative_path: 'large_50000.js' }));
	const rssBefore = process.resourceUsage().maxRSS;
	const mediumFull = await timed(() => call('read_project_file', { relative_path: 'medium_4000.js' }));
	const mediumRange = await timed(() => call('read_project_file', {
		relative_path: 'medium_4000.js', start_line: 2000, end_line: 2099,
	}));
	const rssAfter = process.resourceUsage().maxRSS;

	const report = {
		phase: '2.5A',
		generated_at: new Date().toISOString(),
		note: 'Measured on disposable temporary fixtures with the real native dispatcher. No inference/provider call is made. Token estimates are JSON character counts / 4, not billed tokens. maxRSS is the process high-water mark in KiB.',
		environment: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			cpu_count: os.cpus().length,
			total_memory_bytes: os.totalmem(),
		},
		limits: {
			default_page_lines: 200,
			max_page_lines: 400,
			max_output_chars: 20000,
			read_tool_schema_chars: schemaChars,
		},
		cases,
		responsiveness: {
			large_full_read: {
				elapsed_ms: fullResponsive.elapsedMs,
				max_timer_delay_ms: fullResponsive.maxTimerDelayMs,
				timer_ticks: fullResponsive.ticks,
			},
			large_range_read: {
				elapsed_ms: largeResponsive.elapsedMs,
				max_timer_delay_ms: largeResponsive.maxTimerDelayMs,
				timer_ticks: largeResponsive.ticks,
			},
		},
		memory: {
			max_rss_before_kb: rssBefore,
			max_rss_after_kb: rssAfter,
			max_rss_delta_kb: rssAfter - rssBefore,
			medium_full_read_latency_ms: mediumFull.elapsedMs,
			medium_range_read_latency_ms: mediumRange.elapsedMs,
		},
		sample_comparison: {
			fixture: 'medium_4000',
			whole_file_chars: chars(mediumFull.value),
			range_100_lines_chars: chars(mediumRange.value),
			whole_file_tokens_approx: tokens(chars(mediumFull.value)),
			range_100_lines_tokens_approx: tokens(chars(mediumRange.value)),
			reduction_percent: pct(chars(mediumFull.value), chars(mediumRange.value)),
		},
		honesty: {
			range_reads_still_read_the_whole_file: true,
			reason: 'The full-file SHA-256 and total_lines metadata require scanning every byte; the reader streams the file in 64 KiB chunks and retains only the requested page.',
			not_claimed: [
				'No claim that pagination improves model reasoning quality.',
				'No claim of atomic file snapshots; stability is a bounded pre/post stat check with retry.',
				'No claim that token estimates equal provider-billed tokens.',
			],
		},
	};

	const output = process.argv[2];
	if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	closeDatabase();
	fs.rmSync(directory, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(error);
	try { closeDatabase(); } catch {}
	try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
	process.exitCode = 1;
});
