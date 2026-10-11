'use strict';

// Shared system-message merge used by both the inference wire path and the
// standalone prompt measurer. Strict Jinja templates accept only one leading
// system turn, so every prompt sent to /apply-template (or the model) must go
// through this first. Kept in CommonJS so both src/main/*.js and
// src/lib/*.mjs can consume it without duplicating the logic.
function mergeSystemMessages(messages) {
  const system = messages.filter(message => message.role === 'system');
  if (!system.length) return messages;
  return [
    { role: 'system', content: system.map(message => message.content ?? '').join('\n\n') },
    ...messages.filter(message => message.role !== 'system'),
  ];
}

module.exports = { mergeSystemMessages };

// Just-in-time guardrail reminders for Casual Chat. The static session prompt
// carries only the safety core; these details are pushed as a system notice
// on the first relevant tool call of a turn (see runMemoryChat), so chats
// that never touch those tools never pay for them. Each string is
// self-contained: it is read without its original section around it.
const CASUAL_FILE_OPS_REMINDER = [
  'Terminal and file guardrails: with str_replace_editor make small surgical replacements anchored on unique context — never rewrite whole files.',
  'Restrict test-data deletions to this run\u2019s document ids; preview and confirm any other bulk delete first.',
  'Contained commands run sandboxed; system-affecting or outside-workspace actions need approval.',
].join(' ');

const CASUAL_SUBAGENT_PATTERN_REMINDER = 'Sub-agent call shape: {"tool": "spawn_sub_agent", "arguments": {"task": "<single purpose>", "investigate": true, "expected_output": "<short summary format>"}} — exactly one of url, target_file, or investigate:true.';

// Tool names whose first use in a turn triggers the file-ops reminder.
const FILE_OPS_TOOL_NAMES = new Set(['execute_command', 'str_replace_editor', 'write_project_file', 'write_file', 'edit_file', 'delete_file']);

module.exports = { mergeSystemMessages, CASUAL_FILE_OPS_REMINDER, CASUAL_SUBAGENT_PATTERN_REMINDER, FILE_OPS_TOOL_NAMES };
