'use strict';

// OpenAI-compatible chat-completions tool definitions for local LLM servers.
// Tool execution must bind model/session scope in the main process.
const { searchMemoryTool } = require('./tools/searchMemory');
const nativeTools = [{ type: 'function', function: {
  name: searchMemoryTool.name,
  description: searchMemoryTool.description,
  parameters: searchMemoryTool.input_schema,
} }];

module.exports = { nativeTools };
