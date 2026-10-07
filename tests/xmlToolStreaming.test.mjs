import test from 'node:test';
import assert from 'node:assert/strict';
import { createXmlToolCallInterceptor, runMemoryChat } from '../src/lib/memoryChat.mjs';

const qwenCall = '<tool_call> <function=execute_command> <parameter=command> npm test </parameter> </function> </tool_call>';

for (const xml of [qwenCall, qwenCall.replaceAll('tool_call>', 'TOOL_CALL >').replace('<function=', '<FUNCTION \n= ')]) {
  test(`Qwen XML stays hidden at every split: ${JSON.stringify(xml.slice(0, 40))}`, () => {
    const content = `Before ${xml}After`;
    const check = chunks => {
      const parser = createXmlToolCallInterceptor();
      const visible = chunks.map(chunk => parser.push(chunk)).join('') + parser.finish();
      assert.equal(visible, 'Before After');
      assert.equal(parser.calls.length, 1);
      assert.equal(parser.calls[0].function.name, 'execute_command');
      assert.deepEqual(JSON.parse(parser.calls[0].function.arguments), { command: 'npm test' });
    };
    for (let split = 0; split <= content.length; split++) check([content.slice(0, split), content.slice(split)]);
    check([...content]);
  });
}

test('incomplete wrappers and functions never flush to text or execute', () => {
  for (const xml of [
    '<tool_call> <function=execute_command><parameter=command>npm test',
    '<tool_call><function=execute_command><parameter=command>npm test</parameter></function>',
    '<function = execute_command><parameter=command>npm test',
    '<tool_call', '<function',
  ]) {
    const parser = createXmlToolCallInterceptor();
    let visible = '';
    for (const char of `Before ${xml}`) visible += parser.push(char);
    visible += parser.finish();
    assert.equal(visible, 'Before ');
    assert.deepEqual(parser.calls, []);
  }
});

test('ordinary angle brackets survive buffering', () => {
  const parser = createXmlToolCallInterceptor();
  const text = 'Use <div> and x < y; unfinished comparison <';
  assert.equal([...text].map(char => parser.push(char)).join('') + parser.finish(), text);
});

for (const mode of ['sse', 'json']) {
  test(`${mode} Qwen XML executes through the tool engine and stores structured history`, async () => {
    const requests = [], executed = [];
    let visible = '';
    await runMemoryChat({ baseUrl: 'http://local', modelId: 'test', messages: [{ role: 'system', content: 'Work' }],
      chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
      onText: delta => { visible += delta; },
      executeTool: async call => { executed.push(call); return { success: true }; },
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        const content = requests.length === 1 ? qwenCall : '[TASK COMPLETE]';
        if (mode === 'json') return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
        const events = [...content].map(char => ({ choices: [{ index: 0, delta: { content: char } }] }));
        events.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
        return new Response(new ReadableStream({ start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        } }), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    assert.equal(executed.length, 1);
    assert.equal(executed[0].name, 'execute_command');
    assert.deepEqual(JSON.parse(executed[0].arguments), { command: 'npm test' });
    assert.equal(visible, '[TASK COMPLETE]');
    const history = requests[1].messages;
    const assistant = history.find(message => message.tool_calls?.length);
    assert.equal(assistant.content, null);
    assert.equal(assistant.tool_calls[0].function.name, 'execute_command');
    assert.equal(history.at(-1).tool_call_id, assistant.tool_calls[0].id);
    assert.ok(!JSON.stringify(history).includes('<tool_call>'));
  });
}


test('fragmented XML emits name immediately and arguments before completion, without tag leaks', () => {
  const events = [];
  const parser = createXmlToolCallInterceptor(event => events.push(event));
  let visible = parser.push('Before <tool_') + parser.push('call><func') + parser.push('tion=str_replace_editor>');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_start');
  assert.equal(events[0].functionName, 'str_replace_editor');
  const code = 'const longCode = "hello";\n'.repeat(500);
  const body = '<parameter=new_str>' + code + '</parameter>';
  for (const char of body) visible += parser.push(char);
  assert.equal(parser.calls.length, 0);
  assert.equal(events.filter(event => event.type === 'tool_chunk').map(event => event.content).join(''), code);
  visible += parser.push('</function></tool_call>After') + parser.finish();
  assert.equal(visible, 'Before After');
  assert.equal(parser.calls[0].id, events[0].id);
  assert.equal(JSON.parse(parser.calls[0].function.arguments).new_str, code.trim());
});

test('multiple complete calls share neither IDs nor parameter chunks', () => {
  const events = [];
  const parser = createXmlToolCallInterceptor(event => events.push(event));
  parser.push('<function=one><parameter=a>first</parameter></function><function=two><parameter=b>second</parameter></function>');
  assert.equal(parser.calls.length, 2);
  assert.notEqual(parser.calls[0].id, parser.calls[1].id);
  for (const [i, text] of ['first', 'second'].entries()) {
    assert.equal(events.find(event => event.type === 'tool_chunk' && event.id === parser.calls[i].id).content, text);
  }
});

test('generated card is reused for execution and completion', async () => {
  let requests = 0, executed = 0;
  const events = [], snapshots = [];
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'test', messages: [{ role: 'system', content: 'Work' }],
    chatTools: [{ type: 'function', function: { name: 'write_project_file' } }],
    onToolStream: event => events.push(event), onExecutionSteps: steps => snapshots.push(steps),
    executeTool: async () => { executed++; return { success: true }; },
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: ++requests === 1
      ? '<tool_call><function=write_project_file><parameter=content>hello world</parameter></function></tool_call>'
      : '[TASK COMPLETE]' } }] }),
  });
  assert.equal(executed, 1);
  const id = events[0].id;
  assert.ok(snapshots.some(steps => steps.some(step => step.id === id && step.status === 'preparing')));
  assert.ok(snapshots.some(steps => steps.some(step => step.id === id && step.status === 'running')));
  assert.equal(snapshots.at(-1).length, 1);
  assert.equal(snapshots.at(-1)[0].status, 'complete');
});

test('unfinished XML marks its live card interrupted without executing', async () => {
  const snapshots = [];
  let executions = 0;
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'test', messages: [{ role: 'system', content: 'Work' }],
    onExecutionSteps: steps => snapshots.push(steps), executeTool: async () => { executions++; },
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: '<tool_call><function=write_project_file><parameter=content>unfinished code',
    } }] }),
  });
  assert.equal(executions, 0);
  assert.equal(snapshots.at(-1)[0].status, 'error');
  assert.match(snapshots.at(-1)[0].error, /interrupted or incomplete/);
});
