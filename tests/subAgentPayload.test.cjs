const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runSubAgent, targetFileBudget } = require('../src/main/subAgentRunner');

const engine = { port: 12345, modelId: 'test', contextLength: 32768 };

test('sub-agent file payload is budgeted from the parent context and truncated per file', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-agent-payload-'));
  let calls = 0;
  let payload;
  const fetchImpl = async (_url, options) => {
    calls++;
    payload = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: 'summary' } }] });
  };
  const request = { task_description: 'Summarize', target_files: ['a.txt', 'b.txt'], rootPath, engine, fetchImpl };
  const injectedLength = () => [...payload.messages[1].content
    .matchAll(/\[FILE: [^\]]+\]\n([\s\S]*?)\n\[END FILE\]/g)].map(match => match[1]).join('').length;
  // Injected text cannot reach the exact budget: per-file [FILE:] frames consume part
  // of the reserve, so assert the real invariant (bounded, and nearly filled).
  const FRAME_SLACK = 4096;
  try {
    // Small files are injected whole and in order, well under the budget.
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'a'.repeat(2500));
    await fs.writeFile(path.join(rootPath, 'b.txt'), 'b'.repeat(1500));
    assert.equal(await runSubAgent(request), 'summary');
    assert.equal(calls, 1);
    assert.match(payload.messages[1].content, /\[FILE: a\.txt\]\na{2500}\n\[END FILE\]/);
    assert.match(payload.messages[1].content, /\[FILE: b\.txt\]\nb{1500}\n\[END FILE\]/);
    assert.doesNotMatch(payload.messages[1].content, /\[TRUNCATED due to budget\]/);

    // A file that overflows the remaining budget is truncated and the batch continues.
    const budget = targetFileBudget(engine.contextLength);
    await fs.writeFile(path.join(rootPath, 'b.txt'), 'b'.repeat(budget));
    assert.equal(await runSubAgent(request), 'summary');
    assert.equal(calls, 2);
    assert.match(payload.messages[1].content, /\[FILE: a\.txt\]\na{2500}\n\[END FILE\]/);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.ok(injectedLength() <= budget, `injected ${injectedLength()} exceeds budget ${budget}`);
    assert.ok(injectedLength() > budget - FRAME_SLACK, `injected ${injectedLength()} should closely fill ${budget}`);

    // A lone oversized file truncates instead of rejecting the delegation.
    await fs.writeFile(path.join(rootPath, 'big.txt'), 'B'.repeat(budget * 3));
    assert.equal(await runSubAgent({ ...request, target_files: ['big.txt'] }), 'summary');
    assert.equal(calls, 3);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.ok(!payload.messages[1].content.includes('B'.repeat(budget + 1)));
    assert.ok(injectedLength() <= budget);
    assert.ok(injectedLength() > budget - FRAME_SLACK);

// Truncation is per file: the small files are injected whole, the overflowing one is
    // truncated to whatever budget is left, and the delegation succeeds instead of throwing.
    await fs.writeFile(path.join(rootPath, 'b.txt'), 'b'.repeat(500));
    assert.equal(await runSubAgent({ ...request, target_files: ['a.txt', 'b.txt', 'big.txt'] }), 'summary');
    assert.match(payload.messages[1].content, /\[FILE: a\.txt\]\na{2500}\n\[END FILE\]/);
    assert.match(payload.messages[1].content, /\[FILE: b\.txt\]\nb{500}\n\[END FILE\]/);
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.ok(injectedLength() <= budget);
    // The truncated file yields the leftover space, it does not evict earlier files.
    assert.ok(payload.messages[1].content.indexOf('[FILE: b.txt]')
      < payload.messages[1].content.indexOf('[FILE: big.txt]'));

    // The budget scales with the context window, so small models are never overfilled.
    for (const contextLength of [8192, 16384, 131072]) {
      const scaled = { ...request, target_files: ['big.txt'], engine: { ...engine, contextLength } };
      const expected = targetFileBudget(contextLength);
      assert.equal(await runSubAgent(scaled), 'summary');
      assert.ok(injectedLength() <= expected, `injected ${injectedLength()} exceeds ${expected}`);
      assert.ok(injectedLength() > expected - FRAME_SLACK);
    }

    // A missing contextLength falls back to the conservative default.
    assert.equal(await runSubAgent({ ...request, target_files: ['big.txt'], engine: { ...engine, contextLength: undefined } }), 'summary');
    assert.equal(targetFileBudget(undefined), 64000);
    assert.ok(injectedLength() <= targetFileBudget(undefined));
    assert.ok(injectedLength() > targetFileBudget(undefined) - FRAME_SLACK);

// Multi-byte characters truncated mid-sequence must not corrupt the decode, and the
// encoded body must stay within the context budget even though the char cap is not hit.
    await fs.writeFile(path.join(rootPath, 'wide.txt'), '\u65e5'.repeat(budget));
    assert.equal(await runSubAgent({ ...request, target_files: ['wide.txt'] }), 'summary');
    assert.match(payload.messages[1].content, /\[TRUNCATED due to budget\]/);
    assert.doesNotMatch(payload.messages[1].content, /\uFFFD/);
    assert.ok(injectedLength() <= budget);
    const wideBytes = Buffer.byteLength(payload.messages[1].content);
    assert.ok(wideBytes <= (engine.contextLength - 1024 - 512) * 4,
      `encoded body ${wideBytes} exceeds the context-derived byte budget`);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});