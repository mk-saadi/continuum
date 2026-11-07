// Read-only live diagnostic: never executes model-selected tools. Feed only
// disposable captures from compactPromptBudget.cjs --capture-dir, never a user chat.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readCompletion } from '../../src/lib/memoryChat.mjs';
const require = createRequire(import.meta.url);
const { validate } = require('../../src/main/toolSchemaValidation');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--capture-dir') || !args.includes('--output')) throw Error('--capture-dir and --output required');
const endpoint = args.includes('--endpoint') ? option('--endpoint') : 'http://127.0.0.1:8080';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(endpoint)) throw Error('Local endpoint required');
const report = { version: 1, limits: { requests: 40, totalMs: 300000, requestMs: 45000, maxTokens: 512 },
  conditions: { thinkingDisabled: args.includes('--no-thinking'), profileFilter: args.includes('--profile') ? option('--profile') : null, kindFilter: args.includes('--kind') ? option('--kind') : null, modeFilter: args.includes('--mode') ? option('--mode') : null },
  method: 'Fixture-only wire, server-rendered prompt, optional raw completion, Continuum parser; no tool execution', requests: [], comparisons: [], complete: false };
const persist = () => fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2));
const digest = value => createHash('sha256').update(value).digest('hex');
const globalSignal = AbortSignal.timeout(report.limits.totalMs);
async function request(route, body) {
  globalSignal.throwIfAborted();
  if (report.requests.length >= report.limits.requests) throw Error('DIAGNOSTIC_REQUEST_LIMIT');
  const record = { route, ...(body ? { requestSha256: digest(JSON.stringify(body)) } : {}) };
  report.requests.push(record); persist();
  try {
    const response = await fetch(endpoint + route, { method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([globalSignal, AbortSignal.timeout(report.limits.requestMs)]) });
    record.status = response.status;
    // Consume under the same deadline, then parse a copy through production code.
    const raw = await response.text();
    if (route !== '/props') record.raw = raw;
    persist();
    return new Response(raw, { status: response.status, headers: response.headers });
  } catch (error) { record.error = error.name + ': ' + error.message; persist(); throw error; }
}
try {
  const full = JSON.parse(fs.readFileSync(path.join(option('--capture-dir'), 'full.json')));
  const compact = JSON.parse(fs.readFileSync(path.join(option('--capture-dir'), 'compact.json')));
  for (const [profile, capture] of [['full', full], ['compact', compact]]) {
    const schema = capture.tools.find(t => t.function.name === 'read_project_file');
    report[profile + 'Schema'] = schema;
    report[profile + 'ToolsSha256'] = digest(JSON.stringify(capture.tools));
  }
  persist();
  const health = await request('/health');
  if (!health.ok) throw Error('SERVER_UNAVAILABLE');
  const propsResponse = await request('/props');
  const props = await propsResponse.json();
  // Do not retain host paths or other settings from props.
  delete report.requests.at(-1).raw;
  if (path.basename(props.model_path || '') !== 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf') throw Error('MODEL_MISMATCH');
  report.runtime = { model: path.basename(props.model_path || ''), templateSha256: digest(props.chat_template || ''),
    build: props.build_info, slots: props.total_slots };
  const tasks = [
    ['file', { relative_path: 'sample.txt', start_line: 2, end_line: 3 }],
    ['hash', { relative_path: 'sample.txt', expected_content_hash: 'sha256:' + 'a'.repeat(64), start_line: 1, end_line: 2 }],
    ['attachment', { attachment_id: 'fixture-attachment', start_line: 1, end_line: 2 }],
  ];
  for (const [profile, capture] of [['full', full], ['compact', compact]]) {
    if (args.includes('--profile') && option('--profile') !== profile) continue;
    const reader = capture.tools.find(t => t.function.name === 'read_project_file');
    if (!reader) throw Error('Missing advertised reader');
    report[profile + 'Schema'] = reader;
    for (const [kind, expected] of tasks) for (const mode of (args.includes('--mode') && ['expanded-union-control', 'anyof-control', 'allof-control'].includes(option('--mode')) ? [option('--mode')] : ['minimal', 'required-path-control', 'advertised'])) {
      if (args.includes('--kind') && option('--kind') !== kind) continue;
      if (args.includes('--mode') && option('--mode') !== mode) continue;
      if (mode === 'required-path-control' && kind === 'attachment') continue;
      const tool = structuredClone(reader);
      if (mode === 'required-path-control') {
        delete tool.function.parameters.oneOf;
        tool.function.parameters.required = ['relative_path'];
      }
      // Control is diagnostic-only, never advertised by the application.
      if (mode === 'expanded-union-control') {
        tool.function.parameters.oneOf = tool.function.parameters.oneOf.map(branch => ({ type: 'object', properties: structuredClone(tool.function.parameters.properties), required: branch.required, additionalProperties: false }));
      }
      if (mode === 'anyof-control') {
        tool.function.parameters.anyOf = tool.function.parameters.oneOf;
        delete tool.function.parameters.oneOf;
        tool.function.parameters.not = { required: ['relative_path', 'attachment_id'] };
        tool.function.parameters.not.properties = { relative_path: { type: 'string' }, attachment_id: { type: 'string' } };
      }
      if (mode === 'allof-control') {
        tool.function.parameters.allOf = [{ oneOf: tool.function.parameters.oneOf }];
        delete tool.function.parameters.oneOf;
      }
      const tools = mode === 'advertised' ? capture.tools : [tool];
      const messages = [{ role: 'user', content: 'Diagnostic only. Call read_project_file once with exactly this JSON: ' + JSON.stringify(expected) + '. Do not use another tool or answer in text.' }];
      for (const stream of [false, true]) {
        const body = { ...(args.includes('--no-thinking') ? { chat_template_kwargs: { enable_thinking: false } } : {}), model: props.model_path || full.model, messages, tools, stream, temperature: 0, seed: 42, max_tokens: report.limits.maxTokens,
          ...(stream ? { stream_options: { include_usage: true } } : {}) };
        const comparison = { profile, kind, mode, stream, expected, toolsSha256: digest(JSON.stringify(tools)) };
        report.comparisons.push(comparison);
        try {
          const response = await request('/v1/chat/completions', body);
          if (!response.ok) { comparison.unsupported = response.status; continue; }
          const parsed = await readCompletion(response, () => {}, globalSignal, Date.now, () => {});
          comparison.parsedCalls = parsed.toolCalls; comparison.usage = parsed.usage;
          comparison.valid = parsed.toolCalls.length === 1 && parsed.toolCalls[0].function.name === 'read_project_file';
          for (const call of parsed.toolCalls) {
            const values = JSON.parse(call.function.arguments);
            validate(reader.function.parameters, values);
            comparison.valid &&= isDeepStrictEqual(values, expected);
          }
        } catch (error) { comparison.valid = false; comparison.error = error.message; }
        persist();
      }
    }
    // Same minimal schema/messages rendered by the server; raw completion avoids
    // the server's chat tool-call parser. Unsupported routes are recorded.
    const body = { messages: [{ role: 'user', content: 'Call read_project_file with relative_path sample.txt.' }], tools: [reader], add_generation_prompt: true, ...(args.includes('--no-thinking') ? { chat_template_kwargs: { enable_thinking: false } } : {}) };
    const rendered = await request('/apply-template', body);
    if (rendered.ok) {
      const template = await rendered.json();
      if (typeof template.prompt === 'string') {
        report[profile + 'RenderedPrompt'] = template.prompt;
        const raw = await request('/completion', { prompt: template.prompt, n_predict: 512, temperature: 0, seed: 42, stream: false });
        report[profile + 'RawCompletionSupported'] = raw.ok;
      }
    }
  }
  report.complete = true;
} catch (error) { report.error = error.name + ': ' + error.message; process.exitCode = 1; }
finally { persist(); }
