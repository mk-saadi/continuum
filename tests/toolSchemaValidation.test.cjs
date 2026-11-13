const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../src/main/toolSchemaValidation');
for (const dialect of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
  test(`MCP web search unions and URI formats validate without changing schemas: ${dialect}`, () => {
    const schema = { $schema: dialect, type: 'object', properties: {
      query: { type: 'string' }, limit: { type: ['number', 'string'], default: 5 },
      includeContent: { type: ['boolean', 'string'], default: true },
      url: { type: 'string', format: 'uri' },
    }, required: ['query'], additionalProperties: false };
    const original = JSON.stringify(schema);
    validate(schema, {query: 'example', limit: 8, includeContent: true});
    validate(schema, {query: 'example', limit: '8', includeContent: 'true', url: 'https://example.com'});
    for (const args of [{query:'x',limit:[]}, {query:'x',includeContent:42}, {query:'x',url:'not a url'}, {query:4}, {query:'x',extra:true}])
      assert.throws(() => validate(schema, args), /TOOL_ARGUMENTS_INVALID/);
    assert.equal(JSON.stringify(schema), original);
  });
}
test('unsupported schema reports the cause and still rejects unknown constraints', () => {
  assert.throws(() => validate({type:'object', unknownConstraint: true}, {}), /TOOL_SCHEMA_UNSUPPORTED.*unknownConstraint.*Changing tool arguments/);
});
