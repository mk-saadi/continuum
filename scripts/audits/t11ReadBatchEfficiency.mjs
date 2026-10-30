// Usage: node scripts/audits/t11ReadBatchEfficiency.mjs /absolute/path/to/T1/src/lib/memoryChat.mjs
// Uses disposable files, injected provider responses, and actual local reads.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runMemoryChat } from '../../src/lib/memoryChat.mjs';
const baseline = process.argv[2];
if (!baseline) throw new Error('Provide the preserved T1 memoryChat.mjs module path.');
const t1 = (await import(pathToFileURL(path.resolve(baseline)))).runMemoryChat;
const root = await mkdtemp(path.join(tmpdir(), 't11-efficiency-'));
const paths = Array.from({ length: 24 }, (_, i) => `file-${i}.txt`).concat(['src/components/TaskList.jsx', 'src/components/ThemeToggle.jsx', 'index.html', 'vite.config.js']);
const { mkdir } = await import('node:fs/promises');
const calls = paths.map((relative_path, i) => ({ id: `original-${i}`, type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path }) } }));
const tools = [{ type: 'function', function: { name: 'read_project_file', parameters: { type: 'object', properties: { relative_path: { type: 'string' } }, required: ['relative_path'] } } }];
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
async function measure(run, legacy) {
  const requests = [], generated = [], executed = [];
  let toolMs = 0, failures = 0, turn = 0;
  const start = performance.now();
  await run({ baseUrl: 'http://fixture', modelId: 'fixture', chatTools: tools,
    messages: [{ role: 'system', content: 'Read all requested files.' }, { role: 'user', content: 'Inspect 28 files.' }],
    preflightIndependentRead: async () => true,
    executeTool: async call => {
      const begin = performance.now();
      try { executed.push(call.id); return { success: true, content: await readFile(path.join(root, JSON.parse(call.arguments).relative_path), 'utf8') }; }
      catch (error) { failures++; return { success: false, error: error.message }; }
      finally { toolMs += performance.now() - begin; }
    },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const batch = turn === 0 ? calls : legacy && turn === 1 ? calls.slice(24).map((call, i) => ({ ...call, id: `regenerated-${i}` })) : [];
      generated.push(...batch); turn++;
      return new Response(JSON.stringify({ choices: [{ message: { content: batch.length ? '' : 'Inspected all files.', tool_calls: batch }, finish_reason: batch.length ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const argumentBytes = generated.reduce((sum, call) => sum + bytes(call.function.arguments), 0);
  const requestBytes = requests.map(bytes);
  return { providerRequests: requests.length, generatedArgumentBytes: argumentBytes,
    generatedArgumentTokensEstimated: Math.ceil(argumentBytes / 4), repeatedArgumentBytes: legacy ? calls.slice(24).reduce((sum, call) => sum + bytes(call.function.arguments), 0) : 0,
    fullProviderRequestBytes: requestBytes, fullProviderRequestTokensEstimated: requestBytes.map(n => Math.ceil(n / 4)),
    toolExecutions: executed.length, failedOperations: failures, toolExecutionMsObserved: toolMs,
    taskMsObserved: performance.now() - start, internalBatchSizes: legacy ? [24, 4] : [24, 4] };
}
try {
  for (const name of paths) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), `Fixture contents for ${name}\n`); }
  console.log(JSON.stringify({ method: 'Injected deterministic provider fixture; real disposable local reads; tokens estimated as ceil(UTF-8 serialized bytes/4), not tokenizer measurements. Timings are fixture observations, not model performance evidence.', t1: await measure(t1, true), t11: await measure(runMemoryChat, false) }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
